import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BUILDER_CONFIG_DIR } from "../shared/defaults.ts";

type Trigger = "failure" | "first_deploy" | "check_in";
type Posture = "ask" | "auto" | "off";
export interface PromptContext {
  command?: string;
  error_code?: string;
  trigger?: Trigger;
  dvm_id?: string;
  trace_id?: string;
  project_key?: string;
}
interface State {
  posture?: Posture;
  first_seen?: number;
  last_nudge?: number;
  last_failure?: number;
  last_check_in?: number;
  deployed?: string[];
  prompt?: PromptContext;
}
const path = join(BUILDER_CONFIG_DIR, "feedback-nudges.json");
const DAY = 24 * 60 * 60 * 1000;
let command: string | undefined;
let human = false;
let currentTraceId: string | null = null;
export function setFeedbackTraceId(id: string | null): void { currentTraceId = id; }

export function setFeedbackCommand(name: string | undefined, humanOutput = false): void {
  command = name?.startsWith("feedback") ? undefined : name;
  human = humanOutput;
}

function load(): State {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as State;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function save(state: State): void {
  mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
export function feedbackPosture(): { posture: Posture; source: "default" | "global" } {
  const value = load().posture;
  return value === "ask" || value === "auto" || value === "off"
    ? { posture: value, source: "global" }
    : { posture: "ask", source: "default" };
}
export function setFeedbackPosture(value: Posture): void {
  const state = load();
  state.posture = value;
  save(state);
}
export function lastFeedbackPrompt(): PromptContext {
  return load().prompt ?? {};
}
export function feedbackProjectKey(cwd = process.cwd()): string | undefined {
  try {
    return createHash("sha256").update(realpathSync.native(cwd)).digest("hex");
  } catch {
    return undefined;
  }
}
export function feedbackNudge(args: {
  failed?: boolean;
  platformError?: boolean;
  data?: Record<string, unknown>;
  errorCode?: string;
  traceId?: string | null;
} = {}): { feedback_nudge?: object; feedback_hint?: string } {
  try {
    if (!command || process.env.CI !== undefined) return {};
    const state = load();
    const { posture, source } = feedbackPosture();
    const now = Date.now();
    if (!state.first_seen) { state.first_seen = now; save(state); }
    const dvmId = typeof args.data?.dvmId === "string" ? args.data.dvmId : undefined;
    if (posture === "off") {
      if (command === "deploy" && args.data?.status === "deployed" && dvmId && !state.deployed?.includes(dvmId)) {
        state.deployed = [...(state.deployed ?? []), dvmId];
        save(state);
      }
      return {};
    }
    let trigger: Trigger | undefined;
    if (args.failed) {
      if ((command === "deploy" || args.platformError) && now - (state.last_failure ?? 0) >= DAY) trigger = "failure";
    } else if (command === "deploy" && args.data?.status === "deployed" && dvmId && !state.deployed?.includes(dvmId)) {
      trigger = "first_deploy";
    } else if (now - (state.last_check_in ?? state.first_seen ?? now) >= 14 * DAY && now - (state.last_nudge ?? 0) >= DAY) {
      trigger = "check_in";
    }
    if (!trigger) return {};
    const traceId = args.traceId ?? currentTraceId;
    const context: PromptContext = { command, trigger, ...(args.errorCode ? { error_code: args.errorCode } : {}), ...(dvmId ? { dvm_id: dvmId } : {}), ...(traceId ? { trace_id: traceId } : {}), ...(trigger === "first_deploy" && dvmId && traceId ? { project_key: feedbackProjectKey() } : {}) };
    const topic = trigger === "failure" ? `The ${command} command failed${args.errorCode ? ` (${args.errorCode})` : ""}.` : trigger === "first_deploy" ? `DVM ${dvmId} deployed for the first time.` : "How is building with dvmkit going?";
    const approval = posture === "ask" ? "Describe your proposed feedback to the builder and ask for agreement before sending." : "Send your own short, specific note without asking first.";
    const hint = `${approval} Include what was confusing, slow, or broken. Use dvmctl feedback send, with --trace for the error trace if relevant.`;
    const nudge = { trigger, approval: posture, posture_source: source, command: "dvmctl feedback send", display: topic, hint, ...(traceId ? { trace_id: traceId } : {}), ...(dvmId ? { dvm_id: dvmId } : {}) };
    state.last_nudge = now;
    if (trigger === "failure") state.last_failure = now;
    if (trigger === "check_in") state.last_check_in = now;
    if (trigger === "first_deploy") state.deployed = [...(state.deployed ?? []), dvmId!];
    state.prompt = context;
    save(state);
    return { feedback_nudge: nudge, feedback_hint: hint };
  } catch {
    return {};
  }
}
export function feedbackHumanHint(args: Parameters<typeof feedbackNudge>[0] = {}): string | undefined {
  if (!human || (process.exitCode ?? 0) !== 0) return undefined;
  const result = feedbackNudge(args);
  return result.feedback_hint;
}

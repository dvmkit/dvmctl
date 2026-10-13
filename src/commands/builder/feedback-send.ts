import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

import { DvmError } from "@dvmkit/sdk/internal";

import { deriveSlug } from "../../lib/deploy-attestation.ts";
import { feedbackProjectKey, lastFeedbackPrompt, feedbackPosture, setFeedbackPosture } from "../../lib/builder-feedback-nudges.ts";
import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import { sendBuilderFeedback } from "../../lib/platform-client.ts";
import { CLI_VERSION } from "../../lib/version.ts";
import { findBuilderDvmsByHandle } from "../../shared/builder-store.ts";
import { info, json } from "../../shared/output.ts";

export interface FeedbackSendOptions { body?: string; trace?: string; human?: boolean; org?: string }
export interface FeedbackPostureOptions { human?: boolean }

function readBody(input: string): string {
  if (input === "@-") return readFileSync(0, "utf8");
  if (input.startsWith("@")) return readFileSync(input.slice(1), "utf8");
  return input;
}
function projectContext(prompt: ReturnType<typeof lastFeedbackPrompt>, traceId: string | undefined): { sdk_version?: string; dvm_id?: string } {
  try {
    const cwd = process.cwd();
    const parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { dvmkit?: unknown; dependencies?: unknown };
    const hasProjectConfig = parsed.dvmkit !== null && typeof parsed.dvmkit === "object";
    const hasSdkDependency = parsed.dependencies !== null && typeof parsed.dependencies === "object" && Object.hasOwn(parsed.dependencies, "@dvmkit/sdk");
    if (!hasProjectConfig && !hasSdkDependency) return {};
    let sdkVersion: string | undefined;
    try {
      const installed = JSON.parse(readFileSync(join(cwd, "node_modules", "@dvmkit", "sdk", "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (installed.name === "@dvmkit/sdk" && typeof installed.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(installed.version)) sdkVersion = installed.version;
    } catch { /* An uninstalled project has no admitted SDK version to report. */ }
    let matches: ReturnType<typeof findBuilderDvmsByHandle>;
    try {
      matches = findBuilderDvmsByHandle(deriveSlug(cwd));
    } catch {
      return sdkVersion ? { sdk_version: sdkVersion } : {};
    }
    const promptedId = prompt.trigger === "first_deploy" && typeof prompt.dvm_id === "string" && typeof prompt.trace_id === "string" && typeof prompt.project_key === "string" && prompt.trace_id === traceId && prompt.project_key === feedbackProjectKey(cwd) ? prompt.dvm_id : undefined;
    const storedId = matches.length === 1 ? matches[0].canonical_dvm_id : undefined;
    const dvmId = matches.length > 1 || (promptedId && storedId && promptedId !== storedId) ? undefined : promptedId ?? storedId;
    return { ...(sdkVersion ? { sdk_version: sdkVersion } : {}), ...(dvmId ? { dvm_id: dvmId } : {}) };
  } catch { return {}; }
}
export async function feedbackSend(text: string | undefined, opts: FeedbackSendOptions): Promise<void> {
  if (text !== undefined && opts.body !== undefined) throw new DvmError("feedback_body_conflict", "Pass feedback as a positional text or --body, not both.");
  if (text === undefined && opts.body === undefined) throw new DvmError("feedback_body_required", "Feedback body is required.", "Pass text or --body <text|@path|@->.");
  const body = readBody((opts.body ?? text)!);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes === 0 || bytes > 4096) throw new DvmError("feedback_body_invalid", "Feedback must be 1–4,096 UTF-8 bytes.");
  const prompt = lastFeedbackPrompt();
  const traceId = opts.trace ?? prompt.trace_id;
  const project = projectContext(prompt, traceId);
  const { token, platformUrl } = requireAuth();
  const result = await sendBuilderFeedback(platformUrl, token, {
    body,
    ...(traceId ? { trace_id: traceId } : {}),
    context: {
      dvmctl_version: CLI_VERSION,
      ...project,
      os: platform(),
      node_version: process.version,
      ...(prompt.command ? { command: prompt.command } : {}),
      ...(prompt.error_code ? { error_code: prompt.error_code } : {}),
      ...(prompt.trigger ? { trigger: prompt.trigger } : {}),
    },
  }, resolveOrgScope(opts));
  if (opts.human) info(result.display);
  else json({ ...result, hint: "Feedback was sent to the dvmkit team." });
}
export function feedbackPostureCommand(value: string | undefined, opts: FeedbackPostureOptions): void {
  if (value !== undefined) {
    if (value !== "ask" && value !== "auto" && value !== "off") throw new DvmError("invalid_feedback_posture", "Posture must be ask, auto, or off.");
    setFeedbackPosture(value);
  }
  const effective = feedbackPosture();
  const display = `Feedback posture: ${effective.posture} (${effective.source}).`;
  if (opts.human) info(display);
  else json({ ...effective, display, hint: effective.posture === "off" ? "Explicit dvmctl feedback send still works." : "Set ask, auto, or off with dvmctl feedback posture <value>." });
}

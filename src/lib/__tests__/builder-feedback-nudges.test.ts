import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dir } = vi.hoisted(() => ({ dir: `/tmp/builder-feedback-nudge-test-${process.pid}` }));
vi.mock("../../shared/defaults", () => ({ BUILDER_CONFIG_DIR: dir }));
import { feedbackHumanHint, feedbackNudge, feedbackPosture, setFeedbackCommand, setFeedbackPosture } from "../builder-feedback-nudges";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
  vi.stubEnv("CI", undefined);
  rmSync(join(dir, "feedback-nudges.json"), { force: true });
  setFeedbackCommand("deploy");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setFeedbackCommand(undefined); process.exitCode = undefined; });

describe("builder feedback invitations", () => {
  it("defaults to ask, and off suppresses all triggers", () => {
    expect(feedbackPosture()).toEqual({ posture: "ask", source: "default" });
    setFeedbackPosture("off");
    expect(feedbackNudge({ failed: true, errorCode: "deploy_failed" })).toEqual({});
    expect(feedbackNudge({ data: { status: "deployed", dvmId: "dvm-1" } })).toEqual({});
    setFeedbackPosture("ask");
    expect(feedbackNudge({ data: { status: "deployed", dvmId: "dvm-1" } })).toEqual({});
    setFeedbackPosture("off");
    expect(feedbackNudge({ data: { status: "ok" } })).toEqual({});
  });
  it("limits failure invitations to one in 24 hours and carries only selected context", () => {
    const first = feedbackNudge({ failed: true, errorCode: "deploy_failed", traceId: "trace-1", data: { secret: "PRIVATE" } });
    expect(first.feedback_nudge).toMatchObject({ trigger: "failure", trace_id: "trace-1", approval: "ask" });
    expect(feedbackNudge({ failed: true, errorCode: "deploy_failed" })).toEqual({});
    const stored = readFileSync(join(dir, "feedback-nudges.json"), "utf8");
    expect(stored).not.toContain("PRIVATE");
    expect(stored).toContain("deploy_failed");
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(feedbackNudge({ failed: true, errorCode: "deploy_failed" }).feedback_nudge).toBeDefined();
  });
  it("invites once per deployed DVM and checks in after 14 days, with 24 hour spacing", () => {
    expect(feedbackNudge({ data: { status: "deployed", dvmId: "dvm-1" }, traceId: "deploy-trace" }).feedback_nudge).toMatchObject({ trigger: "first_deploy" });
    const stored = JSON.parse(readFileSync(join(dir, "feedback-nudges.json"), "utf8")) as { prompt: { project_key?: string } };
    expect(stored.prompt.project_key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(process.cwd());
    expect(feedbackNudge({ data: { status: "deployed", dvmId: "dvm-1" } })).toEqual({});
    vi.advanceTimersByTime(13 * 24 * 60 * 60 * 1000);
    expect(feedbackNudge({ data: { status: "ok" } })).toEqual({});
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(feedbackNudge({ data: { status: "ok" } }).feedback_nudge).toMatchObject({ trigger: "check_in" });
    expect(feedbackNudge({ data: { status: "ok" } })).toEqual({});
    expect(feedbackNudge({ data: { status: "deployed", dvmId: "dvm-2" } }).feedback_nudge).toMatchObject({ trigger: "first_deploy" });
  });
  it("does not invite on local non-deploy errors, feedback commands, or CI", () => {
    setFeedbackCommand("validate");
    expect(feedbackNudge({ failed: true, errorCode: "invalid_input" })).toEqual({});
    expect(feedbackNudge({ failed: true, platformError: true, errorCode: "platform_failed" }).feedback_nudge).toBeDefined();
    setFeedbackCommand("feedback send");
    expect(feedbackNudge({ data: { status: "ok" } })).toEqual({});
    setFeedbackCommand("list");
    vi.stubEnv("CI", "true");
    expect(feedbackNudge({ data: { status: "ok" } })).toEqual({});
  });
  it("does not check in after a failing human doctor result", () => {
    setFeedbackCommand("doctor", true);
    expect(feedbackHumanHint()).toBeUndefined();
    vi.advanceTimersByTime(14 * 24 * 60 * 60 * 1000);
    process.exitCode = 1;
    expect(feedbackHumanHint()).toBeUndefined();
    process.exitCode = undefined;
    expect(feedbackHumanHint()).toContain("dvmctl feedback send");
  });
  it("keeps the original command result when local nudge storage fails", () => {
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, "blocked");
    expect(feedbackNudge({ failed: true, errorCode: "deploy_failed" })).toEqual({});
    rmSync(dir);
  });
});

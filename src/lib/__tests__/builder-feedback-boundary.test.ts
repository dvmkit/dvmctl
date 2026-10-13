import { rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dir } = vi.hoisted(() => ({ dir: `/tmp/builder-feedback-boundary-${process.pid}` }));
vi.mock("../../shared/defaults", () => ({ BUILDER_CONFIG_DIR: dir }));
vi.mock("../../shared/output", () => ({ json: vi.fn(), info: vi.fn(), setOutputTraceId: vi.fn() }));

import { DvmError } from "@dvmkit/sdk/internal";
import { setFeedbackCommand, setFeedbackTraceId } from "../builder-feedback-nudges";
import { handleError } from "../error-handler";
import { listDomains } from "../platform-client";
import { info, json } from "../../shared/output";

const stop = new Error("terminal exit");
beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.stubEnv("CI", undefined);
  process.exitCode = undefined;
  setFeedbackTraceId("trace-1");
  vi.spyOn(process, "exit").mockImplementation(() => { throw stop; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  setFeedbackCommand(undefined);
  setFeedbackTraceId(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("builder feedback at the command error boundary", () => {
  it("keeps the original JSON error and exit when nudge storage fails", () => {
    writeFileSync(dir, "blocked");
    setFeedbackCommand("deploy");
    expect(() => handleError(new DvmError("deploy_failed", "Deployment failed."))).toThrow(stop);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(json).toHaveBeenCalledWith({ error: { code: "deploy_failed", message: "Deployment failed." } });
  });
  it("keeps the original human error and exit when nudge storage fails", () => {
    writeFileSync(dir, "blocked");
    setFeedbackCommand("deploy", true);
    expect(() => handleError(new DvmError("deploy_failed", "Deployment failed."), true)).toThrow(stop);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(info).toHaveBeenCalledWith("Error: Deployment failed.");
  });
  it("nudges on an unexpected deploy failure with the original internal error", () => {
    setFeedbackCommand("deploy");
    expect(() => handleError(new Error("private failure"))).toThrow(stop);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "internal" }), feedback_nudge: expect.objectContaining({ trigger: "failure", trace_id: "trace-1" }) }));
    expect(JSON.stringify(vi.mocked(json).mock.calls)).not.toContain("private failure");
  });
  it("nudges on a real platform HTTP refusal outside deploy", async () => {
    setFeedbackCommand("domains");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    let error: unknown;
    try { await listDomains("https://platform.example", "tok", "dvm-1"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DvmError);
    expect(() => handleError(error)).toThrow(stop);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "domain_failed" }), feedback_nudge: expect.objectContaining({ trigger: "failure" }) }));
  });
});

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/output", () => ({ json: vi.fn(), info: vi.fn(), setOutputTraceId: vi.fn() }));

import { DvmError } from "@dvmkit/sdk/internal";
import { handleError } from "../error-handler";
import { platformResponseError } from "../platform-client";
import { DISCORD_INVITE_URL, SUPPORT_EMAIL } from "../support";
import { info, json } from "../../shared/output";

const stop = new Error("terminal exit");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "1");
  vi.spyOn(process, "exit").mockImplementation(() => { throw stop; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function emitted(err: unknown, human = false): Record<string, unknown> | string {
  expect(() => handleError(err, human)).toThrow(stop);
  return human ? vi.mocked(info).mock.calls[0][0] as string : vi.mocked(json).mock.calls[0][0] as Record<string, unknown>;
}

const needsHelp: Array<[string, () => DvmError]> = [
  ["a platform response error", () => platformResponseError("server_error", { message: "Boom" }, "Platform failed")],
  ["a missing credential", () => new DvmError("auth_required", "Not authenticated.", "Run `dvmctl auth`.")],
  ["a rejected credential", () => new DvmError("auth_failed", "Invalid API key.")],
  ["a failed deploy", () => new DvmError("deploy_failed", "Deployment failed.")],
  ["a broken deploy stream", () => new DvmError("deploy_stream_failed", "No response body")],
];
const selfServe: Array<[string, () => unknown]> = [
  ["a local deploy-context validation error", () => new DvmError("deploy_context_too_large", "Build context is too large.", "Add a .dockerignore.")],
  ["an unknown internal error", () => new Error("boom")],
];

describe("help pointer on errors", () => {
  it.each(needsHelp)("adds the Discord invite to JSON for %s without changing the error", (_name, make) => {
    const err = make();
    const out = emitted(err) as { error: Record<string, unknown>; help?: string };
    expect(out.help).toBe(DISCORD_INVITE_URL);
    expect(out.error).toMatchObject({ code: err.code, ...(err.hint ? { hint: err.hint } : {}) });
    expect(out.error).not.toHaveProperty("help");
  });

  it.each(needsHelp)("prints one trailing help line in human mode for %s", (_name, make) => {
    const lines = (emitted(make(), true) as string).split("\n");
    expect(lines.filter((line) => line.includes(DISCORD_INVITE_URL))).toHaveLength(1);
    expect(lines.at(-1)).toContain(DISCORD_INVITE_URL);
  });

  it.each(selfServe)("omits help for %s", (_name, make) => {
    expect(emitted(make())).not.toHaveProperty("help");
    vi.clearAllMocks();
    expect(emitted(make(), true)).not.toContain("discord");
  });
});

describe("build-dvm recovery module", () => {
  it("names the same Discord invite and support email the CLI uses", () => {
    const recovery = readFileSync(new URL("../../../skills/build-dvm/recovery.md", import.meta.url), "utf8");
    expect(recovery).toContain(DISCORD_INVITE_URL);
    expect(recovery).toContain(SUPPORT_EMAIL);
    expect(recovery.indexOf(DISCORD_INVITE_URL)).toBeLessThan(recovery.indexOf(SUPPORT_EMAIL));
  });
});

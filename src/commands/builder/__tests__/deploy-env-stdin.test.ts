import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@dvmkit/sdk/internal", async (original) => ({
  ...(await original<typeof import("@dvmkit/sdk/internal")>()),
  loadIdentitySecret: () => "test-identity",
}));
vi.mock("../../../lib/deploy-attestation.ts", async (original) => ({
  ...(await original<typeof import("../../../lib/deploy-attestation.ts")>()),
  requireBuilderIdentity: () => undefined,
}));
vi.mock("../../../lib/builder-mnemonic.ts", () => ({ readBuilderMnemonic: () => null }));
vi.mock("../../../lib/platform.ts", () => ({ resolveAuth: () => ({ token: "test-token" }), resolveOrgScope: () => undefined }));
vi.mock("../../../shared/builder-store.ts", async (original) => ({
  ...(await original<typeof import("../../../shared/builder-store.ts")>()),
  loadIdentityPubkey: () => "test-pubkey",
}));
vi.mock("../../../lib/platform-client.ts", () => ({ validateAuth: vi.fn(), startDeploy: vi.fn() }));

import { DvmError } from "@dvmkit/sdk/internal";
import { handleError } from "../../../lib/error-handler.ts";
import * as output from "../../../shared/output.ts";
import * as platformClient from "../../../lib/platform-client.ts";
import { deploy, type DeployOptions } from "../deploy.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function project() {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-deploy-env-"));
  directories.push(directory);
  writeFileSync(join(directory, "handler.ts"), "export default {};\n");
  writeFileSync(join(directory, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(directory, ".env"), "REPLACE=project\nKEEP=project-only\n");
  return directory;
}

it.each(["cloud", undefined] as const)("deploy %s sends stdin overrides over project .env without changing the file or inheriting unrelated process env", async (target) => {
  const cwd = project();
  const input = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  vi.stubEnv("SHOULD_NOT_UPLOAD", "inherited-secret");
  const stop = new Error("stop after observing outbound deployment");
  vi.mocked(platformClient.startDeploy).mockRejectedValueOnce(stop);
  const running = deploy({ target, envStdin: true, allowDirty: true, name: "example" }, cwd);
  input.end(JSON.stringify({ REPLACE: "stdin-secret", ADDED: "new-secret", EMPTY: "" }));
  await expect(running).rejects.toBe(stop);
  expect(platformClient.startDeploy).toHaveBeenCalledWith(expect.any(String), "test-token", expect.objectContaining({
    env: { REPLACE: "stdin-secret", KEEP: "project-only", ADDED: "new-secret", EMPTY: "" },
  }));
  expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("REPLACE=project\nKEEP=project-only\n");
});

it("deploy rejects malformed stdin before contacting the platform or inspecting the project", async () => {
  const input = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  const running = deploy({ target: "cloud", envStdin: true }, "/nonexistent-project");
  input.end('{"TOKEN":"hidden-secret"');
  await expect(running).rejects.toMatchObject({ code: "invalid_env_stdin" });
  expect(platformClient.validateAuth).not.toHaveBeenCalled();
  expect(platformClient.startDeploy).not.toHaveBeenCalled();
});

it("deploy without the flag never reads stdin and keeps existing extraEnv precedence", async () => {
  const cwd = project();
  const input = vi.spyOn(process, "stdin", "get");
  const stop = new Error("stop after observing outbound deployment");
  vi.mocked(platformClient.startDeploy).mockRejectedValueOnce(stop);
  await expect(deploy({ target: "cloud", allowDirty: true, name: "example", extraEnv: { REPLACE: "existing-override" } }, cwd)).rejects.toBe(stop);
  expect(input).not.toHaveBeenCalled();
  expect(platformClient.startDeploy).toHaveBeenCalledWith(expect.any(String), "test-token", expect.objectContaining({
    env: { REPLACE: "existing-override", KEEP: "project-only" },
  }));
});


it.each([
  ["self-host", { target: "self-host" }],
  ["local", { target: "local" }],
  ["local", { local: true, target: "cloud" }],
  ["connect-tier", { endpointUrl: "https://example.test" }],
  ["dry-run", { dryRun: true, target: "cloud" }],
] as const)("deploy rejects environment overrides for %s before reading stdin or contacting the platform", async (mode, options) => {
  const stdin = vi.spyOn(process, "stdin", "get");
  await expect(deploy({ ...options, envStdin: true } as DeployOptions, "/nonexistent-project")).rejects.toMatchObject({
    code: "env_stdin_unsupported_target",
    message: `--env-stdin is not supported for ${mode} deployment.`,
    hint: expect.stringContaining("--target cloud"),
  });
  expect(stdin).not.toHaveBeenCalled();
  expect(platformClient.validateAuth).not.toHaveBeenCalled();
  expect(platformClient.startDeploy).not.toHaveBeenCalled();
});


it.each([false, true])("deploy redacts reflected stdin values through the %s error renderer while retaining provider diagnostics", async (human) => {
  const input = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  const secret = "stdin-reflected-marker";
  vi.mocked(platformClient.startDeploy).mockRejectedValueOnce(new DvmError(
    "invalid_deployment",
    `Invalid environment value ${secret}`,
    `Correct ${secret} and retry`,
    { display: `Rejected ${secret}`, next_step: `Replace ${secret}`, details: [{ value: secret }], [secret]: secret },
    `Cannot deploy ${secret}`,
    { message: "provider", hint: "provider", display: "provider" }
  ));
  const running = deploy({ target: "cloud", envStdin: true, allowDirty: true, name: "example" }, project());
  input.end(JSON.stringify({ TOKEN: secret }));
  const error = await running.catch((error: unknown) => error);
  const json = vi.spyOn(output, "json").mockImplementation(() => undefined);
  const info = vi.spyOn(output, "info").mockImplementation(() => undefined);
  const stop = new Error("terminal exit");
  vi.spyOn(process, "exit").mockImplementation(() => { throw stop; });
  expect(() => handleError(error, human)).toThrow(stop);
  const rendered = JSON.stringify(human ? info.mock.calls : json.mock.calls);
  expect(rendered).not.toContain(secret);
  expect(rendered).toContain("[redacted]");
  expect(rendered).toContain("Rejected");
  expect(rendered).toContain("Correct");
  if (!human) {
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: "invalid_deployment", details: [{ value: "[redacted]" }] }) }));
    expect(error).toMatchObject({ proseSources: { message: "provider", hint: "provider", display: "provider" } });
  }
});

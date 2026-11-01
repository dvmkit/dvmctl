import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// identityCreate stays real: the binding preflight must run inside it, before
// any key is written or any packaging starts.
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveAuth: vi.fn(() => ({ token: "tok", account: "api-key" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../lib/platform-client", () => ({
  getAuthenticatedBuilderProfile: vi.fn(),
}));
vi.mock("../deploy-context", () => ({
  createTarball: vi.fn(),
  packagedTreeDirtyPaths: vi.fn(() => []),
  resolveBuildContext: vi.fn(),
}));
vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn(), progress: vi.fn() }));

import { BUILDER_FILE, BUILDER_KEY_FILE } from "../../../shared/defaults";
import * as platformClient from "../../../lib/platform-client";
import { createTarball, resolveBuildContext } from "../deploy-context";
import { deploy } from "../deploy";

const PROFILE = { id: "b1", email: null, handle: null, displayName: null };

describe("deploy --create-identity against a bound account", () => {
  const originalCwd = process.cwd();
  let project: string;

  beforeEach(() => {
    for (const file of [BUILDER_FILE, BUILDER_KEY_FILE]) rmSync(file, { force: true });
    project = mkdtempSync(join(tmpdir(), "dvmctl-deploy-bound-"));
    writeFileSync(join(project, "handler.ts"), "export default {};\n");
    process.chdir(project);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(project, { recursive: true, force: true });
    for (const file of [BUILDER_FILE, BUILDER_KEY_FILE]) rmSync(file, { force: true });
  });

  it("refuses with identity_bound_elsewhere before writing a key or packaging", async () => {
    vi.mocked(platformClient.getAuthenticatedBuilderProfile).mockResolvedValue({
      ...PROFILE,
      identity_pubkey: "ab12cd34" + "0".repeat(56),
    });

    await expect(deploy({ target: "cloud", createIdentity: true })).rejects.toMatchObject({
      code: "identity_bound_elsewhere",
    });

    expect(existsSync(BUILDER_KEY_FILE)).toBe(false);
    expect(existsSync(BUILDER_FILE)).toBe(false);
    expect(resolveBuildContext).not.toHaveBeenCalled();
    expect(createTarball).not.toHaveBeenCalled();
  });

  it("creates the key as before when the platform reports no bound identity", async () => {
    vi.mocked(platformClient.getAuthenticatedBuilderProfile).mockResolvedValue(PROFILE);

    // The deploy proceeds past identity creation and stops at the unmocked platform calls.
    await deploy({ target: "cloud", createIdentity: true }).catch(() => undefined);

    expect(existsSync(BUILDER_KEY_FILE)).toBe(true);
  });
});

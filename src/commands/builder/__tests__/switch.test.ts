import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import * as platform from "../../../lib/platform";
import { json } from "../../../shared/output";
import { switchCmd } from "../switch";

describe("dvmctl switch — context helpers", () => {
  let dir: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.DVMCTL_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "dvmctl-switch-"));
    process.env.DVMCTL_CONFIG_DIR = dir;
  });

  // Restore rather than `delete`: the whole run has a `DVMCTL_CONFIG_DIR`
  // sandbox, and dropping the var would put anything after it back
  // on the real `~/.dvmctl`.
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalConfigDir === undefined) delete process.env.DVMCTL_CONFIG_DIR;
    else process.env.DVMCTL_CONFIG_DIR = originalConfigDir;
  });

  it("save / load / clear round-trip", () => {
    expect(platform.loadActiveOrg()).toBeNull();
    platform.saveActiveOrg("acme");
    expect(platform.loadActiveOrg()).toBe("acme");
    platform.saveActiveOrg("beta");
    expect(platform.loadActiveOrg()).toBe("beta");
    platform.clearActiveOrg();
    expect(platform.loadActiveOrg()).toBeNull();
  });

  it("preserves auth credentials when writing context", () => {
    // Pretend we already have auth saved (simulating prior `dvmctl auth`)
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ auth: { token: "dvmk_existing", account: "x@y.z" } })
    );
    platform.saveActiveOrg("acme");

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(config.auth).toMatchObject({ token: "dvmk_existing", account: "x@y.z" });
    expect(config.context).toMatchObject({ activeOrg: "acme" });
  });

  // The context used to reach `deploy` alone, so a builder who had
  // switched still read their personal org. Every command resolves it now.
  it("resolves the scope from --org first, then the persisted context", () => {
    expect(platform.resolveOrgScope({})).toBeUndefined();

    platform.saveActiveOrg("acme");
    expect(platform.resolveOrgScope({})).toBe("acme");
    expect(platform.resolveOrgScope({ org: "beta" })).toBe("beta");

    platform.clearActiveOrg();
    expect(platform.resolveOrgScope({ org: "beta" })).toBe("beta");
    expect(platform.resolveOrgScope({})).toBeUndefined();
  });

  it("clears context without dropping auth", () => {
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        auth: { token: "dvmk_existing", account: "x@y.z" },
        context: { activeOrg: "acme" },
      })
    );
    platform.clearActiveOrg();
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(config.auth).toBeDefined();
    expect(config.context).toBeUndefined();
  });
});

describe("dvmctl switch — command", () => {
  let dir: string;
  const jsonMock = vi.mocked(json);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dvmctl-switch-cmd-"));
    process.env.DVMCTL_CONFIG_DIR = dir;
    jsonMock.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DVMCTL_CONFIG_DIR;
    delete process.env.DVMKIT_PLATFORM_URL;
    delete process.env.DVMKIT_API_KEY;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("`switch` (no args) prints null when no context is set", async () => {
    await switchCmd(undefined, {});
    expect(jsonMock).toHaveBeenCalledWith({ activeOrg: null });
  });

  it("`switch --personal` clears context", async () => {
    platform.saveActiveOrg("acme");
    await switchCmd(undefined, { personal: true });
    expect(platform.loadActiveOrg()).toBeNull();
    expect(jsonMock).toHaveBeenCalledWith({ activeOrg: null });
  });

  it("`switch <handle>` errors when not authenticated", async () => {
    await expect(switchCmd("acme", {})).rejects.toMatchObject({ code: "auth_required" });
  });

  it("`switch <handle>` verifies membership and persists on success", async () => {
    process.env.DVMKIT_API_KEY = "dvmk_test";
    process.env.DVMKIT_PLATFORM_URL = "http://platform.test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ org: { handle: "acme", displayName: "Acme" }, role: "admin" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await switchCmd("acme", {});

    expect(fetchMock).toHaveBeenCalledWith(
      "http://platform.test/api/v1/builder/orgs/acme",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer dvmk_test" }),
      })
    );
    expect(platform.loadActiveOrg()).toBe("acme");
    expect(jsonMock).toHaveBeenCalledWith({ activeOrg: "acme", role: "admin" });
  });

  it("`switch <handle>` propagates 404 (org missing or not a member)", async () => {
    process.env.DVMKIT_API_KEY = "dvmk_test";
    process.env.DVMKIT_PLATFORM_URL = "http://platform.test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(switchCmd("ghost", {})).rejects.toMatchObject({ code: "org_not_found" });
    expect(platform.loadActiveOrg()).toBeNull();
  });

  it("rejects passing both <handle> and --personal", async () => {
    await expect(switchCmd("acme", { personal: true })).rejects.toMatchObject({
      code: "bad_arguments",
    });
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearAuthToken, loadAuthToken, resolveAuth, saveAuthToken } from "../platform";

// Point the `dvmctl` state root at a fresh dir per test, so each starts with no
// stored token and nothing touches the real `~/.dvmctl/`. `DVMCTL_CONFIG_DIR`
// rather than HOME: the whole run already has a `DVMCTL_CONFIG_DIR`
// sandbox, and the more specific var wins over `homedir()` — so overriding HOME
// alone would silently land every test in the shared run-level dir.
describe("platform auth", () => {
  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.DVMCTL_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvmctl-platform-"));
    process.env.DVMCTL_CONFIG_DIR = tmpConfigDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVMCTL_CONFIG_DIR;
    else process.env.DVMCTL_CONFIG_DIR = originalConfigDir;
    delete process.env.DVMKIT_API_KEY;
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it("saves and loads auth token", () => {
    saveAuthToken({ token: "dvmk_abc", account: "builder" });
    const creds = loadAuthToken();
    expect(creds).toEqual({ token: "dvmk_abc", account: "builder" });
  });

  it("returns null when no token saved", () => {
    expect(loadAuthToken()).toBeNull();
  });

  it("clears auth token", () => {
    saveAuthToken({ token: "dvmk_abc", account: "builder" });
    clearAuthToken();
    expect(loadAuthToken()).toBeNull();
  });

  it("creates config directory if missing", () => {
    saveAuthToken({ token: "dvmk_test", account: "test" });
    expect(existsSync(join(tmpConfigDir, "config.json"))).toBe(true);
  });

  it("DVMKIT_API_KEY env overrides stored token", () => {
    saveAuthToken({ token: "dvmk_stored", account: "stored" });
    process.env.DVMKIT_API_KEY = "dvmk_env";
    const creds = resolveAuth();
    expect(creds?.token).toBe("dvmk_env");
    expect(creds?.account).toBe("api-key");
  });

  it("resolveAuth returns stored token when no env var", () => {
    saveAuthToken({ token: "dvmk_stored", account: "stored" });
    const creds = resolveAuth();
    expect(creds?.token).toBe("dvmk_stored");
  });

  it("resolveAuth returns null when nothing configured", () => {
    expect(resolveAuth()).toBeNull();
  });
});

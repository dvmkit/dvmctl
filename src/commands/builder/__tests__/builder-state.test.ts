import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SPAWN_HEAVY_TIMEOUT } from "../../../test-support/spawn-budget";

const cli = resolve(import.meta.dirname, "../../../../dist/dvmctl.js");
const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("builder state directory isolation", { timeout: SPAWN_HEAVY_TIMEOUT }, () => {
  let root: string;
  let builder: string;
  let caller: string;
  let legacy: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "dvmctl-builder-state-")));
    builder = join(root, "builder");
    caller = join(root, ".dvm");
    mkdirSync(caller);
    legacy = join(caller, "recovery.mnemonic");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        OPENSSL_CONF: process.env.OPENSSL_CONF,
        HOME: root,
        USERPROFILE: root,
        DVM_CONFIG_DIR: caller,
        DVMKIT_CONFIG_DIR: builder,
        DVMCTL_CONFIG_DIR: join(root, "auth"),
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it.each([false, true])("stops for an explicit import or force when caller words exist (human=%s)", (human) => {
    writeFileSync(legacy, WORDS + "\n", { mode: 0o600 });

    const result = run("lock", "create", ...(human ? ["--human"] : []));

    expect(result.status).toBe(1);
    const diagnostic = human ? result.stderr : JSON.parse(result.stdout).error.hint as string;
    expect(diagnostic).toContain(legacy);
    expect(diagnostic).toContain("DVMKIT_CONFIG_DIR");
    expect(diagnostic).toContain("dvmctl lock create --import");
    expect(diagnostic).toContain("--force");
    expect(result.stdout + result.stderr).not.toContain(WORDS);
    expect(existsSync(join(builder, "builder.mnemonic"))).toBe(false);
    expect(existsSync(join(builder, "builder.mnemonic.tmp"))).toBe(false);
    expect(readFileSync(legacy, "utf8")).toBe(WORDS + "\n");
  });

  it("imports known words into the selected tree and leaves caller files untouched", () => {
    writeFileSync(legacy, WORDS + "\n", { mode: 0o600 });

    const result = run("lock", "create", "--import", WORDS);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "imported", configDir: builder, configDirEnv: "DVMKIT_CONFIG_DIR" });
    expect(readFileSync(join(builder, "builder.mnemonic"), "utf8")).toBe(WORDS + "\n");
    expect(readFileSync(legacy, "utf8")).toBe(WORDS + "\n");
    expect(readdirSync(caller)).toEqual(["recovery.mnemonic"]);
  });

  it("creates independent words with force without backing up or moving caller words", () => {
    writeFileSync(legacy, WORDS + "\n", { mode: 0o600 });

    const result = run("lock", "create", "--force");

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "generated", configDir: builder });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("backupFile");
    expect(readFileSync(join(builder, "builder.mnemonic"), "utf8").trim()).not.toBe(WORDS);
    expect(readFileSync(legacy, "utf8")).toBe(WORDS + "\n");
    expect(readdirSync(caller)).toEqual(["recovery.mnemonic"]);
  });

  it("reports the directory that actually contains newly generated secrets and existing identity", () => {
    // A relative override must be reported as the absolute directory used by the CLI.
    builder = "builder";
    const expectedDirectory = join(root, builder);
    const lock = run("lock", "create");
    expect(lock.status, lock.stderr).toBe(0);
    expect(JSON.parse(lock.stdout)).toMatchObject({ status: "generated", configDir: expectedDirectory, configDirEnv: "DVMKIT_CONFIG_DIR" });
    expect(existsSync(join(expectedDirectory, "builder.mnemonic"))).toBe(true);
    const repeated = run("lock", "create");
    expect(JSON.parse(repeated.stdout)).toMatchObject({ status: "already_exists", configDir: expectedDirectory });

    const identity = run("identity", "create");
    expect(identity.status, identity.stderr).toBe(0);
    const created = JSON.parse(identity.stdout);
    expect(created).toMatchObject({ status: "created", configDir: expectedDirectory, configDirEnv: "DVMKIT_CONFIG_DIR" });
    expect(existsSync(join(expectedDirectory, "builder.key"))).toBe(true);
    const shown = run("identity", "show");
    expect(shown.status, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ identity_pubkey: created.identity_pubkey, configDir: expectedDirectory });
    expect(existsSync(join(root, "auth", "builder.key"))).toBe(false);
  });
});

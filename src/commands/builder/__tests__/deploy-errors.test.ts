import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../../../dist/dvmctl.js");

describe("deploy CLI handler precheck", () => {
  let directory: string;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "dvmctl-deploy-errors-")));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, "deploy", ...args], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        OPENSSL_CONF: process.env.OPENSSL_CONF,
        HOME: directory,
        USERPROFILE: directory,
        DVM_CONFIG_DIR: join(directory, "caller"),
        DVMKIT_CONFIG_DIR: join(directory, "builder"),
        DVMCTL_CONFIG_DIR: join(directory, "auth"),
      },
      encoding: "utf8",
      timeout: 4_000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it.each([
    ["default", []],
    ["local flag", ["--local"]],
    ["dry run", ["--dry-run"]],
    ["cloud target", ["--target", "cloud"]],
    ["self-host target", ["--target", "self-host"]],
    ["local target", ["--target", "local"]],
  ])("reports a handled JSON error for %s without a handler", (_mode, args) => {
    const result = run(...args);

    expect(result.status, result.stderr).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe("handler_not_found");
    expect(error.message).toContain(directory);
    expect(error.message).toContain("handler.ts");
    expect(error.message).toContain("handler.js");
    expect(error.hint).toEqual(expect.stringMatching(/handler\.ts.*handler\.js/));
  });

  it("allows an endpoint dry run without a handler", () => {
    const result = run("--endpoint-url", "https://example.test", "--dry-run", "--name", "example");

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "dry-run-ok", runtime: "connect", slug: "example" });
  });
});

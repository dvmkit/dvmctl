import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = resolve(import.meta.dirname, "../../../../dist/dvmctl.js");

describe("deploy CLI diagnostics", () => {
  let directory: string;
  let executablePath: string | undefined;

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "dvmctl-deploy-errors-")));
    executablePath = process.env.PATH;
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function run(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, "deploy", ...args], {
      cwd: directory,
      env: {
        PATH: executablePath,
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

  function dockerProject(script?: string) {
    writeFileSync(join(directory, "handler.ts"), "export default {};\n");
    writeFileSync(join(directory, "package.json"), '{"name":"example"}\n');
    writeFileSync(join(directory, "Dockerfile"), "FROM scratch\n");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    // GNU tar invokes gzip for compressed archives. Preserve both tools while
    // excluding any installed Docker binary.
    for (const tool of ["tar", "gzip"]) {
      const executable = process.env.PATH?.split(delimiter).map((path) => join(path, tool)).find(existsSync);
      if (!executable) throw new Error(`Tests require ${tool} on PATH`);
      symlinkSync(executable, join(bin, tool));
    }
    executablePath = bin;
    if (script !== undefined) {
      writeFileSync(join(bin, "docker"), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
    }
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

  it("reports the last 40 build lines across stdout and stderr without altering their contents", () => {
    dockerProject(`
      const { writeSync } = require('node:fs');
      for (let line = 1; line <= 45; line++) writeSync(1, 'line-' + line + '\\n');
      writeSync(2, '  final failure\\t\\u001b[31m\\r\\n');
      process.exit(1);
    `);
    const result = run("--dry-run");
    expect(result.status).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe("docker_build_failed");
    expect(error.message).toContain("Dockerfile failed to build");
    expect(error.message).not.toContain("line-6\n");
    const expectedTail = Array.from({ length: 39 }, (_, index) => `line-${index + 7}\n`).join("") + "  final failure\t\u001b[31m\r\n";
    expect(error.message.endsWith(expectedTail)).toBe(true);
    expect(error.hint).toMatch(/hosted.*builds on the platform.*does not require local Docker/);
    expect(result.stderr).not.toContain("final failure");
  });

  it("caps a long multibyte build log at 4 KiB while retaining the end", () => {
    dockerProject(`require('node:fs').writeSync(2, 'é'.repeat(5000) + 'END'); process.exit(1);`);
    const result = run("--dry-run");
    const { error } = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    const tail = error.message.slice(error.message.indexOf("\n") + 1);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
    expect(tail).toBe("é".repeat(2046) + "END");
    expect(tail).not.toContain("�");
  });

  it.each([0, 1])("does not stop a verbose build at the pipe buffer limit (exit %s)", (status) => {
    dockerProject(`
      const { writeSync } = require('node:fs');
      for (let index = 0; index < 2048; index++) writeSync(2, 'x'.repeat(1024));
      writeSync(2, '\\nlast build diagnostic\\n');
      process.exit(${status});
    `);
    const result = run("--dry-run");
    expect(result.status).toBe(status);
    const output = JSON.parse(result.stdout);
    if (status === 0) expect(output).toMatchObject({ status: "dry-run-ok", docker_built: true });
    else expect(output.error.message).toMatch(/last build diagnostic\n$/);
  });

  it("reports unavailable Docker when no executable exists on PATH", () => {
    dockerProject();
    const result = run("--dry-run");
    expect(result.status).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.code).toBe("docker_build_failed");
    expect(error.message).toMatch(/Docker is not available/);
    expect(error.message).not.toContain("build failed");
  });

  it.each([
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    "error during connect: connection refused",
  ])("identifies an unavailable daemon: %s", (diagnostic) => {
    dockerProject(`require('node:fs').writeSync(2, ${JSON.stringify(diagnostic)}); process.exit(1);`);
    const result = run("--dry-run");
    expect(result.status).toBe(1);
    const { error } = JSON.parse(result.stdout);
    expect(error.message).toMatch(/Docker daemon is not available/);
    expect(error.message).toContain(diagnostic);
  });

  it.each([0, 1])("preserves inherited Docker output in human mode (exit %s)", (status) => {
    dockerProject(`
      const { writeSync } = require('node:fs');
      writeSync(1, 'human stdout\\n');
      writeSync(2, 'human stderr\\n');
      process.exit(${status});
    `);
    const result = run("--dry-run", "--human");
    expect(result.status).toBe(status);
    expect(result.stdout).toBe("human stdout\n");
    expect(result.stderr).toContain("human stderr\n");
    expect(result.stderr.match(/human stderr/g)).toHaveLength(1);
  });

  it.each([0, 1])("removes the temporary build workspace after Docker exits with %s", (status) => {
    const seenContext = join(directory, "seen-context");
    dockerProject(`
      require('node:fs').writeFileSync(${JSON.stringify(seenContext)}, process.argv.at(-1));
      process.exit(${status});
    `);
    const result = run("--dry-run");
    expect(result.status).toBe(status);
    const context = readFileSync(seenContext, "utf8");
    expect(existsSync(dirname(context))).toBe(false);
  });
});

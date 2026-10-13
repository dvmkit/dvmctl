import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = join(process.cwd(), "dist/dvmctl.js");
for (const human of [false, true]) {
  test(`compiled deploy rejects invalid environment input with redacted ${human ? "human" : "JSON"} errors`, () => {
    for (const input of ['{"TOKEN":"secret-marker"', '{"TOKEN":{"value":"secret-marker"}}', '[]', '', JSON.stringify({ TOKEN: "secret-marker".repeat(6_000) })]) {
      const result = spawnSync(process.execPath, [cli, "deploy", "--target", "cloud", "--env-stdin", ...(human ? ["--human"] : [])], {
        input,
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-marker|No handler/);
      if (human) assert.match(result.stderr, /env-stdin/);
      else assert.equal(JSON.parse(result.stdout).error.code, "invalid_env_stdin");
    }
  });
}

test("compiled deploy refuses terminal stdin immediately", context => {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-deploy-stdin-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, "terminal.cjs");
  writeFileSync(preload, 'Object.defineProperty(process.stdin, "isTTY", { value: true });\n');
  const result = spawnSync(process.execPath, ["--require", preload, cli, "deploy", "--env-stdin"], { input: "{}", encoding: "utf8", timeout: 2_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "invalid_env_stdin");
  assert.match(JSON.parse(result.stdout).error.message, /piped input/);
});


for (const human of [false, true]) {
  test(`compiled deploy redacts platform-reflected stdin values in ${human ? "human" : "JSON"} diagnostics`, context => {
    const directory = mkdtempSync(join(tmpdir(), "dvmctl-deploy-reflection-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "handler.ts"), "export default {};\n");
    writeFileSync(join(directory, "Dockerfile"), "FROM scratch\n");
    const preload = join(directory, "platform.cjs");
    const marker = "stdin-reflected-marker";
    writeFileSync(preload, `global.fetch = async (input) => String(input).endsWith("/auth/me")
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({ error: { code: "invalid_deployment", message: "Invalid value ${marker}", hint: "Correct ${marker} and retry", data: { display: "Rejected ${marker}", next_step: "Replace ${marker}", nested: [{ token: "${marker}" }], "${marker}": "${marker}" } } }), { status: 400, headers: { "Content-Type": "application/json" } });`);
    const result = spawnSync(process.execPath, ["--require", preload, cli, "deploy", "--target", "cloud", "--env-stdin", "--create-identity", "--allow-dirty", "--name", "example", ...(human ? ["--human"] : [])], {
      cwd: directory,
      input: JSON.stringify({ TOKEN: marker }),
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: directory, DVM_CONFIG_DIR: join(directory, "caller"), DVMKIT_CONFIG_DIR: join(directory, "builder"), DVMCTL_CONFIG_DIR: join(directory, "auth"), DVMKIT_API_KEY: "test-token", DVMKIT_PLATFORM_URL: "https://platform.example" },
    });
    assert.equal(result.status, 1, result.stderr);
    const rendered = result.stdout + result.stderr;
    assert.doesNotMatch(rendered, /stdin-reflected-marker/);
    assert.match(rendered, /\[redacted\]/);
    assert.match(rendered, /Correct|Rejected/);
    if (!human) {
      const error = JSON.parse(result.stdout).error;
      assert.equal(error.code, "invalid_deployment");
      assert.deepEqual(error.nested, [{ token: "[redacted]" }]);
    }
  });
}

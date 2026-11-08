import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const account = "new-builder@example.test";

async function fixture(context, mode) {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-auth-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const browser = join(directory, "browser.json");
  const preload = join(directory, "preload.cjs");
  // Replace only the external browser and poll delay; the compiled command owns all output and state.
  writeFileSync(preload, `
const { syncBuiltinESMExports } = require("node:module");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { writeFileSync } = fs;
let stdout = "", stderr = "";
for (const [stream, append] of [[process.stdout, chunk => stdout += chunk], [process.stderr, chunk => stderr += chunk]]) {
  const original = stream.write;
  stream.write = function(chunk, ...args) { append(String(chunk)); return original.call(this, chunk, ...args); };
}
const originalWriteSync = fs.writeSync;
fs.writeSync = (fd, buffer, ...args) => {
  const written = originalWriteSync(fd, buffer, ...args);
  const text = Buffer.isBuffer(buffer) ? buffer.subarray(args[0] ?? 0, (args[0] ?? 0) + written).toString() : buffer.slice(0, written);
  if (fd === 1) stdout += text;
  if (fd === 2) stderr += text;
  return written;
};
childProcess.exec = command => { writeFileSync(${JSON.stringify(browser)}, JSON.stringify({ command, stdout, stderr })); };
syncBuiltinESMExports();
const originalTimeout = global.setTimeout;
global.setTimeout = (done, ms, ...args) => originalTimeout(done, ms >= 1000 && ms < 1500 ? 1 : ms, ...args);
`);
  let polls = 0;
  const requests = [];
  const server = createServer((req, res) => {
    polls += 1;
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(mode === "timeout" ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mode === "cancel" ? { cancelled: true } : { token: "local-test-token", account }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const config = join(directory, "config");
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    DVMCTL_CONFIG_DIR: config,
    DVMKIT_PLATFORM_URL: `http://127.0.0.1:${server.address().port}`,
    DVMKIT_WEB_URL: "https://example.test",
  };
  const run = args => new Promise(resolve => {
    execFile(process.execPath, ["--require", preload, join(process.cwd(), "dist/dvmctl.js"), ...args],
      { env, encoding: "utf8", timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  return { run, config, requests, polls: () => polls, browser: () => JSON.parse(readFileSync(browser, "utf8")) };
}

for (const mode of ["cancel", "timeout", "success"]) {
  for (const human of [false, true]) {
    test(`compiled auth ${mode} preserves ${human ? "human guidance and browser ordering" : "documented JSON shapes"}`, async context => {
      const f = await fixture(context, mode);
      const result = await f.run(["auth", ...(human ? ["--human"] : [])]);
      assert.equal(result.code, mode === "success" ? 0 : 1, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /closed beta|invit(?:e|ed)|waitlist/i);
      assert.equal(f.polls(), mode === "timeout" ? 300 : 1);
      const browser = f.browser();
      assert.match(browser.command, /https:\/\/example\.test\/cli-auth\?session=[a-f0-9]{32}&hash=[a-f0-9]{64}&host=/);
      for (const request of f.requests) {
        assert.match(request.path, /^\/api\/v1\/cli-auth\/[a-f0-9]{32}$/);
        assert.match(request.authorization, /^Bearer [a-f0-9]{64}$/);
      }
      if (human) {
        assert.match(browser.stdout, /^\nOpening browser to authenticate\.\.\.\n[^\n]+\n/);
        const sessionCode = browser.command.match(/session=([a-f0-9]{32})/)[1].slice(0, 12);
        assert.ok(browser.stdout.includes(`Session code: ${sessionCode}`));
        if (mode === "cancel") assert.match(result.stdout, /\nSign-in cancelled\.\n[^\n]*dvmctl auth[^\n]*\n$/);
        if (mode === "timeout") assert.match(result.stderr, /Authentication timed out.*Try again.*DVMKIT_API_KEY/s);
        if (mode === "success") assert.ok(result.stdout.endsWith(`\nAuthenticated as ${account}\n`));
      } else {
        assert.equal(browser.stdout, "");
        const startup = JSON.parse(browser.stderr);
        assert.equal(startup.status, "opening_browser");
        assert.equal(typeof startup.hint, "string");
        assert.ok(startup.hint.length > 0);
        const url = new URL(startup.url);
        assert.equal(startup.fingerprint, url.searchParams.get("session").slice(0, 12));
        assert.ok(startup.display.includes(`Session code: ${startup.fingerprint}`));
        assert.equal(result.stderr, browser.stderr);
        assert.equal(result.stdout.trim().split("\n").length, 1);
        const final = JSON.parse(result.stdout);
        if (mode === "cancel") {
          assert.deepEqual(Object.keys(final).sort(), ["authenticated", "cancelled", "display", "hint"]);
          assert.equal(final.authenticated, false);
          assert.equal(final.cancelled, true);
          assert.equal(final.display, "Sign-in cancelled.");
          assert.equal(typeof final.hint, "string");
          assert.match(final.hint, /dvmctl auth/);
        }
        if (mode === "timeout") {
          assert.deepEqual(Object.keys(final).sort(), ["authenticated", "display", "hint", "timed_out"]);
          assert.equal(final.authenticated, false);
          assert.equal(final.timed_out, true);
          assert.match(final.display, /Authentication timed out.*Try again.*DVMKIT_API_KEY/s);
          assert.match(final.hint, /Try again.*DVMKIT_API_KEY/s);
        }
        if (mode === "success") assert.deepEqual(final, { authenticated: true, account });
      }
      const configPath = join(f.config, "config.json");
      assert.equal(existsSync(configPath), mode === "success");
      if (mode === "success") {
        assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).auth, { token: "local-test-token", account });
        const existing = await f.run(["auth"]);
        assert.equal(existing.code, 0);
        assert.deepEqual(JSON.parse(existing.stdout), { authenticated: true, account });
        assert.equal(existing.stderr, "");
        assert.equal(f.polls(), 1);
      }
    });
  }
}

test("compiled auth_required retains its API key and auth command hint", async context => {
  const f = await fixture(context, "cancel");
  const result = await f.run(["list"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "");
  const error = JSON.parse(result.stdout);
  assert.equal(error.error.code, "auth_required");
  assert.equal(error.error.hint, "Set DVMKIT_API_KEY or run `dvmctl auth`.");
  assert.equal(f.polls(), 0);
});

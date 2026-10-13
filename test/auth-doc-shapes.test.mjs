import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const betaHint = "dvmkit is in a closed beta: sign in with an invited account. No invite yet? Join the waitlist at https://dvmkit.com/waitlist";
const timeoutMessage = "Authentication timed out. Try again, or join the waitlist at https://dvmkit.com/waitlist if you don't have an invite yet. DVMKIT_API_KEY skips the browser.";
const account = "invited@example.test";

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
      assert.equal(f.polls(), mode === "timeout" ? 300 : 1);
      const browser = f.browser();
      assert.match(browser.command, /https:\/\/example\.test\/cli-auth\?session=[a-f0-9]{32}&hash=[a-f0-9]{64}&host=/);
      for (const request of f.requests) {
        assert.match(request.path, /^\/api\/v1\/cli-auth\/[a-f0-9]{32}$/);
        assert.match(request.authorization, /^Bearer [a-f0-9]{64}$/);
      }
      if (human) {
        assert.ok(browser.stdout.startsWith(`\nOpening browser to authenticate...\n${betaHint}\n`));
        if (mode === "cancel") assert.ok(result.stdout.endsWith(`\nSign-in cancelled.\n${betaHint}\n`));
        if (mode === "timeout") assert.equal(result.stderr, `\n${timeoutMessage}\n`);
        if (mode === "success") assert.ok(result.stdout.endsWith(`\nAuthenticated as ${account}\n`));
      } else {
        assert.equal(browser.stdout, "");
        const startup = JSON.parse(browser.stderr);
        assert.equal(startup.status, "opening_browser");
        assert.equal(startup.display, "Opening browser to authenticate...");
        assert.equal(startup.hint, betaHint);
        const url = new URL(startup.url);
        assert.equal(startup.fingerprint, url.searchParams.get("session").slice(0, 12));
        assert.equal(result.stderr, browser.stderr);
        assert.equal(result.stdout.trim().split("\n").length, 1);
        const final = JSON.parse(result.stdout);
        if (mode === "cancel") assert.deepEqual(final, { authenticated: false, cancelled: true, display: "Sign-in cancelled.", hint: betaHint });
        if (mode === "timeout") assert.deepEqual(final, { authenticated: false, timed_out: true, display: timeoutMessage, hint: timeoutMessage });
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

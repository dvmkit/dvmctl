import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const account = "new-builder@example.test";

async function fixture(context, mode, { display = ":0", browserCommand, browserFailure = false, revocation = "success" } = {}) {
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
childProcess.spawn = (command, args, options) => {
  writeFileSync(${JSON.stringify(browser)}, JSON.stringify({ command, args, options, stdout, stderr }));
  const child = new (require("node:events").EventEmitter)();
  child.unref = () => {};
  setImmediate(() => {
    if (${browserFailure}) child.emit("error", new Error("missing browser"));
    else { child.emit("spawn"); child.emit("exit", 0, null); }
  });
  return child;
};
syncBuiltinESMExports();
const originalTimeout = global.setTimeout;
global.setTimeout = (done, ms, ...args) => originalTimeout(done, ms >= 1000 && ms < 1500 ? 1 : ms, ...args);
`);
  let polls = 0;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    if (req.url.startsWith("/api/v1/builder/api-keys")) {
      const failed = revocation === "list-fails" || (revocation === "delete-fails" && req.method === "DELETE");
      const keys = revocation === "ambiguous" ? [{ id: "one", key_prefix: "local-test" }, { id: "two", key_prefix: "local-test" }] :
        [{ id: "other", key_prefix: "unrelated" }, { id: "stored", key_prefix: "local-test" }];
      res.writeHead(failed ? 503 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(failed ? { error: { message: "offline" } } : { keys, count: keys.length, limit: 10 }));
      return;
    }
    polls += 1;
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
    // A browser launch is attempted only where a display exists.
    ...(display ? { DISPLAY: display } : {}),
    ...(browserCommand ? { BROWSER: browserCommand } : {}),
  };
  const run = args => new Promise(resolve => {
    execFile(process.execPath, ["--require", preload, join(process.cwd(), "dist/dvmctl.js"), ...args],
      { env, encoding: "utf8", timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
  const seedAuth = () => {
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "config.json"), JSON.stringify({ auth: { token: "local-test-token", account }, context: { activeOrg: "test-org" } }));
  };
  return { run, config, requests, seedAuth, polls: () => polls, browser: () => JSON.parse(readFileSync(browser, "utf8")), browserLaunched: () => existsSync(browser) };
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
      assert.match(browser.args.at(-1), /https:\/\/example\.test\/cli-auth\?session=[a-f0-9]{32}&hash=[a-f0-9]{64}&host=/);
      for (const request of f.requests) {
        assert.match(request.path, /^\/api\/v1\/cli-auth\/[a-f0-9]{32}$/);
        assert.match(request.authorization, /^Bearer [a-f0-9]{64}$/);
      }
      if (human) {
        assert.match(browser.stdout, /^\nOpening browser to authenticate\.\.\.\n[^\n]+\n/);
        const sessionCode = browser.args.at(-1).match(/session=([a-f0-9]{32})/)[1].slice(0, 12);
        assert.ok(browser.stdout.includes(`Session code: ${sessionCode}`));
        if (mode === "cancel") assert.match(result.stdout, /\nSign-in cancelled\.\n[^\n]*dvmctl auth[^\n]*\n$/);
        if (mode === "timeout") assert.match(result.stderr, /Authentication timed out.*Try again.*DVMKIT_API_KEY/s);
        if (mode === "success") assert.ok(result.stdout.endsWith(`\nAuthenticated as ${account}\n`));
      } else {
        assert.equal(browser.stdout, "");
        assert.equal(browser.stderr, "");
        const startup = JSON.parse(result.stderr);
        assert.equal(startup.status, "awaiting_human");
        assert.equal(startup.browser_opened, true);
        assert.match(startup.expires_at, /^\d{4}-\d\d-\d\dT/);
        assert.ok(startup.instruction.includes(startup.url));
        assert.equal(typeof startup.hint, "string");
        assert.ok(startup.hint.length > 0);
        const url = new URL(startup.url);
        assert.equal(startup.fingerprint, url.searchParams.get("session").slice(0, 12));
        assert.ok(startup.display.includes(`Session code: ${startup.fingerprint}`));
        assert.equal(result.stderr.trim().split("\n").length, 1);
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
  assert.match(error.error.hint, /human must sign in/);
  assert.match(error.error.hint, /`dvmctl auth`/);
  assert.match(error.error.hint, /DVMKIT_API_KEY/);
  assert.match(error.error.hint, /https:\/\/dvmkit\.com\/docs\/cli-auth\.md/);
  assert.equal(f.polls(), 0);
});

test("compiled auth on a Linux host without a display asks for the link to be relayed", { skip: process.platform !== "linux" }, async context => {
  const f = await fixture(context, "success", { display: "" });
  const result = await f.run(["auth"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.browserLaunched(), false);
  const event = JSON.parse(result.stderr.trim().split("\n")[0]);
  assert.equal(event.status, "awaiting_human");
  assert.equal(event.browser_opened, false);
  assert.match(event.display, /could not open a browser/i);
  assert.doesNotMatch(result.stderr, /opening browser/i);
});


for (const human of [false, true]) {
  test(`compiled auth --no-browser preserves the URL and code (human=${human})`, async context => {
    const f = await fixture(context, "success", { browserCommand: "isolated-browser" });
    const result = await f.run(["auth", "--no-browser", ...(human ? ["--human"] : [])]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(f.browserLaunched(), false);
    if (human) {
      const session = result.stdout.match(/session=([a-f0-9]{32})/)[1];
      assert.ok(result.stdout.includes(`Session code: ${session.slice(0, 12)}`));
    } else {
      const event = JSON.parse(result.stderr);
      assert.equal(event.browser_opened, false);
      assert.equal(event.fingerprint, new URL(event.url).searchParams.get("session").slice(0, 12));
      assert.ok(event.instruction.includes(event.url));
      assert.ok(event.display.includes(`Session code: ${event.fingerprint}`));
    }
  });
}

for (const browserFailure of [false, true]) {
  test(`compiled auth uses the selected browser and reports its outcome (failure=${browserFailure})`, async context => {
    const f = await fixture(context, "success", { browserCommand: 'isolated-browser --profile "test profile" %s', browserFailure });
    const result = await f.run(["auth"]);
    assert.equal(result.code, 0, result.stderr);
    const event = JSON.parse(result.stderr);
    assert.equal(event.browser_opened, !browserFailure);
    const browser = f.browser();
    assert.equal(browser.command, "isolated-browser");
    assert.deepEqual(browser.args, ["--profile", "test profile", event.url]);
    assert.equal(browser.options.shell, false);
    assert.ok(event.instruction.includes(event.url));
    assert.ok(event.display.includes(`Session code: ${event.fingerprint}`));
  });
}

for (const revocation of ["success", "list-fails", "delete-fails", "ambiguous"]) {
  test(`compiled logout clears only auth state and reports server revocation (${revocation})`, async context => {
    const f = await fixture(context, "success", { revocation });
    f.seedAuth();
    const result = await f.run(["auth", "--logout"]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "logged_out");
    assert.equal(output.revoked, revocation === "success");
    if (revocation !== "success") assert.match(output.hint, /dashboard.*dvmctl api-keys revoke <id>/);
    assert.deepEqual(f.requests.map(({ method, path }) => ({ method, path })), [
      { method: "GET", path: "/api/v1/builder/api-keys" },
      ...(["success", "delete-fails"].includes(revocation) ? [{ method: "DELETE", path: "/api/v1/builder/api-keys/stored" }] : []),
    ]);
    for (const request of f.requests) assert.equal(request.authorization, "Bearer local-test-token");
    assert.deepEqual(JSON.parse(readFileSync(join(f.config, "config.json"), "utf8")), { context: { activeOrg: "test-org" } });
    assert.equal(f.browserLaunched(), false);
    assert.equal(f.polls(), 0);
  });
}

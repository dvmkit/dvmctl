// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_COMMAND_TIMEOUT_MS, observeProcess, preservePrimaryFailure, processCommand, removeTemporaryDirectory, stopProcess } from "./consumer-process.mjs";

/** @param {string} cli @param {string} project @param {NodeJS.ProcessEnv} env */
export async function assertSignedAuth(cli, project, env) {
  const root = mkdtempSync(join(tmpdir(), "dvmctl-signed-auth-"));
  const handler = join(project, "signed-auth-fixture.mjs");
  /** @type {Set<import("node:child_process").ChildProcess>} */
  const children = new Set();
  await preservePrimaryFailure(async () => {
    copyFileSync(new URL("../test/fixtures/signed-auth-handler.mjs", import.meta.url), handler);
    const projectSdk = await sdkModules(project, env);
    const hostSdk = await sdkModules(dirname(resolve(cli)), env);
    assert.ok(realpathSync(fileURLToPath(projectSdk.server)) !== realpathSync(fileURLToPath(hostSdk.server)), "host and project must resolve different physical SDK installations");
    const host = await import(hostSdk.server);
    const projectServer = await import(projectSdk.server);
    assert.notEqual(host.SignedRequestError, projectServer.SignedRequestError, "the fixture must cross error constructors");

    // Keep the CLI bytes identical and change only its disposable dependency
    // tree. The same refusal assertion must reject the pre-repair host.
    const control = join(root, "old-host");
    mkdirSync(join(control, "dist"), { recursive: true });
    copyFileSync(resolve(cli), join(control, "dist/dvmctl.js"));
    const manifest = JSON.parse(readFileSync(resolve(cli, "../../package.json"), "utf8"));
    writeFileSync(join(control, "package.json"), JSON.stringify({
      private: true, type: "module", version: manifest.version,
      dependencies: { ...manifest.dependencies, "@dvmkit/sdk": "0.25.0" },
    }));
    await installControl(control, env);
    const controlCli = join(control, "dist/dvmctl.js");
    await exercise(controlCli, project, handler, projectSdk, env, true, children);
    await exercise(cli, project, handler, projectSdk, env, false, children);
    console.log("consumer smoke: separate-SDK auth refusals preserve state; the legacy host fails the same refusal assertion");
  }, async () => {
    for (const child of children) if (!await stopProcess(child)) throw new Error("signed-auth process is still running; fixture files retained");
    rmSync(handler, { force: true });
    await removeTemporaryDirectory(root);
  });
}

/** @param {string} cwd @param {NodeJS.ProcessEnv} env */
async function sdkModules(cwd, env) {
  const result = await processCommand(process.execPath, ["--input-type=module", "-e", `
    process.stdout.write(JSON.stringify({
      ...Object.fromEntries(["root", "server", "testing"].map((entry) => [entry, import.meta.resolve(entry === "root" ? "@dvmkit/sdk" : "@dvmkit/sdk/" + entry)])),
      mppx: import.meta.resolve("mppx"),
    }));
  `], { cwd, env, capture: true });
  return /** @type {{root: string, server: string, testing: string, mppx: string}} */ (JSON.parse(result.stdout));
}

/** @param {string} cwd @param {NodeJS.ProcessEnv} env */
async function installControl(cwd, env) {
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"];
  if (process.platform === "win32") {
    await processCommand("cmd.exe", ["/d", "/s", "/c", "npm.cmd " + args.join(" ")], { cwd, env, timeout: INSTALL_COMMAND_TIMEOUT_MS });
  } else {
    await processCommand("npm", args, { cwd, env, timeout: INSTALL_COMMAND_TIMEOUT_MS });
  }
}

/**
 * @param {string} cli @param {string} project @param {string} handler
 * @param {{root: string, server: string, mppx: string}} projectSdk @param {NodeJS.ProcessEnv} env @param {boolean} oldHost
 * @param {Set<import("node:child_process").ChildProcess>} children
 */
async function exercise(cli, project, handler, projectSdk, env, oldHost, children) {
  const hostSdk = await sdkModules(dirname(resolve(cli)), env);
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve(cli), "dev", handler, "--no-reload", "--port", String(port)], {
    cwd: project, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, DVMCTL_AUTH_HOST_TESTING: hostSdk.testing, DVMKIT_FX_SOURCE: "https://fixture.invalid/fx" },
  });
  children.add(child);
  observeProcess(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { output += chunk; });
  await preservePrimaryFailure(async () => {
    await waitUntilReady(child, url, () => output);
    const { createSignedRequestVerifier, z } = await import(projectSdk.root);
    const { Challenge, Credential } = await import(projectSdk.mppx);
    const schema = z.object({
      text: z.string().max(3), pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
    });
    const verifier = createSignedRequestVerifier(schema, { replayStore: null });
    const info = await (await fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(10_000) })).json();
    assert.ok(info.auth_audience, "host must advertise its signed-request audience");
    const key = new Uint8Array(32).fill(1);
    let nonce = 0;
    /** @param {string} path @param {Record<string, unknown>} [data] @param {string} [capability] */
    const sign = (path, data = {}, capability = "run") => verifier.signRequest(key, { text: "ok", ...data }, {
      timestamp: Math.floor(Date.now() / 1000), nonce: `fixture-nonce-${++nonce}`,
    }, { audience: info.auth_audience, method: "POST", path, capability });
    const authorization = Credential.serialize(Credential.from({
      challenge: Challenge.from({
        id: "fixture-payment", realm: "example.com", method: "tempo", intent: "charge",
        request: { amount: "0.01", currency: "0x" + "22".repeat(20) },
      }),
      payload: { type: "hash", hash: "0x" + "33".repeat(32) },
    }));
    /** @param {string} path @param {unknown} data @param {string} [capability] @param {boolean} [paid] */
    const post = async (path, data, capability = "run", paid = false) => {
      const response = await fetch(`${url}${path}`, {
        method: "POST", headers: { "content-type": "application/json", ...(paid ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ capability, data }), signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { message: text }; }
      return { status: response.status, body };
    };
    const effects = async () => {
      const response = await fetch(`${url}/__auth_fixture/effects`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      const { serverModule, ...counters } = await response.json();
      assert.equal(serverModule, realpathSync(fileURLToPath(projectSdk.server)), "auth must come from the project's SDK");
      return counters;
    };
    const empty = { jobWrites: 0, requestClaims: 0, handlers: 0, quotes: 0, payments: 0, challenges: 0, nonces: 0 };
    assert.deepEqual(await effects(), empty);
    const lookup = "/v1/request-result/fixture-request";
    const invalid = await post(lookup, sign(lookup, { text: "too long", request_id: "fixture-request" }));
    if (oldHost) {
      assert.throws(() => assertRefusal(invalid, "schema_invalid"), { name: "AssertionError", actual: 500, expected: 401 });
      assert.deepEqual(await effects(), empty);
      return;
    }
    assertRefusal(invalid, "schema_invalid");

    // A rejected signature must not consume the valid proof's nonce or invoke
    // payment, even when a credential accompanies the refused request.
    const valid = sign("/v1/job", { request_id: "fixture-request" });
    for (const path of [lookup, "/v1/job", "/v1/quote"]) {
      assertRefusal(await post(path, { ...sign(path), signature: "00".repeat(64) }), "signature_invalid");
      assertRefusal(await post(path, { text: "ok" }), "signature_required");
      assertRefusal(await post(path, { ...sign(path, {}, "priced"), signature: "00".repeat(64) }, "priced", true), "signature_invalid");
    }
    assertRefusal(await post("/v1/job", { ...valid, signature: "00".repeat(64) }), "signature_invalid");
    for (const path of ["/v1/job", "/v1/quote"]) {
      const invalidInput = await post(path, { text: "too long" });
      assert.equal(invalidInput.status, 400);
      assert.equal(invalidInput.body.error, "invalid_input");
      assertNoJob(invalidInput.body);
    }
    for (const path of [lookup, "/v1/job", "/v1/quote"]) {
      const unrelated = await post(path, sign(path, { text: "err" }));
      assert.equal(unrelated.status, 500);
      assert.notEqual(unrelated.body.error, "auth_error");
      assert.ok(!JSON.stringify(unrelated.body).includes("fixture-private-auth-failure"));
      assertNoJob(unrelated.body);
    }
    assert.deepEqual(await effects(), empty, "refused requests must not write jobs, claim requests, record nonces or contact payment");

    const missing = await post(lookup, sign(lookup, { request_id: "fixture-request" }));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "request_not_found");
    assert.deepEqual(await effects(), empty, "authenticated lookup must remain read-only");
    const submitted = await post("/v1/job", valid);
    assert.equal(submitted.status, 200);
    assert.equal(typeof submitted.body.job_id, "string");
    assert.equal(submitted.body.status, "completed");
    assert.equal(submitted.body.summary, "authenticated");
    const accepted = await effects();
    assert.ok(accepted.jobWrites > 0, "write observation must see an actual accepted job");
    assert.ok(accepted.requestClaims > 0, "claim observation must see an actual accepted request");
    assert.equal(accepted.handlers, 1);
    assert.equal(accepted.nonces, 1, "refused signature must leave the original nonce usable");
    const recovered = await post(lookup, sign(lookup, { request_id: "fixture-request" }));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.job_id, submitted.body.job_id);
    assert.deepEqual(await effects(), accepted, "recovery must not create another job or replay record");
    assertRefusal(await post(lookup, sign(lookup, { text: "too long", request_id: "fixture-request" })), "schema_invalid");
    assert.deepEqual(await effects(), accepted, "refused recovery of an existing job must not change state");

    // Requests with a public id have their own duplicate-id contract. Use a
    // fresh id-less submission to reach the nonce replay gate itself.
    const replayable = sign("/v1/job");
    assert.equal((await post("/v1/job", replayable)).status, 200);
    const beforeReplay = await effects();
    assert.equal(beforeReplay.handlers, 2);
    assert.equal(beforeReplay.nonces, 2);
    assertRefusal(await post("/v1/job", replayable), "replay_detected");
    assert.deepEqual(await effects(), beforeReplay);

    // Prove the external payment observer is reachable; otherwise zero calls
    // on refusal could be a disconnected fixture rather than auth ordering.
    const paid = await post("/v1/job", sign("/v1/job", {}, "priced"), "priced", true);
    assert.equal(paid.status, 402);
    const afterPayment = await effects();
    assert.equal(afterPayment.payments, 1);
    assert.equal(afterPayment.quotes, 1);
    assert.ok(afterPayment.challenges > 0);
    for (const counter of ["jobWrites", "requestClaims", "handlers", "nonces"]) assert.equal(afterPayment[counter], beforeReplay[counter], counter);
  }, async () => {
    if (!await stopProcess(child)) throw new Error("signed-auth dev process did not stop");
    children.delete(child);
  });
}

/** @param {{status: number, body: Record<string, unknown>}} response @param {string} reason */
function assertRefusal(response, reason) {
  assert.equal(response.status, 401);
  assert.equal(response.body.error, "auth_error");
  assert.equal(response.body.sub_reason, reason);
  assert.equal(typeof response.body.display, "string");
  assertNoJob(response.body);
}

/** @param {Record<string, unknown>} body */
function assertNoJob(body) {
  for (const field of ["job_id", "job_token", "receipt"]) assert.equal(field in body, false, field);
}

function availablePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("could not allocate a fixture port")); return; }
      server.close((error) => error ? reject(error) : done(address.port));
    });
  });
}

/** @param {import("node:child_process").ChildProcess} child @param {string} url @param {() => string} output */
async function waitUntilReady(child, url, output) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`signed-auth dev exited before readiness: ${output()}`);
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && (await response.json()).status === "ok") return;
    } catch { /* Listener may not be open yet. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`signed-auth dev did not become healthy: ${output()}`);
}

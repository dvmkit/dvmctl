import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { buildAdminChallenge, deriveBuilderLockKeypair, verifyChallenge } from "@dvmkit/sdk/internal";

// Portable contract copied unchanged from the SDK's v0.11.0-rc.1 tag.
const wire = JSON.parse(readFileSync(new URL("fixtures/credit-draw-refund.json", import.meta.url), "utf8"));
const cli = resolve("dist/dvmctl.js");
const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const dvmId = "550e8400-e29b-41d4-a716-446655440000";

async function fixture(context, { identity = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-refund-"));
  const config = join(directory, "config");
  const project = join(directory, "project");
  mkdirSync(config);
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "scrape" }));
  if (identity) {
    writeFileSync(join(config, "builder.mnemonic"), mnemonic, { mode: 0o600 });
    writeFileSync(join(config, "builder.json"), JSON.stringify({ version: 2, dvms: {
      [dvmId]: { handle: "scrape", canonical_dvm_id: dvmId, current_rotation_index: 0 },
    } }));
  }
  const requests = [];
  let reply = { status: 200, body: wire.response };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, path: url.pathname, org: url.searchParams.get("org"), authorization: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/v1/builder/dvms") {
      res.end(JSON.stringify({ dvms: url.searchParams.get("org") === "chosen-org" ? [{ id: dvmId, slug: "scrape", dvmkitUrl: null }] : [], org: { id: "org-fixture", handle: "chosen-org", role: "owner", personal: false } }));
    } else if (url.pathname === `/api/v1/builder/dvms/${dvmId}`) {
      res.end(JSON.stringify({ dvm: { id: dvmId, slug: "scrape", url: endpoint }, deploys: [], domains: [] }));
    } else {
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    endpoint, requests, project,
    respond(status, body) { reply = { status, body }; },
    invoke(args) {
      return new Promise((resolve) => {
        const child = execFile(process.execPath, [cli, ...args], { cwd: project, encoding: "utf8", timeout: 20_000,
          env: { PATH: process.env.PATH, HOME: config, DVMKIT_CONFIG_DIR: config, DVM_CONFIG_DIR: config, DVMCTL_CONFIG_DIR: config,
            DVMKIT_API_KEY: "fixture-token", DVMKIT_PLATFORM_URL: endpoint },
        }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
        child.stdin.end();
      });
    },
  };
}

test("packaged help exposes the refund command and its safety and retry options", async (context) => {
  const setup = await fixture(context, { identity: false });
  const root = await setup.invoke(["--help"]);
  assert.equal(root.code, 0, root.stderr);
  assert.match(root.stdout, /refund.*job-id/);
  const result = await setup.invoke(["refund", "--help"]);
  assert.equal(result.code, 0, result.stderr);
  for (const option of ["--dvm", "--amount", "--reason", "--refund-id", "--confirm", "--endpoint", "--org", "--human"]) assert.ok(result.stdout.includes(option), option);
  assert.equal(setup.requests.length, 0);
});

for (const human of [false, true]) {
  test(`packaged ${human ? "human" : "JSON"} preview needs no identity and sends no discovery or admin HTTP`, async (context) => {
    const setup = await fixture(context, { identity: false });
    for (const amount of [undefined, "00.003000"]) {
      const result = await setup.invoke(["refund", "job-example", "--endpoint", setup.endpoint, "--org", "chosen-org",
        ...(human ? ["--human"] : []), ...(amount ? ["--amount", amount] : [])]);
      assert.equal(result.code, 1, result.stderr);
      const error = human ? undefined : JSON.parse(result.stdout).error;
      if (error) {
        assert.equal(error.code, "confirmation_required");
        assert.equal(error.handle, "scrape");
        assert.equal(error.amount_micro, amount ? 3000 : null);
      }
      const copy = human ? result.stderr : `${error.display} ${error.hint}`;
      assert.match(copy, amount ? /0\.003 in this job's credit currency/ : /remaining unrefunded charge/);
      assert.match(copy, /local intent/);
      assert.match(copy, /no HTTP request/);
      assert.doesNotMatch(copy, /USD|EUR|\$/);
    }
    assert.deepEqual(setup.requests, []);
  });
}

test("packaged refund resolves project and organization, signs the fixed route, and preserves original replay fields", async (context) => {
  const setup = await fixture(context);
  const args = ["refund", wire.request.jobId, "--org", "chosen-org", "--amount", "0.000400", "--reason", wire.request.reason, "--refund-id", wire.request.refundId, "--confirm"];
  const result = await setup.invoke(args);
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  for (const [key, value] of Object.entries(wire.response)) assert.deepEqual(body[key], value, key);
  assert.equal(body.handle, "scrape");
  assert.equal(body.dvmId, dvmId);
  assert.match(body.display, /0\.0004 USD/);
  const request = setup.requests.find((row) => row.path === "/admin/credit/refund-draw");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, wire.request);
  const [nonce, ts, signature] = request.authorization.slice(5).split(".");
  const key = deriveBuilderLockKeypair(mnemonic, dvmId, 0);
  assert.equal(verifyChallenge(key.pubkey, buildAdminChallenge({ method: "POST", path: "/admin/credit/refund-draw", dvmId, nonceHex: nonce, unixSeconds: ts }), signature), true);
  assert.equal(setup.requests.find((row) => row.path === "/api/v1/builder/dvms").org, "chosen-org");
  setup.respond(200, { ...wire.response, replayed: true });
  const replay = await setup.invoke(args);
  assert.equal(replay.code, 0, replay.stderr);
  const replayed = JSON.parse(replay.stdout);
  for (const [key, value] of Object.entries(wire.response)) assert.deepEqual(replayed[key], key === "replayed" ? true : value, key);
  assert.match(replayed.display, /not the current balance/);
});

for (const refusal of Object.values(wire.refusals)) {
  test(`packaged refund relays ${refusal.response.error} as evidence required, without retrying`, async (context) => {
    const setup = await fixture(context);
    setup.respond(refusal.status, refusal.response);
    const result = await setup.invoke(["refund", "job-example", "--dvm", "scrape", "--endpoint", setup.endpoint, "--confirm"]);
    assert.equal(result.code, 1, result.stderr);
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, refusal.response.error);
    assert.equal(error.http_status, 422);
    assert.equal(typeof error.hint, "string");
    assert.match(error.hint, /independent.*evidence/);
    assert.match(error.hint, /[Rr]etrying alone/);
    assert.equal(setup.requests.length, 1);
  });
}

test("packaged scaffold declares the same exact SDK as the CLI runtime", async (context) => {
  const setup = await fixture(context, { identity: false });
  const target = join(setup.project, "new-service");
  const result = await setup.invoke(["create", target]);
  assert.equal(result.code, 0, result.stderr);
  const project = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  const installed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const runtimeSdkVersion = installed.dependencies["@dvmkit/sdk"];
  assert.match(runtimeSdkVersion, /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u);
  assert.equal(project.dependencies["@dvmkit/sdk"], runtimeSdkVersion);
});

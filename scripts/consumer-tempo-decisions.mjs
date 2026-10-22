// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { processCommand, removeTemporaryDirectory } from "./consumer-process.mjs";

/** Exercise the CLI file supplied by the caller, including an installed tarball. @param {string} cli */
export async function assertTempoDrainDecisions(cli) {
  const wire = JSON.parse(readFileSync(new URL("../test/fixtures/tempo-drain-decisions.json", import.meta.url), "utf8"));
  // The SDK exposes import-only entry points. Resolve from the supplied CLI's
  // directory so installed-consumer checks use that consumer's dependency tree.
  const sdk = await processCommand(process.execPath, ["--input-type=module", "-e", "process.stdout.write(import.meta.resolve('@dvmkit/sdk/internal'))"], {
    cwd: dirname(resolve(cli)), capture: true,
  });
  const { buildAdminChallenge, deriveBuilderLockKeypair, verifyChallenge } = await import(sdk.stdout);
  const root = mkdtempSync(join(tmpdir(), "dvmctl-tempo-"));
  const config = join(root, "config");
  mkdirSync(config);
  const dvmId = "550e8400-e29b-41d4-a716-446655440000";
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  /** @type {{path: string, method: string | undefined, org: string | null, auth: string | undefined, body: unknown}[]} */
  const requests = [];
  /** @type {Record<string, number>} */
  const calls = {};
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push({ path: url.pathname, method: req.method, org: url.searchParams.get("org"), auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/v1/builder/dvms") {
      res.end(JSON.stringify({ dvms: url.searchParams.get("org") === "chosen-org" ? [{ id: dvmId, slug: "service", dvmkitUrl: null }] : [], org: { id: "org-fixture", handle: "chosen-org", role: "owner", personal: false } }));
    } else if (url.pathname === `/api/v1/builder/dvms/${dvmId}`) {
      res.end(JSON.stringify({ dvm: { id: dvmId, slug: "service", url: endpoint }, deploys: [], domains: [] }));
    } else {
      const fixture = url.pathname === wire.book.path ? wire.book : url.pathname === wire.release.path ? wire.release : undefined;
      if (!fixture) { res.statusCode = 404; res.end(JSON.stringify({ error: "not_found" })); return; }
      const count = calls[url.pathname] = (calls[url.pathname] ?? 0) + 1;
      res.end(JSON.stringify({ ...fixture.response, replayed: count > 1, ...(count > 1 ? { balance_micro: 975, spendable_micro: 0 } : {}) }));
    }
  });
  let endpoint = "";
  /** @param {string[]} args */
  const invoke = (args) => processCommand(process.execPath, [resolve(cli), ...args], {
    cwd: root, capture: true, allowFailure: true,
    env: { PATH: process.env.PATH, OPENSSL_CONF: process.env.OPENSSL_CONF, HOME: config,
      DVMKIT_CONFIG_DIR: config, DVM_CONFIG_DIR: config, DVMCTL_CONFIG_DIR: config,
      DVMKIT_API_KEY: "fixture-token", DVMKIT_PLATFORM_URL: endpoint },
  });
  try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => done(undefined)); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    endpoint = `http://127.0.0.1:${address.port}`;
    for (const name of ["book", "release"]) {
      const help = await invoke(["credit", `tempo-${name}`, "--help"]);
      assert.equal(help.code, 0, help.stderr);
      for (const flag of ["--reason", "--evidence", "--confirm", "--endpoint", "--org", "--human"]) assert.ok(help.stdout.includes(flag), flag);
      for (const human of [false, true]) {
        const preview = await invoke(["credit", `tempo-${name}`, "service", "credit", "drain", "--reason", "Reviewed", ...(human ? ["--human"] : [])]);
        assert.equal(preview.code, 1);
        if (human) assert.match(preview.stderr, /No HTTP request/);
        else assert.equal(JSON.parse(preview.stdout).error.code, "confirmation_required");
      }
    }
    assert.equal(requests.length, 0, "unconfirmed actions must not discover or contact the service");
    writeFileSync(join(config, "builder.mnemonic"), mnemonic, { mode: 0o600 });
    writeFileSync(join(config, "builder.json"), JSON.stringify({ version: 2, dvms: {
      [dvmId]: { handle: "service", canonical_dvm_id: dvmId, current_rotation_index: 0 },
    } }));
    for (const name of ["book", "release"]) {
      const fixture = wire[name];
      const args = ["credit", `tempo-${name}`, "service", fixture.request.credit_id, fixture.request.drain_id,
        "--reason", ` ${fixture.request.reason} `, "--evidence", ` ${fixture.request.evidence} `, "--confirm",
        ...(name === "book" ? ["--org", "chosen-org"] : ["--endpoint", endpoint])];
      const result = await invoke(args);
      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      for (const [key, value] of Object.entries(fixture.response)) assert.deepEqual(output[key], value, key);
      assert.equal(output.op, `credit_tempo_${name}`);
      assert.equal(output.dvmId, dvmId);
      assert.equal(Object.hasOwn(output, "transaction"), false);
      assert.match(output.display, name === "book" ? /whole held refund/ : /no refund was paid/);
      assert.match(output.hint, /unspendable/);
      const financial = requests.filter((row) => row.path === fixture.path);
      assert.equal(financial.length, 1, "one financial request per explicit action");
      const sent = financial[0];
      assert.equal(sent.method, "POST");
      assert.deepEqual(sent.body, fixture.request);
      assert.ok(sent.auth);
      assert.ok(sent.auth.startsWith("P2PK "));
      const [nonce, timestamp, signature] = sent.auth.slice(5).split(".");
      const key = deriveBuilderLockKeypair(mnemonic, dvmId, 0);
      assert.equal(verifyChallenge(key.pubkey, buildAdminChallenge({ method: "POST", path: fixture.path, dvmId, nonceHex: nonce, unixSeconds: timestamp }), signature), true);
      const replay = await invoke(args);
      assert.equal(replay.code, 0, replay.stderr);
      const replayed = JSON.parse(replay.stdout);
      assert.deepEqual(replayed.decision, fixture.response.decision);
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.balance_micro, 975);
      assert.equal(replayed.spendable_micro, 0);
      assert.match(replayed.display, /Nothing moved again/);
      assert.equal(requests.filter((row) => row.path === fixture.path).length, 2);
    }
    assert.equal(requests.find((row) => row.path === "/api/v1/builder/dvms")?.org, "chosen-org");
  } finally {
    server.closeAllConnections();
    try {
      if (server.listening) await new Promise((done, reject) => server.close((error) => error ? reject(error) : done(undefined)));
    } finally { await removeTemporaryDirectory(root); }
  }
}

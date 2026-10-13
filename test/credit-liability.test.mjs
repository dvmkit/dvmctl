import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const contract = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/bitcoin-liability.json"), "utf8"));
const legacy = {
  deposit_liability_sats: 300, deposit_credits: 1, deposit_by_rail: [],
  deposit_by_currency: [{ currency: "usd", micro: 9_000_000, credits: 1 }],
  drain_liability_sats: 200, drain_count: 2, total_owed_sats: 500,
  uncovered_credits: 1, uncovered_micro: 100_000,
  unbacked_credits: 2, unbacked_micro: 900_000, unpriced_drains: 0,
};
const second = {
  deposit_liability_sats: 300, deposit_credits: 2, deposit_by_rail: [], deposit_by_currency: [],
  drain_liability_sats: 200, drain_count: 1, total_owed_sats: 500,
  uncovered_credits: 2, uncovered_by_currency: [{ currency: "usd", micro: 500_000, credits: 1 }, { currency: "eur", micro: 300_000, credits: 1 }],
  unbacked_credits: 2, unbacked_by_currency: [{ currency: "usd", micro: 250_000, credits: 1 }, { currency: "jpy", micro: 10_000_000, credits: 1 }],
  unpriced_drains: 0,
};
const empty = { ...contract, uncovered_credits: 0, uncovered_by_currency: [], unbacked_credits: 0, unbacked_by_currency: [] };
const cases = [
  { name: "mixed currencies within one host", responses: [contract], balances: [{ currency: "jpy", micro: 120_000_000, credits: 2 }, { currency: "usd", micro: 1_200_000, credits: 2 }], amounts: ["120.000000 jpy", "1.200000 usd"], unknown: 0 },
  { name: "equal currencies across hosts", responses: [contract, second], balances: [{ currency: "eur", micro: 300_000, credits: 1 }, { currency: "jpy", micro: 130_000_000, credits: 3 }, { currency: "usd", micro: 1_950_000, credits: 4 }], amounts: ["0.300000 eur", "130.000000 jpy", "1.950000 usd"], unknown: 0 },
  { name: "repeated currency rows and categories", responses: [{ ...empty, uncovered_credits: 2, uncovered_by_currency: [{ currency: "usd", micro: 100_000, credits: 1 }, { currency: "usd", micro: 200_000, credits: 1 }], unbacked_credits: 1, unbacked_by_currency: [{ currency: "usd", micro: 300_000, credits: 1 }] }], balances: [{ currency: "usd", micro: 600_000, credits: 3 }], amounts: ["0.600000 usd"], unknown: 0 },
  { name: "a single currency", responses: [{ ...empty, unbacked_credits: 1, unbacked_by_currency: [{ currency: "eur", micro: 750_000, credits: 1 }] }], balances: [{ currency: "eur", micro: 750_000, credits: 1 }], amounts: ["0.750000 eur"], unknown: 0 },
  { name: "old endpoints without denomination", responses: [legacy], balances: [], amounts: ["3 credit(s)", "denomination and amount are unknown"], unknown: 3 },
  { name: "known and old endpoints together", responses: [contract, legacy], balances: [{ currency: "jpy", micro: 120_000_000, credits: 2 }, { currency: "usd", micro: 1_200_000, credits: 2 }], amounts: ["120.000000 jpy", "1.200000 usd", "3 credit(s)", "denomination and amount are unknown"], unknown: 3 },
  { name: "unpriced reclaims without a ledger amount", responses: [{ ...empty, unpriced_drains: 2 }], balances: [], amounts: ["2 reclaim(s)", "denomination and amount are unknown"], unknown: 0 },
];

async function server(context, reply) {
  const requests = [];
  const host = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ path: url.pathname, query: url.searchParams, authorization: req.headers.authorization });
    const [status, body] = reply(url, req);
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => host.close(resolve)));
  return { url: `http://127.0.0.1:${host.address().port}`, requests };
}

async function fixture(context, responses, refusal) {
  const hosts = await Promise.all(responses.map((body) => server(context, (url, req) => {
    if (url.pathname !== "/admin/credit/bitcoin-liability") return [404, {}];
    if (!req.headers.authorization) return [401, { error: "unauthorized" }];
    return refusal ?? [200, body];
  })));
  const dvms = hosts.map((host, index) => ({ id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`, slug: `host-${index}`, url: host.url, dvmkitUrl: null }));
  const platform = await server(context, (url) => {
    if (url.pathname === "/api/v1/builder/dvms") return [200, { dvms: url.searchParams.get("org") === "chosen-org" ? dvms : [], org: { id: "org-fixture", handle: "chosen-org", role: "owner", personal: false } }];
    const dvm = dvms.find((row) => url.pathname === `/api/v1/builder/dvms/${row.id}`);
    return dvm ? [200, { dvm, deploys: [], domains: [] }] : [404, {}];
  });
  const config = mkdtempSync(join(tmpdir(), "dvmctl-liability-"));
  context.after(() => rmSync(config, { recursive: true, force: true }));
  writeFileSync(join(config, "builder.mnemonic"), "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", { mode: 0o600 });
  writeFileSync(join(config, "builder.json"), JSON.stringify({ version: 2, dvms: Object.fromEntries(dvms.map((dvm) => [dvm.id, { handle: dvm.slug, canonical_dvm_id: dvm.id, current_rotation_index: 0 }])) }));
  return {
    hosts, platform,
    invoke(human = false, args = []) {
      return new Promise((resolve) => {
        const child = execFile(process.execPath, [join(process.cwd(), "dist/dvmctl.js"), "credit", "liability", ...dvms.map((dvm) => dvm.slug), "--org", "chosen-org", "--hub-sats", "2000", ...(human ? ["--human"] : []), ...args], {
          env: { PATH: process.env.PATH, HOME: config, DVMKIT_CONFIG_DIR: config, DVM_CONFIG_DIR: config, DVMKIT_API_KEY: "fixture-key", DVMKIT_PLATFORM_URL: platform.url }, encoding: "utf8", timeout: 20_000,
        }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
        child.stdin.end();
      });
    },
  };
}

for (const scenario of cases) {
  for (const human of [false, true]) {
    test(`credit liability preserves ${scenario.name} in ${human ? "human" : "JSON"} output`, async (context) => {
      const setup = await fixture(context, scenario.responses);
      const result = await setup.invoke(human);
      assert.equal(result.code, 0, result.stderr);
      const body = human ? undefined : JSON.parse(result.stdout);
      const warning = human ? result.stderr : body.gap_note;
      assert.equal(typeof warning, "string");
      for (const amount of scenario.amounts) assert.ok(warning.includes(amount), warning);
      assert.doesNotMatch(warning, /NaN|Infinity/);
      if (scenario.responses.includes(legacy)) assert.doesNotMatch(warning, /1\.000000|9\.000000/);
      if (scenario.responses.length === 1 && scenario.responses[0] === legacy) assert.doesNotMatch(warning, /usd|eur|jpy/);
      if (body) {
        assert.deepEqual([...body.gap_by_currency].sort((a, b) => a.currency.localeCompare(b.currency)), scenario.balances);
        assert.equal(body.gap_unknown_credits, scenario.unknown);
        assert.equal(body.total_owed_sats, scenario.responses.length === 2 ? 1000 : 500);
        assert.equal(body.sweepable_sats, scenario.responses.length === 2 ? 1000 : 1500);
      } else assert.ok(result.stderr.includes(scenario.responses.length === 2 ? "1000 sats are earnings" : "1500 sats are earnings"));
      for (const host of setup.hosts) assert.equal(host.requests.filter((row) => row.path === "/admin/credit/bitcoin-liability").length, 1);
      assert.ok(setup.platform.requests.filter((row) => row.path === "/api/v1/builder/dvms").every((row) => row.query.get("org") === "chosen-org"));
    });
  }
}

for (const human of [false, true]) {
  test(`credit liability omits gap warnings for zero balances in ${human ? "human" : "JSON"} output`, async (context) => {
    const setup = await fixture(context, [empty]); const result = await setup.invoke(human);
    assert.equal(result.code, 0, result.stderr);
    if (human) assert.doesNotMatch(result.stderr, /no in-kind|unknown|NaN/);
    else { const body = JSON.parse(result.stdout); assert.equal(body.gap_note, undefined); assert.equal(body.gap_by_currency, undefined); assert.equal(body.total_owed_sats, 500); }
  });
}

test("credit liability preserves a bad-signature refusal instead of publishing a sweep", async (context) => {
  const setup = await fixture(context, [contract], [401, { error: "unauthorized", reason: "bad_signature", message: "Signature did not match the lock key" }]);
  const result = await setup.invoke();
  assert.notEqual(result.code, 0);
  const body = JSON.parse(result.stdout); assert.equal(body.error.code, "admin_bad_signature"); assert.equal(body.sweepable_sats, undefined);
});

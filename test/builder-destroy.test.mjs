import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const DVM_ID = "550e8400-e29b-41d4-a716-446655440000";
const SLUG = "my-dvm";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * A stand-in for both the platform API and the DVM's admin endpoint. `routes`
 * maps "METHOD /path" to a JSON reply; every request is recorded with its body.
 */
async function fakeServer(context, routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = new URL(req.url, "http://localhost").pathname;
      requests.push({ method: req.method, path, headers: req.headers, body });
      const [status, reply] = routes[`${req.method} ${path}`] ?? [404, {}];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests };
}

function platformRoutes(url, extra) {
  return {
    "GET /api/v1/builder/dvms": [
      200,
      {
        dvms: [{ id: DVM_ID, slug: SLUG, dvmkitUrl: null }],
        org: { id: "org-1", handle: null, role: "owner", personal: true },
      },
    ],
    [`GET /api/v1/builder/dvms/${DVM_ID}`]: [
      200,
      { dvm: { id: DVM_ID, slug: SLUG, url, orgHandle: null }, deploys: [], domains: [] },
    ],
    ...extra,
  };
}

/** A builder config dir; `lock` seeds the mnemonic and DVM entry that let dvmctl sign admin calls. */
function configDir(context, { lock }) {
  const dir = mkdtempSync(join(tmpdir(), "dvmctl-destroy-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  if (lock) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "builder.mnemonic"), MNEMONIC, { mode: 0o600 });
    writeFileSync(
      join(dir, "builder.json"),
      JSON.stringify({
        version: 2,
        dvms: {
          [DVM_ID]: { handle: SLUG, canonical_dvm_id: DVM_ID, current_rotation_index: 0 },
        },
      })
    );
  }
  return dir;
}

function dvmctl(args, { platformUrl, config, stdin = "" }) {
  const cli = join(process.cwd(), "dist/dvmctl.js");
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cli, ...args],
      {
        env: {
          PATH: process.env.PATH,
          HOME: config,
          DVMKIT_CONFIG_DIR: config,
          DVM_CONFIG_DIR: config,
          DVMKIT_API_KEY: "test-key",
          DVMKIT_PLATFORM_URL: platformUrl,
        },
        encoding: "utf8",
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })
    );
    child.stdin.end(stdin);
  });
}

const liability = {
  deposit_liability_sats: 1200,
  deposit_credits: 2,
  deposit_by_rail: [],
  deposit_by_currency: [],
  drain_liability_sats: 0,
  drain_count: 1,
  total_owed_sats: 1200,
  uncovered_credits: 0,
  uncovered_micro: 0,
  unbacked_credits: 1,
  unbacked_micro: 5,
  unpriced_drains: 0,
};

const windingDown = {
  status: "winding_down",
  dvmId: DVM_ID,
  slug: SLUG,
  keptDb: false,
  startedAt: Date.UTC(2026, 8, 1),
  deleteAfter: Date.UTC(2026, 9, 1, 12),
  alreadyWindingDown: false,
  display: "my-dvm still owes callers prepaid balances, so it is being withdrawn.",
};

test("destroy sends the DVM ledger's counts and reports a wind-down, not a deletion", async (context) => {
  const routes = platformRoutes(null, {
    "GET /admin/credit/bitcoin-liability": [200, liability],
    [`DELETE /api/v1/builder/dvms/${DVM_ID}`]: [200, windingDown],
  });
  const { url, requests } = await fakeServer(context, routes);
  routes[`GET /api/v1/builder/dvms/${DVM_ID}`][1].dvm.url = url;

  const config = configDir(context, { lock: true });
  const result = await dvmctl(["destroy", SLUG, "--confirm"], { platformUrl: url, config });

  assert.equal(result.code, 0, result.stderr);
  const admin = requests.find((r) => r.path === "/admin/credit/bitcoin-liability");
  assert.ok(admin?.headers.authorization, "admin read is signed with the builder lock key");
  const del = requests.find((r) => r.method === "DELETE");
  assert.deepEqual(JSON.parse(del.body), {
    ledger: { open_credits: 2, pending_drains: 1, gaps: 1 },
  });
  assert.match(del.headers["content-type"], /application\/json/);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, "winding_down");
  assert.equal(out.deleteAfter, windingDown.deleteAfter);
});

test("destroy preserves the ledger count report from currency-separated liability responses", async (context) => {
  const currentLiability = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/bitcoin-liability.json"), "utf8"));
  const routes = platformRoutes(null, {
    "GET /admin/credit/bitcoin-liability": [200, currentLiability],
    [`DELETE /api/v1/builder/dvms/${DVM_ID}`]: [200, windingDown],
  });
  const { url, requests } = await fakeServer(context, routes);
  routes[`GET /api/v1/builder/dvms/${DVM_ID}`][1].dvm.url = url;
  const result = await dvmctl(["destroy", SLUG, "--confirm"], { platformUrl: url, config: configDir(context, { lock: true }) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(requests.find((request) => request.method === "DELETE").body), {
    ledger: { open_credits: 5, pending_drains: 0, gaps: 4 },
  });
  assert.equal(JSON.parse(result.stdout).status, "winding_down");
});

test("destroy --human prints the platform's wind-down sentence", async (context) => {
  const routes = platformRoutes(null, {
    [`DELETE /api/v1/builder/dvms/${DVM_ID}`]: [200, windingDown],
  });
  const { url } = await fakeServer(context, routes);
  const config = configDir(context, { lock: false });
  const result = await dvmctl(["destroy", SLUG, "--human"], {
    platformUrl: url,
    config,
    stdin: `${DVM_ID}\n`,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /still owes callers prepaid balances/);
  assert.match(result.stderr, /dvmctl status my-dvm/);
  assert.doesNotMatch(result.stderr, /Destroyed "my-dvm"/);
});

test("destroy proceeds without a ledger report when the DVM's ledger can't be read", async (context) => {
  const destroyed = { status: "destroyed", dvmId: DVM_ID, slug: SLUG, keptDb: false };
  const routes = platformRoutes(null, {
    [`DELETE /api/v1/builder/dvms/${DVM_ID}`]: [200, destroyed],
  });
  const { url, requests } = await fakeServer(context, routes);
  // No builder mnemonic on this machine, so the admin read fails before any request.
  const config = configDir(context, { lock: false });

  const result = await dvmctl(["destroy", SLUG, "--confirm"], { platformUrl: url, config });

  assert.equal(result.code, 0, result.stderr);
  const del = requests.find((r) => r.method === "DELETE");
  assert.equal(del.body, "");
  assert.equal(del.headers["content-type"], undefined);
  const { trace_id: _traceId, ...out } = JSON.parse(result.stdout);
  assert.deepEqual(out, destroyed);
});

test("status --human names a withdrawn DVM's deletion date", async (context) => {
  const routes = platformRoutes(null, {
    [`GET /api/v1/builder/dvms/${DVM_ID}/status`]: [
      200,
      {
        slug: SLUG,
        status: "suspended",
        paused: false,
        suspensionReason: "withdrawn",
        withdrawal: {
          started_at: Date.UTC(2026, 8, 1),
          delete_after: Date.UTC(2026, 9, 1, 12),
          keep_db: false,
        },
        reclaimsOpen: true,
        machines: [],
        scale: { count: 0, vm_size: null },
      },
    ],
  });
  const { url } = await fakeServer(context, routes);
  const config = configDir(context, { lock: false });

  const result = await dvmctl(["status", SLUG, "--human"], { platformUrl: url, config });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /is being withdrawn/);
  assert.match(result.stderr, /until 2026-10-01 12:00:00 UTC and is deleted then/);
  assert.doesNotMatch(result.stderr, /suspended by the platform/);
});

test("resume surfaces the platform's withdrawn refusal code", async (context) => {
  const routes = platformRoutes(null, {
    [`POST /api/v1/builder/dvms/${DVM_ID}/resume`]: [
      409,
      { error: { code: "withdrawn", message: "my-dvm is being withdrawn." } },
    ],
  });
  const { url } = await fakeServer(context, routes);
  const config = configDir(context, { lock: false });

  const result = await dvmctl(["resume", SLUG], { platformUrl: url, config });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /"withdrawn"/);
});

import { EventEmitter } from "node:events";

import { configureDVM } from "@dvmkit/sdk";
import { buildAdminAuthHeader, deriveBuilderLockKeypair } from "@dvmkit/sdk/internal";
import { createDVMHost } from "@dvmkit/sdk/server";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";

vi.mock("../../../lib/cashu/builder-lock-identity.ts", () => ({
  resolveBuilderLockKeyringByHandle: vi.fn(async () => ({ canonicalDvmId: DVM_ID, currentKeypair: KEYPAIR })),
  resolveBuilderLockKeyring: vi.fn(() => ({ canonicalDvmId: DVM_ID, currentKeypair: KEYPAIR })),
}));
vi.mock("../../../lib/platform-client.ts", () => ({ getDvm: vi.fn() }));
vi.mock("../resolve-dvm.ts", () => ({
  resolveDvm: vi.fn(async () => ({ dvmId: DVM_ID, token: "token", platformUrl: "https://platform.example" })),
}));
vi.mock("../../../shared/output.ts", () => ({ info: vi.fn(), json: vi.fn(), raw: vi.fn() }));

import { resolveBuilderLockKeyringByHandle } from "../../../lib/cashu/builder-lock-identity.ts";
import { getDvm } from "../../../lib/platform-client.ts";
import { json } from "../../../shared/output.ts";
import { drainSettle, drainsOwed } from "../manual-drains.ts";

const DVM_ID = "11111111-2222-4333-8444-555555555555";
const KEYPAIR = deriveBuilderLockKeypair(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", DVM_ID, 0
);

/** Only Postgres I/O is replaced; SDK mounting, authentication, and ledger methods run normally. */
class AdminDatabase extends EventEmitter {
  readonly options = { max: 10 };
  private readonly nonces = new Set<string>();
  private readonly credit = {
    currency: "usd", caller_pubkey: KEYPAIR.pubkey, tempo_channel_id: null, x402_channel_id: null,
  };
  private drain = {
    credit_id: "credit-example", drain_id: "drain-example", method: "x402",
    payout: { address: `0x${"12".repeat(20)}` }, amount_micro: 400_000, drained_native: 400_000,
    owed_sats: null, balance_after_micro: 0, ledger_seq: 1, status: "pending",
    token: null, sent_ref: null as unknown, fulfilment: null, receipts: [] as unknown[],
    created_at: 1, parked_at: null, picked_up_at: null, sent_at: null as number | null,
    released_at: null, write_off_note: null, written_off_at: null,
  };

  query = async (input: string | { text: string }, values: unknown[] = []) => {
    const sql = (typeof input === "string" ? input : input.text).replace(/\s+/g, " ").trim();
    let rows: Record<string, unknown>[] = [];
    if (sql.startsWith("SELECT to_regclass('x402_batch_channels') IS NOT NULL")) {
      rows = [{ x402: false, x402Settlement: false, x402Batch: false, tempo: false, tempoClose: false, reports: false, obligations: false }];
    } else if (sql.startsWith("SELECT pubkey, retired_at_ms FROM dvm_lock_pubkeys")) {
      rows = [{ pubkey: KEYPAIR.pubkey, retired_at_ms: null }];
    } else if (sql.startsWith("SELECT 1 FROM consumed_credentials")) {
      if (this.nonces.has(String(values[1]))) rows = [{}];
    } else if (sql.startsWith("INSERT INTO consumed_credentials")) {
      if (!this.nonces.has(String(values[1]))) {
        this.nonces.add(String(values[1]));
        rows = [{}];
      }
    } else if (sql.startsWith("SELECT d.*,") && sql.includes("FROM credit_drains d")) {
      if (!sql.includes("WHERE d.status IN") || this.drain.status === "pending") {
        rows = [{ ...this.drain, ...this.credit }];
      }
    } else if (sql.startsWith("UPDATE credit_drains SET status = 'sent'")) {
      if (this.drain.status === "pending") {
        this.drain.status = "sent";
        this.drain.sent_ref = JSON.parse(String(values[2]));
        this.drain.sent_at = Number(values[3]);
        rows = [{ ...this.drain }];
      }
    } else if (sql.startsWith("SELECT * FROM credit_drains WHERE")) {
      rows = [{ ...this.drain }];
    } else if (sql.startsWith("SELECT currency, caller_pubkey, tempo_channel_id, x402_channel_id FROM credits")) {
      rows = [this.credit];
    } else if (sql.startsWith("UPDATE credit_drains SET receipts")) {
      this.drain.receipts.push(...JSON.parse(String(values[2])));
    }
    // Schema setup and unrelated background reads see an otherwise empty database.
    return { rows, rowCount: rows.length };
  };

  async connect() {
    return Object.assign(new EventEmitter(), { query: this.query, release() {} });
  }
}

it.each([
  { mount: "/feed", mountPrefix: "/feed", endpointPath: "", platform: false },
  { mount: "/feed", mountPrefix: "/feed", endpointPath: "", platform: true },
  { mount: "", mountPrefix: undefined, endpointPath: "", platform: false },
  { mount: "/feed", mountPrefix: undefined, endpointPath: "/feed", platform: false },
  { mount: "/feed", mountPrefix: undefined, endpointPath: "/feed", platform: true },
  { mount: "/services/feed", mountPrefix: "/feed", endpointPath: "/services", platform: false },
])("lists and settles a drain through SDK mount '$mount' (endpoint path: '$endpointPath', platform: $platform)", async ({ mount, mountPrefix, endpointPath, platform }) => {
  const host = createDVMHost({
    pool: new AdminDatabase() as unknown as Pool,
    env: { DVMKIT_DVM_ID: DVM_ID, DVMKIT_CASHU_LOCK_PUBKEY: KEYPAIR.pubkey },
  });
  host.mount(configureDVM({ name: "Feed", capability: "feed", onJob() {} }), mount ? { prefix: mount } : undefined);
  try {
    const server = await host.serve({ port: 0 });
    const endpoint = `${server.url}${endpointPath}`;
    vi.mocked(getDvm).mockResolvedValue({ dvm: { url: endpoint } } as never);
    const opts = { ...(platform ? {} : { endpoint }), mountPrefix };
    if (mount) {
      expect((await host.app.request("/admin/credit/pending-drains")).status).toBe(404);
      const { header } = buildAdminAuthHeader({
        method: "GET", path: "/admin/credit/pending-drains", dvmId: DVM_ID, privkeyHex: KEYPAIR.privkey,
      });
      const wrongSignature = await host.app.request(`${mount}/admin/credit/pending-drains`, { headers: { Authorization: header } });
      expect(wrongSignature.status).toBe(401);
      expect(await wrongSignature.json()).toMatchObject({ reason: "bad_signature" });
    }

    await drainsOwed("feed", opts);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({
      owed_count: 1, owed_totals: [{ currency: "usd", amount_micro: 400_000, count: 1 }],
      drains: [expect.objectContaining({ credit_id: "credit-example", drain_id: "drain-example" })],
    }));
    if (!platform) {
      expect(resolveBuilderLockKeyringByHandle).toHaveBeenLastCalledWith("feed", `${server.url}${mount}`);
    }

    await drainSettle("feed", "credit-example", "drain-example", { ...opts, tx: "transaction-example" });
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ replayed: false }));
    expect(await host.creditLedger!.getDrain({ creditId: "credit-example", drainId: "drain-example" })).toMatchObject({
      status: "sent", sentRef: { transaction: "transaction-example", settled_by: "operator" },
    });
    await drainsOwed("feed", opts);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ owed_count: 0 }));
  } finally {
    await host.shutdown();
  }
});

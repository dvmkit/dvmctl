import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPubKeyFromPrivKey, hashToCurve, MintOperationError, Wallet, type ProofLike } from "@cashu/cashu-ts";
import type * as Sdk from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { payoutWallet } from "../../../../test-support/payout-wallet.ts";
import type { AdminBatch } from "../../../lib/admin-cashu-client.ts";

const fixture = vi.hoisted(() => ({ batches: vi.fn(), mark: vi.fn(), wallet: vi.fn(), invoice: vi.fn(), quote: vi.fn(), fee: vi.fn() }));
const PRIVKEY = "11".repeat(32);
const LOCK = Buffer.from(getPubKeyFromPrivKey(Buffer.from(PRIVKEY, "hex"))).toString("hex");
const DVM = "isolation-fixture";
vi.mock("@dvmkit/sdk/internal", async importOriginal => ({
  ...(await importOriginal<typeof Sdk>()), getWallet: fixture.wallet, fetchMeltQuote: fixture.quote,
  getInputFeesForProofs: fixture.fee, fetchLnurlPayInvoice: fixture.invoice,
}));
vi.mock("../../../lib/cashu/builder-lock-identity.ts", () => ({
  resolveBuilderLockKeyringByHandle: () => ({ canonicalDvmId: DVM,
    currentKeypair: { privkey: PRIVKEY, pubkey: LOCK },
    keypairsByPubkey: new Map([[LOCK, { privkey: PRIVKEY, pubkey: LOCK }]]) }),
}));
vi.mock("../../../shared/builder-store.ts", () => ({
  getBuilderDvm: () => ({ payout_ln_address: "payout@example.invalid" }),
}));
vi.mock("../../../lib/admin-cashu-client.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/admin-cashu-client.ts")>()),
  AdminCashuClient: class {
    getPendingBatches = fixture.batches;
    markMelted = fixture.mark;
    async getPendingDrains() { return { drains: [], liability: { cashu_sats: 0, by_method_micro: {} } }; }
  },
}));
vi.mock("../../../shared/output.ts", () => ({ info: vi.fn(), json: vi.fn() }));

function proof(nonce: string, data = LOCK, tags: string[][] = []) {
  return { id: "keyset", amount: 64, secret: JSON.stringify(["P2PK", { nonce, data, tags }]),
    C: hashToCurve(new TextEncoder().encode(nonce)).toHex(true) };
}
async function processObjects() {
  vi.resetModules();
  const command = await import("../melt-pending.ts");
  const journal = await import("../../../lib/melt-pending-log.ts");
  const output = await import("../../../shared/output.ts");
  const custody = await import("../../../lib/melt-change-custody.ts");
  return { run: () => command.meltPending("fixture", { endpoint: "https://dvm.invalid" }), journal, output, custody };
}

describe("unusable proof isolation at the command boundary", () => {
  let root: string;
  let batch: AdminBatch;
  let paidRows: Set<string>;
  let requests: { quote: string; rows: string[] }[];
  let reject: (proofs: ProofLike[]) => Error | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), "melt-isolation-"));
    vi.stubEnv("DVMKIT_CONFIG_DIR", root);
    batch = { mint_url: "https://mint.invalid", lock_pubkey: LOCK,
      row_ids: ["row-a", "row-b", "row-c", "row-d"],
      proofs: [proof("a"), proof("b"), proof("c"), proof("d")], total_sats: 256, t_expire: null };
    paidRows = new Set(); requests = []; reject = () => undefined;
    fixture.batches.mockImplementation(async () => {
      const indices = batch.row_ids.flatMap((row, index) => paidRows.has(row) ? [] : [index]);
      return { batches: indices.length === 0 ? [] : [{ ...batch, row_ids: indices.map(i => batch.row_ids[i]),
        proofs: indices.map(i => batch.proofs[i]), total_sats: indices.reduce((n, i) => n + batch.proofs[i].amount, 0) }] };
    });
    fixture.mark.mockImplementation(async ({ row_ids }: { row_ids: string[] }) => {
      row_ids.forEach(row => paidRows.add(row)); return { melted: row_ids.length };
    });
    fixture.fee.mockResolvedValue(0);
    fixture.invoice.mockImplementation(async (_address, msats) => `invoice:${msats / 1000}`);
    let id = 0;
    fixture.quote.mockImplementation(async (_mint, invoice: string) => ({
      amountSats: Number(invoice.split(":")[1]), feeReserveSats: 0,
      rawQuote: { quote: `quote-${++id}`, amount: Number(invoice.split(":")[1]), fee_reserve: 0, unit: "sat" },
    }));
    fixture.wallet.mockResolvedValue(payoutWallet(async (quote, proofs) => {
      const pending: { batches: AdminBatch[] } = await fixture.batches.mock.results.at(-1)!.value;
      const rowsBySecret = new Map(pending.batches.flatMap(current =>
        current.proofs.map((p, index) => [p.secret, current.row_ids[index]] as const)));
      requests.push({ quote: (quote as { quote: string }).quote, rows: proofs.map(p => {
        const row = rowsBySecret.get(p.secret);
        if (!row) throw new Error("Submission contains a proof outside the pending batches");
        return row;
      }) });
      const error = reject(proofs);
      if (error) throw error;
      return { quote: { state: "PAID", payment_preimage: "receipt" } };
    }, { mint: batch.mint_url }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it.each(["skipped key", "refund parse", "valueless condition"])("sets aside a %s before quoting, pays siblings, and reports only its row", async kind => {
    batch.proofs[1] = kind === "skipped key" ? proof("b", LOCK + " ")
      : kind === "refund parse" ? proof("b", LOCK, [["locktime", "1"], ["refund", "invalid-key"]])
        : proof("b", LOCK, [["n_sigs"]]);
    const process = await processObjects(); await process.run();
    expect(requests.map(r => r.rows)).toEqual([["row-a", "row-c", "row-d"]]);
    expect(fixture.invoice).toHaveBeenCalledExactlyOnceWith("payout@example.invalid", 192000);
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({
      batches_melted: 1, batches_failed: 0, batches_partial_failed: 0, rows_set_aside: 1, sats_set_aside: 64, sats_melted: 192,
    }));
    const events = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(line as string));
    expect(events).toContainEqual(expect.objectContaining({ level: "melt_pending_row_set_aside", row_id: "row-b" }));
    const logs = JSON.stringify(events);
    expect(logs).not.toContain(batch.proofs[1].secret);
    expect(logs).not.toContain(PRIVKEY);
    expect(process.journal.readInFlight(DVM)).toEqual([]);
    expect(new process.custody.MeltCustody().operations(DVM).flatMap(op => op.rows)).not.toContain("row-b");
  });

  it("bisects an unidentified witness rejection and pays every usable sibling in the same run", async () => {
    reject = proofs => proofs.some(p => p.secret === batch.proofs[1].secret)
      ? new MintOperationError(11000, "pubkeys must be unique.") : undefined;
    const process = await processObjects(); await process.run();
    expect(requests.map(r => r.rows)).toEqual([
      ["row-a", "row-b", "row-c", "row-d"], ["row-a", "row-b"], ["row-a"], ["row-b"], ["row-c", "row-d"],
    ]);
    expect([...paidRows]).toEqual(["row-a", "row-c", "row-d"]);
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({ batches_failed: 0, rows_set_aside: 1, sats_melted: 192 }));
    expect(process.journal.readInFlight(DVM)).toEqual([]);
    await (await processObjects()).run();
    expect(requests.at(-1)?.rows).toEqual(["row-b"]);
    expect([...paidRows]).toHaveLength(3);
  });

  it.each(["curve identifier", "quoted secret", "signature point"])("removes a proof identified by its %s without probing siblings", async kind => {
    const bad = batch.proofs[1];
    const identifier = kind === "curve identifier" ? hashToCurve(new TextEncoder().encode(bad.secret)).toHex(true)
      : kind === "quoted secret" ? JSON.stringify(bad.secret) : bad.C;
    reject = proofs => proofs.some(p => p.secret === bad.secret)
      ? new MintOperationError(10001, `Proof verification failed: ${identifier}`) : undefined;
    const process = await processObjects(); await process.run();
    expect(requests.map(r => r.rows)).toEqual([["row-a", "row-b", "row-c", "row-d"], ["row-a", "row-c", "row-d"]]);
    expect(fixture.mark).toHaveBeenCalledExactlyOnceWith({
      row_ids: ["row-a", "row-c", "row-d"], melt_quote_id: "quote-2", payment_preimage: "receipt",
    });
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({ rows_set_aside: 1, batches_failed: 0 }));
  });

  it("ignores an out-of-chunk identifier and isolates multiple proofs without shrinking the next batch", async () => {
    const sibling = { ...batch, row_ids: ["row-e", "row-f", "row-g", "row-h"],
      proofs: [proof("e"), proof("f"), proof("g"), proof("h")] };
    fixture.batches.mockResolvedValue({ batches: [batch, sibling] });
    reject = proofs => proofs.some(p => [batch.proofs[0].secret, batch.proofs[3].secret].includes(p.secret))
      ? new MintOperationError(10001, `Proof verification failed: ${hashToCurve(new TextEncoder().encode("unrelated")).toHex(true)}`) : undefined;
    const process = await processObjects(); await process.run();
    expect([...paidRows]).toEqual(["row-b", "row-c", ...sibling.row_ids]);
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({ rows_set_aside: 2, sats_set_aside: 128, batches_failed: 0 }));
    expect(requests.at(-1)?.rows).toEqual(sibling.row_ids);
    expect(fixture.mark).toHaveBeenLastCalledWith({
      row_ids: sibling.row_ids, melt_quote_id: requests.at(-1)!.quote, payment_preimage: "receipt",
    });
  });

  it("keeps the learned input cap while isolating an unidentified rejected row", async () => {
    reject = proofs => proofs.length > 2 ? new MintOperationError(11014, "Request limit")
      : proofs.some(p => p.secret === batch.proofs[1].secret) ? new MintOperationError(10001, "Proof verification failed") : undefined;
    const process = await processObjects(); await process.run();
    expect(requests.map(r => r.rows)).toEqual([
      ["row-a", "row-b", "row-c", "row-d"], ["row-a", "row-b"], ["row-a"], ["row-b"], ["row-c", "row-d"],
    ]);
    expect([...paidRows]).toEqual(["row-a", "row-c", "row-d"]);
    expect(new Set(fixture.mark.mock.calls.flatMap(([body]) => body.row_ids))).toEqual(paidRows);
  });

  it.each([new Error("pubkeys must be unique."), new MintOperationError(11000, "unknown transaction failure"),
    new MintOperationError(0, "list index out of range"), new MintOperationError(11001, "Proofs already spent")])(
    "holds an ambiguous $name submission across restart without splitting or retrying", async error => {
      reject = () => error;
      const process = await processObjects(); await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
      expect(process.journal.readInFlight(DVM)).toHaveLength(1);
      await (await processObjects()).run();
      expect(requests).toHaveLength(1);
      expect(fixture.mark).not.toHaveBeenCalled();
      expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({ rows_set_aside: 0 }));
    }
  );

  it("keeps an error exit for an uncertain chunk beside a paid chunk, with separate batch counters", async () => {
    batch.row_ids = Array.from({ length: 201 }, (_, i) => `row-${i}`);
    batch.proofs = batch.row_ids.map(row => ({ ...proof(row), secret: `synthetic-${row}` }));
    batch.total_sats = 12864;
    reject = proofs => proofs.some(p => p.secret === batch.proofs[200].secret) ? new Error("response lost") : undefined;
    const process = await processObjects();
    await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({
      batches_melted: 1, batches_failed: 0, batches_partial_failed: 1, rows_set_aside: 0, sats_melted: 12800,
    }));
    expect(paidRows.size).toBe(200);
    expect(process.journal.readInFlight(DVM).map(entry => entry.rowIds)).toEqual([["row-200"]]);
    await (await processObjects()).run();
    expect(requests).toHaveLength(2);
  });

  it("reports a paid but unacknowledged melt as a partial failure and recovers without resubmission", async () => {
    fixture.mark.mockRejectedValueOnce(new Error("admin unavailable"));
    const process = await processObjects();
    await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({
      batches_melted: 1, batches_failed: 0, batches_partial_failed: 1, sats_melted: 256,
    }));
    expect(process.journal.readInFlight(DVM)).toHaveLength(1);
    await (await processObjects()).run();
    expect(requests).toHaveLength(1);
    expect(process.journal.readInFlight(DVM)).toEqual([]);
    expect([...paidRows]).toEqual(batch.row_ids);
  });

  it("reports an all-isolated batch distinctly from an operational failure", async () => {
    reject = () => new MintOperationError(10001, "Proof verification failed");
    const process = await processObjects(); await process.run();
    expect(fixture.mark).not.toHaveBeenCalled();
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({
      batches_failed: 0, batches_partial_failed: 0, batches_skipped: 1, rows_set_aside: 4, sats_set_aside: 256,
    }));
    expect(process.journal.readInFlight(DVM)).toEqual([]);
  });

  it("separates SIG_ALL from SIG_INPUTS before the real wallet signer sees a combined request", async () => {
    batch.proofs[1] = proof("b", LOCK, [["sigflag", "SIG_ALL"]]);
    const process = await processObjects(); await process.run();
    expect(requests.map(r => r.rows)).toEqual([["row-a"], ["row-b"], ["row-c", "row-d"]]);
    expect([...paidRows]).toEqual(batch.row_ids);
    expect(process.output.json).toHaveBeenLastCalledWith(expect.objectContaining({ rows_set_aside: 0, batches_failed: 0 }));
  });

  it("releases a proven local signing failure without leaving a possible submission in custody", async () => {
    const wallet: Wallet = await fixture.wallet();
    const sign = wallet.signP2PKProofs.bind(wallet);
    vi.spyOn(wallet, "signP2PKProofs").mockImplementation((proofs, key, outputs, quote) => {
      if (proofs.some(p => p.secret === batch.proofs[1].secret)) throw new Error("local signing error");
      return sign(proofs, key, outputs, quote);
    });
    const process = await processObjects(); await process.run();
    expect([...paidRows]).toEqual(["row-a", "row-c", "row-d"]);
    expect(process.journal.readInFlight(DVM)).toEqual([]);
    expect(new process.custody.MeltCustody().operations(DVM).filter(op => op.submission !== "rejected").flatMap(op => op.rows))
      .toEqual(["row-a", "row-c", "row-d"]);
  });
});

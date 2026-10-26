import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MeltChangeError, MintOperationError } from "@cashu/cashu-ts";
import type * as SdkInternal from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { admin, mint } = vi.hoisted(() => ({
  admin: { getPendingBatches: vi.fn(), getPendingDrains: vi.fn(), markMelted: vi.fn() },
  mint: { submit: vi.fn(), check: vi.fn(), quote: vi.fn() },
}));
const PUBKEY = "02" + "aa".repeat(32);
const DVM_ID = "recovery-fixture";
const BATCH = {
  mint_url: "https://mint.invalid",
  lock_pubkey: PUBKEY,
  row_ids: ["row-1"],
  proofs: [{ id: "keyset", amount: 60, secret: "synthetic-input", C: "synthetic-point" }],
  total_sats: 60,
  t_expire: null,
};

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkInternal>()),
  deriveBuilderLockKeypair: vi.fn(() => ({ privkey: "11".repeat(32), pubkey: PUBKEY })),
  fetchMeltQuote: mint.quote,
  checkMeltQuoteState: mint.check,
  getInputFeesForProofs: vi.fn(async () => 0),
  getWallet: vi.fn(async () => ({ meltProofsBolt11: mint.submit })),
  fetchLnurlPayInvoice: vi.fn(async () => "synthetic-invoice"),
}));
vi.mock("../../../lib/builder-mnemonic", () => ({
  readBuilderMnemonic: vi.fn(() => "word ".repeat(11) + "word"),
}));
vi.mock("../../../shared/builder-store", () => {
  const entry = () => ({
    handle: "fixture", canonical_dvm_id: DVM_ID, current_rotation_index: 0,
    payout_ln_address: "payout@example.invalid",
  });
  return { getBuilderDvm: vi.fn(entry), requireBuilderDvmByHandle: vi.fn(entry),
    findBuilderDvmsByHandle: vi.fn(() => [entry()]) };
});
vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({ dvmId: DVM_ID })),
}));
vi.mock("../../../lib/admin-cashu-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/admin-cashu-client")>()),
  AdminCashuClient: class { constructor() { return admin; } },
}));
vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn() }));

async function loadProcess() {
  vi.resetModules();
  const { meltPending } = await import("../melt-pending");
  const journal = await import("../../../lib/melt-pending-log");
  return { run: () => meltPending("fixture", { endpoint: "https://dvm.invalid" }), journal };
}

describe("uncertain melt recovery with a durable journal", () => {
  let stateDir: string;
  let paid: boolean;
  let acknowledged: boolean;

  beforeEach(() => {
    vi.resetAllMocks();
    stateDir = mkdtempSync(join(tmpdir(), "melt-recovery-"));
    vi.stubEnv("DVMKIT_CONFIG_DIR", stateDir);
    paid = false;
    acknowledged = false;
    admin.getPendingDrains.mockResolvedValue({
      drains: [], liability: { cashu_sats: 0, by_method_micro: {} },
    });
    admin.getPendingBatches.mockImplementation(async () => ({ batches: acknowledged ? [] : [BATCH] }));
    admin.markMelted.mockImplementation(async () => { acknowledged = true; return { melted: 1 }; });
    mint.quote.mockResolvedValue({
      amountSats: 60, feeReserveSats: 0, rawQuote: { quote: "original-quote" },
    });
    mint.check.mockImplementation(async () => ({
      state: paid ? "PAID" : "UNPAID", payment_preimage: paid ? "payment-receipt" : null,
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it.each(["accepted timeout", "paid change reconstruction error", "malformed response"])(
    "reconciles %s on the original quote after restart, once",
    async (failure) => {
      mint.submit.mockImplementation(async () => {
        paid = true;
        if (failure === "paid change reconstruction error") {
          throw new MeltChangeError([], {
            quote: "original-quote", state: "PAID", payment_preimage: "payment-receipt",
          } as never);
        }
        if (failure === "malformed response") return {};
        throw new Error("transport timeout after acceptance");
      });
      let process = await loadProcess();
      await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
      expect(process.journal.readInFlight(DVM_ID).map((entry) => entry.rowIds)).toEqual([["row-1"]]);

      process = await loadProcess();
      await process.run();
      await process.run();
      expect(admin.markMelted).toHaveBeenCalledExactlyOnceWith({
        row_ids: ["row-1"], melt_quote_id: "original-quote", payment_preimage: "payment-receipt",
      });
      expect(mint.check).toHaveBeenCalledExactlyOnceWith(BATCH.mint_url, "original-quote");
      expect(mint.submit).toHaveBeenCalledTimes(1);
      expect(mint.quote).toHaveBeenCalledTimes(1);
      expect(process.journal.readInFlight(DVM_ID)).toEqual([]);
    }
  );

  it("holds a delayed UNPAID then PENDING submission until PAID across restarts", async () => {
    mint.submit.mockResolvedValue({ quote: { state: "PENDING" }, change: [] });
    let process = await loadProcess();
    await process.run();
    for (const state of ["UNPAID", "UNPAID", "PENDING"]) {
      mint.check.mockResolvedValue({ state });
      process = await loadProcess();
      await process.run();
      expect(process.journal.readInFlight(DVM_ID)).toHaveLength(1);
      expect(admin.markMelted).not.toHaveBeenCalled();
      expect(mint.quote).toHaveBeenCalledTimes(1);
      expect(mint.submit).toHaveBeenCalledTimes(1);
    }
    mint.check.mockResolvedValue({ state: "PAID", payment_preimage: "delayed-receipt" });
    process = await loadProcess();
    await process.run();
    await process.run();
    expect(admin.markMelted).toHaveBeenCalledExactlyOnceWith({
      row_ids: ["row-1"], melt_quote_id: "original-quote", payment_preimage: "delayed-receipt",
    });
    expect(process.journal.readInFlight(DVM_ID)).toEqual([]);
    expect(mint.quote).toHaveBeenCalledTimes(1);
  });

  it("retries payment acknowledgement after a restart mid-recovery without re-submitting", async () => {
    mint.submit.mockImplementation(async () => { paid = true; throw new Error("response lost"); });
    let process = await loadProcess();
    await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
    admin.markMelted.mockRejectedValueOnce(new Error("admin connection lost"));
    process = await loadProcess();
    await process.run();
    expect(process.journal.readInFlight(DVM_ID)).toHaveLength(1);
    expect(mint.quote).toHaveBeenCalledTimes(1);
    process = await loadProcess();
    await process.run();
    await process.run();
    expect(admin.markMelted).toHaveBeenCalledTimes(2);
    expect(admin.markMelted.mock.calls).toEqual(Array(2).fill([{
      row_ids: ["row-1"], melt_quote_id: "original-quote", payment_preimage: "payment-receipt",
    }]));
    expect(mint.submit).toHaveBeenCalledTimes(1);
    expect(mint.quote).toHaveBeenCalledTimes(1);
    expect(process.journal.readInFlight(DVM_ID)).toEqual([]);
  });

  it("keeps a pending change error held instead of treating its class as proof of payment", async () => {
    mint.submit.mockRejectedValue(new MeltChangeError([], {
      quote: "original-quote", state: "PENDING",
    } as never));
    let process = await loadProcess();
    await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
    process = await loadProcess();
    await process.run();
    expect(admin.markMelted).not.toHaveBeenCalled();
    expect(process.journal.readInFlight(DVM_ID)).toHaveLength(1);
    expect(mint.quote).toHaveBeenCalledTimes(1);
  });

  it.each([11001, 11002, 20005, 99999])("holds ambiguous protocol code %i for recovery", async (code) => {
    mint.submit.mockRejectedValue(new MintOperationError(code, "uncertain outcome"));
    let process = await loadProcess();
    await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
    process = await loadProcess();
    await process.run();
    expect(process.journal.readInFlight(DVM_ID)).toHaveLength(1);
    expect(mint.quote).toHaveBeenCalledTimes(1);
    expect(admin.markMelted).not.toHaveBeenCalled();
  });

  it.each(["UNPAID", "unexpected"])("does not acknowledge a %s response carrying a preimage", async (state) => {
    mint.submit.mockResolvedValue({ quote: { state, payment_preimage: "unproven-receipt" } });
    const process = await loadProcess();
    await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(admin.markMelted).not.toHaveBeenCalled();
    expect(process.journal.readInFlight(DVM_ID)).toHaveLength(1);
  });

  it("does not acknowledge an unrecognized recovery state carrying a preimage", async () => {
    mint.submit.mockResolvedValue({ quote: { state: "PENDING" } });
    let process = await loadProcess();
    await process.run();
    mint.check.mockResolvedValue({ state: "unexpected", payment_preimage: "unproven-receipt" });
    process = await loadProcess();
    await process.run();
    expect(admin.markMelted).not.toHaveBeenCalled();
    expect(process.journal.readInFlight(DVM_ID)).toHaveLength(1);
    expect(mint.quote).toHaveBeenCalledTimes(1);
  });

  it.each([10001, 11014, 11015])("closes proven rejection %i without reopening historical failures", async (code) => {
    mint.submit.mockRejectedValue(new MintOperationError(code, "validation rejected"));
    const process = await loadProcess();
    for (const error of ["transport timeout", "Request limit", "ln_unpaid_on_recovery"]) {
      process.journal.appendPreMelt({
        dvm_id: DVM_ID, row_ids: ["historical-row"], quote_id: error,
        mint_url: BATCH.mint_url, lock_pubkey: PUBKEY, total_sats: 60,
      });
      process.journal.appendPostMelt({
        dvm_id: DVM_ID, row_ids: ["historical-row"], quote_id: error, status: "failed", error,
      });
    }
    await expect(process.run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(process.journal.lookupMeltQuote(DVM_ID, "original-quote")).toEqual({ state: "resolved" });
    expect(process.journal.readInFlight(DVM_ID)).toEqual([]);
    expect(mint.check).not.toHaveBeenCalled();
    expect(admin.markMelted).not.toHaveBeenCalled();
  });

});

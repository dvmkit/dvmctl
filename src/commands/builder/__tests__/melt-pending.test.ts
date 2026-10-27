import { rmSync } from "node:fs";
import { join } from "node:path";
import { payoutWallet } from "../../../../test-support/payout-wallet.ts";
import { BUILDER_CONFIG_DIR } from "../../../shared/defaults.ts";
import type * as SdkInternal from "@dvmkit/sdk/internal";
import { MintOperationError } from "@cashu/cashu-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as adminCashuClientModule from "../../../lib/admin-cashu-client";
import type { AdminBatch } from "../../../lib/admin-cashu-client";
import type * as drainHoldStateModule from "../../../lib/drain-hold-state";

vi.mock("../../../lib/builder-mnemonic", () => ({
  readBuilderMnemonic: vi.fn(),
}));

vi.mock("../../../shared/builder-store", async () => {
  const { DvmError } = await import("@dvmkit/sdk/internal");
  const getBuilderDvm = vi.fn();
  return {
    findBuilderDvmsByHandle: vi.fn(),
    getBuilderDvm,

    // The real store's typed refusals, over the same fixture knob the suites
    // already set: `getBuilderDvm` returning undefined means "no entry here".
    requireSelectedBuilderDvm: vi.fn((dvmId: string) => {
      const entry = getBuilderDvm(dvmId);
      if (!entry) {
        throw new DvmError(
          "dvm_not_initialized",
          `No builder.json entry for selected DVM ${dvmId}.`,
          "Run `dvmctl deploy` first so this DVM's canonical_dvm_id is recorded."
        );
      }
      return entry;
    }),
    requireBuilderDvmByHandle: vi.fn((handle: string) => {
      const entry = getBuilderDvm(handle);
      if (!entry) {
        throw new DvmError(
          "dvm_not_initialized",
          `No builder.json entry on this machine for "${handle}".`,
          "…every proof locked under the old one becomes underivable."
        );
      }
      return entry;
    }),
  };
});

// One factory, not five: the builder subkey, melt, wallet, lnurl and NWC modules
// this used to mock one by one are all `@dvmkit/sdk/internal` now, and a second
// `vi.mock` of the same specifier replaces the first rather than adding to it.
// Everything else the command reaches through that entry point stays real.
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkInternal>()),
  deriveBuilderLockKeypair: vi.fn(),
  fetchMeltQuote: vi.fn(),
  checkMeltQuoteState: vi.fn(),
  getInputFeesForProofs: vi.fn().mockResolvedValue(0),
  getWallet: vi.fn(),
  fetchLnurlPayInvoice: vi.fn(),
  makeInvoice: vi.fn(),
}));

vi.mock("../../../lib/melt-pending-log", () => ({
  appendPreMelt: vi.fn(),
  appendPostMelt: vi.fn(),
  appendAcknowledgement: vi.fn((entry: object) => ({ ...entry, kind: "melt_acknowledged", ts: 0 })),
  lookupMeltQuote: vi.fn(() => ({ state: "unknown" })),
  readInFlight: vi.fn(() => []),
  readMeltHistory: vi.fn(() => []),
}));

vi.mock("../../../lib/drain-park-log", () => ({
  appendSwapped: vi.fn(),
  appendParked: vi.fn(),
  readUnparked: vi.fn(() => []),
  appendMintQuote: vi.fn(),
  appendMintPaid: vi.fn(),
  appendMintPaymentAttempt: vi.fn(),
  appendMintPaymentRejected: vi.fn(),
  appendMintOutputs: vi.fn(),
  appendMintAbandoned: vi.fn(),
  readOpenMintQuotes: vi.fn(() => []),
}));

// The liveness record is cross-run by design too — mocked so these
// cases assert what a run stamps rather than what a shared file accumulated.
vi.mock("../../../lib/melt-success-state", () => ({
  recordMeltSuccess: vi.fn(),
}));

// The hold-ceiling state is cross-run by design, so mocking it is
// what keeps one test's streak out of the next test's sweep.
vi.mock("../../../lib/drain-hold-state", async (importOriginal) => ({
  ...(await importOriginal<typeof drainHoldStateModule>()),
  recordDrainState: vi.fn(() => null),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("../../../lib/platform-client", () => ({
  getDvm: vi.fn(),
}));

vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({
    dvmId: "dvm-fixture-1",
    token: "t",
    platformUrl: "https://api.example",
  })),
}));

vi.mock("../../../lib/admin-cashu-client", async (importOriginal) => {
  const actual = await importOriginal<typeof adminCashuClientModule>();
  // Class shell whose constructor delegates to the spy on `clientCtorSpy`,
  // so tests can intercept construction with `mockReturnValue`.
  class AdminCashuClient {
    constructor(opts: unknown) {
      return clientCtorSpy(opts) as AdminCashuClient;
    }
  }
  return { ...actual, AdminCashuClient };
});

const clientCtorSpy = vi.fn();

import * as builderSubkey from "@dvmkit/sdk/internal";
import * as melt from "@dvmkit/sdk/internal";
import * as wallet from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";
import * as lnurl from "@dvmkit/sdk/internal";
import * as nwcModule from "@dvmkit/sdk/internal";

import { AdminApiError } from "../../../lib/admin-cashu-client";
import * as builderMnemonic from "../../../lib/builder-mnemonic";
import * as drainHoldState from "../../../lib/drain-hold-state";
import * as drainParkLog from "../../../lib/drain-park-log";
import * as meltLog from "../../../lib/melt-pending-log";
import * as meltSuccessState from "../../../lib/melt-success-state";
import * as platform from "../../../lib/platform";
import * as platformClient from "../../../lib/platform-client";
import * as builderStore from "../../../shared/builder-store";
import * as output from "../../../shared/output";
import { meltPending } from "../melt-pending";

const PRIVKEY = "11".repeat(32);
const PUBKEY = "02" + "aa".repeat(32);
const REFUND_PUBKEY = "02" + "bb".repeat(32);

function payoutWalletFixture(submit: Parameters<typeof payoutWallet>[0]) {
  return payoutWallet(submit, {
    mint: () => vi.mocked(wallet.getWallet).mock.calls.at(-1)?.[0] ?? "https://mint",
    quote: async () => (await vi.mocked(melt.fetchMeltQuote).mock.results.at(-1)?.value)?.rawQuote ?? {},
    fee: async () => await vi.mocked(melt.getInputFeesForProofs).mock.results.at(-1)?.value ?? 0,
  });
}

function setHappyPath(): {
  getPendingBatches: ReturnType<typeof vi.fn>;
  markMelted: ReturnType<typeof vi.fn>;
  getPendingDrains: ReturnType<typeof vi.fn>;
} {
  vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue("word ".repeat(11) + "word");
  vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
    handle: "dvm",
    canonical_dvm_id: "dvm-fixture-1",
    current_rotation_index: 0,
    payout_ln_address: "alice@example.com",
    updated_at: "2026-05-01",
  });
  vi.mocked(builderSubkey.deriveBuilderLockKeypair).mockReturnValue({
    privkey: PRIVKEY,
    pubkey: PUBKEY,
  });
  vi.mocked(platform.requireAuth).mockReturnValue({
    token: "t",
    platformUrl: "https://api.example",
  });

  const getPendingBatches = vi.fn();
  const markMelted = vi.fn();
  const drainSurface = emptyDrainSurface();
  clientCtorSpy.mockReturnValue({
    getPendingBatches,
    markMelted,
    ...drainSurface,
  });
  return { getPendingBatches, markMelted, getPendingDrains: drainSurface.getPendingDrains };
}

/**
 * One cashu drain the tick cannot settle — with no batch covering it, `parkOne`
 * bails at `drain_park_insufficient_batch`.
 */
function withPendingCashuDrain(getPendingDrains: ReturnType<typeof vi.fn>): void {
  getPendingDrains.mockResolvedValue({
    drains: [
      {
        credit_id: "c1",
        drain_id: "d1",
        method: "cashu",
        payout: { refund_pubkey: REFUND_PUBKEY },
        currency: "usd",
        amount_micro: 400_000,
        amount_sats: 400,
        amount_msats: 400_000,
        created_at: 1,
      },
    ],
    liability: { cashu_sats: 400, by_method_micro: {} },
  });
}

/**
 * One x402 drain, which `serviceDrains` files for a person. Nothing
 * is attempted, so no failure counter moves — and no configuration change
 * would ever settle it: only the operator's own `drain-settle` does.
 */
function withPendingStablecoinDrain(getPendingDrains: ReturnType<typeof vi.fn>): void {
  getPendingDrains.mockResolvedValue({
    drains: [
      {
        credit_id: "imp:x402:0xabc",
        drain_id: "d3",
        method: "x402",
        payout: { address: "0x" + "12".repeat(20) },
        currency: "usd",
        amount_micro: 400_000,
        amount_sats: null,
        amount_msats: null,
        amount_native: 400_000,
        settlement: "manual",
        created_at: 1,
      },
    ],
    liability: {
      cashu_sats: 0,
      by_method_micro: { x402: 400_000 },
      manual_micro: 400_000,
    },
  });
}

/**
 * One channel-backed reclaim mid-close. Same rail and same `pending`
 * status as the row above, but its own cooperative close settles it on the
 * caller's next poll, so nobody here has anything to do about it.
 */
function withPendingChannelDrain(getPendingDrains: ReturnType<typeof vi.fn>): void {
  getPendingDrains.mockResolvedValue({
    drains: [
      {
        credit_id: "c-tempo",
        drain_id: "d4",
        method: "tempo",
        payout: {},
        currency: "usd",
        amount_micro: 750_000,
        amount_sats: null,
        amount_msats: null,
        amount_native: 750_000,
        settlement: "channel",
        channel_id: "chan-1",
        created_at: 1,
      },
    ],
    liability: {
      cashu_sats: 0,
      by_method_micro: { tempo: 750_000 },
      manual_micro: 0,
      channel_micro: 750_000,
    },
  });
}

/** Drain stubs: no pending drains, so melts are never held back. */
function emptyDrainSurface(): {
  getPendingDrains: ReturnType<typeof vi.fn>;
  parkDrain: ReturnType<typeof vi.fn>;
  markDrainSent: ReturnType<typeof vi.fn>;
} {
  return {
    getPendingDrains: vi.fn().mockResolvedValue({
      drains: [],
      liability: { cashu_sats: 0, by_method_micro: {} },
    }),
    parkDrain: vi.fn(),
    markDrainSent: vi.fn(),
  };
}

describe("dvmctl melt-pending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(join(BUILDER_CONFIG_DIR, "melt-custody.json"), { force: true });
    rmSync(join(BUILDER_CONFIG_DIR, "melt-custody.initialized"), { force: true });
    vi.mocked(meltLog.readInFlight).mockReturnValue([]);
    vi.mocked(meltLog.readMeltHistory).mockReturnValue([]);
    vi.mocked(meltLog.lookupMeltQuote).mockReturnValue({ state: "unknown" });
    // `clearMocks` clears calls, not queued return values — a seeded park log
    // would otherwise recover into every test declared after it.
    vi.mocked(drainParkLog.readUnparked).mockReturnValue([]);
    vi.mocked(drainHoldState.recordDrainState).mockReturnValue(null);
    vi.mocked(melt.getInputFeesForProofs).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("chunked melts", () => {
    function setupChunks(count: number, limit = 200, errorCode = 11014) {
      const { getPendingBatches, markMelted } = setHappyPath();
      const batch: AdminBatch = {
        mint_url: "https://mint",
        lock_pubkey: PUBKEY,
        row_ids: Array.from({ length: count }, (_, i) => `r${i}`),
        proofs: Array.from({ length: count }, (_, i) => ({
          id: "k", amount: 8, secret: `s${i}`, C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        })),
        total_sats: count * 8,
        t_expire: null,
      };
      getPendingBatches.mockResolvedValue({ batches: [batch] });
      markMelted.mockResolvedValue({ melted: 1 });
      vi.mocked(lnurl.fetchLnurlPayInvoice).mockImplementation(async (_address, msats) =>
        `invoice:${msats}`
      );
      let quoteId = 0;
      vi.mocked(melt.fetchMeltQuote).mockImplementation(async (_mint, invoice) => ({
        amountSats: Number(invoice.split(":")[1]) / 1000,
        feeReserveSats: 0,
        rawQuote: { quote: `q${++quoteId}`, amount: Number(invoice.split(":")[1]) / 1000, fee_reserve: 0, unit: "sat" } as never,
      }));
      const meltProofsBolt11 = vi.fn(async (_quote: unknown, proofs: AdminBatch["proofs"]) => {
        if (proofs.length > limit) throw new MintOperationError(errorCode, "Request limit");
        return { quote: { state: "PAID", payment_preimage: "paid" }, change: [] };
      });
      vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
      return { batch, getPendingBatches, markMelted, meltProofsBolt11, stdout };
    }

    it("caps default requests at 200 and marks all 600 rows exactly once", async () => {
      const { batch, markMelted, meltProofsBolt11 } = setupChunks(600);
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(meltProofsBolt11.mock.calls.map(([, proofs]) => proofs.length)).toEqual([200, 200, 200]);
      expect(markMelted.mock.calls.flatMap(([body]) => body.row_ids)).toEqual(batch.row_ids);
      expect(meltLog.appendPreMelt).toHaveBeenCalledTimes(3);
      expect(meltLog.appendPostMelt).toHaveBeenCalledTimes(3);
      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({
        batches_seen: 1, batches_melted: 1, batches_failed: 0, sats_melted: 4800,
      }));
    });

    it.each([11014, 11015])("halves on mint error %i and settles every row", async (code) => {
      const { batch, markMelted, meltProofsBolt11, stdout } = setupChunks(150, 50, code);
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(meltProofsBolt11.mock.calls.map(([, proofs]) => proofs.length)).toEqual([
        150, 75, 37, 37, 37, 37, 2,
      ]);
      expect(markMelted.mock.calls.flatMap(([body]) => body.row_ids)).toEqual(batch.row_ids);
      expect(new Set(markMelted.mock.calls.map(([body]) => body.melt_quote_id)).size).toBe(5);
      expect(meltLog.appendPreMelt).toHaveBeenCalledTimes(7);
      expect(meltLog.appendPostMelt).toHaveBeenCalledTimes(7);
      for (const [entry] of vi.mocked(meltLog.appendPreMelt).mock.calls) {
        expect(meltLog.appendPostMelt).toHaveBeenCalledWith(expect.objectContaining({
          quote_id: entry.quote_id, row_ids: entry.row_ids,
        }));
      }
      expect(stdout.mock.calls.map(([line]) => JSON.parse(line as string))).toContainEqual(
        expect.objectContaining({ level: "melt_pending_input_cap_reduced", input_cap: 37 })
      );
    });

    it("reuses a reduced cap for the same mint without applying it to other mints", async () => {
      const { batch, getPendingBatches, meltProofsBolt11 } = setupChunks(150, 50);
      const sibling = {
        ...batch,
        row_ids: batch.row_ids.map((id) => `other-${id}`),
        proofs: batch.proofs.map((proof) => ({ ...proof, secret: `other-${proof.secret}` })),
      };
      getPendingBatches.mockResolvedValue({ batches: [
        batch, sibling, { ...sibling, mint_url: "https://another-mint" },
      ] });
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(meltProofsBolt11.mock.calls.map(([, proofs]) => proofs.length)).toEqual([
        150, 75, 37, 37, 37, 37, 2,
        37, 37, 37, 37, 2,
        150, 75, 37, 37, 37, 37, 2,
      ]);
    });

    it("sums proof values for each invoice and records the corresponding row subset", async () => {
      const { batch } = setupChunks(201);
      batch.proofs[200].amount = 64;
      batch.total_sats = 1664;
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(vi.mocked(lnurl.fetchLnurlPayInvoice).mock.calls.map(([, amount]) => amount))
        .toEqual([1600000, 64000]);
      expect(meltLog.appendPreMelt).toHaveBeenNthCalledWith(1, expect.objectContaining({
        row_ids: batch.row_ids.slice(0, 200), quote_id: "q1", total_sats: 1600,
      }));
      expect(meltLog.appendPreMelt).toHaveBeenNthCalledWith(2, expect.objectContaining({
        row_ids: ["r200"], quote_id: "q2", total_sats: 64,
      }));
    });

    it("refuses mismatched row and proof counts before spending", async () => {
      const { batch, markMelted, meltProofsBolt11 } = setupChunks(3);
      batch.row_ids.pop();
      await expect(meltPending("dvm", { endpoint: "https://dvm.example" }))
        .rejects.toMatchObject({ code: "batches_failed" });
      expect(meltProofsBolt11).not.toHaveBeenCalled();
      expect(markMelted).not.toHaveBeenCalled();
      expect(lnurl.fetchLnurlPayInvoice).not.toHaveBeenCalled();
    });

    it("keeps a small batch in one melt", async () => {
      const { batch, markMelted, meltProofsBolt11 } = setupChunks(3);
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(meltProofsBolt11).toHaveBeenCalledTimes(1);
      expect(markMelted).toHaveBeenCalledExactlyOnceWith({
        row_ids: batch.row_ids, melt_quote_id: "q1", payment_preimage: "paid",
      });
    });

    it("stops reducing at one proof without marking rejected rows", async () => {
      const { markMelted, meltProofsBolt11 } = setupChunks(3, 0);
      await expect(meltPending("dvm", { endpoint: "https://dvm.example" }))
        .rejects.toMatchObject({ code: "batches_failed" });
      expect(meltProofsBolt11.mock.calls.map(([, proofs]) => proofs.length)).toEqual([3, 1, 1, 1]);
      expect(markMelted).not.toHaveBeenCalled();
      expect(meltLog.appendPostMelt).toHaveBeenCalledTimes(4);
    });

    it("continues siblings after failure and retries only the failed rows next run", async () => {
      const { batch, getPendingBatches, markMelted, meltProofsBolt11 } = setupChunks(450);
      meltProofsBolt11.mockImplementationOnce(async () => {
        throw new MintOperationError(10001, "Rejected");
      });
      await expect(meltPending("dvm", { endpoint: "https://dvm.example" }))
        .rejects.toMatchObject({ code: "batches_failed" });
      expect(markMelted.mock.calls.flatMap(([body]) => body.row_ids)).toEqual(batch.row_ids.slice(200));
      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({
        batches_failed: 1, sats_melted: 2000,
      }));
      getPendingBatches.mockResolvedValue({ batches: [{
        ...batch, row_ids: batch.row_ids.slice(0, 200), proofs: batch.proofs.slice(0, 200), total_sats: 1600,
      }] });
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      const marked = markMelted.mock.calls.flatMap(([body]) => body.row_ids);
      expect(marked).toHaveLength(450);
      expect(new Set(marked)).toEqual(new Set(batch.row_ids));
    });

    it("sizes invoices and two-pass reserves from each chunk's proofs", async () => {
      setupChunks(201);
      vi.mocked(melt.getInputFeesForProofs).mockImplementation(async (_mint, proofs) => proofs.length);
      vi.mocked(melt.fetchMeltQuote).mockImplementation(async (_mint, invoice) => ({
        amountSats: Number(invoice.split(":")[1]) / 1000,
        feeReserveSats: 2,
        rawQuote: { quote: invoice, amount: Number(invoice.split(":")[1]) / 1000, fee_reserve: 2, unit: "sat" } as never,
      }));
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(vi.mocked(melt.getInputFeesForProofs).mock.calls.map(([, proofs]) => proofs.length))
        .toEqual([200, 1]);
      expect(vi.mocked(lnurl.fetchLnurlPayInvoice).mock.calls.map(([, amount]) => amount))
        .toEqual([1400000, 1398000, 7000, 5000]);
    });

    it("skips a fee-starved chunk while its sibling pays out", async () => {
      const { batch, markMelted } = setupChunks(201);
      vi.mocked(melt.getInputFeesForProofs).mockImplementation(async (_mint, proofs) =>
        proofs.length === 1 ? 8 : 0
      );
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(markMelted.mock.calls.flatMap(([body]) => body.row_ids)).toEqual(batch.row_ids.slice(0, 200));
      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({
        batches_skipped: 1, sats_melted: 1600,
      }));
    });

    it("holds pending rows individually while melting fresh siblings", async () => {
      const { batch, markMelted, meltProofsBolt11 } = setupChunks(201);
      vi.mocked(meltLog.readInFlight).mockReturnValue([{
        ts: Date.now(), dvmId: "dvm-fixture-1", rowIds: batch.row_ids.slice(0, 200),
        mintUrl: "https://mint", quoteId: "pending", lockPubkey: PUBKEY, totalSats: 1600,
      }]);
      vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({ state: "PENDING" } as never);
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(meltProofsBolt11.mock.calls.map(([, proofs]) => proofs.map((p) => p.secret)))
        .toEqual([["s200"]]);
      expect(markMelted).toHaveBeenCalledExactlyOnceWith({
        row_ids: ["r200"], melt_quote_id: "q1", payment_preimage: "paid",
      });
      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({
        batches_skipped: 1, sats_melted: 8,
      }));
    });

    it("recovers only a paid chunk after marking failed, without spending it again", async () => {
      const { batch, getPendingBatches, markMelted, meltProofsBolt11 } = setupChunks(201);
      markMelted.mockRejectedValueOnce(new Error("DVM unreachable"));
      await expect(meltPending("dvm", { endpoint: "https://dvm.example" }))
        .rejects.toMatchObject({ code: "batches_failed" });
      expect(meltLog.appendPostMelt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ quote_id: "q2", row_ids: ["r200"], status: "success" })
      );
      vi.mocked(meltLog.readInFlight).mockReturnValue([{
        ts: Date.now(), dvmId: "dvm-fixture-1", rowIds: batch.row_ids.slice(0, 200),
        mintUrl: "https://mint", quoteId: "q1", lockPubkey: PUBKEY, totalSats: 1600,
      }]);
      vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
        state: "PAID", payment_preimage: "paid",
      } as never);
      getPendingBatches.mockResolvedValue({ batches: [] });
      await meltPending("dvm", { endpoint: "https://dvm.example" });
      expect(meltProofsBolt11).toHaveBeenCalledTimes(2);
      expect(markMelted).toHaveBeenLastCalledWith({
        row_ids: batch.row_ids.slice(0, 200), melt_quote_id: "q1", payment_preimage: "paid",
      });
    });
  });

  it("errors when no builder mnemonic exists", async () => {
    vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue(null);
    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "no_builder_mnemonic",
    });
  });

  it("errors when no builder.json entry exists for handle", async () => {
    vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue("m");
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue(undefined);
    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "dvm_not_initialized",
    });
  });

  it("errors when no payout address resolves (no flag, no persisted)", async () => {
    vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue("m");
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "dvm",
      canonical_dvm_id: "dvm-fixture-1",
      current_rotation_index: 0,
      updated_at: "2026-05-01",
    });
    vi.mocked(builderSubkey.deriveBuilderLockKeypair).mockReturnValue({
      privkey: PRIVKEY,
      pubkey: PUBKEY,
    });
    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "no_payout_destination",
    });
  });

  it("uses an older /v1/info match to settle an ambiguous handle and sign the command", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({ batches: [] });
    const other = {
      handle: "dvm",
      canonical_dvm_id: "dvm-other",
      current_rotation_index: 0,
      payout_ln_address: "other@example.com",
      updated_at: "2026-05-01",
    };
    const matching = {
      handle: "dvm",
      canonical_dvm_id: "dvm-matching",
      current_rotation_index: 2,
      payout_ln_address: "matching@example.com",
      updated_at: "2026-05-02",
    };
    const advertisedRetiredPubkey = "03" + "cc".repeat(32);
    const advertisedRetiredPrivkey = "33".repeat(32);
    const locallyNewestPubkey = "02" + "ee".repeat(32);
    vi.mocked(builderStore.requireBuilderDvmByHandle).mockImplementationOnce(() => {
      throw new DvmError(
        "ambiguous_dvm_handle",
        '2 builder.json entries claim the handle "dvm".',
        "original refusal"
      );
    });
    vi.mocked(builderStore.findBuilderDvmsByHandle).mockReturnValueOnce([other, matching]);
    vi.mocked(builderStore.getBuilderDvm).mockImplementation((dvmId: string) =>
      dvmId === matching.canonical_dvm_id ? matching : undefined
    );
    vi.mocked(builderSubkey.deriveBuilderLockKeypair).mockImplementation(
      (_mnemonic: string, dvmId: string, rotationIndex: number) => {
        if (dvmId === matching.canonical_dvm_id && rotationIndex === 1) {
          return { privkey: advertisedRetiredPrivkey, pubkey: advertisedRetiredPubkey };
        }
        if (dvmId === matching.canonical_dvm_id && rotationIndex === 2) {
          return { privkey: "55".repeat(32), pubkey: locallyNewestPubkey };
        }
        return {
          privkey: "44".repeat(32),
          pubkey: "02" + "dd".repeat(31) + (rotationIndex + 1).toString(16).padStart(2, "0"),
        };
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            cashu: {
              mints: ["https://mint.example"],
              lock_pubkeys: [advertisedRetiredPubkey],
              min_locktime: 604800,
              canonical_id: matching.canonical_dvm_id,
            },
          }),
          { status: 200 }
        )
      )
    );

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(clientCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dvmId: "dvm-matching",
        privkeyHex: advertisedRetiredPrivkey,
      })
    );
    expect(getPendingBatches).toHaveBeenCalled();
  });

  it("resolves the endpoint via getDvm when --endpoint is not supplied", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({ batches: [] });
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm: { url: "https://my-dvm.fly.dev" } as never,
      deploys: [],
      domains: [],
    });
    await meltPending("dvm", {});
    expect(platformClient.getDvm).toHaveBeenCalledWith("https://api.example", "t", "dvm-fixture-1");
  });

  it("errors with dvm_url_unset when getDvm returns null URL", async () => {
    setHappyPath();
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm: { url: null } as never,
      deploys: [],
      domains: [],
    });
    await expect(meltPending("dvm", {})).rejects.toMatchObject({
      code: "dvm_url_unset",
      hint: expect.stringContaining("dvmctl handle set"),
    });
  });

  it("keeps the deploy hint for a connect-tier DVM with no URL yet", async () => {
    setHappyPath();
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm: {
        url: null,
        endpointUrl: "https://dvm.example.com",
        dvmkitUrl: "https://builder--dvm.example.com",
      } as never,
      deploys: [],
      domains: [],
    });
    const err = await meltPending("dvm", {}).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "dvm_url_unset",
      hint: expect.stringContaining("wait for the deploy"),
    });
    expect((err as { hint: string }).hint).not.toContain("handle set");
  });

  it("skips batches whose lock_pubkey isn't in the walked 0..current_rotation_index range", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: "02" + "ff".repeat(32),
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 10, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 10,
          t_expire: null,
        },
      ],
    });
    await meltPending("dvm", { endpoint: "https://dvm.example" });
    const summary = vi.mocked(output.json).mock.calls[0][0] as {
      batches_skipped: number;
      dvmId: string;
      slug: string;
    };
    expect(summary.batches_skipped).toBe(1);
    expect(summary.dvmId).toBe("dvm-fixture-1");
    expect(summary.slug).toBe("dvm");
    expect(lnurl.fetchLnurlPayInvoice).not.toHaveBeenCalled();
  });

  it("melts a batch locked to a retired pubkey via the rotation walker", async () => {
    // current_rotation_index = 1, so the walker derives keypairs at indices 0
    // and 1. The batch is locked to the index-0 pubkey (now retired); the
    // walker picks up the matching privkey and melts as usual. Admin auth
    // still uses the current (index-1) privkey.
    const RETIRED_PRIVKEY = "22".repeat(32);
    const RETIRED_PUBKEY = "02" + "bb".repeat(32);
    const CURRENT_PRIVKEY = "33".repeat(32);
    const CURRENT_PUBKEY = "02" + "cc".repeat(32);
    vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue("m");
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "dvm",
      canonical_dvm_id: "dvm-fixture-1",
      current_rotation_index: 1,
      payout_ln_address: "alice@example.com",
      updated_at: "2026-05-01",
    });
    vi.mocked(builderSubkey.deriveBuilderLockKeypair).mockImplementation(
      (_mnemonic: string, _id: string, idx: number) =>
        idx === 0
          ? { privkey: RETIRED_PRIVKEY, pubkey: RETIRED_PUBKEY }
          : { privkey: CURRENT_PRIVKEY, pubkey: CURRENT_PUBKEY }
    );
    vi.mocked(platform.requireAuth).mockReturnValue({
      token: "t",
      platformUrl: "https://api.example",
    });

    const getPendingBatches = vi.fn().mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: RETIRED_PUBKEY,
          row_ids: ["r1"],
          proofs: [
            {
              id: "k",
              amount: 60,
              secret: "s",
              C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
              dleq: { e: "1212121212121212121212121212121212121212121212121212121212121212", s: "1212121212121212121212121212121212121212121212121212121212121212", r: "1212121212121212121212121212121212121212121212121212121212121212" },
            },
          ],
          total_sats: 60,
          t_expire: null,
        },
      ],
    });
    const markMelted = vi.fn().mockResolvedValue({ melted: 1 });
    clientCtorSpy.mockReturnValue({ getPendingBatches, markMelted, ...emptyDrainSurface() });

    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 60,
      feeReserveSats: 0,
      rawQuote: { quote: "q-retired", amount: 60, fee_reserve: 0, unit: "sat" } as never,
    });
    const meltProofsBolt11 = vi
      .fn()
      .mockResolvedValue({ quote: { state: "PAID", payment_preimage: "preimage-retired" }, change: [] });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    // The melt witness uses the retired-index privkey (matches batch.lock_pubkey).
    expect(meltProofsBolt11).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([expect.objectContaining({ secret: "s" })]),
      expect.objectContaining({ privkey: RETIRED_PRIVKEY })
    );
    // The admin-client constructor uses the CURRENT privkey for challenge signing.
    expect(clientCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ privkeyHex: CURRENT_PRIVKEY })
    );
    expect(markMelted).toHaveBeenCalledWith({
      row_ids: ["r1"],
      melt_quote_id: "q-retired",
      payment_preimage: "preimage-retired",
    });
  });

  it("melts a matching batch end-to-end and posts mark-melted", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [
            {
              id: "k",
              amount: 60,
              secret: "s",
              C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
              dleq: { e: "1212121212121212121212121212121212121212121212121212121212121212", s: "1212121212121212121212121212121212121212121212121212121212121212", r: "1212121212121212121212121212121212121212121212121212121212121212" },
            },
          ],
          total_sats: 60,
          t_expire: null,
        },
      ],
    });
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 60,
      feeReserveSats: 0,
      rawQuote: { quote: "q1", amount: 60, fee_reserve: 0, unit: "sat" } as never,
    });
    const meltProofsBolt11 = vi.fn().mockImplementation((_quote, proofs) => {
      if (!proofs.every((proof: { dleq?: unknown }) => proof.dleq)) {
        throw new Error("panic mode requires DLEQ data for every input");
      }
      return Promise.resolve({ quote: { state: "PAID", payment_preimage: "preimage123" }, change: [] });
    });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);
    markMelted.mockResolvedValue({ melted: 1 });

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(meltProofsBolt11).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          secret: "s",
          dleq: { e: "1212121212121212121212121212121212121212121212121212121212121212", s: "1212121212121212121212121212121212121212121212121212121212121212", r: "1212121212121212121212121212121212121212121212121212121212121212" },
        }),
      ]),
      expect.objectContaining({ privkey: PRIVKEY })
    );
    expect(markMelted).toHaveBeenCalledWith({
      row_ids: ["r1"],
      melt_quote_id: "q1",
      payment_preimage: "preimage123",
    });
    expect(meltLog.appendPreMelt).toHaveBeenCalled();
    expect(meltLog.appendPostMelt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", preimage: "preimage123" })
    );
  });

  it("counts an uncertain melt failure without closing recovery and preserves its diagnostic", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 60, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 60,
          t_expire: null,
        },
      ],
    });
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 60,
      feeReserveSats: 0,
      rawQuote: { quote: "q1", amount: 60, fee_reserve: 0, unit: "sat" } as never,
    });
    const meltProofsBolt11 = vi
      .fn()
      .mockRejectedValue(new Error("panic mode requires DLEQ data for every input"));
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);

    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "batches_failed",
    });
    expect(markMelted).not.toHaveBeenCalled();
    expect(meltLog.appendPostMelt).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("\n")).toContain(
      "The NUT-11 key can authorize the spend but cannot recreate DLEQ"
    );
  });

  it("exits with admin_bad_signature when the DVM rejects our signature", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockRejectedValue(
      new AdminApiError(401, {
        error: "unauthorized",
        reason: "bad_signature",
        raw: {},
      })
    );
    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "admin_bad_signature",
    });
  });

  it("exits with actionable admin_state_unavailable guidance", async () => {
    const { getPendingDrains } = setHappyPath();
    getPendingDrains.mockRejectedValue(
      new DvmError(
        "admin_state_unavailable",
        "The requested DVM operation did not run.",
        "Retry, then inspect database health."
      )
    );

    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "admin_state_unavailable",
      hint: "Retry, then inspect database health.",
    });
  });

  it("recovery: forwards a PAID quote's preimage to mark-melted without re-melting", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({ batches: [] });
    vi.mocked(meltLog.readInFlight).mockReturnValue([
      {
        ts: 1,
        dvmId: "dvm-fixture-1",
        rowIds: ["r1"],
        mintUrl: "https://mint",
        quoteId: "q1",
        lockPubkey: PUBKEY,
        totalSats: 60,
      },
    ]);
    vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
      state: "PAID",
      payment_preimage: "pre123",
    } as never);
    markMelted.mockResolvedValue({ melted: 1 });

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(markMelted).toHaveBeenCalledWith({
      row_ids: ["r1"],
      melt_quote_id: "q1",
      payment_preimage: "pre123",
    });
    expect(meltLog.appendPostMelt).toHaveBeenCalledWith(
      expect.objectContaining({ status: "success", preimage: "pre123" })
    );
    const summary = vi.mocked(output.json).mock.calls[0][0] as { recovered: number };
    expect(summary.recovered).toBe(1);
    expect(wallet.getWallet).not.toHaveBeenCalled();
    expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
  });

  it("recovery: keeps an UNPAID quote held for a possibly outstanding submission", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({ batches: [] });
    vi.mocked(meltLog.readInFlight).mockReturnValue([
      {
        ts: 1,
        dvmId: "dvm-fixture-1",
        rowIds: ["r1"],
        mintUrl: "https://mint",
        quoteId: "q1",
        lockPubkey: PUBKEY,
        totalSats: 60,
      },
    ]);
    vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
      state: "UNPAID",
      payment_preimage: null,
    } as never);

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(meltLog.appendPostMelt).not.toHaveBeenCalled();
  });

  it("leaves entry in-flight (no post-melt) when mark-melted fails after a successful melt", async () => {
    // Failure mode the reviewer flagged: appending a `post_melt success`
    // closes the pair and strands the preimage on the next run. The fix
    // leaves the pre-melt unpaired so recovery handles it.
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 60, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 60,
          t_expire: null,
        },
      ],
    });
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 60,
      feeReserveSats: 0,
      rawQuote: { quote: "q1", amount: 60, fee_reserve: 0, unit: "sat" } as never,
    });
    const meltProofsBolt11 = vi
      .fn()
      .mockResolvedValue({ quote: { state: "PAID", payment_preimage: "preimage123" }, change: [] });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);
    markMelted.mockRejectedValue(new Error("DVM unreachable"));

    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "batches_failed",
    });

    expect(meltLog.appendPreMelt).toHaveBeenCalledTimes(1);
    // Critical: no post-melt is appended — entry stays in-flight for recovery.
    expect(meltLog.appendPostMelt).not.toHaveBeenCalled();
  });

  it("recovery: keeps PAID-without-preimage entry in-flight (mint protocol violation)", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({ batches: [] });
    vi.mocked(meltLog.readInFlight).mockReturnValue([
      {
        ts: 1,
        dvmId: "dvm-fixture-1",
        rowIds: ["r1"],
        mintUrl: "https://mint",
        quoteId: "q1",
        lockPubkey: PUBKEY,
        totalSats: 60,
      },
    ]);
    vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
      state: "PAID",
      payment_preimage: null,
    } as never);

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(markMelted).not.toHaveBeenCalled();
    // No post-melt → entry stays in-flight for subsequent recovery attempts.
    expect(meltLog.appendPostMelt).not.toHaveBeenCalled();
  });

  it("defers a pending melt without declaring the batch failed", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 60, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 60,
          t_expire: null,
        },
      ],
    });
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 60,
      feeReserveSats: 0,
      rawQuote: { quote: "q1", amount: 60, fee_reserve: 0, unit: "sat" } as never,
    });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWallet( vi.fn().mockResolvedValue({
        quote: { state: "PENDING", payment_preimage: null },
        change: [],
      }),
    ) as never);

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(meltLog.appendPreMelt).toHaveBeenCalledTimes(1);
    expect(meltLog.appendPostMelt).not.toHaveBeenCalled();
    expect(markMelted).not.toHaveBeenCalled();
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
      batches_skipped: 1,
      batches_failed: 0,
    });
  });

  it("does not submit pending proofs to a second quote, and alarms after a day", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 60, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 60,
          t_expire: null,
        },
      ],
    });
    vi.mocked(meltLog.readInFlight).mockReturnValue([
      {
        ts: Date.now() - 60 * 60 * 1000,
        dvmId: "dvm-fixture-1",
        rowIds: ["r1"],
        mintUrl: "https://mint",
        quoteId: "q1",
        lockPubkey: PUBKEY,
        totalSats: 60,
      },
    ]);
    vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
      state: "PENDING",
      payment_preimage: null,
    } as never);

    await meltPending("dvm", { endpoint: "https://dvm.example" });
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
      batches_skipped: 1,
      batches_failed: 0,
    });
    expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
    expect(lnurl.fetchLnurlPayInvoice).not.toHaveBeenCalled();
    expect(wallet.getWallet).not.toHaveBeenCalled();

    vi.mocked(meltLog.readInFlight).mockReturnValue([
      {
        ts: Date.now() - 25 * 60 * 60 * 1000,
        dvmId: "dvm-fixture-1",
        rowIds: ["r1"],
        mintUrl: "https://mint",
        quoteId: "q1",
        lockPubkey: PUBKEY,
        totalSats: 60,
      },
    ]);
    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "batches_failed",
    });
    expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
  });

  it("retries with a smaller invoice when the first quote needs more than the batch (two-pass)", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 152, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 152,
          t_expire: null,
        },
      ],
    });
    // First call: invoice for 152 sats; mint quotes amountSats=152 + 2 fee
    // = 154 > batch, triggers retry. Second call: invoice for 150 sats; mint
    // quotes amountSats=150 + 2 fee = 152 = batch, fits.
    vi.mocked(lnurl.fetchLnurlPayInvoice)
      .mockResolvedValueOnce("lnbc-pass1")
      .mockResolvedValueOnce("lnbc-pass2");
    vi.mocked(melt.fetchMeltQuote)
      .mockResolvedValueOnce({
        amountSats: 152,
        feeReserveSats: 2,
        rawQuote: { quote: "q-pass1", amount: 152, fee_reserve: 2, unit: "sat" } as never,
      })
      .mockResolvedValueOnce({
        amountSats: 150,
        feeReserveSats: 2,
        rawQuote: { quote: "q-pass2", amount: 150, fee_reserve: 2, unit: "sat" } as never,
      });
    const meltProofsBolt11 = vi
      .fn()
      .mockResolvedValue({ quote: { state: "PAID", payment_preimage: "preimage-twopass" }, change: [] });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);
    markMelted.mockResolvedValue({ melted: 1 });

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    // Both LNURL calls fired with the expected msat amounts.
    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).toHaveBeenNthCalledWith(
      1,
      "alice@example.com",
      152_000
    );
    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).toHaveBeenNthCalledWith(
      2,
      "alice@example.com",
      150_000
    );
    // Melt proceeds using the second (fitting) quote.
    expect(markMelted).toHaveBeenCalledWith({
      row_ids: ["r1"],
      melt_quote_id: "q-pass2",
      payment_preimage: "preimage-twopass",
    });
    const summary = vi.mocked(output.json).mock.calls[0][0] as { batches_melted: number };
    expect(summary.batches_melted).toBe(1);
  });

  it("skips when the second-pass quote still demands more than the batch", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 50, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 50,
          t_expire: null,
        },
      ],
    });
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    // First quote needs 50 + 5 = 55; retry. Second quote on a 45-sat invoice
    // still needs 45 + 6 = 51 (mint's fee_reserve actually grew on the
    // smaller invoice). Skipped.
    vi.mocked(melt.fetchMeltQuote)
      .mockResolvedValueOnce({
        amountSats: 50,
        feeReserveSats: 5,
        rawQuote: { quote: "q-pass1", amount: 50, fee_reserve: 5, unit: "sat" } as never,
      })
      .mockResolvedValueOnce({
        amountSats: 45,
        feeReserveSats: 6,
        rawQuote: { quote: "q-pass2", amount: 45, fee_reserve: 6, unit: "sat" } as never,
      });

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    const summary = vi.mocked(output.json).mock.calls[0][0] as {
      batches_skipped: number;
      batches_failed: number;
    };
    expect(summary.batches_skipped).toBe(1);
    expect(summary.batches_failed).toBe(0);
    expect(meltLog.appendPreMelt).not.toHaveBeenCalled();
  });

  it("subtracts mint input_fees from the invoice amount up front", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1", "r2"],
          proofs: [
            { id: "k", amount: 100, secret: "s1", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" },
            { id: "k", amount: 52, secret: "s2", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" },
          ],
          total_sats: 152,
          t_expire: null,
        },
      ],
    });
    // Mint charges 3 sats of input fees on this proof set.
    vi.mocked(melt.getInputFeesForProofs).mockResolvedValue(3);
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc-input-fee");
    // Invoice for 152 - 3 = 149 sats. Quote claims amount=149, fee_reserve=0.
    // Guard: 152 >= 149 + 0 + 3 = 152 — fits on first pass.
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 149,
      feeReserveSats: 0,
      rawQuote: { quote: "q-input-fee", amount: 149, fee_reserve: 0, unit: "sat" } as never,
    });
    const meltProofsBolt11 = vi
      .fn()
      .mockResolvedValue({ quote: { state: "PAID", payment_preimage: "preimage-input-fee" }, change: [] });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);
    markMelted.mockResolvedValue({ melted: 1 });

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).toHaveBeenCalledWith(
      "alice@example.com",
      149_000
    );
    expect(markMelted).toHaveBeenCalledWith({
      row_ids: ["r1", "r2"],
      melt_quote_id: "q-input-fee",
      payment_preimage: "preimage-input-fee",
    });
  });

  /**
   * Every Bitcoin deposit converges on the hub. A self-hosted node has no Lightning address to resolve — so the melt has to
   * be able to ask the destination wallet for its own invoice. Routing
   * first-party receipts through a hosted address to get one would put a
   * vendor back in the money path, which is the thing the hub exists to avoid.
   */
  it("mints the payout invoice from the destination wallet when one is named", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 100, secret: "s1", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 100,
          t_expire: null,
        },
      ],
    });
    vi.mocked(nwcModule.makeInvoice).mockResolvedValue({
      type: "incoming",
      invoice: "lnbc-from-hub",
      paymentHash: "aa".repeat(32),
      amountMsats: 100_000,
      createdAt: 1,
    });
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 100,
      feeReserveSats: 0,
      rawQuote: { quote: "q-hub", amount: 100, fee_reserve: 0, unit: "sat" } as never,
    });
    const meltProofsBolt11 = vi
      .fn()
      .mockResolvedValue({ quote: { state: "PAID", payment_preimage: "preimage-hub" }, change: [] });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);
    markMelted.mockResolvedValue({ melted: 1 });

    await meltPending("dvm", {
      endpoint: "https://dvm.example",
      payoutNwc: `nostr+walletconnect://${"ab".repeat(32)}?relay=wss://r.example&secret=${"cd".repeat(32)}`,
    });

    expect(vi.mocked(nwcModule.makeInvoice)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amountMsats: 100_000 })
    );
    // The wallet wins over the address: an operator who named it meant the
    // melt to land there, and melting to the address instead is the mistake
    // worth being loud about rather than falling back on.
    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).not.toHaveBeenCalled();
    expect(markMelted).toHaveBeenCalledWith({
      row_ids: ["r1"],
      melt_quote_id: "q-hub",
      payment_preimage: "preimage-hub",
    });
  });

  it("refuses a payout wallet URI it cannot read rather than melting to the address instead", async () => {
    setHappyPath();
    await expect(
      meltPending("dvm", { endpoint: "https://dvm.example", payoutNwc: "not-a-uri" })
    ).rejects.toThrow(expect.objectContaining({ code: "invalid_payout_nwc" }));
    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).not.toHaveBeenCalled();
  });

  it("skips when input_fees alone meet or exceed the batch", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 2, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 2,
          t_expire: null,
        },
      ],
    });
    vi.mocked(melt.getInputFeesForProofs).mockResolvedValue(3);

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).not.toHaveBeenCalled();
    const summary = vi.mocked(output.json).mock.calls[0][0] as { batches_skipped: number };
    expect(summary.batches_skipped).toBe(1);
  });

  it("skips when fee_reserve alone meets or exceeds the batch (no second pass)", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 3, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 3,
          t_expire: null,
        },
      ],
    });
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    // Mint's fee_reserve (5) >= batch (3); target = -2 invalid, skip without
    // a second LNURL call.
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 3,
      feeReserveSats: 5,
      rawQuote: { quote: "q1", amount: 3, fee_reserve: 5, unit: "sat" } as never,
    });

    await meltPending("dvm", { endpoint: "https://dvm.example" });

    expect(vi.mocked(lnurl.fetchLnurlPayInvoice)).toHaveBeenCalledTimes(1);
    const summary = vi.mocked(output.json).mock.calls[0][0] as { batches_skipped: number };
    expect(summary.batches_skipped).toBe(1);
  });

  it("leaves entry in-flight (no post-melt) when the mint returns PAID without a preimage", async () => {
    const { getPendingBatches, markMelted } = setHappyPath();
    getPendingBatches.mockResolvedValue({
      batches: [
        {
          mint_url: "https://mint",
          lock_pubkey: PUBKEY,
          row_ids: ["r1"],
          proofs: [{ id: "k", amount: 60, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
          total_sats: 60,
          t_expire: null,
        },
      ],
    });
    vi.mocked(lnurl.fetchLnurlPayInvoice).mockResolvedValue("lnbc...");
    vi.mocked(melt.fetchMeltQuote).mockResolvedValue({
      amountSats: 60,
      feeReserveSats: 0,
      rawQuote: { quote: "q1", amount: 60, fee_reserve: 0, unit: "sat" } as never,
    });
    const meltProofsBolt11 = vi
      .fn()
      .mockResolvedValue({ quote: { state: "PAID", payment_preimage: null }, change: [] });
    vi.mocked(wallet.getWallet).mockResolvedValue(payoutWalletFixture(meltProofsBolt11) as never);

    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "batches_failed",
    });

    expect(markMelted).not.toHaveBeenCalled();
    expect(meltLog.appendPostMelt).not.toHaveBeenCalled();
  });

  it("throws pending_batches_fetch_failed when the admin endpoint errors (non-bad-signature)", async () => {
    const { getPendingBatches } = setHappyPath();
    getPendingBatches.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
      code: "pending_batches_fetch_failed",
    });
    // No misleading `batches_failed: 1` summary surfaces.
    expect(output.json).not.toHaveBeenCalled();
  });

  describe("--acknowledge-stuck", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const BATCH: AdminBatch = {
      mint_url: "https://mint",
      lock_pubkey: PUBKEY,
      row_ids: ["r1"],
      proofs: [{ id: "k", amount: 60, secret: "s", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }],
      total_sats: 60,
      t_expire: null,
    };
    function stuck(ageMs: number, acknowledged = true) {
      return {
        ts: Date.now() - ageMs,
        dvmId: "dvm-fixture-1",
        rowIds: ["r1"],
        mintUrl: "https://mint",
        quoteId: "q1",
        lockPubkey: PUBKEY,
        totalSats: 60,
        ...(acknowledged ? { acknowledged: { ts: Date.now() - 1000, reason: "mint ticket open" } } : {}),
      };
    }
    function loggedLevels(spy: { mock: { calls: unknown[][] } }): string[] {
      return spy.mock.calls.map(([line]) => (JSON.parse(String(line)) as { level: string }).level);
    }

    it("holds an acknowledged stale melt without failing the run or re-melting its rows", async () => {
      const { getPendingBatches } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [BATCH] });
      vi.mocked(meltLog.readInFlight).mockReturnValue([stuck(3 * DAY_MS)]);
      vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({ state: "PENDING" } as never);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      await meltPending("dvm", { endpoint: "https://dvm.example" });

      expect(melt.checkMeltQuoteState).toHaveBeenCalledWith("https://mint", "q1");
      expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
      expect(wallet.getWallet).not.toHaveBeenCalled();
      expect(loggedLevels(log)).toContain("melt_pending_batch_acknowledged");
      expect(loggedLevels(log)).not.toContain("melt_pending_batch_in_flight");
      const ackLine = log.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((line) => line.level === "melt_pending_batch_acknowledged");
      expect(ackLine).toMatchObject({ quote_id: "q1", reason: "mint ticket open" });
      expect(ackLine?.age_ms).toBeGreaterThanOrEqual(3 * DAY_MS);
      expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
        batches_failed: 0,
        acknowledged_melts: 1,
        acknowledged_sats: 60,
      });
      expect(meltSuccessState.recordMeltSuccess).toHaveBeenCalled();
    });

    it("still fails the run for an unacknowledged melt past the alarm beside an acknowledged one", async () => {
      const { getPendingBatches } = setHappyPath();
      getPendingBatches.mockResolvedValue({
        batches: [BATCH, { ...BATCH, row_ids: ["r2"], proofs: [{ id: "k", amount: 60, secret: "s2", C: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" }] }],
      });
      vi.mocked(meltLog.readInFlight).mockReturnValue([
        stuck(3 * DAY_MS),
        { ...stuck(2 * DAY_MS, false), rowIds: ["r2"], quoteId: "q2" },
      ]);
      vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({ state: "PENDING" } as never);
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
        code: "batches_failed",
      });
      expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
    });

    it("keeps alarming on an acknowledged quote the mint paid while mark-melted keeps failing", async () => {
      const { getPendingBatches, markMelted } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [BATCH] });
      markMelted.mockRejectedValue(new Error("DVM unreachable"));
      vi.mocked(meltLog.readInFlight).mockReturnValue([stuck(3 * DAY_MS)]);
      vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
        state: "PAID",
        payment_preimage: "pre123",
      } as never);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
        code: "batches_failed",
      });
      expect(loggedLevels(log)).not.toContain("melt_pending_batch_acknowledged");
      expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
      expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({ acknowledged_melts: 0 });
    });

    it("keeps alarming on an acknowledged quote once the mint stops answering", async () => {
      const { getPendingBatches } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [BATCH] });
      vi.mocked(meltLog.readInFlight).mockReturnValue([stuck(3 * DAY_MS)]);
      vi.mocked(melt.checkMeltQuoteState).mockRejectedValue(new Error("mint unreachable"));
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
        code: "batches_failed",
      });
      expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
    });

    it("recovers an acknowledged quote the mint later reports PAID", async () => {
      const { getPendingBatches, markMelted } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      markMelted.mockResolvedValue({ melted: 1 });
      vi.mocked(meltLog.readInFlight).mockReturnValue([stuck(3 * DAY_MS)]);
      vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
        state: "PAID",
        payment_preimage: "pre123",
      } as never);

      await meltPending("dvm", { endpoint: "https://dvm.example" });

      expect(markMelted).toHaveBeenCalledWith({
        row_ids: ["r1"],
        melt_quote_id: "q1",
        payment_preimage: "pre123",
      });
      expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
        recovered: 1,
        acknowledged_melts: 0,
        acknowledged_sats: 0,
      });
    });

    it("holds an acknowledged quote without alarming when the mint later reports UNPAID", async () => {
      const { getPendingBatches, markMelted } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [BATCH] });
      markMelted.mockResolvedValue({ melted: 1 });
      vi.mocked(meltLog.readInFlight).mockReturnValue([stuck(3 * DAY_MS)]);
      vi.mocked(melt.checkMeltQuoteState).mockResolvedValue({
        state: "UNPAID",
        payment_preimage: null,
      } as never);
      await meltPending("dvm", { endpoint: "https://dvm.example" });

      expect(meltLog.appendPostMelt).not.toHaveBeenCalled();
      expect(markMelted).not.toHaveBeenCalled();
      expect(melt.fetchMeltQuote).not.toHaveBeenCalled();
      expect(wallet.getWallet).not.toHaveBeenCalled();
      expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
        batches_melted: 0,
        batches_failed: 0,
        acknowledged_melts: 1,
      });
    });

    it("appends an acknowledgement for a stale in-flight quote without sweeping", async () => {
      const { getPendingBatches } = setHappyPath();
      vi.mocked(meltLog.lookupMeltQuote).mockReturnValue({
        state: "in_flight",
        entry: stuck(2 * DAY_MS, false),
      });

      await meltPending("dvm", {
        endpoint: "https://dvm.example",
        acknowledgeStuck: "q1",
        reason: "  mint ticket open  ",
      });

      expect(meltLog.lookupMeltQuote).toHaveBeenCalledWith("dvm-fixture-1", "q1");
      expect(meltLog.appendAcknowledgement).toHaveBeenCalledExactlyOnceWith({
        dvm_id: "dvm-fixture-1",
        acknowledged_quote_id: "q1",
        reason: "mint ticket open",
      });
      expect(output.json).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledged: true, quote_id: "q1", total_sats: 60 })
      );
      expect(clientCtorSpy).not.toHaveBeenCalled();
      expect(getPendingBatches).not.toHaveBeenCalled();
      expect(melt.checkMeltQuoteState).not.toHaveBeenCalled();
      expect(meltSuccessState.recordMeltSuccess).not.toHaveBeenCalled();
    });

    it.each([
      ["an unknown quote", { state: "unknown" }, "melt_quote_not_found"],
      ["a resolved quote", { state: "resolved" }, "melt_quote_resolved"],
      [
        "a quote younger than the alarm window",
        { state: "in_flight", entry: stuck(DAY_MS - 60_000, false) },
        "melt_quote_too_young",
      ],
    ] as const)("refuses to acknowledge %s and leaves the journal alone", async (_label, found, code) => {
      setHappyPath();
      vi.mocked(meltLog.lookupMeltQuote).mockReturnValue(found as never);

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", acknowledgeStuck: "q1", reason: "stuck" })
      ).rejects.toMatchObject({ code, hint: expect.stringMatching(/\S/) });
      expect(meltLog.appendAcknowledgement).not.toHaveBeenCalled();
    });

    it("refuses an acknowledgement combined with --watch before reading the journal", async () => {
      setHappyPath();
      await expect(
        meltPending("dvm", {
          endpoint: "https://dvm.example",
          acknowledgeStuck: "q1",
          reason: "stuck",
          watch: true,
        })
      ).rejects.toMatchObject({ code: "acknowledge_conflicting_flags" });
      expect(meltLog.lookupMeltQuote).not.toHaveBeenCalled();
      expect(meltLog.appendAcknowledgement).not.toHaveBeenCalled();
    });

    it("refuses an acknowledgement without a reason before reading the journal", async () => {
      setHappyPath();
      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", acknowledgeStuck: "q1", reason: "  " })
      ).rejects.toMatchObject({ code: "acknowledge_reason_required" });
      expect(meltLog.lookupMeltQuote).not.toHaveBeenCalled();
      expect(meltLog.appendAcknowledgement).not.toHaveBeenCalled();
    });
  });

  /**
   * `--drains-only` pays the refunds owed to callers and stops. The
   * summary has to read *skipped by configuration* — a zero-melt tick that
   * looked like a failure, or like the drain hold, would send an operator
   * chasing a payout that was never meant to run.
   */
  describe("--drains-only", () => {
    it("services drains and never fetches batches", async () => {
      const { getPendingBatches } = setHappyPath();
      await meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true });

      const client = clientCtorSpy.mock.results[0].value as {
        getPendingDrains: ReturnType<typeof vi.fn>;
      };
      expect(client.getPendingDrains).toHaveBeenCalled();
      expect(getPendingBatches).not.toHaveBeenCalled();
      expect(lnurl.fetchLnurlPayInvoice).not.toHaveBeenCalled();
    });

    it("reports the skip as configuration, distinct from a hold or a failure", async () => {
      setHappyPath();
      await meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true });

      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        melt_skipped: string | null;
        melt_held: boolean;
        batches_seen: number;
        batches_failed: number;
      };
      expect(summary).toMatchObject({
        melt_skipped: "drains_only",
        melt_held: false,
        batches_seen: 0,
        batches_failed: 0,
      });
    });

    it("needs no payout address — nothing melts, so requiring one would be a lie", async () => {
      setHappyPath();
      vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
        handle: "dvm",
        canonical_dvm_id: "dvm-fixture-1",
        current_rotation_index: 0,
        updated_at: "2026-05-01",
      });
      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true })
      ).resolves.toBeUndefined();
    });

    it("leaves melt_skipped null on a normal sweep", async () => {
      const { getPendingBatches } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      await meltPending("dvm", { endpoint: "https://dvm.example" });

      const summary = vi.mocked(output.json).mock.calls[0][0] as { melt_skipped: string | null };
      expect(summary.melt_skipped).toBeNull();
    });

    it("exits non-zero when a drain goes unsettled — batches_failed can't carry this run", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] }); // nothing covers the refund
      withPendingCashuDrain(getPendingDrains);

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true })
      ).rejects.toThrow(expect.objectContaining({ code: "drains_unsettled" }));

      // The summary still prints: the operator needs the counters, not just a code.
      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        drains_queued: number;
        batches_failed: number;
      };
      // `queued` rather than `failed` — nothing covered the refund and no send
      // wallet was wired to buy one, so nothing was attempted. The
      // exit code is unchanged: this mode owes the caller either way.
      expect(summary).toMatchObject({ drains_queued: 1, batches_failed: 0 });
    });

    /**
     * A stablecoin refund moves no failure counter either, and no flag will
     * ever settle it — the exit code is the only thing that keeps a cron from
     * reading "settled everything it could" as "settled everything".
     */
    it("exits non-zero on a refund only a person can settle, naming the verb", async () => {
      const { getPendingDrains } = setHappyPath();
      withPendingStablecoinDrain(getPendingDrains);

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true })
      ).rejects.toThrow(
        expect.objectContaining({
          code: "drains_unsettled",
          hint: expect.stringContaining("dvmctl credit drains-owed"),
        })
      );

      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        drains_manual: number;
        drains_failed: number;
        drains_seen: number;
      };
      expect(summary).toMatchObject({
        drains_seen: 1,
        drains_manual: 1,
        drains_failed: 0,
      });
    });

    /**
     * The counterpart to the case above: same rail, same `pending` status, but
     * the channel's own close settles it. A non-zero exit here would page an
     * operator every tick for something they cannot act on — the reason
     * `drains_channel` is counted outside the unsettled buckets.
     */
    it("exits clean on a channel-backed reclaim nobody has to settle", async () => {
      const { getPendingDrains } = setHappyPath();
      withPendingChannelDrain(getPendingDrains);

      await meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true });

      expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
        drains_seen: 1,
        drains_channel: 1,
        drains_manual: 0,
        drains_failed: 0,
      });
    });

    /**
     * A DVM whose admin surface is down reports zeros for every drain counter,
     * so the counters cannot distinguish "nothing owed" from "never asked".
     * `drain_state_known` is what carries that, and it has to reach the exit
     * code or a cron reads a total outage as a clean run.
     */
    it("exits non-zero when the pending-drain fetch failed — zeros aren't an answer", async () => {
      const { getPendingDrains } = setHappyPath();
      getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true })
      ).rejects.toThrow(expect.objectContaining({ code: "drain_state_unknown" }));

      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        drain_state_known: boolean;
        drains_seen: number;
      };
      expect(summary).toMatchObject({ drain_state_known: false, drains_seen: 0 });
    });

    /**
     * Recovery replays the local park log *before* the fetch, so an
     * unknown-state tick can still have settled a refund. An error that flatly
     * claimed nothing settled would contradict the `drains_recovered: 1` the
     * same run just printed.
     */
    it("names the recovered park in the unknown-state error instead of claiming nothing settled", async () => {
      const { getPendingDrains } = setHappyPath();
      vi.mocked(drainParkLog.readUnparked).mockReturnValue([
        {
          kind: "swapped",
          ts: 1,
          dvm_id: "dvm-fixture-1",
          credit_id: "c1",
          drain_id: "d1",
          token: "cashuA-token",
          consumed_row_ids: ["row-1"],
          keep_proofs: [],
        },
      ]);
      getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true })
      ).rejects.toThrow(
        expect.objectContaining({
          code: "drain_state_unknown",
          message: expect.stringContaining("only the 1 park(s) replayed from the local log"),
        })
      );

      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        drains_recovered: number;
        drain_state_known: boolean;
      };
      expect(summary).toMatchObject({ drains_recovered: 1, drain_state_known: false });
    });

    it("stays green when there is nothing owed — drain_state_known says so", async () => {
      setHappyPath();
      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true })
      ).resolves.toBeUndefined();

      const summary = vi.mocked(output.json).mock.calls[0][0] as { drain_state_known: boolean };
      expect(summary.drain_state_known).toBe(true);
    });

    it("leaves a normal sweep exiting 0 on the same drain — it parks on a later tick", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      withPendingCashuDrain(getPendingDrains);

      // Deliberate asymmetry: the daily melter must not alarm on a healthy DVM
      // whose refund is merely waiting on accumulation.
      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example" })
      ).resolves.toBeUndefined();
    });

    it("leaves a normal sweep exiting 0 on an unreachable drain surface too", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));

      // Same asymmetry: the sweep holds the melt back (`melt_held`) rather than
      // failing, because a payout that runs blind to owed refunds is the bug —
      // not the run itself.
      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example" })
      ).resolves.toBeUndefined();

      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        melt_held: boolean;
        drain_state_known: boolean;
      };
      expect(summary).toMatchObject({ melt_held: true, drain_state_known: false });
    });
  });

  /**
   * The melt hold is the right answer to an unreadable drain surface
   * and the wrong answer to a rejected signature — and, given enough time, the
   * wrong answer to either. These pin the three-way split: fail now on a
   * configuration fault, hold then fail on a stall, hold forever on a healthy
   * DVM whose refund is merely waiting on accumulation.
   */
  /**
   * A melt job is almost always run by a scheduler, and every
   * scheduler dies the same silent way: no exit code anyone reads, no growing
   * log, no next run. The stamp a clean run leaves is the only trace of that,
   * which makes *when it is withheld* as load-bearing as when it is written.
   */
  describe("the liveness record a clean run leaves behind", () => {
    it("stamps the run, keyed by canonical DVM id, with what it moved", async () => {
      const { getPendingBatches } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });

      await meltPending("dvm", { endpoint: "https://dvm.example" });

      expect(meltSuccessState.recordMeltSuccess).toHaveBeenCalledWith("dvm-fixture-1", "sweep", {
        handle: "dvm",
        batches_melted: 0,
        sats_melted: 0,
        drains_parked: 0,
      });
    });

    it("withholds the stamp when the run exits non-zero", async () => {
      // Otherwise a melter failing every night for a fortnight would keep
      // refreshing its own proof of life — which is exactly the 15 days of
      // failed melts nobody was told about.
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(drainHoldState.recordDrainState).mockReturnValue(
        new Date(Date.now() - 30 * 3_600_000).toISOString()
      );

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", holdAlarmAfter: "24h" })
      ).rejects.toMatchObject({ code: "drain_state_unknown_sustained" });

      expect(meltSuccessState.recordMeltSuccess).not.toHaveBeenCalled();
    });

    it("stamps a --drains-only run under its own mode, never the sweep's", async () => {
      // `docs/sdk.md` recommends a `--watch` sweep daemon *and* a drains-only
      // cron. One shared clock would let the hourly cron vouch for a payout
      // daemon that died weeks ago.
      setHappyPath();

      await meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true });

      expect(meltSuccessState.recordMeltSuccess).toHaveBeenCalledWith(
        "dvm-fixture-1",
        "drains_only",
        expect.objectContaining({ handle: "dvm", batches_melted: 0 })
      );
    });

    it("stamps under --watch too, which is the mode with no exit code at all", async () => {
      const { getPendingBatches } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      vi.useFakeTimers();
      try {
        void meltPending("dvm", { endpoint: "https://dvm.example", watch: true, interval: 10 });
        await vi.advanceTimersByTimeAsync(500);

        expect(meltSuccessState.recordMeltSuccess).toHaveBeenCalledWith(
          "dvm-fixture-1",
          "sweep",
          expect.objectContaining({ handle: "dvm" })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("says on stderr when a --watch tick is not recorded, since it cannot exit", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(drainHoldState.recordDrainState).mockReturnValue(
        new Date(Date.now() - 30 * 3_600_000).toISOString()
      );
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        void meltPending("dvm", {
          endpoint: "https://dvm.example",
          watch: true,
          interval: 10,
          holdAlarmAfter: "24h",
        });
        await vi.advanceTimersByTimeAsync(500);

        expect(meltSuccessState.recordMeltSuccess).not.toHaveBeenCalled();
        const line = stderr.mock.calls
          .map(([entry]) => JSON.parse(entry as string) as Record<string, unknown>)
          .find((entry) => entry.level === "melt_pending_tick_not_recorded");
        expect(line).toMatchObject({ code: "drain_state_unknown_sustained" });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the melt hold has a floor and a ceiling", () => {
    function badSignature(): AdminApiError {
      return new AdminApiError(401, { error: "unauthorized", reason: "bad_signature", raw: {} });
    }

    /** ISO timestamp `hours` in the past — the shape `recordDrainState` returns. */
    function unknownSince(hours: number): string {
      return new Date(Date.now() - hours * 3_600_000).toISOString();
    }

    it("exits admin_bad_signature when the drain fetch rejects our signature", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingDrains.mockRejectedValue(badSignature());

      // The hold short-circuits before the batch fetch, so this 401 is the only
      // one a mismatched lock pubkey ever gets to raise on a plain sweep.
      await expect(meltPending("dvm", { endpoint: "https://dvm.example" })).rejects.toMatchObject({
        code: "admin_bad_signature",
      });
      expect(getPendingBatches).not.toHaveBeenCalled();
      expect(output.json).not.toHaveBeenCalled();
    });

    it("exits admin_bad_signature under --drains-only too, not drain_state_unknown", async () => {
      const { getPendingDrains } = setHappyPath();
      getPendingDrains.mockRejectedValue(badSignature());

      // Both exit non-zero; only one names a cause the operator can act on.
      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", drainsOnly: true })
      ).rejects.toMatchObject({ code: "admin_bad_signature" });
    });

    it("records the unreadable surface so consecutive one-shot runs can add up", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(drainHoldState.recordDrainState).mockReturnValue(unknownSince(2));

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example" })
      ).resolves.toBeUndefined();

      expect(drainHoldState.recordDrainState).toHaveBeenCalledWith("dvm-fixture-1", false);
      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        drain_state_unknown_since: string | null;
      };
      expect(summary.drain_state_unknown_since).not.toBeNull();
    });

    it("exits non-zero once the surface has been unreadable past --hold-alarm-after", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));
      vi.mocked(drainHoldState.recordDrainState).mockReturnValue(unknownSince(30));

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", holdAlarmAfter: "24h" })
      ).rejects.toMatchObject({ code: "drain_state_unknown_sustained" });

      // Thrown after the summary, unlike the fetch-classification errors: the
      // counters are all the operator has to reason about a stalled DVM.
      expect(output.json).toHaveBeenCalledTimes(1);
    });

    it("clears the streak when the surface answers again", async () => {
      const { getPendingBatches } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", holdAlarmAfter: "1s" })
      ).resolves.toBeUndefined();

      expect(drainHoldState.recordDrainState).toHaveBeenCalledWith("dvm-fixture-1", true);
    });

    it("never alarms on a refund waiting on accumulation, however long it waits", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      getPendingBatches.mockResolvedValue({ batches: [] });
      withPendingCashuDrain(getPendingDrains);

      // A thin accumulator holds the melt too, and that DVM is working exactly
      // as designed — the ceiling is on an unreadable surface, nothing else.
      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", holdAlarmAfter: "1s" })
      ).resolves.toBeUndefined();

      const summary = vi.mocked(output.json).mock.calls[0][0] as {
        melt_held: boolean;
        drain_state_known: boolean;
      };
      expect(summary).toMatchObject({ melt_held: true, drain_state_known: true });
    });

    it("rejects an unparseable --hold-alarm-after before touching the DVM", async () => {
      const { getPendingDrains } = setHappyPath();

      await expect(
        meltPending("dvm", { endpoint: "https://dvm.example", holdAlarmAfter: "soon" })
      ).rejects.toMatchObject({ code: "invalid_duration" });
      expect(getPendingDrains).not.toHaveBeenCalled();
    });

    it("shuts the --watch daemon down on a drain-fetch bad signature", async () => {
      const { getPendingDrains } = setHappyPath();
      getPendingDrains.mockRejectedValue(badSignature());
      vi.useFakeTimers();
      try {
        const run = meltPending("dvm", {
          endpoint: "https://dvm.example",
          watch: true,
          interval: 10,
        });
        const settled = expect(run).rejects.toMatchObject({ code: "admin_bad_signature" });
        // A daemon retrying a key it will never hold is the failure mode the
        // fatal path exists for; it was unreachable until the drain fetch
        // stopped swallowing the 401.
        await vi.advanceTimersByTimeAsync(500);
        await settled;
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs actionable guidance and retries a mid-run admin-state outage under --watch", async () => {
      const { getPendingBatches, getPendingDrains } = setHappyPath();
      const emptyDrains = {
        drains: [],
        liability: { cashu_sats: 0, by_method_micro: {} },
      };
      const unavailable = new DvmError(
        "admin_state_unavailable",
        "The requested DVM operation did not run.",
        "Retry the same command; inspect database health, restart the DVM, and do not rotate the lock key."
      );
      getPendingBatches.mockResolvedValue({ batches: [] });
      getPendingDrains
        .mockResolvedValueOnce(emptyDrains)
        .mockRejectedValueOnce(unavailable)
        .mockRejectedValueOnce(badSignature());
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        const run = meltPending("dvm", {
          endpoint: "https://dvm.example",
          watch: true,
          interval: 10,
        });
        const settled = expect(run).rejects.toMatchObject({ code: "admin_bad_signature" });

        await vi.advanceTimersByTimeAsync(20_500);
        await settled;

        const tickError = stderr.mock.calls
          .map(([line]) => JSON.parse(line as string) as Record<string, unknown>)
          .find((entry) => entry.level === "melt_pending_tick_error");
        expect(tickError).toMatchObject({
          error: "The operation could not be completed. Retry recovery.",
          code: "admin_state_unavailable",
          hint: unavailable.hint,
        });
        expect(getPendingDrains).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

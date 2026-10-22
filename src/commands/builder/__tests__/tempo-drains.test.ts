import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as adminCashuClientModule from "../../../lib/admin-cashu-client";

vi.mock("../../../lib/cashu/builder-lock-identity", () => ({
  resolveBuilderLockKeyring: vi.fn(),
  resolveBuilderLockKeyringByHandle: vi.fn(),
}));
vi.mock("../../../shared/output", () => ({
  json: vi.fn(),
  info: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("../../../lib/platform", () => ({ requireAuth: vi.fn() }));
vi.mock("../../../lib/platform-client", () => ({ getDvm: vi.fn() }));

vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({
    dvmId: "dvm-fixture-2034",
    token: "t",
    platformUrl: "https://api.example",
  })),
}));

vi.mock("../../../lib/admin-cashu-client", async (importOriginal) => {
  const actual = await importOriginal<typeof adminCashuClientModule>();
  class AdminCashuClient {
    constructor(opts: unknown) {
      return clientCtorSpy(opts) as AdminCashuClient;
    }
  }
  return { ...actual, AdminCashuClient };
});

const clientCtorSpy = vi.fn();
const getTempoDrains = vi.fn();
const reconcile = vi.fn();
const writeOff = vi.fn();

import { AdminApiError, type AdminTempoDrain } from "../../../lib/admin-cashu-client";
import {
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../../lib/cashu/builder-lock-identity";
import * as output from "../../../shared/output";
import { tempoReconcile, tempoWedged, tempoWriteOff } from "../tempo-drains";

const ENDPOINT = "https://dvm.example.com";
const CHANNEL_ID = `0x${"3a".repeat(32)}`;
const TX_HASH = `0x${"b1".repeat(32)}`;
const CREDIT_ID = "imp:mpp:challenge-1";
const DRAIN_ID = "drain-1";

function drainRow(overrides: Partial<AdminTempoDrain> = {}): AdminTempoDrain {
  return {
    credit_id: CREDIT_ID,
    drain_id: DRAIN_ID,
    channel_id: CHANNEL_ID,
    amount_micro: 400_000,
    amount_native: 400_000,
    currency: "usd",
    caller_pubkey: "ab".repeat(32),
    status: "pending",
    created_at: 1,
    write_off_note: null,
    written_off_at: null,
    chain: {
      chain: "found",
      transaction: TX_HASH,
      refundedToPayer: "400000",
      settledToPayee: "100000",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const keyring = {
    canonicalDvmId: "dvm-fixture-2034",
    currentKeypair: { privkey: "11".repeat(32), pubkey: "02" + "aa".repeat(32) },
    keypairsByPubkey: new Map(),
  } as never;
  vi.mocked(resolveBuilderLockKeyring).mockReturnValue(keyring);
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue(keyring);
  clientCtorSpy.mockReturnValue({
    getTempoDrains,
    reconcileTempoDrain: reconcile,
    writeOffTempoDrain: writeOff,
  });
  getTempoDrains.mockResolvedValue({ drains: [drainRow()] });
  reconcile.mockResolvedValue({
    status: "reconciled",
    credit_id: CREDIT_ID,
    drain_id: DRAIN_ID,
    channel_id: CHANNEL_ID,
    transaction: TX_HASH,
    settled_amount: "400000",
    amount_micro: 400_000,
    amount_native: 400_000,
    currency: "usd",
    replayed: false,
  });
  writeOff.mockResolvedValue({
    status: "written_off",
    credit_id: CREDIT_ID,
    drain_id: DRAIN_ID,
    channel_id: CHANNEL_ID,
    amount_micro: 400_000,
    amount_native: 400_000,
    currency: "usd",
    note: "chain refunded short",
    replayed: false,
  });
});

describe("dvmctl credit tempo-wedged", () => {
  it("separates a refund that covers the debit from one that is short", async () => {
    getTempoDrains.mockResolvedValue({
      drains: [
        drainRow(),
        drainRow({
          drain_id: "drain-short",
          chain: {
            chain: "found",
            transaction: TX_HASH,
            refundedToPayer: "399999",
            settledToPayee: "100001",
          },
        }),
        drainRow({ drain_id: "drain-down", chain: { chain: "unreachable", error: "timeout" } }),
        // Write-off annotations remain visible without inflating existing action counts.
        drainRow({ drain_id: "drain-closed", write_off_note: "reviewed", written_off_at: 5 }),
      ],
      next_after: "cursor",
    });
    await tempoWedged("cast", { endpoint: ENDPOINT, includeResolved: true });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_tempo_wedged",
      wedged_count: 3,
      repairable_count: 1,
      short_refund_count: 1,
      next_after: "cursor",
    });
    expect(String(body.hint)).toContain("tempo-reconcile");
    expect(String(body.display)).toContain("refunded the caller less");
  });

  it("calls a drain with no native debit neither repairable nor short", async () => {
    // A legacy credit with no rail basis has nothing the floor can be sized
    // against, so the DVM will refuse it too — counting it as ready to finish
    // would send an operator at a verb that cannot succeed, and counting it as
    // short would claim the chain underpaid when nothing was ever compared.
    getTempoDrains.mockResolvedValue({ drains: [drainRow({ amount_native: null })] });
    await tempoWedged("cast", { endpoint: ENDPOINT });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ wedged_count: 1, repairable_count: 0, short_refund_count: 0 });
    expect(String(body.display)).not.toContain("refunded the caller less");
  });

  it("keeps a drain whose close never landed out of the wedged count", async () => {
    // A pending drain with no confirmed close is the caller's to finish: nothing
    // reached the chain, so no repair applies and saying one "landed on chain"
    // would send an operator at a row neither verb can take.
    getTempoDrains.mockResolvedValue({
      drains: [drainRow(), drainRow({ drain_id: "drain-open", chain: { chain: "unconfirmed" } })],
    });
    await tempoWedged("cast", { endpoint: ENDPOINT });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      wedged_count: 1,
      repairable_count: 1,
      awaiting_close_count: 1,
    });
    expect(String(body.display)).toContain("no confirmed close on chain yet");
  });

  it("says nothing is stuck rather than emitting an empty list with a scary display", async () => {
    getTempoDrains.mockResolvedValue({ drains: [] });
    await tempoWedged("cast", { endpoint: ENDPOINT });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ wedged_count: 0 });
    expect(String(body.display)).toContain("No Tempo channel closes");
  });

  it("refuses an out-of-range page locally rather than asking the DVM", async () => {
    await expect(tempoWedged("cast", { endpoint: ENDPOINT, limit: 500 })).rejects.toMatchObject({
      code: "invalid_limit",
    });
    expect(getTempoDrains).not.toHaveBeenCalled();
  });

  it("passes the evidence opt-out through", async () => {
    await tempoWedged("cast", { endpoint: ENDPOINT, evidence: false });
    expect(getTempoDrains).toHaveBeenCalledWith(expect.objectContaining({ evidence: false }));
  });

  it("translates a bad signature before the generic admin-error surface", async () => {
    getTempoDrains.mockRejectedValue(
      new AdminApiError(401, { error: "unauthorized", reason: "bad_signature", raw: {} })
    );
    await expect(tempoWedged("cast", { endpoint: ENDPOINT })).rejects.toMatchObject({
      code: "admin_bad_signature",
    });
  });
});

describe("dvmctl credit tempo-reconcile", () => {
  it("preserves the DVM's short-refund refusal with both figures", async () => {
    reconcile.mockRejectedValue(
      new AdminApiError(409, {
        error: "drain_conflict",
        message: "Tempo close refunded 0 for a drain requiring at least 20000",
        raw: {},
      })
    );

    await expect(
      tempoReconcile("cast", CREDIT_ID, DRAIN_ID, { endpoint: ENDPOINT })
    ).rejects.toMatchObject({
      code: "drain_conflict",
      message: "Tempo close refunded 0 for a drain requiring at least 20000",
      data: { http_status: 409 },
    });
  });

  it("reports the chain figure the drain was booked against", async () => {
    await tempoReconcile("cast", CREDIT_ID, DRAIN_ID, { endpoint: ENDPOINT });
    expect(reconcile).toHaveBeenCalledWith({ credit_id: CREDIT_ID, drain_id: DRAIN_ID });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_tempo_reconcile",
      credit_id: CREDIT_ID,
      drain_id: DRAIN_ID,
      settled_amount: "400000",
      replayed: false,
    });
    expect(String(body.display)).toContain(TX_HASH);
  });

  it("says nothing moved on a replay", async () => {
    reconcile.mockResolvedValue({
      status: "reconciled",
      credit_id: CREDIT_ID,
      drain_id: DRAIN_ID,
      channel_id: CHANNEL_ID,
      transaction: TX_HASH,
      settled_amount: "400000",
      amount_micro: 400_000,
      amount_native: 400_000,
      currency: "usd",
      replayed: true,
    });
    await tempoReconcile("cast", CREDIT_ID, DRAIN_ID, { endpoint: ENDPOINT });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(String(body.display)).toContain("Nothing moved");
  });
});

describe("dvmctl credit tempo-write-off", () => {
  it("keeps the write-off an annotation and directs full repayment to operator booking", async () => {
    await tempoWriteOff("cast", CREDIT_ID, DRAIN_ID, {
      endpoint: ENDPOINT,
      note: "chain refunded short",
    });
    expect(writeOff).toHaveBeenCalledWith({
      credit_id: CREDIT_ID,
      drain_id: DRAIN_ID,
      note: "chain refunded short",
    });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ op: "credit_tempo_write_off", replayed: false });
    expect(String(body.display)).toContain("refund liability remains");
    expect(String(body.display)).toContain("tempo-book");
    expect(String(body.hint)).toContain("tempo-reconcile");
  });

  it("tells the operator their note did not overwrite the one on record", async () => {
    writeOff.mockResolvedValue({
      status: "written_off",
      credit_id: CREDIT_ID,
      drain_id: DRAIN_ID,
      channel_id: CHANNEL_ID,
      amount_micro: 400_000,
      amount_native: 400_000,
      currency: "usd",
      note: "the first note",
      replayed: true,
    });
    await tempoWriteOff("cast", CREDIT_ID, DRAIN_ID, {
      endpoint: ENDPOINT,
      note: "second thoughts",
    });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(String(body.display)).toContain("the first note");
    expect(String(body.display)).toContain("not recorded over it");
  });
});


describe("held Tempo audit presentation", () => {
  it.each([false, true])("keeps held write-offs visible and terminal decisions out of action counts, human=%s", async (human) => {
    const decision = { source: "operator" as const, decision: "release" as const, reason: "No refund paid", decidedAt: 1800000001000 };
    const rows = [
      drainRow(),
      drainRow({ drain_id: "written-off", written_off_at: 5, write_off_note: "Reviewed", held_reason: "refund_short" }),
      drainRow({ drain_id: "released", status: "released", held_reason: null, decision }),
      drainRow({ drain_id: "booked", status: "sent", decision: { ...decision, decision: "book_refunded" } }),
    ];
    getTempoDrains.mockResolvedValue({ drains: rows, next_after: "opaque /?&cursor" });
    await tempoWedged("cast", { endpoint: ENDPOINT, includeResolved: true, human, after: "prior /?&cursor", limit: 50 });
    expect(getTempoDrains).toHaveBeenCalledWith({ limit: 50, after: "prior /?&cursor", includeResolved: true });
    if (human) {
      expect(output.raw).toHaveBeenCalledTimes(4);
      expect(output.raw).toHaveBeenCalledWith(expect.stringContaining('written-off — note on record: "Reviewed"'));
      expect(output.raw).toHaveBeenCalledWith(expect.stringContaining('decision={"source":"operator","decision":"release"'));
      expect(output.info).toHaveBeenCalledWith(expect.stringContaining("1 awaiting a decision, 1 whose on-chain refund covers"));
    } else {
      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({ drains: rows, wedged_count: 1, repairable_count: 1, next_after: "opaque /?&cursor" }));
    }
  });

  it.each([false, true])("preserves exact, unknown, and sticky positive facts alongside separate reports, human=%s", async (human) => {
    const rows = [
      drainRow({ credit_id: "credit/日本語?&", drain_id: "drain with spaces", held_reason: "refund_short",
        proven_refund_native: "900719925474099312345678901234567890", refund_payment_proven: true,
        chain: { chain: "found", transaction: TX_HASH, refundedToPayer: "0", settledToPayee: "1" },
        close_reports: [{ obligation_id: "report/1", status: "no_report", written_off: true }] }),
      drainRow({ drain_id: "positive-lower-bound", proven_refund_native: null, refund_payment_proven: true, chain: undefined }),
      drainRow({ drain_id: "exact-zero", proven_refund_native: "0", refund_payment_proven: false, chain: undefined }),
      drainRow({ drain_id: "unknown", proven_refund_native: null, refund_payment_proven: false, chain: undefined }),
    ];
    getTempoDrains.mockResolvedValue({ drains: rows });
    await tempoWedged("cast", { endpoint: ENDPOINT, human, evidence: false });
    if (human) {
      const text = vi.mocked(output.raw).mock.calls.flat().join(" ");
      expect(text).toContain("900719925474099312345678901234567890");
      expect(text).toContain("proven_refund_native=unknown  refund_payment_proven=true");
      expect(text).toContain("proven_refund_native=0  refund_payment_proven=false");
      expect(text).toContain("report/1  no_report  written_off=true (builder payout report; separate from caller refund)");
      expect(output.info).toHaveBeenCalledWith(expect.stringContaining("false does not prove nonpayment"));
    } else {
      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({ drains: rows, hint: expect.stringContaining("false does not prove nonpayment") }));
    }
  });

  it.each([false, true])("keeps a written-off held row visible on the default page, human=%s", async (human) => {
    const row = drainRow({ written_off_at: 5, write_off_note: "Reviewed", held_reason: "refund_short" });
    getTempoDrains.mockResolvedValue({ drains: [row] });
    await tempoWedged("cast", { endpoint: ENDPOINT, human });
    expect(getTempoDrains).toHaveBeenCalledWith({ limit: 20 });
    if (human) {
      expect(output.raw).toHaveBeenCalledWith(expect.stringContaining("written-off"));
      expect(output.info).toHaveBeenCalledWith(expect.stringContaining("still hold the caller's debited balance"));
    } else {
      expect(output.json).toHaveBeenCalledWith(expect.objectContaining({ drains: [row], wedged_count: 0, short_refund_count: 0,
        hint: expect.stringContaining("Written-off held drains remain visible") }));
    }
  });

  it("compares decimal receipt evidence without rounding above the safe integer limit", async () => {
    // This debit is exactly representable; rounding the receipt up to it would hide a short refund.
    getTempoDrains.mockResolvedValue({ drains: [
      drainRow({ amount_native: 9007199254740996, chain: { chain: "found", transaction: TX_HASH, refundedToPayer: "9007199254740995", settledToPayee: "1" } }),
      drainRow({ drain_id: "large", amount_native: 9007199254740991, chain: { chain: "found", transaction: TX_HASH, refundedToPayer: "90071992547409931234567890", settledToPayee: "1" } }),
    ] });
    await tempoWedged("cast", { endpoint: ENDPOINT });
    expect(output.json).toHaveBeenCalledWith(expect.objectContaining({ repairable_count: 1, short_refund_count: 1 }));
  });
});

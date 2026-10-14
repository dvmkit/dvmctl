/**
 * The `dvmctl credit x402-*` verbs. The route contract is asserted in
 * `@dvmkit/sdk/server` and the repair's own money
 * behaviour in `x402-channel-store.db.test.ts`; what only this suite covers is
 * the CLI's own half — the page ceiling it refuses locally rather than asking
 * the DVM about, the bad-signature translation, and the JSON an
 * agent reads to decide between reconciling and writing off.
 */
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
    dvmId: "dvm-fixture-1881",
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
const getX402Settlements = vi.fn();
const reconcile = vi.fn();
const writeOff = vi.fn();

import { AdminApiError, type AdminX402Settlement } from "../../../lib/admin-cashu-client";
import {
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../../lib/cashu/builder-lock-identity";
import * as output from "../../../shared/output";
import { x402Reconcile, x402Wedged, x402WriteOff } from "../x402-settlements";

const ENDPOINT = "https://dvm.example.com";
const SETTLEMENT_ID = "5e".repeat(32);

function settlementRow(overrides: Partial<AdminX402Settlement> = {}): AdminX402Settlement {
  return {
    settlement_id: SETTLEMENT_ID,
    channel_id: `0x${"7c".repeat(32)}`,
    operation: "refund",
    effect_id: "imp:x402:pay-1:drain-1",
    credit_id: "imp:x402:pay-1",
    drain_id: "drain-1",
    credit_balance_micro: 400_000,
    credit_remaining_micro: 400_000,
    credit_currency: "usd",
    spending_blocked: true,
    status: "settled",
    submission_block: "100",
    settled_amount: "999",
    settled_transaction: "0xstale",
    created_at: 1,
    updated_at: 2,
    resolved_at: null,
    write_off_note: null,
    chain: { chain: "found", transaction: "0xrefund", amount: "400000" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const keyring = {
    canonicalDvmId: "dvm-fixture-1881",
    currentKeypair: { privkey: "11".repeat(32), pubkey: "02" + "aa".repeat(32) },
    keypairsByPubkey: new Map(),
  } as never;
  vi.mocked(resolveBuilderLockKeyring).mockReturnValue(keyring);
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue(keyring);
  clientCtorSpy.mockReturnValue({
    getX402Settlements,
    reconcileX402Settlement: reconcile,
    writeOffX402Settlement: writeOff,
  });
  getX402Settlements.mockResolvedValue({ settlements: [settlementRow()] });
  reconcile.mockResolvedValue({
    status: "reconciled",
    settlement_id: SETTLEMENT_ID,
    channel_id: `0x${"7c".repeat(32)}`,
    credit_id: "imp:x402:pay-1",
    drain_id: "drain-1",
    transaction: "0xrefund",
    settled_amount: "400000",
    amount_micro: 400_000,
    currency: "usd",
    replayed: false,
  });
  writeOff.mockResolvedValue({
    status: "written_off",
    settlement_id: SETTLEMENT_ID,
    channel_id: `0x${"7c".repeat(32)}`,
    effect_id: "imp:x402:pay-1:drain-1",
    note: "chain and ledger disagree",
    replayed: false,
  });
});

describe("dvmctl credit x402-wedged", () => {
  it("separates rows awaiting a decision from rows the chain can confirm", async () => {
    getX402Settlements.mockResolvedValue({
      settlements: [
        settlementRow(),
        settlementRow({ settlement_id: "aa", chain: { chain: "unreachable", error: "timeout" } }),
        // A chain match on a settlement an operator already closed is not work
        // anybody is waiting on, so it must not inflate the repairable count.
        settlementRow({ settlement_id: "bb", status: "written_off" }),
      ],
      next_after: "cursor",
    });
    await x402Wedged("cast", { endpoint: ENDPOINT, includeResolved: true });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_x402_wedged",
      wedged_count: 2,
      repairable_count: 1,
      next_after: "cursor",
    });
    expect(String(body.hint)).toContain("x402-reconcile");
  });

  it("says nothing is stuck rather than emitting an empty list with a scary display", async () => {
    getX402Settlements.mockResolvedValue({ settlements: [] });
    await x402Wedged("cast", { endpoint: ENDPOINT });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ wedged_count: 0 });
    expect(String(body.display)).toContain("No x402 refunds");
  });

  it("refuses an out-of-range page locally rather than asking the DVM", async () => {
    await expect(x402Wedged("cast", { endpoint: ENDPOINT, limit: 500 })).rejects.toMatchObject({
      code: "invalid_limit",
    });
    expect(getX402Settlements).not.toHaveBeenCalled();
  });

  it("passes the evidence opt-out through", async () => {
    await x402Wedged("cast", { endpoint: ENDPOINT, evidence: false });
    expect(getX402Settlements).toHaveBeenCalledWith(expect.objectContaining({ evidence: false }));
  });

  it("translates a bad signature before the generic admin-error surface", async () => {
    getX402Settlements.mockRejectedValue(
      new AdminApiError(401, { error: "unauthorized", reason: "bad_signature", raw: {} })
    );
    await expect(x402Wedged("cast", { endpoint: ENDPOINT })).rejects.toMatchObject({
      code: "admin_bad_signature",
    });
  });
});

describe("dvmctl credit x402-reconcile", () => {
  it("reports the chain figure the drain was booked against", async () => {
    await x402Reconcile("cast", SETTLEMENT_ID, { endpoint: ENDPOINT });
    expect(reconcile).toHaveBeenCalledWith({ settlement_id: SETTLEMENT_ID });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_x402_reconcile",
      credit_id: "imp:x402:pay-1",
      drain_id: "drain-1",
      settled_amount: "400000",
      replayed: false,
    });
    expect(String(body.display)).toContain("0xrefund");
  });

  it("says nothing moved on a replay", async () => {
    reconcile.mockResolvedValue({
      status: "reconciled",
      settlement_id: SETTLEMENT_ID,
      channel_id: "0x00",
      credit_id: "imp:x402:pay-1",
      drain_id: "drain-1",
      transaction: "0xrefund",
      settled_amount: "400000",
      amount_micro: 400_000,
      currency: "usd",
      replayed: true,
    });
    await x402Reconcile("cast", SETTLEMENT_ID, { endpoint: ENDPOINT });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(String(body.display)).toContain("Nothing moved");
  });
});

describe("dvmctl credit x402-write-off", () => {
  it("says the caller's balance stays reclaimable, and that the verb is reversible", async () => {
    await x402WriteOff("cast", SETTLEMENT_ID, {
      endpoint: ENDPOINT,
      note: "chain and ledger disagree",
    });
    expect(writeOff).toHaveBeenCalledWith({
      settlement_id: SETTLEMENT_ID,
      note: "chain and ledger disagree",
    });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ op: "credit_x402_write_off", replayed: false });
    expect(String(body.display)).toContain("reclaim");
    expect(String(body.hint)).toContain("x402-reconcile");
  });

  it("tells the operator their note did not overwrite the one on record", async () => {
    writeOff.mockResolvedValue({
      status: "written_off",
      settlement_id: SETTLEMENT_ID,
      channel_id: "0x00",
      effect_id: "e",
      note: "the first note",
      replayed: true,
    });
    await x402WriteOff("cast", SETTLEMENT_ID, { endpoint: ENDPOINT, note: "second thoughts" });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(String(body.display)).toContain("the first note");
    expect(String(body.display)).toContain("not recorded over it");
  });
});

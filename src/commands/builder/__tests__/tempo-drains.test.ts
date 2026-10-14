/**
 * The `dvmctl credit tempo-*` verbs. The route contract is asserted
 * in `@dvmkit/sdk/server` and the shared terminal
 * transition in `tempo-drain-leg.test.ts`; what only this suite covers is the
 * CLI's own half — the page ceiling it refuses locally rather than asking the
 * DVM about, the bad-signature translation, and the JSON an agent
 * reads to decide between reconciling and writing off.
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
        // A chain figure on a drain an operator already closed out is not work
        // anybody is waiting on, so it must not inflate the repairable count.
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
  it("says the shortfall is not expressible here, and that the verb is reversible", async () => {
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
    expect(String(body.display)).toContain("out of band");
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

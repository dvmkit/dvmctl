/**
 * The `dvmctl credit drains-owed` / `drain-settle` pair. The route
 * contract is asserted in `@dvmkit/sdk/server`; what
 * only this suite covers is the CLI's own half — that the queue is narrowed to
 * the rows a person actually has to settle, that totals are grouped rather than
 * summed across denominations, that a settlement without evidence is refused
 * here rather than recorded blank, and that a replay is reported as one.
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
    dvmId: "dvm-fixture-2030",
    token: "t",
    platformUrl: "https://api.example",
  })),
}));

vi.mock("../../../lib/admin-cashu-client", async (importOriginal) => {
  const actual = await importOriginal<typeof adminCashuClientModule>();
  // Class shell whose constructor delegates to the spy, so a test can hand the
  // command a fake client without the real one ever reaching the network.
  class AdminCashuClient {
    constructor(opts: unknown) {
      return clientCtorSpy(opts) as AdminCashuClient;
    }
  }
  return { ...actual, AdminCashuClient };
});

const clientCtorSpy = vi.fn();
const getPendingDrains = vi.fn();
const markDrainSent = vi.fn();

import { AdminApiError, type AdminPendingDrain } from "../../../lib/admin-cashu-client";
import {
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../../lib/cashu/builder-lock-identity";
import * as output from "../../../shared/output";
import { drainSettle, drainsOwed } from "../manual-drains";

const ENDPOINT = "https://dvm.example.com";
const ADDRESS = "0x" + "12".repeat(20);

function manualDrain(overrides: Partial<AdminPendingDrain> = {}): AdminPendingDrain {
  return {
    credit_id: "imp:x402:0xabc",
    drain_id: "drain-7",
    method: "x402",
    payout: { address: ADDRESS },
    currency: "usd",
    amount_micro: 400_000,
    amount_sats: null,
    amount_msats: null,
    amount_native: 400_000,
    sats_basis: null,
    settlement: "manual",
    channel_id: null,
    created_at: 1_754_000_000_000,
    ...overrides,
  };
}

function automaticDrain(overrides: Partial<AdminPendingDrain> = {}): AdminPendingDrain {
  return {
    credit_id: "c-cashu",
    drain_id: "drain-1",
    method: "cashu",
    payout: { refund_pubkey: "02" + "cd".repeat(32) },
    currency: "usd",
    amount_micro: 900_000,
    amount_sats: 900,
    amount_msats: 900_000,
    amount_native: 900,
    sats_basis: null,
    settlement: "automatic",
    channel_id: null,
    created_at: 1_754_000_000_000,
    ...overrides,
  };
}

/**
 * A channel-backed reclaim sitting `pending` while its cooperative close
 * reconciles — same method as a manual row, settled by something else entirely.
 * The Tempo shape carries an empty `payout`, so nothing but the
 * classification distinguishes it.
 */
function channelDrain(overrides: Partial<AdminPendingDrain> = {}): AdminPendingDrain {
  return {
    credit_id: "c-tempo",
    drain_id: "drain-9",
    method: "tempo",
    payout: {},
    currency: "usd",
    amount_micro: 750_000,
    amount_sats: null,
    amount_msats: null,
    amount_native: 750_000,
    sats_basis: null,
    settlement: "channel",
    channel_id: "chan-1",
    created_at: 1_753_000_000_000,
    ...overrides,
  };
}

function pending(drains: AdminPendingDrain[]): unknown {
  const totalFor = (settlement: AdminPendingDrain["settlement"]): number =>
    drains.filter((d) => d.settlement === settlement).reduce((sum, d) => sum + d.amount_micro, 0);
  return {
    drains,
    liability: {
      cashu_sats: 0,
      by_method_micro: {},
      manual_micro: totalFor("manual"),
      channel_micro: totalFor("channel"),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const keyring = {
    canonicalDvmId: "dvm-fixture-2030",
    currentKeypair: { privkey: "11".repeat(32), pubkey: "02" + "aa".repeat(32) },
    keypairsByPubkey: new Map(),
  } as never;
  vi.mocked(resolveBuilderLockKeyring).mockReturnValue(keyring);
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue(keyring);
  clientCtorSpy.mockReturnValue({ getPendingDrains, markDrainSent });
  getPendingDrains.mockResolvedValue(pending([manualDrain()]));
  markDrainSent.mockResolvedValue({
    status: "sent",
    credit_id: "imp:x402:0xabc",
    drain_id: "drain-7",
    replayed: false,
  });
});

describe("dvmctl credit drains-owed", () => {
  it("lists only what a person has to settle, with the figure they send", async () => {
    getPendingDrains.mockResolvedValue(pending([automaticDrain(), manualDrain()]));
    await drainsOwed("cast", { endpoint: ENDPOINT });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_drains_owed",
      handle: "cast",
      dvmId: "dvm-fixture-2030",
      slug: "cast",
      owed_count: 1,
    });
    // The cashu row is the batch job's work, not the operator's — showing it
    // here would make a queue that clears itself look like outstanding debt.
    const drains = body.drains as Record<string, unknown>[];
    expect(drains).toHaveLength(1);
    expect(drains[0]).toMatchObject({
      drain_id: "drain-7",
      method: "x402",
      amount_micro: 400_000,
      amount_native: 400_000,
      payout: { address: ADDRESS },
    });
    expect(String(body.hint)).toContain("dvmctl credit drain-settle");
    // The privkey is derived locally and handed to the client, never fetched.
    expect(clientCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: ENDPOINT, dvmId: "dvm-fixture-2030" })
    );
  });

  it("leaves out a channel-backed reclaim its own close is still settling", async () => {
    // The oldest row in the set, so an age-ordered list would put it at the
    // top: an operator told to pay it would be paying a refund the channel is
    // about to pay itself, and recording that by hand would take the row out
    // of the reconciliation that would have settled it.
    getPendingDrains.mockResolvedValue(pending([channelDrain(), manualDrain()]));
    await drainsOwed("cast", { endpoint: ENDPOINT });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    const drains = body.drains as Record<string, unknown>[];
    expect(drains.map((d) => d.drain_id)).toEqual(["drain-7"]);
    expect(body).toMatchObject({
      owed_count: 1,
      owed_totals: [{ currency: "usd", amount_micro: 400_000, count: 1 }],
    });
  });

  it("puts the longest-owed refund first and ages each one", async () => {
    const now = Date.now();
    getPendingDrains.mockResolvedValue(
      pending([
        manualDrain({ drain_id: "recent", created_at: now - 60_000 }),
        manualDrain({ drain_id: "oldest", created_at: now - 3 * 86_400_000 }),
      ])
    );
    await drainsOwed("cast", { endpoint: ENDPOINT });

    const drains = (vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>)
      .drains as Record<string, unknown>[];
    expect(drains.map((d) => d.drain_id)).toEqual(["oldest", "recent"]);
    expect(drains[0].age_ms).toBeGreaterThanOrEqual(3 * 86_400_000);
  });

  it("groups the total by currency rather than adding denominations together", async () => {
    getPendingDrains.mockResolvedValue(
      pending([
        manualDrain({ drain_id: "usd-1", currency: "usd", amount_micro: 400_000 }),
        manualDrain({ drain_id: "eur-1", currency: "eur", amount_micro: 250_000 }),
        manualDrain({ drain_id: "usd-2", currency: "usd", amount_micro: 100_000 }),
      ])
    );
    await drainsOwed("cast", { endpoint: ENDPOINT });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body.owed_totals).toEqual([
      { currency: "eur", amount_micro: 250_000, count: 1 },
      { currency: "usd", amount_micro: 500_000, count: 2 },
    ]);
    expect(body.owed_count).toBe(3);
  });

  it("says plainly when the operator owes nothing", async () => {
    getPendingDrains.mockResolvedValue(pending([automaticDrain()]));
    await drainsOwed("cast", { endpoint: ENDPOINT });
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
      owed_count: 0,
      owed_totals: [],
      display: "This DVM owes no stablecoin refunds that a person has to settle.",
    });
  });

  it("translates a bad signature rather than surfacing it as a per-call refusal", async () => {
    getPendingDrains.mockRejectedValue(
      new AdminApiError(401, { error: "unauthorized", reason: "bad_signature", raw: {} })
    );
    await expect(drainsOwed("cast", { endpoint: ENDPOINT })).rejects.toMatchObject({
      code: "admin_bad_signature",
    });
  });
});

describe("dvmctl credit drain-settle", () => {
  it("records the transaction as the drain's settlement evidence", async () => {
    await drainSettle("cast", "imp:x402:0xabc", "drain-7", {
      endpoint: ENDPOINT,
      tx: "0xfeed",
      note: "ops wallet",
    });

    expect(markDrainSent).toHaveBeenCalledWith({
      credit_id: "imp:x402:0xabc",
      drain_id: "drain-7",
      sent_ref: { transaction: "0xfeed", settled_by: "operator", note: "ops wallet" },
    });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_drain_settle",
      credit_id: "imp:x402:0xabc",
      drain_id: "drain-7",
      transaction: "0xfeed",
      replayed: false,
    });
  });

  it("refuses a settlement with no evidence rather than recording a blank one", async () => {
    await expect(
      drainSettle("cast", "imp:x402:0xabc", "drain-7", { endpoint: ENDPOINT })
    ).rejects.toMatchObject({ code: "missing_transaction" });
    // Refused locally: nothing reached the DVM, so no half-recorded row exists.
    expect(markDrainSent).not.toHaveBeenCalled();
  });

  it("refuses whitespace as a transaction hash", async () => {
    await expect(
      drainSettle("cast", "imp:x402:0xabc", "drain-7", { endpoint: ENDPOINT, tx: "   " })
    ).rejects.toMatchObject({ code: "missing_transaction" });
    expect(markDrainSent).not.toHaveBeenCalled();
  });

  it("tells an operator a re-run changed nothing, so they can check before re-paying", async () => {
    markDrainSent.mockResolvedValue({
      status: "sent",
      credit_id: "imp:x402:0xabc",
      drain_id: "drain-7",
      replayed: true,
    });
    await drainSettle("cast", "imp:x402:0xabc", "drain-7", { endpoint: ENDPOINT, tx: "0xfeed" });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body.replayed).toBe(true);
    expect(String(body.display)).toContain("already recorded as sent");
    expect(String(body.display)).toContain("before sending another");
  });

  it("omits the note rather than recording an empty one", async () => {
    await drainSettle("cast", "imp:x402:0xabc", "drain-7", { endpoint: ENDPOINT, tx: "0xfeed" });
    expect(markDrainSent).toHaveBeenCalledWith(
      expect.objectContaining({
        sent_ref: { transaction: "0xfeed", settled_by: "operator" },
      })
    );
  });

  it("translates a bad signature rather than surfacing it as a per-call refusal", async () => {
    markDrainSent.mockRejectedValue(
      new AdminApiError(401, { error: "unauthorized", reason: "bad_signature", raw: {} })
    );
    await expect(
      drainSettle("cast", "imp:x402:0xabc", "drain-7", { endpoint: ENDPOINT, tx: "0xfeed" })
    ).rejects.toMatchObject({ code: "admin_bad_signature" });
  });
});

/**
 * The adoption both money-adding doors make when a wedged x402 channel refuses
 * them and names the one drain id that still reclaims the balance on it
 * for `dvm credit fund` and the post-job auto-refill.
 *
 * These are the helper's own cases. Each door's wiring — that it fires on
 * `settlement_pending` and nothing else, and what it does with the sentence it
 * gets back — is asserted where that door lives.
 */

import type * as SdkInternal from "@dvmkit/sdk/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
type SdkInternalModule = typeof SdkInternal;

// The pure selectors come through real, so the "which drain is already on this
// credit" question is answered by the store's own matching rules.
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<SdkInternalModule>()),
  clearPendingDrain: vi.fn(),
  ensureProvisionalCredit: vi.fn(),
  loadCredit: vi.fn(() => undefined),
  recordCreditX402Instrument: vi.fn(),
  recordPendingDrain: vi.fn(),
}));

import {
  clearPendingDrain,
  ensureProvisionalCredit,
  loadCredit,
  recordCreditX402Instrument,
  recordPendingDrain,
  type StoredCredit,
} from "@dvmkit/sdk/internal";

import { adoptWedgedChannelDrain, creditDrainCommand, reclaimCommand } from "../credit-reclaim";

/**
 * The drain record the store keeps on a credit. `@dvmkit/sdk/internal` names
 * the functions that take one but not the interface itself, so it is read off
 * the signature that carries it rather than restated here.
 */
type PendingDrain = Parameters<typeof recordPendingDrain>[2];

const ENDPOINT = "https://wordcount.example";
const PUBKEY = "bb".repeat(32);
const DVM_ID = "dvm-wordcount";
/** The attested pair a store row is keyed on — id alone is not one. */
const IDENTITY = { dvmId: DVM_ID, builderPubkey: "ab".repeat(32) };

function stored(overrides: Partial<StoredCredit> = {}): StoredCredit {
  return {
    endpoint: ENDPOINT,
    callerPubkey: PUBKEY,
    creditId: "credit-1",
    currency: "usd",
    balanceMicro: 300_000,
    remainingMicro: 300_000,
    ledgerSeq: 4,
    expiryMs: 1789300000000,
    targetMicro: 400_000,
    status: "active",
    openedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** The refusal's `data`, as either door builds it: an admitted id, no `drain_registered`. */
function refusalData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settlement_id: "s-1",
    settlement_status: "settled",
    settlement_drain_id: "wedged-drain",
    ...overrides,
  };
}

function adopt(args: Partial<Parameters<typeof adoptWedgedChannelDrain>[0]> = {}) {
  return adoptWedgedChannelDrain({
    endpoint: ENDPOINT,
    callerPubkey: PUBKEY,
    creditId: "credit-1",
    data: refusalData(),
    ...args,
  });
}

beforeEach(() => {
  vi.mocked(loadCredit).mockReturnValue(stored());
});

describe("adoptWedgedChannelDrain", () => {
  it("records the named id as this credit's reclaim and names the bare command", () => {
    const adopted = adopt();

    expect(adopted).toMatchObject({
      drainId: "wedged-drain",
      command: `dvm credit drain ${ENDPOINT}`,
    });
    expect(adopted?.advice).toContain("Drain wedged-drain is now this credit's recorded reclaim");
    expect(adopted?.advice).toContain(`'dvm credit drain ${ENDPOINT}' posts it`);
    expect(adopted?.advice).toContain("no --drain-id needed");

    expect(recordPendingDrain).toHaveBeenCalledWith(ENDPOINT, PUBKEY, {
      drainId: "wedged-drain",
      creditId: "credit-1",
      // The channel shape, not a guess: this refusal only fires on a
      // channel-bound credit, whose payout is fixed in the channel config.
      method: "x402",
      payout: {},
      requestedAt: expect.any(Number),
    });
    // The hold is only reachable through a settlement channel, so the refusal
    // named the instrument as surely as it named the drain.
    expect(recordCreditX402Instrument).toHaveBeenCalledWith(
      ENDPOINT,
      PUBKEY,
      "credit-1",
      "x402_channel",
      undefined
    );
    expect(clearPendingDrain).not.toHaveBeenCalled();
    expect(ensureProvisionalCredit).not.toHaveBeenCalled();
  });

  it("keys the store on the attested identity and the reclaim command on the handle", () => {
    // Two different identities: the record is keyed by the pair the DVM
    // attested, while the command has to be something the caller can type.
    const adopted = adopt({ identity: IDENTITY, handle: DVM_ID });

    expect(adopted?.command).toBe(`dvm credit drain ${DVM_ID}`);
    expect(recordPendingDrain).toHaveBeenCalledWith(
      ENDPOINT,
      PUBKEY,
      expect.objectContaining({ drainId: "wedged-drain" }),
      IDENTITY
    );
    expect(recordCreditX402Instrument).toHaveBeenCalledWith(
      ENDPOINT,
      PUBKEY,
      "credit-1",
      "x402_channel",
      IDENTITY
    );
  });

  it("replaces a stale drain this credit was holding under another id", () => {
    // Two drains on one credit is a shape nothing reads: `pendingDrainFor` takes
    // the first stamped entry, so leaving the old one is how the next plain
    // drain posts the id this gate refuses. Any other id recorded here met the
    // same gate and was never registered server-side.
    const stale: PendingDrain = {
      drainId: "stale-drain",
      creditId: "credit-1",
      method: "x402",
      payout: {},
      requestedAt: 0,
    };
    vi.mocked(loadCredit).mockReturnValue(stored({ pendingDrains: [stale] }));

    adopt();

    expect(clearPendingDrain).toHaveBeenCalledWith(ENDPOINT, PUBKEY, stale);
    expect(recordPendingDrain).toHaveBeenCalledWith(
      ENDPOINT,
      PUBKEY,
      expect.objectContaining({ drainId: "wedged-drain", creditId: "credit-1" })
    );
  });

  it("re-records without clearing when the named id is already the recorded one", () => {
    vi.mocked(loadCredit).mockReturnValue(
      stored({
        pendingDrains: [
          {
            drainId: "wedged-drain",
            creditId: "credit-1",
            method: "x402",
            payout: {},
            requestedAt: 0,
          },
        ],
      })
    );

    adopt();

    expect(clearPendingDrain).not.toHaveBeenCalled();
    expect(recordPendingDrain).toHaveBeenCalledWith(
      ENDPOINT,
      PUBKEY,
      expect.objectContaining({ drainId: "wedged-drain" })
    );
  });

  it("leaves a sibling credit's drain alone", () => {
    // `pendingDrainFor` is credit-scoped, and so is the replacement: a drain on
    // another credit at this DVM says nothing about the one just refused.
    const sibling: PendingDrain = {
      drainId: "sibling-drain",
      creditId: "credit-other",
      method: "cashu",
      payout: {},
      requestedAt: 0,
    };
    vi.mocked(loadCredit).mockReturnValue(stored({ pendingDrains: [sibling] }));

    adopt();

    expect(clearPendingDrain).not.toHaveBeenCalled();
  });

  it("creates the record first when the store has never seen this credit", () => {
    // The whole reason these doors need their own adoption: `recordPendingDrain`
    // is a silent no-op without a record, and a caller reaching a wedged channel
    // from a machine that holds no drain history is the expected case.
    vi.mocked(loadCredit).mockReturnValue(undefined);

    const adopted = adopt({ identity: IDENTITY });

    expect(ensureProvisionalCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: ENDPOINT,
        identity: IDENTITY,
        callerPubkey: PUBKEY,
        creditId: "credit-1",
        targetMicro: 0,
      })
    );
    expect(vi.mocked(ensureProvisionalCredit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recordPendingDrain).mock.invocationCallOrder[0]
    );
    // No record to disagree with, so the reclaim is the bare verb: it creates
    // one under exactly this credit id.
    expect(adopted?.command).toBe(`dvm credit drain ${ENDPOINT}`);
  });

  it("names the credit in the reclaim when the record tracks a sibling", () => {
    // The bare verb resolves its credit from the tracked record, so advertising
    // it here would send the caller at a live sibling balance instead of the one
    // just refused — and leave this reclaim undone.
    vi.mocked(loadCredit).mockReturnValue(stored({ creditId: "credit-other" }));

    const adopted = adopt();

    expect(adopted?.command).toBe(`dvm credit drain ${ENDPOINT} --credit-id credit-1`);
    expect(adopted?.advice).toContain(
      `'dvm credit drain ${ENDPOINT} --credit-id credit-1' posts it`
    );
    expect(recordPendingDrain).toHaveBeenCalledWith(
      ENDPOINT,
      PUBKEY,
      expect.objectContaining({ drainId: "wedged-drain", creditId: "credit-1" })
    );
  });

  it("records nothing when the refusal names no admitted id", () => {
    // The written-off hold. `x402SettlementPending` withholds the id there on
    // purpose: the operator closed the refund out, so the id it was
    // recorded under is dead and only a *fresh* drain reclaims. Recording the
    // absent one would jam the reclaim on exactly the id `accept` refuses.
    const adopted = adoptWedgedChannelDrain({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      data: { settlement_id: "s-1", settlement_status: "written_off" },
    });

    expect(adopted).toBeUndefined();
    expect(recordPendingDrain).not.toHaveBeenCalled();
    expect(clearPendingDrain).not.toHaveBeenCalled();
    expect(recordCreditX402Instrument).not.toHaveBeenCalled();
    expect(ensureProvisionalCredit).not.toHaveBeenCalled();
  });

  it("records nothing for an absent, empty or non-string id", () => {
    for (const data of [
      undefined,
      {},
      refusalData({ settlement_drain_id: "" }),
      refusalData({ settlement_drain_id: 7 }),
    ]) {
      expect(
        adoptWedgedChannelDrain({
          endpoint: ENDPOINT,
          callerPubkey: PUBKEY,
          creditId: "credit-1",
          data,
        })
      ).toBeUndefined();
    }
    expect(recordPendingDrain).not.toHaveBeenCalled();
  });

  it("never keys on drain_registered, which these doors deliberately omit", () => {
    // `drain_registered` answers whether the id *this request* posted was
    // registered. Neither money-adding door posts one, so the server withholds
    // the field — and the adoption keying on `settlement_drain_id` alone is what
    // keeps the two questions apart.
    expect(adopt({ data: refusalData({ drain_registered: false }) })).toMatchObject({
      drainId: "wedged-drain",
    });
    expect(recordPendingDrain).toHaveBeenCalled();
  });
});

describe("the reclaim command", () => {
  it("is bare when the tracked record names this credit, or there is none", () => {
    expect(reclaimCommand(ENDPOINT, stored(), "credit-1")).toBe(`dvm credit drain ${ENDPOINT}`);
    expect(reclaimCommand(ENDPOINT, undefined, "credit-1")).toBe(`dvm credit drain ${ENDPOINT}`);
  });

  it("names the credit when the record tracks another", () => {
    expect(reclaimCommand(ENDPOINT, stored({ creditId: "credit-other" }), "credit-1")).toBe(
      `dvm credit drain ${ENDPOINT} --credit-id credit-1`
    );
  });

  it("shell-quotes both halves", () => {
    expect(creditDrainCommand("https://x.example/a b", "credit 1")).toBe(
      "dvm credit drain 'https://x.example/a b' --credit-id 'credit 1'"
    );
  });
});

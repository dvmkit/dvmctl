/**
 * `dvmctl credit liability`. The route contract is asserted in
 * `@dvmkit/sdk/server`; what only this suite covers
 * is the CLI's own half — that the floor sums across every DVM the hub backs
 * rather than reading one of them, that supplying the hub balance turns the
 * read into the sweep decision, and that a hub short of what callers are owed
 * says so instead of publishing a negative number nobody reads.
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
    dvmId: "dvm-fixture-2208",
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
const getBitcoinLiability = vi.fn();

import { DvmError } from "@dvmkit/sdk/internal";

import type { AdminBitcoinLiabilityResponse } from "../../../lib/admin-cashu-client";
import {
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../../lib/cashu/builder-lock-identity";
import * as output from "../../../shared/output";
import { creditLiability } from "../credit-liability";

const ENDPOINT = "https://dvm.example.com";

function liability(
  overrides: Partial<AdminBitcoinLiabilityResponse> = {}
): AdminBitcoinLiabilityResponse {
  return {
    deposit_liability_sats: 1_142,
    deposit_credits: 1,
    deposit_by_rail: [{ rail: "lightning", sats: 1_142, credits: 1 }],
    deposit_by_currency: [{ currency: "usd", micro: 1_142_000, credits: 1 }],
    drain_liability_sats: 400,
    drain_count: 1,
    total_owed_sats: 1_542,
    uncovered_credits: 0,
    uncovered_micro: 0,
    unbacked_credits: 0,
    unbacked_micro: 0,
    unpriced_drains: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const keyring = {
    canonicalDvmId: "dvm-fixture-2208",
    currentKeypair: { privkey: "11".repeat(32), pubkey: "02" + "aa".repeat(32) },
    keypairsByPubkey: new Map(),
  } as never;
  vi.mocked(resolveBuilderLockKeyring).mockReturnValue(keyring);
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue(keyring);
  clientCtorSpy.mockReturnValue({ getBitcoinLiability });
  getBitcoinLiability.mockResolvedValue(liability());
});

describe("dvmctl credit liability", () => {
  it("reports what callers are owed, split between deposits and reclaims", async () => {
    await creditLiability(["scrape"], { endpoint: ENDPOINT });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_liability",
      handles: ["scrape"],
      deposit_liability_sats: 1_142,
      drain_liability_sats: 400,
      total_owed_sats: 1_542,
      hub_sats: null,
      sweepable_sats: null,
      solvent: null,
    });
    expect((body.dvms as Record<string, unknown>[])[0]).toMatchObject({
      handle: "scrape",
      dvm_id: "dvm-fixture-2208",
    });
    // Without a hub balance the command cannot decide the sweep, so it says
    // what to do with the figure rather than implying one.
    expect(String(body.hint)).toContain("--hub-sats");
  });

  /**
   * One hub normally backs every first-party DVM, so a sweep netted against a
   * single DVM's floor is wrong by all the others. Reading them together is
   * the whole reason this verb takes a list.
   */
  it("sums the floor across every DVM the hub backs", async () => {
    getBitcoinLiability.mockResolvedValueOnce(liability()).mockResolvedValueOnce(
      liability({
        deposit_liability_sats: 858,
        drain_liability_sats: 0,
        total_owed_sats: 858,
      })
    );

    await creditLiability(["scrape", "cast"], { endpoint: ENDPOINT });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      deposit_liability_sats: 2_000,
      drain_liability_sats: 400,
      total_owed_sats: 2_400,
    });
    expect(body.dvms).toHaveLength(2);
  });

  it("turns a hub balance into the sweep decision", async () => {
    await creditLiability(["scrape"], { endpoint: ENDPOINT, hubSats: "10000" });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      hub_sats: 10_000,
      sweepable_sats: 8_458,
      solvent: true,
    });
    expect(String(body.display)).toContain("8458 sats");
  });

  /**
   * A hub below the floor is an operational error to repair, never a routine
   * state and never something to sweep around. It has to read as
   * one rather than as a small sweepable figure.
   */
  it("says plainly when the hub is short of what callers are owed", async () => {
    await creditLiability(["scrape"], { endpoint: ENDPOINT, hubSats: "1000" });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ sweepable_sats: -542, solvent: false });
    expect(String(body.display)).toContain("542 sats less than callers are owed");
  });

  it("flags balance no in-kind figure covers instead of quietly omitting it", async () => {
    getBitcoinLiability.mockResolvedValue(
      liability({ unbacked_credits: 2, unbacked_micro: 750_000 })
    );
    await creditLiability(["scrape"], { endpoint: ENDPOINT });

    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(String(body.gap_note)).toContain("2 credit(s)");
    expect(String(body.gap_note)).toContain("denomination and amount are unknown");
    expect(String(body.gap_note)).not.toContain("0.750000");
    expect(body.gap_by_currency).toEqual([]);
    expect(body.gap_unknown_credits).toBe(2);
  });

  it("refuses a hub balance that is not a whole number of sats", async () => {
    await expect(
      creditLiability(["scrape"], { endpoint: ENDPOINT, hubSats: "0.5" })
    ).rejects.toBeInstanceOf(DvmError);
    expect(getBitcoinLiability).not.toHaveBeenCalled();
  });

  it("prints a line per DVM and one verdict under --human", async () => {
    await creditLiability(["scrape"], { endpoint: ENDPOINT, hubSats: "10000", human: true });

    expect(vi.mocked(output.json)).not.toHaveBeenCalled();
    expect(vi.mocked(output.raw).mock.calls[0][0]).toContain("scrape");
    expect(vi.mocked(output.info).mock.calls[0][0]).toContain("8458 sats are earnings");
  });
});

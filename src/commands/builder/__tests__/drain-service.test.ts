/**
 * The builder-side drain batch job. Covers the acceptance-critical
 * behaviours at the unit level: cashu park via a caller-locked swap, the
 * mint-down tick failing and the next tick completing (the cron-retry
 * criterion), and the stablecoin rails' classification into the operator's
 * worklist versus the channel's own close. Cashu is the only rail this job
 * settles — direct Lightning payout is unsupported.
 */
import { Amount, getDecodedToken, getEncodedToken, type Token } from "@cashu/cashu-ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  type BuilderLockKeypair,
  DvmError,
  type LockPubkey,
  NwcError,
  toLockPubkey,
} from "@dvmkit/sdk/internal";

import type { AdminCashuClient, AdminPendingDrain } from "../../../lib/admin-cashu-client";
import { AdminApiError } from "../../../lib/admin-cashu-client";
import * as parkLog from "../../../lib/drain-park-log";
import { type DrainServiceContext, serviceDrains } from "../drain-service";

const KEYSET_ID = "009a1f293253e41e";
const LOCK_PUBKEY = "02" + "aa".repeat(32);
const REFUND_PUBKEY = "02" + "cd".repeat(32);
const PRIVKEY = "11".repeat(32);

/**
 * The nonce is per-proof on purpose. Real Cashu secrets are unique by
 * construction and the accumulator enforces it (`UNIQUE (dvm_id,
 * proof_secret_hash)`), so a fixture that reused one secret across proofs
 * modelled a state the schema forbids — and hid the untouched-input case
 * `parkOne` has to partition on.
 */
function p2pkSecret(pubkey: string, nonce: string): string {
  return JSON.stringify(["P2PK", { nonce, data: pubkey }]);
}

/** A second ESM evaluation models the SDK's separately bundled cashu-ts copy. */
async function foreignAmount(value: number): Promise<{ toBigInt(): bigint }> {
  const foreign = await import(
    `${import.meta.resolve("@cashu/cashu-ts")}?drain-service-foreign-amount`
  );
  const ForeignAmount = foreign.Amount;
  const amount = ForeignAmount.from(value);
  expect(ForeignAmount).not.toBe(Amount);
  expect(amount).not.toBeInstanceOf(Amount);
  return amount;
}

function pendingCashuDrain(overrides: Partial<AdminPendingDrain> = {}): AdminPendingDrain {
  return {
    credit_id: "c1",
    drain_id: "d1",
    method: "cashu",
    payout: { refund_pubkey: REFUND_PUBKEY },
    currency: "usd",
    amount_micro: 400_000,
    amount_sats: 400,
    amount_msats: 400_000,
    amount_native: 400,
    sats_basis: "in_kind",
    settlement: "automatic",
    channel_id: null,
    created_at: 1,
    ...overrides,
  };
}

/**
 * A one-payment stablecoin drain — the shape `serviceDrains` files for a person.
 * Unpriced in sats by construction, and `amount_native` is the
 * figure the operator's payout is sized in.
 */
function pendingStablecoinDrain(overrides: Partial<AdminPendingDrain> = {}): AdminPendingDrain {
  return {
    credit_id: "imp:x402:0xabc",
    drain_id: "d-x402",
    method: "x402",
    payout: { address: "0x" + "12".repeat(20) },
    currency: "usd",
    amount_micro: 400_000,
    amount_sats: null,
    amount_msats: null,
    amount_native: 400_000,
    sats_basis: "in_kind",
    settlement: "manual",
    channel_id: null,
    created_at: 1,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<DrainServiceContext> = {}): {
  ctx: DrainServiceContext;
  client: {
    getPendingDrains: ReturnType<typeof vi.fn>;
    getPendingBatches: ReturnType<typeof vi.fn>;
    parkDrain: ReturnType<typeof vi.fn>;
    markDrainSent: ReturnType<typeof vi.fn>;
  };
} {
  const client = {
    getPendingDrains: vi.fn().mockResolvedValue({
      drains: [],
      liability: { cashu_sats: 0, by_method_micro: {} },
    }),
    getPendingBatches: vi.fn().mockResolvedValue({ batches: [] }),
    parkDrain: vi.fn().mockResolvedValue({ status: "parked" }),
    markDrainSent: vi.fn().mockResolvedValue({ status: "sent" }),
  };
  const keypairs = new Map<LockPubkey, BuilderLockKeypair>([
    [toLockPubkey(LOCK_PUBKEY), { privkey: PRIVKEY, pubkey: LOCK_PUBKEY }],
  ]);
  const ctx: DrainServiceContext = {
    dvmId: "dvm-fixture-1",
    handle: "test",
    client: client as unknown as AdminCashuClient,
    keypairsByPubkey: keypairs,
    ...overrides,
  };
  return { ctx, client };
}

/**
 * A cashu-ts `wallet.ops.send(...)` chain stub ending in `run()`, carrying the
 * NUT-02 fee helpers `swapSendReserve` reads off a loaded mint.
 *
 * `ppk` is the keyset's `input_fee_ppk`, defaulting to the zero-fee mint every
 * other case here assumes. The helper bodies are lifted from cashu-ts, and
 * `Amount` / `splitAmount` are the library's own (this file mocks no module
 * from it), so what the batch sizing is pinned against is the arithmetic the
 * mint will actually perform — not a second model that could agree with our
 * code and disagree with the mint.
 */
function opsWallet(
  run: ReturnType<typeof vi.fn>,
  ppk = 0
): {
  wallet: unknown;
  send: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  includeFees: ReturnType<typeof vi.fn>;
} {
  const chain = {
    asLocked: vi.fn(() => chain),
    keepAsLocked: vi.fn(() => chain),
    privkey: vi.fn(() => chain),
    includeFees: vi.fn(() => chain),
    run,
  };
  const keys: Record<number, string> = {};
  for (let amount = 1; amount <= 1024; amount *= 2) keys[amount] = "02" + "cc".repeat(32);
  const feeFor = (nInputs: number): Amount =>
    Amount.from(Math.max(Math.floor((nInputs * ppk + 999) / 1000), 0));
  const send = vi.fn(() => chain);
  const wallet = {
    ops: { send },
    getKeyset: () => ({ id: KEYSET_ID, fee: ppk, keys }),
    getFeesForKeyset: (nInputs: number, id: string) => {
      if (id !== KEYSET_ID) throw new Error(`No keyset found with ID ${id}`);
      return feeFor(nInputs);
    },
    getFeesForProofs: (proofs: { id: string }[]) => feeFor(proofs.length),
  };
  return { wallet, send, run, includeFees: chain.includeFees };
}

function batch() {
  return {
    mint_url: "https://mint.example.com",
    lock_pubkey: LOCK_PUBKEY,
    row_ids: ["r1", "r2"],
    proofs: [
      {
        id: KEYSET_ID,
        amount: 256,
        secret: p2pkSecret(LOCK_PUBKEY, "in-1"),
        C: "02" + "11".repeat(32),
      },
      {
        id: KEYSET_ID,
        amount: 256,
        secret: p2pkSecret(LOCK_PUBKEY, "in-2"),
        C: "02" + "22".repeat(32),
      },
    ],
    total_sats: 512,
    t_expire: null,
  };
}

/**
 * A batch holding exactly `totalSats`, in power-of-two denominations plus a
 * remainder — the legacy-keyset shape, where holdings sit on the old fee-free
 * target and the swap's real cost is what decides whether they cover it.
 */
function thinBatch(totalSats: number) {
  const amounts = [256, 128, 16];
  const remainder = totalSats - 400;
  if (remainder > 0) amounts.push(remainder);
  return {
    mint_url: "https://mint.example.com",
    lock_pubkey: LOCK_PUBKEY,
    row_ids: amounts.map((_, i) => `t${i + 1}`),
    proofs: amounts.map((amount, i) => ({
      id: KEYSET_ID,
      amount,
      secret: p2pkSecret(LOCK_PUBKEY, `thin-${i + 1}`),
      C: "02" + "66".repeat(32),
    })),
    total_sats: totalSats,
    t_expire: null,
  };
}

function swapResult() {
  return {
    send: [
      {
        id: KEYSET_ID,
        amount: 400,
        secret: p2pkSecret(REFUND_PUBKEY, "out-send"),
        C: "02" + "33".repeat(32),
      },
    ],
    keep: [
      {
        id: KEYSET_ID,
        amount: 112,
        secret: p2pkSecret(LOCK_PUBKEY, "out-change"),
        C: "02" + "44".repeat(32),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parkLog.readUnparked).mockReturnValue([]);
  vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([]);
});

describe("serviceDrains — cashu park", () => {
  it("swaps a covering batch into a caller-locked token and parks it (logging the token first)", async () => {
    const run = vi.fn().mockResolvedValue(swapResult());
    const { wallet } = opsWallet(run);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [batch()] });

    const summary = await serviceDrains(ctx);

    expect(summary).toMatchObject({
      fetched: true,
      drains_seen: 1,
      drains_parked: 1,
      drains_failed: 0,
      cashu_liability_sats_after: 0,
    });
    // Recovery entry hits disk BEFORE the park POST — the token is the money.
    expect(parkLog.appendSwapped).toHaveBeenCalledTimes(1);
    const swapped = vi.mocked(parkLog.appendSwapped).mock.calls[0][0];
    expect(swapped.consumed_row_ids).toEqual(["r1", "r2"]);
    expect(swapped.token).toMatch(/^cashu/);
    expect(client.parkDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        credit_id: "c1",
        drain_id: "d1",
        consumed_row_ids: ["r1", "r2"],
        keep_proofs: [expect.objectContaining({ amount: 112 })],
      })
    );
    expect(parkLog.appendParked).toHaveBeenCalledTimes(1);
  });

  it("bridges SDK-wallet Amounts at both sides of the swap boundary", async () => {
    const foreign = await foreignAmount(400);
    const foreignProof = {
      id: KEYSET_ID,
      amount: foreign,
      secret: p2pkSecret(REFUND_PUBKEY, "foreign-send"),
      C: "02" + "55".repeat(32),
    };
    const foreignChange = {
      id: KEYSET_ID,
      amount: await foreignAmount(112),
      secret: p2pkSecret(LOCK_PUBKEY, "foreign-change"),
      C: "02" + "56".repeat(32),
    };
    // This is the production failure: cashu-ts rejects an Amount from another
    // bundle even though its represented value is valid.
    expect(() =>
      getEncodedToken({
        mint: "https://mint.example.com",
        proofs: [foreignProof],
      } as unknown as Token)
    ).toThrow();

    const run = vi.fn().mockResolvedValue({ send: [foreignProof], keep: [foreignChange] });
    const { wallet, send } = opsWallet(run);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [batch()] });

    await serviceDrains(ctx);

    // Incoming proofs remain JSON primitives for the SDK wallet's own amount
    // normalization; no local Amount instance crosses into its bundle.
    expect(send.mock.calls[0][1][0].amount).toBe(256);
    const token = vi.mocked(parkLog.appendSwapped).mock.calls[0][0].token;
    expect(getDecodedToken(token, [KEYSET_ID]).proofs[0].amount.toNumber()).toBe(400);
    expect(client.parkDrain).toHaveBeenCalledWith(
      expect.objectContaining({ keep_proofs: [expect.objectContaining({ amount: 112 })] })
    );
  });

  /**
   * Untouched swap inputs must remain spendable. A mint hands
   * back the inputs it never had to touch inside `keep`, mixed in with the
   * change it minted. Reporting the whole batch as consumed marks live money
   * `drained`, and re-sending an untouched proof as change collides on the
   * accumulator's `(dvm_id, proof_secret_hash)` guard — so every park 500s on
   * any DVM whose batch holds a denomination the refund doesn't need.
   */
  it("reports only what the mint spent — an untouched input is neither consumed nor change", async () => {
    const inputs = batch();
    const run = vi.fn().mockResolvedValue({
      send: [
        {
          id: KEYSET_ID,
          amount: 400,
          secret: p2pkSecret(REFUND_PUBKEY, "out-send"),
          C: "02" + "33".repeat(32),
        },
      ],
      keep: [
        // r2 came back exactly as we sent it — the mint only needed r1.
        inputs.proofs[1],
        {
          id: KEYSET_ID,
          amount: 112,
          secret: p2pkSecret(LOCK_PUBKEY, "out-change"),
          C: "02" + "44".repeat(32),
        },
      ],
    });
    const { wallet } = opsWallet(run);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [inputs] });

    const summary = await serviceDrains(ctx);

    expect(summary).toMatchObject({ drains_parked: 1, drains_failed: 0 });
    expect(client.parkDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        consumed_row_ids: ["r1"],
        keep_proofs: [expect.objectContaining({ amount: 112 })],
      })
    );
    // The recovery log records the same partition, or a re-POST would re-mark
    // the untouched row drained.
    expect(vi.mocked(parkLog.appendSwapped).mock.calls[0][0].consumed_row_ids).toEqual(["r1"]);
  });

  it("fails the park rather than posting one that spends nothing", async () => {
    const inputs = batch();
    const run = vi.fn().mockResolvedValue({
      send: [
        {
          id: KEYSET_ID,
          amount: 400,
          secret: p2pkSecret(REFUND_PUBKEY, "out-send"),
          C: "02" + "33".repeat(32),
        },
      ],
      keep: inputs.proofs,
    });
    const { wallet } = opsWallet(run);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [inputs] });

    const summary = await serviceDrains(ctx);

    expect(summary).toMatchObject({ drains_parked: 0, drains_failed: 1 });
    expect(client.parkDrain).not.toHaveBeenCalled();
    expect(parkLog.appendSwapped).not.toHaveBeenCalled();
  });

  it("mint down ⇒ the drain stays pending and holds melts; the next tick completes it", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("mint unreachable"))
      .mockResolvedValueOnce(swapResult());
    const { wallet } = opsWallet(run);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [batch()] });

    const firstTick = await serviceDrains(ctx);
    expect(firstTick).toMatchObject({ drains_parked: 0, drains_failed: 1 });
    // Non-zero outstanding liability is what melt-pending's holdback keys on.
    expect(firstTick.cashu_liability_sats_after).toBe(400);
    expect(client.parkDrain).not.toHaveBeenCalled();

    const secondTick = await serviceDrains(ctx);
    expect(secondTick).toMatchObject({
      drains_parked: 1,
      drains_failed: 0,
      cashu_liability_sats_after: 0,
    });
  });

  it("re-POSTs a swapped-but-unparked token from the recovery log before fresh work", async () => {
    const { ctx, client } = makeCtx();
    vi.mocked(parkLog.readUnparked).mockReturnValueOnce([
      {
        kind: "swapped",
        ts: 1,
        dvm_id: "dvm-fixture-1",
        credit_id: "c1",
        drain_id: "d1",
        token: "cashuBrecovered",
        consumed_row_ids: ["r1"],
        keep_proofs: [],
      },
    ]);
    const summary = await serviceDrains(ctx);
    expect(client.parkDrain).toHaveBeenCalledWith(
      expect.objectContaining({ token: "cashuBrecovered" })
    );
    expect(summary.recovered).toBe(1);
  });

  it("leaves a drain no single batch covers, with an honest log", async () => {
    const { ctx, client } = makeCtx();
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain({ amount_sats: 10_000, amount_msats: 10_000_000 })],
      liability: { cashu_sats: 10_000, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [batch()] });
    const summary = await serviceDrains(ctx);
    // `queued`, not `failed`: no swap was attempted and no send wallet is
    // wired to buy the refund instead, so nothing went wrong — there was
    // simply nothing this tick could do.
    expect(summary).toMatchObject({ drains_failed: 0, drains_queued: 1 });
    expect(summary.cashu_liability_sats_after).toBe(10_000);
    expect(client.parkDrain).not.toHaveBeenCalled();
  });

  /**
   * Swap selection must include the mint fee. The old cover test was
   * `total_sats >= amountSats` — the fee-free target — while the swap costs
   * `amountSats + swapFee(inputs)`. Holdings equal to the old target are
   * exactly the shape that used to be selected, refused by the mint, and
   * reported as a generic `drain_swap_failed`: a permanent stall, since `find`
   * re-picked the same too-thin batch on every subsequent tick.
   *
   * At 100 ppk the three-input swap costs 1 sat, so 401 is required against
   * 400 held. The receiver-fee term is excluded from that sum — the caller
   * pays their own redeem fee now — so the gap narrowed by a sat without the
   * failure mode changing.
   */
  it("skips a batch that covers the refund but not the mint's swap cost", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const run = vi.fn().mockResolvedValue(swapResult());
    const { wallet, send } = opsWallet(run, 100);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [thinBatch(400)] });

    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    expect(summary).toMatchObject({ drains_parked: 0, drains_queued: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(client.parkDrain).not.toHaveBeenCalled();
    expect(parkLog.appendSwapped).not.toHaveBeenCalled();

    // Distinguishable from both a mint outage (`drain_swap_failed`) and an
    // accumulator that simply has nothing in it (`drain_park_insufficient_batch`).
    const line = logs.find((l) => l.includes("drain_park_batch_below_swap_cost"));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      amount_sats: 400,
      total_sats: 400,
      // 400 sats of refund plus the mint's own per-input swap fee.
      // The caller pays their own redeem fee, so the batch no longer
      // has to carry that second sat.
      required_sats: 401,
      short_by_sats: 1,
      mint_url: "https://mint.example.com",
    });
    expect(logs.some((l) => l.includes("drain_swap_failed"))).toBe(false);
  });

  /**
   * The obligation is in kind — the sats you deposited, pro rata,
   * minus what it costs to hand them back — so the notes carry the recorded
   * figure at face value and the caller pays their own redeem fee. Covering it
   * would pay it out of a deposit pot holding exactly what was deposited.
   */
  it("hands the caller notes at face value rather than covering their redeem fee", async () => {
    const run = vi.fn().mockResolvedValue(swapResult());
    const { wallet, send, includeFees } = opsWallet(run, 100);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [batch()] });

    const summary = await serviceDrains(ctx);

    expect(summary).toMatchObject({ drains_parked: 1 });
    expect(send).toHaveBeenCalledWith(400, expect.anything());
    expect(includeFees).toHaveBeenCalledWith(false);
  });

  it("parks off a fatter batch rather than wedging on the first one", async () => {
    const run = vi.fn().mockResolvedValue(swapResult());
    const { wallet } = opsWallet(run, 100);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    // The thin batch clears the old fee-free test and comes first, so the old
    // `find` stopped there and never reached the one that can actually pay.
    client.getPendingBatches.mockResolvedValue({ batches: [thinBatch(400), batch()] });

    const summary = await serviceDrains(ctx);

    expect(summary).toMatchObject({ drains_parked: 1, drains_failed: 0 });
    expect(client.parkDrain).toHaveBeenCalledWith(
      expect.objectContaining({ consumed_row_ids: ["r1", "r2"] })
    );
  });

  it("clears the same shape with one more sat in the batch", async () => {
    const run = vi.fn().mockResolvedValue({
      send: [
        {
          id: KEYSET_ID,
          amount: 400,
          secret: p2pkSecret(REFUND_PUBKEY, "thin-send"),
          C: "02" + "55".repeat(32),
        },
      ],
      keep: [],
    });
    const { wallet } = opsWallet(run, 100);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [thinBatch(401)] });

    const summary = await serviceDrains(ctx);

    expect(summary).toMatchObject({ drains_parked: 1, drains_failed: 0 });
    expect(client.parkDrain).toHaveBeenCalledWith(
      expect.objectContaining({ consumed_row_ids: ["t1", "t2", "t3", "t4"] })
    );
  });

  it("keeps looking when one mint won't price a keyset", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const run = vi.fn().mockResolvedValue(swapResult());
    const { wallet } = opsWallet(run, 100);
    const walletProvider = vi.fn(async (mintUrl: string) => {
      if (mintUrl === "https://sick.mint.example.com") throw new Error("mint unreachable");
      return wallet;
    });
    const { ctx, client } = makeCtx({
      walletProvider: walletProvider as unknown as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({
      batches: [{ ...batch(), mint_url: "https://sick.mint.example.com" }, batch()],
    });

    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    expect(summary).toMatchObject({ drains_parked: 1, drains_failed: 0 });
    expect(logs.some((l) => l.includes("drain_park_batch_unpriceable"))).toBe(true);
  });

  it("says a mint is down rather than blaming the accumulator", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const walletProvider = vi.fn(() => Promise.reject(new Error("mint unreachable")));
    const { ctx, client } = makeCtx({
      walletProvider: walletProvider as unknown as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain()],
      liability: { cashu_sats: 400, by_method_micro: {} },
    });
    client.getPendingBatches.mockResolvedValue({
      batches: [{ ...batch(), mint_url: "https://sick.mint.example.com" }],
    });

    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    expect(summary).toMatchObject({ drains_parked: 0, drains_queued: 1 });
    // The accumulator may well hold the money — nothing here proves otherwise —
    // so the terminal line must not be the one that tells the operator to fund.
    expect(logs.some((l) => l.includes("drain_park_insufficient_batch"))).toBe(false);
    const line = logs.find((l) => l.includes("drain_park_no_priceable_batch"));
    expect(line).toBeDefined();
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      amount_sats: 400,
      unpriceable_mints: ["https://sick.mint.example.com"],
    });
  });
});

/**
 * Every non-404 fetch failure used to collapse into `fetched: false`,
 * which the caller reads as "unknown, hold and retry". That is the right read
 * for a DVM that is down and the wrong one for a DVM whose advertised lock
 * pubkey we cannot sign for — a fault no number of retries fixes.
 */
describe("serviceDrains — an unreadable drain surface", () => {
  it("throws admin_bad_signature rather than reporting an unknown state", async () => {
    const { ctx, client } = makeCtx();
    client.getPendingDrains.mockRejectedValue(
      new AdminApiError(401, { error: "unauthorized", reason: "bad_signature", raw: {} })
    );
    await expect(serviceDrains(ctx)).rejects.toMatchObject({ code: "admin_bad_signature" });
  });

  it("preserves admin_state_unavailable guidance rather than reporting an unknown state", async () => {
    const { ctx, client } = makeCtx();
    client.getPendingDrains.mockRejectedValue(
      new DvmError(
        "admin_state_unavailable",
        "The requested DVM operation did not run.",
        "Retry, then inspect database health."
      )
    );

    await expect(serviceDrains(ctx)).rejects.toMatchObject({
      code: "admin_state_unavailable",
      hint: "Retry, then inspect database health.",
    });
  });

  it("still reports fetched: false on a transport error — that one may fix itself", async () => {
    const { ctx, client } = makeCtx();
    client.getPendingDrains.mockRejectedValue(new Error("ECONNREFUSED"));
    const summary = await serviceDrains(ctx);
    expect(summary.fetched).toBe(false);
  });

  it("reports fetched: true on a 404 — a DVM predating the surface owes nothing", async () => {
    const { ctx, client } = makeCtx();
    client.getPendingDrains.mockRejectedValue(
      new AdminApiError(404, { error: "not_found", raw: {} })
    );
    const summary = await serviceDrains(ctx);
    expect(summary).toMatchObject({ fetched: true, drains_seen: 0 });
  });
});

/**
 * The manual arm. These refunds are real debts the loop can never
 * pay — no builder-held chain send key exists — so what the pass owes an
 * operator is an accurate count and a log line naming everything they need to
 * settle from. It must also not silently look like a failure, or like something
 * the melt should wait behind.
 */
describe("serviceDrains — manual stablecoin settlement", () => {
  function manualLines(logs: string[]): Record<string, unknown>[] {
    return logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.level === "drain_manual_settlement_required");
  }

  it("files each stablecoin drain for a person, attempting nothing on its behalf", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const { ctx, client } = makeCtx();
    client.getPendingDrains.mockResolvedValue({
      drains: [
        pendingStablecoinDrain(),
        pendingStablecoinDrain({
          credit_id: "imp:mpp:0xdef",
          drain_id: "d-tempo",
          method: "tempo",
          amount_micro: 250_000,
          amount_native: 250_000,
        }),
      ],
      liability: {
        cashu_sats: 0,
        by_method_micro: { x402: 400_000, tempo: 250_000 },
        manual_micro: 650_000,
      },
    });

    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    expect(summary).toMatchObject({
      fetched: true,
      drains_seen: 2,
      drains_manual: 2,
      drains_parked: 0,
      // Not a failure: nothing was tried and nothing went wrong. Counting these
      // as failures is what would make a healthy DVM look broken every tick.
      drains_failed: 0,
    });
    expect(client.parkDrain).not.toHaveBeenCalled();
    expect(client.markDrainSent).not.toHaveBeenCalled();

    const lines = manualLines(logs);
    expect(lines).toHaveLength(2);
    // Everything an operator needs to send the money is on the line itself,
    // including `amount_native` — the payout is sized in the token's units, not
    // the ledger's fiat micro.
    expect(lines[0]).toMatchObject({
      credit_id: "imp:x402:0xabc",
      drain_id: "d-x402",
      method: "x402",
      payout: { address: "0x" + "12".repeat(20) },
      amount_micro: 400_000,
      amount_native: 400_000,
    });
    expect(lines[1]).toMatchObject({ drain_id: "d-tempo", method: "tempo", amount_micro: 250_000 });
    // The hint names a command that exists, with this DVM's own ids in it.
    expect(String(lines[0].hint)).toContain(
      "dvmctl credit drain-settle test imp:x402:0xabc d-x402 --tx <hash>"
    );
    expect(String(lines[1].hint)).toContain("dvmctl credit drains-owed test");
  });

  it("does not hold the payout melt behind a debt the melt cannot pay", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const run = vi.fn().mockRejectedValue(new Error("mint down"));
    const { wallet } = opsWallet(run);
    const { ctx, client } = makeCtx({
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain(), pendingStablecoinDrain()],
      liability: {
        cashu_sats: 400,
        by_method_micro: { cashu: 400_000, x402: 400_000 },
        manual_micro: 400_000,
      },
    });
    client.getPendingBatches.mockResolvedValue({ batches: [thinBatch(512)] });

    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    // `failed` here rather than `queued`: this batch covers the refund, so the
    // swap really was attempted and the mint really did refuse it.
    expect(summary).toMatchObject({ drains_manual: 1, drains_failed: 1 });
    // `cashu_liability_sats_after` is what holds the melt back, and it counts
    // only the cashu row: a stablecoin refund comes out of a wallet the melt
    // never touches, so holding the melt for it would stall the builder's
    // payout on a debt melting can never clear.
    expect(summary.cashu_liability_sats_after).toBe(400);
  });

  it("leaves a channel-backed reclaim to its own close, off the operator's worklist", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(line);
    });
    const { ctx, client } = makeCtx();
    client.getPendingDrains.mockResolvedValue({
      drains: [
        pendingStablecoinDrain({
          credit_id: "c-tempo",
          drain_id: "d-chan",
          method: "tempo",
          payout: {},
          sats_basis: "in_kind",
          settlement: "channel",
          channel_id: "chan-1",
        }),
        pendingStablecoinDrain(),
      ],
      liability: {
        cashu_sats: 0,
        by_method_micro: { x402: 400_000, tempo: 400_000 },
        manual_micro: 400_000,
        channel_micro: 400_000,
      },
    });

    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    // Counted apart from `drains_manual`, which is what keeps it out of
    // `drainsUnsettled`'s unsettled sum: `recoverTempoSessionClose` finishes
    // this row on the caller's next poll, so alarming a cron on it wakes an
    // operator for something they cannot act on.
    expect(summary).toMatchObject({
      drains_seen: 2,
      drains_channel: 1,
      drains_manual: 1,
      drains_failed: 0,
    });
    expect(client.markDrainSent).not.toHaveBeenCalled();

    expect(manualLines(logs).map((l) => l.drain_id)).toEqual(["d-x402"]);
    const channelLines = logs
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.level === "drain_channel_settlement_pending");
    expect(channelLines).toHaveLength(1);
    expect(channelLines[0]).toMatchObject({
      credit_id: "c-tempo",
      drain_id: "d-chan",
      method: "tempo",
      channel_id: "chan-1",
    });
    expect(String(channelLines[0].hint)).toContain("nothing to do");
    // The one channel drain a poll never clears has an operator verb now, and
    // the hint has to name it — this bucket is otherwise read as "ignore me".
    expect(String(channelLines[0].hint)).toContain("tempo-wedged");
  });
});

/**
 * Just-in-time minting. Everything below covers the path taken
 * when the accumulator cannot cover a refund at all, which for a
 * Lightning-funded credit is every time: quote at an accepted mint, pay that
 * quote from the hub, mint notes locked to the caller, park them.
 *
 * The property most of these are really about is **pay exactly once**. NIP-47
 * has no idempotency key and a fresh quote per retry would sidestep even the
 * wallet's own event dedup, so the safety comes entirely from the recovery log
 * and from what the servicer refuses to do while a quote is unresolved.
 */
describe("serviceDrains — just-in-time mint", () => {
  const MINT = "https://mint.example.com";
  const QUOTE_ID = "quote-1";
  const BOLT11 = "lnbc4u1pexampleinvoice";
  const NWC = {
    uri: "nostr+walletconnect://wallet?relay=wss://r.example&secret=" + "ab".repeat(32),
  };

  /** A mint stub carrying the quote lifecycle `advanceMintQuote` walks. */
  /**
   * A mint that tracks whether its quote has been settled, because the order
   * the worker reads that in is now load-bearing: a fresh quote reads UNPAID
   * until the invoice is paid, and only an UNPAID quote may ever be abandoned.
   * `settled: true` is a quote a previous run already paid for.
   */
  function mintWallet(
    opts: {
      quoteState?: string;
      settled?: boolean;
      expiry?: number | null;
      proofs?: { id: string; amount: number; secret: string; C: string }[];
      createQuote?: ReturnType<typeof vi.fn>;
    } = {}
  ) {
    let settled = opts.settled ?? false;
    const keys: Record<number, string> = {};
    for (let amount = 1; amount <= 1024; amount *= 2) keys[amount] = "02" + "cc".repeat(32);
    const createLockedMintQuote =
      opts.createQuote ??
      vi.fn().mockResolvedValue({
        quote: QUOTE_ID,
        request: BOLT11,
        amount: Amount.from(392),
        state: "UNPAID",
        expiry: null,
      });
    const checkMintQuoteBolt11 = vi.fn(async () => ({
      quote: QUOTE_ID,
      request: BOLT11,
      amount: Amount.from(392),
      state: opts.quoteState ?? (settled ? "PAID" : "UNPAID"),
      expiry: opts.expiry ?? null,
    }));
    const completeMint = vi.fn().mockResolvedValue(
      opts.proofs ?? [
        {
          id: KEYSET_ID,
          amount: 392,
          secret: p2pkSecret(REFUND_PUBKEY, "jit-1"),
          C: "02" + "77".repeat(32),
        },
      ]
    );
    const outputData = [
      {
        blindedMessage: {
          amount: Amount.from(392),
          B_: "02" + "88".repeat(32),
          id: KEYSET_ID,
        },
        blindingFactor: 1n,
        secret: new TextEncoder().encode(p2pkSecret(REFUND_PUBKEY, "jit-1")),
        toProof: vi.fn(),
      },
    ];
    const prepareMint = vi.fn().mockResolvedValue({ outputData, blindedMessages: [] });
    return {
      createLockedMintQuote,
      checkMintQuoteBolt11,
      prepareMint,
      completeMint,
      markSettled: () => {
        settled = true;
      },
      keyChain: { getKeysets: () => [{ id: KEYSET_ID, isActive: true, hasKeys: true, keys }] },
    };
  }

  function jitCtx(
    overrides: Partial<DrainServiceContext> = {},
    walletOverrides: Parameters<typeof mintWallet>[0] = {}
  ) {
    const wallet = mintWallet(walletOverrides);
    const payInvoice = vi.fn(async () => {
      // The mint sees the settlement the moment the invoice is paid.
      wallet.markSettled();
      return { preimage: "ff".repeat(32), feesPaidMsats: 1_100, outcome: "paid" };
    });
    const lookupInvoiceImpl = vi.fn();
    const { ctx, client } = makeCtx({
      currentKeypair: { privkey: PRIVKEY, pubkey: LOCK_PUBKEY },
      refundNwc: NWC,
      walletProvider: vi.fn().mockResolvedValue(wallet) as DrainServiceContext["walletProvider"],
      payInvoice: payInvoice as unknown as DrainServiceContext["payInvoice"],
      lookupInvoiceImpl: lookupInvoiceImpl as unknown as DrainServiceContext["lookupInvoiceImpl"],
      ...overrides,
    });
    // Nothing in the accumulator: the production shape a Lightning-funded
    // credit is always in, and the only reason this path runs at all.
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain({ amount_sats: 392, amount_msats: 392_000 })],
      liability: { cashu_sats: 392, by_method_micro: {} },
      mints: [MINT],
    });
    client.getPendingBatches.mockResolvedValue({ batches: [] });
    return { ctx, client, wallet, payInvoice, lookupInvoiceImpl };
  }

  function jitSwappedEntry() {
    return {
      kind: "swapped" as const,
      ts: 4,
      dvm_id: "dvm-fixture-1",
      credit_id: "c1",
      drain_id: "d1",
      token: "cashuBjit",
      consumed_row_ids: [],
      keep_proofs: [],
      mint_evidence: {
        source: "jit_mint" as const,
        mint_url: MINT,
        quote_id: QUOTE_ID,
        face_sats: 392,
        reserve_sats: 8,
        invoice_msats: 400_000,
        routing_fee_msats: 1_100,
      },
    };
  }

  function quoteEntry(overrides: Record<string, unknown> = {}) {
    return {
      kind: "mint_quote" as const,
      ts: 1,
      dvm_id: "dvm-fixture-1",
      credit_id: "c1",
      drain_id: "d1",
      mint_url: MINT,
      quote_id: QUOTE_ID,
      bolt11: BOLT11,
      invoice_msats: 392_400,
      face_sats: 392,
      reserve_sats: 8,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refund_pubkey: REFUND_PUBKEY,
      ...overrides,
    };
  }

  it("buys the refund, locks it to the caller, and parks it with its cost itemized", async () => {
    const { ctx, client, wallet, payInvoice } = jitCtx();
    const summary = await serviceDrains(ctx);

    expect(summary).toMatchObject({ drains_parked: 1, drains_jit_minted: 1, drains_failed: 0 });
    // Face value is the drain's published figure, not the gross: the reserve
    // came off when the reclaim was promised and pays for this purchase.
    expect(wallet.createLockedMintQuote).toHaveBeenCalledWith(392, LOCK_PUBKEY);
    // The quote is locked to the *builder* so nobody else can collect the
    // invoice we pay; the outputs are locked to the *caller*.
    expect(wallet.prepareMint).toHaveBeenCalledWith(
      "bolt11",
      392,
      expect.anything(),
      { privkey: PRIVKEY },
      expect.objectContaining({ type: "p2pk", options: { pubkey: REFUND_PUBKEY } })
    );
    expect(payInvoice).toHaveBeenCalledExactlyOnceWith(expect.anything(), BOLT11);
    expect(client.parkDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        credit_id: "c1",
        drain_id: "d1",
        consumed_row_ids: [],
        keep_proofs: [],
        mint_evidence: {
          source: "jit_mint",
          mint_url: MINT,
          quote_id: QUOTE_ID,
          face_sats: 392,
          reserve_sats: 8,
          invoice_msats: 400_000,
          routing_fee_msats: 1_100,
        },
      })
    );
  });

  it("encodes foreign SDK Amounts after the JIT mint/restore branch", async () => {
    const foreign = await foreignAmount(392);
    const { ctx } = jitCtx(
      {},
      {
        proofs: [
          {
            id: KEYSET_ID,
            amount: foreign as unknown as number,
            secret: p2pkSecret(REFUND_PUBKEY, "foreign-jit"),
            C: "02" + "66".repeat(32),
          },
        ],
      }
    );

    await serviceDrains(ctx);

    const token = vi.mocked(parkLog.appendSwapped).mock.calls[0][0].token;
    expect(getDecodedToken(token, [KEYSET_ID]).proofs[0].amount.toNumber()).toBe(392);
  });

  it("writes the quote to disk before paying it, and the outputs before minting", async () => {
    const { ctx, client, wallet, payInvoice } = jitCtx();
    const order: string[] = [];
    vi.mocked(parkLog.appendMintQuote).mockImplementation(() => void order.push("quote"));
    vi.mocked(parkLog.appendMintPaymentAttempt).mockImplementation(
      () => void order.push("attempt")
    );
    vi.mocked(parkLog.appendMintPaid).mockImplementation(() => void order.push("paid"));
    vi.mocked(parkLog.appendMintOutputs).mockImplementation(() => void order.push("outputs"));
    vi.mocked(parkLog.appendSwapped).mockImplementation(() => void order.push("swapped"));
    vi.mocked(parkLog.appendParked).mockImplementation(() => void order.push("parked"));

    await serviceDrains(ctx);

    // Each line lands before the step it makes recoverable, never after.
    expect(order).toEqual(["quote", "attempt", "paid", "outputs", "swapped", "parked"]);
    expect(vi.mocked(parkLog.appendMintQuote).mock.invocationCallOrder[0]).toBeLessThan(
      payInvoice.mock.invocationCallOrder[0]
    );
    expect(vi.mocked(parkLog.appendMintOutputs).mock.invocationCallOrder[0]).toBeLessThan(
      wallet.completeMint.mock.invocationCallOrder[0]
    );
    expect(vi.mocked(parkLog.appendSwapped).mock.invocationCallOrder[0]).toBeLessThan(
      client.parkDrain.mock.invocationCallOrder[0]
    );
  });

  it("queues the refund rather than buying it when no send wallet is wired", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const { ctx, client } = jitCtx({ refundNwc: undefined });
    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    expect(summary).toMatchObject({ drains_queued: 1, drains_jit_minted: 0, drains_failed: 0 });
    expect(client.parkDrain).not.toHaveBeenCalled();
    expect(summary.cashu_liability_sats_after).toBe(392);
    const line = logs.find((l) => l.includes("drain_jit_unconfigured"));
    expect(line).toBeDefined();
    expect(String(JSON.parse(line ?? "{}").hint)).toContain("--refund-nwc");
  });

  it("skips a mint that will not quote, naming its own error, and queues when none will", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const createQuote = vi.fn().mockRejectedValue(new Error("amount below mint minimum"));
    const { ctx, client } = jitCtx({}, { createQuote });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain({ amount_sats: 392, amount_msats: 392_000 })],
      liability: { cashu_sats: 392, by_method_micro: {} },
      mints: [MINT, "https://mint-b.example.com"],
    });
    const summary = await serviceDrains(ctx);
    spy.mockRestore();

    // Both mints tried, neither answered — and nothing was paid, so this is a
    // queue rather than a failure.
    expect(createQuote).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ drains_queued: 1, drains_jit_minted: 0 });
    expect(logs.filter((l) => JSON.parse(l).level === "drain_jit_quote_failed")).toHaveLength(2);
    const aggregate = logs.find((l) => l.includes("drain_jit_no_mint"));
    expect(JSON.parse(aggregate ?? "{}")).toMatchObject({
      mints_tried: [MINT, "https://mint-b.example.com"],
    });
    expect(String(JSON.parse(aggregate ?? "{}").error ?? "")).not.toContain("below mint minimum");
  });

  it("mints and parks on the next tick after a mint that was down (the cron-retry criterion)", async () => {
    const createQuote = vi
      .fn()
      .mockRejectedValueOnce(new Error("mint down"))
      .mockResolvedValue({
        quote: QUOTE_ID,
        request: BOLT11,
        amount: Amount.from(392),
        state: "UNPAID",
        expiry: null,
      });
    const { ctx, client } = jitCtx({}, { createQuote });
    const first = await serviceDrains(ctx);
    expect(first).toMatchObject({ drains_queued: 1, drains_jit_minted: 0 });
    expect(client.parkDrain).not.toHaveBeenCalled();

    const second = await serviceDrains(ctx);
    expect(second).toMatchObject({ drains_jit_minted: 1 });
    expect(client.parkDrain).toHaveBeenCalledTimes(1);
  });

  /**
   * `pay_invoice` sends whatever the invoice says, so the only bound on what
   * the hub can be made to spend is the one applied before it is asked. A mint
   * whose fee is misconfigured — or whose entry in the accepted list is not
   * what the operator thinks it is — must not be able to spend more than the
   * refund is worth.
   */
  it("refuses a quote asking for more than the refund plus its reserve, and tries the next mint", async () => {
    const greedy = mintWallet({
      createQuote: vi.fn().mockResolvedValue({
        quote: "quote-greedy",
        request: "lnbc40u1pgreedyinvoice",
        amount: Amount.from(392),
        state: "UNPAID",
        expiry: null,
      }),
    });
    const honest = mintWallet();
    const walletProvider = vi
      .fn()
      .mockImplementation(async (url: string) => (url === MINT ? greedy : honest));
    const payInvoice = vi.fn(async () => {
      honest.markSettled();
      return { preimage: "ff".repeat(32), feesPaidMsats: 1_100, outcome: "paid" };
    });
    const { ctx, client } = jitCtx({
      walletProvider: walletProvider as DrainServiceContext["walletProvider"],
      payInvoice: payInvoice as unknown as DrainServiceContext["payInvoice"],
    });
    client.getPendingDrains.mockResolvedValue({
      drains: [pendingCashuDrain({ amount_sats: 392, amount_msats: 392_000 })],
      liability: { cashu_sats: 392, by_method_micro: {} },
      mints: [MINT, "https://second.example.com"],
    });

    const summary = await serviceDrains(ctx);

    // Nothing was paid to the greedy mint, and no quote of its was recorded —
    // so nothing can recover it into a payment later either.
    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect(payInvoice).toHaveBeenCalledWith(expect.anything(), BOLT11);
    expect(parkLog.appendMintQuote).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ drains_jit_minted: 1 });
  });

  it("refuses a quote whose invoice amount it cannot read", async () => {
    const createQuote = vi.fn().mockResolvedValue({
      quote: "quote-amountless",
      request: "lnbc1pamountlessinvoice",
      amount: Amount.from(392),
      state: "UNPAID",
      expiry: null,
    });
    const { ctx, payInvoice } = jitCtx({}, { createQuote });
    const summary = await serviceDrains(ctx);

    expect(payInvoice).not.toHaveBeenCalled();
    expect(parkLog.appendMintQuote).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ drains_queued: 1, drains_jit_minted: 0 });
  });

  describe("crash recovery", () => {
    it("after the quote: asks the wallet before paying, and pays once when it never sent", async () => {
      const { ctx, client, payInvoice, lookupInvoiceImpl } = jitCtx();
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([{ quote: quoteEntry() }]);
      lookupInvoiceImpl.mockRejectedValue(new NwcError("NOT_FOUND", "no such invoice"));
      const summary = await serviceDrains(ctx);

      // The lookup ran first, and exactly one payment followed it.
      expect(lookupInvoiceImpl).toHaveBeenCalledWith(expect.anything(), { invoice: BOLT11 });
      expect(payInvoice).toHaveBeenCalledTimes(1);
      expect(summary.recovered).toBe(1);
      expect(client.parkDrain).toHaveBeenCalledTimes(1);
      // No second quote was opened for the same drain.
      expect(parkLog.appendMintQuote).not.toHaveBeenCalled();
    });

    it("retries the same invoice after a definitive wallet rejection", async () => {
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((line: string) => void logs.push(line));
      const { ctx, client, payInvoice, lookupInvoiceImpl } = jitCtx();
      payInvoice.mockRejectedValueOnce(
        new NwcError("INTERNAL", "PaymentSendingFailed", "pay_invoice")
      );

      const first = await serviceDrains(ctx);
      expect(first).toMatchObject({ drains_queued: 1, drains_jit_minted: 0 });
      expect(parkLog.appendMintPaymentRejected).toHaveBeenCalledWith(
        expect.objectContaining({ quote_id: QUOTE_ID, error_code: "INTERNAL" })
      );

      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([
        {
          quote: quoteEntry(),
          paymentRejected: {
            kind: "mint_payment_rejected",
            ts: 2,
            dvm_id: "dvm-fixture-1",
            credit_id: "c1",
            drain_id: "d1",
            quote_id: QUOTE_ID,
            error_code: "INTERNAL",
          },
        },
      ]);
      lookupInvoiceImpl.mockResolvedValue({
        type: "outgoing",
        paymentHash: "aa".repeat(32),
        amountMsats: 392_400,
        createdAt: 1,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      const second = await serviceDrains(ctx);
      spy.mockRestore();

      expect(second).toMatchObject({ recovered: 1, drains_jit_minted: 1 });
      expect(payInvoice).toHaveBeenCalledTimes(2);
      expect(payInvoice).toHaveBeenNthCalledWith(1, expect.anything(), BOLT11);
      expect(payInvoice).toHaveBeenNthCalledWith(2, expect.anything(), BOLT11);
      expect(parkLog.appendMintQuote).toHaveBeenCalledTimes(1);
      expect(parkLog.appendMintPaymentAttempt).toHaveBeenCalledTimes(2);
      expect(client.parkDrain).toHaveBeenCalledTimes(1);
      expect(logs.some((line) => line.includes("drain_jit_payment_failed"))).toBe(true);
      expect(logs.some((line) => line.includes("drain_jit_payment_retrying"))).toBe(true);
    });

    it("after the payment: recovers the settled invoice and never pays again", async () => {
      const { ctx, client, payInvoice, lookupInvoiceImpl } = jitCtx({}, { settled: true });
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([{ quote: quoteEntry() }]);
      lookupInvoiceImpl.mockResolvedValue({
        type: "outgoing",
        paymentHash: "aa".repeat(32),
        preimage: "ff".repeat(32),
        amountMsats: 392_400,
        feesPaidMsats: 900,
        createdAt: 1,
        settledAt: 2,
      });
      const summary = await serviceDrains(ctx);

      expect(payInvoice).not.toHaveBeenCalled();
      expect(parkLog.appendMintPaid).toHaveBeenCalledWith(
        expect.objectContaining({ recovered: true, fees_paid_msats: 900 })
      );
      expect(summary.recovered).toBe(1);
      expect(client.parkDrain).toHaveBeenCalledTimes(1);
    });

    it("after the mint: restores the proofs from the persisted outputs rather than re-minting", async () => {
      const { ctx, client, wallet } = jitCtx({}, { quoteState: "ISSUED" });
      (wallet as unknown as { mint: unknown }).mint = {
        restore: vi.fn().mockResolvedValue({ outputs: [], signatures: [] }),
      };
      (wallet as unknown as { keyChain: { getKeyset: unknown } }).keyChain = {
        ...wallet.keyChain,
        getKeyset: () => ({ id: KEYSET_ID }),
      };
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([
        {
          quote: quoteEntry(),
          paid: {
            kind: "mint_paid",
            ts: 2,
            dvm_id: "dvm-fixture-1",
            credit_id: "c1",
            drain_id: "d1",
            quote_id: QUOTE_ID,
            preimage: "ff".repeat(32),
          },
          outputs: {
            kind: "mint_outputs",
            ts: 3,
            dvm_id: "dvm-fixture-1",
            credit_id: "c1",
            drain_id: "d1",
            quote_id: QUOTE_ID,
            keyset_id: KEYSET_ID,
            outputs: [],
          },
        },
      ]);
      const summary = await serviceDrains(ctx);

      expect(wallet.completeMint).not.toHaveBeenCalled();
      expect(summary.recovered).toBe(1);
      expect(client.parkDrain).toHaveBeenCalledTimes(1);
    });

    it("before the park: re-POSTs the recorded token with its evidence intact", async () => {
      const { ctx, client } = jitCtx();
      vi.mocked(parkLog.readUnparked).mockReturnValue([jitSwappedEntry()]);
      const summary = await serviceDrains(ctx);

      // The evidence has to ride the retry: without it the park route reads
      // the re-POST as an accumulator park and refuses it for consuming
      // nothing.
      expect(client.parkDrain).toHaveBeenCalledWith(
        expect.objectContaining({
          token: "cashuBjit",
          mint_evidence: expect.objectContaining({ source: "jit_mint" }),
        })
      );
      expect(summary).toMatchObject({ recovered: 1, drains_jit_minted: 1 });
      expect(client.parkDrain).toHaveBeenCalledTimes(1);
    });

    /**
     * The one that would cost real money to get wrong. A wallet that will not
     * say whether it paid must freeze the drain: quoting again would put a
     * second invoice beside a payment that may still be routing.
     */
    it("refuses to re-quote a drain whose payment the wallet cannot account for", async () => {
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((line: string) => void logs.push(line));
      const { ctx, client, payInvoice, lookupInvoiceImpl } = jitCtx();
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([{ quote: quoteEntry() }]);
      // Known to the wallet, unsettled, and not yet expired: it may still be
      // routing, so nothing about it is decidable.
      lookupInvoiceImpl.mockResolvedValue({
        type: "outgoing",
        paymentHash: "aa".repeat(32),
        amountMsats: 392_400,
        createdAt: 1,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      const summary = await serviceDrains(ctx);
      spy.mockRestore();

      expect(payInvoice).not.toHaveBeenCalled();
      expect(parkLog.appendMintQuote).not.toHaveBeenCalled();
      expect(client.parkDrain).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ drains_queued: 1, drains_jit_minted: 0 });
      expect(logs.some((l) => l.includes("drain_jit_payment_in_flight"))).toBe(true);
    });

    it("holds a drain whose quote cannot be reconciled without the send credential", async () => {
      const { ctx, client } = jitCtx({ refundNwc: undefined });
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([{ quote: quoteEntry() }]);
      const summary = await serviceDrains(ctx);

      expect(summary).toMatchObject({ drains_queued: 1 });
      expect(parkLog.appendMintQuote).not.toHaveBeenCalled();
      expect(client.parkDrain).not.toHaveBeenCalled();
    });

    /**
     * A wallet that cannot pay — an exhausted budget is the ordinary way —
     * eventually lets the quote expire. Without an expiry check ahead of the
     * pay step the drain is frozen behind a dead invoice forever, and the only
     * documented escape is hand-editing the log.
     */
    it("abandons a quote that expired before anything was paid, freeing the drain", async () => {
      const { ctx, client, payInvoice, lookupInvoiceImpl } = jitCtx();
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([
        { quote: quoteEntry({ expires_at: Math.floor(Date.now() / 1000) - 60 }) },
      ]);
      lookupInvoiceImpl.mockRejectedValue(new NwcError("NOT_FOUND", "no such invoice"));
      const summary = await serviceDrains(ctx);

      expect(payInvoice).not.toHaveBeenCalled();
      expect(parkLog.appendMintAbandoned).toHaveBeenCalledWith(
        expect.objectContaining({ quote_id: QUOTE_ID, reason: "quote_expired_unpaid" })
      );
      expect(client.parkDrain).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ drains_queued: 1, drains_jit_minted: 0 });

      // Next tick the quote is no longer open, and the refund is bought.
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([]);
      const next = jitCtx();
      expect(await serviceDrains(next.ctx)).toMatchObject({ drains_jit_minted: 1 });
    });

    it("drops a quote a mint published no expiry for once it is plainly dead", async () => {
      const { ctx, payInvoice, lookupInvoiceImpl } = jitCtx();
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([
        // A day and a half old, and the wallet is certain it never sent it.
        { quote: quoteEntry({ expires_at: null, ts: Date.now() - 36 * 60 * 60 * 1000 }) },
      ]);
      lookupInvoiceImpl.mockRejectedValue(new NwcError("NOT_FOUND", "no such invoice"));
      const summary = await serviceDrains(ctx);

      expect(payInvoice).not.toHaveBeenCalled();
      expect(parkLog.appendMintAbandoned).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "quote_expired_unpaid" })
      );
      expect(summary).toMatchObject({ drains_queued: 1 });
    });

    /**
     * The mirror image, and the one that costs real money: an expired quote
     * the hub *did* pay must never be abandoned, because abandoning it frees
     * the drain to buy the same refund a second time.
     */
    it("never abandons a quote the hub already paid for, however it expired", async () => {
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((line: string) => void logs.push(line));
      const { ctx, client, payInvoice } = jitCtx(
        {},
        { expiry: Math.floor(Date.now() / 1000) - 60 }
      );
      vi.mocked(parkLog.readOpenMintQuotes).mockReturnValue([
        {
          quote: quoteEntry(),
          paid: {
            kind: "mint_paid",
            ts: 2,
            dvm_id: "dvm-fixture-1",
            credit_id: "c1",
            drain_id: "d1",
            quote_id: QUOTE_ID,
            preimage: "ff".repeat(32),
          },
        },
      ]);
      const summary = await serviceDrains(ctx);
      spy.mockRestore();

      expect(parkLog.appendMintAbandoned).not.toHaveBeenCalled();
      expect(parkLog.appendMintQuote).not.toHaveBeenCalled();
      expect(payInvoice).not.toHaveBeenCalled();
      expect(client.parkDrain).not.toHaveBeenCalled();
      // Money moved and the ladder cannot finish on its own: an operator has
      // to settle it with the mint, so it is failed rather than queued.
      expect(summary).toMatchObject({ drains_failed: 1, drains_queued: 0 });
      expect(summary.cashu_liability_sats_after).toBe(392);
      expect(logs.some((l) => l.includes("drain_jit_quote_expired_paid"))).toBe(true);
    });

    /**
     * A re-POST that fails leaves a paid-for refund sitting on disk. It must
     * not fall out of every counter: `drains_only` reads them for its exit
     * code and the melt hold-back reads the liability, so a silent skip is how
     * a night's melt sends the deposit pot out from under an unpaid caller.
     */
    it("keeps a failed park recovery counted rather than silently skipping it", async () => {
      const { ctx, client } = jitCtx();
      vi.mocked(parkLog.readUnparked).mockReturnValue([jitSwappedEntry()]);
      client.parkDrain.mockRejectedValue(new Error("park route down"));
      const summary = await serviceDrains(ctx);

      // No second purchase for a drain whose token is already on disk.
      expect(parkLog.appendMintQuote).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        recovered: 0,
        drains_queued: 1,
        drains_jit_minted: 0,
        cashu_liability_sats_after: 392,
      });
    });
  });
});

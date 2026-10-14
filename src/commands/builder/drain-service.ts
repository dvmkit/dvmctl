// Builder-owned refund servicing used by dvmctl melt-pending.
import type { MintQuoteBolt11Response } from "@cashu/cashu-ts";
import {
  Amount,
  getEncodedToken,
  MintQuoteState,
  type Proof,
  type ProofLike,
  type Token,
  type Wallet,
} from "@cashu/cashu-ts";
import {
  type BuilderLockKeypair,
  computeSmartDenominations,
  getWallet,
  type LockPubkey,
  lookupInvoice,
  maxKeysetDenomination,
  missingDleqRecoveryDiagnostic,
  type NwcConnection,
  NwcError,
  parseNwcUri,
  payInvoiceReconciling,
  prepareP2PKMint,
  restoreProofsFromOutputs,
  serializeOutputData,
  swapFeeForProofs,
  toLockPubkey,
} from "@dvmkit/sdk/internal";
import { DRAIN_DELIVERY_RESERVE_SATS } from "@dvmkit/sdk/server";

import type { AdminCashuClient, AdminMintEvidence } from "../../lib/admin-cashu-client.ts";
import {
  AdminApiError,
  type AdminBatch,
  type AdminBatchProof,
  type AdminPendingDrain,
  rethrowIfAdminStateUnavailable,
  rethrowIfBadSignature,
} from "../../lib/admin-cashu-client.ts";
import {
  appendMintAbandoned,
  appendMintOutputs,
  appendMintPaid,
  appendMintPaymentAttempt,
  appendMintPaymentRejected,
  appendMintQuote,
  appendParked,
  appendSwapped,
  type MintPaidEntry,
  type MintPaymentRejectedEntry,
  type MintQuoteEntry,
  type OpenMintQuote,
  readOpenMintQuotes,
  readUnparked,
} from "../../lib/drain-park-log.ts";
import { bolt11AmountMsats } from "../../lib/lightning/bolt11-amount.ts";

/** Refunds precede builder payouts; outstanding cashu liability holds the melt. */
export interface DrainServiceContext {
  dvmId: string;
  handle: string;
  client: AdminCashuClient;
  /** Lock pubkey → keypair map, same rotation walker as the melt path. */
  keypairsByPubkey: Map<LockPubkey, BuilderLockKeypair>;
  /**
   * The builder's current lock keypair. The just-in-time mint needs it as a
   * *signer* rather than a lookup: NUT-20 binds the mint quote to a pubkey and
   * only its holder may later ask the mint to issue against the paid invoice,
   * which is what stops anyone else redeeming a quote this worker paid for.
   * The proofs themselves are locked elsewhere — to the caller's refund key.
   */
  currentKeypair?: BuilderLockKeypair;
  /** The send-capable connection refunds are bought over; absent queues them. */
  refundNwc?: RefundNwcConfig;
  /** Test seam — cashu-ts wallet construction. */
  walletProvider?: typeof getWallet;
  /** Test seams — NIP-47 calls. */
  payInvoice?: typeof payInvoiceReconciling;
  lookupInvoiceImpl?: typeof lookupInvoice;
}

/**
 * The dedicated send connection the refund worker buys ecash with.
 *
 * Deliberately its own credential, separate from the receive-only connection a
 * DVM funds credit over and held only on the operator's worker host
 * — the DVM process gains no ability to spend, and this one only ever pays
 * invoices the worker obtained itself from an accepted mint's quote endpoint.
 * There is no client-side budget: NIP-47 budgets are static wallet-side policy
 * and the worker must not hold its own leash, so the bound is the wallet's own
 * balance and the operator's sweep discipline.
 */
export interface RefundNwcConfig {
  uri: string;
}

export interface DrainServiceSummary {
  /**
   * False when the pending-drain fetch failed — the pass cannot say whether
   * anything was owed. `recovered` may still be non-zero (recovery replays the
   * local park log first); every other counter below is zero for want of an
   * answer. A DVM that predates the drain admin surface reports `true`: there,
   * nothing owed is a fact, not an unknown.
   *
   * It means a *transport-shaped* unknown — something that may resolve itself
   * on a later tick. A rejected signature never reaches here; `serviceDrains`
   * throws on it instead.
   */
  fetched: boolean;
  drains_seen: number;
  drains_parked: number;
  /**
   * Refunds bought just in time rather than swapped out of the accumulator,
   * counted apart because each one moved sats out of the hub over
   * Lightning — the figure to read against the wallet's own outgoing history.
   *
   * Counted once per refund, on the tick that **finishes** it, which is not
   * always the tick that paid: a purchase interrupted anywhere between the
   * quote and the park resumes on a later tick and is counted there, through
   * whichever recovery leg finishes it. So it is not a subset of
   * `drains_parked` — a finished purchase lands in `recovered` — and summing
   * it across a night's ticks gives the number of refunds bought, with no
   * double count and none dropped.
   */
  drains_jit_minted: number;
  drains_failed: number;
  /**
   * Cashu refunds nothing was attempted for: no send credential, no mint that
   * would quote, or an earlier attempt still in flight. Not a failure — but
   * still money owed, so it has to be counted rather than fall between the
   * buckets, and it feeds `--drains-only`'s exit code the way `drains_manual`
   * does.
   */
  drains_queued: number;
  /** One-payment x402/mpp drains listed for manual settlement (no builder-held keys). */
  drains_manual: number;
  /**
   * Channel-backed x402/mpp drains left alone because their own cooperative
   * close settles them, on the caller's next poll. Counted so a run can say it
   * saw them, but deliberately outside the unsettled buckets: nobody has
   * anything to do about one, so it must not reach the `--drains-only` exit
   * code the way a manual refund does.
   */
  drains_channel: number;
  /** Recovered from the park log before fresh work. */
  recovered: number;
  /** Cashu liability (sats) still pending after this pass — melts hold back while > 0. */
  cashu_liability_sats_after: number;
}

/**
 * One drain-servicing pass: recover un-parked swaps from the local log, then
 * fulfil pending drains — cashu via a batch-proof swap into caller-locked
 * notes parked on the DVM. x402/mpp drains are surfaced for the operator (no
 * builder-held on-chain keys exist; see the follow-up issue), and cashu is the
 * only rail this job settles: direct Lightning payout was removed as a reclaim
 * method in tracked change.
 *
 * Outcomes ride the returned summary rather than an exception — a pass that
 * could settle nothing is still a pass, and the caller decides what that costs.
 * Authentication failures are exceptions: `admin_bad_signature` is a
 * configuration fault, while `admin_state_unavailable` needs the operator's
 * database/restart guidance rather than a healthy-looking held tick.
 */
export async function serviceDrains(ctx: DrainServiceContext): Promise<DrainServiceSummary> {
  const summary: DrainServiceSummary = {
    fetched: false,
    drains_seen: 0,
    drains_parked: 0,
    drains_jit_minted: 0,
    drains_failed: 0,
    drains_queued: 0,
    drains_manual: 0,
    drains_channel: 0,
    recovered: 0,
    cashu_liability_sats_after: 0,
  };

  // Every drain the recovery pass touched, resolved or not. Fresh work skips
  // all of them, and the re-fetch below is deliberately not what enforces
  // that: `refreshedPendingIds` falls back to the stale list when the DVM
  // cannot be reached, and on the just-in-time path a stale row means quoting
  // and paying for a refund that is already parked. Re-POSTing a park is
  // idempotent; buying a second one is not.
  // What recovery did with each drain it touched. Every one of them is out of
  // fresh work for the rest of the tick, but only `resolved` is settled: a
  // re-POST that failed, or a quote whose fate the wallet would not confirm,
  // is still money owed and has to reach a counter. Collapsing the two is what
  // let a paid-for, unparked refund release the melt hold-back and exit 0.
  const recovery = new Map<string, "resolved" | "queued" | "failed">();
  summary.recovered += await recoverParks(ctx, summary, recovery);
  // Before any fresh work: an in-flight mint quote is a payment that may
  // already have left the hub, and resolving it is the only thing that makes a
  // second quote on that drain safe. `recoverMintQuotes` carries each one as
  // far as it can get — paying, minting, restoring, parking — and marks the
  // drains whose quote is still unresolved, which stay queued below.
  await recoverMintQuotes(ctx, summary, recovery);

  let pending;
  try {
    pending = await ctx.client.getPendingDrains();
  } catch (err) {
    // Before anything else: a rejected signature is a configuration fault, not
    // an outage, and this is the first admin call of a sweep — flattening it
    // into `fetched: false` is what made a lock-pubkey mismatch read as a
    // healthy held tick at exit 0.
    rethrowIfBadSignature(err);
    rethrowIfAdminStateUnavailable(err);
    if (isMissingDrainSurface(err)) {
      // The DVM predates the drain surface — nothing to service, and melts
      // must not be held back by a liability that cannot exist.
      return { ...summary, fetched: true };
    }
    logDrain(ctx, "drain_pending_fetch_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }
  summary.fetched = true;
  summary.drains_seen = pending.drains.length;

  // Re-read after recovery would be another round trip; instead track which
  // drains recovery already closed and skip them below.
  const stillPending = new Set(
    (await refreshedPendingIds(ctx, pending.drains, summary)).map(
      (d) => `${d.credit_id}|${d.drain_id}`
    )
  );

  let cashuOutstandingSats = 0;
  for (const drain of pending.drains) {
    if (!stillPending.has(`${drain.credit_id}|${drain.drain_id}`)) continue;
    if (drain.method === "cashu") {
      const key = `${drain.credit_id}|${drain.drain_id}`;
      const recovered = recovery.get(key);
      if (recovered === "resolved") {
        // Recovery already finished this one; the row is only still here
        // because the re-fetch could not confirm it. Counting it parked would
        // double-count, so it is simply left alone.
        continue;
      }
      if (recovered) {
        // Recovery touched this drain and could not finish it: an unresolved
        // quote (the wallet would not say whether it paid, or the mint has not
        // credited yet), or a minted token whose re-POST failed. Either way a
        // fresh attempt here is how a refund gets bought or swapped twice, so
        // the drain waits for the next tick — and is counted, because the sats
        // are still owed and the melt hold-back reads this figure.
        if (recovered === "failed") summary.drains_failed++;
        else summary.drains_queued++;
        cashuOutstandingSats += drain.amount_sats ?? 0;
        continue;
      }
      const outcome = await parkOne(ctx, drain, pending.mints ?? []);
      if (outcome === "parked" || outcome === "jit_minted") {
        summary.drains_parked++;
        if (outcome === "jit_minted") summary.drains_jit_minted++;
      } else {
        if (outcome === "queued") summary.drains_queued++;
        else summary.drains_failed++;
        cashuOutstandingSats += drain.amount_sats ?? 0;
      }
    } else if (drain.settlement === "channel") {
      // A channel-backed reclaim, mid-close. `completeTempoDrain` leaves every
      // ambiguous close pending on purpose and `recoverTempoSessionClose`
      // finishes it on the caller's next poll, so this row is owed by the
      // channel rather than by anyone here — logged so a run can account for
      // it, and counted outside the unsettled buckets so it never alarms a
      // cron the operator cannot act on.
      summary.drains_channel++;
      logDrain(ctx, "drain_channel_settlement_pending", {
        credit_id: drain.credit_id,
        drain_id: drain.drain_id,
        method: drain.method,
        channel_id: drain.channel_id,
        amount_micro: drain.amount_micro,
        hint: "Usually nothing to do — the caller's channel close settles this one, and their next drain poll finishes the reconciliation. It is not on `dvmctl credit drains-owed`. The exception is a Tempo close that landed on chain and refunded less than the ledger extinguished: that one never clears on a poll, and `dvmctl credit tempo-wedged` is where it shows up.",
      });
    } else {
      // x402 `exact` and Tempo charge payouts, which stay a person's job by
      // decision rather than by omission: automating the send means
      // a builder-held chain spending key live on this host, with the DVM's
      // whole stablecoin balance behind it. The operator verbs are the
      // supported path, and `amount_native` on the row is the figure the
      // payout is sized in.
      summary.drains_manual++;
      logDrain(ctx, "drain_manual_settlement_required", {
        credit_id: drain.credit_id,
        drain_id: drain.drain_id,
        method: drain.method,
        payout: drain.payout,
        amount_micro: drain.amount_micro,
        amount_native: drain.amount_native,
        hint: `No builder-held on-chain send keys exist; send this refund yourself and record it with \`dvmctl credit drain-settle ${ctx.handle} ${drain.credit_id} ${drain.drain_id} --tx <hash>\`. \`dvmctl credit drains-owed ${ctx.handle}\` lists everything outstanding.`,
      });
    }
  }

  summary.cashu_liability_sats_after = cashuOutstandingSats;
  return summary;
}

/** Re-POST swapped-but-unparked tokens from the recovery log. */
async function recoverParks(
  ctx: DrainServiceContext,
  summary: DrainServiceSummary,
  recovery: Map<string, "resolved" | "queued" | "failed">
): Promise<number> {
  const unparked = readUnparked(ctx.dvmId);
  let recovered = 0;
  for (const entry of unparked) {
    const key = `${entry.credit_id}|${entry.drain_id}`;
    // Queued until the re-POST says otherwise. The token exists on disk either
    // way, so no fresh swap or purchase may run for this drain this tick.
    recovery.set(key, "queued");
    try {
      await ctx.client.parkDrain({
        credit_id: entry.credit_id,
        drain_id: entry.drain_id,
        token: entry.token,
        consumed_row_ids: entry.consumed_row_ids,
        keep_proofs: entry.keep_proofs,
        // Without this a just-in-time park's retry reads as an accumulator
        // park and is refused for consuming no rows — so the refund would sit
        // on disk, minted and paid for, and never reach the caller.
        ...(entry.mint_evidence ? { mint_evidence: entry.mint_evidence } : {}),
      });
      appendParked({
        dvm_id: ctx.dvmId,
        credit_id: entry.credit_id,
        drain_id: entry.drain_id,
      });
      recovered++;
      recovery.set(key, "resolved");
      // A just-in-time purchase interrupted between the mint and the park is
      // finished here, and this is the only tick that can count it: the tick
      // that paid returned `queued`.
      if (entry.mint_evidence) summary.drains_jit_minted++;
      logDrain(ctx, "drain_park_recovered", {
        credit_id: entry.credit_id,
        drain_id: entry.drain_id,
      });
    } catch (err) {
      rethrowIfAdminStateUnavailable(err);
      logDrain(ctx, "drain_park_recovery_failed", {
        credit_id: entry.credit_id,
        drain_id: entry.drain_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return recovered;
}

/** Pending drains minus those the recovery pass just fulfilled. */
async function refreshedPendingIds(
  ctx: DrainServiceContext,
  drains: AdminPendingDrain[],
  summary: DrainServiceSummary
): Promise<AdminPendingDrain[]> {
  if (summary.recovered === 0) return drains;
  try {
    const fresh = await ctx.client.getPendingDrains();
    return fresh.drains;
  } catch (err) {
    rethrowIfAdminStateUnavailable(err);
    return drains;
  }
}

type ParkOutcome = "parked" | "jit_minted" | "queued" | "failed";

/**
 * Fulfil one cashu drain: pick an accumulator batch that covers the amount
 * plus what the mint charges to swap it ({@link selectCoveringBatch}), swap it
 * at the mint into refund notes P2PK-locked to the caller plus
 * change re-locked to the builder, write the `swapped` recovery entry, and
 * park the token on the DVM. Only the proofs the mint actually spent count as
 * consumed — an input it never had to touch stays live in the accumulator —
 * and change re-enters through the park route's transaction.
 */
async function parkOne(
  ctx: DrainServiceContext,
  drain: AdminPendingDrain,
  mints: string[]
): Promise<ParkOutcome> {
  const amountSats = drain.amount_sats;
  const refundPubkey = drain.payout.refund_pubkey;
  if (!amountSats || amountSats <= 0 || !refundPubkey) {
    logDrain(ctx, "drain_park_unpriceable", {
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      amount_sats: amountSats,
    });
    return "failed";
  }

  let batches: AdminBatch[];
  try {
    batches = (await ctx.client.getPendingBatches()).batches;
  } catch (err) {
    rethrowIfAdminStateUnavailable(err);
    logDrain(ctx, "drain_park_batches_fetch_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  // The accumulator first, always: proofs this DVM already holds cost nothing
  // to swap, and refunds have come out of them ahead of the builder's payout
  // since tracked change. Buying ecash is what happens when there is none to swap —
  // a Lightning-funded credit never had any, and a Cashu-funded one loses its
  // proofs the moment the nightly melt legitimately sweeps them.
  const jitAvailable = ctx.refundNwc !== undefined;
  const selected = await selectCoveringBatch(ctx, drain, amountSats, batches, jitAvailable);
  if (!selected) {
    return jitMintOne(ctx, drain, amountSats, refundPubkey, mints);
  }
  const { batch, wallet, inputProofs, keypair } = selected;

  let send: Proof[];
  let keep: Proof[];
  try {
    const result = await wallet.ops
      .send(amountSats, inputProofs)
      .asLocked({ pubkey: refundPubkey })
      .keepAsLocked({ pubkey: batch.lock_pubkey })
      .privkey(keypair.privkey)
      // The caller is handed notes whose face value is exactly the recorded
      // obligation, and pays their own fee to redeem them. That
      // reverses tracked change's posture deliberately: under an in-kind promise the
      // reclaim is "the sats you deposited, pro rata, minus what it costs to
      // hand them back", so covering the redeem fee would pay it out of a
      // deposit pot that holds precisely what was deposited and no more. The
      // batch sizing below drops the matching `receiverFee` term for the same
      // reason. The mint's own per-input swap fee still comes off the
      // accumulator, because those are the proofs being spent — and since
      // tracked change that is what the delivery reserve already withheld from this
      // figure pays for, on this path exactly as the quote's cost is on the
      // just-in-time one.
      .includeFees(false)
      .run();
    send = result.send;
    keep = result.keep;
  } catch (err) {
    const recoveryDiagnostic = missingDleqRecoveryDiagnostic(inputProofs, err);
    logDrain(ctx, "drain_swap_failed", {
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      mint_url: batch.mint_url,
      error: err instanceof Error ? err.message : String(err),
      ...(recoveryDiagnostic ? { recovery: recoveryDiagnostic } : {}),
    });
    return "failed";
  }

  // `keep` is not all change: cashu-ts returns the inputs it never had to
  // touch alongside the freshly-minted remainder. Those untouched proofs are
  // still the rows we handed it, so reporting the whole batch as consumed
  // would mark live money `drained` — and re-inserting them as change trips
  // the accumulator's replay guard on `(dvm_id, proof_secret_hash)`, failing
  // every park on any DVM whose batch holds denominations the refund doesn't
  // need. Only what the mint actually spent is consumed; only what it minted
  // is change.
  const inputIndexBySecret = new Map(batch.proofs.map((p, i) => [p.secret, i]));
  const untouchedInputs = new Set<number>();
  const change: Proof[] = [];
  for (const p of keep) {
    const index = inputIndexBySecret.get(p.secret);
    if (index === undefined) change.push(p);
    else untouchedInputs.add(index);
  }
  const consumedRowIds = batch.row_ids.filter((_, i) => !untouchedInputs.has(i));
  const keepProofs: AdminBatchProof[] = change.map((p) => ({
    id: p.id,
    amount: amountForJson(p.amount),
    secret: p.secret,
    C: p.C,
    ...(p.dleq ? { dleq: { ...p.dleq } } : {}),
  }));
  if (consumedRowIds.length === 0) {
    // Every input came back untouched, so the mint spent nothing — and a proof
    // it signed against no input is not money. The accumulator is intact and
    // the next tick retries from a clean slate, so bailing out here burns
    // nothing; this runs before the token is encoded precisely so there is no
    // refund in hand to drop. Writing a `swapped` entry instead would be the
    // unsafe move: the park route rejects an empty `consumed_row_ids` on a
    // swap (only a just-in-time mint may consume nothing, and it says so with
    // its evidence), so the recovery sweep would re-POST it into a 400 on
    // every tick, forever.
    logDrain(ctx, "drain_park_no_consumed_rows", {
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      mint_url: batch.mint_url,
      batch_rows: batch.row_ids.length,
    });
    return "failed";
  }

  // The caller-locked token exists only here until the park commits — write
  // it durably BEFORE the POST so a crash can't burn the refund.
  const encoded = getEncodedToken({
    mint: batch.mint_url,
    proofs: rehydrateLocalProofs(send),
  } satisfies Token);
  appendSwapped({
    dvm_id: ctx.dvmId,
    credit_id: drain.credit_id,
    drain_id: drain.drain_id,
    token: encoded,
    consumed_row_ids: consumedRowIds,
    keep_proofs: keepProofs,
  });

  try {
    await ctx.client.parkDrain({
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      token: encoded,
      consumed_row_ids: consumedRowIds,
      keep_proofs: keepProofs,
    });
  } catch (err) {
    rethrowIfAdminStateUnavailable(err);
    // Leave the `swapped` entry unpaired — next tick's recovery re-POSTs
    // the same token (the park route is idempotent on it).
    logDrain(ctx, "drain_park_post_failed", {
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  appendParked({ dvm_id: ctx.dvmId, credit_id: drain.credit_id, drain_id: drain.drain_id });
  logDrain(ctx, "drain_parked", {
    credit_id: drain.credit_id,
    drain_id: drain.drain_id,
    amount_sats: amountSats,
    mint_url: batch.mint_url,
  });
  return "parked";
}

// ── Just-in-time mint ────────────────────────────────────────

/**
 * Buy caller-locked refund notes at an accepted mint and park them.
 * NIP-47 cannot constrain destinations: only this worker's mint quote invoice
 * may reach payInvoiceReconciling. refund_pubkey is a lock, never an address.
 * Missing credentials or unavailable quotes are queued because no money moved.
 */
async function jitMintOne(
  ctx: DrainServiceContext,
  drain: AdminPendingDrain,
  amountSats: number,
  refundPubkey: string,
  mints: string[]
): Promise<ParkOutcome> {
  const ids = { credit_id: drain.credit_id, drain_id: drain.drain_id };
  if (!ctx.refundNwc) {
    logDrain(ctx, "drain_jit_unconfigured", {
      ...ids,
      amount_sats: amountSats,
      display:
        "This refund needs sats bought from the hub, and no send wallet is configured to buy them.",
      hint: "Pass `--refund-nwc <wallet connection URI>` (or set DVMKIT_REFUND_NWC_URL) with a send-capable NWC connection on the wallet holding your Bitcoin deposits. The refund waits, visible in `dvmctl credit drains-owed`, until one is wired.",
    });
    return "queued";
  }
  const keypair = ctx.currentKeypair;
  if (!keypair) {
    logDrain(ctx, "drain_jit_no_lock_key", {
      ...ids,
      display:
        "This refund needs to be minted, and no current builder lock key was resolved to sign the mint quote.",
      hint: "The mint quote is locked to your builder key (NUT-20) so nobody else can redeem the invoice you pay for. Check `~/.dvmkit/builder.mnemonic` is present and that this DVM is registered in `~/.dvmkit/builder.json`.",
    });
    return "queued";
  }

  let conn: NwcConnection;
  try {
    conn = parseNwcUri(ctx.refundNwc.uri);
  } catch (err) {
    logDrain(ctx, "drain_jit_nwc_invalid", {
      ...ids,
      error: err instanceof Error ? err.message : String(err),
      display: "The refund send wallet's connection string could not be read, so nothing was paid.",
      hint: "Re-copy the `wallet connection URI` URI from the wallet that holds your Bitcoin deposits. The refund stays owed and retries on the next tick.",
    });
    return "queued";
  }

  const tried: string[] = [];
  for (const mintUrl of mints) {
    tried.push(mintUrl);
    let wallet: Wallet;
    let quote: MintQuoteBolt11Response;
    try {
      wallet = await (ctx.walletProvider ?? getWallet)(mintUrl);
      // NUT-20: only the holder of this keypair's privkey can later ask the
      // mint to issue against the invoice we are about to pay, so a paid quote
      // is not a bearer instrument anyone else can collect.
      quote = await wallet.createLockedMintQuote(amountSats, keypair.pubkey);
    } catch (err) {
      // One mint refusing is not the refund failing — another may answer. The
      // per-mint line carries that mint's own words (a minimum it will not go
      // below reads very differently from an outage), and the aggregate below
      // says whether every one of them died.
      logDrain(ctx, "drain_jit_quote_failed", {
        ...ids,
        mint_url: mintUrl,
        amount_sats: amountSats,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // What the mint is asking, bounded before anything is paid. `pay_invoice`
    // sends whatever the invoice says, so an invoice this worker cannot read,
    // or one asking for more than the refund plus its reserve, is refused
    // outright: the posture the whole design rests on is that a mint sees
    // value only in transit, and a fee misconfiguration or a compromised entry
    // in the accepted list must not be able to drain the hub through it. The
    // ceiling is the promise itself — face value plus the reserve the caller
    // already paid for delivery — so a mint whose margin exceeds that is one
    // this refund cannot afford, whatever its intent.
    const invoiceMsats = bolt11AmountMsats(quote.request);
    const ceilingMsats = (amountSats + DRAIN_DELIVERY_RESERVE_SATS) * 1000;
    if (invoiceMsats === null || invoiceMsats > ceilingMsats) {
      logDrain(ctx, "drain_jit_quote_refused", {
        ...ids,
        mint_url: mintUrl,
        quote_id: quote.quote,
        reason: invoiceMsats === null ? "invoice_unreadable" : "above_ceiling",
        face_sats: amountSats,
        invoice_msats: invoiceMsats,
        ceiling_msats: ceilingMsats,
        display:
          invoiceMsats === null
            ? `${mintUrl} asked for this refund's ecash with an invoice whose amount could not be read, so nothing was paid.`
            : `${mintUrl} wants more for this refund's ecash than the refund is worth, so nothing was paid.`,
        hint: "Nothing left the wallet, and the unpaid quote simply expires at the mint. Another accepted mint is tried next; if every one of them is refused this way, check the mints' own fee settings before adding one that is cheaper.",
      });
      continue;
    }

    const entry: Omit<MintQuoteEntry, "kind" | "ts"> = {
      dvm_id: ctx.dvmId,
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      mint_url: mintUrl,
      quote_id: quote.quote,
      bolt11: quote.request,
      invoice_msats: invoiceMsats,
      face_sats: amountSats,
      reserve_sats: DRAIN_DELIVERY_RESERVE_SATS,
      expires_at: quote.expiry ?? null,
      refund_pubkey: refundPubkey,
    };
    // Durable before the payment, for the same reason `swapped` is durable
    // before the park: from here on a crash must be able to find out whether
    // the hub paid, and the only handle on that is this bolt11.
    appendMintQuote(entry);
    logDrain(ctx, "drain_jit_quoted", {
      ...ids,
      mint_url: mintUrl,
      quote_id: quote.quote,
      face_sats: amountSats,
      invoice_msats: entry.invoice_msats,
    });
    return advanceMintQuote(ctx, conn, keypair, {
      quote: { ...entry, kind: "mint_quote", ts: Date.now() },
    });
  }

  logDrain(ctx, "drain_jit_no_mint", {
    ...ids,
    amount_sats: amountSats,
    mints_tried: tried,
    display:
      tried.length === 0
        ? "This refund has to be bought at a Cashu mint and this DVM has none configured, so nothing could be minted."
        : "No accepted mint would quote for this refund, so nothing was bought and nothing was paid.",
    hint:
      tried.length === 0
        ? "Set DVMKIT_CASHU_MINTS on the DVM. A non-channel Bitcoin refund is P2PK-locked ecash and nothing else, so without a mint there is no shape it can take."
        : `Each mint's own error is on the \`drain_jit_quote_failed\` line above it. The refund stays owed and retries every tick — nothing here needs undoing, and no payment was attempted.`,
  });
  return "queued";
}

/**
 * Fresh work and recovery share the pay/mint/restore/park ladder to prevent
 * disagreement about whether a refund has already been paid.
 * Read expiry before payment: abandoning a paid quote would permit a second
 * refund; checking expiry only after payment strands repeated failed payments.
 * Track payment made by this call in paid, rather than re-reading open.paid.
 */
async function advanceMintQuote(
  ctx: DrainServiceContext,
  conn: NwcConnection,
  keypair: BuilderLockKeypair,
  open: OpenMintQuote
): Promise<ParkOutcome> {
  const entry = open.quote;
  const refundPubkey = entry.refund_pubkey;
  const ids = { credit_id: entry.credit_id, drain_id: entry.drain_id };
  const base = { ...ids, mint_url: entry.mint_url, quote_id: entry.quote_id };

  let wallet: Wallet;
  try {
    wallet = await (ctx.walletProvider ?? getWallet)(entry.mint_url);
  } catch (err) {
    logDrain(ctx, "drain_jit_mint_unreachable", {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      display:
        "The mint holding this refund's quote is not answering, so the refund is still on its way.",
      hint: "Nothing is lost and nothing needs undoing — the quote is recorded and the next tick picks it up where it left off. If the mint stays down, its own status page is the place to look.",
    });
    return "queued";
  }

  // This call's own record of whether the hub has paid, seeded from the
  // recovered entry and set again below if this call is what pays. Everything
  // downstream reads it rather than `open.paid`.
  let paid = Boolean(open.paid);
  let feesPaidMsats = open.paid?.fees_paid_msats ?? null;

  let checked: MintQuoteBolt11Response;
  if (!paid) {
    if (quoteDead(entry)) {
      // The only place a quote may be abandoned. Everything reaching here
      // unpaid is provably unpaid: a quote created moments ago on the fresh
      // path (never dead), or one `reconcileQuotePayment` got a definitive
      // negative for from the wallet. Nothing left the hub, so the drain is
      // freed to quote afresh next tick rather than sitting frozen behind a
      // dead invoice.
      //
      // Read off the recorded quote rather than the mint, deliberately: this
      // is what releases a drain, so it must not need the mint to answer, and
      // asking the mint first would also skip the payment entirely against a
      // backend that marks its own quotes paid.
      appendMintAbandoned({
        dvm_id: ctx.dvmId,
        ...ids,
        quote_id: entry.quote_id,
        reason: "quote_expired_unpaid",
      });
      logDrain(ctx, "drain_jit_quote_abandoned", {
        ...base,
        reason: "quote_expired_unpaid",
        display:
          "The mint's quote for this refund ran out before it could be paid, so it was dropped unpaid.",
        hint: "Nothing left the wallet — the refund is still owed and the next tick asks for a fresh quote. If this repeats, the wallet is the place to look: an exhausted budget or an empty balance keeps a quote from being paid until it expires.",
      });
      return "queued";
    }
    appendMintPaymentAttempt({
      dvm_id: ctx.dvmId,
      ...ids,
      quote_id: entry.quote_id,
    });
    try {
      const outcome = await (ctx.payInvoice ?? payInvoiceReconciling)(conn, entry.bolt11);
      paid = true;
      feesPaidMsats = outcome.feesPaidMsats ?? null;
      appendMintPaid({
        dvm_id: ctx.dvmId,
        ...ids,
        quote_id: entry.quote_id,
        preimage: outcome.preimage,
        ...(outcome.feesPaidMsats !== undefined ? { fees_paid_msats: outcome.feesPaidMsats } : {}),
        ...(outcome.outcome === "paid" ? {} : { recovered: true }),
      });
      logDrain(ctx, "drain_jit_invoice_paid", {
        ...base,
        pay_outcome: outcome.outcome,
        invoice_msats: entry.invoice_msats,
        fees_paid_msats: outcome.feesPaidMsats ?? null,
      });
    } catch (err) {
      const code = err instanceof NwcError ? err.code : "pay_failed";
      const definitivelyRejected =
        err instanceof NwcError &&
        err.method === "pay_invoice" &&
        code.toLowerCase() !== "payment_unknown";
      if (definitivelyRejected) {
        appendMintPaymentRejected({
          dvm_id: ctx.dvmId,
          ...ids,
          quote_id: entry.quote_id,
          error_code: code,
        });
      }
      // `payment_unknown` is the one that must not be retried blind: the
      // wallet neither confirmed nor denied, and the quote stays open so the
      // next tick reconciles it through `lookup_invoice` rather than paying a
      // second time. A wallet rejection is recorded durably, so after lookup
      // confirms that exact invoice remains unsettled the same invoice can be
      // tried again. Other failures stay conservative unless lookup itself
      // proves the invoice was never sent.
      logDrain(
        ctx,
        code === "payment_unknown" ? "drain_jit_payment_unknown" : "drain_jit_payment_failed",
        {
          ...base,
          error_code: code,
          error: err instanceof Error ? err.message : String(err),
          display:
            code === "payment_unknown"
              ? "The wallet buying this refund never answered, so we cannot yet say whether the payment went out."
              : "The wallet could not pay for this refund's ecash, so no money left and the refund is still owed.",
          hint:
            code === "payment_unknown"
              ? "Nothing is retried until this resolves — the next tick asks the wallet about this exact invoice, so it cannot be paid twice. Check the wallet is online and reachable over its relays."
              : "The wallet's own error is on this line. A balance too low or a budget exhausted are the usual two; the same invoice is retried on the next tick once the wallet can pay it.",
        }
      );
      return "queued";
    }
  }

  try {
    checked = await wallet.checkMintQuoteBolt11(entry.quote_id);
  } catch (err) {
    logDrain(ctx, "drain_jit_quote_state_failed", {
      ...base,
      error: err instanceof Error ? err.message : String(err),
      display:
        "The mint would not say whether it has been paid for this refund yet, so it stays in flight.",
      hint: "The payment is recorded, so nothing is re-sent. The next tick asks again.",
    });
    return "queued";
  }

  let proofs: Proof[];
  if (checked.state === MintQuoteState.ISSUED) {
    if (!open.outputs) {
      // The mint says it issued against outputs this worker has no record of.
      // That should be unreachable — the outputs are written before
      // `completeMint` — so it means either a second worker minted this quote
      // or the log lost a line. Either way the proofs cannot be unblinded here
      // and guessing is worse than stopping: the quote stays open, which keeps
      // the drain from quoting again and buying the refund a second time.
      logDrain(ctx, "drain_jit_issued_unrecoverable", {
        ...base,
        display:
          "This refund's ecash was already issued by the mint, but this machine has no record of the outputs needed to collect it.",
        hint: "Do not re-run the refund — the drain is deliberately held so it cannot be bought twice. This means another host minted the same quote, or `~/.dvmkit/drain-park.log` lost a line. Check for a second worker against this DVM before doing anything else.",
      });
      return "failed";
    }
    try {
      proofs = await restoreProofsFromOutputs(wallet, open.outputs.keyset_id, open.outputs.outputs);
    } catch (err) {
      logDrain(ctx, "drain_jit_restore_failed", {
        ...base,
        error: err instanceof Error ? err.message : String(err),
        display:
          "The mint has this refund's ecash and would not hand back the signatures for it this time.",
        hint: "The outputs are on disk, so this is recoverable — the next tick asks the mint again. Nothing was paid twice.",
      });
      return "queued";
    }
    logDrain(ctx, "drain_jit_restored", { ...base, proofs: proofs.length });
  } else if (checked.state === MintQuoteState.PAID) {
    const denominations = computeSmartDenominations(entry.face_sats, {
      maxDenomination: maxKeysetDenomination(wallet),
      includeTinyTail: false,
    });
    let preview;
    try {
      // The quote's own key signs the issue request (NUT-20); the outputs lock
      // to the caller's refund key (NUT-11). Two different keys, and swapping
      // them would either fail to issue or hand the caller notes they cannot
      // spend.
      preview = await prepareP2PKMint(
        wallet,
        entry.face_sats,
        checked,
        keypair.privkey,
        refundPubkey,
        denominations
      );
    } catch (err) {
      logDrain(ctx, "drain_jit_prepare_failed", {
        ...base,
        error: err instanceof Error ? err.message : String(err),
        display:
          "The mint has been paid for this refund but would not prepare the notes this time.",
        hint: "The payment stands and is not repeated — the next tick prepares them again.",
      });
      return "queued";
    }
    const previewKeysetId = preview.outputData[0]?.blindedMessage.id;
    if (
      !previewKeysetId ||
      preview.outputData.some((output) => output.blindedMessage.id !== previewKeysetId)
    ) {
      logDrain(ctx, "drain_jit_prepare_failed", {
        ...base,
        error: "The prepared Cashu outputs do not share one keyset.",
        display:
          "The mint has been paid for this refund but returned malformed note metadata this time.",
        hint: "The payment stands and is not repeated — the next tick prepares the notes again.",
      });
      return "queued";
    }
    // Durable before the mint signs: between here and the proofs landing in
    // this process the sats have left the hub and exist only as signatures the
    // mint holds. With these outputs on disk that state is recoverable through
    // NUT-09; without them it is money nobody can unblind.
    appendMintOutputs({
      dvm_id: ctx.dvmId,
      ...ids,
      quote_id: entry.quote_id,
      keyset_id: previewKeysetId,
      outputs: serializeOutputData(preview.outputData),
    });
    try {
      proofs = await wallet.completeMint(preview);
    } catch (err) {
      logDrain(ctx, "drain_jit_mint_failed", {
        ...base,
        error: err instanceof Error ? err.message : String(err),
        display:
          "The mint has been paid for this refund and did not return the notes, so it is still in flight.",
        hint: "The blinded outputs are recorded, so the next tick can collect the same notes from the mint — nothing is bought twice.",
      });
      return "queued";
    }
  } else {
    // Still UNPAID at the mint after this worker has paid — the sats left the
    // hub and the mint has not credited them yet. Reaching here unpaid is not
    // possible and the compiler says so: `paid` narrows to `true` below,
    // because every path through the pay step above either sets it or returns.
    //
    // An expired quote is the one shape that will never resolve itself: the
    // invoice can no longer settle into this quote, so the sats are with the
    // mint or refunded by Lightning and neither is something this loop can
    // decide. It is emphatically *not* abandoned — abandoning would release
    // the drain to buy a second refund on top of the one already paid for,
    // which is why abandoning lives above the pay step and only there.
    if (quoteExpired(checked)) {
      logDrain(ctx, "drain_jit_quote_expired_paid", {
        ...base,
        invoice_msats: entry.invoice_msats,
        display:
          "The hub paid for this refund's ecash and the mint's quote expired before it credited the payment.",
        hint: `Do not re-run the refund — the drain is held so it cannot be bought twice. Ask ${entry.mint_url} about quote ${entry.quote_id}; the payment either sits with them or was returned by Lightning. Settle it there, then remove this quote's lines from \`~/.dvmkit/drain-park.log\` to release the drain.`,
      });
      return "failed";
    }
    logDrain(ctx, "drain_jit_awaiting_credit", {
      ...base,
      quote_state: checked.state,
      display:
        "The hub has paid for this refund's ecash and the mint has not credited the payment yet.",
      hint: "Ordinary for a moment after a Lightning payment. The next tick collects the notes; nothing is paid again in the meantime.",
    });
    return "queued";
  }

  const evidence: AdminMintEvidence = {
    source: "jit_mint",
    mint_url: entry.mint_url,
    quote_id: entry.quote_id,
    face_sats: entry.face_sats,
    reserve_sats: entry.reserve_sats,
    invoice_msats: entry.invoice_msats,
    routing_fee_msats: feesPaidMsats,
  };
  const encoded = getEncodedToken({
    mint: entry.mint_url,
    proofs: rehydrateLocalProofs(proofs),
  } satisfies Token);
  // From here the shape is the accumulator path's exactly: the caller-locked
  // token exists only in this process until the park commits, so it is written
  // durably first and `recoverParks` re-POSTs it on any later tick.
  appendSwapped({
    dvm_id: ctx.dvmId,
    ...ids,
    token: encoded,
    consumed_row_ids: [],
    keep_proofs: [],
    mint_evidence: evidence,
  });

  try {
    await ctx.client.parkDrain({
      ...ids,
      token: encoded,
      consumed_row_ids: [],
      keep_proofs: [],
      mint_evidence: evidence,
    });
  } catch (err) {
    rethrowIfAdminStateUnavailable(err);
    logDrain(ctx, "drain_park_post_failed", {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    });
    return "queued";
  }

  appendParked({ dvm_id: ctx.dvmId, ...ids });
  logDrain(ctx, "drain_jit_parked", {
    ...base,
    face_sats: entry.face_sats,
    reserve_sats: entry.reserve_sats,
    invoice_msats: entry.invoice_msats,
    routing_fee_msats: feesPaidMsats,
    // What the reserve did or did not cover. Negative is the overage the
    // provider absorbs rather than re-pricing a promise it already made.
    reserve_remainder_msats: entry.reserve_sats * 1000 - deliveryCostMsats(entry, feesPaidMsats),
  });
  return "jit_minted";
}

/**
 * How long an unpaid quote a mint published no expiry for is carried before it
 * is treated as dead. Real mint quotes expire in minutes; a day is generous
 * enough that the only quotes it catches are ones nothing will ever settle,
 * and it exists so a mint that publishes no expiry cannot freeze a drain
 * permanently.
 */
const MINT_QUOTE_STALE_MS = 24 * 60 * 60 * 1000;

/** Whether a recorded quote can still be settled, without asking the mint. */
function quoteDead(entry: MintQuoteEntry): boolean {
  if (entry.expires_at !== null) return entry.expires_at * 1000 < Date.now();
  return Date.now() - entry.ts > MINT_QUOTE_STALE_MS;
}

/**
 * Whether the mint itself says the quote can no longer be settled. Only read
 * for a quote already paid for, where it separates "not credited yet" from
 * "never will be". A mint publishing no expiry never reads as expired.
 */
function quoteExpired(quote: MintQuoteBolt11Response): boolean {
  return typeof quote.expiry === "number" && quote.expiry * 1000 < Date.now();
}

/** What handing this refund over actually cost: the mint's margin plus routing. */
function deliveryCostMsats(entry: MintQuoteEntry, routingFeeMsats: number | null): number {
  return entry.invoice_msats - entry.face_sats * 1000 + (routingFeeMsats ?? 0);
}

/**
 * Resolve in-flight quotes before fresh work. Exclude every recovered drain for
 * this tick: a fresh quote bypasses wallet event dedup and can pay twice while
 * the first invoice's fate is unknown.
 */
async function recoverMintQuotes(
  ctx: DrainServiceContext,
  summary: DrainServiceSummary,
  recovery: Map<string, "resolved" | "queued" | "failed">
): Promise<void> {
  const open = readOpenMintQuotes(ctx.dvmId);
  if (open.length === 0) return;

  const keypair = ctx.currentKeypair;
  let conn: NwcConnection | undefined;
  if (ctx.refundNwc) {
    try {
      conn = parseNwcUri(ctx.refundNwc.uri);
    } catch {
      conn = undefined;
    }
  }

  for (const item of open) {
    const key = `${item.quote.credit_id}|${item.quote.drain_id}`;
    recovery.set(key, "queued");
    if (!conn || !keypair) {
      // Nothing can be resolved without the credential that paid — and
      // crucially, nothing may be re-quoted either. Holding the drain is the
      // safe answer: the money may already be gone.
      logDrain(ctx, "drain_jit_recovery_unconfigured", {
        credit_id: item.quote.credit_id,
        drain_id: item.quote.drain_id,
        quote_id: item.quote.quote_id,
        display:
          "A refund purchase from a previous run is unfinished and cannot be checked without the send wallet.",
        hint: "Re-wire `--refund-nwc` (or DVMKIT_REFUND_NWC_URL) before the next tick. The refund is deliberately held until then, because the earlier payment may already have gone out.",
      });
      continue;
    }
    // A quote with no recorded payment may still have been paid: the response
    // could have been lost after the wallet acted. Ask the wallet about this
    // exact invoice before anything else touches the quote — re-running the
    // pay path would re-sign the request, and a re-signed request is a second
    // payment rather than a deduplicated retry.
    let carried = item;
    if (!item.paid) {
      const settled = await reconcileQuotePayment(ctx, conn, item.quote, item.paymentRejected);
      if (settled === "unknown") continue;
      if (settled !== "unpaid") carried = { ...item, paid: settled };
    }
    const outcome = await advanceMintQuote(ctx, conn, keypair, carried);
    if (outcome === "jit_minted") {
      summary.recovered++;
      summary.drains_jit_minted++;
      recovery.set(key, "resolved");
    } else if (outcome === "failed") {
      // Money left the hub and the ladder cannot finish on its own — an
      // expired quote the mint was paid for, or an issue this host has no
      // outputs for. Distinguished from `queued` because it needs hands, not
      // another tick.
      recovery.set(key, "failed");
    }
  }
}

/**
 * settled records the missing payment and continues without paying again;
 * unpaid permits payment only when the wallet confirms nothing left;
 * unknown freezes the quote, including transport failures.
 */
async function reconcileQuotePayment(
  ctx: DrainServiceContext,
  conn: NwcConnection,
  entry: MintQuoteEntry,
  paymentRejected?: MintPaymentRejectedEntry
): Promise<MintPaidEntry | "unpaid" | "unknown"> {
  const base = {
    credit_id: entry.credit_id,
    drain_id: entry.drain_id,
    quote_id: entry.quote_id,
    mint_url: entry.mint_url,
  };
  let tx;
  try {
    tx = await (ctx.lookupInvoiceImpl ?? lookupInvoice)(conn, { invoice: entry.bolt11 });
  } catch (err) {
    // A wallet that has never heard of the invoice answers NOT_FOUND, which is
    // as definitive as a settled answer: nothing was sent. Anything else is
    // transport, and transport failures must not unfreeze a quote.
    const code = err instanceof NwcError ? err.code : "lookup_failed";
    if (code === "NOT_FOUND") {
      logDrain(ctx, "drain_jit_payment_never_sent", base);
      return "unpaid";
    }
    logDrain(ctx, "drain_jit_recovery_lookup_failed", {
      ...base,
      error_code: code,
      error: err instanceof Error ? err.message : String(err),
      display:
        "A refund purchase from a previous run could not be checked, so it is being left alone.",
      hint: "Nothing is re-sent while this is unanswered — that is what stops a refund being bought twice. The next tick asks the wallet again.",
    });
    return "unknown";
  }
  if (tx.settledAt) {
    const paid: Omit<MintPaidEntry, "kind" | "ts"> = {
      dvm_id: ctx.dvmId,
      credit_id: entry.credit_id,
      drain_id: entry.drain_id,
      quote_id: entry.quote_id,
      preimage: tx.preimage ?? "",
      ...(tx.feesPaidMsats !== undefined ? { fees_paid_msats: tx.feesPaidMsats } : {}),
      recovered: true,
    };
    appendMintPaid(paid);
    logDrain(ctx, "drain_jit_payment_recovered", {
      ...base,
      fees_paid_msats: tx.feesPaidMsats ?? null,
    });
    return { ...paid, kind: "mint_paid", ts: Date.now() };
  }
  // The wallet knows the invoice and has not settled it. An expired one can
  // never settle now, so nothing is in flight and the drain is free to be
  // quoted afresh; anything else may still be routing, and a fresh quote
  // beside a routing payment is the double-refund bug.
  if (tx.expiresAt && tx.expiresAt * 1000 < Date.now()) {
    logDrain(ctx, "drain_jit_payment_expired_unpaid", base);
    return "unpaid";
  }
  if (paymentRejected) {
    logDrain(ctx, "drain_jit_payment_retrying", {
      ...base,
      error_code: paymentRejected.error_code,
      display:
        "The wallet rejected the previous attempt and confirms this refund invoice is still unpaid, so the same invoice is being retried.",
      hint: "No new mint quote was opened. If the wallet rejects this attempt too, its error is reported and the same safe check runs again next tick.",
    });
    return "unpaid";
  }
  logDrain(ctx, "drain_jit_payment_in_flight", {
    ...base,
    display:
      "A refund purchase from a previous run is still in flight, so nothing new was attempted for it.",
    hint: "The refund is held until the wallet reports one way or the other — that is what keeps it from being paid for twice.",
  });
  return "unknown";
}

/** An accumulator batch priced at its own mint and ready to swap. */
interface CoveringBatch {
  batch: AdminBatch;
  wallet: Wallet;
  inputProofs: ProofLike[];
  keypair: BuilderLockKeypair;
}

/**
 * The SDK wallet may be bundled with a distinct cashu-ts module instance.
 * Rebuild its Amount values at the CLI's encoding boundary without changing
 * the proof fields the mint signed.
 */
function rehydrateLocalProofs(proofs: readonly Proof[]): Proof[] {
  return proofs.map((proof) => ({ ...proof, amount: localAmount(proof.amount) }));
}

/** Convert a proof amount to JSON only through cashu-ts's checked conversion. */
function amountForJson(amount: unknown): number {
  return localAmount(amount).toNumber();
}

/** Normalize an AmountLike, rehydrating foreign Amount instances by exact bigint value. */
function localAmount(amount: unknown): Amount {
  if (typeof amount === "number" || typeof amount === "bigint" || typeof amount === "string") {
    return Amount.from(amount);
  }
  if (amount && typeof amount === "object" && "toBigInt" in amount) {
    const toBigInt = (amount as { toBigInt?: unknown }).toBigInt;
    if (typeof toBigInt === "function") {
      const value: unknown = toBigInt.call(amount);
      if (typeof value === "bigint") return Amount.from(value);
    }
  }
  throw new TypeError("Cashu proof amount must be a primitive AmountLike or expose toBigInt()");
}

/**
 * Choose a batch covering the refund plus its mint/keyset input fee. Fee-free
 * sizing selects an unusable first batch and can hide a later usable one.
 * Caller redemption fees are excluded; the caller pays those separately.
 * Price all proofs in the batch, even though cashu-ts may select fewer. This
 * conservatively defers a park until accumulation grows; underpricing can
 * stall it permanently. Do not duplicate cashu-ts proof selection here.
 * Wallets are cached per mint URL, so pricing multiple batches needs one load.
 */
async function selectCoveringBatch(
  ctx: DrainServiceContext,
  drain: AdminPendingDrain,
  amountSats: number,
  batches: AdminBatch[],
  jitAvailable: boolean
): Promise<CoveringBatch | undefined> {
  // What happens next when nothing here covers the refund, and it changes the
  // remedy entirely: with a send credential wired the drain is about to be
  // bought from the hub rather than left waiting on accumulation, so telling
  // an operator to fund the DVM would send them after a problem that is
  // already being solved.
  const nextStep = jitAvailable
    ? "The refund is minted just in time from the hub instead — see the `drain_jit_*` lines below."
    : "";
  let closestShortfall: { batch: AdminBatch; requiredSats: number } | undefined;
  const unpriceableMints = new Set<string>();

  for (const batch of batches) {
    // A swap spans one mint and one witness key, so cross-batch combining is
    // out; a thin accumulator leaves the drain pending until value arrives.
    const keypair = ctx.keypairsByPubkey.get(toLockPubkey(batch.lock_pubkey));
    if (!keypair) continue;
    if (batch.total_sats < amountSats) continue;

    let wallet: Wallet;
    let inputProofs: ProofLike[];
    let reserveSats: number;
    try {
      wallet = await (ctx.walletProvider ?? getWallet)(batch.mint_url);
      inputProofs = batch.proofs.map((p) => ({
        id: p.id,
        // JSON from the DVM is the cross-package amount boundary. Leave its
        // validated primitive value intact so the SDK wallet recognizes it as
        // an AmountLike instead of rejecting this CLI bundle's Amount class.
        amount: p.amount,
        secret: p.secret,
        C: p.C,
        ...(p.dleq ? { dleq: { ...p.dleq } } : {}),
      }));
      // `includeFees(false)` (see `parkOne`), so the swap needs
      // `sum(inputs) >= amountSats + swapFee(inputs)` and nothing for the
      // receiver's own redeem fee.
      reserveSats = swapFeeForProofs(wallet, inputProofs);
    } catch (err) {
      // This mint can't be reached or won't name a priceable keyset. Another
      // batch at another mint may still fulfil the refund, so keep looking
      // rather than failing the whole drain on one bad mint.
      unpriceableMints.add(batch.mint_url);
      logDrain(ctx, "drain_park_batch_unpriceable", {
        credit_id: drain.credit_id,
        drain_id: drain.drain_id,
        mint_url: batch.mint_url,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const requiredSats = amountSats + reserveSats;
    if (batch.total_sats >= requiredSats) return { batch, wallet, inputProofs, keypair };
    if (
      !closestShortfall ||
      requiredSats - batch.total_sats <
        closestShortfall.requiredSats - closestShortfall.batch.total_sats
    ) {
      closestShortfall = { batch, requiredSats };
    }
  }

  if (closestShortfall) {
    const { batch, requiredSats } = closestShortfall;
    const shortBySats = requiredSats - batch.total_sats;
    logDrain(ctx, "drain_park_batch_below_swap_cost", {
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      amount_sats: amountSats,
      mint_url: batch.mint_url,
      total_sats: batch.total_sats,
      required_sats: requiredSats,
      short_by_sats: shortBySats,
      batches_seen: batches.length,
      unpriceable_mints: [...unpriceableMints],
      hint: `A batch at ${batch.mint_url} holds ${batch.total_sats} sats, which covers the ${amountSats}-sat refund but not the ${requiredSats - amountSats} sats that mint charges to swap it. ${nextStep || `It parks automatically once ${shortBySats} more sats land on that lock key; to intervene, fund the DVM or settle manually.`}`,
    });
    return undefined;
  }

  // Every candidate died at the mint, so we never learned whether the
  // accumulator is thin — say that, rather than sending the operator off to
  // fund a DVM that may hold the money already. Before tracked change this surfaced
  // as `drain_swap_failed` carrying the mint's own error; it must stay
  // distinguishable from a genuinely empty accumulator.
  if (unpriceableMints.size > 0) {
    const mints = [...unpriceableMints];
    logDrain(ctx, "drain_park_no_priceable_batch", {
      credit_id: drain.credit_id,
      drain_id: drain.drain_id,
      amount_sats: amountSats,
      batches_seen: batches.length,
      unpriceable_mints: mints,
      hint: `No accumulator batch could be priced: ${mints.join(", ")} would not answer for its keyset, so the refund's swap cost is unknown. This is a mint problem, not a funding one${nextStep ? `. ${nextStep}` : " — the drain retries on the next tick"}, and the per-batch \`drain_park_batch_unpriceable\` lines carry each mint's error.`,
    });
    return undefined;
  }

  logDrain(ctx, "drain_park_insufficient_batch", {
    credit_id: drain.credit_id,
    drain_id: drain.drain_id,
    amount_sats: amountSats,
    batches_seen: batches.length,
    hint: `No single accumulator batch covers this refund yet. ${nextStep || "It parks automatically once enough value accumulates on one lock key at one mint; to intervene, fund the DVM or settle manually."}`,
  });
  return undefined;
}

/** 404 from the drain admin routes — the DVM predates tracked change. */
function isMissingDrainSurface(err: unknown): boolean {
  return err instanceof AdminApiError && err.status === 404;
}

function logDrain(ctx: DrainServiceContext, level: string, fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level,
      ts: new Date().toISOString(),
      dvm_id: ctx.dvmId,
      handle: ctx.handle,
      ...fields,
    })
  );
}

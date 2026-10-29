// Builder-owned payout surface shipped with dvmctl.
import type { MeltQuoteBolt11Response, ProofLike } from "@cashu/cashu-ts";
import {
  type BuilderLockKeypair,
  checkMeltQuoteState,
  DvmError,
  fetchLnurlPayInvoice,
  fetchMeltQuote,
  getInputFeesForProofs,
  type LockPubkey,
  makeInvoice,
  missingDleqRecoveryDiagnostic,
  type NwcConnection,
  parseNwcUri,
  toLockPubkey,
} from "@dvmkit/sdk/internal";

import {
  AdminApiError,
  type AdminBatch,
  AdminCashuClient,
  rethrowIfAdminStateUnavailable,
  rethrowIfBadSignature,
} from "../../lib/admin-cashu-client.ts";
import {
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../lib/cashu/builder-lock-identity.ts";
import { drainHoldElapsedMs, recordDrainState } from "../../lib/drain-hold-state.ts";
import { parseDurationMs } from "../../lib/duration.ts";
import {
  appendAcknowledgement,
  appendPostMelt,
  appendPreMelt,
  type InFlightMelt,
  lookupMeltQuote,
  readInFlight,
  readMeltHistory,
} from "../../lib/melt-pending-log.ts";
import { withMeltPendingLock } from "../../lib/melt-pending-lock.ts";
import { canonicalMint, freshQuoteConfirmsPaid, MeltCustody, prepareCustody, recoverCustody, type CustodyOperation } from "../../lib/melt-change-custody.ts";
import { recordMeltSuccess } from "../../lib/melt-success-state.ts";
import { requireAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { getBuilderDvm } from "../../shared/builder-store.ts";
import { info, json } from "../../shared/output.ts";
import { dvmUrlUnsetError } from "./dvm-url.ts";
import { type ResolvedDvm, resolveDvm } from "./resolve-dvm.ts";
import { type DrainServiceContext, serviceDrains } from "./drain-service.ts";

export interface MeltPendingOptions {
  /** Lightning address invoices are fetched from per batch via LNURL-pay.
   *  Overrides any `payout_ln_address` persisted in builder.json. */
  payout?: string;
  /** DVM admin endpoint URL override. When unset, the CLI resolves the URL
   *  via the platform API (`getDvm`). Skipping that lookup is required for
   *  self-hosted DVMs and local-dev. */
  endpoint?: string;
  /** When true, poll forever (daemon mode). */
  watch?: boolean;
  /** Poll interval in seconds for `--watch`. Default 60. Clamped [10, 3600]. */
  interval?: number;
  /**
   * Service credit drains and stop — never sweep accumulator batches to the
   * payout address. Pays the refunds owed to callers now and
   * leaves revenue melting to the scheduled job. `--payout` is not required
   * in this mode, because nothing melts. A one-shot run exits non-zero unless
   * every owed refund was settled — see {@link drainsUnsettled}.
   */
  drainsOnly?: boolean;
  /**
   * How long the drain surface may stay unreadable before a one-shot sweep
   * exits non-zero instead of holding the melt again. Short
   * duration string (`30s` / `5m` / `2h` / `1d`); defaults to
   * {@link DEFAULT_HOLD_ALARM_AFTER}.
   */
  holdAlarmAfter?: string;
  /**
   * The send-capable NWC connection refunds are bought over.
   * Falls back to `DVMKIT_REFUND_NWC_URL`. Without one, a refund the
   * accumulator cannot cover stays queued rather than being minted.
   */
  refundNwc?: string;
  /**
   * Mint the payout invoice from this NWC connection instead of resolving a
   * Lightning address. Falls back to `DVMKIT_MELT_PAYOUT_NWC_URL`.
   * A self-hosted Lightning node is often reachable over NWC and not over
   * LNURL at all, which is exactly the case when the melt destination is the
   * hub the refund worker spends from.
   */
  payoutNwc?: string;
  /**
   * Record that this unresolved melt quote is known to be stuck, then exit
   * without sweeping. Its rows stay held and recovery keeps checking it; the
   * in-flight alarm just stops failing the run. Requires {@link reason}.
   */
  acknowledgeStuck?: string;
  /** Why the quote is acknowledged — kept in the journal and logged each sweep. */
  reason?: string;
  human?: boolean;
  org?: string;
}

/** Per-tick summary surfaced as JSON (and as one log line in `--watch`). */
export interface TickSummary {
  tick: string;
  dvm_id: string;
  endpoint: string;
  batches_seen: number;
  batches_melted: number;
  batches_skipped: number;
  batches_failed: number;
  sats_melted: number;
  recovered: number;
  /** Credit-drain servicing counters. */
  drains_seen: number;
  drains_parked: number;
  /** Of those parks, how many bought their notes from the hub. */
  drains_jit_minted: number;
  drains_failed: number;
  /** Refunds nothing was attempted for this tick — see `DrainServiceSummary.drains_queued`. */
  drains_queued: number;
  drains_manual: number;
  /** Channel-backed drains their own close settles — seen, not owed by anyone here. */
  drains_channel: number;
  drains_recovered: number;
  /**
   * False when the pending-drain fetch failed, so the counters above read zero
   * for want of an answer rather than for want of work. Read it before them: a
   * run that could not reach the DVM's admin surface knows nothing about what
   * it owes. `drains_recovered` is the one exception — recovery replays the
   * local park log before the fetch, so it can be non-zero here.
   */
  drain_state_known: boolean;
  /**
   * When `drain_state_known` is false: the timestamp at which this DVM's drain
   * surface first stopped answering, carried across runs. A hold is meant to be
   * a pause, so read this to tell one from a standstill — past
   * `--hold-alarm-after` a one-shot sweep exits `drain_state_unknown_sustained`
   * rather than holding again. Null whenever the surface is readable.
   */
  drain_state_unknown_since: string | null;
  /** True when melting was held back behind unserviced cashu drain liability. */
  melt_held: boolean;
  /**
   * Why the batch sweep did not run, when it was skipped **by configuration**
   * rather than by outcome. `"drains_only"` is the only value today. `null`
   * means the sweep was attempted — read `melt_held` and the batch counters
   * for what happened. Never conflate this with a failure: zero
   * `batches_melted` under `melt_skipped` is the operator's instruction, not
   * a stuck payout.
   */
  melt_skipped: "drains_only" | null;
  /**
   * In-flight melts still unresolved after this tick's recovery that an
   * operator acknowledged with `--acknowledge-stuck`. Counted per melt quote,
   * not per server batch. Their rows stay held and their alarm no longer fails
   * the run, so this is where they stay visible.
   */
  acknowledged_melts: number;
  acknowledged_sats: number;
}

const DEFAULT_MELT_INPUT_CAP = 200;
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 3600;
/**
 * Default ceiling on an unreadable drain surface. A day is long enough that the
 * daily melter never alarms on the transient 504 an autostopped DVM serves
 * while Fly boots it, and short enough that a mint-locked accumulator and
 * unparked caller refunds are noticed on the second run rather than never.
 */
const DEFAULT_HOLD_ALARM_AFTER = "24h";
const IN_FLIGHT_MELT_ALARM_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Entry point for `dvmctl melt-pending <handle>`. Drains a DVM's pending
 * accumulator batches by deriving the per-DVM lock privkey locally, signing
 * NUT-11 witnesses, melting at the mint, and posting `mark-melted` back to
 * the DVM. With `--watch`, runs as a long-lived poll loop suitable for
 * systemd.
 */
export async function meltPending(handle: string, opts: MeltPendingOptions): Promise<void> {
  if (opts.acknowledgeStuck !== undefined || opts.reason !== undefined) {
    await acknowledgeStuck(handle, opts);
    return;
  }
  const ctx = await resolveContext(handle, opts);

  if (!opts.watch) {
    const summary = await runTick(ctx);
    emitTickSummary(summary, !!opts.human, ctx.handle);
    const failure = runFailure(ctx, summary);
    if (failure) throw failure;
    recordCleanRun(ctx, summary);
    return;
  }

  await runWatchLoop(ctx, opts);
}

interface MeltContext {
  handle: string;
  dvmId: string;
  endpoint: string;
  /** Keypair matching the DVM's advertised current key — signs admin-route challenges. */
  currentKeypair: BuilderLockKeypair;
  /**
   * Lock pubkey → keypair lookup walking `0..current_rotation_index`. Lets
   * the per-batch melt derive the matching privkey when a batch's
   * `lock_pubkey` references a pre-rotation key still in the grace window.
   * All entries derive from the same mnemonic + canonical_id, so
   * the map is bounded by the number of rotations the operator has run.
   */
  keypairsByPubkey: Map<LockPubkey, BuilderLockKeypair>;
  /** Empty only under {@link MeltContext.drainsOnly}, or when {@link MeltContext.payoutNwc} carries the destination. */
  payoutLnAddress: string;
  /** Parsed payout connection when the melt destination is an NWC wallet rather than an LN address. */
  payoutNwc?: NwcConnection;
  /** When true, `runTick` services drains and returns without sweeping batches. */
  drainsOnly: boolean;
  /** Ceiling on an unreadable drain surface, ms — see {@link holdSustained}. */
  holdAlarmAfterMs: number;
  client: AdminCashuClient;
  /** Credit-drain servicing context — shares client + keypairs. */
  drainCtx: DrainServiceContext;
  /** Test seam — defaults to bound `globalThis.fetch`. */
  fetchImpl: typeof fetch;
  human: boolean;
}

/**
 * Append an acknowledgement for one stuck quote and exit. Touches no mint and
 * melts nothing; only the DVM-id resolution the sweep itself uses runs, so the
 * entry lands under the same journal key the sweep reads.
 */
async function acknowledgeStuck(handle: string, opts: MeltPendingOptions): Promise<void> {
  const quoteId = opts.acknowledgeStuck?.trim();
  const reason = opts.reason?.trim();
  if (!quoteId || !reason) {
    throw new DvmError(
      "acknowledge_reason_required",
      "`--acknowledge-stuck <quote-id>` and `--reason <text>` go together, and neither may be empty.",
      "Pass the quote id from the `melt_pending_batch_in_flight` line along with a reason, e.g. `--acknowledge-stuck <quote-id> --reason \"mint support ticket open\"`."
    );
  }
  if (opts.watch || opts.drainsOnly) {
    throw new DvmError(
      "acknowledge_conflicting_flags",
      "`--acknowledge-stuck` records an acknowledgement and exits; it cannot run with `--watch` or `--drains-only`.",
      "Run the acknowledgement on its own, then start the sweep or daemon as usual."
    );
  }

  const { canonicalDvmId } = await resolveKeyring(handle, opts);
  await withMeltPendingLock(canonicalDvmId, () => {
    const found = lookupMeltQuote(canonicalDvmId, quoteId);
    if (found.state === "unknown") {
      throw new DvmError(
        "melt_quote_not_found",
        `No melt for quote ${quoteId} is journalled for ${handle} on this machine.`,
        "Copy the `quote_id` from a `melt_pending_batch_in_flight` line this DVM's sweep logged. The journal is local, so run this on the host that runs `melt-pending`."
      );
    }
    if (found.state === "resolved") {
      throw new DvmError(
        "melt_quote_resolved",
        `The melt for quote ${quoteId} is already resolved, so there is nothing to acknowledge.`,
        "Its rows were marked melted or released for a new melt. If a sweep still fails, the failing quote is a different one; read its `melt_pending_batch_in_flight` line."
      );
    }
    const ageMs = Math.max(0, Date.now() - found.entry.ts);
    if (ageMs < IN_FLIGHT_MELT_ALARM_AFTER_MS) {
      throw new DvmError(
        "melt_quote_too_young",
        `The melt for quote ${quoteId} has been in flight for ${Math.floor(ageMs / 3_600_000)}h; only one past the 24h alarm can be acknowledged.`,
        "A young pending melt usually settles on its own: the next sweeps keep checking it at the mint. Acknowledge it only once it has stayed stuck past 24h and the mint will not resolve it."
      );
    }

    const record = appendAcknowledgement({
      dvm_id: canonicalDvmId,
      acknowledged_quote_id: quoteId,
      reason,
    });
    const result = {
      acknowledged: true,
      dvm_id: canonicalDvmId,
      dvmId: canonicalDvmId,
      slug: handle,
      quote_id: quoteId,
      mint_url: found.entry.mintUrl,
      row_ids: found.entry.rowIds,
      total_sats: found.entry.totalSats,
      age_ms: ageMs,
      reason,
      acknowledged_at: new Date(record.ts).toISOString(),
    };
    if (opts.human) {
      info(
        `Acknowledged stuck melt ${quoteId} (${found.entry.totalSats} sats, ${Math.floor(ageMs / 3_600_000)}h in flight). ` +
          "Its rows stay held and later sweeps keep checking the quote, but it no longer fails the run."
      );
    } else {
      json(result);
    }
  });
}

async function resolveKeyring(handle: string, opts: MeltPendingOptions) {
  const selected = opts.endpoint ? undefined : await resolveDvm(handle, opts);
  const keyring = selected
    ? resolveBuilderLockKeyring(selected.dvmId)
    : await resolveBuilderLockKeyringByHandle(handle, opts.endpoint);
  return { selected, ...keyring };
}

async function resolveContext(handle: string, opts: MeltPendingOptions): Promise<MeltContext> {
  const { selected, canonicalDvmId, currentKeypair, keypairsByPubkey } = await resolveKeyring(
    handle,
    opts
  );

  const endpoint = await resolveEndpoint(handle, opts.endpoint, selected);

  const drainsOnly = !!opts.drainsOnly;
  const payoutLnAddress = opts.payout ?? getBuilderDvm(canonicalDvmId)?.payout_ln_address;
  // A wallet reachable over NWC can mint its own payout invoice, which an
  // LN address cannot always do for it: a self-hosted node has no LNURL-pay
  // endpoint unless someone hosts one, and the melt destination under
  // tracked change is exactly such a node — the hub the refund worker spends from.
  // It wins over the address when both are set, because it is the more
  // specific instruction.
  const payoutNwc = parsePayoutNwc(opts.payoutNwc ?? process.env.DVMKIT_MELT_PAYOUT_NWC_URL);
  // Under `--drains-only` nothing melts, so a payout destination is not just
  // unused — requiring it would be a lie about what the run needs.
  if (!payoutLnAddress && !payoutNwc && !drainsOnly) {
    throw new DvmError(
      "no_payout_destination",
      "No payout destination configured.",
      "Pass `--payout <ln-address>` or set a default with `dvmctl set-payout " +
        handle +
        " <ln-address>`. To melt into a wallet reachable over NWC instead, pass `--payout-nwc <wallet connection URI>` or set DVMKIT_MELT_PAYOUT_NWC_URL."
    );
  }
  const refundNwcUri = opts.refundNwc ?? process.env.DVMKIT_REFUND_NWC_URL;

  const client = new AdminCashuClient({
    endpoint,
    dvmId: canonicalDvmId,
    privkeyHex: currentKeypair.privkey,
  });

  return {
    handle,
    dvmId: canonicalDvmId,
    endpoint,
    currentKeypair,
    keypairsByPubkey,
    payoutLnAddress: payoutLnAddress ?? "",
    ...(payoutNwc ? { payoutNwc } : {}),
    drainsOnly,
    holdAlarmAfterMs: resolveHoldAlarmAfterMs(opts.holdAlarmAfter),
    client,
    drainCtx: {
      dvmId: canonicalDvmId,
      handle,
      client,
      keypairsByPubkey,
      currentKeypair,
      ...(refundNwcUri ? { refundNwc: { uri: refundNwcUri } } : {}),
    },
    fetchImpl: globalThis.fetch.bind(globalThis),
    human: !!opts.human,
  };
}

/** Refuse an invalid explicit wallet; falling back could pay a different destination. */
function parsePayoutNwc(uri: string | undefined): NwcConnection | undefined {
  if (!uri) return undefined;
  try {
    return parseNwcUri(uri);
  } catch (err) {
    throw new DvmError(
      "invalid_payout_nwc",
      `Melt payout NWC connection could not be read: ${err instanceof Error ? err.message : String(err)}`,
      "Re-copy the `wallet connection URI` URI from the wallet the melt should land in. Nothing was melted — the run refuses rather than paying the Lightning address you did not name."
    );
  }
}

/** Self-hosted NWC wallets can issue their own invoices without a hosted LNURL-pay address. */
async function payoutInvoice(ctx: MeltContext, msats: number): Promise<string> {
  if (ctx.payoutNwc) {
    const invoice = await makeInvoice(ctx.payoutNwc, {
      amountMsats: msats,
      description: `dvmkit melt · ${ctx.handle}`,
    });
    if (!invoice.invoice) {
      throw new DvmError(
        "payout_invoice_missing",
        "The payout wallet returned no bolt11 for the melt.",
        "The wallet answered `make_invoice` without an invoice. Check the connection permits `make_invoice`, then re-run — nothing has melted."
      );
    }
    return invoice.invoice;
  }
  return fetchLnurlPayInvoice(ctx.payoutLnAddress, msats);
}

function resolveHoldAlarmAfterMs(input: string | undefined): number {
  try {
    return parseDurationMs(input ?? DEFAULT_HOLD_ALARM_AFTER);
  } catch (err) {
    throw new DvmError(
      "invalid_duration",
      err instanceof Error ? err.message : String(err),
      "`--hold-alarm-after` takes one count and one unit — e.g. `6h`, `2d`. Raise it to give a flaky DVM more rope; lower it to hear about a stalled melt sooner."
    );
  }
}

async function resolveEndpoint(
  handle: string,
  override: string | undefined,
  selected?: ResolvedDvm
): Promise<string> {
  if (override) return override.replace(/\/+$/, "");
  const { token, platformUrl } = selected ?? requireAuth();
  const { dvm } = await platformClient.getDvm(platformUrl, token, selected?.dvmId ?? handle);
  if (!dvm.url) {
    throw dvmUrlUnsetError(handle, dvm);
  }
  return dvm.url.replace(/\/+$/, "");
}

/**
 * Recover in-flight melts, service refunds, then sweep batches. Unserviced or
 * unknown cashu liability holds the payout to avoid stranding caller refunds.
 * drains_only reports a configured skip separately from a hold or failure.
 * Record each drain-state response so holdSustained can alarm on a lasting outage.
 */
async function runTick(ctx: MeltContext): Promise<TickSummary> {
  return withMeltPendingLock("builder-payout-custody", () =>
    withMeltPendingLock(ctx.dvmId, () => runLockedTick({ ...ctx, custody: new MeltCustody() }))
  );
}

type CustodyContext = MeltContext & { custody: MeltCustody };

async function runLockedTick(ctx: CustodyContext): Promise<TickSummary> {
  const recovery = await runRecovery(ctx);
  const drains = await serviceDrains({ ...ctx.drainCtx,
    isMeltedRow: (mintUrl, rowId) => ctx.custody.spentByPaidMelt(ctx.dvmId, mintUrl, rowId) });
  const meltHeld = !drains.fetched || drains.cashu_liability_sats_after > 0;
  const unknownSince = recordDrainState(ctx.dvmId, drains.fetched);
  const heldForMs = drainHoldElapsedMs(unknownSince);
  if (heldForMs !== null && heldForMs >= ctx.holdAlarmAfterMs) {
    // Loud on both paths: a one-shot converts this into a non-zero exit below,
    // and a daemon has no exit code to speak with — killing it would only stop
    // the retries that might still fix things — so stderr is its channel.
    logErr(
      ctx,
      "melt_pending_drain_hold_sustained",
      new Error(
        `Pending drains have been unreadable since ${unknownSince}; the payout melt has been held ever since.`
      ),
      { drain_state_unknown_since: unknownSince, hold_alarm_after_ms: ctx.holdAlarmAfterMs }
    );
  }

  const acknowledged = recovery.unresolved.filter(isAcknowledgedPending);
  const summaryBase = {
    tick: new Date().toISOString(),
    dvm_id: ctx.dvmId,
    endpoint: ctx.endpoint,
    recovered: recovery.recovered,
    drains_seen: drains.drains_seen,
    drains_parked: drains.drains_parked,
    drains_jit_minted: drains.drains_jit_minted,
    drains_failed: drains.drains_failed,
    drains_queued: drains.drains_queued,
    drains_manual: drains.drains_manual,
    drains_channel: drains.drains_channel,
    drains_recovered: drains.recovered,
    drain_state_known: drains.fetched,
    drain_state_unknown_since: unknownSince,
    melt_held: meltHeld,
    acknowledged_melts: acknowledged.length,
    acknowledged_sats: acknowledged.reduce((sum, entry) => sum + entry.totalSats, 0),
  };
  const noBatches = {
    batches_seen: 0,
    batches_melted: 0,
    batches_skipped: 0,
    batches_failed: 0,
    sats_melted: 0,
  };

  if (ctx.drainsOnly) {
    // Skipped by configuration, not by outcome. Logged and reported distinctly
    // from `melt_held` so a zero-melt tick is never read as a stuck payout.
    logEvent(ctx, "melt_pending_skipped_drains_only", {
      drain_liability_sats: drains.cashu_liability_sats_after,
      drain_state_known: drains.fetched,
    });
    return { ...summaryBase, ...noBatches, melt_skipped: "drains_only" };
  }

  if (meltHeld) {
    logEvent(ctx, "melt_pending_held_for_drains", {
      drain_liability_sats: drains.cashu_liability_sats_after,
      drain_state_known: drains.fetched,
    });
    return { ...summaryBase, ...noBatches, melt_skipped: null };
  }

  let res;
  try {
    res = await ctx.client.getPendingBatches();
  } catch (err) {
    rethrowIfBadSignature(err);
    rethrowIfAdminStateUnavailable(err);
    // Surfacing this as a batch-level failure would lie to the agent
    // (`batches_failed: 1` despite zero batches having been attempted).
    // Throw so the one-shot exits non-zero with a clear code and `--watch`
    // logs the tick error and retries.
    throw new DvmError(
      "pending_batches_fetch_failed",
      "Failed to fetch pending batches from the DVM admin endpoint.",
      "Check DVM connectivity and retry the same command."
    );
  }

  let melted = 0;
  let skipped = 0;
  let failed = 0;
  let satsMelted = 0;
  const inputCapsByMint = new Map<string, number>();
  const unresolvedByRow = new Map(
    recovery.unresolved.flatMap((entry) => entry.rowIds.map((rowId) => [rowId, entry] as const))
  );
  for (const batch of res.batches) {
    const result = await meltBatchChunks(ctx, batch, unresolvedByRow, inputCapsByMint);
    if (result.outcome === "melted") melted++;
    else if (result.outcome === "skipped") skipped++;
    else failed++;
    satsMelted += result.satsMelted;
  }

  return {
    ...summaryBase,
    batches_seen: res.batches.length,
    batches_melted: melted,
    batches_skipped: skipped,
    batches_failed: failed,
    sats_melted: satsMelted,
    melt_skipped: null,
  };
}

type BatchOutcome = "melted" | "skipped" | "failed";

/** Keep summary counters per server batch, even when only some chunks settle. */
async function meltBatchChunks(
  ctx: CustodyContext,
  batch: AdminBatch,
  unresolvedByRow: Map<string, UnresolvedMelt>,
  inputCapsByMint: Map<string, number>
): Promise<{ outcome: BatchOutcome; satsMelted: number }> {
  // Slicing by position is safe only with the admin API's one-row-per-proof contract.
  if (batch.row_ids.length !== batch.proofs.length || new Set(batch.row_ids).size !== batch.row_ids.length ||
      !Number.isSafeInteger(batch.total_sats) || batch.proofs.some(p => !Number.isSafeInteger(p.amount) || p.amount <= 0) ||
      batch.proofs.reduce((sum, p) => sum + p.amount, 0) !== batch.total_sats) {
    logErr(ctx, "melt_pending_invalid_batch", new Error("Invalid batch row or native amount mapping"), {
      mint_url: batch.mint_url,
    });
    return { outcome: "failed", satsMelted: 0 };
  }

  let failed = false;
  let skipped = false;
  let satsMelted = 0;
  const availableIndices: number[] = [];
  const heldEntries = new Set<UnresolvedMelt>();
  batch.row_ids.forEach((rowId, index) => {
    const unresolved = unresolvedByRow.get(rowId);
    if (unresolved) { heldEntries.add(unresolved); return; }
    const known = ctx.custody.operations(ctx.dvmId).find(op => op.submission !== "rejected" &&
      op.mint === canonicalMint(batch.mint_url) && op.rows.includes(rowId));
    if (!known) { availableIndices.push(index); return; }
    if (known.acknowledged) {
      skipped = true;
      logEvent(ctx, "melt_pending_row_already_acknowledged", { quote_id: known.quote, row_id: rowId });
    } else {
      heldEntries.add({ ts: known.created, dvmId: known.dvm, rowIds: known.rows, mintUrl: known.mint,
        quoteId: known.quote, lockPubkey: known.lock, totalSats: Number(known.gross),
        pendingReason: known.payment === "PENDING" ? "mint_pending" : known.payment === "UNPAID" ? "mint_unpaid" : "check_failed" });
    }
  });
  for (const entry of heldEntries) {
    const ageMs = Math.max(0, Date.now() - entry.ts);
    if (isAcknowledgedPending(entry)) {
      logEvent(ctx, "melt_pending_batch_acknowledged", {
        mint_url: entry.mintUrl,
        quote_id: entry.quoteId,
        row_ids: entry.rowIds,
        age_ms: ageMs,
        reason: entry.acknowledged.reason,
        acknowledged_at: new Date(entry.acknowledged.ts).toISOString(),
      });
      skipped = true;
      continue;
    }
    const alarmed = ageMs >= IN_FLIGHT_MELT_ALARM_AFTER_MS;
    logEvent(ctx, "melt_pending_batch_in_flight", {
      mint_url: entry.mintUrl,
      quote_id: entry.quoteId,
      row_ids: entry.rowIds,
      age_ms: ageMs,
      pending_reason: entry.pendingReason,
      ...(alarmed && (entry.pendingReason === "mint_pending" || entry.pendingReason === "mint_unpaid")
        ? {
            hint: `If the mint will not resolve this quote, record that with \`dvmctl melt-pending ${ctx.handle} --acknowledge-stuck ${entry.quoteId} --reason "<why>"\`; its rows stay held and recovery keeps checking it.`,
          }
        : {}),
    });
    if (alarmed) failed = true;
    else skipped = true;
  }

  let offset = 0;
  while (offset < availableIndices.length) {
    const cap = inputCapsByMint.get(batch.mint_url) ?? DEFAULT_MELT_INPUT_CAP;
    const indices = availableIndices.slice(offset, offset + cap);
    const proofs = indices.map((i) => batch.proofs[i]);
    const chunk: AdminBatch = {
      ...batch,
      proofs,
      row_ids: indices.map((i) => batch.row_ids[i]),
      total_sats: proofs.reduce((sum, proof) => sum + proof.amount, 0),
    };
    const outcome = await meltBatch(ctx, chunk);
    if (outcome === "input_cap_exceeded" && indices.length > 1) {
      const reducedCap = Math.max(1, Math.floor(indices.length / 2));
      inputCapsByMint.set(batch.mint_url, reducedCap);
      logEvent(ctx, "melt_pending_input_cap_reduced", {
        mint_url: batch.mint_url,
        previous_input_cap: cap,
        input_cap: reducedCap,
      });
      // A definitive size rejection spent nothing. Retry these rows with a fresh quote.
      continue;
    }
    if (outcome === "melted") satsMelted += chunk.total_sats;
    else if (outcome === "skipped") skipped = true;
    else failed = true;
    offset += indices.length;
  }

  return { outcome: failed ? "failed" : skipped ? "skipped" : "melted", satsMelted };
}

async function meltBatch(
  ctx: CustodyContext,
  batch: AdminBatch
): Promise<BatchOutcome | "input_cap_exceeded"> {
  const batchKeypair = ctx.keypairsByPubkey.get(toLockPubkey(batch.lock_pubkey));
  if (!batchKeypair) {
    // No matching privkey in `0..current_rotation_index` — either the batch
    // is locked to a future pubkey (impossible without external state edits)
    // or to a pre-mnemonic key. Either way, the operator has to intervene
    // (tracked change's rotation walker covers rotations performed via this CLI).
    logEvent(ctx, "melt_pending_skip_unknown_lock", {
      mint_url: batch.mint_url,
      lock_pubkey: batch.lock_pubkey,
      row_ids: batch.row_ids,
      total_sats: batch.total_sats,
    });
    return "skipped";
  }

  // Mint cost has three components, only the first two of which are returned
  // in the melt quote:
  //   1. amount       — the bolt11 invoice amount the mint pays out to LN
  //   2. fee_reserve  — LN routing fee buffer (returned by quote)
  //   3. input_fees   — NUT-02 per-proof input fee (NOT in the quote; must be
  //                     computed locally from the keyset's input_fee_ppk)
  // The mint requires `proofs_total >= amount + fee_reserve + input_fees`.
  // Two-pass flow: request invoice for `total - input_fees` (we know that up
  // front); if the quote then needs even more for fee_reserve, re-issue for
  // `total - input_fees - feeReserve` and re-quote.
  let inputFees: number;
  try {
    inputFees = await getInputFeesForProofs(batch.mint_url, batch.proofs);
  } catch (err) {
    logErr(ctx, "melt_pending_input_fee_lookup_failed", err, {
      mint_url: batch.mint_url,
      row_ids: batch.row_ids,
    });
    return "failed";
  }

  if (!Number.isSafeInteger(inputFees) || inputFees < 0) return "failed";

  if (batch.total_sats <= inputFees) {
    logEvent(ctx, "melt_pending_input_fees_exceed_batch", {
      mint_url: batch.mint_url,
      row_ids: batch.row_ids,
      total_sats: batch.total_sats,
      input_fees: inputFees,
    });
    return "skipped";
  }

  let bolt11: string;
  try {
    bolt11 = await payoutInvoice(ctx, (batch.total_sats - inputFees) * 1000);
  } catch (err) {
    logErr(ctx, "melt_pending_payout_invoice_failed", err, {
      destination: ctx.payoutNwc ? "nwc" : "lnurl",
      mint_url: batch.mint_url,
      row_ids: batch.row_ids,
      total_sats: batch.total_sats,
      input_fees: inputFees,
    });
    return "failed";
  }

  let quote: Awaited<ReturnType<typeof fetchMeltQuote>>;
  try {
    quote = await fetchMeltQuote(batch.mint_url, bolt11);
  } catch (err) {
    logErr(ctx, "melt_pending_quote_failed", err, {
      mint_url: batch.mint_url,
      row_ids: batch.row_ids,
    });
    return "failed";
  }

  if (batch.total_sats < quote.amountSats + quote.feeReserveSats + inputFees) {
    const target = batch.total_sats - quote.feeReserveSats - inputFees;
    if (target <= 0) {
      // Combined fee_reserve + input_fees meet or exceed the batch — no
      // sendable invoice amount can fit. Skip; next tick may have a richer
      // batch or different mint conditions.
      logEvent(ctx, "melt_pending_fee_reserve_exceeds_batch", {
        mint_url: batch.mint_url,
        row_ids: batch.row_ids,
        total_sats: batch.total_sats,
        fee_reserve_sats: quote.feeReserveSats,
        input_fees: inputFees,
      });
      return "skipped";
    }

    try {
      bolt11 = await payoutInvoice(ctx, target * 1000);
    } catch (err) {
      logErr(ctx, "melt_pending_payout_invoice_failed", err, {
        destination: ctx.payoutNwc ? "nwc" : "lnurl",
        mint_url: batch.mint_url,
        row_ids: batch.row_ids,
        total_sats: batch.total_sats,
        target_sats: target,
      });
      return "failed";
    }

    try {
      quote = await fetchMeltQuote(batch.mint_url, bolt11);
    } catch (err) {
      logErr(ctx, "melt_pending_quote_failed", err, {
        mint_url: batch.mint_url,
        row_ids: batch.row_ids,
      });
      return "failed";
    }

    if (batch.total_sats < quote.amountSats + quote.feeReserveSats + inputFees) {
      logEvent(ctx, "melt_pending_fee_reserve_too_high", {
        mint_url: batch.mint_url,
        row_ids: batch.row_ids,
        total_sats: batch.total_sats,
        amount_sats: quote.amountSats,
        fee_reserve_sats: quote.feeReserveSats,
        input_fees: inputFees,
        retry: true,
      });
      return "skipped";
    }
  }

  const proofs: ProofLike[] = batch.proofs.map((p) => ({
    id: p.id,
    amount: p.amount,
    secret: p.secret,
    C: p.C,
    ...(p.dleq ? { dleq: { ...p.dleq } } : {}),
  }));

  const { getWallet } = await import("@dvmkit/sdk/internal");
  let wallet: Awaited<ReturnType<typeof getWallet>>;
  try { wallet = await getWallet(batch.mint_url); }
  catch {
    logErr(ctx, "melt_pending_wallet_unavailable", new Error("Wallet metadata is unavailable"));
    return "failed";
  }
  let prepared: Awaited<ReturnType<typeof prepareCustody>>;
  try {
    prepared = await prepareCustody(ctx.custody, wallet, {
      dvm: ctx.dvmId, mint: batch.mint_url, rows: batch.row_ids, lock: batch.lock_pubkey,
      gross: batch.total_sats, inputFee: inputFees, invoice: bolt11,
    }, quote.rawQuote, proofs);
  } catch {
    logErr(ctx, "melt_pending_prepare_failed", new Error("Could not durably prepare melt outputs"));
    return "failed";
  }
  const { op, preview } = prepared;
  appendPreMelt({
    dvm_id: ctx.dvmId, row_ids: batch.row_ids, mint_url: batch.mint_url,
    quote_id: op.quote, lock_pubkey: batch.lock_pubkey, total_sats: batch.total_sats,
  });
  op.submission = "submission_possible";
  ctx.custody.commit();
  let submissionError = false;
  try {
    const result = await wallet.completeMelt(preview, batchKeypair.privkey);
    ctx.custody.observe(op, "submission", result);
  } catch (err) {
    submissionError = true;
    // Persist evidence, never the signing key or an SDK error's public message/cause.
    const evidence = err && typeof err === "object" && "quote" in err ? err.quote : null;
    ctx.custody.observe(op, "submission", evidence);
    const recoveryDiagnostic = missingDleqRecoveryDiagnostic(proofs, err);
    const rejectionCode = noSpendRejectionCode(err);
    if (rejectionCode !== null) {
      op.submission = "rejected";
      ctx.custody.commit();
      appendPostMelt({ dvm_id: ctx.dvmId, row_ids: batch.row_ids, quote_id: op.quote,
        status: "failed", error: `mint_rejection_${rejectionCode}` });
      if (batch.proofs.length > 1 && (rejectionCode === 11014 || rejectionCode === 11015)) return "input_cap_exceeded";
      return "failed";
    }
    logErr(ctx, "melt_pending_melt_failed", new Error("Submission outcome requires recovery"), {
      mint_url: batch.mint_url, row_ids: batch.row_ids, quote_id: op.quote,
      ...(recoveryDiagnostic ? { recovery: recoveryDiagnostic } : {}),
    });
  }
  let meltResult: { state: string; preimage: string | null };
  let changeUnresolved = false;
  const observed = op.observations.length;
  try {
    const state = await recoverCustody(ctx.custody, op, wallet);
    meltResult = { state, preimage: op.preimage ?? null };
    logEvent(ctx, "melt_pending_change_custody", ctx.custody.status(op));
  } catch (err) {
    if (freshPayment(ctx, op, observed, err) !== "settled") {
      logErr(ctx, "melt_pending_recovery_check_failed", new Error("Fresh quote validation failed"), { quote_id: op.quote });
      return "failed";
    }
    changeUnresolved = true;
    meltResult = { state: op.payment, preimage: op.preimage ?? null };
  }
  if (meltResult.state === "PENDING") {
    if (submissionError) return "failed";
    logEvent(ctx, "melt_pending_payment_pending", {
      mint_url: batch.mint_url,
      row_ids: batch.row_ids,
      quote_id: quote.rawQuote.quote,
    });
    return "skipped";
  }

  if (meltResult.state !== "PAID" || !meltResult.preimage) {
    // Keep the pre-melt unpaired: the mint may still settle or release the
    // proofs, and only a later quote-state lookup can distinguish those.
    logErr(
      ctx,
      "melt_pending_missing_preimage_after_success",
      new Error(`mint returned ${meltResult.state} without confirmed PAID state and payment_preimage`),
      {
        mint_url: batch.mint_url,
        row_ids: batch.row_ids,
        quote_id: quote.rawQuote.quote,
      }
    );
    return "failed";
  }

  try {
    await ctx.client.markMelted({
      row_ids: batch.row_ids,
      melt_quote_id: quote.rawQuote.quote,
      payment_preimage: meltResult.preimage,
    });
  } catch (err) {
    rethrowIfAdminStateUnavailable(err);
    // The mint already settled the LN payment — proofs are SPENT. Leave the
    // pre-melt entry unpaired so the next run's recovery sweep calls
    // `checkMeltQuoteState`, gets PAID + preimage, and forwards to
    // `mark-melted`. Appending a post-melt here would close the pair and
    // strand the preimage.
    logErr(ctx, "melt_pending_mark_melted_failed", err, {
      mint_url: batch.mint_url,
      row_ids: batch.row_ids,
      quote_id: quote.rawQuote.quote,
    });
    return "failed";
  }

  op.acknowledged = true;
  ctx.custody.commit();
  if (changeUnresolved) logChangeUnresolved(ctx, op);
  appendPostMelt({
    dvm_id: ctx.dvmId,
    row_ids: batch.row_ids,
    quote_id: quote.rawQuote.quote,
    status: "success",
    preimage: meltResult.preimage,
  });
  logEvent(ctx, "melt_pending_batch_melted", {
    mint_url: batch.mint_url,
    row_ids: batch.row_ids,
    total_sats: batch.total_sats,
    quote_id: quote.rawQuote.quote,
  });
  // The payout landed, but its change did not reconcile: keep the run's alarm.
  return changeUnresolved ? "failed" : "melted";
}

/**
 * Whether this tick's own quote answer settles the payment after change
 * custody failed. `recoverCustody` records the answer before validating it and
 * commits PAID with its preimage before touching change, so a failure in the
 * change phase leaves a confirming answer here; a change failure does not
 * unspend the inputs, and the rows must still be acknowledged. No answer this
 * tick (transport loss, a held-change refresh) is unknown. An answer that does
 * not itself confirm PAID with the recorded preimage is a contradiction and
 * never acknowledges, whatever an earlier tick recorded.
 */
function freshPayment(ctx: CustodyContext, op: CustodyOperation, observedBefore: number, err: unknown): "settled" | "contradicted" | "unknown" {
  if (err instanceof DvmError && err.code === "melt_custody_io") return "unknown";
  const answers = op.observations.slice(observedBefore).filter(o => o.kind === "quote");
  if (answers.length === 0) return "unknown";
  if (op.payment === "PAID" && freshQuoteConfirmsPaid(op, answers[answers.length - 1].data)) return "settled";
  logErr(ctx, "melt_pending_fresh_quote_contradicts", new Error("Fresh quote contradicts the recorded payment"), {
    quote_id: op.quote, recorded_payment_state: op.payment,
    hint: "The mint's answer for this quote no longer matches what was recorded, so its rows were not acknowledged. Inspect the quote at the mint before acting.",
  });
  return "contradicted";
}

function logChangeUnresolved(ctx: CustodyContext, op: CustodyOperation): void {
  logErr(ctx, "melt_pending_change_unresolved",
    new Error("Payment settled but its change could not be reconciled"),
    { ...ctx.custody.status(op), hint: "The payout is paid and mark-melted acknowledged its rows. This melt's change did not reconcile with the mint's answer, so it stays quarantined in melt-custody.json for inspection, and recovery no longer re-checks it." });
}

/** Only explicit final submission rejections prove this request cannot later pay. */
function noSpendRejectionCode(err: unknown): number | null {
  // cashu-ts wraps a mint's keyset rejection after attempting a snapshot
  // refresh. Both repair outcomes still prove rejection; arbitrary causes
  // (especially a MeltChangeError after payment) do not.
  if (
    err instanceof Error && err.name === "StaleKeysetError" &&
    "repaired" in err && typeof err.repaired === "boolean"
  ) {
    const code = mintOperationCode(err.cause);
    return code === 12001 || code === 12002 || code === 12003 ? code : null;
  }
  const code = mintOperationCode(err);
  // Only assigned integer rejections establish finality. A direct failed
  // payment or expired-quote rejection differs from observing UNPAID/expiry
  // after a response was lost: this submission cannot later settle.
  return code !== null &&
    Number.isInteger(code) &&
    (code === 10001 || (code >= 11005 && code <= 11015) ||
      code === 12001 || code === 12002 || code === 12003 || code === 20004 || code === 20007)
    ? code
    : null;
}

function mintOperationCode(err: unknown): number | null {
  // SDK wallets may use another cashu-ts copy. Match its protocol error shape,
  // not constructor identity; never classify transport errors by message text.
  if (!(err instanceof Error) || err.name !== "MintOperationError" || !("code" in err)) {
    return null;
  }
  return typeof err.code === "number" ? err.code : null;
}

/**
 * On every run, check the log for melts that started but didn't reach a
 * post-melt record. For each: query the mint for the quote's state and
 * either forward the preimage to `mark-melted` (PAID) or keep the entry
 * held for the next tick.
 */
async function runRecovery(
  ctx: CustodyContext
): Promise<{ recovered: number; unresolved: UnresolvedMelt[] }> {
  const allOwned = ctx.custody.operations(ctx.dvmId);
  const owned = allOwned.filter(op => op.submission !== "rejected");
  const inFlight = readInFlight(ctx.dvmId);
  let recovered = 0;
  const unresolved: UnresolvedMelt[] = [];
  for (const op of owned) {
    const audit = inFlight.find(entry => entry.quoteId === op.quote && canonicalMint(entry.mintUrl) === op.mint);
    const entry: InFlightMelt = audit ?? { ts: op.created, dvmId: op.dvm, rowIds: op.rows,
      mintUrl: op.mint, quoteId: op.quote, lockPubkey: op.lock, totalSats: Number(op.gross) };
    if (op.acknowledged && audit) appendPostMelt({ dvm_id: op.dvm, row_ids: op.rows, quote_id: op.quote,
      status: "success", preimage: op.preimage });
    if (op.acknowledged && op.complete && !ctx.custody.records(op).some(p => p.state === "held")) continue;
    // Quarantine is terminal and its rows are acknowledged: re-checking only
    // appends an observation to the custody file on every tick.
    if (op.acknowledged && op.quarantine) continue;
    const wasAcknowledged = op.acknowledged;
    const result = await recoverOwned(ctx, op);
    if (result === "recovered") { if (!wasAcknowledged) recovered++; }
    else if (!op.acknowledged) unresolved.push({ ...entry, pendingReason: result });
  }
  const isOwned = (entry: InFlightMelt) => allOwned.some(op => op.quote === entry.quoteId && op.mint === canonicalMint(entry.mintUrl));
  for (const entry of readMeltHistory(ctx.dvmId)) {
    if (!isOwned(entry)) logEvent(ctx, "melt_pending_change_legacy_missing_material", {
      quote_id: entry.quoteId, change_recovery_status: "legacy_missing_material",
    });
  }
  for (const entry of inFlight) {
    if (isOwned(entry)) continue;
    const result = await recoverOne(ctx, entry);
    if (result === "recovered") recovered++;
    else unresolved.push({ ...entry, pendingReason: result });
  }
  return { recovered, unresolved };
}

/**
 * Why recovery left a melt unresolved. Acknowledgement silences alarms for
 * PENDING and UNPAID observations without releasing rows. The other reasons
 * mean the mint was unreachable, broke protocol, or paid while the DVM refused
 * the preimage, so sats may already have left without the rows being marked
 * melted. Those keep alarming.
 */
type PendingReason =
  | "mint_pending"
  | "mint_unpaid"
  | "check_failed"
  | "paid_no_preimage"
  | "mark_melted_failed";

type UnresolvedMelt = InFlightMelt & { pendingReason: PendingReason };

function isAcknowledgedPending(
  entry: UnresolvedMelt
): entry is UnresolvedMelt & Required<Pick<InFlightMelt, "acknowledged">> {
  return !!entry.acknowledged &&
    (entry.pendingReason === "mint_pending" || entry.pendingReason === "mint_unpaid");
}

async function recoverOwned(ctx: CustodyContext, op: CustodyOperation): Promise<"recovered" | PendingReason> {
  let changeUnresolved = false;
  const observed = op.observations.length;
  try {
    const { getWallet } = await import("@dvmkit/sdk/internal");
    const wallet = await getWallet(op.mint);
    const needsSignatures = ctx.custody.records(op).some(proof => proof.state === "held" && proof.verification === "unverified");
    if (op.payment === "PAID" && op.complete && op.preimage && !needsSignatures) await ctx.custody.refreshHeld(op, wallet);
    else await recoverCustody(ctx.custody, op, wallet);
    logEvent(ctx, "melt_pending_change_custody", ctx.custody.status(op));
  } catch (err) {
    if (freshPayment(ctx, op, observed, err) !== "settled") {
      logErr(ctx, "melt_pending_recovery_check_failed", new Error("Fresh quote or change evidence validation failed"), { quote_id: op.quote });
      return "check_failed";
    }
    changeUnresolved = true;
  }
  if (op.acknowledged) return "recovered";
  if (op.payment === "PENDING") return "mint_pending";
  if (op.payment === "UNPAID") return "mint_unpaid";
  if (op.payment !== "PAID") return "check_failed";
  if (!op.preimage) return "paid_no_preimage";
  try {
    await ctx.client.markMelted({ row_ids: op.rows, melt_quote_id: op.quote, payment_preimage: op.preimage });
  } catch (err) {
    rethrowIfAdminStateUnavailable(err);
    logErr(ctx, "melt_pending_recovery_mark_melted_failed", new Error("Payment acknowledgement failed"), { quote_id: op.quote });
    return "mark_melted_failed";
  }
  op.acknowledged = true;
  ctx.custody.commit();
  if (changeUnresolved) logChangeUnresolved(ctx, op);
  appendPostMelt({ dvm_id: op.dvm, row_ids: op.rows, quote_id: op.quote, status: "success", preimage: op.preimage });
  return "recovered";
}

async function recoverOne(
  ctx: CustodyContext,
  entry: InFlightMelt
): Promise<"recovered" | PendingReason> {
  let quote: MeltQuoteBolt11Response;
  try {
    quote = await checkMeltQuoteState(entry.mintUrl, entry.quoteId);
  } catch (err) {
    logErr(ctx, "melt_pending_recovery_check_failed", err, {
      mint_url: entry.mintUrl,
      quote_id: entry.quoteId,
    });
    return "check_failed";
  }
  if (quote.state === "PENDING") {
    logEvent(ctx, "melt_pending_recovery_pending", {
      mint_url: entry.mintUrl,
      quote_id: entry.quoteId,
    });
    return "mint_pending";
  }
  if (quote.state === "UNPAID") {
    // UNPAID is an observation, not request finality: a timed-out submission
    // can still arrive after this check, even after quote expiry. Neither time
    // nor repeated UNPAID checks prove cancellation. Only an explicit no-spend
    // rejection at submission closes a failure; otherwise hold indefinitely
    // until PAID with a preimage can be acknowledged. Never re-quote these rows.
    logEvent(ctx, "melt_pending_recovery_unpaid", {
      mint_url: entry.mintUrl,
      quote_id: entry.quoteId,
    });
    return "mint_unpaid";
  }
  if (quote.state !== "PAID") return "check_failed";
  // PAID — forward preimage to the DVM so the rows transition to melted.
  const preimage = quote.payment_preimage;
  if (!preimage) {
    // Protocol-violating mint state: PAID without a preimage. Keep the
    // entry in-flight so subsequent checks may surface it; loud-log so the
    // operator can intervene if the mint is stuck.
    logErr(
      ctx,
      "melt_pending_recovery_paid_no_preimage",
      new Error("mint returned PAID without payment_preimage"),
      {
        mint_url: entry.mintUrl,
        quote_id: entry.quoteId,
      }
    );
    return "paid_no_preimage";
  }
  try {
    await ctx.client.markMelted({
      row_ids: entry.rowIds,
      melt_quote_id: entry.quoteId,
      payment_preimage: preimage,
    });
  } catch (err) {
    rethrowIfAdminStateUnavailable(err);
    logErr(ctx, "melt_pending_recovery_mark_melted_failed", err, {
      mint_url: entry.mintUrl,
      quote_id: entry.quoteId,
    });
    // Keep the entry in-flight — next tick retries.
    return "mark_melted_failed";
  }
  appendPostMelt({
    dvm_id: ctx.dvmId,
    row_ids: entry.rowIds,
    quote_id: entry.quoteId,
    status: "success",
    preimage,
  });
  logEvent(ctx, "melt_pending_recovery_marked_melted", {
    mint_url: entry.mintUrl,
    quote_id: entry.quoteId,
    row_ids: entry.rowIds,
  });
  return "recovered";
}

async function runWatchLoop(ctx: MeltContext, opts: MeltPendingOptions): Promise<void> {
  const requestedInterval = opts.interval ?? DEFAULT_INTERVAL_SECONDS;
  const intervalSeconds = Math.min(
    Math.max(MIN_INTERVAL_SECONDS, requestedInterval),
    MAX_INTERVAL_SECONDS
  );

  let stopping = false;
  let inFlight: Promise<void> | null = null;
  const fatalHolder: { err: DvmError | null } = { err: null };

  logEvent(ctx, "melt_pending_watch_started", {
    interval_seconds: intervalSeconds,
    endpoint: ctx.endpoint,
  });

  // `tick` is hoisted (async function declaration); `shutdown` resolves
  // through closure at call-time, so the forward references below are safe.
  async function tick(): Promise<void> {
    if (stopping) return;
    if (inFlight) {
      logEvent(ctx, "melt_pending_tick_skipped_in_flight", {});
      return;
    }
    inFlight = (async () => {
      try {
        const summary = await runTick(ctx);
        emitTickSummary(summary, ctx.human, ctx.handle);
        // A daemon has no exit code, so this record is the only thing that
        // outlives it — and the only way anyone learns the process died.
        // A tick that fell short deliberately leaves the previous
        // timestamp standing, so "still running" can't pass for "still
        // melting"; it says which check it failed rather than going quiet.
        const failure = runFailure(ctx, summary);
        if (failure) {
          logErr(ctx, "melt_pending_tick_not_recorded", failure);
        } else {
          recordCleanRun(ctx, summary);
        }
      } catch (err) {
        if (err instanceof DvmError && err.code === "admin_bad_signature") {
          fatalHolder.err = err;
          shutdown();
          return;
        }
        logErr(ctx, "melt_pending_tick_error", err);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalSeconds * 1000);

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    logEvent(ctx, "melt_pending_watch_stopping", {});
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Fire one tick immediately, then yield to the interval timer.
  await tick();

  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (stopping && !inFlight) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
    if (typeof poll.unref === "function") poll.unref();
  });

  if (fatalHolder.err) throw fatalHolder.err;
}

/**
 * One-shot exit status and watch liveness use the same failure predicate:
 * refreshing a failed tick's stamp would make an alive daemon look successful.
 */
function runFailure(ctx: MeltContext, summary: TickSummary): DvmError | null {
  if (summary.batches_failed > 0) {
    return new DvmError(
      "batches_failed",
      `${summary.batches_failed} batch(es) failed during this sweep.`,
      "Inspect the per-batch logs above. Transient failures retry on next run."
    );
  }
  // `--drains-only` sweeps nothing, so `batches_failed` is structurally zero
  // and cannot carry the run's outcome. Settling owed refunds *is* the run,
  // and a wrapper that reads total failure as success would sit on them
  // silently — so a run that did not settle everything falls short here.
  // Deliberately not symmetric with a normal sweep: there, a drain still
  // waiting on accumulation holds the melt back but is benign and
  // self-resolving, and failing the daily melter on it would alarm on a
  // healthy DVM.
  if (ctx.drainsOnly) return drainsUnsettled(summary);
  return holdSustained(summary, ctx.holdAlarmAfterMs);
}

/** Detect a stopped scheduler even when no melt runs to emit an exit code. */
function recordCleanRun(ctx: MeltContext, summary: TickSummary): void {
  // Stamped under the mode that ran. A `--drains-only` run settles refunds and
  // deliberately sweeps nothing, so letting it touch the sweep clock would let
  // an hourly drains-only cron vouch for a payout daemon that died weeks ago.
  recordMeltSuccess(ctx.dvmId, ctx.drainsOnly ? "drains_only" : "sweep", {
    handle: ctx.handle,
    batches_melted: summary.batches_melted,
    sats_melted: summary.sats_melted,
    drains_parked: summary.drains_parked,
  });
}

/**
 * Unknown state, failed, queued, and manual refunds require non-zero exit even
 * when failure counters are zero. Channel reclaims are excluded: the caller's
 * cooperative close settles them without an operator action.
 */
function drainsUnsettled(summary: TickSummary): DvmError | null {
  if (!summary.drain_state_known) {
    return new DvmError(
      "drain_state_unknown",
      `Could not read this DVM's pending credit drains, so ${settledBeforeFetchFailed(summary)} ` +
        `and this run cannot say what it still owes.`,
      "See `drain_pending_fetch_failed` above for the underlying error, then check the DVM is reachable and still advertises the lock pubkey this mnemonic derives. Every drain counter except `drains_recovered` reads zero for want of an answer, not for want of work."
    );
  }
  // A queued refund counts here for the same reason a manual one does: this
  // mode exists to settle everything owed, and a refund nothing was attempted
  // for is still a refund the caller has not received. It is deliberately not
  // folded into `drains_failed` — nothing went wrong, there was just nothing
  // configured or no mint answering, and the remedies differ.
  const unsettled = summary.drains_failed + summary.drains_manual + summary.drains_queued;
  if (unsettled === 0) return null;
  return new DvmError(
    "drains_unsettled",
    `${unsettled} credit drain(s) went unsettled ` +
      `(failed=${summary.drains_failed}, manual=${summary.drains_manual}, queued=${summary.drains_queued}).`,
    unsettledDrainHint(summary)
  );
}

/**
 * Unreadable drain state holds payouts to protect refunds. Transient outages
 * exit clean; hold-alarm-after makes a lasting outage actionable. A healthy
 * refund waiting for accumulation can hold indefinitely without an alarm.
 */
function holdSustained(summary: TickSummary, holdAlarmAfterMs: number): DvmError | null {
  const heldForMs = drainHoldElapsedMs(summary.drain_state_unknown_since);
  if (heldForMs === null || heldForMs < holdAlarmAfterMs) return null;
  return new DvmError(
    "drain_state_unknown_sustained",
    `This DVM's pending credit drains have been unreadable since ${summary.drain_state_unknown_since} ` +
      `(${Math.floor(heldForMs / 3_600_000)}h), so the payout melt has been held that whole time and no owed refund has parked.`,
    "See `drain_pending_fetch_failed` above for the underlying error. Check the DVM is up and its admin endpoint reachable — nothing melts and no caller gets refunded until it answers. Raise `--hold-alarm-after` if this DVM is expected to be offline this long."
  );
}

/**
 * Recovery replays the local park log before the pending-drain fetch, so an
 * unknown-state tick may still have settled a refund. Saying "nothing was
 * settled" flat would contradict the `drains_recovered` the same run printed.
 */
function settledBeforeFetchFailed(summary: TickSummary): string {
  if (summary.drains_recovered === 0) return "nothing was settled";
  return `only the ${summary.drains_recovered} park(s) replayed from the local log were settled`;
}

/** One sentence per unsettled bucket — each has a different way out. */
function unsettledDrainHint(summary: TickSummary): string {
  const hints: string[] = [];
  if (summary.drains_failed > 0) {
    hints.push(
      "`failed`: inspect the per-drain logs above — `drain_park_insufficient_batch` means no single accumulator batch covers the refund yet, so fund the DVM or wait for accumulation and it parks on a later run."
    );
  }
  if (summary.drains_manual > 0) {
    hints.push(
      "`manual`: x402/tempo refunds have no builder-held send keys — list them with `dvmctl credit drains-owed <handle>`, send each one yourself, and record it with `dvmctl credit drain-settle <handle> <credit-id> <drain-id> --tx <hash>`."
    );
  }
  if (summary.drains_queued > 0) {
    hints.push(
      "`queued`: nothing was attempted for these — the `drain_jit_*` lines above say why. `drain_jit_unconfigured` means no send wallet is wired to buy the refund's ecash; `drain_jit_no_mint` means no accepted mint would quote; anything naming a payment in flight is being held on purpose so the refund cannot be bought twice."
    );
  }
  return hints.join(" ");
}

function emitTickSummary(summary: TickSummary, human: boolean, slug: string): void {
  if (human) {
    info(
      `[${summary.tick}] dvm=${summary.dvm_id} seen=${summary.batches_seen} ` +
        `melted=${summary.batches_melted} skipped=${summary.batches_skipped} ` +
        `failed=${summary.batches_failed} sats=${summary.sats_melted} recovered=${summary.recovered} ` +
        `drains=${summary.drains_seen} parked=${summary.drains_parked} ` +
        `drain_failed=${summary.drains_failed} drain_queued=${summary.drains_queued} ` +
        `drain_manual=${summary.drains_manual}` +
        `${summary.acknowledged_melts > 0 ? ` acknowledged=${summary.acknowledged_melts} (${summary.acknowledged_sats} sats held)` : ""}` +
        `${drainStateNote(summary)}${meltNote(summary)}`
    );
  } else {
    json({ ...summary, dvmId: summary.dvm_id, slug });
  }
}

/** How long the drain surface has been silent — one tick reads very differently from a week of them. */
function drainStateNote(summary: TickSummary): string {
  if (summary.drain_state_known) return "";
  if (!summary.drain_state_unknown_since) return " (drain state unknown)";
  return ` (drain state unknown since ${summary.drain_state_unknown_since})`;
}

/** Why the human line shows zero melts: an instruction, a hold, or neither. */
function meltNote(summary: TickSummary): string {
  if (summary.melt_skipped === "drains_only") return " (melt skipped: --drains-only)";
  return summary.melt_held ? " (melt held for drains)" : "";
}

function logEvent(ctx: MeltContext, level: string, fields: Record<string, unknown>): void {
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

function logErr(
  ctx: MeltContext,
  level: string,
  err: unknown,
  fields: Record<string, unknown> = {}
): void {
  console.error(
    JSON.stringify({
      level,
      ts: new Date().toISOString(),
      dvm_id: ctx.dvmId,
      handle: ctx.handle,
      error: "The operation could not be completed. Retry recovery.",
      ...(err instanceof DvmError
        ? {
            code: ["admin_bad_signature", "admin_state_unavailable", "batches_failed", "drains_unsettled", "drain_state_unknown", "drain_state_unknown_sustained"].includes(err.code) ? err.code : "melt_pending_error",
            ...(err.code === "admin_state_unavailable" ? { hint: "Retry the same command; inspect database health, restart the DVM, and do not rotate the lock key." } : {}),
          }
        : err instanceof AdminApiError
          ? { status: err.status, code: "admin_request_failed" }
          : {}),
      ...fields,
    })
  );
}

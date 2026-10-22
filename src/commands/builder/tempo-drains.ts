// Builder-owned Tempo repair surface shipped with dvmctl.
import { DvmError } from "@dvmkit/sdk/internal";

import { type AdminTempoDrain } from "../../lib/admin-cashu-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, type AdminConnectionOptions, connectAdmin } from "./admin-connection.ts";

/** Largest page `dvmctl credit tempo-wedged` will ask the DVM for. */
const MAX_LIMIT = 50;

export interface TempoLossesOptions {
  endpoint?: string;
  limit?: number;
  human?: boolean;
  org?: string;
}

/** List terminal Tempo credit losses. This surface is deliberately read-only. */
export async function tempoLosses(handle: string, opts: TempoLossesOptions): Promise<void> {
  const limit = resolveLimit(opts.limit);
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() => client.getTempoCreditLosses({ limit }));
  if (opts.human) {
    if (res.losses.length === 0) {
      info("No Tempo-backed credits have been closed for lost collection.");
      return;
    }
    for (const loss of res.losses) {
      raw(
        `${loss.credit_id}  ${loss.currency} former=${String(loss.former_balance_micro)} micro` +
          `  settled=${loss.settled_on_chain_native} voucher=${loss.highest_voucher_native}` +
          `  channel=${loss.channel_id}`
      );
    }
    info("These are audit records. The credits expose no drawable or reclaimable balance.");
    return;
  }
  json({
    op: "credit_tempo_losses",
    handle,
    dvmId,
    slug: handle,
    losses: res.losses,
    loss_count: res.losses.length,
    display:
      res.losses.length === 0
        ? "No Tempo-backed credits have been closed for lost collection."
        : `${res.losses.length} Tempo-backed credit loss record(s). These credits are terminal and expose no drawable or reclaimable balance.`,
    hint: "This is a read-only audit surface; there is no refund, retry, or mark-sent action.",
  });
}

export interface TempoWedgedOptions {
  /** DVM admin endpoint URL override; skips the platform `getDvm` lookup. */
  endpoint?: string;
  /** Page size. Default 20, max {@link MAX_LIMIT}. */
  limit?: number;
  /** Opaque `next_after` cursor from a previous run. */
  after?: string;
  /** Also list terminal operator decisions — the audit view. */
  includeResolved?: boolean;
  /** How long a drain must have sat before it counts as stuck. Default 5 min. */
  minAgeMs?: number;
  /** `false` (from `--no-evidence`) skips the per-row chain lookups. */
  evidence?: boolean;
  human?: boolean;
  org?: string;
}

export interface TempoReconcileOptions {
  endpoint?: string;
  human?: boolean;
  org?: string;
}

export interface TempoWriteOffOptions {
  endpoint?: string;
  /** Why you are not booking this drain. Recorded on the drain row. */
  note?: string;
  human?: boolean;
  org?: string;
}

export interface TempoDecisionOptions extends AdminConnectionOptions {
  reason?: string;
  evidence?: string;
  confirm?: boolean;
  human?: boolean;
}

const HELD_GUIDANCE = "Use tempo-book only after independently returning the entire held amount; use tempo-release only when no refund was paid. Unknown refund evidence is not zero. refund_payment_proven=true retains a positive-payment fact; false does not prove nonpayment. Separate channel close-report retry/write-off does not pay or release a caller drain.";

const DECISION_HINTS: Record<string, string> = {
  drain_decision_conflict: "Inspect tempo-wedged --include-resolved for the original decision. Replay only the same action, reason, and evidence; do not switch intent to bypass this conflict.",
  tempo_drain_close_pending: "The close may already have been broadcast. Resolve its final close or timed-exit outcome before deciding; elapsed time or a missing transaction hash does not prove nonpayment.",
  tempo_drain_refund_paid: "Some refund payment is already proven. Independently return any remaining amount, then use tempo-book for the whole held refund. Do not release a partial refund.",
  tempo_drain_refund_unknown: "Recover the original refund evidence before asserting nonpayment. An unknown historical amount is not zero; do not release it on that assumption.",
  drain_not_repairable: "Check the DVM, credit, and drain IDs in tempo-wedged. Only supported held Tempo session drains can receive these decisions; completed-job refunds use a separate command.",
  tempo_drain_decision_unavailable: "Configure a durable decision-capable ledger and Tempo session store, plus transactional drain reporting for hosted services. Upgrade the service to @dvmkit/sdk 0.11.0-rc.1 or a compatible later release before retrying the same intent.",
  credit_not_found: "Check the target DVM and exact credit ID in tempo-wedged before submitting the same intent again.",
  drain_not_found: "Check the target DVM and exact credit/drain ID pair in tempo-wedged before submitting the same intent again.",
  invalid_body: "Check the IDs, a reason of 1–2000 characters, and optional evidence of 1–4000 characters. Amount, source, and action overrides are unsupported.",
  unauthorized: "Check the intended service and builder lock identity. Authentication must succeed before a decision can run; do not replace the financial intent.",
};

export async function tempoBook(handle: string, creditId: string, drainId: string, opts: TempoDecisionOptions): Promise<void> {
  return tempoDecision("book_refunded", handle, creditId, drainId, opts);
}

export async function tempoRelease(handle: string, creditId: string, drainId: string, opts: TempoDecisionOptions): Promise<void> {
  return tempoDecision("release", handle, creditId, drainId, opts);
}

async function tempoDecision(
  action: "book_refunded" | "release", handle: string, creditId: string, drainId: string, opts: TempoDecisionOptions
): Promise<void> {
  if (!creditId.trim() || !drainId.trim()) {
    throw new DvmError("invalid_id", "Nonempty credit and drain IDs are required.", "Copy the exact ID pair from tempo-wedged; IDs are matched exactly.");
  }
  const reason = opts.reason?.trim();
  if (!reason || reason.length > 2000) {
    throw new DvmError("invalid_reason", "--reason must contain 1 to 2000 characters after trimming.", "Explain why the whole refund was independently returned, or why no refund was paid.");
  }
  const evidence = opts.evidence?.trim();
  if (opts.evidence !== undefined && (!evidence || evidence.length > 4000)) {
    throw new DvmError("invalid_evidence", "--evidence must contain 1 to 4000 characters after trimming.", "Supply an audit note/reference, or omit --evidence. It is not submitted chain proof.");
  }
  const intent = action === "book_refunded"
    ? "Attest that the entire held refund, including any off-path remainder, was independently returned to the caller."
    : "Record that no refund was paid and restore the original held debit, subject to existing spending restrictions.";
  if (!opts.confirm) {
    throw new DvmError("confirmation_required", "Tempo drain decision confirmation is required.",
      "Repeat the same command with --confirm to submit this intent. No HTTP request has been sent.",
      { handle, credit_id: creditId, drain_id: drainId, action, reason, ...(evidence === undefined ? {} : { evidence }) },
      `${intent} This local intent does not establish eligibility.`);
  }
  const { client, dvmId } = await connectAdmin(handle, opts);
  const body = { credit_id: creditId, drain_id: drainId, reason, ...(evidence === undefined ? {} : { evidence }) };
  const res = await decisionCall(() => action === "book_refunded" ? client.bookTempoDrain(body) : client.releaseTempoDrain(body));
  const outcome = action === "book_refunded"
    ? `Booked the whole held refund of ${res.amount_micro} ${res.currency} micro as independently returned to the caller; this command sent no payment.`
    : `Released the held debit of ${res.amount_micro} ${res.currency} micro because no refund was paid.`;
  const display = `Drain ${res.drain_id} on ${res.credit_id}, channel=${res.channel_id ?? "unknown"}, original native=${res.amount_native ?? "unknown"}. ${res.replayed ? "Replayed the original immutable decision. Nothing moved again. " : ""}${outcome} Current balance=${res.balance_micro}, spendable=${res.spendable_micro} ${res.currency} micro.`;
  const hint = "Replay requires the same action, trimmed reason, and evidence. The decision/time are original; balances are current. Restored balance may remain unspendable because expiry, backing, job holds, and channel restrictions still apply. Evidence is an audit note, not verified escrow refund proof; channel close reports are separate.";
  if (opts.human) {
    info(display);
    info(`Decision: ${res.decision.decision} at ${res.decision.decidedAt} ms; reason=${JSON.stringify(res.decision.reason)}` +
      (res.decision.evidence === undefined ? "" : `; evidence=${JSON.stringify(res.decision.evidence)}`));
    info(hint);
    return;
  }
  json({ op: action === "book_refunded" ? "credit_tempo_book" : "credit_tempo_release", handle, dvmId, slug: handle, ...res, display, hint });
}

async function decisionCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await adminCall(fn);
  } catch (err) {
    if (err instanceof DvmError) {
      const hint = (Object.hasOwn(DECISION_HINTS, err.code) ? DECISION_HINTS[err.code] : undefined)
        ?? (err.code === "not_found" && err.data?.http_status === 404
          ? "This service does not serve held Tempo drain decisions. Upgrade to @dvmkit/sdk 0.11.0-rc.1 or a compatible later release, then retry the same intent."
          : undefined);
      if (hint) {
        const { hint: _providerHint, ...proseSources } = err.proseSources ?? {};
        throw new DvmError(err.code, err.message, hint, err.data, err.display, proseSources);
      }
    }
    throw err;
  }
}

/** List held caller drains separately from channel payout-report obligations. */
export async function tempoWedged(handle: string, opts: TempoWedgedOptions): Promise<void> {
  const limit = resolveLimit(opts.limit);
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.getTempoDrains({
      limit,
      ...(opts.after === undefined ? {} : { after: opts.after }),
      ...(opts.includeResolved ? { includeResolved: true } : {}),
      ...(opts.minAgeMs === undefined ? {} : { minAgeMs: opts.minAgeMs }),
      ...(opts.evidence === false ? { evidence: false } : {}),
    })
  );

  const unresolved = res.drains.filter((d) => d.written_off_at === null && !d.decision && (d.status === "pending" || d.status === "exit_required"));
  // A pending drain whose channel has no confirmed close is not wedged at all —
  // the caller simply never came back to finish it, and nothing has landed on
  // chain to book. Counting those as stuck closes would put an operator in
  // front of rows no repair applies to.
  const exitRequired = unresolved.filter((d) => d.status === "exit_required");
  const awaitingClose = unresolved.filter((d) => d.status !== "exit_required" && d.chain?.chain === "unconfirmed");
  const wedged = unresolved.filter((d) => d.status === "exit_required"
    ? coversDebit(d)
    : d.chain?.chain !== "unconfirmed");
  const exitShort = exitRequired.filter((d) => isShortRefund(d));
  const timedExit = exitRequired.filter((d) => d.chain?.chain === "unconfirmed");
  const evidenceUnavailable = exitRequired.filter((d) =>
    d.chain?.chain !== "unconfirmed" && compareRefund(d) === "incomparable");
  const evidenceHint = "Re-run with chain lookups (omit --no-evidence), or check the channel before choosing an action.";
  const evidenceNotice = evidenceUnavailable.length > 0
    ? ` ${evidenceUnavailable.length} exit_required drain(s): chain evidence unavailable. ${evidenceHint}`
    : "";
  const exitNotice = timedExit.length > 0
    ? ` ${timedExit.length} drain(s): cooperative close is unavailable; the caller must recover the funds with the timed exit.`
    : "";
  const shortExitNotice = exitShort.length > 0
    ? ` ${exitShort.length} exit_required drain(s): a close landed with a short refund. Independently return any remainder, then attest to the whole refund with \`dvmctl credit tempo-book\`; release is only for nonpayment.`
    : "";
  // Counted over the unresolved rows only: under `--include-resolved` the page
  // also carries drains an operator has already closed out, and a chain figure
  // on one of those is not work anybody is waiting on.
  const repairable = wedged.filter((d) => coversDebit(d));
  // An unknown native debit cannot establish a short refund.
  const short = wedged.filter((d) => isShortRefund(d));
  if (opts.human) {
    if (res.drains.length === 0) {
      info("No Tempo closes are stuck between chain and ledger. Nothing to repair.");
      return;
    }
    for (const drain of res.drains) {
      raw(
        `${drain.credit_id} ${drain.drain_id}  ${drain.status}  ${describeChain(drain)}` +
          `  original_debit=${drain.amount_native ?? "-"} native (${String(drain.amount_micro)} ${drain.currency} micro)` +
          (drain.written_off_at === null ? "" : `  written-off${noteSuffix(drain.write_off_note)}`) +
          (drain.held_reason === undefined ? "" : `  held_reason=${drain.held_reason ?? "-"}`) +
          (drain.proven_refund_native === undefined ? "" : `  proven_refund_native=${drain.proven_refund_native ?? "unknown"}`) +
          (drain.refund_payment_proven === undefined ? "" : `  refund_payment_proven=${drain.refund_payment_proven}`) +
          (drain.decision ? `  decision=${JSON.stringify(drain.decision)}` : "")
      );
      for (const report of drain.close_reports ?? []) {
        raw(`  close-report ${report.obligation_id}  ${report.status}  written_off=${report.written_off} (builder payout report; separate from caller refund)`);
      }
    }
    if (wedged.length > 0) {
      info(
        `${wedged.length} awaiting a decision, ${repairable.length} whose on-chain refund covers the debit. ` +
          `Finish one with \`dvmctl credit tempo-reconcile ${handle} <credit-id> <drain-id>\`.`
      );
    }
    if (short.length > 0) {
      info(
        `${short.length} refunded the caller less than the ledger extinguished. A reconcile refuses those. Independently return the remainder, then use \`dvmctl credit tempo-book\` for the whole refund. A drain write-off only annotates the held liability.`
      );
    }
    for (const drain of exitShort) {
      info(`${drain.credit_id} ${drain.drain_id}: close landed with a short refund. Independently return any remainder, then use tempo-book for the whole refund. Release is only for nonpayment.`);
    }
    for (const drain of evidenceUnavailable) {
      info(`${drain.credit_id} ${drain.drain_id}: chain evidence unavailable. ${evidenceHint}`);
    }
    if (exitNotice) info(exitNotice.trim());
    if (awaitingClose.length > 0) {
      info(
        `${awaitingClose.length} more have no confirmed close on chain yet — those are the caller's to finish, not yours, and are not counted above.`
      );
    }
    if (!opts.includeResolved) {
      info(
        "Written-off held drains remain visible and still hold the caller's debited balance; they are excluded from action counts. `--include-resolved` adds terminal operator decisions."
      );
    }
    info(HELD_GUIDANCE);
    if (res.next_after) info(`More rows: re-run with \`--after ${res.next_after}\`.`);
    return;
  }

  json({
    op: "credit_tempo_wedged",
    handle,
    dvmId,
    slug: handle,
    drains: res.drains,
    wedged_count: wedged.length,
    repairable_count: repairable.length,
    short_refund_count: short.length,
    awaiting_close_count: awaitingClose.length,
    exit_required_count: exitRequired.length,
    exit_required_short_refund_count: exitShort.length,
    timed_exit_count: timedExit.length,
    exit_required_evidence_unavailable_count: evidenceUnavailable.length,
    ...(res.next_after ? { next_after: res.next_after } : {}),
    display:
      (wedged.length === 0
        ? awaitingClose.length === 0
          ? "No Tempo channel closes are waiting on an operator decision."
          : `No Tempo close is waiting on an operator decision. ${awaitingClose.length} pending drain(s) have no confirmed close on chain yet, which is the caller's to finish rather than yours.`
        : `${wedged.length} Tempo close(s) landed on chain without the caller's credit balance being booked as paid. ${repairable.length} paid enough to cover the debit and can be finished.` +
          (short.length > 0
            ? ` ${short.length} refunded the caller less than was extinguished — those cannot be reconciled and need a decision.`
            : "") +
          (awaitingClose.length > 0
            ? ` A further ${awaitingClose.length} pending drain(s) have no confirmed close on chain yet and are not counted here.`
            : "")) + shortExitNotice + exitNotice + evidenceNotice,
    hint: [
      HELD_GUIDANCE,
      wedged.length > 0
        ? "Finish a repairable drain with `dvmctl credit tempo-reconcile <handle> <credit-id> <drain-id>` — the amount comes off the close receipt, not from you. If a refund is short, independently return the remainder and use `dvmctl credit tempo-book` for the whole refund. A drain write-off only records an annotation."
        : "",
      shortExitNotice.trim(),
      exitNotice.trim(),
      evidenceNotice.trim(),
      opts.includeResolved
        ? ""
        : "Written-off held drains remain visible but are not counted here; `--include-resolved` adds terminal operator decisions.",
    ].filter(Boolean).join(" "),
  });
}

/**
 * Book a Tempo drain whose cooperative close already paid on chain.
 *
 * The DVM decides everything: it re-reads the `ChannelClosed` receipt the close
 * already recorded and books the drain against that figure. You name one thing
 * — which drain. If the chain refunded less than the ledger is extinguishing it
 * refuses, naming both figures. For a short refund, independently return the
 * remainder before using tempo-book to attest to the whole refund.
 * Running this twice books once.
 */
export async function tempoReconcile(
  handle: string,
  creditId: string,
  drainId: string,
  opts: TempoReconcileOptions
): Promise<void> {
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.reconcileTempoDrain({ credit_id: creditId, drain_id: drainId })
  );

  if (opts.human) {
    info(
      res.replayed
        ? `Already booked (drain ${res.drain_id} on ${res.credit_id}) — nothing moved.`
        : `Booked the ${res.settled_amount ?? "on-chain"} refund against drain ${res.drain_id} on ${res.credit_id}.`
    );
    return;
  }
  json({
    op: "credit_tempo_reconcile",
    handle,
    dvmId,
    slug: handle,
    credit_id: res.credit_id,
    drain_id: res.drain_id,
    channel_id: res.channel_id,
    transaction: res.transaction,
    settled_amount: res.settled_amount,
    amount_micro: res.amount_micro,
    amount_native: res.amount_native,
    currency: res.currency,
    replayed: res.replayed,
    display: res.replayed
      ? `This drain was already booked. Nothing moved.`
      : `Booked drain ${res.drain_id} on ${res.credit_id} against the refund the channel close already paid (${res.transaction ?? "no transaction recorded"}).`,
    hint: "The reclaim is reported to the platform on the DVM's own retry loop, so its liability view catches up without another command.",
  });
}

/** Record an audit annotation without paying, releasing, or settling the held debit. */
export async function tempoWriteOff(
  handle: string,
  creditId: string,
  drainId: string,
  opts: TempoWriteOffOptions
): Promise<void> {
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.writeOffTempoDrain({
      credit_id: creditId,
      drain_id: drainId,
      ...(opts.note === undefined ? {} : { note: opts.note }),
    })
  );

  if (opts.human) {
    info(
      res.replayed
        ? `Already written off (drain ${res.drain_id} on ${res.credit_id})${noteSuffix(res.note)}. Nothing changed.`
        : `Wrote off drain ${res.drain_id} on ${res.credit_id}. Nothing was booked.`
    );
    info("The debit and refund liability remain held; a write-off annotation does not pay the caller.");
    return;
  }
  json({
    op: "credit_tempo_write_off",
    handle,
    dvmId,
    slug: handle,
    credit_id: res.credit_id,
    drain_id: res.drain_id,
    channel_id: res.channel_id,
    amount_micro: res.amount_micro,
    amount_native: res.amount_native,
    currency: res.currency,
    note: res.note,
    replayed: res.replayed,
    display: res.replayed
      ? `This drain was already written off${res.note ? `, with the note "${res.note}"` : ""}. Nothing changed, and your note was not recorded over it.`
      : "Annotated this held drain without booking it. No money moved and the refund liability remains. Independently return any remainder out of band, then use tempo-book to attest to the whole refund.",
    hint: "Reversible: `dvmctl credit tempo-reconcile` still accepts a written-off drain if you change your mind.",
  });
}

/**
 * Whether the chain's stated refund covers the drain's rail-native debit — the
 * payout floor, asked client-side so a queue can be ranked without a round trip
 * per row. `BigInt` because the chain's figure arrives as a decimal string and
 * a channel token's atomic units are not bounded by `Number.MAX_SAFE_INTEGER`.
 *
 * A drain with no native debit is **not** repairable: that is the one input the
 * DVM's own floor also refuses, so counting it as ready to finish would send an
 * operator at a verb that cannot succeed.
 */
function coversDebit(drain: AdminTempoDrain): boolean {
  return compareRefund(drain) === "covers";
}

/**
 * Whether the chain's stated refund is short of the debit.
 *
 * Deliberately not `!coversDebit`: a drain whose debit is unknown fails that
 * test too, and calling it short would claim the chain underpaid when nothing
 * was ever compared.
 */
function isShortRefund(drain: AdminTempoDrain): boolean {
  return compareRefund(drain) === "short";
}

function compareRefund(drain: AdminTempoDrain): "covers" | "short" | "incomparable" {
  if (drain.chain?.chain !== "found" || drain.amount_native === null) return "incomparable";
  try {
    return BigInt(drain.chain.refundedToPayer) >= BigInt(drain.amount_native) ? "covers" : "short";
  } catch {
    return "incomparable";
  }
}

function describeChain(drain: AdminTempoDrain): string {
  const evidence = drain.chain;
  if (!evidence) return "chain=not-checked";
  switch (evidence.chain) {
    case "found":
      return `chain=refunded:${evidence.refundedToPayer}${isShortRefund(drain) ? " (short)" : ""}`;
    case "unreported":
      return "chain=no-receipt";
    case "unconfirmed":
      return "chain=no-close";
    default:
      return "chain=unreachable";
  }
}

function noteSuffix(note: string | null | undefined): string {
  return note ? ` — note on record: "${note}"` : "";
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DvmError(
      "invalid_limit",
      `--limit must be an integer in 1..${MAX_LIMIT} (got ${limit}).`,
      "Leave it unset for the default page of 20, then follow `next_after` for the rest. The ceiling is low because every row on the page may cost a chain read."
    );
  }
  return limit;
}

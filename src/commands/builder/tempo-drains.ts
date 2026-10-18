// Builder-owned Tempo repair surface shipped with dvmctl.
import { DvmError } from "@dvmkit/sdk/internal";

import { type AdminTempoDrain } from "../../lib/admin-cashu-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, connectAdmin } from "./admin-connection.ts";

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
  /** Also list drains already written off — the audit view. */
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

/**
 * List the Tempo cooperative closes this DVM could not finish booking
 * — a channel close that landed on chain while its ledger leg
 * refused because the refund did not cover the debit.
 *
 * Read-only. Chain evidence determines whether a drain can be reconciled,
 * whether a pending drain has a short refund that can be written off, or
 * whether an exit_required drain still needs caller recovery.
 */
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

  const unresolved = res.drains.filter((d) => d.written_off_at === null);
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
    ? ` ${exitShort.length} exit_required drain(s): a close landed with a short refund. No command can repair these drains yet; their status prevents a drain write-off.`
    : "";
  // Counted over the unresolved rows only: under `--include-resolved` the page
  // also carries drains an operator has already closed out, and a chain figure
  // on one of those is not work anybody is waiting on.
  const repairable = wedged.filter((d) => coversDebit(d));
  // The sharp end: the chain named a figure and it is *short*. Those are the
  // rows a reconcile will refuse, so they are the ones a write-off is for. A
  // drain with no native debit is not among them — there is nothing for the
  // refund to be short against, and `coversDebit` refusing it is about the
  // reconcile it would send an operator at, not about the chain paying too
  // little.
  const short = wedged.filter((d) => isShortRefund(d));
  if (opts.human) {
    if (res.drains.length === 0) {
      info("No Tempo closes are stuck between chain and ledger. Nothing to repair.");
      return;
    }
    for (const drain of res.drains) {
      raw(
        `${drain.credit_id} ${drain.drain_id}  ${drain.status}  ${describeChain(drain)}` +
          `  owed=${drain.amount_native ?? "-"} native (${String(drain.amount_micro)} ${drain.currency} micro)` +
          (drain.written_off_at === null ? "" : `  written-off${noteSuffix(drain.write_off_note)}`)
      );
    }
    if (wedged.length > 0) {
      info(
        `${wedged.length} awaiting a decision, ${repairable.length} whose on-chain refund covers the debit. ` +
          `Finish one with \`dvmctl credit tempo-reconcile ${handle} <credit-id> <drain-id>\`.`
      );
    }
    if (short.length > 0) {
      info(
        `${short.length} refunded the caller less than the ledger extinguished. A reconcile refuses those; \`dvmctl credit tempo-write-off\` is how one is closed.`
      );
    }
    for (const drain of exitShort) {
      info(`${drain.credit_id} ${drain.drain_id}: close landed with a short refund. No command can repair it yet; its status prevents a drain write-off.`);
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
        "A written-off close still holds its caller's debited balance, and is not on this page — `--include-resolved` lists those too."
      );
    }
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
      wedged.length > 0
        ? "Finish a repairable drain with `dvmctl credit tempo-reconcile <handle> <credit-id> <drain-id>` — the amount comes off the close receipt, not from you. If a pending drain's refund was genuinely short, close it with `dvmctl credit tempo-write-off`."
        : "",
      shortExitNotice.trim(),
      exitNotice.trim(),
      evidenceNotice.trim(),
      opts.includeResolved
        ? ""
        : "Drains you have already written off are not counted here; re-run with `--include-resolved` to see those.",
    ].filter(Boolean).join(" "),
  });
}

/**
 * Book a Tempo drain whose cooperative close already paid on chain.
 *
 * The DVM decides everything: it re-reads the `ChannelClosed` receipt the close
 * already recorded and books the drain against that figure. You name one thing
 * — which drain. If the chain refunded less than the ledger is extinguishing it
 * refuses, naming both figures. A pending drain can be written off; an
 * exit_required drain with a short refund has no repair command yet.
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

/**
 * Record that you reviewed a wedged Tempo close and are not booking it.
 *
 * Moves no money and books nothing. The close paid the caller less than this
 * ledger extinguished, and no dvmkit row can express that difference — the
 * channel is closed, so there is nothing left to refund through it, and
 * re-crediting the balance here would pay the caller twice for the part the
 * chain did return. Making the shortfall good is an out-of-band decision; this
 * verb records that you took it. It is reversible —
 * `dvmctl credit tempo-reconcile` still accepts a written-off drain.
 */
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
      : "Closed this drain without booking it. No ledger row moved: the caller keeps the on-chain refund the close paid them, and the shortfall against what was extinguished is not expressible here — make it good out of band if you owe it.",
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
 * Whether the chain's stated refund is **short** of the debit — the rows a
 * write-off exists for.
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

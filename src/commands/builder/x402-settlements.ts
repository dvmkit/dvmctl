// Builder-owned x402 channel repair surface shipped with dvmctl.
import { DvmError } from "@dvmkit/sdk/internal";

import { type AdminX402Settlement } from "../../lib/admin-cashu-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, connectAdmin } from "./admin-connection.ts";

/** Largest page `dvmctl credit x402-wedged` will ask the DVM for. */
const MAX_LIMIT = 50;

export interface X402WedgedOptions {
  /** DVM admin endpoint URL override; skips the platform `getDvm` lookup. */
  endpoint?: string;
  /** Page size. Default 20, max {@link MAX_LIMIT}. */
  limit?: number;
  /** Opaque `next_after` cursor from a previous run. */
  after?: string;
  /** Also list settlements already written off — the audit view. */
  includeResolved?: boolean;
  /** How long a settlement must have sat before it counts as stuck. Default 5 min. */
  minAgeMs?: number;
  /** `false` (from `--no-evidence`) skips the per-row chain lookups. */
  evidence?: boolean;
  human?: boolean;
  org?: string;
}

export interface X402ReconcileOptions {
  endpoint?: string;
  human?: boolean;
  org?: string;
}

export interface X402WriteOffOptions {
  endpoint?: string;
  /** Why you are not booking this settlement. Recorded on the settlement row. */
  note?: string;
  human?: boolean;
  org?: string;
}

/**
 * List the x402 settlements this DVM could not finish booking — a
 * cooperative refund that reached the chain while its ledger leg refused.
 *
 * Read-only. Each row carries what the chain says about it, which is what
 * decides whether it can be reconciled or has to be written off.
 */
export async function x402Wedged(handle: string, opts: X402WedgedOptions): Promise<void> {
  const limit = resolveLimit(opts.limit);
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.getX402Settlements({
      limit,
      ...(opts.after === undefined ? {} : { after: opts.after }),
      ...(opts.includeResolved ? { includeResolved: true } : {}),
      ...(opts.minAgeMs === undefined ? {} : { minAgeMs: opts.minAgeMs }),
      ...(opts.evidence === false ? { evidence: false } : {}),
    })
  );

  const unresolved = res.settlements.filter((s) => s.status !== "written_off");
  // Counted over the unresolved rows only: under `--include-resolved` the page
  // also carries settlements an operator has already closed, and a chain match
  // on one of those is not work anybody is waiting on.
  const repairable = unresolved.filter((s) => s.chain?.chain === "found");
  // Rows whose caller is locked out of their own balance until an operator acts
  // — counted over every row on the page, `written_off` included,
  // because a write-off closes the queue item without lifting the spend hold.
  // Those are exactly the rows the default page does not show: `listSettlements`
  // returns the wedged pair unless `--include-resolved`, so a hold that has
  // become permanent is the one an operator has to ask for. Hence the pointer
  // on the human line below.
  const held = res.settlements.filter(
    (s) => s.spending_blocked && (s.credit_balance_micro ?? 0) > 0
  );
  if (opts.human) {
    if (res.settlements.length === 0) {
      info("No x402 settlements are stuck between chain and ledger. Nothing to repair.");
      return;
    }
    for (const settlement of res.settlements) {
      raw(
        `${settlement.settlement_id}  ${settlement.status}  ${describeChain(settlement)}` +
          `  credit=${settlement.credit_id ?? "-"} drain=${settlement.drain_id ?? "-"}` +
          `  ${describeHold(settlement)}`
      );
    }
    info(
      `${unresolved.length} awaiting a decision, ${repairable.length} with a matching refund on chain. ` +
        `Finish one with \`dvmctl credit x402-reconcile ${handle} <settlement-id>\`.`
    );
    if (held.length > 0) {
      info(
        `${held.length} of these hold a caller's balance: it can be reclaimed but not spent until the settlement is closed out.`
      );
    }
    if (!opts.includeResolved) {
      info(
        "A written-off settlement keeps holding its caller's balance for good, and is not on this page — `--include-resolved` lists those too."
      );
    }
    if (res.next_after) info(`More rows: re-run with \`--after ${res.next_after}\`.`);
    return;
  }

  json({
    op: "credit_x402_wedged",
    handle,
    dvmId,
    slug: handle,
    settlements: res.settlements,
    wedged_count: unresolved.length,
    repairable_count: repairable.length,
    holding_balance_count: held.length,
    ...(res.next_after ? { next_after: res.next_after } : {}),
    display:
      unresolved.length === 0
        ? "No x402 refunds are waiting on an operator decision."
        : `${unresolved.length} x402 refund(s) settled on chain without the caller's credit balance being cleared. ${repairable.length} of them have a matching refund the chain can confirm.` +
          (held.length > 0
            ? ` ${held.length} are holding a caller's balance, which they can reclaim but not spend until the settlement is closed out.`
            : ""),
    hint:
      "Finish one with `dvmctl credit x402-reconcile <handle> <settlement-id>` — the amount comes off the chain, not from you. If the chain and the ledger disagree, close it with `dvmctl credit x402-write-off`." +
      (opts.includeResolved
        ? ""
        : " A written-off settlement holds its caller's balance for good and is not counted here; re-run with `--include-resolved` to see those."),
  });
}

/**
 * Finish the ledger leg of an x402 refund the chain already paid.
 *
 * The DVM decides everything: it re-derives the refund amount from the chain's
 * own logs and completes the drain against that figure. You name one thing —
 * which settlement. If the chain's figure and the ledger's disagree it refuses,
 * naming both; that settlement is not reconcilable and the write-off is how it
 * gets closed. Running this twice books once.
 */
export async function x402Reconcile(
  handle: string,
  settlementId: string,
  opts: X402ReconcileOptions
): Promise<void> {
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.reconcileX402Settlement({ settlement_id: settlementId })
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
    op: "credit_x402_reconcile",
    handle,
    dvmId,
    slug: handle,
    settlement_id: res.settlement_id,
    channel_id: res.channel_id,
    credit_id: res.credit_id,
    drain_id: res.drain_id,
    transaction: res.transaction,
    settled_amount: res.settled_amount,
    amount_micro: res.amount_micro,
    currency: res.currency,
    replayed: res.replayed,
    display: res.replayed
      ? `This settlement was already booked against drain ${res.drain_id}. Nothing moved.`
      : `Cleared the caller's balance on ${res.credit_id} against the refund the chain already paid (${res.transaction ?? "no transaction recorded"}).`,
    hint: "The reclaim is reported to the platform on the DVM's own retry loop, so its liability view catches up without another command.",
  });
}

/**
 * Record that you reviewed a wedged x402 settlement and are not booking it.
 *
 * Moves no money and books nothing: the refund, if it reached the chain, is
 * already with the caller, and their credit balance stays on this ledger where
 * they can reclaim it with a fresh drain id. It exists so a settlement leaves
 * the queue without pretending it booked, and it is reversible —
 * `dvmctl credit x402-reconcile` still accepts a written-off settlement.
 */
export async function x402WriteOff(
  handle: string,
  settlementId: string,
  opts: X402WriteOffOptions
): Promise<void> {
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.writeOffX402Settlement({
      settlement_id: settlementId,
      ...(opts.note === undefined ? {} : { note: opts.note }),
    })
  );

  if (opts.human) {
    info(
      res.replayed
        ? `Already written off (${res.settlement_id})${res.note ? ` — note on record: "${res.note}"` : ""}. Nothing changed.`
        : `Wrote off settlement ${res.settlement_id}. Nothing was booked.`
    );
    return;
  }
  json({
    op: "credit_x402_write_off",
    handle,
    dvmId,
    slug: handle,
    settlement_id: res.settlement_id,
    channel_id: res.channel_id,
    effect_id: res.effect_id,
    note: res.note,
    replayed: res.replayed,
    display: res.replayed
      ? `This settlement was already written off${res.note ? `, with the note "${res.note}"` : ""}. Nothing changed, and your note was not recorded over it.`
      : "Closed this settlement without booking it. No ledger row moved: if the refund did reach the chain, the caller still holds the matching credit balance here and can reclaim it with a new drain.",
    hint: "Reversible: `dvmctl credit x402-reconcile` still accepts a written-off settlement if you change your mind.",
  });
}

function describeChain(settlement: AdminX402Settlement): string {
  const evidence = settlement.chain;
  if (!evidence) return "chain=not-checked";
  switch (evidence.chain) {
    case "found":
      return `chain=paid:${evidence.amount}`;
    case "absent":
      return "chain=nothing-found";
    case "unbookmarked":
      return "chain=no-bookmark";
    default:
      return "chain=unreachable";
  }
}

/** What the caller can still do with the balance behind this settlement. */
function describeHold(settlement: AdminX402Settlement): string {
  const balance = settlement.credit_balance_micro;
  if (balance === null) return "balance=-";
  const amount = `${String(balance)}${settlement.credit_currency ? ` ${settlement.credit_currency}` : ""} micro`;
  return settlement.spending_blocked ? `balance=${amount} (spend-blocked)` : `balance=${amount}`;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DvmError(
      "invalid_limit",
      `--limit must be an integer in 1..${MAX_LIMIT} (got ${limit}).`,
      "Leave it unset for the default page of 20, then follow `next_after` for the rest. The ceiling is low because every row on the page may cost a chain log scan."
    );
  }
  return limit;
}

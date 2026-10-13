// Builder-owned drain settlement surface shipped with dvmctl.
import { DvmError } from "@dvmkit/sdk/internal";

import { type AdminPendingDrain } from "../../lib/admin-cashu-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, type AdminConnectionOptions, connectAdmin } from "./admin-connection.ts";

export interface DrainsOwedOptions extends AdminConnectionOptions {
  human?: boolean;
}

export interface DrainSettleOptions extends AdminConnectionOptions {
  /** The on-chain transaction that paid the refund. Required — it is the evidence. */
  tx?: string;
  /** Free text recorded alongside the transaction, e.g. which wallet sent it. */
  note?: string;
  human?: boolean;
}

/** One manual row, as `dvmctl credit drains-owed` publishes it. */
interface OwedDrain extends AdminPendingDrain {
  /** How long this refund has been owed, in ms — the row's own age at read time. */
  age_ms: number;
}

/** What is owed in one currency, summed over that currency's rows. */
interface OwedTotal {
  currency: string;
  amount_micro: number;
  count: number;
}

/**
 * List the stablecoin refunds this DVM owes and nothing will ever pay on its
 * own — the queue behind every `drain_manual_settlement_required`
 * log line.
 *
 * These are one-payment x402 `exact` and Tempo charge reclaims. A channel-backed
 * refund is settled by its own cooperative close, so the route classifies it
 * `channel` and it never reaches this list — listing one would send an operator
 * to pay a refund the channel is about to pay itself. What is left has no
 * builder-held on-chain send key behind it, so a person sends the money and
 * records it with `dvmctl credit drain-settle`.
 *
 * Read-only. Every figure comes off the drain row — nothing here re-prices a
 * refund, which is also why these rows carry no sats.
 */
export async function drainsOwed(handle: string, opts: DrainsOwedOptions): Promise<void> {
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() => client.getPendingDrains());

  const now = Date.now();
  const owed: OwedDrain[] = res.drains
    .filter((d) => d.settlement === "manual")
    // Oldest first: a refund's age is the whole reason to act on it, and the
    // one at the top has been owed the longest.
    .sort((a, b) => a.created_at - b.created_at)
    .map((d) => ({ ...d, age_ms: Math.max(0, now - d.created_at) }));
  const totals = totalsByCurrency(owed);

  if (opts.human) {
    if (owed.length === 0) {
      info("No stablecoin refunds are waiting on you. Nothing to settle by hand.");
      return;
    }
    for (const drain of owed) {
      raw(
        `${drain.credit_id}  ${drain.drain_id}  ${drain.method}  ${formatOwed(drain)}` +
          `  to=${payoutAddress(drain)}  ${formatAge(drain.age_ms)} old`
      );
    }
    info(
      `${owed.length} refund(s) owed: ${totals.map((t) => formatMicro(t.amount_micro, t.currency)).join(", ")}. ` +
        `Record one with \`dvmctl credit drain-settle ${handle} <credit-id> <drain-id> --tx <hash>\`.`
    );
    return;
  }

  json({
    op: "credit_drains_owed",
    handle,
    dvmId,
    slug: handle,
    drains: owed,
    owed_count: owed.length,
    owed_totals: totals,
    display:
      owed.length === 0
        ? "This DVM owes no stablecoin refunds that a person has to settle."
        : `${owed.length} stablecoin refund(s) are owed to callers and no job will pay them: ${totals
            .map((t) => formatMicro(t.amount_micro, t.currency))
            .join(
              ", "
            )}. Each one was debited from the caller's balance already, so the money is owed whether or not it is sent.`,
    hint: "Send each payout on its own rail (`method` names it, `payout.address` is the destination, `amount_native` is the figure in the token's own units), then record it with `dvmctl credit drain-settle <handle> <credit-id> <drain-id> --tx <hash>`.",
  });
}

/**
 * Record that you settled one of those refunds on chain.
 *
 * Moves no money — the payout happened in your own wallet, and this is the
 * ledger catching up with it: the drain flips `pending → sent`, the caller's
 * poll sees a countersigned `sent` receipt, and the reclaim is reported to the
 * platform so its liability view stops counting a debt you have paid.
 *
 * Idempotent, and it says which it was: running it twice records once and
 * answers `replayed`. A drain that is not `pending` is refused rather than
 * overwritten — the recorded settlement reference is the one that counts.
 */
export async function drainSettle(
  handle: string,
  creditId: string,
  drainId: string,
  opts: DrainSettleOptions
): Promise<void> {
  const transaction = opts.tx?.trim();
  if (!transaction) {
    throw new DvmError(
      "missing_transaction",
      "No settlement transaction named.",
      "Pass `--tx <hash>` — the on-chain transaction that paid the refund. It is the only evidence this row will ever carry, and `dvmctl credit drains-owed` lists the credit and drain ids to go with it."
    );
  }
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.markDrainSent({
      credit_id: creditId,
      drain_id: drainId,
      // `transaction` is the key the cooperative x402 close already records, so
      // one reader can read both doors. `settled_by` is what separates a payout
      // a person made from one the batch job made.
      sent_ref: {
        transaction,
        settled_by: "operator",
        ...(opts.note === undefined ? {} : { note: opts.note }),
      },
    })
  );

  if (opts.human) {
    info(
      res.replayed
        ? `Drain ${drainId} was already recorded as sent — nothing changed, and your transaction was not recorded over the one on file.`
        : `Recorded ${transaction} against drain ${drainId} on ${creditId}.`
    );
    return;
  }
  json({
    op: "credit_drain_settle",
    handle,
    dvmId,
    slug: handle,
    credit_id: res.credit_id,
    drain_id: res.drain_id,
    transaction,
    replayed: res.replayed,
    display: res.replayed
      ? `This refund was already recorded as sent, so nothing changed and the settlement reference on file was left alone. If you just sent the payout, check the recorded transaction before sending another — it may already have been paid.`
      : `Recorded the payout for drain ${drainId} on ${creditId}. The caller's next reclaim poll sees it settled, with a countersigned receipt.`,
    hint: "The reclaim is reported to the platform inside the same transaction as this transition, so its liability view catches up without another command — and exactly once, however many times this runs.",
  });
}

/**
 * What is owed, per currency. Grouped rather than flattened because the admin
 * read is host-wide — a multi-mount host can hold credits in two denominations,
 * and adding those micro figures together produces a number nobody can send.
 */
function totalsByCurrency(drains: OwedDrain[]): OwedTotal[] {
  const byCurrency = new Map<string, OwedTotal>();
  for (const drain of drains) {
    const total = byCurrency.get(drain.currency) ?? {
      currency: drain.currency,
      amount_micro: 0,
      count: 0,
    };
    total.amount_micro += drain.amount_micro;
    total.count++;
    byCurrency.set(drain.currency, total);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Where the payout goes. `payout` is a per-rail bag typed `Record<string,
 * string>`, so the key is annotated as optional rather than assumed present —
 * the ones this queue holds carry `address`, but a rail that recorded something
 * else must read as "unknown" rather than as the string `undefined`.
 */
function payoutAddress(drain: OwedDrain): string {
  const payout: Record<string, string | undefined> = drain.payout;
  return payout.address ?? "-";
}

/** Both figures on one line: what the caller is owed, and what you send. */
function formatOwed(drain: OwedDrain): string {
  const fiat = formatMicro(drain.amount_micro, drain.currency);
  return drain.amount_native === null ? fiat : `${fiat} (${drain.amount_native} native)`;
}

function formatMicro(amountMicro: number, currency: string): string {
  return `${(amountMicro / 1_000_000).toFixed(6)} ${currency.toUpperCase()}`;
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

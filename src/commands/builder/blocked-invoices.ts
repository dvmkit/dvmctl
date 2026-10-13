// Builder-owned repair surface shipped with dvmctl.
import { DvmError } from "@dvmkit/sdk/internal";

import { type AdminBlockedInvoice } from "../../lib/admin-cashu-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, connectAdmin } from "./admin-connection.ts";

/** Largest page `dvmctl credit blocked` will ask the DVM for. */
const MAX_LIMIT = 200;

export interface BlockedInvoicesOptions {
  /** DVM admin endpoint URL override; skips the platform `getDvm` lookup. */
  endpoint?: string;
  /** Page size. Default 50, max {@link MAX_LIMIT}. */
  limit?: number;
  /** Opaque `next_after` cursor from a previous run. */
  after?: string;
  /** Also list rows already reconciled or written off — the audit view. */
  includeResolved?: boolean;
  human?: boolean;
  org?: string;
}

export interface ReconcileInvoiceOptions {
  endpoint?: string;
  /** Credit the payment should land on. Required — it is the whole decision. */
  creditId?: string;
  human?: boolean;
  org?: string;
}

export interface WriteOffInvoiceOptions {
  endpoint?: string;
  /** Why you are not crediting this payment. Recorded on the invoice row. */
  note?: string;
  human?: boolean;
  org?: string;
}

/**
 * List the paid Lightning top-ups this DVM's ledger can never credit
 * — the queue behind every `lightning_settlement_blocked` log line.
 *
 * Read-only. The money is still in your wallet; nothing here has moved it.
 */
export async function blockedInvoices(handle: string, opts: BlockedInvoicesOptions): Promise<void> {
  const limit = resolveLimit(opts.limit);
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.getBlockedInvoices({
      limit,
      ...(opts.after === undefined ? {} : { after: opts.after }),
      ...(opts.includeResolved ? { includeResolved: true } : {}),
    })
  );

  const unresolved = res.invoices.filter((i) => i.status === "blocked");
  if (opts.human) {
    if (res.invoices.length === 0) {
      info("No blocked Lightning funding invoices. Nothing to reconcile.");
      return;
    }
    for (const invoice of res.invoices) {
      raw(
        `${invoice.payment_hash}  ${formatAmount(invoice)}  ${invoice.status}` +
          `  ${invoice.blocked_reason ?? "-"}  credit=${invoice.credit_id} fund=${invoice.fund_id}`
      );
    }
    info(
      `${unresolved.length} awaiting a decision. Credit one with \`dvmctl credit reconcile ${handle} <payment-hash> --credit-id <id>\`.`
    );
    if (res.next_after) info(`More rows: re-run with \`--after ${res.next_after}\`.`);
    return;
  }

  json({
    op: "credit_blocked",
    handle,
    dvmId,
    slug: handle,
    invoices: res.invoices,
    blocked_count: unresolved.length,
    ...(res.next_after ? { next_after: res.next_after } : {}),
    display:
      unresolved.length === 0
        ? "No Lightning payments are waiting on an operator decision."
        : `${unresolved.length} Lightning payment(s) landed in this DVM's wallet with no caller balance to put them on.`,
    hint: "Credit one onto a credit the caller holds with `dvmctl credit reconcile <handle> <payment-hash> --credit-id <id>`, or close it with `dvmctl credit write-off`.",
  });
}

/**
 * Credit a blocked invoice's payment onto a credit the caller holds.
 *
 * The DVM decides everything except which credit: the amount, the currency and
 * the caller identity all come off the invoice row it recorded when it minted
 * the bolt11, and it re-confirms with the wallet that the payment really landed
 * before it moves anything. Running this twice with the same target credits
 * once.
 */
export async function reconcileInvoice(
  handle: string,
  paymentHash: string,
  opts: ReconcileInvoiceOptions
): Promise<void> {
  const creditId = opts.creditId;
  if (!creditId) {
    throw new DvmError(
      "missing_credit_id",
      "No target credit named.",
      "Pass `--credit-id <id>`. Which credit this payment should land on is not derivable from the failed row — `dvmctl credit blocked` shows the one it was minted for, and `dvm credit list` (as the caller) shows what they hold."
    );
  }
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.reconcileInvoice({ payment_hash: paymentHash, credit_id: creditId })
  );

  if (opts.human) {
    info(
      res.replayed
        ? `Already credited to ${res.credit_id} — nothing moved.`
        : `Credited ${formatMicro(res.amount_micro, res.currency)} to ${res.credit_id}.`
    );
    return;
  }
  json({
    op: "credit_reconcile",
    handle,
    dvmId,
    slug: handle,
    payment_hash: res.payment_hash,
    credit_id: res.credit_id,
    fund_id: res.fund_id,
    amount_micro: res.amount_micro,
    currency: res.currency,
    replayed: res.replayed,
    ...(res.credit ? { credit: res.credit } : {}),
    display: res.replayed
      ? `This payment was already credited to ${res.credit_id}. Nothing moved.`
      : `Credited ${formatMicro(res.amount_micro, res.currency)} to ${res.credit_id}. The caller can spend it now.`,
    hint: "The deposit is reported to the platform on the DVM's own retry loop, so its liability view catches up without another command.",
  });
}

/**
 * Record that you reviewed a blocked invoice and are not crediting it.
 *
 * Moves no money — the sats stay in your wallet and no caller balance is
 * created. It exists so a row leaves the queue without pretending it settled,
 * and it is reversible: `dvmctl credit reconcile` still accepts a written-off
 * invoice.
 */
export async function writeOffInvoice(
  handle: string,
  paymentHash: string,
  opts: WriteOffInvoiceOptions
): Promise<void> {
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall(() =>
    client.writeOffInvoice({
      payment_hash: paymentHash,
      ...(opts.note === undefined ? {} : { note: opts.note }),
    })
  );

  if (opts.human) {
    info(
      res.replayed
        ? `Already written off (${res.payment_hash})${res.note ? ` — note on record: "${res.note}"` : ""}. Nothing changed.`
        : `Wrote off ${formatMicro(res.amount_micro, res.currency)} (${res.payment_hash}). No balance was created.`
    );
    return;
  }
  json({
    op: "credit_write_off",
    handle,
    dvmId,
    slug: handle,
    payment_hash: res.payment_hash,
    amount_micro: res.amount_micro,
    currency: res.currency,
    note: res.note,
    replayed: res.replayed,
    display: res.replayed
      ? `This payment was already written off${res.note ? `, with the note "${res.note}"` : ""}. Nothing changed, and your note was not recorded over it.`
      : `Closed this payment without crediting it. The ${formatMicro(res.amount_micro, res.currency)} stays in your wallet and no caller balance was created for it.`,
    hint: "Reversible: `dvmctl credit reconcile` still accepts a written-off invoice if you change your mind.",
  });
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new DvmError(
      "invalid_limit",
      `--limit must be an integer in 1..${MAX_LIMIT} (got ${limit}).`,
      "Leave it unset for the default page of 50, then follow `next_after` for the rest."
    );
  }
  return limit;
}

function formatAmount(invoice: AdminBlockedInvoice): string {
  return `${formatMicro(invoice.amount_micro, invoice.currency)} (${invoice.amount_msats} msats)`;
}

function formatMicro(amountMicro: number, currency: string): string {
  return `${(amountMicro / 1_000_000).toFixed(6)} ${currency.toUpperCase()}`;
}

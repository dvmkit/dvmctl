import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import type { PersistedOutputData } from "@dvmkit/sdk/internal";

import { BUILDER_CONFIG_DIR, DRAIN_PARK_LOG_FILE } from "../shared/defaults.ts";
import type { AdminMintEvidence } from "./admin-cashu-client.ts";

/**
 * Recovery log for the credit-drain park flow, mirroring
 * `melt-pending-log.ts`'s pre/post pairing. The exposure it closes: after the
 * mint swap succeeds, the caller-locked refund token exists **only in this
 * process's memory** until the park POST commits on the DVM — the consumed
 * accumulator proofs are already spent at the mint, so losing the token here
 * loses the caller's refund outright. `swapped` is therefore written
 * synchronously before the POST, and the recovery sweep re-POSTs any
 * `swapped` entry without a matching `parked` (the park route is idempotent
 * on the token).
 */
export interface SwappedEntry {
  kind: "swapped";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
  /** Caller-locked token the swap produced — the money, until parked. */
  token: string;
  /** Accumulator rows whose proofs the swap consumed. */
  consumed_row_ids: string[];
  /** Change proofs re-locked to the builder, to re-enter the accumulator. */
  keep_proofs: { id: string; amount: number; secret: string; C: string }[];
  /**
   * Cost evidence when these notes were minted just in time rather than
   * swapped. Carried here so the recovery re-POST sends the same
   * body the first attempt did — the park route reads it to tell the two park
   * shapes apart, and an evidence-less retry of a JIT park would be refused
   * for consuming no accumulator rows.
   */
  mint_evidence?: AdminMintEvidence;
}

/**
 * Written **before** the mint's invoice is paid, when a refund is being minted
 * just in time rather than swapped out of the accumulator.
 *
 * NIP-47 `pay_invoice` has no idempotency key, and a *fresh* quote per retry
 * would sidestep even the wallet's own event dedup — so the rule is: never ask
 * a mint for a second quote while a drain has one open. Recovery reconciles
 * the recorded bolt11 through `lookup_invoice` and the mint's own quote state
 * before any new payment can be attempted.
 */
export interface MintQuoteEntry {
  kind: "mint_quote";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
  mint_url: string;
  quote_id: string;
  bolt11: string;
  /** What the mint asked for the face value below. */
  invoice_msats: number;
  /** Face value the quote will issue — the drain's published `owed_sats`. */
  face_sats: number;
  /** Delivery reserve already withheld from the caller's gross obligation. */
  reserve_sats: number;
  /**
   * Unix seconds after which the mint will no longer settle this quote, as the
   * mint itself published it. Recorded rather than re-read because it decides
   * whether the quote may be abandoned, and that decision must not depend on
   * the mint being reachable. `null` when the mint publishes none.
   */
  expires_at: number | null;
  /**
   * The caller's NUT-11 refund key, recorded so a later tick can finish this
   * mint without re-reading the drain. The pending-drains listing is the
   * authority on it, but a quote can outlive a drain's presence there — a park
   * that committed with its response lost leaves the drain `parked` while the
   * proofs are still only on disk — and recovery must never be the step that
   * cannot find the lock.
   */
  refund_pubkey: string;
}

/** Written once the send wallet settles a {@link MintQuoteEntry}'s invoice. */
export interface MintPaidEntry {
  kind: "mint_paid";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
  quote_id: string;
  preimage: string;
  /** Routing the wallet reported, where it reported any. */
  fees_paid_msats?: number;
  /** True when the payment was recovered through `lookup_invoice` rather than answered directly. */
  recovered?: boolean;
}

/**
 * Written immediately before each `pay_invoice` call.
 *
 * Besides making the attempt visible, this clears any older rejection for the
 * same quote. If the process dies or the new call becomes unknown, recovery
 * must not reuse a rejection that described an earlier attempt.
 */
export interface MintPaymentAttemptEntry {
  kind: "mint_payment_attempt";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
  quote_id: string;
}

/**
 * Written when the send wallet itself rejects a `pay_invoice` request.
 *
 * Unlike a timeout or an unreadable response, the wallet's rejection proves
 * this attempt did not settle. Recovery still looks the invoice up first — a
 * settled answer always wins — but a known-unsettled answer may then retry the
 * same recorded BOLT11 instead of holding it until expiry.
 */
export interface MintPaymentRejectedEntry {
  kind: "mint_payment_rejected";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
  quote_id: string;
  error_code: string;
}

/**
 * The blinded outputs, written **before** `completeMint` posts them.
 *
 * This is the same exposure `swapped` closes one step later: between the mint
 * signing these outputs and the proofs reaching this process, the sats have
 * left the hub and exist only as signatures the mint holds. With the outputs
 * on disk an ISSUED quote is recoverable through NUT-09 restore; without them
 * it is money nobody can unblind.
 */
export interface MintOutputsEntry {
  kind: "mint_outputs";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
  quote_id: string;
  keyset_id: string;
  outputs: PersistedOutputData[];
}

/**
 * Closes a {@link MintQuoteEntry} that can never be paid — the quote expired
 * with the wallet confirming no payment left. The drain is free to quote again
 * on a later tick; anything less definite must stay open instead, because a
 * second quote beside a payment still in flight is the double-refund bug.
 */
export interface MintAbandonedEntry {
  kind: "mint_abandoned";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
  quote_id: string;
  reason: string;
}

/** Written after the park POST returns 2xx — closes the matching `swapped`. */
export interface ParkedEntry {
  kind: "parked";
  ts: number;
  dvm_id: string;
  credit_id: string;
  drain_id: string;
}

/** Union of records that appear in `~/.dvmkit/drain-park.log`. */
export type DrainParkEntry =
  | SwappedEntry
  | ParkedEntry
  | MintQuoteEntry
  | MintPaidEntry
  | MintPaymentAttemptEntry
  | MintPaymentRejectedEntry
  | MintOutputsEntry
  | MintAbandonedEntry;

/**
 * A mint quote with no terminal entry — the drain either still owes a payment,
 * or has paid one and not yet got its proofs into a park.
 *
 * `paid`, `paymentRejected`, and `outputs` carry however far the run before
 * this one got, so recovery resumes rather than restarting: a quote with
 * `paid` set must never be paid again, a definitively rejected payment may be
 * retried after lookup confirms it remains unsettled, and one with `outputs`
 * set is recoverable through NUT-09 even if the mint has already marked it
 * ISSUED.
 */
export interface OpenMintQuote {
  quote: MintQuoteEntry;
  paid?: MintPaidEntry;
  paymentRejected?: MintPaymentRejectedEntry;
  outputs?: MintOutputsEntry;
}

/** Append a `swapped` entry. Synchronous — this line IS the refund until parked. */
export function appendSwapped(entry: Omit<SwappedEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "swapped", ts: Date.now() });
}

/** Append a `parked` entry closing a previously-written `swapped`. */
export function appendParked(entry: Omit<ParkedEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "parked", ts: Date.now() });
}

/** Append a `mint_quote` entry. Synchronous, before the invoice is paid. */
export function appendMintQuote(entry: Omit<MintQuoteEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "mint_quote", ts: Date.now() });
}

/** Append a `mint_paid` entry once the send wallet settles the quote's invoice. */
export function appendMintPaid(entry: Omit<MintPaidEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "mint_paid", ts: Date.now() });
}

/** Append before asking the wallet to pay, clearing any older retryable rejection. */
export function appendMintPaymentAttempt(
  entry: Omit<MintPaymentAttemptEntry, "kind" | "ts">
): void {
  appendEntry({ ...entry, kind: "mint_payment_attempt", ts: Date.now() });
}

/** Append a definitive wallet rejection so the same invoice remains retryable. */
export function appendMintPaymentRejected(
  entry: Omit<MintPaymentRejectedEntry, "kind" | "ts">
): void {
  appendEntry({ ...entry, kind: "mint_payment_rejected", ts: Date.now() });
}

/** Append a `mint_outputs` entry. Synchronous, before `completeMint`. */
export function appendMintOutputs(entry: Omit<MintOutputsEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "mint_outputs", ts: Date.now() });
}

/** Append a `mint_abandoned` entry, freeing its drain to quote again. */
export function appendMintAbandoned(entry: Omit<MintAbandonedEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "mint_abandoned", ts: Date.now() });
}

/**
 * `swapped` entries without a matching `parked`, keyed on
 * `(dvm_id, credit_id, drain_id)` and scoped to one DVM. Each one is a
 * refund token that must be re-POSTed to the park route before anything
 * else happens in a tick.
 */
export function readUnparked(dvmId: string): SwappedEntry[] {
  return scan(dvmId).unparked;
}

/**
 * Mint quotes with no terminal entry, scoped to one DVM.
 *
 * Terminal is `swapped` (the proofs are in hand and the park is the only step
 * left, which {@link readUnparked} already drives), `parked`, or
 * `mint_abandoned`. Everything else is an open obligation the next tick has to
 * resolve **before** that drain may quote again.
 */
export function readOpenMintQuotes(dvmId: string): OpenMintQuote[] {
  return scan(dvmId).openQuotes;
}

/** One pass over the log, since both reads share its pairing. */
function scan(dvmId: string): { unparked: SwappedEntry[]; openQuotes: OpenMintQuote[] } {
  if (!existsSync(DRAIN_PARK_LOG_FILE)) return { unparked: [], openQuotes: [] };
  const raw = readFileSync(DRAIN_PARK_LOG_FILE, "utf-8");
  const swapped = new Map<string, SwappedEntry>();
  const parked = new Set<string>();
  const quotes = new Map<string, MintQuoteEntry>();
  const paid = new Map<string, MintPaidEntry>();
  const paymentRejected = new Map<string, MintPaymentRejectedEntry>();
  const outputs = new Map<string, MintOutputsEntry>();
  const abandoned = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: DrainParkEntry;
    try {
      entry = JSON.parse(line) as DrainParkEntry;
    } catch {
      continue;
    }
    if (entry.dvm_id !== dvmId) continue;
    const key = `${entry.dvm_id}|${entry.credit_id}|${entry.drain_id}`;
    switch (entry.kind) {
      case "swapped":
        swapped.set(key, entry);
        break;
      case "parked":
        parked.add(key);
        break;
      case "mint_quote":
        quotes.set(key, entry);
        break;
      case "mint_paid":
        paid.set(key, entry);
        break;
      case "mint_payment_attempt":
        // A newer attempt makes an older rejection unsafe to act on until the
        // wallet definitively rejects this attempt too.
        if (paymentRejected.get(key)?.quote_id === entry.quote_id) paymentRejected.delete(key);
        break;
      case "mint_payment_rejected":
        paymentRejected.set(key, entry);
        break;
      case "mint_outputs":
        outputs.set(key, entry);
        break;
      case "mint_abandoned":
        // Keyed per quote, not per drain: a drain that abandons one quote and
        // opens another has to be able to work on the second, and a
        // drain-level mark would hide it.
        abandoned.add(`${key}|${entry.quote_id}`);
        break;
    }
  }
  const openQuotes: OpenMintQuote[] = [];
  for (const [key, quote] of quotes) {
    // A quote whose proofs already reached `swapped` is not open: the park log
    // owns it from there, and re-driving the mint side would ask a mint that
    // has already issued to issue again.
    if (parked.has(key) || swapped.has(key) || abandoned.has(`${key}|${quote.quote_id}`)) continue;
    const paidEntry = paid.get(key);
    const paymentRejectedEntry = paymentRejected.get(key);
    const outputsEntry = outputs.get(key);
    openQuotes.push({
      quote,
      // Entries from an earlier, abandoned quote on the same drain would
      // otherwise be read as this quote's progress.
      ...(paidEntry?.quote_id === quote.quote_id ? { paid: paidEntry } : {}),
      ...(paymentRejectedEntry?.quote_id === quote.quote_id
        ? { paymentRejected: paymentRejectedEntry }
        : {}),
      ...(outputsEntry?.quote_id === quote.quote_id ? { outputs: outputsEntry } : {}),
    });
  }
  return {
    unparked: [...swapped.entries()].filter(([k]) => !parked.has(k)).map(([, e]) => e),
    openQuotes,
  };
}

function appendEntry(entry: DrainParkEntry): void {
  if (!existsSync(BUILDER_CONFIG_DIR)) {
    mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(DRAIN_PARK_LOG_FILE)) {
    writeFileSync(DRAIN_PARK_LOG_FILE, "", { mode: 0o600 });
  } else {
    chmodSync(DRAIN_PARK_LOG_FILE, 0o600);
  }
  appendFileSync(DRAIN_PARK_LOG_FILE, JSON.stringify(entry) + "\n");
}

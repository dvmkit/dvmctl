import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import { BUILDER_CONFIG_DIR, MELT_PENDING_LOG_FILE } from "../shared/defaults.ts";

/**
 * Record written immediately before a melt is submitted to the mint. Pairs
 * 1:1 with a post-melt entry via `(dvm_id, quote_id)`. Crash between the two
 * means the LN payment may or may not have happened — the rerun's recovery
 * sweep resolves it via NUT-05 quote-state lookup.
 */
export interface PreMeltEntry {
  kind: "pre_melt";
  ts: number;
  dvm_id: string;
  row_ids: string[];
  mint_url: string;
  quote_id: string;
  lock_pubkey: string;
  total_sats: number;
}

/**
 * Record written after the melt finishes (or definitively fails). `status:
 * "success"` carries the LN preimage so the rerun's recovery sweep can
 * forward it to `mark-melted` if the pre-melt entry was orphaned.
 */
export interface PostMeltEntry {
  kind: "post_melt";
  ts: number;
  dvm_id: string;
  row_ids: string[];
  quote_id: string;
  status: "success" | "failed";
  preimage?: string;
  error?: string;
}

/**
 * An operator's statement that an unresolved melt is known to be stuck. It
 * changes nothing about the pre-melt it names: the rows stay held and recovery
 * keeps checking the quote. It only stops the in-flight alarm failing the run.
 *
 * The quote is named in `acknowledged_quote_id`, never `quote_id`. Releases
 * before this entry existed treat every non-`pre_melt` line carrying a
 * matching `quote_id` as the pair's resolution, which would release the held
 * rows to a fresh melt and stop recovering the quote. Without `quote_id` those
 * readers match it to no pre-melt and keep alarming instead.
 */
export interface MeltAcknowledgedEntry {
  kind: "melt_acknowledged";
  ts: number;
  dvm_id: string;
  acknowledged_quote_id: string;
  reason: string;
}

/**
 * Union of records that appear in `~/.dvmkit/melt-pending.log`.
 *
 * The JSONL file is an append-only recovery and audit journal. This module
 * deliberately never rotates or prunes it: an unmatched pre-melt must survive
 * arbitrary restart gaps, and retention is an operator policy rather than a
 * safe inference the writer can make.
 */
export type MeltPendingEntry = PreMeltEntry | PostMeltEntry | MeltAcknowledgedEntry;

/**
 * An in-flight melt — a pre-melt record without a matching post-melt. The
 * recovery sweep on each run consumes these and either reconciles them via
 * `checkMeltQuoteState` + `mark-melted` (PAID) or marks them failed (UNPAID).
 */
export interface InFlightMelt {
  ts: number;
  dvmId: string;
  rowIds: string[];
  mintUrl: string;
  quoteId: string;
  lockPubkey: string;
  totalSats: number;
  /** Latest operator acknowledgement for this quote, when one was recorded. */
  acknowledged?: { ts: number; reason: string };
}

/** What the journal knows about one quote — see {@link lookupMeltQuote}. */
export type MeltQuoteLookup =
  | { state: "unknown" }
  | { state: "resolved" }
  | { state: "in_flight"; entry: InFlightMelt };

/**
 * Append a pre-melt entry to the JSONL log at `~/.dvmkit/melt-pending.log`.
 * Creates the file with mode 0600 if absent. Synchronous — durability before
 * the network call matters more than non-blocking I/O at this volume.
 */
export function appendPreMelt(entry: Omit<PreMeltEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "pre_melt", ts: Date.now() });
}

/** Append a post-melt entry pairing with a previously-written pre-melt. */
export function appendPostMelt(entry: Omit<PostMeltEntry, "kind" | "ts">): void {
  appendEntry({ ...entry, kind: "post_melt", ts: Date.now() });
}

/**
 * Append an acknowledgement for one unresolved quote. The caller validates the
 * quote against {@link lookupMeltQuote} first; this only writes the record.
 */
export function appendAcknowledgement(
  entry: Omit<MeltAcknowledgedEntry, "kind" | "ts">
): MeltAcknowledgedEntry {
  const record: MeltAcknowledgedEntry = { ...entry, kind: "melt_acknowledged", ts: Date.now() };
  appendEntry(record);
  return record;
}

/** Classify one quote as never journalled, resolved, or still in flight for `dvmId`. */
export function lookupMeltQuote(dvmId: string, quoteId: string): MeltQuoteLookup {
  const journal = scanJournal(dvmId);
  if (!journal.pre.has(quoteId)) return { state: "unknown" };
  if (journal.done.has(quoteId)) return { state: "resolved" };
  return { state: "in_flight", entry: toInFlight(journal, quoteId) };
}

/**
 * Scan the log and return entries with a `pre_melt` record but no matching
 * `post_melt`. Pairs are matched on `(dvm_id, quote_id)`. Scoped to `dvmId`
 * so a multi-DVM operator running `melt-pending` per DVM only sees the
 * relevant in-flight set. The whole retained journal is scanned; malformed
 * lines are ignored, but neither completed pairs nor unrelated DVMs are
 * removed from the audit trail.
 */
export function readInFlight(dvmId: string): InFlightMelt[] {
  const journal = scanJournal(dvmId);
  const out: InFlightMelt[] = [];
  for (const quoteId of journal.pre.keys()) {
    if (journal.done.has(quoteId)) continue;
    out.push(toInFlight(journal, quoteId));
  }
  return out;
}

interface ScannedJournal {
  pre: Map<string, PreMeltEntry>;
  done: Set<string>;
  acknowledged: Map<string, MeltAcknowledgedEntry>;
}

/**
 * One DVM's journal keyed by quote. Only a `post_melt` resolves a pair: an
 * unknown `kind` written by a newer release is ignored, which keeps its quote
 * held rather than releasing rows that may still be paying out.
 */
function scanJournal(dvmId: string): ScannedJournal {
  const journal: ScannedJournal = { pre: new Map(), done: new Set(), acknowledged: new Map() };
  if (!existsSync(MELT_PENDING_LOG_FILE)) return journal;
  const raw = readFileSync(MELT_PENDING_LOG_FILE, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: MeltPendingEntry;
    try {
      entry = JSON.parse(line) as MeltPendingEntry;
    } catch {
      continue;
    }
    if (entry.dvm_id !== dvmId) continue;
    if (entry.kind === "pre_melt") journal.pre.set(entry.quote_id, entry);
    else if (entry.kind === "post_melt") journal.done.add(entry.quote_id);
    else if (entry.kind === "melt_acknowledged") {
      journal.acknowledged.set(entry.acknowledged_quote_id, entry);
    }
  }
  return journal;
}

function toInFlight(journal: ScannedJournal, quoteId: string): InFlightMelt {
  const entry = journal.pre.get(quoteId) as PreMeltEntry;
  const ack = journal.acknowledged.get(quoteId);
  return {
    ts: entry.ts,
    dvmId: entry.dvm_id,
    rowIds: entry.row_ids,
    mintUrl: entry.mint_url,
    quoteId: entry.quote_id,
    lockPubkey: entry.lock_pubkey,
    totalSats: entry.total_sats,
    ...(ack ? { acknowledged: { ts: ack.ts, reason: ack.reason } } : {}),
  };
}

/** Append one record without rewriting, rotating, or pruning earlier history. */
function appendEntry(entry: MeltPendingEntry): void {
  ensureLogFile();
  appendFileSync(MELT_PENDING_LOG_FILE, JSON.stringify(entry) + "\n");
}

function ensureLogFile(): void {
  if (!existsSync(BUILDER_CONFIG_DIR)) {
    mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(MELT_PENDING_LOG_FILE)) {
    writeFileSync(MELT_PENDING_LOG_FILE, "", { mode: 0o600 });
  } else {
    // Tighten perms in case the file was created with a wider umask.
    chmodSync(MELT_PENDING_LOG_FILE, 0o600);
  }
}

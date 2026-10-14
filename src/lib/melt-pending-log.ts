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
 * Union of records that appear in `~/.dvmkit/melt-pending.log`.
 *
 * The JSONL file is an append-only recovery and audit journal. This module
 * deliberately never rotates or prunes it: an unmatched pre-melt must survive
 * arbitrary restart gaps, and retention is an operator policy rather than a
 * safe inference the writer can make.
 */
export type MeltPendingEntry = PreMeltEntry | PostMeltEntry;

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
}

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
 * Scan the log and return entries with a `pre_melt` record but no matching
 * `post_melt`. Pairs are matched on `(dvm_id, quote_id)`. Scoped to `dvmId`
 * so a multi-DVM operator running `melt-pending` per DVM only sees the
 * relevant in-flight set. The whole retained journal is scanned; malformed
 * lines are ignored, but neither completed pairs nor unrelated DVMs are
 * removed from the audit trail.
 */
export function readInFlight(dvmId: string): InFlightMelt[] {
  if (!existsSync(MELT_PENDING_LOG_FILE)) return [];
  const raw = readFileSync(MELT_PENDING_LOG_FILE, "utf-8");
  const pre = new Map<string, PreMeltEntry>();
  const done = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: MeltPendingEntry;
    try {
      entry = JSON.parse(line) as MeltPendingEntry;
    } catch {
      continue;
    }
    if (entry.dvm_id !== dvmId) continue;
    const key = `${entry.dvm_id}|${entry.quote_id}`;
    if (entry.kind === "pre_melt") {
      pre.set(key, entry);
    } else {
      done.add(key);
    }
  }
  const out: InFlightMelt[] = [];
  for (const [key, entry] of pre) {
    if (done.has(key)) continue;
    out.push({
      ts: entry.ts,
      dvmId: entry.dvm_id,
      rowIds: entry.row_ids,
      mintUrl: entry.mint_url,
      quoteId: entry.quote_id,
      lockPubkey: entry.lock_pubkey,
      totalSats: entry.total_sats,
    });
  }
  return out;
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

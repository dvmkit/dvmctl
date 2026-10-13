import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { BUILDER_CONFIG_DIR, MELT_SUCCESS_FILE } from "../shared/defaults.ts";

/** Separate clocks prevent a drains-only cron from vouching for a stopped sweep daemon. */
export type MeltRunMode = "sweep" | "drains_only";

export interface MeltRunRecord {
  /** ISO-8601 completion time of the run. */
  at: string;
  /** Handle the run was invoked with — a readable companion to the canonical-id key. */
  handle: string;
  /** Accumulator batches swept to the payout destination. Structurally zero under `drains_only`. */
  batches_melted: number;
  /** Sats those batches carried. */
  sats_melted: number;
  /** Caller refunds parked. */
  drains_parked: number;
}

/**
 * One DVM's melt liveness: the last clean run of each mode.
 *
 * Only `sweep` answers "is my melt still working" — a `--drains-only` run
 * settles refunds and deliberately sweeps nothing, so it can never stand in for
 * one.
 */
export interface MeltSuccessRecord {
  /** Last clean full sweep, or `null` if there has never been one here. */
  sweep: MeltRunRecord | null;
  /** Last clean `--drains-only` run, or `null`. Never substitutes for `sweep`. */
  drains_only: MeltRunRecord | null;
}

/**
 * Call only after a successful run, including watch ticks. Canonical IDs keep
 * DVM clocks separate. Persistence is best-effort: a write failure costs the
 * liveness record, not the completed sweep.
 */
export function recordMeltSuccess(
  dvmId: string,
  mode: MeltRunMode,
  run: Omit<MeltRunRecord, "at">,
  nowMs = Date.now()
): void {
  const state = readState();
  const existing = state.get(dvmId) ?? { sweep: null, drains_only: null };
  state.set(dvmId, { ...existing, [mode]: { ...run, at: new Date(nowMs).toISOString() } });
  writeState(state);
}

/** Both clocks for one DVM, or `null` when neither mode has ever run cleanly here. */
export function readMeltSuccess(dvmId: string): MeltSuccessRecord | null {
  return readState().get(dvmId) ?? null;
}

/**
 * Every recorded run, keyed by canonical DVM id. A `Map` rather than an object
 * so a DVM with no record reads as absent by type, which is the case every
 * caller has to handle and the one it is easiest to forget.
 */
export function readMeltSuccesses(): Map<string, MeltSuccessRecord> {
  return readState();
}

/**
 * Milliseconds since the run, or null for absent, unparseable, or future timestamps.
 * Zero or a negative age would make a future-dated record pass freshness checks.
 */
export function meltRunAgeMs(run: MeltRunRecord | null, nowMs = Date.now()): number | null {
  if (!run) return null;
  const atMs = Date.parse(run.at);
  if (Number.isNaN(atMs)) return null;
  if (atMs > nowMs) return null;
  return nowMs - atMs;
}

type MeltSuccessFile = Map<string, MeltSuccessRecord>;

function readState(): MeltSuccessFile {
  const state: MeltSuccessFile = new Map();
  if (!existsSync(MELT_SUCCESS_FILE)) return state;
  try {
    const parsed: unknown = JSON.parse(readFileSync(MELT_SUCCESS_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return state;
    for (const [dvmId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const record = coerce(entry);
      if (record) state.set(dvmId, record);
    }
    return state;
  } catch {
    return new Map();
  }
}

function coerce(entry: unknown): MeltSuccessRecord | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const candidate = entry as Partial<Record<MeltRunMode, unknown>>;
  const sweep = coerceRun(candidate.sweep);
  const drainsOnly = coerceRun(candidate.drains_only);
  if (!sweep && !drainsOnly) return null;
  return { sweep, drains_only: drainsOnly };
}

function coerceRun(run: unknown): MeltRunRecord | null {
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const candidate = run as Partial<MeltRunRecord>;
  if (typeof candidate.at !== "string") return null;
  return {
    at: candidate.at,
    handle: typeof candidate.handle === "string" ? candidate.handle : "",
    batches_melted: numberOr(candidate.batches_melted),
    sats_melted: numberOr(candidate.sats_melted),
    drains_parked: numberOr(candidate.drains_parked),
  };
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function writeState(state: MeltSuccessFile): void {
  try {
    if (!existsSync(BUILDER_CONFIG_DIR)) {
      mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(MELT_SUCCESS_FILE, JSON.stringify(Object.fromEntries(state)), { mode: 0o600 });
    chmodSync(MELT_SUCCESS_FILE, 0o600);
  } catch {
    // A record we cannot write costs the liveness signal, not the melt that
    // just succeeded. The next run rewrites it.
  }
}

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { BUILDER_CONFIG_DIR, DRAIN_HOLD_STATE_FILE } from "../shared/defaults.ts";

/**
 * How long a DVM's pending-drain surface has been unreadable, as recorded
 * across `dvmctl melt-pending` runs.
 */
export interface DrainHoldStreak {
  /** ISO timestamp of the first run in the current unreadable streak. */
  unknown_since: string;
}

/**
 * Persist one unreadable-drain streak per canonical DVM ID across one-shot runs.
 * A known surface clears it; subsequent unknown runs preserve its start.
 * Persistence is best-effort: corrupt or unwritable state can lose the hold's
 * alarm ceiling without failing the sweep.
 */
export function recordDrainState(dvmId: string, known: boolean, nowMs = Date.now()): string | null {
  const state = readState();
  if (known) {
    if (!state.has(dvmId)) return null;
    state.delete(dvmId);
    writeState(state);
    return null;
  }
  const existing = state.get(dvmId)?.unknown_since;
  if (existing) return existing;
  const since = new Date(nowMs).toISOString();
  state.set(dvmId, { unknown_since: since });
  writeState(state);
  return since;
}

/**
 * Milliseconds the current unreadable streak has run for, or `null` when
 * `unknownSince` is absent or unparseable. Shared by the tick log and the
 * one-shot exit contract so both read the same clock.
 */
export function drainHoldElapsedMs(unknownSince: string | null, nowMs = Date.now()): number | null {
  if (!unknownSince) return null;
  const startedMs = Date.parse(unknownSince);
  if (Number.isNaN(startedMs)) return null;
  return Math.max(0, nowMs - startedMs);
}

type DrainHoldFile = Map<string, DrainHoldStreak>;

function readState(): DrainHoldFile {
  const state: DrainHoldFile = new Map();
  if (!existsSync(DRAIN_HOLD_STATE_FILE)) return state;
  try {
    const parsed: unknown = JSON.parse(readFileSync(DRAIN_HOLD_STATE_FILE, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return state;
    for (const [dvmId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const since = (entry as Partial<DrainHoldStreak> | null)?.unknown_since;
      if (typeof since === "string") state.set(dvmId, { unknown_since: since });
    }
    return state;
  } catch {
    return new Map();
  }
}

function writeState(state: DrainHoldFile): void {
  try {
    if (!existsSync(BUILDER_CONFIG_DIR)) {
      mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(DRAIN_HOLD_STATE_FILE, JSON.stringify(Object.fromEntries(state)), {
      mode: 0o600,
    });
    chmodSync(DRAIN_HOLD_STATE_FILE, 0o600);
  } catch {
    // A state file we cannot write costs the hold its ceiling, not the sweep.
  }
}

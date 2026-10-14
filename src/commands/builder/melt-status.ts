import { DvmError } from "@dvmkit/sdk/internal";

import { parseDurationMs } from "../../lib/duration.ts";
import {
  meltRunAgeMs,
  type MeltRunRecord,
  type MeltSuccessRecord,
  readMeltSuccesses,
} from "../../lib/melt-success-state.ts";
import { loadBuilderStore, requireBuilderDvmByHandle } from "../../shared/builder-store.ts";
import { BUILDER_FILE, MELT_SUCCESS_FILE } from "../../shared/defaults.ts";
import { info, json } from "../../shared/output.ts";

export interface MeltStatusOptions {
  /** Exit non-zero if a full sweep is missing or older than this duration (`30h`, `2d`). */
  maxAge?: string;
  /**
   * Repeatable explicit exemptions from the alarm. Missing liveness records cannot
   * identify non-Cashu DVMs safely; invalid or ambiguous handles are refused.
   */
  except?: string[];
  human?: boolean;
}

/** One DVM's melt liveness, as `dvmctl melt-status` reports it. */
export interface MeltStatusEntry {
  /** DVM handle as recorded in `builder.json`. */
  handle: string;
  /** Immutable canonical DVM id — the key the record is stored under. */
  dvm_id: string;
  /** ISO-8601 of the last clean full sweep, or `null` if there has never been one here. */
  last_success_at: string | null;
  /** Seconds since that sweep, or `null` when there is none to age. */
  age_seconds: number | null;
  /** True when `--max-age` was given, this handle was not named by `--except`, and its sweep is absent or outside the window. */
  stale: boolean;
  /** Accumulator batches that sweep melted; `null` with no sweep recorded. */
  batches_melted: number | null;
  /** Sats those batches carried; `null` with no sweep recorded. */
  sats_melted: number | null;
  /** Caller refunds that sweep parked; `null` with no sweep recorded. */
  drains_parked: number | null;
  /**
   * ISO-8601 of the last clean `--drains-only` run, or `null`. Reported for
   * completeness and deliberately **not** counted by `--max-age`: that mode
   * settles refunds and sweeps nothing, so it says nothing about whether your
   * payout melt still works.
   */
  last_drains_only_at: string | null;
  /** Seconds since that `--drains-only` run, or `null`. */
  drains_only_age_seconds: number | null;
}

/**
 * Local liveness alarm for hosted or self-hosted builders. Missing sweeps are
 * stale: failed writes, malformed records or concurrent non-atomic updates can
 * lose evidence. Only explicit `--except` exempts a configured DVM.
 */
export function meltStatus(handle: string | undefined, opts: MeltStatusOptions): void {
  const maxAgeMs = resolveMaxAgeMs(opts.maxAge);
  const records = readMeltSuccesses();
  const nowMs = Date.now();

  const except = validatedExcept(opts.except ?? []);
  const configured = configuredTargets();
  const all = targets(handle, configured);
  refuseAmbiguousExcept(all, except);
  const watched = all.filter((target) => !except.has(target.handle));
  const excepted = all.filter((target) => except.has(target.handle)).map((t) => t.handle);
  const configuredIds = new Set(configured.map((target) => target.dvmId));
  const orphaned = [...records.keys()].filter((dvmId) => !configuredIds.has(dvmId)).sort();

  const dvms = all.map((target): MeltStatusEntry => {
    const record = records.get(target.dvmId) ?? null;
    return entryFor(target, record, except.has(target.handle) ? null : maxAgeMs, nowMs);
  });

  // Emitted before either refusal below, so an agent parsing stdout gets the
  // same shape whichever way the run ends.
  emit(dvms, { maxAgeMs, excepted, orphaned, human: !!opts.human });

  // An empty alarm must refuse, including a wrong state directory or all DVMs exempted.
  if (maxAgeMs !== null && watched.length === 0) nothingToWatch(all.length > 0);

  const stale = dvms.filter((entry) => entry.stale);
  if (stale.length > 0) throw staleError(stale, opts.maxAge ?? "");
}

function entryFor(
  target: { handle: string; dvmId: string },
  record: MeltSuccessRecord | null,
  maxAgeMs: number | null,
  nowMs: number
): MeltStatusEntry {
  const sweep: MeltRunRecord | null = record?.sweep ?? null;
  const drainsOnly: MeltRunRecord | null = record?.drains_only ?? null;
  const sweepAgeMs = meltRunAgeMs(sweep, nowMs);
  const drainsOnlyAgeMs = meltRunAgeMs(drainsOnly, nowMs);
  return {
    handle: target.handle,
    dvm_id: target.dvmId,
    last_success_at: sweep?.at ?? null,
    age_seconds: sweepAgeMs === null ? null : Math.floor(sweepAgeMs / 1000),
    stale: maxAgeMs !== null && (sweepAgeMs === null || sweepAgeMs > maxAgeMs),
    batches_melted: sweep?.batches_melted ?? null,
    sats_melted: sweep?.sats_melted ?? null,
    drains_parked: sweep?.drains_parked ?? null,
    last_drains_only_at: drainsOnly?.at ?? null,
    drains_only_age_seconds: drainsOnlyAgeMs === null ? null : Math.floor(drainsOnlyAgeMs / 1000),
  };
}

/** Reject a following flag consumed as an exemption value; it could remove the alarm window. */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function validatedExcept(handles: string[]): Set<string> {
  for (const handle of handles) {
    if (HANDLE_PATTERN.test(handle)) continue;
    throw new DvmError(
      "invalid_except_handle",
      `\`--except ${handle || "<empty>"}\` is not a DVM handle.`,
      "A handle is lowercase letters, digits and hyphens. This most often means the value was swallowed from the next flag — `--except --max-age 30h` reads `--max-age` as the handle and leaves no window, which turns the alarm into a plain read that always exits 0. Put a handle after every `--except`, and repeat the flag for each one."
    );
  }
  return new Set(handles);
}

/**
 * Ambiguous handles must not exempt both a retired and live DVM. Unmatched
 * exemptions remain benign so retiring a DVM does not break an existing cron.
 */
function refuseAmbiguousExcept(
  all: { handle: string; dvmId: string }[],
  except: Set<string>
): void {
  for (const handle of except) {
    const matches = all.filter((target) => target.handle === handle);
    if (matches.length <= 1) continue;
    throw new DvmError(
      "ambiguous_dvm_handle",
      `${matches.length} builder.json entries claim the handle "${handle}", so \`--except ${handle}\` cannot pick between them.`,
      `Excepting by handle would drop every one of them from the alarm, including a DVM that is still melting. Candidates: ${matches
        .map((target) => target.dvmId)
        .join(
          ", "
        )}. Remove the entry you no longer operate from ${BUILDER_FILE}, then except the handle.`
    );
  }
}

/** Named queries share the store's unknown/ambiguous-handle refusal. */
function targets(
  handle: string | undefined,
  configured: { handle: string; dvmId: string }[]
): { handle: string; dvmId: string }[] {
  if (handle) {
    const entry = requireBuilderDvmByHandle(handle);
    return [{ handle: entry.handle, dvmId: entry.canonical_dvm_id }];
  }
  return configured;
}

/** Every DVM in `builder.json`, including those outside a positional query. */
function configuredTargets(): { handle: string; dvmId: string }[] {
  return Object.values(loadBuilderStore().dvms)
    .map((entry) => ({ handle: entry.handle, dvmId: entry.canonical_dvm_id }))
    .sort((a, b) => a.handle.localeCompare(b.handle));
}

/** One code, two causes: nothing recorded here, or everything excepted by flag. */
function nothingToWatch(allExcepted: boolean): never {
  throw new DvmError(
    "no_dvms_recorded",
    allExcepted
      ? "Every DVM on this machine was excluded by `--except`, so `--max-age` has nothing to check."
      : `No DVMs are recorded in ${BUILDER_FILE}, so \`--max-age\` has nothing to check.`,
    allExcepted
      ? "Exiting 0 here would be an alarm that can never fire, so this refuses instead. Drop an `--except` flag, or drop `--max-age` if you only wanted to read the record."
      : "Exiting 0 here would be an alarm that can never fire, so this refuses instead. The usual cause is the command running against the wrong state directory rather than a machine with no DVMs — a cron or launchd job runs in a minimal environment, so check `HOME` is the account that deployed these DVMs, or set `DVMKIT_CONFIG_DIR` explicitly in the job."
  );
}

function resolveMaxAgeMs(input: string | undefined): number | null {
  if (!input) return null;
  try {
    return parseDurationMs(input);
  } catch (err) {
    throw new DvmError(
      "invalid_duration",
      err instanceof Error ? err.message : String(err),
      "`--max-age` takes one count and one unit — e.g. `30h`, `2d`. Set it a little longer than your melt cadence so a single late run is not an alarm."
    );
  }
}

function staleError(stale: MeltStatusEntry[], maxAge: string): DvmError {
  const named = stale
    .map((entry) =>
      entry.last_success_at
        ? `${entry.handle} (last swept ${entry.last_success_at})`
        : `${entry.handle} (never swept on this machine)`
    )
    .join(", ");
  return new DvmError(
    "melt_stale",
    `${stale.length} DVM(s) have not melted successfully within ${maxAge}: ${named}.`,
    "Nothing is being swept to your payout destination and no caller refund is parking for these DVMs. Check the scheduled `dvmctl melt-pending` is still running at all — a cron that stopped firing or a `--watch` daemon that was killed is the usual cause — then run it by hand and read the error it gives you. A `--drains-only` run does not count here: it settles refunds and sweeps nothing. If one of these DVMs has no Cashu rail and is never meant to melt, exclude it with `--except <handle>`."
  );
}

function emit(
  dvms: MeltStatusEntry[],
  ctx: { maxAgeMs: number | null; excepted: string[]; orphaned: string[]; human: boolean }
): void {
  if (!ctx.human) {
    json({
      dvms,
      max_age_seconds: ctx.maxAgeMs === null ? null : Math.floor(ctx.maxAgeMs / 1000),
      excepted: ctx.excepted,
      orphaned: ctx.orphaned,
      state_file: MELT_SUCCESS_FILE,
    });
    return;
  }
  if (dvms.length === 0) {
    info("No configured DVMs to report on.");
  } else {
    for (const entry of dvms) {
      info(
        `${entry.handle}: ${
          entry.last_success_at
            ? `last clean sweep ${entry.last_success_at} (${describeAge(entry.age_seconds)} ago)`
            : "no clean sweep recorded on this machine"
        }${entry.stale ? " — STALE" : ""}${
          entry.last_drains_only_at
            ? ` · last drains-only ${describeAge(entry.drains_only_age_seconds)} ago`
            : ""
        }`
      );
    }
  }
  if (ctx.excepted.length > 0) info(`Excepted: ${ctx.excepted.join(", ")}`);
  if (ctx.orphaned.length > 0) {
    info(`Orphaned melt records (not watched): ${ctx.orphaned.join(", ")}`);
  }
  info(`Record: ${MELT_SUCCESS_FILE}`);
}

function describeAge(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

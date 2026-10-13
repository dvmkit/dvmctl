/**
 * Sole owner of `CONFIG_DIR`'s POSIX mode (`~/.dvm` by default).
 *
 * Every caller-side write path creates the directory lazily, and `mkdirSync`
 * only applies its `mode` to a directory it actually creates — so a single
 * no-mode call site anywhere decided the mode for the whole tree, and every
 * later mode-carrying call was a no-op. Creation goes through
 * {@link ensureConfigDir} instead, and {@link repairConfigDirMode} heals the
 * installed base, which mode-on-create can never reach.
 *
 * The files underneath are independently 0600, so this is defence in depth:
 * what 0700 buys is that a second local user cannot list the directory and
 * learn which rails are configured, or read the deliberately-public
 * `receipts.jsonl`.
 */

import { chmodSync, mkdirSync, statSync } from "fs";

import { CONFIG_DIR } from "./defaults.ts";

/** Owner-only mode `~/.dvm` is meant to carry. */
export const CONFIG_DIR_MODE = 0o700;

/** Outcome of a {@link repairConfigDirMode} pass. Never throws; failures land in `error`. */
export interface ConfigDirModeResult {
  path: string;
  /** Whether the directory exists. False also when the stat itself failed (see `error`). */
  exists: boolean;
  /** Mode after the pass, e.g. `"0700"`. Null when absent, unreadable, or off-POSIX. */
  modeOctal: string | null;
  /** Mode found before the pass, when {@link repaired} is true. */
  previousModeOctal?: string;
  /** True when this call tightened a group/other-accessible directory to 0700. */
  repaired: boolean;
  /** True on Windows, where POSIX modes are meaningless and the pass is a no-op. */
  skippedNonPosix: boolean;
  /** Underlying message when the stat or chmod failed. */
  error?: string;
}

/**
 * Create `CONFIG_DIR` at mode 0700 if it does not exist. Idempotent, and the
 * only sanctioned way to create the directory — a bare
 * `mkdirSync(CONFIG_DIR, …)` elsewhere is what caused tracked change and is pinned
 * against by `config-dir.test.ts`.
 */
export function ensureConfigDir(): void {
  ensureConfigSubdir(CONFIG_DIR);
}

/**
 * Same, for a path *inside* the caller-state tree (`MESSAGES_DIR`,
 * `PAIRINGS_DIR`, `ADMIN_DIR`, `dirname(BTC_RATE_FILE)`). A recursive mkdir
 * creates `CONFIG_DIR` as a parent and stamps it with this mode, so a
 * subdirectory call site decides the whole tree's mode exactly as a
 * `CONFIG_DIR` one does — which is why these route through here too, and why
 * `config-dir.test.ts` pins every mkdir of a `CONFIG_DIR`-derived path.
 *
 * The path is passed in rather than joined from `CONFIG_DIR` here, so a suite
 * that repoints one of those constants in a `defaults` mock keeps working.
 */
export function ensureConfigSubdir(path: string): void {
  mkdirSync(path, { recursive: true, mode: CONFIG_DIR_MODE });
}

/**
 * Tighten an existing `CONFIG_DIR` to 0700 when it is group- or
 * other-accessible. Does not create the directory — an absent one is reported,
 * not conjured, so read-mostly callers (`dvm doctor`) stay honest.
 *
 * Only *loosening* is corrected: a directory an operator deliberately set
 * stricter than 0700 (e.g. 0500) is left alone, so a shared-service setup is
 * not fought with on every run. No-op on Windows.
 */
export function repairConfigDirMode(): ConfigDirModeResult {
  const base: ConfigDirModeResult = {
    path: CONFIG_DIR,
    exists: false,
    modeOctal: null,
    repaired: false,
    skippedNonPosix: process.platform === "win32",
  };

  if (base.skippedNonPosix) return base;

  let mode: number;
  try {
    mode = statSync(CONFIG_DIR).mode & 0o777;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return missing ? base : { ...base, error: message };
  }

  if ((mode & 0o077) === 0) {
    return { ...base, exists: true, modeOctal: toOctal(mode) };
  }

  try {
    chmodSync(CONFIG_DIR, CONFIG_DIR_MODE);
  } catch (err) {
    return {
      ...base,
      exists: true,
      modeOctal: toOctal(mode),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ...base,
    exists: true,
    modeOctal: toOctal(CONFIG_DIR_MODE),
    previousModeOctal: toOctal(mode),
    repaired: true,
  };
}

function toOctal(mode: number): string {
  return "0" + mode.toString(8).padStart(3, "0");
}

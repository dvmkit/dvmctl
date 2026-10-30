import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { backupSecretFile, DvmError } from "@dvmkit/sdk/internal";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import {
  BUILDER_CONFIG_DIR,
  BUILDER_CONFIG_DIR_EXPLICIT,
  BUILDER_MNEMONIC_FILE,
  LEGACY_BUILDER_MNEMONIC_FILE,
  RECOVERY_MNEMONIC_FILE,
} from "../shared/defaults.ts";
import { info } from "../shared/output.ts";

export interface WriteMnemonicResult {
  /**
   * Path of the timestamped 0600 copy of the mnemonic that was replaced, or
   * null when nothing was replaced (no prior file, or identical words).
   */
  backupFile: string | null;
}

/** Generate a fresh 12-word BIP-39 mnemonic for builder Cashu lock keypairs. */
export function generateRecoveryMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

/** Validate a BIP-39 mnemonic against the English wordlist. */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Read the builder's BIP-39 mnemonic from `~/.dvmkit/builder.mnemonic`.
 * Auto-migrates the former `~/.dvmkit/recovery.mnemonic` name, or the older
 * pre-state-split `~/.dvm/recovery.mnemonic`, when the current path is absent.
 * Migration is disabled when DVMKIT_CONFIG_DIR is explicitly set, even to the
 * default directory. Otherwise it removes its source after the 0600 copy is
 * in place, so a second read is a no-op. Returns null when no current or
 * eligible legacy mnemonic exists.
 */
export function readBuilderMnemonic(): string | null {
  if (existsSync(BUILDER_MNEMONIC_FILE)) {
    return readFileSync(BUILDER_MNEMONIC_FILE, "utf-8").trim();
  }
  if (BUILDER_CONFIG_DIR_EXPLICIT) return null;
  const legacyFile = findLegacyMnemonic();
  if (legacyFile) {
    mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${BUILDER_MNEMONIC_FILE}.tmp`;
    try {
      copyFileSync(legacyFile, tmp);
      chmodSync(tmp, 0o600);
      renameSync(tmp, BUILDER_MNEMONIC_FILE);
      chmodSync(BUILDER_MNEMONIC_FILE, 0o600);
      unlinkSync(legacyFile);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* swallow */
      }
      throw err;
    }
    info(`Migrated builder mnemonic → ${BUILDER_MNEMONIC_FILE}`);
    return readFileSync(BUILDER_MNEMONIC_FILE, "utf-8").trim();
  }
  return null;
}

function findLegacyMnemonic(): string | undefined {
  return [LEGACY_BUILDER_MNEMONIC_FILE, RECOVERY_MNEMONIC_FILE].find((path) => existsSync(path));
}

/** Explain a skipped migration without reading or exposing the recovery words. */
export function getBuilderMnemonicMigrationHint(): string | null {
  if (!BUILDER_CONFIG_DIR_EXPLICIT || existsSync(BUILDER_MNEMONIC_FILE)) return null;
  const legacyFile = findLegacyMnemonic();
  return legacyFile
    ? `Legacy recovery mnemonic found at ${legacyFile}; it was left untouched because DVMKIT_CONFIG_DIR explicitly selects ${BUILDER_CONFIG_DIR}. To reuse those words in this tree, run \`dvmctl lock create --import <words>\` in a private terminal. DVMCTL_CONFIG_DIR controls authentication separately.`
    : null;
}

/**
 * Write the builder's BIP-39 mnemonic to `~/.dvmkit/builder.mnemonic` (mode 0600).
 * Atomic tmp+rename so a crash mid-write never leaves a truncated file — a torn
 * write here is unrecoverable, as the mnemonic roots every Cashu lock keypair.
 *
 * Refuses to replace an existing mnemonic unless `force` is passed, so the
 * decision to destroy a derivation root is explicit and greppable at the call
 * site. "Existing" includes the legacy `recovery.mnemonic` in the selected
 * builder directory, and (only
 * without an explicit builder override) `~/.dvm/recovery.mnemonic`:
 * a caller that writes without reading first would otherwise leave those words
 * shadowed by a root nothing derives from.
 * A forced overwrite copies the prior words aside first — see
 * {@link backupSecretFile} — and reports that path back, because the words
 * this replaces are the only way to spend every proof locked to the DVMs
 * derived from them.
 */
export function writeBuilderMnemonic(
  mnemonic: string,
  opts: { force?: boolean } = {}
): WriteMnemonicResult {
  const existing = existsSync(BUILDER_MNEMONIC_FILE)
    ? BUILDER_MNEMONIC_FILE
    : existsSync(LEGACY_BUILDER_MNEMONIC_FILE)
      ? LEGACY_BUILDER_MNEMONIC_FILE
      : !BUILDER_CONFIG_DIR_EXPLICIT && existsSync(RECOVERY_MNEMONIC_FILE)
        ? RECOVERY_MNEMONIC_FILE
        : null;
  if (existing && !opts.force) {
    throw new DvmError(
      "mnemonic_exists",
      `A builder recovery mnemonic already exists at ${existing}.`,
      "Pass --force to replace it, or --import <words> to restore a known mnemonic. WARNING: the current words are the derivation root for every DVM's Cashu lock keypair — replacing them makes proofs locked to the old pubkeys unspendable. The replaced mnemonic is copied to a timestamped .bak sibling."
    );
  }

  mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Back up whichever file holds the words being superseded. In the legacy
  // case the original survives at its own path, but it stops being reachable
  // through `readBuilderMnemonic` once this write lands — so the caller still
  // needs a path to hand the operator.
  const backupFile = existing ? backupSecretFile(existing, mnemonic) : null;

  const tmp = `${BUILDER_MNEMONIC_FILE}.tmp`;
  try {
    writeFileSync(tmp, mnemonic + "\n", { mode: 0o600 });
    renameSync(tmp, BUILDER_MNEMONIC_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* swallow */
    }
    throw err;
  }
  // Re-chmod after rename — on some filesystems the move may have widened the
  // mode (the tmp side was 0o600 but Node may apply umask on rename targets).
  try {
    chmodSync(BUILDER_MNEMONIC_FILE, 0o600);
  } catch {
    // POSIX-only; no-op on Windows.
  }

  return { backupFile };
}

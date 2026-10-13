import { DvmError } from "@dvmkit/sdk/internal";

import {
  generateRecoveryMnemonic,
  isValidMnemonic,
  readBuilderMnemonic,
  writeBuilderMnemonic,
} from "../../lib/builder-mnemonic.ts";
import { BUILDER_MNEMONIC_FILE } from "../../shared/defaults.ts";
import { info, json } from "../../shared/output.ts";

export interface LockCreateOptions {
  human?: boolean;
  /** Import an existing mnemonic instead of generating a new one. */
  import?: string;
  /** Replace an existing mnemonic with a freshly generated one. */
  force?: boolean;
}

/**
 * Generate (or import) a BIP-39 mnemonic for builder Cashu P2PK lock
 * keypairs (tracked change rename of `dvmctl keygen`). Saves the mnemonic to
 * `~/.dvmkit/builder.mnemonic`. The mnemonic is the derivation root for
 * per-DVM lock keypairs (`dvmctl deploy` / `rotate` / `melt-pending`).
 *
 * An existing mnemonic is reported as `already_exists` and left alone unless
 * `--import` (restore known words) or `--force` (generate fresh ones) says
 * otherwise. Either way the replaced mnemonic is copied to a timestamped
 * `.bak` sibling and its path surfaced.
 */
export function lockCreate(opts: LockCreateOptions): void {
  const existing = readBuilderMnemonic();
  if (existing && !opts.import && !opts.force) {
    if (opts.human) {
      info("Builder mnemonic already exists.");
      info(`Mnemonic stored at: ${BUILDER_MNEMONIC_FILE}`);
      info("\nTo replace it, re-run with --force (fresh words) or --import <words>");
      info("(known words). Either way the current mnemonic is copied to a");
      info("timestamped .bak sibling first.");
      info("\n⚠  Proofs locked to lock pubkeys derived from the current words stop");
      info("   being spendable once you replace them — re-run `dvmctl deploy` for");
      info("   every DVM afterwards.");
    } else {
      json({
        status: "already_exists",
        mnemonicFile: BUILDER_MNEMONIC_FILE,
        hint: `A builder mnemonic already exists, so nothing was written. Re-run with --force to generate fresh words, or --import <words> to restore a known mnemonic; either way the current mnemonic is copied to a timestamped .bak sibling (mode 0600) first. Replacing it makes proofs locked to lock pubkeys derived from the current words unspendable, so \`dvmctl deploy\` has to be re-run for every DVM afterwards.`,
      });
    }
    return;
  }

  let mnemonic: string;
  if (opts.import) {
    const words = opts.import.trim();
    if (!isValidMnemonic(words)) {
      throw new DvmError(
        "invalid_mnemonic",
        "The provided mnemonic is not a valid 12-word BIP-39 phrase.",
        "Check that all 12 words are correct and separated by spaces."
      );
    }
    mnemonic = words;
  } else {
    mnemonic = generateRecoveryMnemonic();
  }

  // Both branches here are deliberate replacements — `--import` is the restore
  // path, `--force` the rotate-in-place one — so the library guard opts in.
  const { backupFile } = writeBuilderMnemonic(mnemonic, {
    force: Boolean(opts.import) || Boolean(opts.force),
  });

  if (opts.human) {
    if (!opts.import) {
      info("Builder mnemonic generated.\n");
      info("⚠  Write down these 12 words — they are the ONLY way to recover");
      info("   Cashu proofs locked to your DVMs. We never see them.\n");
      const words = mnemonic.split(" ");
      for (let i = 0; i < words.length; i++) {
        info(`  ${String(i + 1).padStart(2)}. ${words[i]}`);
      }
      info("");
    } else {
      info("Builder mnemonic imported.\n");
    }
    info(`Mnemonic stored at: ${BUILDER_MNEMONIC_FILE}`);
    if (backupFile) {
      info(`Previous mnemonic backed up to: ${backupFile}`);
      info(
        "⚠  Proofs locked to lock pubkeys derived from the previous mnemonic\n" +
          "   are no longer spendable with this one. Re-run `dvmctl deploy` for\n" +
          "   every DVM so it advertises a lock pubkey you can still derive."
      );
    }
    info("\nThe per-DVM lock pubkey is registered automatically on `dvmctl deploy`.");
  } else {
    json({
      status: opts.import ? "imported" : "generated",
      mnemonicFile: BUILDER_MNEMONIC_FILE,
      ...(backupFile
        ? {
            backupFile,
            hint: `The mnemonic this replaced was copied to ${backupFile} (mode 0600). Proofs locked to lock pubkeys derived from it are not spendable with the new mnemonic — re-run \`dvmctl deploy\` for every DVM, or restore with \`dvmctl lock create --import\` from the backup.`,
          }
        : {}),
    });
  }
}

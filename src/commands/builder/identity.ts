import { resolve } from "node:path";

import { DvmError, generateIdentity, writeIdentity } from "@dvmkit/sdk/internal";

import { loadIdentityPubkey } from "../../shared/builder-store.ts";
import { BUILDER_CONFIG_DIR, BUILDER_FILE, BUILDER_KEY_FILE } from "../../shared/defaults.ts";
import { info, json } from "../../shared/output.ts";

export interface IdentityCreateOptions {
  /**
   * Overwrite an existing identity. Existing DVM attestations need re-deploy
   * to refresh under the new key — flag is destructive.
   */
  force?: boolean;
  human?: boolean;
  /** Create without writing a second command result (used by deploy). */
  quiet?: boolean;
}

export interface IdentityShowOptions {
  human?: boolean;
}

/**
 * Generate a per-workstation secp256k1 identity keypair. Pubkey
 * lands at `~/.dvmkit/builder.json#identity_pubkey`; the matching secret at
 * `~/.dvmkit/builder.key` (mode 0600 on POSIX, best-effort on Windows).
 *
 * One identity signs deploy attestations for every DVM the operator
 * publishes — there is no per-DVM identity. `dvmctl deploy` errors with
 * `identity_required` until this has been run.
 */
export function identityCreate(opts: IdentityCreateOptions): void {
  const keypair = generateIdentity();
  writeIdentity(keypair, { force: opts.force });
  if (opts.quiet) return;
  const configDir = resolve(BUILDER_CONFIG_DIR);
  const isWindows = process.platform === "win32";
  if (opts.human) {
    info("Builder identity created.");
    info(`  pubkey: ${keypair.pubkey}`);
    info(`  secret stored at: ${BUILDER_KEY_FILE}`);
    info(`  builder directory: ${configDir} (DVMKIT_CONFIG_DIR; separate from authentication's DVMCTL_CONFIG_DIR)`);
    if (isWindows) {
      info("");
      info("⚠  Windows does not enforce Unix file permissions. Make sure");
      info(`   ${BUILDER_KEY_FILE} sits on disk-encrypted storage and is`);
      info("   not synced to shared/backup locations.");
    } else {
      info(`  mode: 0600 (POSIX)`);
    }
    info("");
    info("`dvmctl deploy` will now sign each deploy with this key. Run");
    info("`dvmctl identity show` to print the pubkey again later.");
  } else {
    json({
      status: "created",
      configDir,
      configDirEnv: "DVMKIT_CONFIG_DIR",
      identity_pubkey: keypair.pubkey,
      secret_path: BUILDER_KEY_FILE,
      pubkey_path: BUILDER_FILE,
      ...(isWindows
        ? {
            windows_note:
              "Windows does not enforce Unix file permissions; ensure the secret file lives on disk-encrypted storage.",
          }
        : { mode: "0600" }),
    });
  }
}

/**
 * Print the builder identity pubkey from `~/.dvmkit/builder.json`. Errors
 * with a structured hint when no identity exists yet.
 */
export function identityShow(opts: IdentityShowOptions): void {
  const pubkey = loadIdentityPubkey();
  if (!pubkey) {
    throw new DvmError(
      "identity_missing",
      "No builder identity exists.",
      `Checked ${resolve(BUILDER_CONFIG_DIR)} (DVMKIT_CONFIG_DIR; separate from authentication's DVMCTL_CONFIG_DIR). Run \`dvmctl identity create\` to generate one.`
    );
  }
  if (opts.human) {
    info(`identity_pubkey: ${pubkey}`);
    info(`stored at: ${BUILDER_FILE}`);
    info(`Builder directory: ${resolve(BUILDER_CONFIG_DIR)} (DVMKIT_CONFIG_DIR; separate from authentication's DVMCTL_CONFIG_DIR).`);
  } else {
    json({
      identity_pubkey: pubkey,
      pubkey_path: BUILDER_FILE,
      configDir: resolve(BUILDER_CONFIG_DIR),
      configDirEnv: "DVMKIT_CONFIG_DIR",
    });
  }
}

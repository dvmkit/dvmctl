import { resolve } from "node:path";

import {
  backupSecretFile,
  DvmError,
  generateIdentity,
  loadIdentitySecret,
  receiptPubkeyFromSecret,
  writeIdentity,
} from "@dvmkit/sdk/internal";

import { readIdentitySecret } from "../../lib/identity-secret-input.ts";
import { requireAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
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
  /** Skip the account-binding preflight (deploy targets that never contact the platform). */
  skipBindingCheck?: boolean;
}

export interface IdentityImportOptions {
  /** Read the secret from this file instead of stdin. */
  fromFile?: string;
  /** Replace a different existing identity (the old key is backed up first). */
  force?: boolean;
  human?: boolean;
}

export interface IdentityShowOptions {
  human?: boolean;
}

/**
 * Refuse to mint a signing key when the platform account is already bound to
 * one: the platform rejects deploy attestations signed by any other key, so a
 * freshly generated key can never match. Skipped silently when the check
 * cannot be made (not logged in, platform unreachable, or a platform that
 * predates `identity_pubkey`), so offline and self-host use keep working.
 */
export async function assertIdentityNotBoundElsewhere(): Promise<void> {
  let bound: string | null | undefined;
  try {
    const { token, platformUrl } = requireAuth();
    bound = (await platformClient.getAuthenticatedBuilderProfile(platformUrl, token)).identity_pubkey;
  } catch {
    return;
  }
  if (typeof bound !== "string" || bound === "") return;
  throw new DvmError(
    "identity_bound_elsewhere",
    `This account is already bound to a builder signing identity (${bound.slice(0, 8)}…). A newly created key would be rejected at deploy.`,
    "Bring the existing key to this machine with `dvmctl identity import` (secret on stdin or --from-file), then re-run."
  );
}

/**
 * Generate a per-account secp256k1 identity keypair. Pubkey
 * lands at `~/.dvmkit/builder.json#identity_pubkey`; the matching secret at
 * `~/.dvmkit/builder.key` (mode 0600 on POSIX, best-effort on Windows).
 *
 * One identity signs deploy attestations for every DVM the account
 * publishes — there is no per-DVM identity. `dvmctl deploy` errors with
 * `identity_required` until this has been run. On another machine use
 * `identity import` instead; this refuses when the account is already bound.
 */
export async function identityCreate(opts: IdentityCreateOptions): Promise<void> {
  if (!opts.skipBindingCheck) await assertIdentityNotBoundElsewhere();
  const keypair = generateIdentity();
  writeIdentity(keypair, { force: opts.force });
  if (opts.quiet) return;
  reportIdentity("created", keypair.pubkey, opts);
}

/**
 * Install the account's existing identity on this machine from its 32-byte hex
 * secret. The secret is read from stdin or a file, never from argv, and is
 * never printed.
 */
export async function identityImport(opts: IdentityImportOptions): Promise<void> {
  const secret = await readIdentitySecret({ fromFile: opts.fromFile });
  const pubkey = receiptPubkeyFromSecret(secret);
  const existing = loadIdentityPubkey();
  const sameIdentity = existing === pubkey;
  if (existing !== null && !sameIdentity && !opts.force) {
    throw new DvmError(
      "identity_exists",
      "A different builder identity already exists on this machine.",
      "Re-run with --force to replace it; the old key is backed up first. Any DVMs deployed under the old key need a re-deploy."
    );
  }
  let stored: string | null = null;
  try {
    stored = loadIdentitySecret();
  } catch {
    // A malformed key file is replaced below.
  }
  if (sameIdentity && stored === secret) {
    reportIdentity("unchanged", pubkey, opts);
    return;
  }
  const backupFile = backupSecretFile(BUILDER_KEY_FILE, secret + "\n");
  writeIdentity({ pubkey, secret }, { force: true });
  reportIdentity("imported", pubkey, opts, backupFile);
}

function reportIdentity(
  status: "created" | "imported" | "unchanged",
  pubkey: string,
  opts: { human?: boolean },
  backupFile: string | null = null
): void {
  const configDir = resolve(BUILDER_CONFIG_DIR);
  const isWindows = process.platform === "win32";
  if (opts.human) {
    info(`Builder identity ${status}.`);
    info(`  pubkey: ${pubkey}`);
    info(`  secret stored at: ${BUILDER_KEY_FILE}`);
    if (backupFile) info(`  previous key backed up to: ${backupFile}`);
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
      status,
      configDir,
      configDirEnv: "DVMKIT_CONFIG_DIR",
      identity_pubkey: pubkey,
      secret_path: BUILDER_KEY_FILE,
      pubkey_path: BUILDER_FILE,
      ...(backupFile ? { backup_file: backupFile } : {}),
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

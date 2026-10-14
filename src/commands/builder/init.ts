import { randomUUID } from "node:crypto";

import { DvmError } from "@dvmkit/sdk/internal";

import { findBuilderDvmsByHandle, upsertBuilderDvm } from "../../shared/builder-store.ts";
import { info, json } from "../../shared/output.ts";

export interface InitOptions {
  /**
   * Mark the DVM as self-hosted. Generates a local UUIDv4 as the
   * `canonical_dvm_id`. Required — platform-hosted DVMs get their
   * `canonical_dvm_id` from the platform at deploy time, so they don't need
   * to run `dvmctl init` at all.
   */
  selfHosted?: boolean;
  human?: boolean;
}

/**
 * Bootstrap a self-hosted DVM's local state. Generates a UUIDv4
 * `canonical_dvm_id` and persists it to `~/.dvmkit/builder.json` so the
 * builder's BIP-32 derivation has a stable identifier to hash even when no
 * platform-hosted `dvms.id` exists. Refuses to overwrite an existing entry
 * for the same handle so a typo can't silently retire keys.
 */
export function init(handle: string, opts: InitOptions): void {
  if (!opts.selfHosted) {
    throw new DvmError(
      "init_requires_self_hosted",
      "`dvmctl init` only applies to self-hosted DVMs.",
      "Platform-hosted DVMs get their canonical_dvm_id from the platform at deploy time. Re-run with --self-hosted if this DVM runs outside dvmkit infrastructure."
    );
  }
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(handle)) {
    throw new DvmError(
      "invalid_handle",
      `Handle "${handle}" is not a valid DVM slug.`,
      "Handles are 3-40 lowercase alphanumeric characters or hyphens."
    );
  }
  // Any entry for this handle blocks, not only a self-hosted one. A platform
  // deploy records the handle too, and initializing over it used to be
  // reachable — it mints a second canonical ID that then shadows the deployed
  // one on every by-handle lookup, orphaning every proof locked under the
  // first.
  const matches = findBuilderDvmsByHandle(handle);
  if (matches.length > 0) {
    const existing = matches[0];
    throw new DvmError(
      "already_initialized",
      existing.self_hosted
        ? `Handle "${handle}" is already initialized with canonical_dvm_id=${existing.canonical_dvm_id}.`
        : `Handle "${handle}" already belongs to a deployed DVM (canonical_dvm_id=${existing.canonical_dvm_id}).`,
      `Initializing over it would mint a second canonical_dvm_id for the same handle, and the Cashu lock keys derive from that ID — every proof already locked under ${matches
        .map((entry) => entry.canonical_dvm_id)
        .join(
          ", "
        )} would become underivable. If you genuinely want a new identity, melt or write off what is locked to the old one first, then remove that entry from ~/.dvmkit/builder.json by hand.`
    );
  }
  const canonicalDvmId = randomUUID();
  upsertBuilderDvm(canonicalDvmId, {
    handle,
    canonical_dvm_id: canonicalDvmId,
    current_rotation_index: 0,
    self_hosted: true,
  });

  if (opts.human) {
    info(`Initialized self-hosted DVM "${handle}".`);
    info(`  canonical_dvm_id: ${canonicalDvmId}`);
    info("  rotation_index:   0");
    info("");
    info("Advertise this canonical_dvm_id on /v1/info via the SDK's");
    info("DVMKIT_CANONICAL_DVM_ID env var (or DVMKIT_DVM_ID for compatibility).");
  } else {
    json({
      status: "initialized",
      handle,
      canonical_dvm_id: canonicalDvmId,
      current_rotation_index: 0,
      self_hosted: true,
    });
  }
}

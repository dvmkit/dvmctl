import { deriveBuilderLockKeypair, DvmError } from "@dvmkit/sdk/internal";

import { AdminApiError, AdminCashuClient } from "../../lib/admin-cashu-client.ts";
import { readBuilderMnemonic } from "../../lib/builder-mnemonic.ts";
import {
  type BuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../lib/cashu/builder-lock-identity.ts";
import { requireAuth, resolveAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import {
  type BuilderDvmEntry,
  patchBuilderDvm,
  requireSelectedBuilderDvm,
} from "../../shared/builder-store.ts";
import { info, json } from "../../shared/output.ts";
import { dvmUrlUnsetError } from "./dvm-url.ts";
import { type ResolvedDvm, resolveDvm } from "./resolve-dvm.ts";

export interface RotateOptions {
  /** SDK admin endpoint URL override. Skips the platform `getDvm` lookup
   *  and unconditionally targets the SDK admin route. Required for
   *  self-hosted DVMs. Only valid for container-runtime DVMs — isolate
   *  DVMs have no admin route at their URL. */
  endpoint?: string;
  syncPlatform?: boolean;
  human?: boolean;
  org?: string;
}

/** Post-rotation state surfaced to the human/JSON output. Shape matches both
 *  the SDK admin response and the platform isolate-rotation response. */
interface RotationResult {
  current: string;
  retired: { pubkey: string; retired_at_ms: number }[];
}

/**
 * Rotate the per-DVM lock keypair. Increments the rotation index in
 * `~/.dvmkit/builder.json`, derives the next BIP-32 child, asks the DVM (or
 * platform, for isolate-tier DVMs) to publish the new pubkey and demote the
 * prior one to retired.
 *
 * Two underlying surfaces are dispatched between based on `dvm.runtime`:
 *
 * * **Container DVMs** (and `--endpoint` overrides / self-hosted) — sign an
 *   admin challenge with the **current** privkey and POST to the SDK's
 *   `/admin/cashu/rotate-lock-pubkey` route. After the DVM acknowledges,
 *   syncs `dvms.lock_pubkey` on the platform so the next redeploy injects the
 *   rotated pubkey. A failed sync leaves a local pending marker for recovery.
 *
 * * **Isolate DVMs** — the isolate machine runs handler-only and
 *   has no admin route, so the CLI calls the platform-side
 *   `POST /api/v1/dvms/:dvmId/rotate-lock-pubkey` instead. Auth is the
 *   existing builder bearer; the platform writes both `dvm_lock_pubkeys`
 *   and attempts the `dvms.lock_pubkey` bookkeeping sync. A warning from that
 *   sync leaves the same local pending marker.
 */
export async function rotate(handle: string, opts: RotateOptions): Promise<void> {
  const mnemonic = readBuilderMnemonic();
  if (!mnemonic) {
    throw new DvmError(
      "no_builder_mnemonic",
      "No builder mnemonic found.",
      "Run `dvmctl lock create` first to generate or import a mnemonic."
    );
  }

  const selected = opts.endpoint ? undefined : await resolveDvm(handle, opts);
  let directKeyring: BuilderLockKeyring | undefined;
  let builderEntry: BuilderDvmEntry;
  if (selected) {
    builderEntry = requireSelectedBuilderDvm(selected.dvmId);
  } else {
    directKeyring = await resolveBuilderLockKeyringByHandle(handle, opts.endpoint);
    builderEntry = requireSelectedBuilderDvm(directKeyring.canonicalDvmId);
  }

  const currentIndex = builderEntry.current_rotation_index;
  const currentPubkey = deriveBuilderLockKeypair(
    mnemonic,
    builderEntry.canonical_dvm_id,
    currentIndex
  ).pubkey;
  if (opts.syncPlatform) {
    if (builderEntry.self_hosted || !builderEntry.pending_platform_lock_sync) {
      throw new DvmError(
        "no_pending_platform_lock_sync",
        `No pending platform lock-pubkey sync is recorded for "${handle}".`
      );
    }
    try {
      const { token, platformUrl } = requireAuth();
      await platformClient.setDvmLockPubkey(
        platformUrl,
        token,
        builderEntry.canonical_dvm_id,
        currentPubkey
      );
    } catch (err) {
      throw platformSyncFailure(handle, builderEntry, currentIndex, currentPubkey, err, opts);
    }
    patchBuilderDvm(builderEntry.canonical_dvm_id, { pending_platform_lock_sync: undefined });
    if (opts.human) {
      info(`Synchronized the platform lock pubkey for "${handle}" at rotation_index ${currentIndex}.`);
    } else {
      json({
        status: "platform_resynced",
        handle,
        dvmId: builderEntry.canonical_dvm_id,
        canonical_dvm_id: builderEntry.canonical_dvm_id,
        current_rotation_index: currentIndex,
        current_pubkey: currentPubkey,
      });
    }
    return;
  }

  if (builderEntry.pending_platform_lock_sync) {
    throw new DvmError(
      "platform_lock_sync_pending",
      `The DVM's rotation_index ${currentIndex} is saved locally, but platform lock-pubkey sync is pending.`,
      platformSyncHint(handle, opts),
      {
        dvm_id: builderEntry.canonical_dvm_id,
        current_rotation_index: currentIndex,
        current_pubkey: currentPubkey,
        platform_sync_pending: true,
      }
    );
  }

  const nextIndex = currentIndex + 1;
  const nextKeypair = deriveBuilderLockKeypair(mnemonic, builderEntry.canonical_dvm_id, nextIndex);

  const target = await resolveRotationTarget(
    handle,
    builderEntry.canonical_dvm_id,
    opts.endpoint,
    !!builderEntry.self_hosted,
    selected
  );

  let response: RotationResult;
  let resyncedFrom409 = false;
  let platformSyncWarning: string | undefined;

  if (target.kind === "platform-isolate") {
    // Isolate DVMs — platform owns both the receive path and the rotation
    // mutator. One round-trip writes `dvm_lock_pubkeys` (rotation + grace)
    // and attempts a best-effort `dvms.lock_pubkey` sync (deploy-time
    // injection). The accumulator write is atomic; a bookkeeping warning
    // requires the same sync-only recovery as the container path.
    try {
      const platformResponse = await platformClient.rotateDvmLockPubkey(
        target.platformUrl,
        target.token,
        builderEntry.canonical_dvm_id,
        nextKeypair.pubkey
      );
      response = { current: platformResponse.current, retired: platformResponse.retired };
      if (platformResponse.lock_pubkey_sync_warning) {
        platformSyncWarning = platformResponse.lock_pubkey_sync_warning;
      }
    } catch (err) {
      if (err instanceof DvmError && err.code === "no_op_rotation") {
        // Same recovery as the SDK-admin 409: the platform already published
        // the pubkey we were about to send, so heal `builder.json` rather
        // than wedge the operator on the same 409 forever.
        response = { current: nextKeypair.pubkey, retired: [] };
        resyncedFrom409 = true;
      } else {
        throw err;
      }
    }
    patchBuilderDvm(builderEntry.canonical_dvm_id, {
      current_rotation_index: nextIndex,
      ...(platformSyncWarning || resyncedFrom409 ? { pending_platform_lock_sync: true } : {}),
    });
    if (platformSyncWarning) {
      throw platformSyncFailure(
        handle,
        builderEntry,
        nextIndex,
        nextKeypair.pubkey,
        platformSyncWarning,
        opts
      );
    }
    if (resyncedFrom409) {
      try {
        await platformClient.setDvmLockPubkey(
          target.platformUrl,
          target.token,
          builderEntry.canonical_dvm_id,
          nextKeypair.pubkey
        );
      } catch (err) {
        throw platformSyncFailure(handle, builderEntry, nextIndex, nextKeypair.pubkey, err, opts);
      }
      patchBuilderDvm(builderEntry.canonical_dvm_id, { pending_platform_lock_sync: undefined });
    }
  } else {
    // Container or self-hosted — sign an admin challenge with the *current*
    // privkey. A retired-key holder must not be able to rotate the DVM back
    // into a state they control.
    const currentKeypair =
      directKeyring?.currentKeypair ??
      deriveBuilderLockKeypair(mnemonic, builderEntry.canonical_dvm_id, currentIndex);
    const client = new AdminCashuClient({
      endpoint: target.endpoint,
      dvmId: builderEntry.canonical_dvm_id,
      privkeyHex: currentKeypair.privkey,
    });

    try {
      response = await client.rotateLockPubkey({ new_pubkey: nextKeypair.pubkey });
    } catch (err) {
      if (err instanceof AdminApiError && err.isBadSignature) {
        throw new DvmError(
          "admin_bad_signature",
          "DVM admin endpoint rejected our signed challenge (bad_signature).",
          "The DVM's currently-published lock pubkey does not match the privkey derived from this mnemonic + current rotation_index. Confirm `~/.dvmkit/builder.json` is in sync with the DVM."
        );
      }
      if (err instanceof AdminApiError && err.status === 409) {
        // Preserve the no-op resync for servers that return 409. The current
        // SDK verifies the signer first, so a stale key normally receives 401
        // and cannot use this branch to recover an accepted rotation.
        // The 409 body has no post-rotation `{current, retired}`.
        response = { current: nextKeypair.pubkey, retired: [] };
        resyncedFrom409 = true;
      } else {
        throw err;
      }
    }

    if (builderEntry.self_hosted) {
      patchBuilderDvm(builderEntry.canonical_dvm_id, { current_rotation_index: nextIndex });
    } else {
      patchBuilderDvm(builderEntry.canonical_dvm_id, {
        current_rotation_index: nextIndex,
        pending_platform_lock_sync: true,
      });
      try {
        const { token, platformUrl } = requireAuth();
        await platformClient.setDvmLockPubkey(
          platformUrl,
          token,
          builderEntry.canonical_dvm_id,
          nextKeypair.pubkey
        );
      } catch (err) {
        throw platformSyncFailure(handle, builderEntry, nextIndex, nextKeypair.pubkey, err, opts);
      }
      patchBuilderDvm(builderEntry.canonical_dvm_id, { pending_platform_lock_sync: undefined });
    }
  }

  if (opts.human) {
    info(
      resyncedFrom409
        ? `Resynced builder.json — DVM was already at rotation_index ${nextIndex} (prior rotate landed without bumping the local index).`
        : `Rotated lock pubkey for "${handle}".`
    );
    info(`  rotation_index: ${currentIndex} → ${nextIndex}`);
    info(`  new pubkey:     ${response.current}`);
    if (response.retired.length > 0) {
      info(`  retired pubkeys in grace window:`);
      for (const r of response.retired) {
        info(`    ${r.pubkey}  (retired ${new Date(r.retired_at_ms).toISOString()})`);
      }
    }
  } else {
    json({
      status: resyncedFrom409 ? "resynced" : "rotated",
      handle,
      dvmId: builderEntry.canonical_dvm_id,
      slug: handle,
      canonical_dvm_id: builderEntry.canonical_dvm_id,
      previous_rotation_index: currentIndex,
      current_rotation_index: nextIndex,
      current_pubkey: response.current,
      retired: response.retired,
    });
  }
}

function platformSyncHint(handle: string, opts: RotateOptions): string {
  const org = opts.org ? ` --org ${opts.org}` : "";
  return `After restoring platform auth, run \`dvmctl rotate ${handle} --sync-platform${org}\` before the next deploy. This updates the platform record without rotating the DVM again.`;
}

function platformSyncFailure(
  handle: string,
  entry: BuilderDvmEntry,
  index: number,
  pubkey: string,
  cause: unknown,
  opts: RotateOptions
): DvmError {
  return new DvmError(
    "platform_lock_sync_failed",
    `The DVM accepted rotation_index ${index} and builder.json saved it, but platform lock-pubkey sync was not confirmed: ${cause instanceof Error ? cause.message : String(cause)}`,
    platformSyncHint(handle, opts),
    {
      dvm_id: entry.canonical_dvm_id,
      current_rotation_index: index,
      current_pubkey: pubkey,
      platform_sync_pending: true,
    }
  );
}

/**
 * Resolves which surface a rotation call should target. Three outcomes:
 *
 * 1. `--endpoint` override or self-hosted → SDK admin path against the
 *    supplied URL. (Self-hosted without `--endpoint` errors out; isolate
 *    DVMs reached via `--endpoint` are operator error and will fail at the
 *    admin-client step.)
 * 2. Cloud isolate DVM → platform-side rotation endpoint with builder bearer.
 * 3. Cloud container DVM → SDK admin path against `dvm.url`.
 */
type RotationTarget =
  | { kind: "sdk-admin"; endpoint: string }
  | { kind: "platform-isolate"; platformUrl: string; token: string };

async function resolveRotationTarget(
  handle: string,
  dvmId: string,
  override: string | undefined,
  selfHosted: boolean,
  selected?: ResolvedDvm
): Promise<RotationTarget> {
  if (override) {
    return { kind: "sdk-admin", endpoint: override.replace(/\/+$/, "") };
  }
  if (selfHosted) {
    throw new DvmError(
      "endpoint_required",
      `Self-hosted DVM "${handle}" needs an explicit \`--endpoint <url>\`.`,
      "Platform lookup is skipped for self-hosted DVMs — pass the DVM's public URL."
    );
  }
  if (!resolveAuth()) {
    throw new DvmError(
      "auth_required",
      "Not authenticated.",
      "Set DVMKIT_API_KEY or run `dvmctl auth` so the CLI can resolve the DVM endpoint via the platform."
    );
  }
  const { token, platformUrl } = selected ?? requireAuth();
  const { dvm } = await platformClient.getDvm(platformUrl, token, dvmId);
  if (dvm.runtime === "isolate") {
    return { kind: "platform-isolate", platformUrl, token };
  }
  if (!dvm.url) {
    throw dvmUrlUnsetError(handle, dvm);
  }
  return { kind: "sdk-admin", endpoint: dvm.url.replace(/\/+$/, "") };
}

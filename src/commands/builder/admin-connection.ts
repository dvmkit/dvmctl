// Builder-owned authenticated connection to a DVM's self-admin surface.
import { DvmError, providerProseSources } from "@dvmkit/sdk/internal";

import {
  AdminApiError,
  AdminCashuClient,
  rethrowIfBadSignature,
} from "../../lib/admin-cashu-client.ts";
import {
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../lib/cashu/builder-lock-identity.ts";
import { requireAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { dvmUrlUnsetError } from "./dvm-url.ts";
import { type ResolvedDvm, resolveDvm } from "./resolve-dvm.ts";

/** A signed admin client bound to one immutable DVM ID. */
export interface AdminConnection {
  client: AdminCashuClient;
  dvmId: string;
}

/** The two flags every `dvmctl credit` verb takes to reach a DVM's admin surface. */
export interface AdminConnectionOptions {
  /** DVM admin endpoint URL override; skips the platform `getDvm` lookup. */
  endpoint?: string;
  org?: string;
}

/**
 * Build an authenticated admin client for `handle` — the lock privkey is
 * derived locally from the builder mnemonic and never leaves this process.
 */
export async function connectAdmin(
  handle: string,
  opts: AdminConnectionOptions
): Promise<AdminConnection> {
  const selected = opts.endpoint ? undefined : await resolveDvm(handle, opts);
  const { canonicalDvmId, currentKeypair } = selected
    ? resolveBuilderLockKeyring(selected.dvmId)
    : await resolveBuilderLockKeyringByHandle(handle, opts.endpoint);
  return {
    client: new AdminCashuClient({
      endpoint: await resolveAdminEndpoint(handle, opts.endpoint, selected),
      dvmId: canonicalDvmId,
      privkeyHex: currentKeypair.privkey,
    }),
    dvmId: canonicalDvmId,
  };
}

/**
 * Run one admin call, translating the DVM's structured refusals for the CLI.
 *
 * A `401 bad_signature` means this mnemonic cannot derive the lock pubkey the
 * DVM advertises — never transient, never self-healing — so it must not reach
 * the ordinary refusal surface. Preserve every other `AdminApiError`
 * as a `DvmError`, with its operator copy explicitly provider-marked instead
 * of letting the generic boundary redact it as an unknown dependency failure.
 */
export async function adminCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrowIfBadSignature(err);
    if (err instanceof AdminApiError) {
      throw new DvmError(
        err.body.error,
        err.body.message ?? err.message,
        err.body.hint,
        {
          http_status: err.status,
          ...(err.body.reason ? { reason: err.body.reason } : {}),
        },
        err.body.display,
        providerProseSources(err.body, { message: err.message })
      );
    }
    throw err;
  }
}

async function resolveAdminEndpoint(
  handle: string,
  override: string | undefined,
  selected?: ResolvedDvm
): Promise<string> {
  if (override) return override.replace(/\/+$/, "");
  const { token, platformUrl } = selected ?? requireAuth();
  const { dvm } = await platformClient.getDvm(platformUrl, token, selected?.dvmId ?? handle);
  if (!dvm.url) {
    throw dvmUrlUnsetError(handle, dvm);
  }
  return dvm.url.replace(/\/+$/, "");
}

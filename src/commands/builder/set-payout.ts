// Builder-owned payout configuration surface shipped with dvmctl.
import { DvmError, validateLnAddress } from "@dvmkit/sdk/internal";

import {
  patchBuilderDvm,
  requireBuilderDvmByHandle,
  requireSelectedBuilderDvm,
} from "../../shared/builder-store.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface SetPayoutOptions {
  human?: boolean;
  org?: string;
  /** Target a `dvmctl init --self-hosted` entry instead of resolving a platform DVM. */
  selfHosted?: boolean;
  /** Skip the LNURL-pay pre-flight check. Useful when the provider is
   *  temporarily down but the operator knows the address is correct. */
  skipPreflight?: boolean;
}

/**
 * Persist a default payout LN address for `<handle>` into
 * `~/.dvmkit/builder.json`. `dvmctl melt-pending` reads this when no
 * `--payout` flag is supplied. Pre-flights the LNURL-pay metadata endpoint
 * by default so typos surface immediately.
 */
export async function setPayout(
  handle: string,
  lnAddress: string,
  opts: SetPayoutOptions
): Promise<void> {
  if (opts.selfHosted && opts.org) {
    throw new DvmError(
      "invalid_scope",
      "--self-hosted cannot be combined with --org.",
      "Use --self-hosted for the local DVM created by `dvmctl init`, or omit it to select a platform DVM with --org."
    );
  }
  const selected = opts.selfHosted ? undefined : await resolveDvm(handle, opts);
  const existing = selected
    ? requireSelectedBuilderDvm(selected.dvmId)
    : requireBuilderDvmByHandle(handle);
  const dvmId = selected?.dvmId ?? existing.canonical_dvm_id;

  if (!opts.skipPreflight) {
    await validateLnAddress(lnAddress);
  }

  patchBuilderDvm(dvmId, { payout_ln_address: lnAddress });

  if (opts.human) {
    info(`Payout address for "${handle}" set to ${lnAddress}.`);
    info(
      "\n`dvmctl melt-pending " +
        handle +
        "` now melts to this address by default. Override per-run with `--payout <addr>`."
    );
  } else {
    json({
      status: "set",
      handle,
      dvmId,
      slug: handle,
      payout_ln_address: lnAddress,
    });
  }
}

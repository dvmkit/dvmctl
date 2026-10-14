import { DvmError } from "@dvmkit/sdk/internal";

const trimSlash = (u: string): string => u.replace(/\/+$/, "");

/**
 * The platform `url` when it names an address other than the public router
 * one. A cloud DVM's `url` is its router address, so it returns null there; a
 * connect-tier DVM's `url` is its upstream, which is worth showing.
 */
export function distinctUpstream(url: string | null, dvmkitUrl: string | null): string | null {
  if (!url) return null;
  if (dvmkitUrl && trimSlash(url) === trimSlash(dvmkitUrl)) return null;
  return url;
}

/**
 * The `dvm_url_unset` error for a DVM whose platform `url` is null. A cloud DVM
 * (no connect-tier `endpointUrl`) is only addressed through the router, so a
 * missing handle is the cause rather than an unfinished deploy.
 */
export function dvmUrlUnsetError(
  handle: string,
  dvm: { endpointUrl?: string | null; dvmkitUrl?: string | null }
): DvmError {
  const hint =
    !dvm.endpointUrl && !dvm.dvmkitUrl
      ? "Its owner has no handle, so the router can't address it. Claim one with `dvmctl handle set <handle>`, or pass `--endpoint <url>`."
      : "If the DVM is still deploying, wait for the deploy to finish. Otherwise pass `--endpoint <url>` (e.g. for self-hosted DVMs).";
  return new DvmError("dvm_url_unset", `DVM "${handle}" has no platform URL yet.`, hint);
}

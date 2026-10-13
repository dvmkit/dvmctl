import { DvmError } from "@dvmkit/sdk/internal";

import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { scopeLabel } from "../../lib/platform-client.ts";

/** A DVM selected by bare slug within the caller's active org scope. */
export interface ResolvedDvm {
  dvmId: string;
  dvmkitUrl: string | null;
  platformUrl: string;
  token: string;
}

/**
 * Resolve a command's bare DVM slug inside its selected org context.
 *
 * The list route resolves the selected org and enforces membership. Resource
 * routes then receive the immutable DVM ID, so a slug can never select a DVM
 * from another org or change meaning after a transfer.
 */
export async function resolveDvm(slug: string, opts: { org?: string } = {}): Promise<ResolvedDvm> {
  const { token, platformUrl } = requireAuth();
  const { dvms, org } = await platformClient.listDvms(platformUrl, token, {
    org: resolveOrgScope(opts),
  });
  const dvm = dvms.find((candidate) => candidate.slug === slug);
  if (!dvm) {
    throw new DvmError(
      "not_found",
      `DVM "${slug}" not found in ${scopeLabel(org)}.`,
      "Run `dvmctl list` to see the DVMs available in this context."
    );
  }
  return { dvmId: dvm.id, dvmkitUrl: dvm.dvmkitUrl, platformUrl, token };
}

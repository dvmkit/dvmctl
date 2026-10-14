import { DvmError } from "@dvmkit/sdk/internal";

import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface TransferOptions {
  createOrg?: boolean;
  displayName?: string;
  human?: boolean;
  org?: string;
}

/**
 * Transfer a DVM to an existing org (by handle) or back to personal.
 * With `--create-org`, creates the target org atomically as part of the transfer.
 */
export async function transfer(slug: string, to: string, opts: TransferOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  const body: platformClient.TransferBody = opts.createOrg
    ? { to: { create: { handle: to, displayName: opts.displayName } } }
    : { to };

  const result = await platformClient.transferDvm(platformUrl, token, dvmId, body);

  if (result.status === "noop") {
    throw new DvmError("noop", `DVM "${slug}" is already in the target destination.`);
  }

  if (opts.human) {
    if (result.org) {
      info(`Created org "${result.org.handle}" and transferred ${slug} into it.`);
    } else {
      info(`Transferred ${slug} → ${result.to}`);
    }
    if (result.treasuryRekeyPending) {
      info(
        "Warning: Treasury re-key pending — redeploy the DVM (`dvmctl deploy`) to update the Cashu lock pubkey under the new org."
      );
    }
  } else {
    json({ ...result, dvmId, slug });
  }
}

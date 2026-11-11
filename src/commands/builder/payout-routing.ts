import { DvmError } from "@dvmkit/sdk/internal";

import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface PayoutRoutingOptions {
  cashu?: string;
  tempo?: string;
  base?: string;
  org?: string;
  human?: boolean;
}

export async function payoutRouting(slug: string, opts: PayoutRoutingOptions): Promise<void> {
  const preferences: Partial<platformClient.DvmPayoutPreferences> = {};
  for (const rail of ["cashu", "tempo", "base"] as const) {
    const value = opts[rail];
    if (value === undefined) continue;
    if (value !== "true" && value !== "false" && value !== "null") {
      throw new DvmError(
        "bad_request",
        `Invalid --${rail} value: "${value}".`,
        `Use --${rail} true, --${rail} false, or --${rail} null.`
      );
    }
    preferences[`accept_${rail}`] = value === "null" ? null : value === "true";
  }

  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const result = Object.keys(preferences).length > 0
    ? await platformClient.setDvmPayoutRouting(platformUrl, token, dvmId, preferences)
    : await platformClient.getDvmPayoutRouting(platformUrl, token, dvmId);

  if (opts.human) {
    info(`Stored payout routing for "${slug}": Cashu=${result.accept_cashu}, Tempo=${result.accept_tempo}, Base=${result.accept_base}.`);
    info("Preferences apply at the next deploy; the running service is unchanged. False declines a rail; true and null inherit account settings and cannot override an account disable.");
  } else {
    json(result);
  }
}

import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface SecretsListOptions {
  human?: boolean;
  org?: string;
}

/**
 * List a DVM's builder-configured secrets — names + last-applied timestamps,
 * never values. Lets builders verify a secret was applied without exposing it
 * over the wire. Platform-injected keys (PLATFORM_*, DVMKIT_*, FLY_*, …) are
 * filtered out by the platform; you only see the secrets you set.
 */
export async function secretsList(slug: string, opts: SecretsListOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const secrets = await platformClient.listSecrets(platformUrl, token, dvmId);

  if (opts.human) {
    if (secrets.length === 0) {
      info("No secrets set.");
    } else {
      for (const s of secrets) {
        info(`  ${s.name}  (applied ${s.last_applied_at})`);
      }
    }
  } else {
    json({ dvmId, slug, secrets });
  }
}

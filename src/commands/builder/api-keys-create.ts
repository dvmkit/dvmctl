import { requireAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface ApiKeysCreateOptions {
  label?: string;
  human?: boolean;
}

export async function apiKeysCreate(opts: ApiKeysCreateOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const result = await platformClient.createApiKey(platformUrl, token, { label: opts.label });

  if (opts.human) {
    info("  API key created.");
    info("");
    info(`  Key:     ${result.key}`);
    info(`  ID:      ${result.id}`);
    info(`  Label:   ${result.label}`);
    info("");
    info("  Save this key now — it will not be shown again.");
  } else {
    json(result);
  }
}

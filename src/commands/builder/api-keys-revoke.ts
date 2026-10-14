import { requireAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface ApiKeysRevokeOptions {
  human?: boolean;
}

export async function apiKeysRevoke(id: string, opts: ApiKeysRevokeOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  await platformClient.deleteApiKey(platformUrl, token, id);

  if (opts.human) {
    info(`  API key ${id} revoked.`);
  } else {
    json({ deleted: true, id });
  }
}

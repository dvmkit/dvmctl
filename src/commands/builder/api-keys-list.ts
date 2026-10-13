import { requireAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface ApiKeysListOptions {
  human?: boolean;
}

export async function apiKeysList(opts: ApiKeysListOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const result = await platformClient.listApiKeys(platformUrl, token);

  if (opts.human) {
    if (result.keys.length === 0) {
      info("  No API keys.");
      return;
    }
    info(`  ${result.count}/${result.limit} keys used`);
    info("");
    const idW = Math.max(2, ...result.keys.map((k) => k.id.length));
    const labelW = Math.max(5, ...result.keys.map((k) => (k.label ?? "—").length));
    info(
      `  ${"ID".padEnd(idW)}  ${"LABEL".padEnd(labelW)}  ${"PREFIX".padEnd(10)}  ${"CREATED".padEnd(19)}  LAST USED`
    );
    for (const k of result.keys) {
      const prefix = k.key_prefix ? `${k.key_prefix}...` : "—";
      const created = fmtDate(k.created_at);
      const lastUsed = k.last_used_at ? fmtDate(k.last_used_at) : "never";
      info(
        `  ${k.id.padEnd(idW)}  ${(k.label ?? "—").padEnd(labelW)}  ${prefix.padEnd(10)}  ${created.padEnd(19)}  ${lastUsed}`
      );
    }
  } else {
    json(result);
  }
}

function fmtDate(epoch: number): string {
  return new Date(epoch)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

import { DvmError } from "@dvmkit/sdk/internal";

import { resolveAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

/** Set the builder's handle for *.dvmkit.ai subdomains. */
export async function handle(h: string, opts: { human?: boolean }): Promise<void> {
  const creds = resolveAuth();
  if (!creds) {
    throw new DvmError(
      "auth_required",
      "Not authenticated.",
      "Set DVMKIT_API_KEY or run `dvmctl auth`."
    );
  }

  const platformUrl = process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev";

  await platformClient.setHandle(platformUrl, creds.token, h);

  if (opts.human) {
    info(`Handle set to "${h}". Your DVMs will be accessible at ${h}--<slug>.dvmkit.ai`);
  } else {
    json({ status: "ok", handle: h });
  }
}

export async function handleCheck(h: string, opts: { human?: boolean }): Promise<void> {
  const platformUrl = process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev";
  const result = await platformClient.checkHandle(platformUrl, h);

  if (opts.human) {
    info(result.available ? `"${h}" is available.` : `"${h}" is taken.`);
  } else {
    json({ handle: h, available: result.available });
  }
}

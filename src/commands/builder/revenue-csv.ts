import { writeFileSync } from "node:fs";

import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info } from "../../shared/output.ts";

export interface RevenueCsvOptions {
  from: string;
  to: string;
  currency?: string;
  rail?: string;
  out?: string;
  /** Org handle to read as, overriding the `dvmctl switch` context. */
  org?: string;
}

export async function revenueCsv(opts: RevenueCsvOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const { csv, org } = await platformClient.getRevenueCsv(platformUrl, token, {
    from: opts.from,
    to: opts.to,
    currency: opts.currency,
    rail: opts.rail,
    org: resolveOrgScope(opts),
  });

  // The scope line goes to stderr, so an export piped to a file or another
  // process still says which org it came from without polluting the CSV.
  info(`  Org: ${org}`);
  if (opts.out) {
    writeFileSync(opts.out, csv, "utf-8");
    info(`  CSV written to ${opts.out}`);
  } else {
    process.stdout.write(csv);
  }
}

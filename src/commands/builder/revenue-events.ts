import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { scopeLabel } from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface RevenueEventsOptions {
  from?: string;
  to?: string;
  rail?: string;
  limit?: string;
  human?: boolean;
  /** Org handle to read as, overriding the `dvmctl switch` context. */
  org?: string;
}

export async function revenueEvents(opts: RevenueEventsOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const result = await platformClient.getRevenueEvents(platformUrl, token, {
    from: opts.from,
    to: opts.to,
    rail: opts.rail,
    limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
    org: resolveOrgScope(opts),
  });

  if (opts.human) {
    info(`  Org: ${scopeLabel(result.org)}`);
    if (result.events.length === 0) {
      info(`  No revenue events found for ${scopeLabel(result.org)}.`);
      return;
    }
    info(`  ${result.total} total events (showing ${result.events.length})`);
    info("");
    const dateW = 10;
    const railW = Math.max(4, ...result.events.map((e) => e.rail.length));
    const typeW = Math.max(4, ...result.events.map((e) => e.source_type.length));
    const slugW = Math.max(3, ...result.events.map((e) => e.dvm_slug.length));
    info(
      `  ${"DATE".padEnd(dateW)}  ${"RAIL".padEnd(railW)}  ${"TYPE".padEnd(typeW)}  ${"DVM".padEnd(slugW)}  ${"AMOUNT".padStart(12)}  DESCRIPTION`
    );
    for (const e of result.events) {
      const cur = e.fiat_currency.toUpperCase();
      info(
        `  ${e.date.padEnd(dateW)}  ${e.rail.padEnd(railW)}  ${e.source_type.padEnd(typeW)}  ${e.dvm_slug.padEnd(slugW)}  ${formatMinor(e.net_fiat_minor, cur).padStart(12)}  ${e.line_description}`
      );
    }
  } else {
    json(result);
  }
}

function formatMinor(minor: number, currency: string): string {
  const major = (minor / 100).toFixed(2);
  const symbols: Record<string, string> = { GBP: "£", EUR: "€", USD: "$", CHF: "CHF " };
  const sym = symbols[currency] ?? `${currency} `;
  return `${sym}${major}`;
}

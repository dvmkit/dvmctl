import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { scopeLabel } from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface RevenueSummaryOptions {
  from: string;
  to: string;
  currency?: string;
  human?: boolean;
  /** Org handle to read as, overriding the `dvmctl switch` context. */
  org?: string;
}

export async function revenueSummary(opts: RevenueSummaryOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const result = await platformClient.getRevenueSeries(platformUrl, token, {
    from: opts.from,
    to: opts.to,
    currency: opts.currency,
    org: resolveOrgScope(opts),
  });

  if (opts.human) {
    const s = result.summary;
    const cur = s.fiat_currency.toUpperCase();
    info(`  Revenue summary for ${scopeLabel(result.org)} (${s.period.from} to ${s.period.to})`);
    info("");
    info(`  Total:  ${formatMinor(s.total_gross_fiat_minor, cur)}  (${s.total_count} events)`);
    info("");

    if (s.by_source_type_rail.length > 0) {
      const typeW = Math.max(4, ...s.by_source_type_rail.map((r) => r.source_type.length));
      const railW = Math.max(4, ...s.by_source_type_rail.map((r) => r.rail.length));
      info(`  ${"TYPE".padEnd(typeW)}  ${"RAIL".padEnd(railW)}  ${"AMOUNT".padStart(12)}  COUNT`);
      for (const row of s.by_source_type_rail) {
        info(
          `  ${row.source_type.padEnd(typeW)}  ${row.rail.padEnd(railW)}  ${formatMinor(row.gross_fiat_minor, cur).padStart(12)}  ${row.count}`
        );
      }
    }

    if (s.cross_rate_note) {
      info("");
      info(`  Note: ${s.cross_rate_note}`);
    }

    for (const w of result.stale_fx_warnings) {
      info(`  ! ${w}`);
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

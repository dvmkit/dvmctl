import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { distinctUpstream } from "./dvm-url.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface InfoOptions {
  human?: boolean;
  org?: string;
}

export async function dvmInfo(slug: string, opts: InfoOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const { dvm, deploys, domains } = await platformClient.getDvm(platformUrl, token, dvmId);

  if (opts.human) {
    // A suspended DVM reads very differently depending on who put it down:
    // "paused" is the builder's own `dvmctl pause` and "idle" is the platform
    // parking a quiet free-tier DVM — `dvmctl resume` lifts both. Anything else
    // came from the platform and they can't lift it themselves. A platform
    // suspension and a pause can be true at once — the suspension takes
    // precedence but doesn't erase the pause — in which case the platform's
    // reason is what they need to act on.
    const suspension =
      dvm.status === "suspended"
        ? dvm.suspensionReason === "builder_pause"
          ? " (paused — run `dvmctl resume` to bring it back)"
          : dvm.suspensionReason === "free_tier_idle"
            ? " (idle — run `dvmctl resume` to bring it back)"
            : ` (${dvm.suspensionReason ?? "suspended by the operator"}${
                dvm.pausedAt != null ? "; you had also paused it" : ""
              })`
        : "";

    info(`  Name:       ${dvm.name}`);
    info(`  Slug:       ${dvm.slug}`);
    // Which org owns it. `dvmctl info` resolves the bare slug only in the
    // selected context, so this confirms the org that supplied the result.
    info(`  Org:        ${dvm.orgHandle ?? "personal"}`);
    info(`  Status:     ${dvm.status}${suspension}`);
    // The address callers use. Absent until the builder claims a handle — the
    // router has nothing to resolve without one, so `dvmctl handle set` is the
    // next action, not a missing deploy.
    info(
      `  Public URL: ${dvm.dvmkitUrl ?? "— (set a handle with `dvmctl handle set <handle>` to get one)"}`
    );
    // A cloud DVM's `url` is this same router address; only a connect-tier
    // upstream is a second address worth printing.
    const upstream = distinctUpstream(dvm.url, dvm.dvmkitUrl);
    if (upstream) info(`  Upstream:   ${upstream}`);
    info(`  Region:     ${dvm.region}`);
    info(`  Created:    ${fmtDate(dvm.createdAt)}`);
    info(`  Updated:    ${fmtDate(dvm.updatedAt)}`);

    if (deploys.length > 0) {
      info("");
      info("  Recent deploys:");
      for (const d of deploys.slice(0, 5)) {
        const duration = d.endedAt ? ` (${fmtDuration(d.endedAt - d.startedAt)})` : "";
        info(`    #${d.id.slice(0, 8)}  ${d.status}  ${fmtDate(d.startedAt)}${duration}`);
      }
    }

    if (domains.length > 0) {
      info("");
      info("  Domains:");
      for (const d of domains) {
        info(`    ${d.domain}  ${d.status}`);
      }
    }
  } else {
    json({ dvmId, slug, dvm, deploys, domains });
  }
}

function fmtDate(epoch: number): string {
  return new Date(epoch)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

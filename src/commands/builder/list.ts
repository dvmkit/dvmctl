import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { scopeLabel } from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface ListOptions {
  human?: boolean;
  org?: string;
}

export async function list(opts: ListOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const { dvms, org } = await platformClient.listDvms(platformUrl, token, {
    org: resolveOrgScope(opts),
  });

  if (opts.human) {
    info(`Org: ${scopeLabel(org)}`);
    if (dvms.length === 0) {
      info(`No DVMs found in ${scopeLabel(org)}.`);
      return;
    }
    const slugW = Math.max(4, ...dvms.map((d) => d.slug.length));
    const nameW = Math.max(4, ...dvms.map((d) => d.name.length));
    const statusW = Math.max(6, ...dvms.map((d) => d.status.length));
    const regionW = Math.max(6, ...dvms.map((d) => d.region.length));
    const header = `  ${"SLUG".padEnd(slugW)}  ${"NAME".padEnd(nameW)}  ${"STATUS".padEnd(statusW)}  ${"REGION".padEnd(regionW)}  URL`;
    info(header);
    for (const d of dvms) {
      // The public address, not the Fly origin — that's what a builder came to
      // read. The scope is a single org, so `dvmkitUrl` is set on all of these
      // rows or none: the column never mixes the two kinds of URL. It falls
      // back to the origin only for a handle-less owner, who has no public
      // address yet (`dvmctl info` names the fix).
      const url = d.dvmkitUrl ?? d.url ?? "—";
      info(
        `  ${d.slug.padEnd(slugW)}  ${d.name.padEnd(nameW)}  ${d.status.padEnd(statusW)}  ${d.region.padEnd(regionW)}  ${url}`
      );
    }
  } else {
    json({ dvms, org });
  }
}

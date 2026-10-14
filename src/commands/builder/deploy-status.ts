import { requireAuth } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { distinctUpstream } from "./dvm-url.ts";

export interface DeployStatusOptions {
  human?: boolean;
}

/**
 * Show the current status of a deploy by ID — the recovery handle for
 * `dvmctl deploy`. When the deploy SSE drops or the operator kills
 * the CLI mid-build, the `Deploy queued: <id>` line printed up front lets the
 * next invocation resume from this command.
 */
export async function deployStatus(deployId: string, opts: DeployStatusOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const { deploy, dvm, recovery } = await platformClient.getDeployStatus(
    platformUrl,
    token,
    deployId
  );

  if (opts.human) {
    info(`  Deploy:   ${deploy.id}`);
    info(`  Status:   ${deploy.status}`);
    info(`  Slug:     ${dvm.slug}`);
    info(`  Public:   ${dvm.dvmkitUrl ?? "—"}`);
    const upstream = distinctUpstream(dvm.url, dvm.dvmkitUrl);
    if (upstream) info(`  Upstream: ${upstream}`);
    info(`  Started:  ${fmtDate(deploy.startedAt)}`);
    if (deploy.endedAt) info(`  Ended:    ${fmtDate(deploy.endedAt)}`);
    if (deploy.error) info(`  Error:    ${deploy.error}`);
    if (recovery) {
      info(`  Recovery: ${recovery.status} (${recovery.deployId})`);
      if (recovery.error) info(`  Recovery error: ${recovery.error}`);
    }
  } else {
    json({
      status: deploy.status,
      url: dvm.url,
      dvmkitUrl: dvm.dvmkitUrl,
      slug: dvm.slug,
      dvmId: deploy.dvmId,
      deployId: deploy.id,
      startedAt: deploy.startedAt,
      endedAt: deploy.endedAt,
      error: deploy.error,
      ...(deploy.releaseAcceptedAt != null ? { releaseAccepted: true } : {}),
      ...(recovery ? { recovery } : {}),
    });
  }
}

function fmtDate(epoch: number): string {
  return new Date(epoch)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

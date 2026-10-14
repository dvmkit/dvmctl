import * as platformClient from "../../lib/platform-client.ts";
import { info, json, progress } from "../../shared/output.ts";
import { fmtElapsed } from "./deploy.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface RollbackOptions {
  /** Roll back to a specific `deploy_id` instead of the previous deploy. */
  to?: string;
  human?: boolean;
  org?: string;
}

/**
 * Roll a deployed DVM back to a previous successful deploy's image.
 * Without `--to`, targets the previous deploy; `--to <deploy-id>` picks a
 * specific one. The platform redeploys the recorded image asynchronously; this
 * streams the deploy logs to completion, mirroring `dvmctl deploy`.
 */
export async function rollback(slug: string, opts: RollbackOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  const { deployId, rolledBackTo } = await platformClient.rollbackDvm(platformUrl, token, dvmId, {
    to: opts.to,
  });

  if (opts.human) {
    info(`Rolling back ${slug} to deploy ${rolledBackTo}...`);
    info(`  Deploy queued: ${deployId}`);
  } else {
    progress({ event: "queued", deploy_id: deployId, rolled_back_to: rolledBackTo });
  }

  const result = await platformClient.streamDeployLogs(platformUrl, token, deployId, {
    onLog: (line) => {
      if (opts.human) info(`  ${line}`);
      else progress({ event: "log", line });
    },
    onPhase: ({ status, elapsedMs }) => {
      if (opts.human) info(`  ${status}... (${fmtElapsed(elapsedMs)})`);
      else progress({ event: "phase", phase: status, elapsed_ms: elapsedMs });
    },
  });

  if (opts.human) {
    info(`\n  Rolled back to ${result.url}`);
    if (result.dvmkitUrl) info(`  Public URL: ${result.dvmkitUrl}`);
    info("");
  } else {
    json({
      status: "deployed",
      url: result.url,
      dvmkitUrl: result.dvmkitUrl,
      slug,
      dvmId,
      deployId,
      rolledBackTo,
    });
  }
}

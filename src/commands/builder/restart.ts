import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface RestartOptions {
  machine?: string;
  human?: boolean;
  org?: string;
}

/**
 * Restart a deployed DVM's Fly machines without a redeploy, mediated by the
 * platform (no flyctl required builder-side). Restarts all running machines by
 * default, or a single machine with `--machine <id>`. Reports each machine's
 * post-restart state.
 */
export async function restart(slug: string, opts: RestartOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  const result = await platformClient.restartMachines(platformUrl, token, dvmId, {
    machine: opts.machine,
  });

  if (opts.human) {
    for (const m of result.machines) {
      info(`${m.id}: ${m.state}`);
    }
    info(`Restarted ${result.restarted} machine${result.restarted === 1 ? "" : "s"}.`);
  } else {
    json({ ...result, dvmId, slug });
  }
}

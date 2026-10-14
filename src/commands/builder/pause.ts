import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface PauseOptions {
  human?: boolean;
  org?: string;
}

/**
 * Take a deployed DVM offline without destroying it: the router stops routing
 * to it (callers get a 503), it drops out of `/explore`, and its Fly machines
 * are stopped so compute stops accruing. Slug, secrets, volumes and the paired
 * Postgres are all preserved — `dvmctl resume` brings it back on the same
 * image with no redeploy.
 */
export async function pause(slug: string, opts: PauseOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  const result = await platformClient.pauseDvm(platformUrl, token, dvmId);

  if (opts.human) {
    for (const m of result.machines) {
      info(`${m.id}: ${m.state}`);
    }
    info(
      `Paused "${slug}". It's no longer serving traffic and its machines are stopping. Data, secrets and database are untouched — run \`dvmctl resume ${slug}\` to bring it back.`
    );
  } else {
    json({ ...result, dvmId, slug });
  }
}

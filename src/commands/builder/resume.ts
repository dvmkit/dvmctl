import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface ResumeOptions {
  human?: boolean;
  org?: string;
}

/**
 * Bring an offline DVM back: start its Fly machines again and let the router
 * route to it. Same image, same data — no redeploy. Lifts a pause the builder
 * made themselves or an idle auto-suspend the platform applied to a quiet
 * free-tier DVM; a DVM the platform suspended for any other reason stays
 * suspended.
 */
export async function resume(slug: string, opts: ResumeOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  const result = await platformClient.resumeDvm(platformUrl, token, dvmId);

  if (opts.human) {
    for (const m of result.machines) {
      info(`${m.id}: ${m.state}`);
    }
    info(`Resumed "${slug}". It's serving traffic again on the same image.`);
  } else {
    json({ ...result, dvmId, slug });
  }
}

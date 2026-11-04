import { DvmError } from "@dvmkit/sdk/internal";

import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface VisibilityOptions {
  hidden?: boolean;
  listed?: boolean;
  org?: string;
  human?: boolean;
}

export async function visibility(slug: string, opts: VisibilityOptions): Promise<void> {
  if (Boolean(opts.hidden) === Boolean(opts.listed)) {
    throw new DvmError(
      "bad_request",
      "Choose exactly one of --hidden or --listed.",
      `Run dvmctl visibility ${slug} --hidden or dvmctl visibility ${slug} --listed.`
    );
  }

  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const result = await platformClient.setDvmVisibility(platformUrl, token, dvmId, Boolean(opts.hidden));

  if (opts.human) {
    info(result.hidden
      ? `Hidden "${result.slug}" from discovery. It is still callable by URL.`
      : `Listed "${result.slug}" in discovery.`);
  } else {
    json(result);
  }
}

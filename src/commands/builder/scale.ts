import { DvmError } from "@dvmkit/sdk/internal";

import * as platformClient from "../../lib/platform-client.ts";
import { MAX_MACHINES_HARD_CEILING } from "../../builder-platform/vm-config.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface ScaleOptions {
  count?: string;
  size?: string;
  human?: boolean;
  org?: string;
}

/**
 * Adjust a deployed DVM's machine count and/or VM size between deploys, mediated
 * by the platform (no flyctl required builder-side). At least one of `--count`
 * or `--size` is required. Plan-limit violations surface as a `plan_limit_exceeded`
 * error carrying an upgrade URL.
 */
export async function scale(slug: string, opts: ScaleOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  if (opts.count === undefined && opts.size === undefined) {
    throw new DvmError(
      "bad_request",
      "Nothing to scale.",
      `Pass --count <n> and/or --size <vm-size>, e.g. dvmctl scale ${slug} --count 2.`
    );
  }

  let count: number | undefined;
  if (opts.count !== undefined) {
    count = Number(opts.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_MACHINES_HARD_CEILING) {
      throw new DvmError(
        "bad_request",
        `--count must be an integer between 1 and ${MAX_MACHINES_HARD_CEILING}.`
      );
    }
  }

  const result = await platformClient.scaleDvm(platformUrl, token, dvmId, {
    count,
    size: opts.size,
  });

  if (opts.human) {
    const { before, after } = result;
    info(`Scaled ${result.slug}:`);
    if (before.maxMachines !== after.maxMachines) {
      info(`  machines: ${before.maxMachines} → ${after.maxMachines}`);
    }
    const sizeBefore = `${before.cpuCount}× ${before.cpuKind} CPU, ${before.memoryMb} MB`;
    const sizeAfter = `${after.cpuCount}× ${after.cpuKind} CPU, ${after.memoryMb} MB`;
    if (sizeBefore !== sizeAfter) {
      info(`  size:     ${sizeBefore} → ${sizeAfter}`);
    }
  } else {
    json({ ...result, dvmId, slug });
  }
}

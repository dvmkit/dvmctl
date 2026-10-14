import { DvmError } from "@dvmkit/sdk/internal";

import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface EnvOptions {
  set?: string[];
  unset?: string[];
  human?: boolean;
  org?: string;
}

export async function env(slug: string, opts: EnvOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const hasSet = opts.set && opts.set.length > 0;
  const hasUnset = opts.unset && opts.unset.length > 0;

  if (!hasSet && !hasUnset) {
    // List mode
    const names = await platformClient.getEnv(platformUrl, token, dvmId);
    if (opts.human) {
      if (names.length === 0) {
        info("No environment variables set.");
      } else {
        for (const name of names) {
          info(`  ${name}`);
        }
      }
    } else {
      json({ dvmId, slug, env: names });
    }
    return;
  }

  // Set/unset mode
  const setMap: Record<string, string> = {};
  if (hasSet) {
    for (const entry of opts.set ?? []) {
      const eqIdx = entry.indexOf("=");
      if (eqIdx === -1) {
        throw new DvmError(
          "bad_request",
          `Invalid format: "${entry}". Use KEY=value.`,
          "Example: --set API_KEY=abc123"
        );
      }
      setMap[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    }
  }

  await platformClient.setEnv(platformUrl, token, dvmId, {
    set: hasSet ? setMap : undefined,
    unset: hasUnset ? opts.unset : undefined,
  });

  if (opts.human) {
    const parts: string[] = [];
    if (hasSet) parts.push(`set ${Object.keys(setMap).join(", ")}`);
    if (hasUnset) parts.push(`unset ${(opts.unset ?? []).join(", ")}`);
    info(`Environment updated: ${parts.join("; ")}.`);
  } else {
    json({
      dvmId,
      slug,
      updated: hasSet ? Object.keys(setMap) : [],
      removed: hasUnset ? opts.unset : [],
    });
  }
}

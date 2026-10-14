import { DvmError } from "@dvmkit/sdk/internal";

import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export async function domains(
  action: "add" | "remove" | "verify" | "list",
  slug: string,
  opts: { domain?: string; human?: boolean; org?: string }
): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  switch (action) {
    case "add": {
      if (!opts.domain) throw new DvmError("bad_request", "Domain is required.");
      const result = await platformClient.addDomain(platformUrl, token, dvmId, opts.domain);
      if (opts.human) {
        info(`Domain "${opts.domain}" added to ${slug}.`);
        if (result.hint) info(result.hint);
      } else {
        json({ status: "added", dvmId, slug, domain: opts.domain });
      }
      break;
    }
    case "remove": {
      if (!opts.domain) throw new DvmError("bad_request", "Domain is required.");
      await platformClient.removeDomain(platformUrl, token, dvmId, opts.domain);
      if (opts.human) {
        info(`Domain "${opts.domain}" removed from ${slug}.`);
      } else {
        json({ status: "removed", dvmId, slug, domain: opts.domain });
      }
      break;
    }
    case "verify": {
      if (!opts.domain) throw new DvmError("bad_request", "Domain is required.");
      await platformClient.verifyDomain(platformUrl, token, dvmId, opts.domain);
      if (opts.human) {
        info(`Domain "${opts.domain}" verified and TLS certificate provisioned.`);
      } else {
        json({ status: "verified", dvmId, slug, domain: opts.domain });
      }
      break;
    }
    case "list": {
      const result = await platformClient.listDomains(platformUrl, token, dvmId);
      if (opts.human) {
        if (result.length === 0) {
          info("No custom domains configured.");
        } else {
          for (const d of result) {
            info(`  ${d.domain} (${d.status})`);
          }
        }
      } else {
        json({ dvmId, slug, domains: result });
      }
      break;
    }
  }
}

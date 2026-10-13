import { DvmError } from "@dvmkit/sdk/internal";

import { clearActiveOrg, loadActiveOrg, resolveAuth, saveActiveOrg } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface SwitchOptions {
  personal?: boolean;
  human?: boolean;
}

/**
 * Set or inspect the persistent org context. Stores the active org handle in
 * `~/.dvmctl/config.json`; every subsequent `dvmctl` command — reads as well
 * as deploys — runs against it, and `--org` overrides it for one invocation.
 *
 *  - `dvmctl switch <handle>`  — set context (verifies membership first)
 *  - `dvmctl switch --personal` — clear context (run as personal builder)
 *  - `dvmctl switch`            — print current context
 */
export async function switchCmd(handle: string | undefined, opts: SwitchOptions): Promise<void> {
  if (opts.personal && handle != null) {
    throw new DvmError(
      "bad_arguments",
      "Cannot pass both <handle> and --personal.",
      "Use `dvmctl switch <handle>` to set, or `dvmctl switch --personal` to clear."
    );
  }

  if (opts.personal) {
    clearActiveOrg();
    if (opts.human) {
      info("Switched to personal context.");
    } else {
      json({ activeOrg: null });
    }
    return;
  }

  if (handle == null) {
    const active = loadActiveOrg();
    if (opts.human) {
      info(active ? `Active org: ${active}` : "Active context: personal");
    } else {
      json({ activeOrg: active });
    }
    return;
  }

  // Setting context — verify membership before persisting so we don't save a
  // handle that would 404 every subsequent read and 403 every deploy.
  const creds = resolveAuth();
  if (!creds) {
    throw new DvmError(
      "auth_required",
      "Not authenticated.",
      "Set DVMKIT_API_KEY or run `dvmctl auth`."
    );
  }
  const platformUrl = process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev";
  const membership = await platformClient.getOrgMembership(platformUrl, creds.token, handle);

  saveActiveOrg(membership.handle);
  if (opts.human) {
    info(`Switched to ${membership.handle} (${membership.role}).`);
    info("Subsequent `dvmctl` commands read from this org, and deploys create DVMs under it.");
  } else {
    json({ activeOrg: membership.handle, role: membership.role });
  }
}

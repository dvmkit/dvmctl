import type { DvmError } from "@dvmkit/sdk/internal";

import { isPlatformError } from "./platform-error-tag.ts";

export const SUPPORT_EMAIL = "support@dvmkit.com";
/** Permanent invite to the dvmkit builder Discord, the first stop for a stuck builder. */
export const DISCORD_INVITE_URL = "https://discord.gg/aJ8BwVj5G2";

// Codes for failures the builder cannot fix alone but that are not tagged as
// platform errors because they are raised locally: a missing or rejected
// credential, and a deploy the platform reported as failed. Local causes such
// as an oversized build context use their own `deploy_context_*` codes.
const HELP_CODES = new Set(["auth_required", "auth_failed", "deploy_failed", "deploy_stream_failed"]);

/** The Discord invite for an error the builder is unlikely to resolve alone. */
export function helpFor(err: DvmError): string | undefined {
  return isPlatformError(err) || HELP_CODES.has(err.code) ? DISCORD_INVITE_URL : undefined;
}

export function helpHumanLine(url: string): string {
  return `Need help? Join the dvmkit builder Discord: ${url}`;
}

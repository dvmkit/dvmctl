import { DvmError } from "@dvmkit/sdk/internal";

import { CLI_AUTH_TTL_MS } from "./cli-auth.ts";

/** Where agents learn the sign-in routes, including the headless API key route. */
export const CLI_AUTH_DOCS_URL = "https://dvmkit.com/docs/cli-auth.md";

const SIGN_IN_WINDOW = `${CLI_AUTH_TTL_MS / 60_000} minutes`;

/**
 * What an agent must tell its human when no credentials exist. Kept in one
 * place so every `auth_required` site gives the same two routes: relay the
 * sign-in link, or ask for an API key.
 */
export const AUTH_REQUIRED_HINT =
  "A human must sign in once. Run `dvmctl auth` and give the printed link and session code to the human; " +
  `they can open it on any device within ${SIGN_IN_WINDOW}, and signing in also creates the account if they have none. ` +
  "If you cannot wait for them or run unattended, ask the human to create an API key in the dashboard " +
  `and set DVMKIT_API_KEY (${CLI_AUTH_DOCS_URL}).`;

export function authRequiredError(message = "Not authenticated."): DvmError {
  return new DvmError("auth_required", message, AUTH_REQUIRED_HINT);
}

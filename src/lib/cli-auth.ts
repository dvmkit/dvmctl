/**
 * Shared constants and helpers for the `dvmctl auth` device flow. The CLI
 * poll window, platform session TTL, and consent-screen fingerprint width
 * all depend on these — keeping them in one place avoids drift between
 * the CLI and the platform (where a mismatch would mean the CLI times out
 * before the server expires or vice versa).
 */

/** Time-to-live for a pending CLI auth session, in milliseconds. */
export const CLI_AUTH_TTL_MS = 5 * 60 * 1000;

/** How often the CLI polls the platform for the deposited token. */
export const CLI_AUTH_POLL_INTERVAL_MS = 1000;

/**
 * Upper bound on random jitter added to each poll sleep. Small enough to
 * stay imperceptible, large enough to de-sync concurrent CLI auth flows.
 */
export const CLI_AUTH_POLL_JITTER_MS = 500;

/** Maximum poll attempts before the CLI gives up — derived from TTL. */
export const CLI_AUTH_MAX_POLL_ATTEMPTS = Math.floor(CLI_AUTH_TTL_MS / CLI_AUTH_POLL_INTERVAL_MS);

/**
 * Number of leading session-id hex characters shown as a fingerprint on
 * both the CLI and the consent screen. 12 chars = 48 bits, comfortably
 * unique across concurrent auth flows.
 */
export const CLI_AUTH_FINGERPRINT_LEN = 12;

/**
 * Platform client shape consumed by {@link mintAndDepositCliAuth}. The
 * server action injects the real web-side `@/lib/platform` module; tests
 * inject mocks. Keeps the rollback logic testable without pulling in any
 * Next.js request context or Better Auth.
 */
export interface CliAuthPlatform {
  createBuilderApiKey(label?: string): Promise<{ id: string; key: string }>;
  depositCliAuth(opts: {
    session: string;
    verifierHash: string;
    apiKey: string;
    account: string;
  }): Promise<void>;
  deleteBuilderApiKey(id: string): Promise<void>;
}

/**
 * Mint a labeled API key and deposit it into a pending CLI auth session.
 * If the deposit fails the minted key is best-effort revoked, so a
 * platform-side error can't leave an orphan long-lived credential behind
 * on the builder's account.
 */
export async function mintAndDepositCliAuth(params: {
  platform: CliAuthPlatform;
  label: string;
  session: string;
  verifierHash: string;
  account: string;
}): Promise<void> {
  const { platform, label, session, verifierHash, account } = params;
  const { id, key } = await platform.createBuilderApiKey(label);
  try {
    await platform.depositCliAuth({ session, verifierHash, apiKey: key, account });
  } catch (err) {
    await platform.deleteBuilderApiKey(id).catch(() => undefined);
    throw err;
  }
}

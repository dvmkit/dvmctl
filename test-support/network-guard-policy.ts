/**
 * Policy shared by the vitest network guard (`setup-network-guard.ts`) and the
 * live-network test tiers it has to let through. Side-effect free and free of
 * heavy imports on purpose: a `setupFiles` entry loads it before every test file
 * in the run.
 *
 * Why it exists: the guard blocks every non-loopback `fetch`, which
 * included the *reachability probes* the two testnet integration tiers gate
 * themselves on. The probes catch and return `false`, so a blocked probe was
 * indistinguishable from a testnet outage and both tiers skipped silently —
 * including in CI, which sets `TEMPO_TESTNET_RPC` precisely to run them. Two
 * things fix that and both live here:
 *
 * 1. An **allowlist keyed on the env vars that gate each tier**. A host opens
 *    only when an operator/CI has explicitly enabled the tier that needs it, so
 *    the guard stays closed by default and outbound-fetch protection is untouched
 *    for every other file. Deliberately *not* a blanket "integration tests
 *    bypass the guard" opt-out — that re-opens unstubbed outbound access for any tagged test.
 * 2. A **distinguishable error** ({@link NetworkGuardBlockedError} /
 *    {@link isNetworkGuardBlocked}), so a probe can tell "blocked by the guard"
 *    (a wiring bug — rethrow, fail the run loudly) from "host is down" (skip and
 *    warn, the explicit testnet-outage behaviour).
 *
 * The third protection — an enabled tier saying out loud whether it ran or
 * skipped — outgrew this file's network-guard scope and moved to
 * `announceTier` in `src/test-support/tier-announce.ts`, which every
 * other env-gated tier now uses too.
 *
 * Adding a tier that talks to a live host: add an entry to {@link TESTNET_TIERS}
 * naming the env vars that gate it and every URL it can reach — the env override
 * *and* the built-in default, since a client library may resolve its own default
 * endpoint regardless of what we pass (mppx does exactly this for moderato).
 */

/** Moderato — the Tempo public testnet RPC. Matches mppx's own testnet default. */
export const MODERATO_RPC_DEFAULT = "https://rpc.moderato.tempo.xyz";

/** Base Sepolia public RPC. */
export const BASE_SEPOLIA_RPC_DEFAULT = "https://sepolia.base.org";

/** The free, no-API-key x402 facilitator that settles Base Sepolia. */
export const X402_FACILITATOR_DEFAULT = "https://x402.org/facilitator";

/** The subset of `process.env` this module reads. */
export type EnvLike = Record<string, string | undefined>;

/** A test tier that talks to a live network host, and the env that enables it. */
export interface TestnetTier {
  /** Short identifier, used in messages. */
  name: string;
  /** Every one of these must be non-empty for the tier — and its hosts — to be enabled. */
  enabledBy: readonly string[];
  /** Every URL the tier can reach when enabled: env overrides plus built-in defaults. */
  urls: (env: EnvLike) => readonly string[];
}

/**
 * The live-network tiers. `enabledBy` mirrors each consumer's own `ENABLED`
 * expression — the allowlist must open exactly when the tier runs, never wider.
 */
export const TESTNET_TIERS: readonly TestnetTier[] = [
  {
    // scripts/money-loop/run-tempo-money-loop.ts and
    // scripts/mpp-conformance/run-mpp-rs-conformance.ts
    name: "tempo",
    enabledBy: ["TEMPO_TESTNET_RPC"],
    urls: (env) => [env.TEMPO_TESTNET_RPC ?? MODERATO_RPC_DEFAULT, MODERATO_RPC_DEFAULT],
  },
  {
    // scripts/x402-conformance/run-x402-conformance.ts
    name: "x402",
    enabledBy: ["X402_TESTNET_RPC", "X402_TESTNET_PRIVATE_KEY"],
    urls: (env) => [
      env.X402_TESTNET_RPC ?? BASE_SEPOLIA_RPC_DEFAULT,
      BASE_SEPOLIA_RPC_DEFAULT,
      env.X402_TESTNET_FACILITATOR ?? X402_FACILITATOR_DEFAULT,
      X402_FACILITATOR_DEFAULT,
    ],
  },
];

/** Thrown by the network guard for an outbound request or DNS lookup it refuses to make. */
export class NetworkGuardBlockedError extends Error {
  /**
   * Brand read by {@link isNetworkGuardBlocked}. A property rather than an
   * `instanceof` check, so the predicate holds even if the setup file and the
   * test file end up with separate instances of this module.
   */
  readonly isNetworkGuardBlocked = true;
  /** The URL or transport-qualified target that was refused. */
  readonly url: string;

  constructor(url: string, message: string) {
    super(message);
    this.name = "NetworkGuardBlockedError";
    this.url = url;
  }
}

/** True when `err` is the network guard refusing a request, rather than a real network failure. */
export function isNetworkGuardBlocked(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isNetworkGuardBlocked?: unknown }).isNetworkGuardBlocked === true
  );
}

/** Whether every env var gating `tier` is set and non-empty. */
export function testnetTierEnabled(tier: TestnetTier, env: EnvLike = process.env): boolean {
  return tier.enabledBy.every((name) => Boolean(env[name]));
}

/**
 * Hostnames the guard lets through for the tiers `env` enables — empty when none
 * is. Unparseable URLs are skipped rather than thrown: a malformed override is
 * the tier's own problem to report, not something that should take down every
 * test file's setup.
 */
export function allowedTestnetHosts(env: EnvLike = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const tier of TESTNET_TIERS) {
    if (!testnetTierEnabled(tier, env)) continue;
    for (const url of tier.urls(env)) {
      try {
        hosts.add(new URL(url).hostname);
      } catch {
        // Malformed override — nothing to allow.
      }
    }
  }
  return hosts;
}

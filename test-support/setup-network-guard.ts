/**
 * Globally block any outbound request to a real (non-loopback) network host for
 * every vitest run, unless a later setup file or a per-test stub intercepts it
 * first. Wired into `vitest.config.ts` via `setupFiles`.
 *
 * Three transports are covered, because a library gets to pick its own: the global
 * `fetch`, `node:http` / `node:https`, and `node:dns` / `node:dns/promises`.
 * The HTTP guard catches requests that bypass global fetch: `stripe@22` on Node builds
 * a `NodeHttpClient` by default, so the price-cache tests' unstubbed
 * `new Stripe("sk_test_dummy")` round-tripped to `api.stripe.com` on every unit
 * run — invisible while the 401 came back fast, and a 5s `testTimeout` failure
 * that froze `master` when a CI runner's connection was cold. A fetch-only
 * guard cannot see requests through other transports.
 *
 * Why this exists: `wallet-cashu.test.ts` made an unstubbed real request
 * to `api.example.invalid` on every run — `fetchReliability()`'s try/catch swallowed
 * the failure, so the suite kept passing while quietly eating real network
 * latency per run, flaking under CI's default 5s vitest `testTimeout` whenever
 * the connection hung instead of refusing outright. A per-file `vi.mock` only
 * closes that hole once someone remembers to add it; this closes the whole
 * class by making the leak a hard failure everywhere.
 *
 * Loopback (`localhost` / `127.0.0.1` / `::1`) is allowed through unconditionally
 * — published SDK server integration tests and `src/isolate/__tests__/*` spin up
 * a real local HTTP server via `serve()` (`http://localhost:${port}`, see
 * `@dvmkit/sdk/server`) and talk to it over real `fetch`. That's the L1
 * in-process integration testing this repo's verification ladder relies on, not
 * a live-network leak.
 *
 * The DNS guard is needed because the domain-add role-boundary test performed
 * a real CNAME lookup. It patches only public `node:dns` exports, not Node's
 * internal resolver binding: Vitest and the Postgres driver can keep resolving
 * loopback without ever calling these exported functions.
 *
 * Ordering matters for the `fetch` half: this file must be listed BEFORE
 * `setup-fx-mock.ts` in `vitest.config.ts`'s `setupFiles`. Each global-fetch
 * setup file captures the current `globalThis.fetch` as its fallback and
 * reassigns the global to its own wrapper, so the file loaded *last* becomes
 * outermost and gets first look at a call. `setup-fx-mock.ts` needs to stay
 * outermost so it can keep short-circuiting CoinGecko/ECB with canned data
 * before ever delegating down to this guard — if this guard loaded last
 * instead, it would block those non-loopback origins before the FX mock got a
 * chance to serve them. The `node:http`/`node:https` half has no such ordering
 * concern: nothing else in the run patches those builtins.
 *
 * Verified safe against the two categories of test that look risky at a glance:
 * SSRF-guard tests (`@dvmkit/sdk/server`,
 * `src/isolate/__tests__/{remote-context,cancel}.test.ts`) hit real-looking
 * external IPs, but every one either asserts rejection *before* any fetch call
 * reaches the network (the DNS/IP validation runs first) or injects its own
 * `baseFetch` double, bypassing `globalThis.fetch` entirely.
 *
 * The one narrow exception is the live-network testnet tiers, which have to
 * reach moderato / Base Sepolia to be worth anything. They open through an
 * allowlist keyed on the same env vars that gate each tier, declared in
 * `src/__tests__/network-guard-policy.ts` — so a host is reachable only when an
 * operator or CI has explicitly enabled the tier that needs it, and the guard is
 * closed by default for everything else. Blocking their reachability probes is
 * what made both tiers skip silently for months; the refusal is a
 * typed `NetworkGuardBlockedError` for the same reason, so a probe can tell a
 * guard block from a real outage instead of reporting both as "unreachable".
 */

import { createRequire, syncBuiltinESMExports } from "node:module";

import {
  allowedTestnetHosts,
  NetworkGuardBlockedError,
} from "./network-guard-policy";

/**
 * The testnet hostnames this run opens, resolved once at setup — the env can't
 * change between here and the test file. Exported so a test can assert the guard
 * reads the policy, rather than re-deriving the same answer on both sides.
 */
export const ALLOWED_TESTNET_HOSTS: ReadonlySet<string> = allowedTestnetHosts(process.env);

/**
 * The guard's own allow decision, exported so it can be exercised against a
 * synthetic host set on any box — a run with no tier enabled would otherwise
 * have no way to catch this dropping its allowlist consult.
 */
export function isNetworkGuardAllowed(
  url: string,
  allowedTestnetHostnames: ReadonlySet<string> = ALLOWED_TESTNET_HOSTS
): boolean {
  try {
    const { hostname } = new URL(url);
    return isNetworkGuardHostnameAllowed(hostname, allowedTestnetHostnames);
  } catch {
    // Unparseable/relative input — let the real fetch surface its own error
    // rather than mask it behind a misleading "network blocked" message.
    return true;
  }
}

/** Share the loopback and testnet policy with hostname-only DNS APIs. */
export function isNetworkGuardHostnameAllowed(
  hostname: string,
  allowedTestnetHostnames: ReadonlySet<string> = ALLOWED_TESTNET_HOSTS
): boolean {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) || allowedTestnetHostnames.has(normalized);
}

/**
 * The URL a `node:http` / `node:https` call would reach, resolved from either
 * calling form — `request(url[, options][, cb])` or `request(options[, cb])`,
 * with `options` overriding the URL exactly as Node merges them.
 *
 * `null` means "this names no network host": a `socketPath` (unix socket), or a
 * shape/URL we can't parse. The guard lets those through for the same reason the
 * `fetch` half does — Node's own error is more useful than a misleading
 * "network blocked".
 */
export function nodeRequestUrl(
  args: readonly unknown[],
  defaultProtocol: "http:" | "https:"
): string | null {
  const [first, second] = args;
  let base: URL | null = null;
  let options: NodeRequestOptions | undefined;

  if (typeof first === "string" || first instanceof URL) {
    try {
      base = new URL(first.toString());
    } catch {
      return null;
    }
    options = asRequestOptions(second);
  } else {
    options = asRequestOptions(first);
    if (options === undefined) return null;
  }

  if (nonEmpty(options?.socketPath)) return null;

  const protocol = nonEmpty(options?.protocol) ?? base?.protocol ?? defaultProtocol;
  const host = normalizeHost(
    nonEmpty(options?.hostname) ?? nonEmpty(options?.host) ?? base?.hostname ?? "localhost"
  );
  const port = options?.port != null ? String(options.port) : (base?.port ?? "");
  const path = nonEmpty(options?.path) ?? (base ? `${base.pathname}${base.search}` : "/");

  try {
    return new URL(
      `${protocol}//${host}${port ? `:${port}` : ""}${path.startsWith("/") ? path : `/${path}`}`
    ).href;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The `node:http` / `node:https` surface this guard wraps. */
type NodeHttpModule = Record<"request" | "get", (...args: unknown[]) => unknown>;

/** The public resolution APIs shared by `node:dns` and `node:dns/promises`. */
const NODE_DNS_RESOLUTION_METHODS = [
  "lookup",
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTlsa",
  "resolveTxt",
  "reverse",
] as const;

/** `Resolver` instances do not expose the `lookup` APIs. */
const NODE_DNS_RESOLVER_METHODS = NODE_DNS_RESOLUTION_METHODS.filter(
  (name) => name !== "lookup" && name !== "lookupService"
);

type NodeDnsModule = Record<string, unknown>;
type NodeDnsSurface = "callback" | "promises";

/** The subset of Node's request options that decides where a request goes. */
interface NodeRequestOptions {
  protocol?: string | null;
  host?: string | null;
  hostname?: string | null;
  port?: number | string | null;
  path?: string | null;
  socketPath?: string | null;
}

function asRequestOptions(value: unknown): NodeRequestOptions | undefined {
  if (value === null || typeof value !== "object" || value instanceof URL) return undefined;
  return value as NodeRequestOptions;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `options.host` may carry a `:port`; `options.hostname` may be a bare IPv6
 * literal. Both have to come out as something `new URL()` accepts and as the
 * spelling {@link LOOPBACK_HOSTNAMES} uses.
 */
function normalizeHost(host: string): string {
  if (host.startsWith("[")) return host;
  const colon = host.lastIndexOf(":");
  if (colon === -1) return host;
  const head = host.slice(0, colon);
  if (head.includes(":")) return `[${host}]`; // bare IPv6 literal
  return /^\d+$/.test(host.slice(colon + 1)) ? head : host;
}

const innerFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function fetchWithNetworkGuard(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (isNetworkGuardAllowed(url)) {
    return await innerFetch(input, init);
  }
  throw new NetworkGuardBlockedError(
    url,
    `Blocked unstubbed outbound fetch to ${url} in a unit test. ` +
      `Unit tests must not reach a real network host — mock the client module ` +
      `that wraps this call (e.g. vi.mock("../../lib/platform-client")) or stub ` +
      `fetch directly with vi.stubGlobal("fetch", ...). If this is a live-network ` +
      `test tier that is supposed to reach this host, declare the tier and its ` +
      `gating env vars in src/__tests__/network-guard-policy.ts.`
  );
} as typeof fetch;

/**
 * Marks a builtin as already wrapped. The patch is process-global while this
 * file is per-test-file, so it has to be re-entrant even though vitest's forks
 * pool isolates each file today.
 */
const NODE_HTTP_GUARD_INSTALLED = Symbol.for("dvmkit.network-guard.node-http");

function installNodeHttpGuard(mod: NodeHttpModule, defaultProtocol: "http:" | "https:"): void {
  const marker = mod as unknown as Record<symbol, boolean | undefined>;
  if (marker[NODE_HTTP_GUARD_INSTALLED] === true) return;
  marker[NODE_HTTP_GUARD_INSTALLED] = true;

  const scheme = defaultProtocol.slice(0, -1);
  // `get` too, not just `request`: Node's `get` calls the module-local `request`
  // binding rather than the exported property, so wrapping one never covers the
  // other.
  for (const name of ["request", "get"] as const) {
    const inner = mod[name];
    mod[name] = function requestWithNetworkGuard(this: unknown, ...args: unknown[]): unknown {
      const url = nodeRequestUrl(args, defaultProtocol);
      if (url !== null && !isNetworkGuardAllowed(url)) {
        throw new NetworkGuardBlockedError(
          url,
          `Blocked unstubbed outbound node:${scheme} request to ${url} in a unit test. ` +
            `Unit tests must not reach a real network host — a client library that ships ` +
            `its own transport (stripe's NodeHttpClient, the AWS SDK, ws) never touches ` +
            `globalThis.fetch, so stubbing fetch does not cover it. Inject a stub client ` +
            `instead (e.g. StripeService's 5th constructor arg), or vi.mock("node:${scheme}"). ` +
            `If this is a live-network test tier that is supposed to reach this host, declare ` +
            `the tier and its gating env vars in src/__tests__/network-guard-policy.ts.`
        );
      }
      return inner.apply(this, args);
    };
  }
}

/** Markers mirror the HTTP guard: setup files run per test file, builtins do not. */
const NODE_DNS_GUARD_INSTALLED = Symbol.for("dvmkit.network-guard.node-dns");
const NODE_DNS_RESOLVER_GUARD_INSTALLED = Symbol.for("dvmkit.network-guard.node-dns-resolver");

/**
 * A DNS-specific guard error. `url` remains a transport identifier for callers
 * that log it, while the message names the hostname a test tried to resolve.
 */
function dnsBlockedError(hostname: string): NetworkGuardBlockedError {
  return new NetworkGuardBlockedError(
    `dns://${hostname}`,
    `Blocked unstubbed node:dns lookup for ${hostname} in a unit test. ` +
      `Unit tests must not reach a real network host — inject a resolver or mock ` +
      `the module that performs the lookup. If this is a live-network test tier ` +
      `that is supposed to resolve this host, declare the tier and its gating env ` +
      `vars in src/__tests__/network-guard-policy.ts.`
  );
}

/**
 * Guard one DNS function without changing its public call shape. Callback APIs
 * throw synchronously, as the HTTP guard does; promise APIs reject immediately
 * so callers keep their normal `await` / `.catch()` behavior.
 */
function guardedDnsMethod(
  inner: (...args: unknown[]) => unknown,
  surface: NodeDnsSurface
): (this: unknown, ...args: unknown[]) => unknown {
  return function dnsMethodWithNetworkGuard(this: unknown, ...args: unknown[]): unknown {
    const hostname = args[0];
    if (typeof hostname === "string" && !isNetworkGuardHostnameAllowed(hostname)) {
      const error = dnsBlockedError(hostname);
      if (surface === "promises") return Promise.reject(error);
      throw error;
    }
    return inner.apply(this, args);
  };
}

function installNodeDnsResolverGuard(resolver: unknown, surface: NodeDnsSurface): void {
  if (typeof resolver !== "function") return;
  const prototype = (resolver as { prototype?: unknown }).prototype;
  if (prototype === null || typeof prototype !== "object") return;

  const marker = prototype as Record<symbol, boolean | undefined>;
  if (marker[NODE_DNS_RESOLVER_GUARD_INSTALLED] === true) return;
  marker[NODE_DNS_RESOLVER_GUARD_INSTALLED] = true;

  const methods = prototype as Record<string, unknown>;
  for (const name of NODE_DNS_RESOLVER_METHODS) {
    const inner = methods[name];
    if (typeof inner !== "function") continue;
    methods[name] = guardedDnsMethod(inner as (...args: unknown[]) => unknown, surface);
  }
}

function installNodeDnsGuard(mod: NodeDnsModule, surface: NodeDnsSurface): void {
  const marker = mod as Record<symbol, boolean | undefined>;
  if (marker[NODE_DNS_GUARD_INSTALLED] === true) return;
  marker[NODE_DNS_GUARD_INSTALLED] = true;

  for (const name of NODE_DNS_RESOLUTION_METHODS) {
    const inner = mod[name];
    if (typeof inner !== "function") continue;
    mod[name] = guardedDnsMethod(inner as (...args: unknown[]) => unknown, surface);
  }
  installNodeDnsResolverGuard(mod.Resolver, surface);
}

// `createRequire` rather than `import * as http`: an ES module namespace object
// is frozen and would not take the patch, while the CJS `module.exports` object
// this returns is the very one `require("https")` hands stripe et al.
const nodeRequire = createRequire(import.meta.url);
installNodeHttpGuard(nodeRequire("node:http") as NodeHttpModule, "http:");
installNodeHttpGuard(nodeRequire("node:https") as NodeHttpModule, "https:");
installNodeDnsGuard(nodeRequire("node:dns") as NodeDnsModule, "callback");
installNodeDnsGuard(nodeRequire("node:dns/promises") as NodeDnsModule, "promises");

// Builtin ESM named exports are snapshots. Vitest or a dependency may have
// imported `node:dns` before this setup file; refresh those bindings so static
// and dynamic ESM imports see the same guarded CJS functions.
syncBuiltinESMExports();

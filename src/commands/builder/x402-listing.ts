import { DvmError } from "@dvmkit/sdk/internal";

import { dvmFetch } from "../../lib/http.ts";
import { info, json, progress } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

/** Coinbase's public x402 resource validator. It takes no credentials. */
export const X402_VALIDATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402/validate";

const INFO_TIMEOUT_MS = 10_000;
const VALIDATOR_TIMEOUT_MS = 10_000;
const ICON_TIMEOUT_MS = 5_000;
const ICON_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export type X402ListingStatus =
  | "listed"
  | "listed_with_problems"
  | "not_listed"
  | "unreachable"
  | "not_x402"
  | "challenge_invalid"
  | "check_unavailable";

export interface X402ListingProblem {
  check: string;
  severity: string;
  detail: string;
  fix?: string;
}

export interface X402IconWarning {
  code: "icon_unreachable" | "icon_http_error" | "icon_unsupported_type";
  icon_url: string;
  detail: string;
  fix: string;
}

export interface X402RouteListing {
  capability: string;
  url: string;
  status: X402ListingStatus;
  detail?: string;
  problems?: X402ListingProblem[];
  index?: { active?: boolean; last_crawled_at?: string };
  icon_warning?: X402IconWarning;
  hint?: string;
}

/** `status` and `routes` are always present; `routes` is empty when nothing was checked. */
export type X402ListingReport =
  | { status: "checked"; routes: X402RouteListing[]; note?: string }
  | { status: "not_checked"; routes: []; hint: string };

export const NOT_LISTED_HINT =
  "Not in Coinbase's x402 catalog. That is optional: to list it, add a `listing` to the capability's x402 channel and redeploy.";

export const NOT_INDEXED_HINT =
  "Valid, but not in Coinbase's active index yet. Coinbase indexes a route after its first paid call through its facilitator.";

export const LISTING_UPKEEP_NOTE =
  "Coinbase removes a catalog listing after 30 days without a settlement, so keeping it active is up to you. Curation in the catalog is Coinbase's editorial choice; a valid listing is not a curated one.";

/**
 * Read a deployed DVM's x402 routes from `/v1/info` and ask Coinbase's
 * validator about each one. Returns a `checked` report with no routes when
 * the DVM offers none. `onRoutes` runs once the routes are known and before
 * any validator call. Throws `x402_info_unavailable` when `/v1/info` cannot
 * be read; every validator or icon failure is reported per route instead.
 */
export async function checkX402Listing(
  dvmkitUrl: string,
  slug: string,
  onRoutes?: (count: number) => void
): Promise<X402ListingReport> {
  const routes = await readX402Routes(dvmkitUrl);
  if (routes.length === 0) return { status: "checked", routes: [] };
  onRoutes?.(routes.length);
  const checked = await Promise.all(routes.map((route) => checkRoute(route.capability, route.url, slug)));
  const anyListed = checked.some((r) => r.status === "listed" || r.status === "listed_with_problems");
  return { status: "checked", routes: checked, ...(anyListed ? { note: LISTING_UPKEEP_NOTE } : {}) };
}

/** Human-readable lines for a listing report, without trailing blank lines. */
export function formatX402ListingLines(report: X402ListingReport): string[] {
  if (report.status === "not_checked") return [report.hint];
  const lines = ["x402 catalog listing (Coinbase validator):"];
  for (const route of report.routes) {
    lines.push(`  ${route.capability}: ${STATUS_LABELS[route.status]} (${route.url})`);
    if (route.detail) lines.push(`    ${route.detail}`);
    if (route.index) {
      const active = route.index.active === undefined ? "" : `index ${route.index.active ? "active" : "inactive"}`;
      const crawled = route.index.last_crawled_at ? `last crawled ${route.index.last_crawled_at}` : "";
      const parts = [active, crawled].filter(Boolean);
      if (parts.length) lines.push(`    ${parts.join(", ")}`);
    }
    for (const problem of route.problems ?? []) {
      lines.push(`    ${problem.severity} check ${problem.check} failed: ${problem.detail}`);
      if (problem.fix) lines.push(`      Fix: ${problem.fix}`);
    }
    if (route.icon_warning) {
      lines.push(`    Warning (${route.icon_warning.code}): ${route.icon_warning.detail}`);
      lines.push(`      Fix: ${route.icon_warning.fix}`);
    }
    if (route.hint) lines.push(`    ${route.hint}`);
  }
  if (report.note) lines.push(report.note);
  return lines;
}

/** The report a deploy gives when it could not confirm the DVM is serving. */
export function unverifiedListingReport(slug: string): X402ListingReport {
  return {
    status: "not_checked",
    routes: [],
    hint: `If this DVM offers x402 routes, run \`dvmctl x402 listing-check ${slug}\` once it is serving to see Coinbase's catalog verdict.`,
  };
}

/** The progress line printed before the validator calls start. */
export function listingProgressLine(count: number): string {
  return `Checking ${count} x402 route${count === 1 ? "" : "s"} with Coinbase's validator...`;
}

export interface X402ListingCheckOptions {
  human?: boolean;
  org?: string;
}

/** `dvmctl x402 listing-check <slug>`: the post-deploy listing check, on demand. */
export async function x402ListingCheck(slug: string, opts: X402ListingCheckOptions): Promise<void> {
  const { dvmkitUrl } = await resolveDvm(slug, opts);
  if (!dvmkitUrl) {
    throw new DvmError(
      "dvm_url_unset",
      `DVM "${slug}" has no public URL yet.`,
      `Coinbase can only check a public HTTPS address. If the DVM is still deploying, wait for it to finish; if its owner has no handle, claim one with \`dvmctl handle set <handle>\`. Then rerun \`dvmctl x402 listing-check ${slug}\`.`
    );
  }
  const report = await checkX402Listing(dvmkitUrl, slug, (count) => {
    if (opts.human) info(listingProgressLine(count));
    else progress({ event: "x402_listing_check", routes: count });
  });

  if (opts.human) {
    if (report.routes.length === 0) info(`"${slug}" offers no x402 routes, so there is nothing to list.`);
    else for (const line of formatX402ListingLines(report)) info(line);
  } else {
    json({ slug, dvmkitUrl, x402_listing: report });
  }
}

const STATUS_LABELS: Record<X402ListingStatus, string> = {
  listed: "listed",
  listed_with_problems: "listed, but Coinbase's validator reports problems",
  not_listed: "not listed",
  unreachable: "unreachable from Coinbase",
  not_x402: "did not answer with an x402 payment challenge",
  challenge_invalid: "answered 402, but its x402 payment challenge is invalid",
  check_unavailable: "check unavailable",
};

const FIXES: Record<string, string> = {
  endpoint_reachable: "Serve the route on a public HTTPS hostname that resolves from the internet.",
  returns_402:
    "Make an unpaid POST to this exact URL answer HTTP 402 with a PAYMENT-REQUIRED header. Coinbase does not follow redirects.",
  has_bazaar_extension: "Add a `listing` to the capability's x402 channel and redeploy.",
  "accepts[0].amount": "Price the x402 route at $0.001 or more; Coinbase requires at least 1000 micro-USDC.",
  "bazaar.info.output": "Add `outputExample` to the listing.",
  "bazaar.info.output.example": "Add `outputExample` to the listing.",
};

interface PreflightItem {
  check: string;
  detail: string;
  passed: boolean;
  severity: string;
}

async function readX402Routes(dvmkitUrl: string): Promise<Array<{ capability: string; url: string }>> {
  const infoUrl = `${dvmkitUrl.replace(/\/+$/, "")}/v1/info`;
  let body: unknown;
  try {
    const res = await dvmFetch(infoUrl, { signal: AbortSignal.timeout(INFO_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (error) {
    throw new DvmError(
      "x402_info_unavailable",
      `Could not read ${infoUrl}: ${error instanceof Error ? error.message : String(error)}.`,
      "Check that the DVM is serving, then retry."
    );
  }
  const capabilities = isRecord(body) ? body.x402_capabilities : undefined;
  if (!isRecord(capabilities)) return [];
  const routes: Array<{ capability: string; url: string }> = [];
  for (const [capability, entry] of Object.entries(capabilities)) {
    if (isRecord(entry) && typeof entry.url === "string") routes.push({ capability, url: entry.url });
  }
  return routes;
}

async function checkRoute(capability: string, url: string, slug: string): Promise<X402RouteListing> {
  // Coinbase rejects a non-HTTPS resource before probing it, so skip the call.
  if (!url.startsWith("https://")) {
    return {
      capability,
      url,
      status: "unreachable",
      problems: [
        {
          check: "url_https",
          severity: "required",
          detail: "Coinbase only checks public HTTPS addresses, so this route was not sent to the validator.",
          fix: FIXES.endpoint_reachable,
        },
      ],
    };
  }
  let res: Response;
  try {
    res = await dvmFetch(X402_VALIDATOR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: url, method: "POST" }),
      signal: AbortSignal.timeout(VALIDATOR_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return unavailable(capability, url, slug, timedOut ? "The validator did not answer within 10 seconds." : "The validator could not be reached.");
  }
  // 408 and 429 are transient, so they keep the retry hint below.
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    // Retrying a rejected request gives the same answer, so report Coinbase's reason instead.
    const reason = await readErrorMessage(res);
    return {
      capability,
      url,
      status: "check_unavailable",
      detail: `Coinbase's validator rejected the request (HTTP ${res.status})${reason ? `: ${reason}` : "."}`,
    };
  }
  if (!res.ok) {
    await discardBody(res);
    return unavailable(capability, url, slug, `The validator answered HTTP ${res.status}.`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return unavailable(capability, url, slug, "The validator's answer was not JSON.");
  }
  const preflight = isRecord(body) && Array.isArray(body.preflight) ? body.preflight.filter(isPreflightItem) : null;
  if (!isRecord(body) || !preflight || preflight.length === 0) {
    return unavailable(capability, url, slug, "The validator's answer had no preflight checks.");
  }

  const failed = (check: string) => preflight.some((item) => item.check === check && !item.passed);
  // A `Skipped:` item was not evaluated because an earlier check failed.
  const failedItself = (check: string) =>
    preflight.some((item) => item.check === check && !item.passed && !item.detail.startsWith("Skipped:"));
  // Checks Coinbase skipped because an earlier one failed carry no extra
  // information. `endpoint_reachable` is the exception: its own failure detail
  // starts with "Skipped:" when the host is private or does not resolve.
  const reportable = preflight.filter(
    (item) => !item.passed && (item.check === "endpoint_reachable" || !item.detail.startsWith("Skipped:"))
  );
  const route: X402RouteListing = { capability, url, status: "listed_with_problems" };

  if (failed("endpoint_reachable")) {
    route.status = "unreachable";
  } else if (failedItself("returns_402")) {
    route.status = "not_x402";
  } else if (failedItself("has_bazaar_extension")) {
    route.status = "not_listed";
    route.hint = NOT_LISTED_HINT;
    // An absent listing fails every listing check; only the route's own problems are news.
    const own = reportable.filter((item) => item.check !== "has_bazaar_extension" && item.check !== "parse" && !item.check.startsWith("bazaar"));
    if (own.length) route.problems = own.map(toProblem);
    return route;
  } else if (body.valid === true) {
    route.status = "listed";
    const index = isRecord(body.index) ? body.index : undefined;
    if (index && (typeof index.active === "boolean" || typeof index.lastCrawledAt === "string")) {
      route.index = {
        ...(typeof index.active === "boolean" ? { active: index.active } : {}),
        ...(typeof index.lastCrawledAt === "string" ? { last_crawled_at: index.lastCrawledAt } : {}),
      };
    }
    if (index?.active !== true) route.hint = NOT_INDEXED_HINT;
  } else if (failed("has_bazaar_extension") && !hasBazaarExtension(body)) {
    // An earlier challenge check failed, so Coinbase never looked for a listing.
    route.status = "challenge_invalid";
  }

  if (reportable.length) route.problems = reportable.map(toProblem);
  if (route.status === "listed" || route.status === "listed_with_problems") {
    const iconUrl = readIconUrl(body.paymentRequirements);
    if (iconUrl) {
      const warning = await checkIcon(iconUrl);
      if (warning) route.icon_warning = warning;
    }
  }
  return route;
}

/**
 * The validator's `paymentRequirements` is the decoded PAYMENT-REQUIRED
 * challenge it fetched, so its `resource.iconUrl` is the icon the catalog sees.
 */
function readIconUrl(paymentRequirements: unknown): string | undefined {
  if (!isRecord(paymentRequirements) || !isRecord(paymentRequirements.resource)) return undefined;
  const iconUrl = paymentRequirements.resource.iconUrl;
  return typeof iconUrl === "string" && iconUrl.length > 0 ? iconUrl : undefined;
}

async function checkIcon(iconUrl: string): Promise<X402IconWarning | undefined> {
  const fix = "Serve the listing's `iconUrl` publicly as a JPEG, PNG, WebP, or GIF image, or remove it.";
  let res: Response;
  try {
    res = await dvmFetch(iconUrl, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
  } catch {
    return { code: "icon_unreachable", icon_url: iconUrl, detail: `The listing icon ${iconUrl} could not be fetched within 5 seconds.`, fix };
  }
  await discardBody(res);
  if (!res.ok) {
    return { code: "icon_http_error", icon_url: iconUrl, detail: `The listing icon ${iconUrl} answered HTTP ${res.status}.`, fix };
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ICON_CONTENT_TYPES.has(contentType)) {
    return {
      code: "icon_unsupported_type",
      icon_url: iconUrl,
      detail: `The listing icon ${iconUrl} is served as ${contentType || "an unknown type"}, not a JPEG, PNG, WebP, or GIF image.`,
      fix,
    };
  }
  return undefined;
}

function unavailable(capability: string, url: string, slug: string, detail: string): X402RouteListing {
  return { capability, url, status: "check_unavailable", detail: `${detail} Retry later with \`dvmctl x402 listing-check ${slug}\`.` };
}

/** Whether the challenge Coinbase decoded carries a bazaar extension, whatever its checks say. */
function hasBazaarExtension(body: Record<string, unknown>): boolean {
  if (isRecord(body.bazaarExtension)) return true;
  const requirements = body.paymentRequirements;
  return isRecord(requirements) && isRecord(requirements.extensions) && isRecord(requirements.extensions.bazaar);
}

async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (!isRecord(body)) return undefined;
    const message = body.errorMessage ?? body.message ?? body.error;
    return typeof message === "string" && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The status and headers are already read; an unread body is harmless.
  }
}

function toProblem(item: PreflightItem): X402ListingProblem {
  const fix = FIXES[item.check];
  return { check: item.check, severity: item.severity, detail: item.detail, ...(fix ? { fix } : {}) };
}

function isPreflightItem(value: unknown): value is PreflightItem {
  return (
    isRecord(value) &&
    typeof value.check === "string" &&
    typeof value.detail === "string" &&
    typeof value.passed === "boolean" &&
    typeof value.severity === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

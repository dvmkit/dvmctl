// Validator response shapes as observed from Coinbase's x402 validate endpoint:
// 25 preflight items of `{check, detail, passed, severity}`, in Coinbase's order.

const CHECKS = [
  "url_valid",
  "url_https",
  "endpoint_reachable",
  "returns_402",
  "valid_json",
  "x402_version",
  "payment_required_header",
  "has_accepts",
  "accepts[0].scheme",
  "accepts[0].network",
  "accepts[0].asset",
  "accepts[0].amount",
  "accepts[0].payTo",
  "accepts[0].maxTimeoutSeconds",
  "has_resource",
  "has_bazaar_extension",
  "bazaar.info",
  "bazaar.info.input",
  "bazaar.info.input.type",
  "bazaar.info.input.method",
  "bazaar.info.input.method.matches_request",
  "bazaar.info.output",
  "bazaar.info.output.example",
  "bazaar.schema",
  "parse",
];
const ADVISORY_CHECKS = new Set(["bazaar.info.output", "bazaar.info.output.example"]);

export interface PreflightFixture {
  check: string;
  detail: string;
  passed: boolean;
  severity: "required" | "advisory";
}

/**
 * The 25 preflight items with every check passing, then `failures` applied.
 * After a failing check named in `skipAfter`, every later check is
 * `Skipped: <reason>` and failed, as Coinbase reports it.
 */
export function preflight(
  failures: Record<string, string> = {},
  skipAfter?: { check: string; reason: string }
): PreflightFixture[] {
  let skipping = false;
  return CHECKS.map((check) => {
    const severity = ADVISORY_CHECKS.has(check) ? "advisory" : "required";
    if (skipping) return { check, detail: `Skipped: ${skipAfter?.reason ?? ""}`, passed: false, severity };
    if (skipAfter?.check === check) skipping = true;
    const detail = failures[check];
    return detail === undefined
      ? { check, detail: "ok", passed: true, severity }
      : { check, detail, passed: false, severity };
  });
}

export function listedResponse(opts: { iconUrl?: string; failures?: Record<string, string>; index?: unknown } = {}) {
  return {
    valid: true,
    statusCode: 402,
    x402Version: 2,
    simulation: { outcome: "accepted" },
    preflight: preflight(opts.failures),
    paymentRequirements: {
      x402Version: 2,
      resource: {
        url: "https://alice--weather.dvmkit.ai/v1/x402/forecast",
        description: "Seven-day forecast for a city.",
        mimeType: "application/json",
        ...(opts.iconUrl ? { iconUrl: opts.iconUrl } : {}),
      },
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", maxTimeoutSeconds: 55 }],
      extensions: { bazaar: { info: { input: { type: "http", method: "POST" } }, schema: {} } },
    },
    bazaarExtension: { info: {}, schema: {} },
    index: "index" in opts ? opts.index : { active: true, lastCrawledAt: "2026-11-10T17:39:05.778Z" },
  };
}

export function rejectedResponse(preflightItems: PreflightFixture[], extra: Record<string, unknown> = {}) {
  return {
    valid: false,
    statusCode: 402,
    x402Version: 2,
    simulation: { outcome: "rejected", rejectionReason: "preflight failed" },
    preflight: preflightItems,
    ...extra,
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn(), progress: vi.fn() }));
vi.mock("../resolve-dvm", () => ({ resolveDvm: vi.fn() }));

import { info, json, progress } from "../../../shared/output";
import { resolveDvm } from "../resolve-dvm";
import { checkX402Listing, X402_VALIDATOR_URL, x402ListingCheck } from "../x402-listing";
import { listedResponse, preflight, rejectedResponse } from "./x402-validator-fixtures";

const DVM_URL = "https://alice--weather.dvmkit.ai";
const ROUTE_URL = `${DVM_URL}/v1/x402/forecast`;
const ICON_URL = "https://cdn.example.com/weather.png";

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Route a stubbed `fetch` by URL; any unexpected URL fails the test. */
function stubFetch(routes: Record<string, Handler>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const infoWith = (capabilities: Record<string, { url: string }> | undefined) => () =>
  jsonResponse({ name: "weather", ...(capabilities ? { x402_capabilities: capabilities } : {}) });

const oneRoute = { forecast: { url: ROUTE_URL } };

async function check() {
  const report = await checkX402Listing(DVM_URL, "weather");
  if (report.status !== "checked") throw new Error("expected a checked report");
  return report;
}

function validatorCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === X402_VALIDATOR_URL);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkX402Listing", () => {
  it("does nothing for a DVM without x402 routes", async () => {
    const fetchMock = stubFetch({ [`${DVM_URL}/v1/info`]: infoWith(undefined) });

    await expect(checkX402Listing(DVM_URL, "weather")).resolves.toEqual({ status: "checked", routes: [] });
    expect(validatorCalls(fetchMock)).toHaveLength(0);
  });

  it("asks the validator about each route once, unauthenticated, with the route URL as the resource", async () => {
    const second = `${DVM_URL}/v1/x402/alerts`;
    const fetchMock = stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith({ forecast: { url: ROUTE_URL }, alerts: { url: second } }),
      [X402_VALIDATOR_URL]: () => jsonResponse(listedResponse()),
    });

    const report = await check();

    const calls = validatorCalls(fetchMock);
    expect(calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { resource: ROUTE_URL, method: "POST" },
      { resource: second, method: "POST" },
    ]);
    for (const [, init] of calls) {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(report?.routes.map((r) => [r.capability, r.status])).toEqual([
      ["forecast", "listed"],
      ["alerts", "listed"],
    ]);
  });

  it("reports a valid route as listed with its index state and the upkeep note", async () => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse(listedResponse()),
    });

    const report = await check();

    expect(report?.routes[0]).toEqual({
      capability: "forecast",
      url: ROUTE_URL,
      status: "listed",
      index: { active: true, last_crawled_at: "2026-11-10T17:39:05.778Z" },
    });
    expect(report?.note).toBeDefined();
  });

  it("keeps a valid route listed but reports its failed advisory check with the fix", async () => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () =>
        jsonResponse(listedResponse({ failures: { "bazaar.info.output.example": "No output example provided" } })),
    });

    const route = (await check())?.routes[0];

    expect(route?.status).toBe("listed");
    expect(route?.problems).toEqual([
      {
        check: "bazaar.info.output.example",
        severity: "advisory",
        detail: "No output example provided",
        fix: "Add `outputExample` to the listing.",
      },
    ]);
  });

  it("reports a listed route that fails a required check as listed_with_problems, with every failed check", async () => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () =>
        jsonResponse(
          rejectedResponse(
            preflight({
              "accepts[0].amount": "Amount 500 is below the minimum of 1000",
              "bazaar.info.output": "No output declared",
            })
          )
        ),
    });

    const report = await check();
    const route = report?.routes[0];

    expect(route?.status).toBe("listed_with_problems");
    expect(route?.problems?.map((p) => [p.check, p.severity, Boolean(p.fix)])).toEqual([
      ["accepts[0].amount", "required", true],
      ["bazaar.info.output", "advisory", true],
    ]);
    expect(report?.note).toBeDefined();
  });

  it("reports an unlisted x402 route as not_listed with a neutral hint and no listing problems", async () => {
    const reason = "endpoint has no bazaar extension";
    const items = preflight({ has_bazaar_extension: "No bazaar extension in PAYMENT-REQUIRED" });
    // An absent listing fails every listing check that follows.
    for (const item of items.slice(items.findIndex((i) => i.check === "bazaar.info"))) {
      Object.assign(item, { passed: false, detail: `Skipped: ${reason}` });
    }
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse(rejectedResponse(items)),
    });

    const report = await check();
    const route = report?.routes[0];

    expect(route?.status).toBe("not_listed");
    expect(route?.problems).toBeUndefined();
    expect(route?.hint).toBeDefined();
    expect(report?.note).toBeUndefined();
  });

  it("reports a private or unresolvable host as unreachable, keeping Coinbase's reason", async () => {
    const reason = "URL must be a public, allowed HTTPS endpoint";
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () =>
        jsonResponse(
          rejectedResponse(
            preflight({ endpoint_reachable: `Skipped: ${reason}` }, { check: "endpoint_reachable", reason })
          )
        ),
    });

    const route = (await check())?.routes[0];

    expect(route?.status).toBe("unreachable");
    expect(route?.problems).toEqual([
      expect.objectContaining({ check: "endpoint_reachable", detail: `Skipped: ${reason}`, fix: expect.any(String) }),
    ]);
  });

  it("reports a route that does not answer 402 as not_x402", async () => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () =>
        jsonResponse(
          rejectedResponse(
            preflight(
              { returns_402: "Endpoint returned HTTP 308 instead of 402" },
              { check: "returns_402", reason: "endpoint did not return 402" }
            )
          )
        ),
    });

    const route = (await check())?.routes[0];

    expect(route?.status).toBe("not_x402");
    expect(route?.problems).toEqual([
      expect.objectContaining({ check: "returns_402", detail: "Endpoint returned HTTP 308 instead of 402", fix: expect.stringMatching(/402/) }),
    ]);
  });

  it.each([
    ["a 5xx", () => new Response("upstream error", { status: 503 })],
    ["a rate limit", () => new Response("slow down", { status: 429 })],
    ["a request timeout", () => new Response("timeout", { status: 408 })],
    ["an unparseable body", () => new Response("<html>gateway</html>", { status: 200 })],
    ["a body without preflight checks", () => jsonResponse({ valid: false })],
    [
      "a timeout",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    ],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("reports %s from the validator as check_unavailable for that route only", async (_label, failing) => {
    let call = 0;
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith({ forecast: { url: ROUTE_URL }, alerts: { url: `${DVM_URL}/v1/x402/alerts` } }),
      [X402_VALIDATOR_URL]: () => (call++ === 0 ? failing() : jsonResponse(listedResponse())),
    });

    const report = await check();

    expect(report?.routes.map((r) => r.status)).toEqual(["check_unavailable", "listed"]);
    expect(report?.routes[0]?.detail).toContain("dvmctl x402 listing-check weather");
  });

  it("reports Coinbase's reason for a rejected request without advising a retry", async () => {
    const reason = 'resource: string doesn\'t match the pattern "^https://.*$"';
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse({ errorType: "invalid_request", errorMessage: reason }, 400),
    });

    const route = (await check()).routes[0];

    expect(route?.status).toBe("check_unavailable");
    expect(route?.detail).toContain(reason);
    expect(route?.detail).not.toMatch(/retry/i);
  });

  it("does not send a non-HTTPS route to the validator and says why", async () => {
    const fetchMock = stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith({ forecast: { url: "http://alice--weather.dvmkit.ai/v1/x402/forecast" } }),
    });

    const route = (await check()).routes[0];

    expect(validatorCalls(fetchMock)).toHaveLength(0);
    expect(route?.status).toBe("unreachable");
    expect(route?.problems).toEqual([expect.objectContaining({ check: "url_https", fix: expect.any(String) })]);
  });

  it.each(["valid_json", "x402_version", "payment_required_header"])(
    "reports a 402 whose %s check fails as a broken challenge, not as unlisted",
    async (check402) => {
      const reason = "earlier check failed";
      stubFetch({
        [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
        [X402_VALIDATOR_URL]: () =>
          jsonResponse(rejectedResponse(preflight({ [check402]: `${check402} is invalid` }, { check: check402, reason }))),
      });

      const route = (await check()).routes[0];

      expect(route?.status).toBe("challenge_invalid");
      expect(route?.hint).toBeUndefined();
      expect(route?.problems).toEqual([expect.objectContaining({ check: check402, severity: "required" })]);
    }
  );

  it("keeps a route whose challenge carries a bazaar extension listed_with_problems when later checks were skipped", async () => {
    const reason = "earlier check failed";
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () =>
        jsonResponse(
          rejectedResponse(
            preflight({ x402_version: "x402Version 3 is not supported" }, { check: "x402_version", reason }),
            { bazaarExtension: { info: {}, schema: {} } }
          )
        ),
    });

    const route = (await check()).routes[0];

    expect(route?.status).toBe("listed_with_problems");
    expect(route?.problems?.map((p) => p.check)).toEqual(["x402_version"]);
  });

  it.each([
    ["no index entry", null],
    ["an inactive index entry", { active: false, lastCrawledAt: "2026-11-01T00:00:00.000Z" }],
  ])("says a valid route with %s is not indexed yet", async (_label, index) => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse(listedResponse({ index })),
    });

    const route = (await check()).routes[0];

    expect(route?.status).toBe("listed");
    expect(route?.hint).toMatch(/first paid call/);
  });

  it.each([
    ["404", () => new Response("not found", { status: 404 }), "icon_http_error"],
    ["image/svg+xml", () => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }), "icon_unsupported_type"],
    [
      "a timeout",
      () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
      "icon_unreachable",
    ],
  ])("warns when the listing icon answers %s", async (_label, iconResponse, code) => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse(listedResponse({ iconUrl: ICON_URL })),
      [ICON_URL]: iconResponse,
    });

    const route = (await check())?.routes[0];

    expect(route?.status).toBe("listed");
    expect(route?.icon_warning).toMatchObject({ code, icon_url: ICON_URL });
  });

  it("accepts an icon served as a raster image with a charset parameter", async () => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse(listedResponse({ iconUrl: ICON_URL })),
      [ICON_URL]: () => new Response("png", { status: 200, headers: { "content-type": "image/png; charset=binary" } }),
    });

    const route = (await check())?.routes[0];

    expect(route?.icon_warning).toBeUndefined();
  });

  it("throws x402_info_unavailable when /v1/info cannot be read", async () => {
    stubFetch({ [`${DVM_URL}/v1/info`]: () => new Response("down", { status: 502 }) });

    await expect(checkX402Listing(DVM_URL, "weather")).rejects.toMatchObject({ code: "x402_info_unavailable" });
  });
});

describe("dvmctl x402 listing-check", () => {
  beforeEach(() => {
    vi.mocked(resolveDvm).mockResolvedValue({
      dvmId: "dvm-1",
      dvmkitUrl: DVM_URL,
      platformUrl: "https://platform.example",
      token: "secret-token",
    });
  });

  it("resolves the slug through the platform and prints the same report as JSON, without the platform token", async () => {
    const fetchMock = stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse(listedResponse()),
    });

    await x402ListingCheck("weather", { org: "alice" });

    expect(resolveDvm).toHaveBeenCalledWith("weather", { org: "alice" });
    expect(json).toHaveBeenCalledWith({
      slug: "weather",
      dvmkitUrl: DVM_URL,
      x402_listing: expect.objectContaining({
        status: "checked",
        routes: [expect.objectContaining({ capability: "forecast", url: ROUTE_URL, status: "listed" })],
      }),
    });
    expect(progress).toHaveBeenCalledWith({ event: "x402_listing_check", routes: 1 });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret-token");
  });

  it("prints human lines with --human", async () => {
    stubFetch({
      [`${DVM_URL}/v1/info`]: infoWith(oneRoute),
      [X402_VALIDATOR_URL]: () => jsonResponse(listedResponse()),
    });

    await x402ListingCheck("weather", { human: true });

    const lines = vi.mocked(info).mock.calls.map(([line]) => line);
    expect(lines).toContain(`  forecast: listed (${ROUTE_URL})`);
    expect(json).not.toHaveBeenCalled();
  });

  it("refuses a DVM with no public URL", async () => {
    vi.mocked(resolveDvm).mockResolvedValueOnce({
      dvmId: "dvm-1",
      dvmkitUrl: null,
      platformUrl: "https://platform.example",
      token: "t",
    });

    await expect(x402ListingCheck("weather", {})).rejects.toMatchObject({
      code: "dvm_url_unset",
      hint: expect.not.stringContaining("--endpoint"),
    });
  });
});

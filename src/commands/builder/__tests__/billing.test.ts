import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/platform.ts")>(),
  requireAuth: () => ({ platformUrl: "https://platform.example", token: "test-key" }),
}));
const outputTrace = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("../../../shared/output.ts", () => ({
  json: vi.fn(), info: vi.fn(),
  getOutputTraceId: () => outputTrace.current,
  setOutputTraceId: (trace: string | null) => { outputTrace.current = trace; },
}));
vi.mock("../resolve-dvm.ts", () => ({ resolveDvm: vi.fn(async () => ({
  platformUrl: "https://platform.example", token: "test-key", dvmId: "app-id", dvmkitUrl: null,
})) }));
vi.mock("../db-proxy.ts", () => ({ startDbProxy: vi.fn(), buildDatabaseUrl: () => "postgres://readonly@127.0.0.1:1234/app" }));
vi.mock("../../../lib/keep-alive.ts", () => ({ blockUntilShutdown: vi.fn(async () => {}) }));

import { getOutputTraceId, info, json } from "../../../shared/output.ts";
import { getBillingState } from "../../../lib/billing-client.ts";
import { mapHandshakeError } from "../../../lib/db-tunnel-client.ts";
import { blockUntilShutdown } from "../../../lib/keep-alive.ts";
import { saveActiveOrg } from "../../../lib/platform.ts";
import { resumeDvm, scaleDvm, startDeploy } from "../../../lib/platform-client.ts";
import { startDbProxy } from "../db-proxy.ts";
import { billingCheckout, billingStatus, billingTopup, budgetGet, budgetSet, invoiceStatus, planPurchase, planQuote, planStatus, topupStatus, trialExport, trialRestore } from "../billing.ts";

const path = "/api/v1/builder/billing";
const ctx = { platformUrl: "https://platform.example", token: "test-key" };
const requestKey = "saved-request-01";
const budget = { state: "paused", version: 2, limit_cents: 1000, actual_cents: 900, reserved_cents: 100,
  display: "Your monthly hosting budget has been reached.", hint: "Reserved spend has not been charged." };
const quote = { id: "quote-1", state: "quoted", quote: { currency: "USD", payableCents: 1200, expiresAt: 2000000000000, kind: "purchase" } };
const topup = { id: "topup-1", state: "invoiced", requestKey, billingAccountId: "account-1", bolt11: "lnbc-test",
  paymentHash: "hash", providerExpiresAt: 2000000000000,
  quote: { usdCents: 1000, nativeSats: 10000, nativeMsats: 10000000, expiresAt: 2000000000000 } };
const invoice = { invoiceId: "invoice-1", bolt11: "lnbc-test", amountSats: 15000, amountCents: 1500, expiresAt: 2000000000000 };
const state = {
  version: 1, display: "Hosting is restricted.", hint: "Read every active reason.",
  period: { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", coverage: "complete" },
  usage: { breakdown: { app: { minor_units: 125, currency: "USD", basis: "estimated" } } },
  restrictions: { coverage: "complete", items: [
    { reason: "payment", deadline_at: "2026-10-23T00:00:00.000Z", next_actions: [{ code: "settle_card", display: "Settle the card balance.", hint: "Open billing." }] },
    { reason: "eligibility", next_actions: [{ code: "upgrade_plan", display: "Upgrade your plan.", hint: "Inspect a quote." }] },
    { reason: "customer_budget", next_actions: [{ code: "raise_or_remove_budget" }] },
  ] },
  trial: { state: "expired", limit_fired: "credit", recovery_deadline_at: "2026-10-25T00:00:00.000Z",
    recovery: { available: true, data: "managed_database", export: { route: "/api/v1/builder/dvms/app-id/db-tunnel", display: "Export your database." },
      restore: { route: "/api/v1/builder/dvms/app-id/trial-restore", display: "Restore after purchase." },
      purchase: { stripe: "/api/v1/builder/billing/checkout", lightning: "/api/v1/builder/billing/lightning/checkout" } },
    display: "Your trial hosting credit has been used.", hint: "Export or purchase before the recovery deadline." },
};
const reply = (body: unknown, status = 200, trace?: string) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...(trace ? { traceparent: `00-${trace}-1234567890abcdef-01` } : {}) },
});
function sent(index = 0) {
  const [url, init] = vi.mocked(fetch).mock.calls[index]!;
  const opts = init!;
  return { url: String(url), method: opts.method ?? "GET", headers: new Headers(opts.headers),
    body: opts.body ? JSON.parse(String(opts.body)) as unknown : undefined };
}

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "dvmctl-billing-"));
  vi.stubEnv("DVMCTL_CONFIG_DIR", configDir);
  outputTrace.current = null;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

describe("billing command HTTP contracts", () => {
  it.each([
    ["state", () => billingStatus({}), `${path}/state`, state],
    ["budget", () => budgetGet({ org: "team" }), `/api/v1/builder/orgs/team/billing/budget`, budget],
    ["top-up status", () => topupStatus("topup-1", {}), `${path}/hosting/topups/topup-1`, topup],
    ["invoice status", () => invoiceStatus("invoice-1", {}), `${path}/lightning/invoice/invoice-1`, { ...invoice, status: "payment_recovery", display: "Payment received; applying your plan." }],
    ["plan status", () => planStatus("quote-1", {}), `${path}/plan-change/quote-1`, quote],
  ] as const)("%s inspection makes only one GET", async (_name, run, route, response) => {
    vi.mocked(fetch).mockResolvedValue(reply(response));
    await run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ url: `${ctx.platformUrl}${route}`, method: "GET", body: undefined });
    expect(sent().headers.get("Authorization")).toBe("Bearer test-key");
    expect(json).toHaveBeenCalledWith(expect.objectContaining(response));
  });

  it("quotes in the platform currency without buying", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ...quote, quote: { ...quote.quote, currency: "EUR" } }));
    await planQuote("studio-monthly", { requestKey });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ method: "POST", url: `${ctx.platformUrl}${path}/plan-change/quote`,
      body: { targetPlanId: "studio-monthly", requestKey } });
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ display: expect.stringContaining("€12.00") }));
  });

  it("sends budget and top-up replay keys with the observed version and requested amount", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => reply(String(url).endsWith("/budget") ? budget : topup));
    await budgetSet("1000", { expectedVersion: "1", idempotencyKey: requestKey, org: "team" });
    await billingTopup("1000", { idempotencyKey: requestKey });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent()).toMatchObject({ method: "PUT", body: { expected_version: 1, limit_cents: 1000 } });
    expect(sent().headers.get("Idempotency-Key")).toBe(requestKey);
    expect(sent(1)).toMatchObject({ method: "POST", body: { usdCents: 1000 } });
    expect(sent(1).headers.get("Idempotency-Key")).toBe(requestKey);
  });

  it("removes a budget explicitly using null and the observed version", async () => {
    vi.mocked(fetch).mockResolvedValue(reply(budget));
    await budgetSet("none", { expectedVersion: "2", idempotencyKey: requestKey });
    expect(sent().body).toEqual({ expected_version: 2, limit_cents: null });
  });

  it("reads the saved quote before purchasing and offers its status command", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, init) => reply(init?.method === "POST" ? { ...invoice, id: "quote-1", rail: "lightning", amountCents: 1200, fiatCurrency: "usd", planUsdCents: 1900 } : quote));
    await planPurchase("quote-1", { rail: "lightning" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent()).toMatchObject({ method: "GET", url: `${ctx.platformUrl}${path}/plan-change/quote-1` });
    expect(sent(1)).toMatchObject({ method: "POST", url: `${ctx.platformUrl}${path}/plan-change/quote-1/purchase`, body: { rail: "lightning" } });
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ invoiceId: "invoice-1", expiresAt: invoice.expiresAt,
      display: "$19.00 USD plan value before credit; $12.00 invoice value; Lightning invoice 15000 sats (Bitcoin units); expires at 2033-05-18T03:33:20.000Z.", amount_display: "$12.00",
      continuation: expect.objectContaining({ status_command: ["dvmctl", "billing", "plan", "status", "quote-1"] }) }));
  });

  it("surfaces Stripe checkout as a hosted continuation, never paid", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ url: "https://checkout.example/session" }));
    await billingCheckout("builder-monthly", { rail: "stripe", org: "team" });
    expect(sent()).toMatchObject({ method: "POST", url: `${ctx.platformUrl}/api/v1/builder/orgs/team/billing/checkout`, body: { planId: "builder-monthly" } });
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ continuation: { url: "https://checkout.example/session", invoice_id: null,
      status_command: ["dvmctl", "billing", "status", "--org", "team"] } }));
  });

  it("resumes interrupted Lightning checkout with invoice GET instead of another checkout", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply(invoice)).mockResolvedValueOnce(reply({ ...invoice, status: "pending" }));
    await billingCheckout("builder-monthly", { rail: "lightning", months: "3" });
    const output = vi.mocked(json).mock.calls[0]![0] as { continuation: { invoice_id: string; status_command: string[] }; display: string };
    expect(output.display).toContain("15000 sats");
    expect(output.continuation.status_command).toEqual(["dvmctl", "billing", "invoice", "invoice-1"]);
    await invoiceStatus(output.continuation.invoice_id, {});
    expect(sent().body).toEqual({ planId: "builder-monthly", months: 3 });
    expect(sent(1)).toMatchObject({ method: "GET", url: `${ctx.platformUrl}${path}/lightning/invoice/invoice-1` });
  });

  it.each([
    ["checkout", true], ["checkout", false], ["invoice", true], ["invoice", false],
  ] as const)("%s labels new currency fields or explicitly reports an unstated currency (fields present: %s)", async (command, fieldsPresent) => {
    const response = { ...invoice, ...(fieldsPresent ? { fiatCurrency: "gbp", planUsdCents: 1900 } : {}) };
    vi.mocked(fetch).mockResolvedValue(reply(response));
    if (command === "checkout") await billingCheckout("builder-monthly", { rail: "lightning" });
    else await invoiceStatus("invoice-1", {});
    expect(json).toHaveBeenCalledWith(expect.objectContaining(fieldsPresent
      ? { fiatCurrency: "gbp", planUsdCents: 1900, amountCents: 1500, amount_display: "£15.00", plan_usd_display: "$19.00" }
      : { amountCents: 1500, amount_display: "1500 minor units (currency unstated)", hint: expect.stringContaining("currency is unstated") }));
  });

  it.each([
    ["checkout", "us"], ["invoice", "us"], ["checkout", "zzz"], ["invoice", "zzz"],
  ])("%s retains the invoice id and raw minor units when fiatCurrency is invalid (%s)", async (command, currency) => {
    vi.mocked(fetch).mockResolvedValue(reply({ ...invoice, fiatCurrency: currency }));
    if (command === "checkout") await billingCheckout("builder-monthly", { rail: "lightning" });
    else await invoiceStatus("invoice-1", {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: "invoice-1", fiatCurrency: currency, amountCents: 1500,
      amount_display: `1500 minor units (currency: ${currency})`,
      continuation: expect.objectContaining({ invoice_id: "invoice-1" }),
    }));
  });

  it("keeps an unknown USD plan price null and formats zero-decimal invoice currency in its minor units", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ...invoice, fiatCurrency: "jpy", planUsdCents: null }));
    await invoiceStatus("invoice-1", {});
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ amount_display: "¥1,500", planUsdCents: null, plan_usd_display: null }));
  });

  it.each([
    () => budgetSet("1.5", { expectedVersion: "1", idempotencyKey: requestKey }),
    () => budgetSet("1000", { expectedVersion: "-1", idempotencyKey: requestKey }),
    () => billingTopup("999", { idempotencyKey: requestKey }),
    () => billingTopup("1000", { idempotencyKey: "short" }),
    () => planQuote("builder-monthly", {}),
    () => billingCheckout("builder-monthly", { rail: "lightning", months: "2" }),
  ])("rejects invalid money or replay arguments before HTTP", async (run) => {
    await expect(run()).rejects.toMatchObject({ code: "bad_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    () => planQuote("studio-monthly", { org: "team", requestKey }),
    () => planPurchase("quote-1", { org: "team", rail: "stripe" }),
    () => invoiceStatus("invoice-1", { org: "team" }),
    () => billingCheckout("builder-monthly", { org: "team", rail: "lightning" }),
  ])("refuses unsupported organisation selection before money can go to the wrong account", async (run) => {
    await expect(run()).rejects.toMatchObject({ code: "billing_scope_unsupported" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["quote", () => planQuote("studio-monthly", { requestKey })],
    ["purchase", () => planPurchase("quote-1", { rail: "stripe" })],
    ["plan status", () => planStatus("quote-1", {})],
    ["invoice", () => invoiceStatus("invoice-1", {})],
    ["checkout", () => billingCheckout("builder-monthly", { rail: "lightning" })],
  ] as const)("%s explains how to clear a saved org before any HTTP request", async (_name, run) => {
    saveActiveOrg("team");
    await expect(run()).rejects.toMatchObject({
      code: "billing_scope_unsupported", hint: expect.stringContaining("dvmctl switch --personal"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the saved org for card checkout and its continuation", async () => {
    saveActiveOrg("team");
    vi.mocked(fetch).mockResolvedValue(reply({ url: "https://checkout.example/session" }));
    await billingCheckout("builder-monthly", { rail: "stripe" });
    expect(sent().url).toBe(`${ctx.platformUrl}/api/v1/builder/orgs/team/billing/checkout`);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ continuation: expect.objectContaining({
      status_command: ["dvmctl", "billing", "status", "--org", "team"],
    }) }));
  });

  it("rejects a newer billing contract with an upgrade instruction", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ...state, version: 2 }));
    await expect(getBillingState(ctx)).rejects.toMatchObject({ code: "billing_version_unsupported", hint: expect.stringContaining("Upgrade dvmctl") });
  });

  it("keeps an explicit organisation-scope refusal distinct from a missing feature", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ error: { code: "org_not_found", message: "Organisation not found." } }, 404));
    await expect(billingStatus({ org: "missing" })).rejects.toMatchObject({ code: "org_not_found", message: "Organisation not found." });
  });

  it("leaves the default subscription term to the platform for yearly checkout", async () => {
    vi.mocked(fetch).mockResolvedValue(reply(invoice));
    await billingCheckout("builder-yearly", { rail: "lightning" });
    expect(sent().body).toEqual({ planId: "builder-yearly" });
  });

  it.each([
    ["quote", () => planStatus("missing", {})],
    ["invoice", () => invoiceStatus("missing", {})],
    ["top-up", () => topupStatus("missing", {})],
  ] as const)("reports an unknown %s id as not found", async (_name, run) => {
    vi.mocked(fetch).mockResolvedValue(reply({ error: { code: "not_found" } }, 404));
    await expect(run()).rejects.toMatchObject({ code: "not_found", message: "Billing resource not found." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["quote", () => planStatus("missing", {})],
    ["invoice", () => invoiceStatus("missing", {})],
    ["top-up", () => topupStatus("missing", {})],
  ] as const)("reports a plain-text %s status 404 as an unavailable platform feature", async (_name, run) => {
    vi.mocked(fetch).mockResolvedValue(new Response("Not Found", { status: 404 }));
    await expect(run()).rejects.toMatchObject({ code: "billing_not_available", message: expect.stringContaining("not available on this platform") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains a missing route on an older platform", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("404 Not Found", { status: 404 }));
    await expect(billingStatus({})).rejects.toMatchObject({ code: "billing_not_available", message: expect.stringContaining("not available on this platform") });
  });
});

function humanText(): string {
  return vi.mocked(info).mock.calls.map(([line]) => line).join("\n");
}

describe("human billing output", () => {
  const trace = "3".repeat(32);

  it("renders billing sections, all restrictions and next actions with their deadlines", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ...state,
      plan: { display: "Builder plan.", hint: "Plan renews monthly." },
      usage: { display: "$1.25 estimated usage.", hint: "Usage can change." },
      budget,
    }, 200, trace));
    await billingStatus({ human: true });
    const text = humanText();
    for (const detail of ["Hosting is restricted.", "Builder plan.", "Plan renews monthly.", "$1.25 estimated usage.",
      "Usage can change.", "2026-10-01", "2026-11-01", "payment", "eligibility", "customer_budget",
      "Settle the card balance.", "Open billing.", "Upgrade your plan.", "raise_or_remove_budget", "2026-10-23",
      "Your monthly hosting budget has been reached.", "expired", "2026-10-25", "Export your database.",
      "Restore after purchase.", `Trace ID: ${trace}`]) expect(text).toContain(detail);
    expect(text.trimStart()).not.toMatch(/^\{/);
    expect(json).not.toHaveBeenCalled();
  });

  it("keeps unknown budget amounts and incomplete restriction coverage explicit", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ...state,
      restrictions: { coverage: "unknown", items: [] },
      budget: { ...budget, limit_cents: null, actual_cents: null, reserved_cents: null, coverage: "unknown" },
    }));
    await billingStatus({ human: true });
    expect(humanText()).toContain("Restriction coverage: unknown");
    expect(humanText()).toContain("Actual: unknown");
    expect(humanText()).toContain("Reserved: unknown");
    expect(humanText()).not.toContain("$0.00");
    expect(humanText()).not.toContain("No restrictions");
  });

  it("retains invoice details beside platform status prose and quotes continuation arguments", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ ...invoice, fiatCurrency: "gbp", planUsdCents: 1900,
      status: "payment_recovery", display: "Payment received; applying your plan." }));
    await invoiceStatus("invoice; echo unsafe", { human: true });
    const text = humanText();
    expect(text).toContain("Payment received; applying your plan.");
    expect(text).toContain("payment_recovery");
    expect(text).toContain("£15.00");
    expect(text).toContain("$19.00");
    expect(text).toContain("2033-05-18T03:33:20.000Z");
    expect(text).toContain("Check status: dvmctl billing invoice 'invoice; echo unsafe'");
  });

  it.each([
    ["budget get", () => budgetGet({ human: true }), [budget], ["$10.00", "$9.00", "$1.00", "Version: 2"]],
    ["budget set", () => budgetSet("1000", { human: true, expectedVersion: "1", idempotencyKey: requestKey }),
      [budget], ["$10.00", "Version: 2", requestKey]],
    ["topup", () => billingTopup("1000", { human: true, idempotencyKey: requestKey }), [topup],
      ["$10.00", "10000 sats", "lnbc-test", "dvmctl billing topup-status topup-1", requestKey]],
    ["topup-status", () => topupStatus("topup-1", { human: true }), [topup],
      ["invoiced", "lnbc-test", "dvmctl billing topup-status topup-1"]],
    ["invoice", () => invoiceStatus("invoice-1", { human: true }), [{ ...invoice, status: "pending" }],
      ["pending", "lnbc-test", "currency unstated", "dvmctl billing invoice invoice-1"]],
    ["checkout", () => billingCheckout("builder-monthly", { human: true, rail: "stripe", org: "team" }),
      [{ url: "https://checkout.example/session" }], ["https://checkout.example/session", "dvmctl billing status --org team"]],
    ["plan quote", () => planQuote("studio-monthly", { human: true, requestKey }), [quote],
      ["$12.00", "quote-1", requestKey, "2033-05-18T03:33:20.000Z"]],
    ["plan purchase", () => planPurchase("quote-1", { human: true, rail: "lightning" }), [quote, invoice],
      ["$15.00", "lnbc-test", "dvmctl billing plan status quote-1"]],
    ["plan status", () => planStatus("quote-1", { human: true }), [quote], ["quoted", "quote-1"]],
    ["trial restore", () => trialRestore("app", { human: true }), [{ restored: true, display: "Restored." }],
      ["Restored.", "app"]],
  ] as const)("%s prints actionable prose instead of a JSON object", async (_name, run, responses, details) => {
    for (const response of responses) vi.mocked(fetch).mockResolvedValueOnce(reply(response, 200, trace));
    await run();
    const text = humanText();
    for (const detail of details) expect(text).toContain(detail);
    expect(text).toContain(`Trace ID: ${trace}`);
    expect(text.trimStart()).not.toMatch(/^\{/);
    expect(json).not.toHaveBeenCalled();
  });

  it("keeps trial export usable while the process holds the read-only tunnel open", async () => {
    vi.mocked(fetch).mockResolvedValue(reply(state, 200, trace));
    const proxy = { port: 1234, ready: { user: "readonly", password: "test", database: "app" }, close: vi.fn() };
    vi.mocked(startDbProxy).mockResolvedValue(proxy);
    await trialExport("app", { human: true });
    const text = humanText();
    expect(text).toContain("postgres://readonly@127.0.0.1:1234/app");
    expect(text).toContain("2026-10-25T00:00:00.000Z");
    expect(text).toContain("pg_dump");
    expect(text).toContain("Keep this process running");
    expect(text).toContain(`Trace ID: ${trace}`);
    expect(text.trimStart()).not.toMatch(/^\{/);
    expect(json).not.toHaveBeenCalled();
    expect(blockUntilShutdown).toHaveBeenCalledOnce();
    expect(vi.mocked(blockUntilShutdown).mock.calls[0]![0]()).toBe(proxy);
  });
});

describe("trial recovery", () => {
  it("opens the existing database tunnel only after reading canonical recovery access", async () => {
    vi.mocked(fetch).mockResolvedValue(reply(state));
    vi.mocked(startDbProxy).mockResolvedValue({ port: 1234, ready: { user: "readonly", password: "test", database: "app" }, close: vi.fn() });
    await trialExport("app", {});
    expect(startDbProxy).toHaveBeenCalledWith(expect.objectContaining({ dvmId: "app-id" }), {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent().method).toBe("GET");
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ recovery_deadline_at: "2026-10-25T00:00:00.000Z", database_url: expect.stringContaining("readonly") }));
  });

  it("preserves purchase-required routes and every hold after a refused restore", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply({ error: { code: "purchase_required", message: "Explicitly purchase Builder before restoring hosting.", stripe: `${path}/checkout`, lightning: `${path}/lightning/checkout` } }, 402)).mockResolvedValueOnce(reply(state));
    await expect(trialRestore("app", {})).rejects.toMatchObject({ code: "purchase_required", data: { stripe: `${path}/checkout`, lightning: `${path}/lightning/checkout`, billing_state: state } });
    expect(sent()).toMatchObject({ method: "POST", url: `${ctx.platformUrl}/api/v1/builder/dvms/app-id/trial-restore`, body: undefined });
    expect(sent(1).method).toBe("GET");
  });

  it("reports a closed recovery window without claiming the DVM was destroyed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply({ error: { code: "trial_recovery_closed" } }, 410)).mockResolvedValueOnce(reply(state));
    await expect(trialRestore("app", {})).rejects.toMatchObject({ code: "trial_recovery_closed", message: "The seven-day trial recovery window has closed." });
    expect(mapHandshakeError(410, "app", "trial_recovery_closed").message).toBe("The seven-day trial recovery window has closed.");
  });

  it("names a blocked restore and retains the canonical holds and both request traces", async () => {
    const refusedTrace = "1".repeat(32), billingTrace = "2".repeat(32);
    vi.mocked(fetch).mockResolvedValueOnce(reply({ restored: false, display: "Other restrictions prevent hosting from resuming." }, 409, refusedTrace))
      .mockResolvedValueOnce(reply(state, 200, billingTrace));
    await expect(trialRestore("app", {})).rejects.toMatchObject({ code: "trial_restore_blocked",
      message: "Other restrictions prevent hosting from resuming.",
      data: { restored: false, reasons: state.restrictions.items, billing_state: state, billing_state_trace_id: billingTrace } });
    expect(getOutputTraceId()).toBe(refusedTrace);
  });

  it("keeps the restore refusal and its trace when the billing follow-up fails", async () => {
    const refusedTrace = "1".repeat(32), billingTrace = "2".repeat(32);
    vi.mocked(fetch).mockResolvedValueOnce(reply({ error: { code: "trial_recovery_closed", message: "Recovery ended." } }, 410, refusedTrace))
      .mockResolvedValueOnce(reply({}, 404, billingTrace));
    await expect(trialRestore("app", {})).rejects.toMatchObject({ code: "trial_recovery_closed", message: "Recovery ended.",
      data: { billing_state_error: "billing_not_available", billing_state_trace_id: billingTrace } });
    expect(getOutputTraceId()).toBe(refusedTrace);
  });

  it("preserves a successful restore without resetting trial or buying", async () => {
    vi.mocked(fetch).mockResolvedValue(reply({ restored: true, display: "Restored." }));
    await trialRestore("app", {});
    expect(json).toHaveBeenCalledWith({ restored: true, display: "Restored.", dvmId: "app-id", slug: "app" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("admission refusal relay", () => {
  const refusal = { error: { code: "hosting_restricted", message: "Admission refused.", display: "Hosting is restricted.", hint: "Check billing.", data: { reasons: ["customer_budget", "payment"] } } };
  it.each(["deploy", "scale", "resume"])("%s retains actions when supplied without a billing read", async (operation) => {
    vi.mocked(fetch).mockResolvedValue(reply({ error: { ...refusal.error, options: ["wait", "purchase_builder"] } }, 409));
    const run = () => operation === "deploy" ? startDeploy(ctx.platformUrl, ctx.token, { slug: "app", name: "App" })
      : operation === "scale" ? scaleDvm(ctx.platformUrl, ctx.token, "app-id", { count: 1 }) : resumeDvm(ctx.platformUrl, ctx.token, "app-id");
    await expect(run()).rejects.toMatchObject({ code: "hosting_restricted", display: "Hosting is restricted.", hint: "Check billing.", data: { reasons: ["customer_budget", "payment"], options: ["wait", "purchase_builder"] } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["deploy", "scale", "resume"])("%s reads billing state when no next action was supplied", async (operation) => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const route = String(url);
      if (route.endsWith("/billing/state")) return reply(state);
      if (route.endsWith("/dvms/app-id")) return reply({ dvm: { orgHandle: "team" } });
      return reply(refusal, 409);
    });
    const run = () => operation === "deploy" ? startDeploy(ctx.platformUrl, ctx.token, { slug: "app", name: "App", orgHandle: "team" })
      : operation === "scale" ? scaleDvm(ctx.platformUrl, ctx.token, "app-id", { count: 1 }) : resumeDvm(ctx.platformUrl, ctx.token, "app-id");
    await expect(run()).rejects.toMatchObject({ code: "hosting_restricted", data: { reasons: ["customer_budget", "payment"], billing_state: state } });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/orgs/team/billing/state"))).toBe(true);
  });

  it.each([
    ["deploy", "text", "deploy_failed"], ["deploy", "empty", "deploy_failed"],
    ["scale", "text", "scale_failed"], ["scale", "empty", "scale_failed"],
    ["resume", "text", "resume_failed"], ["resume", "empty", "resume_failed"],
  ])("%s preserves its existing error for a %s 409 body", async (operation, body, code) => {
    vi.mocked(fetch).mockResolvedValue(new Response(body === "text" ? "<html>conflict</html>" : "", { status: 409 }));
    const run = () => operation === "deploy" ? startDeploy(ctx.platformUrl, ctx.token, { slug: "app", name: "App" })
      : operation === "scale" ? scaleDvm(ctx.platformUrl, ctx.token, "app-id", { count: 1 }) : resumeDvm(ctx.platformUrl, ctx.token, "app-id");
    await expect(run()).rejects.toMatchObject({ code, message: expect.stringContaining("409") });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["deploy", "scale", "resume"])("%s does not attach billing to an unrelated conflict", async (operation) => {
    vi.mocked(fetch).mockResolvedValue(reply({ error: { code: "scale_in_progress", message: "A change is in progress.", data: { reasons: ["resource_busy"] } } }, 409));
    const run = () => operation === "deploy" ? startDeploy(ctx.platformUrl, ctx.token, { slug: "app", name: "App" })
      : operation === "scale" ? scaleDvm(ctx.platformUrl, ctx.token, "app-id", { count: 1 }) : resumeDvm(ctx.platformUrl, ctx.token, "app-id");
    await expect(run()).rejects.toMatchObject({ code: "scale_in_progress", message: "A change is in progress." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the original trace while identifying the billing follow-up separately", async () => {
    const refusedTrace = "1".repeat(32), scopeTrace = "2".repeat(32), billingTrace = "3".repeat(32);
    vi.mocked(fetch).mockResolvedValueOnce(reply(refusal, 409, refusedTrace))
      .mockResolvedValueOnce(reply({ dvm: { orgHandle: null } }, 200, scopeTrace))
      .mockResolvedValueOnce(reply(state, 200, billingTrace));
    await expect(scaleDvm(ctx.platformUrl, ctx.token, "app-id", { count: 1 })).rejects.toMatchObject({
      code: "hosting_restricted", data: { billing_state: state, billing_state_trace_id: billingTrace },
    });
    expect(getOutputTraceId()).toBe(refusedTrace);
  });

  it("keeps the original refusal when the follow-up is unavailable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(reply(refusal, 409)).mockResolvedValueOnce(reply({}, 404));
    await expect(startDeploy(ctx.platformUrl, ctx.token, { slug: "app", name: "App" })).rejects.toMatchObject({ code: "hosting_restricted", data: { reasons: ["customer_budget", "payment"], billing_state_error: "billing_not_available" } });
  });
});

import { DvmError, shellQuoteArg } from "@dvmkit/sdk/internal";
import type { Command } from "commander";

import { billingPath, billingRequest, billingStateAfterRefusal, getBillingState, type BillingContext } from "../../lib/billing-client.ts";
import type { BillingState, BudgetSummary, HostingTopup, PaymentResult, PlanQuote, RelayCopy } from "../../lib/billing-types.ts";
import { catchErrors } from "../../lib/error-handler.ts";
import { blockUntilShutdown } from "../../lib/keep-alive.ts";
import { requireAuth, resolveOrgScope } from "../../lib/platform.ts";
import { getOutputTraceId, info, json } from "../../shared/output.ts";
import { buildDatabaseUrl, startDbProxy } from "./db-proxy.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface BillingOptions {
  human?: boolean;
  org?: string;
  idempotencyKey?: string;
  requestKey?: string;
  expectedVersion?: string;
  rail?: string;
  months?: string;
  port?: string;
  machine?: string;
}

function context(opts: BillingOptions, accountOnly = false): BillingContext {
  const auth = requireAuth();
  const org = resolveOrgScope(opts);
  if (org && accountOnly) {
    throw new DvmError("billing_scope_unsupported", "This route bills the authenticated key's account and cannot select an organisation.",
      "Use a key for the intended account and clear the selected organisation with `dvmctl switch --personal`.");
  }
  return { ...auth, org };
}

function integer(value: string | undefined, name: string, minimum = 0): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new DvmError("bad_request", `${name} must be a safe integer of at least ${minimum}.`);
  }
  return Number(value);
}

function key(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new DvmError("bad_request", "--idempotency-key must contain 8–128 letters, digits, underscores, or hyphens.",
      "Save this key and reuse it with the same arguments after an interruption.");
  }
  return value;
}

function rail(opts: BillingOptions): "stripe" | "lightning" {
  if (opts.rail !== "stripe" && opts.rail !== "lightning") {
    throw new DvmError("bad_request", "--rail must be stripe or lightning.");
  }
  return opts.rail;
}

function output(result: object, opts: BillingOptions, details: () => string[]): void {
  if (!opts.human) {
    json(result);
    return;
  }
  if ("display" in result && typeof result.display === "string") info(result.display);
  for (const line of details()) info(line);
  if ("hint" in result && typeof result.hint === "string") info(result.hint);
  const trace = getOutputTraceId();
  if (trace) info(`Trace ID: ${trace}`);
}

function relayLines(value: Partial<RelayCopy> | null | undefined, label: string): string[] {
  return [
    ...(value?.display ? [`${label}: ${value.display}`] : []),
    ...(value?.hint ? [value.hint] : []),
  ];
}

function budgetDetails(budget: BudgetSummary): string[] {
  const amount = (value: number | null): string => typeof value === "number" ? money(value, "USD") : "unknown";
  return [
    `Budget status: ${budget.state}. Version: ${budget.version}`,
    `Limit: ${budget.limit_cents === null ? "none" : amount(budget.limit_cents)}`,
    `Actual: ${amount(budget.actual_cents)}. Reserved: ${amount(budget.reserved_cents)}`,
    `Budget coverage: ${budget.coverage ?? "unknown"}`,
  ];
}

function statusDetails(state: BillingState): string[] {
  const lines = [
    ...relayLines(state.plan, "Plan"),
    ...relayLines(state.period, "Period"),
    `Period: ${state.period.start ?? "unknown"} to ${state.period.end ?? "unknown"} (coverage: ${state.period.coverage})`,
  ];
  for (const [label, value] of [
    ["Usage", state.usage], ["Outbound", state.outbound], ["Card", state.card],
    ["Prepaid", state.prepaid], ["Continuing costs", state.continuing_costs], ["Eligibility", state.eligibility],
  ] as const) lines.push(...relayLines(value, label));
  lines.push(...relayLines(state.restrictions, "Restrictions"), `Restriction coverage: ${state.restrictions.coverage}`);
  for (const restriction of state.restrictions.items) {
    lines.push(`Restriction (${restriction.reason}): ${restriction.display ?? restriction.reason}`);
    if (restriction.dvm_id) lines.push(`DVM: ${restriction.dvm_id}`);
    if (restriction.hint) lines.push(restriction.hint);
    if (restriction.deadline_at) lines.push(`Deadline: ${restriction.deadline_at}`);
    for (const action of restriction.next_actions) {
      lines.push(`Action (${action.code}): ${action.display ?? action.code}`);
      if (action.hint) lines.push(action.hint);
      if (action.deadline_at) lines.push(`Action deadline: ${action.deadline_at}`);
    }
  }
  if (state.budget) lines.push(...relayLines(state.budget, "Budget"), ...budgetDetails(state.budget));
  if (state.trial) {
    const trial = state.trial;
    lines.push(`Trial status: ${trial.state}`, ...relayLines(trial, "Trial"));
    if (trial.ends_at) lines.push(`Trial ends: ${trial.ends_at}`);
    if (trial.limit_fired) lines.push(`Trial limit reached: ${trial.limit_fired}`);
    for (const [label, value] of [
      ["Trial days remaining", trial.remaining_days], ["Trial credit remaining", trial.remaining_credit],
      ["Trial outbound remaining", trial.remaining_outbound],
    ] as const) lines.push(...relayLines(value, label));
    if (trial.recovery_deadline_at) lines.push(`Recovery deadline: ${trial.recovery_deadline_at}`);
    lines.push(...relayLines(trial.recovery, "Recovery"), ...relayLines(trial.recovery?.export, "Export"),
      ...relayLines(trial.recovery?.restore, "Restore"), ...relayLines(trial.action, "Next action"));
  }
  return lines;
}

function money(minorUnits: number, currency: string): string {
  const code = String(currency);
  if (!Intl.supportedValuesOf("currency").includes(code.toUpperCase())) {
    return `${minorUnits} minor units (currency: ${code})`;
  }
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: code.toUpperCase() });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(minorUnits / 10 ** digits);
}

function continuation(command: string[], opts: BillingOptions): string[] {
  const org = resolveOrgScope(opts);
  return [...command, ...(org ? ["--org", org] : [])];
}

export async function billingStatus(opts: BillingOptions): Promise<void> {
  const result = await getBillingState(context(opts));
  output(result, opts, () => statusDetails(result));
}

export async function budgetGet(opts: BillingOptions): Promise<void> {
  const ctx = context(opts);
  const result = await billingRequest<BudgetSummary>(ctx, `${billingPath(ctx.org)}/budget`);
  output(result, opts, () => budgetDetails(result));
}

export async function budgetSet(limit: string, opts: BillingOptions): Promise<void> {
  const ctx = context(opts);
  const result = await billingRequest<BudgetSummary>(ctx, `${billingPath(ctx.org)}/budget`, "PUT", {
    expected_version: integer(opts.expectedVersion, "--expected-version"),
    limit_cents: limit === "none" ? null : integer(limit, "limit in USD cents", 1),
  }, key(opts.idempotencyKey));
  output({ ...result, idempotency_key: opts.idempotencyKey }, opts,
    () => [...budgetDetails(result), `Idempotency key: ${opts.idempotencyKey}`]);
}

function topupOutput(result: HostingTopup, opts: BillingOptions): void {
  output({ ...result,
    display: `${money(result.quote.usdCents, "USD")} hosting value; Lightning invoice ${result.quote.nativeSats} sats (Bitcoin units). Quote expires: ${new Date(result.quote.expiresAt).toISOString()}. Status: ${result.state}.`,
    hint: "Only paid confirms hosting credit. Check the saved invoice status; do not create another top-up to resume.",
    continuation: { invoice_id: result.id, status_command: continuation(["dvmctl", "billing", "topup-status", result.id], opts) },
  }, opts, () => [
    `Invoice ID: ${result.id}`,
    ...(result.bolt11 ? [`Lightning invoice: ${result.bolt11}`] : []),
    ...(typeof result.providerExpiresAt === "number" ? [`Invoice expires: ${new Date(result.providerExpiresAt).toISOString()}`] : []),
    `Idempotency key: ${result.requestKey}`,
    `Check status: ${continuation(["dvmctl", "billing", "topup-status", result.id], opts).map(shellQuoteArg).join(" ")}`,
  ]);
}

export async function billingTopup(amount: string, opts: BillingOptions): Promise<void> {
  const ctx = context(opts);
  topupOutput(await billingRequest<HostingTopup>(ctx, `${billingPath(ctx.org)}/hosting/topups`, "POST",
    { usdCents: integer(amount, "hosting value in USD cents", 1000) }, key(opts.idempotencyKey)), opts);
}

export async function topupStatus(id: string, opts: BillingOptions): Promise<void> {
  const ctx = context(opts);
  topupOutput(await billingRequest<HostingTopup>(ctx, `${billingPath(ctx.org)}/hosting/topups/${encodeURIComponent(id)}`), opts);
}

export async function planQuote(planId: string, opts: BillingOptions): Promise<void> {
  const ctx = context(opts, true);
  if (!opts.requestKey || opts.requestKey.length > 128) throw new DvmError("bad_request", "--request-key must contain 1–128 characters.");
  const result = await billingRequest<PlanQuote>(ctx, `${billingPath()}/plan-change/quote`, "POST", { targetPlanId: planId, requestKey: opts.requestKey });
  output({ ...result, request_key: opts.requestKey,
    display: `Plan quote: ${money(result.quote.payableCents, result.quote.currency)} payable. No purchase has been made.`,
    hint: "Use the saved quote id for an explicit purchase. A renewal downgrade requires scheduling on the platform.",
  }, opts, () => [`Quote ID: ${result.id}`, `Request key: ${opts.requestKey}`,
    `Quote expires: ${new Date(result.quote.expiresAt).toISOString()}`]);
}

export async function planStatus(id: string, opts: BillingOptions): Promise<void> {
  const ctx = context(opts, true);
  const result = await billingRequest<PlanQuote>(ctx, `${billingPath()}/plan-change/${encodeURIComponent(id)}`);
  output({ ...result, display: `Plan change status: ${result.state}.`,
    hint: "Only the platform's applied state confirms the plan change. Retain this quote id to resume inspection." }, opts,
    () => [`Quote ID: ${result.id}`]);
}

export async function planPurchase(id: string, opts: BillingOptions): Promise<void> {
  const ctx = context(opts, true);
  const paymentRail = rail(opts);
  const quote = await billingRequest<PlanQuote>(ctx, `${billingPath()}/plan-change/${encodeURIComponent(id)}`);
  const result = await billingRequest<PaymentResult>(ctx, `${billingPath()}/plan-change/${encodeURIComponent(id)}/purchase`, "POST", { rail: paymentRail });
  paymentOutput(result, opts, quote.quote.currency, ["dvmctl", "billing", "plan", "status", id]);
}

function paymentOutput(result: PaymentResult, opts: BillingOptions, currency: string | undefined, statusCommand: string[]): void {
  const invoiceCurrency = result.fiatCurrency ?? currency;
  const amountDisplay = typeof result.amountCents === "number"
    ? invoiceCurrency ? money(result.amountCents, invoiceCurrency) : `${result.amountCents} minor units (currency unstated)`
    : undefined;
  const planDisplay = typeof result.planUsdCents === "number" ? money(result.planUsdCents, "USD") : null;
  const invoiceDescription = [
    ...(planDisplay ? [`${planDisplay} USD plan value before credit`] : []),
    ...(amountDisplay ? [`${amountDisplay} invoice value`] : []),
    `Lightning invoice ${result.amountSats} sats (Bitcoin units)`,
    ...(typeof result.expiresAt === "number" ? [`expires at ${new Date(result.expiresAt).toISOString()}`] : []),
  ].join("; ") + ".";
  output({ ...result, ...(currency ? { quote_currency: currency } : {}),
    ...(amountDisplay ? { amount_display: amountDisplay } : {}),
    ...("planUsdCents" in result ? { plan_usd_display: planDisplay } : {}),
    display: typeof result.display === "string" ? result.display : result.bolt11
      ? invoiceDescription : "Payment action returned. Check status to confirm service activation.",
    hint: "A hosted payment page or invoice is a human payment step. Only the platform's confirmed status establishes payment and activation." +
      (amountDisplay && !invoiceCurrency ? " The invoice currency is unstated; amountCents is preserved without assuming USD." : ""),
    continuation: { url: result.url ?? result.hostedInvoiceUrl ?? null, invoice_id: result.invoiceId ?? null,
      status_command: continuation(statusCommand, opts) },
  }, opts, () => [
    ...(result.state ?? result.status ? [`Payment status: ${result.state ?? result.status}`] : []),
    ...(planDisplay ? [`USD plan value before credit: ${planDisplay}`] : []),
    ...(amountDisplay ? [`Invoice amount: ${amountDisplay}`] : []),
    ...(result.invoiceId ? [`Invoice ID: ${result.invoiceId}`] : []),
    ...(result.bolt11 ? [`Lightning invoice: ${result.bolt11}`] : []),
    ...(typeof result.expiresAt === "number" ? [`Invoice expires: ${new Date(result.expiresAt).toISOString()}`] : []),
    ...(result.url ?? result.hostedInvoiceUrl ? [`Payment page: ${result.url ?? result.hostedInvoiceUrl}`] : []),
    `Check status: ${continuation(statusCommand, opts).map(shellQuoteArg).join(" ")}`,
  ]);
}

export async function billingCheckout(planId: string, opts: BillingOptions): Promise<void> {
  const paymentRail = rail(opts);
  const ctx = context(opts, paymentRail === "lightning");
  if (paymentRail === "stripe" && opts.months) throw new DvmError("bad_request", "--months applies only to Lightning checkout.");
  const months = paymentRail === "lightning" && opts.months !== undefined ? integer(opts.months, "--months", 1) : undefined;
  if (months !== undefined && ![1, 3, 6, 12].includes(months)) throw new DvmError("bad_request", "--months must be 1, 3, 6, or 12.");
  const result = await billingRequest<PaymentResult>(ctx,
    paymentRail === "stripe" ? `${billingPath(ctx.org)}/checkout` : `${billingPath()}/lightning/checkout`,
    "POST", { planId, ...(months === undefined ? {} : { months }) });
  paymentOutput(result, opts, undefined, result.invoiceId
    ? ["dvmctl", "billing", "invoice", result.invoiceId] : ["dvmctl", "billing", "status"]);
}

export async function invoiceStatus(id: string, opts: BillingOptions): Promise<void> {
  const ctx = context(opts, true);
  const result = await billingRequest<PaymentResult>(ctx, `${billingPath()}/lightning/invoice/${encodeURIComponent(id)}`);
  paymentOutput({ ...result, invoiceId: id }, opts, undefined, ["dvmctl", "billing", "invoice", id]);
}

export async function trialRestore(slug: string, opts: BillingOptions): Promise<void> {
  const target = await resolveDvm(slug, opts);
  try {
    const result = await billingRequest<Record<string, unknown>>(target,
      `/api/v1/builder/dvms/${encodeURIComponent(target.dvmId)}/trial-restore`, "POST");
    output({ ...result, dvmId: target.dvmId, slug }, opts, () => [`DVM: ${slug} (${target.dvmId})`]);
  } catch (error) {
    if (error instanceof DvmError) {
      const followUp = await billingStateAfterRefusal(context(opts));
      throw new DvmError(error.code, error.message, error.hint,
        { ...error.data, ...followUp,
          ...(error.code === "trial_restore_blocked" && error.data?.reasons === undefined && followUp.billing_state
            ? { reasons: followUp.billing_state.restrictions.items } : {}),
          status_command: continuation(["dvmctl", "billing", "status"], opts) }, error.display, error.proseSources);
    }
    throw error;
  }
}

export async function trialExport(slug: string, opts: BillingOptions): Promise<void> {
  const target = await resolveDvm(slug, opts);
  const state = await getBillingState(context(opts));
  const trial = state.trial;
  if (!trial?.recovery?.available || !trial.recovery.export) {
    throw new DvmError("trial_export_unavailable",
      trial?.recovery?.display ?? "Trial database export is not currently available.", trial?.hint ?? undefined,
      { billing_state: state });
  }
  const proxy = await startDbProxy(target, opts);
  const url = buildDatabaseUrl(proxy.ready, proxy.port);
  output({ dvmId: target.dvmId, slug, database_url: url, host: "127.0.0.1", port: proxy.port,
    recovery_deadline_at: trial.recovery_deadline_at, recovery: trial.recovery,
    display: trial.recovery.export.display,
    hint: "Use pg_dump with database_url to save the database. Keep this process running during export; the read-only tunnel ends by the recovery deadline.",
  }, opts, () => [`DVM: ${slug}`, `Database URL: ${url}`, `Recovery deadline: ${trial.recovery_deadline_at ?? "unknown"}`]);
  await blockUntilShutdown(() => proxy);
}

export function registerBillingCommands(program: Command): void {
  const billing = program.command("billing").description("Inspect hosting billing and explicitly authorise payments");
  const add = (parent: Command, name: string, description: string): Command => parent.command(name).description(description)
    .option("--org <handle>", "Organisation billing scope")
    .option("--human", "Human-readable output");
  add(billing, "status", "Read billing state, restrictions, allowances, and recovery").action((opts: BillingOptions) => catchErrors(() => billingStatus(opts), opts.human));
  const budget = billing.command("budget").description("Read or change the monthly hosting budget (USD cents)");
  add(budget, "get", "Read the current budget and version").action((opts: BillingOptions) => catchErrors(() => budgetGet(opts), opts.human));
  add(budget, "set <limit>", "Set USD cents, or none to remove the budget")
    .requiredOption("--expected-version <version>", "Version from budget get")
    .requiredOption("--idempotency-key <key>", "Saved key; reuse for the same retry")
    .action((limit: string, opts: BillingOptions) => catchErrors(() => budgetSet(limit, opts), opts.human));
  add(billing, "topup <usd-cents>", "Explicitly create a Lightning hosting top-up (minimum 1000 USD cents)")
    .requiredOption("--idempotency-key <key>", "Saved key; reuse for the same retry")
    .action((amount: string, opts: BillingOptions) => catchErrors(() => billingTopup(amount, opts), opts.human));
  add(billing, "topup-status <id>", "Read or reconcile a saved top-up; never create another invoice")
    .action((id: string, opts: BillingOptions) => catchErrors(() => topupStatus(id, opts), opts.human));
  add(billing, "invoice <id>", "Poll a saved Lightning subscription invoice once")
    .action((id: string, opts: BillingOptions) => catchErrors(() => invoiceStatus(id, opts), opts.human));
  add(billing, "checkout <plan-id>", "Explicitly open checkout for a paid plan, including trial conversion")
    .requiredOption("--rail <rail>", "stripe or lightning")
    .option("--months <months>", "Lightning term: 1, 3, 6, or 12")
    .action((id: string, opts: BillingOptions) => catchErrors(() => billingCheckout(id, opts), opts.human));
  const plan = billing.command("plan").description("Quote, purchase, or inspect a change to a settled paid plan");
  add(plan, "quote <plan-id>", "Create a quote without purchasing")
    .requiredOption("--request-key <key>", "Saved request key; reuse for the same quote")
    .action((id: string, opts: BillingOptions) => catchErrors(() => planQuote(id, opts), opts.human));
  add(plan, "purchase <quote-id>", "Explicitly purchase a saved quote")
    .requiredOption("--rail <rail>", "stripe or lightning")
    .action((id: string, opts: BillingOptions) => catchErrors(() => planPurchase(id, opts), opts.human));
  add(plan, "status <quote-id>", "Read or reconcile a saved plan change")
    .action((id: string, opts: BillingOptions) => catchErrors(() => planStatus(id, opts), opts.human));
  const trial = program.command("trial").description("Export retained trial data or restore after verified purchase");
  add(trial, "export <slug>", "Open the read-only database export tunnel during recovery")
    .option("--port <port>", "Local port (default: OS assigned)")
    .option("--machine <id>", "Machine to broker through")
    .action((slug: string, opts: BillingOptions) => catchErrors(() => trialExport(slug, opts), opts.human));
  add(trial, "restore <slug>", "Request restoration; does not purchase a plan or reset trial")
    .addHelpText("after", "\nRestore also works after the seven-day recovery deadline if a paid plan was purchased before that deadline.")
    .action((slug: string, opts: BillingOptions) => catchErrors(() => trialRestore(slug, opts), opts.human));
}

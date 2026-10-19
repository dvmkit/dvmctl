// Wire types are owned here; additional version 1 fields pass through unchanged.
export interface RelayCopy { display: string; hint: string | null }
export interface BillingMoney { minor_units: number | null; currency: string; basis: string }
export interface BillingAction extends RelayCopy { code: string; deadline_at: string | null }
export interface BillingRestriction extends RelayCopy {
  reason: string;
  mode: string;
  dvm_id: string | null;
  set_at: string;
  deadline_at: string | null;
  episode_reset_not_before_at: string | null;
  next_actions: BillingAction[];
}
export interface TrialState extends RelayCopy {
  state: string;
  coverage: string;
  started_at: string | null;
  ends_at: string | null;
  remaining_days: { amount: number | null; unit: "days"; display: string };
  remaining_credit: { amount: number | null; currency: string; unit: "cents"; display: string };
  remaining_outbound: { amount: string | null; unit: "bytes"; display: string };
  limit_fired: string | null;
  recovery_deadline_at: string | null;
  recovery: {
    data: string;
    available: boolean;
    export: { route: string; display: string } | null;
    restore: { route: string; display: string } | null;
    purchase: { stripe: string; lightning: string };
    display: string;
  } | null;
  reason: string;
  action: { route: string; display: string };
}
export interface BudgetSummary extends RelayCopy {
  state: string;
  period: { start: string | null; end: string | null };
  limit_cents: number | null;
  actual_cents: number | null;
  reserved_cents: number | null;
  warn_at_cents: number | null;
  coverage: string;
  version: number;
  continuing_costs: { plan_cents: number | null; retained_storage_cents: number | null; recovery_cents: number | null };
  can_edit: boolean;
}
export interface BillingState extends RelayCopy {
  version: number;
  can_edit: boolean;
  account_id: string | null;
  as_of: string;
  plan: RelayCopy & Record<string, unknown>;
  period: RelayCopy & { start: string | null; end: string | null; coverage: string };
  usage: RelayCopy & Record<string, unknown>;
  outbound: RelayCopy & Record<string, unknown>;
  card: RelayCopy & Record<string, unknown>;
  prepaid: RelayCopy & Record<string, unknown>;
  continuing_costs: RelayCopy & Record<string, unknown>;
  eligibility: RelayCopy & Record<string, unknown>;
  restrictions: RelayCopy & { coverage: string; items: BillingRestriction[] };
  trial: TrialState | null;
  budget: BudgetSummary | null;
}
export interface HostingTopup {
  id: string;
  billingAccountId: string;
  requestKey: string;
  state: string;
  quote: { usdCents: number; nativeSats: number; nativeMsats: number; expiresAt: number; [key: string]: unknown };
  bolt11: string | null;
  paymentHash: string | null;
  providerExpiresAt: number | null;
}
export interface PlanQuote {
  id: string;
  state: string;
  quote: { currency: string; payableCents: number; expiresAt: number; kind: string; [key: string]: unknown };
  [key: string]: unknown;
}
export interface PaymentResult {
  id?: string;
  invoiceId?: string | null;
  state?: string;
  status?: string;
  url?: string;
  hostedInvoiceUrl?: string | null;
  bolt11?: string;
  amountSats?: number;
  amountCents?: number;
  fiatCurrency?: string;
  planUsdCents?: number | null;
  expiresAt?: number;
  [key: string]: unknown;
}

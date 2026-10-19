import { DvmError } from "@dvmkit/sdk/internal";

import { getOutputTraceId, setOutputTraceId } from "../shared/output.ts";

import { platformFetch, platformResponseError } from "./platform-client.ts";
import type { BillingState } from "./billing-types.ts";

export interface BillingContext { platformUrl: string; token: string; org?: string }

export function billingPath(org?: string): string {
  return `/api/v1/builder${org ? `/orgs/${encodeURIComponent(org)}` : ""}/billing`;
}

export async function billingRequest<T>(
  context: BillingContext,
  path: string,
  method = "GET",
  body?: unknown,
  idempotencyKey?: string
): Promise<T> {
  const res = await platformFetch(`${context.platformUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${context.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await res.json().catch(() => ({}));
  const data = isRecord(parsed) ? parsed : {};
  if (!res.ok) {
    const remote = data.error as ({ code?: string; message?: string } & Record<string, unknown>) | undefined;
    if (res.status === 404) {
      if (remote?.code === "not_found") {
        throw platformResponseError("not_found", remote, "Billing resource not found.",
          { hint: "Check the identifier and account scope." });
      }
      if (!remote?.code) {
        throw platformResponseError("billing_not_available", remote,
          "This billing feature is not available on this platform.",
          { hint: "Older platforms may not provide this route." });
      }
    }
    const restoreBlocked = res.status === 409 && path.endsWith("/trial-restore") && data.restored === false;
    const relay = restoreBlocked && typeof data.display === "string"
      ? { ...remote, message: data.display, display: data.display } : remote;
    throw platformResponseError(remote?.code ?? (restoreBlocked ? "trial_restore_blocked" : "billing_failed"), relay,
      remote?.code === "trial_recovery_closed" ? "The seven-day trial recovery window has closed."
        : restoreBlocked && typeof data.display === "string" ? data.display : `Billing request failed (HTTP ${res.status}).`,
      { data: {
        ...Object.fromEntries(Object.entries(remote ?? {}).filter(([key]) => !["code", "message", "display", "hint", "data"].includes(key))),
        ...Object.fromEntries(Object.entries(data).filter(([key]) => key !== "error")),
      } });
  }
  return data as T;
}

export async function getBillingState(context: BillingContext): Promise<BillingState> {
  const state = await billingRequest<BillingState>(context, `${billingPath(context.org)}/state`);
  if (state.version !== 1) {
    throw new DvmError("billing_version_unsupported", `Unsupported billing-state version ${String(state.version)}.`,
      "Upgrade dvmctl before interpreting this platform's billing state.");
  }
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Follow-up diagnostics must not replace the trace of the refused operation.
export async function billingStateAfterRefusal(context: BillingContext): Promise<{
  billing_state?: BillingState;
  billing_state_error?: string;
  billing_state_trace_id: string | null;
}> {
  const refusalTrace = getOutputTraceId();
  setOutputTraceId(null);
  try {
    const billing_state = await getBillingState(context);
    return { billing_state, billing_state_trace_id: getOutputTraceId() };
  } catch (error) {
    return { billing_state_error: error instanceof DvmError ? error.code : "billing_state_unavailable",
      billing_state_trace_id: getOutputTraceId() };
  } finally {
    setOutputTraceId(refusalTrace);
  }
}

const hostingRefusalCodes = new Set([
  "hosting_restricted", "free_hosting_at_capacity", "hosting_trial_unavailable", "hosting_trial_envelope",
  "capacity_limit_exceeded", "capacity_evidence_unavailable", "capacity_evidence_pending",
  "capacity_supplier_proof_unsupported", "capacity_concurrency_exceeded", "capacity_supplier_limit_exceeded",
  "capacity_replay_conflict", "awake_machine_cap_reached", "card_exposure_limit",
]);

const billingRestrictionReasons = new Set([
  "payment", "eligibility", "customer_budget", "trial_expiry", "operator_security", "idle",
  "egress_allowance", "egress_unobserved", "egress_stopper", "operator",
]);

// Keep the original refusal even when the follow-up read is unavailable.
export async function admissionRefusal(res: Response, url: string, init?: RequestInit): Promise<Response> {
  const text = await res.clone().text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { return res; }
  if (!isRecord(body) || !isRecord(body.error)) return res;
  const remote = body.error;
  const data = isRecord(remote.data) ? remote.data : {};
  const hasReasons = [remote.reasons, data.reasons].some((value) => Array.isArray(value) && value.some((item: unknown) => {
    const reason = isRecord(item) ? item.reason : item;
    return typeof reason === "string" && billingRestrictionReasons.has(reason);
  }));
  if (!hostingRefusalCodes.has(String(remote.code)) && !hasReasons) return res;
  const actions = [remote.options, remote.next_actions, data.next_actions, data.options];
  if (actions.some((value) => Array.isArray(value) && value.length > 0)) return res;
  const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
  if (!token) return res;
  const refusalTrace = getOutputTraceId();
  let org: string | undefined;
  const base = url.split("/api/v1/builder")[0]!;
  try {
    if (init?.body instanceof FormData) {
      const metadata = init.body.get("metadata");
      if (typeof metadata === "string") org = (JSON.parse(metadata) as { orgHandle?: string }).orgHandle;
    }
    // Resource routes carry an immutable DVM id; read its owner for the billing scope.
    const match = /\/dvms\/([^/]+)\/(resume|scale)$/.exec(url);
    if (match) {
      const detail = await platformFetch(`${base}/api/v1/builder/dvms/${match[1]}`, { headers: init?.headers });
      if (!detail.ok) throw new Error("DVM scope unavailable");
      const value = await detail.json() as { dvm?: { orgHandle?: string | null }; orgHandle?: string | null };
      org = value.dvm?.orgHandle ?? value.orgHandle ?? undefined;
      if (!value.dvm && !("orgHandle" in value)) throw new Error("DVM billing scope unavailable");
    }
    remote.data = { ...data, ...await billingStateAfterRefusal({ platformUrl: base, token, org }) };
  } catch (error) {
    remote.data = { ...data, billing_state_error: error instanceof DvmError ? error.code : "billing_state_unavailable" };
  } finally {
    setOutputTraceId(refusalTrace);
  }
  if (isRecord(remote.data) && remote.data.billing_state_error) {
    remote.data.billing_status_command = org ? ["dvmctl", "billing", "status", "--org", org] : ["dvmctl", "billing", "status"];
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
}

import {
  type AttestationPayload,
  DvmError,
  isAbortError,
  type JsonValue,
  providerProseSources,
  transportErrorCode,
} from "@dvmkit/sdk/internal";

import type { FeatureManifest } from "../builder-platform/capability-manifest.ts";
import type {
  Builder,
  BuilderDeploy,
  BuilderDvmWithRevenue,
  Deploy,
  DeployStatus,
  Domain,
  DomainStatus,
  DvmEventEntry,
  DvmStatus,
  RequestMetric,
  SuspensionReason,
  VmConfig,
} from "../builder-platform/types.ts";
import { setOutputTraceId } from "../shared/output.ts";
import { parseTraceparent } from "../shared/traceparent.ts";
import { dvmFetch } from "./http.ts";
import type { FeedbackRow, TraceResult } from "./platform-api-types.ts";
import { markPlatformError } from "./platform-error-tag.ts";

/**
 * Fetch wrapper that captures the `traceparent` response header from the
 * platform API and stores the trace_id for automatic injection into CLI
 * JSON output via `setOutputTraceId`. For multi-call commands, the last
 * response's trace_id wins.
 */
async function platformFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const attempts = method === "GET" || method === "HEAD" ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await dvmFetch(input, init);
      const tp = res.headers.get("traceparent");
      if (tp) {
        const parsed = parseTraceparent(tp);
        if (parsed) setOutputTraceId(parsed.traceId);
      }
      return res;
    } catch (err) {
      if (isAbortError(err) || err instanceof DvmError) throw err;
      lastError = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  const cause = transportErrorCode(lastError);
  throw new DvmError(
    "platform_unreachable",
    `Could not reach the dvmkit platform after ${attempts} attempt${attempts === 1 ? "" : "s"}${cause ? ` (${cause})` : ""}.`,
    "Check the network connection and retry. No server response was received.",
    {
      attempts,
      method,
      ...(cause ? { transport_code: cause } : {}),
    }
  );
}

/**
 * Turn a failed org-scoped read into a `DvmError` whose hint names the org
 * scope, so an agent relaying it can say *which* org the caller was pointed
 * at. The platform answers 404 for an org the caller isn't a member of
 * (anti-enumeration) and 403 when their role is too low.
 */
async function orgScopedError(
  res: Response,
  fallbackCode: string,
  what: string,
  org: string | undefined
): Promise<DvmError> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string; display?: string; hint?: string };
  };
  const scope = org ? `org "${org}"` : "your personal context";
  let hint = body.error?.hint;
  // Only the org gate answers 404 with `not_found`; a route's own 404 (a
  // missing trace, say) keeps its own words rather than being retold as a
  // membership problem the caller doesn't have.
  if (!hint && org && res.status === 404 && body.error?.code === "not_found") {
    hint = `No org "${org}" you can see. Check the handle, or ask an admin to invite you.`;
  }
  if (!hint && res.status === 403) {
    hint = `Your role in ${scope} is too low for this data. Ask an org admin.`;
  }
  return platformResponseError(
    body.error?.code ?? fallbackCode,
    body.error,
    `${what} for ${scope}: ${res.status}`,
    { hint }
  );
}

interface PlatformErrorBody {
  message?: string;
  hint?: string;
  display?: string;
  data?: Record<string, unknown>;
}

function platformResponseError(
  code: string,
  remote: PlatformErrorBody | undefined,
  fallbackMessage: string,
  local: {
    hint?: string;
    display?: string;
    data?: Record<string, unknown>;
  } = {}
): DvmError {
  const data =
    remote?.data || local.data ? { ...(remote?.data ?? {}), ...(local.data ?? {}) } : undefined;
  const error = new DvmError(
    code,
    remote?.message ?? fallbackMessage,
    remote?.hint ?? local.hint,
    data,
    remote?.display ?? local.display,
    providerProseSources(remote, remote?.data)
  );
  return markPlatformError(error);
}

export interface DeployResult {
  url: string;
  status: string;
  dvmkitUrl: string | null;
}

/** Hosted release accepted by Fly before the platform's post-deploy verification completes. */
export interface AcceptedDeployRelease {
  deployId: string;
  url: string;
  commitSha: string | null;
}

/** Phase tick emitted by `streamDeployLogs` while a deploy is in flight. */
export interface DeployPhase {
  status: DeployStatus;
  elapsedMs: number;
}

/** Snapshot returned by `GET /api/v1/builder/deploys/:id`. */
export interface DeployStatusResponse {
  deploy: Deploy;
  recovery?: {
    deployId: string;
    status: Deploy["recoveryStatus"];
    targetDeployId: string | null;
    error: string | null;
  } | null;
  dvm: {
    id: string;
    slug: string;
    url: string | null;
    dvmkitUrl: string | null;
  };
}

/** Response shape returned by `POST /api/v1/feedback`. */
export interface FeedbackSubmitResponse {
  id: string;
  created_at: string;
  dvm_id: string | null;
  job_id: string | null;
  tier?: "claimed" | "receipt_verified" | null;
  hint?: string;
}

/**
 * POST `/api/v1/feedback` with an already-signed envelope. Auth is
 * carried by the envelope's secp256k1 Schnorr signature; no Bearer token.
 * Throws `DvmError` on a non-2xx response, carrying the platform's marked
 * `display` and `hint` through under their own names. Keeping them separate
 * preserves what the platform said without presenting either as CLI guidance
 * (tracked change, tracked change).
 */
export async function submitFeedback(
  platformUrl: string,
  signedEnvelope: Record<string, unknown>
): Promise<FeedbackSubmitResponse> {
  const res = await platformFetch(`${platformUrl}/api/v1/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signedEnvelope),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; display?: string; hint?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "feedback_failed",
      body.error,
      `Feedback submission failed: ${res.status}`
    );
  }
  return (await res.json()) as FeedbackSubmitResponse;
}

/** Per-mint reliability rollup row from `GET /api/v1/mint-health`. */
export interface MintReliabilityRow {
  url: string;
  recent_failures_7d: number;
  last_check_at: string;
  consecutive_failures: number;
}

/**
 * Fetch the public Cashu mint reliability rollup. No auth — this is
 * a low-priv read of `cashu-mint-health-cron` liveness history. Callers merge
 * the historical fields into the live-probe rows of `dvm wallet mint-health`
 * and swallow failures to fall back to live-probe-only.
 */
export async function getMintReliability(platformUrl: string): Promise<MintReliabilityRow[]> {
  const res = await platformFetch(`${platformUrl}/api/v1/mint-health`);
  if (!res.ok) {
    throw markPlatformError(new DvmError("mint_health_failed", `Failed to fetch mint reliability: ${res.status}`));
  }
  const body = (await res.json()) as { mints: MintReliabilityRow[] };
  return body.mints;
}

/** Set the builder's handle. Throws DvmError on failure. */
export async function setHandle(platformUrl: string, token: string, handle: string): Promise<void> {
  const res = await platformFetch(`${platformUrl}/api/v1/builder/handle`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "handle_failed",
      body.error,
      `Failed to set handle: ${res.status}`
    );
  }
}

export async function checkHandle(
  platformUrl: string,
  handle: string
): Promise<{ available: boolean }> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/handle/check/${encodeURIComponent(handle)}`
  );
  return (await res.json()) as { available: boolean };
}

export async function addDomain(
  platformUrl: string,
  token: string,
  dvmId: string,
  domain: string
): Promise<{ hint?: string }> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/domains`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "domain_failed",
      body.error,
      `Failed to add domain: ${res.status}`
    );
  }
  const body = (await res.json().catch(() => ({}))) as { hint?: string };
  return { hint: body.hint };
}

export async function removeDomain(
  platformUrl: string,
  token: string,
  dvmId: string,
  domain: string
): Promise<void> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/domains/${encodeURIComponent(domain)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "domain_failed",
      body.error,
      `Failed to remove domain: ${res.status}`
    );
  }
}

/** Verify a custom domain's CNAME and provision TLS cert. */
export async function verifyDomain(
  platformUrl: string,
  token: string,
  dvmId: string,
  domain: string
): Promise<void> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/domains/${encodeURIComponent(domain)}/verify`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "verify_failed",
      body.error,
      `Failed to verify domain: ${res.status}`
    );
  }
}

export async function listDomains(
  platformUrl: string,
  token: string,
  dvmId: string
): Promise<{ domain: string; status: DomainStatus }[]> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/domains`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    throw markPlatformError(new DvmError("domain_failed", `Failed to list domains: ${res.status}`));
  }
  const body = (await res.json()) as { domains: { domain: string; status: DomainStatus }[] };
  return body.domains;
}

/**
 * The org a builder read was answered from, echoed by every scoped route.
 * `handle` is null for a personal context — personal orgs are faceless, so
 * `personal: true` is the only honest label for them.
 */
export interface ReadScopeInfo {
  id: string;
  handle: string | null;
  role: "owner" | "admin" | "member";
  personal: boolean;
}

/**
 * Name a read's org scope for `--human` output. Personal orgs have no public
 * handle, so "personal" is the label — the same answer the platform gives.
 */
export function scopeLabel(org: ReadScopeInfo): string {
  return org.personal ? "personal" : (org.handle ?? org.id);
}

/** Response from `GET /api/v1/builder/dvms`. */
export interface ListDvmsResult {
  dvms: BuilderDvmWithRevenue[];
  org: ReadScopeInfo;
}

/**
 * List the DVMs in the caller's current org scope. `org` selects a shared
 * org by handle (`dvmctl switch` / `--org`); without it the platform answers
 * for the caller's own org. The response echoes the scope it used, so an
 * empty list is never ambiguous about which org it was empty *for*.
 */
export async function listDvms(
  platformUrl: string,
  token: string,
  opts: { org?: string } = {}
): Promise<ListDvmsResult> {
  const url = new URL(`${platformUrl}/api/v1/builder/dvms`);
  if (opts.org) url.searchParams.set("org", opts.org);
  const res = await platformFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw await orgScopedError(res, "list_failed", "Failed to list DVMs", opts.org);
  }
  return (await res.json()) as ListDvmsResult;
}

/**
 * A DVM as `GET /api/v1/builder/dvms/:dvmId` returns it — the builder projection
 * plus `orgHandle`, which is the shared org that owns it (null for a personal org).
 */
export type BuilderDvmView = BuilderDvmWithRevenue & { orgHandle: string | null };

/**
 * Get detailed info for a single DVM including deploys and domains.
 *
 * `deploys` is the builder projection (`builderDeploy`), not the raw `Deploy`
 * row — the route strips the infra internals (`machineId`, `imageRef`, the
 * attestation columns) before it answers.
 */
export async function getDvm(
  platformUrl: string,
  token: string,
  dvmId: string
): Promise<{ dvm: BuilderDvmView; deploys: BuilderDeploy[]; domains: Domain[] }> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "info_failed",
      body.error,
      `Failed to get DVM: ${res.status}`
    );
  }
  return (await res.json()) as { dvm: BuilderDvmView; deploys: BuilderDeploy[]; domains: Domain[] };
}

/**
 * Destroy a deployed DVM. By default both the Fly compute app and its paired
 * Postgres cluster are destroyed. Pass `keepDb: true` to preserve the cluster
 * for re-attachment on redeploy.
 */
export async function destroyDvm(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts?: { keepDb?: boolean; ledger?: DestroyLedgerReport }
): Promise<DestroyResult> {
  const url = new URL(`${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}`);
  if (opts?.keepDb) url.searchParams.set("keep_db", "true");
  const res = await platformFetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts?.ledger ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts?.ledger ? { body: JSON.stringify({ ledger: opts.ledger }) } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "destroy_failed",
      body.error,
      `Failed to destroy DVM: ${res.status}`
    );
  }
  return (await res.json()) as DestroyResult;
}

/**
 * What the DVM's own ledger says it owes, sent with a destroy so the platform
 * can wind the DVM down rather than delete it. Counts only.
 */
export interface DestroyLedgerReport {
  open_credits: number;
  pending_drains: number;
  gaps: number;
}

/**
 * The platform's answer to a destroy: deleted now, or winding down because
 * callers still hold prepaid balances, in which case it is deleted after
 * `deleteAfter` (Unix ms) and answers reclaims until then.
 */
export type DestroyResult =
  | { status: "destroyed"; dvmId: string; slug: string; keptDb: boolean }
  | {
      status: "winding_down";
      dvmId: string;
      slug: string;
      keptDb: boolean;
      startedAt: number;
      deleteAfter: number;
      alreadyWindingDown: boolean;
      display: string;
    };

export interface ListBuilderFeedbackOptions {
  /** Filter to a single immutable DVM ID. Omit to span every DVM in the org scope. */
  dvmId?: string;
  verdict?: "up" | "down";
  /** Look-back cutoff as Unix ms. */
  sinceMs?: number;
  /** Opaque cursor returned by a prior response's `next_cursor`. */
  cursor?: string;
  /** Page size cap. The platform clamps at 100. */
  limit?: number;
  /** Org handle to read as. Omit for the caller's own context. */
  org?: string;
}

/** Response shape returned by `GET /api/v1/builder/feedback`. */
export interface ListBuilderFeedbackResult {
  feedback: FeedbackRow[];
  next_cursor: string | null;
  org: ReadScopeInfo;
}

/**
 * Fetch caller-feedback rows for the DVMs in the caller's org scope.
 * Platform-level rows (`slug IS NULL`) stay operator-only and are
 * never returned here.
 */
export async function listBuilderFeedback(
  platformUrl: string,
  token: string,
  opts: ListBuilderFeedbackOptions = {}
): Promise<ListBuilderFeedbackResult> {
  const url = new URL(`${platformUrl}/api/v1/builder/feedback`);
  if (opts.verdict) url.searchParams.set("verdict", opts.verdict);
  if (opts.dvmId) url.searchParams.set("dvm_id", opts.dvmId);
  if (opts.sinceMs !== undefined) url.searchParams.set("since", String(opts.sinceMs));
  if (opts.cursor) url.searchParams.set("cursor", opts.cursor);
  if (opts.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
  if (opts.org) url.searchParams.set("org", opts.org);
  const res = await platformFetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw await orgScopedError(res, "feedback_list_failed", "Failed to list feedback", opts.org);
  }
  return (await res.json()) as ListBuilderFeedbackResult;
}

export interface BuilderFeedbackSubmission {
  body: string;
  trace_id?: string;
  context?: {
    dvmctl_version?: string;
    sdk_version?: string;
    os?: string;
    node_version?: string;
    command?: string;
    error_code?: string;
    trigger?: "failure" | "first_deploy" | "check_in";
    dvm_id?: string;
  };
}

export async function sendBuilderFeedback(
  platformUrl: string,
  token: string,
  submission: BuilderFeedbackSubmission,
  org?: string
): Promise<{ id: string; created_at: string; display: string }> {
  const url = new URL(`${platformUrl}/api/v1/builder/feedback`);
  if (org) url.searchParams.set("org", org);
  const res = await platformFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
  if (!res.ok) throw await orgScopedError(res, "feedback_send_failed", "Failed to send feedback", org);
  return (await res.json()) as { id: string; created_at: string; display: string };
}

/** Body shape for `PATCH /api/v1/builder/dvms/:dvmId/settings`. */
export interface DvmSettingsUpdate {
  feedback_enabled?: boolean;
}

/** Response shape returned by `PATCH /api/v1/builder/dvms/:dvmId/settings`. */
export interface DvmSettingsResponse {
  dvm_id: string;
  slug: string;
  settings: { feedback_enabled: boolean };
}

/**
 * Update per-DVM settings. First endpoint of the future DVM-settings
 * surface; the body shape can widen with more keys without route churn.
 */
export async function updateDvmSettings(
  platformUrl: string,
  token: string,
  dvmId: string,
  settings: DvmSettingsUpdate
): Promise<DvmSettingsResponse> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/settings`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; display?: string; hint?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "settings_update_failed",
      body.error,
      `Failed to update DVM settings: ${res.status}`
    );
  }
  return (await res.json()) as DvmSettingsResponse;
}

/** Membership info returned from `GET /api/v1/builder/orgs/:handle`. */
export interface OrgMembershipInfo {
  handle: string;
  displayName: string | null;
  role: "owner" | "admin" | "member";
}

/** A builder's membership returned by `GET /api/v1/builder/orgs`. */
export interface BuilderOrgMembership {
  /** Personal-org handles must not be offered to callers as switch targets. */
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: "owner" | "admin" | "member";
  isPersonal: boolean;
}

/** The authenticated builder profile returned by `GET /api/v1/builder/me`. */
export type AuthenticatedBuilderProfile = Builder;

export async function getAuthenticatedBuilderProfile(
  platformUrl: string,
  token: string
): Promise<AuthenticatedBuilderProfile> {
  const res = await platformFetch(`${platformUrl}/api/v1/builder/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "builder_profile_failed",
      body.error,
      `Failed to read builder profile: ${res.status}`
    );
  }
  const data = (await res.json()) as { builder: AuthenticatedBuilderProfile };
  return data.builder;
}

export async function listBuilderOrgs(
  platformUrl: string,
  token: string
): Promise<BuilderOrgMembership[]> {
  const res = await platformFetch(`${platformUrl}/api/v1/builder/orgs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "org_list_failed",
      body.error,
      `Failed to list org memberships: ${res.status}`
    );
  }
  const data = (await res.json()) as { orgs: BuilderOrgMembership[] };
  return data.orgs;
}

/** Look up an org by handle and verify the caller is a member. The platform
 *  returns 404 for both "no such org" and "not a member" — same as how it
 *  handles other org reads. */
export async function getOrgMembership(
  platformUrl: string,
  token: string,
  handle: string
): Promise<OrgMembershipInfo> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/orgs/${encodeURIComponent(handle)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (res.status === 404) {
    throw markPlatformError(new DvmError(
      "org_not_found",
      `Org "${handle}" not found, or you are not a member.`,
      "Check the handle, or ask an admin to invite you."
    ));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "org_lookup_failed",
      body.error,
      `Failed to look up org: ${res.status}`
    );
  }
  const data = (await res.json()) as {
    org: { handle: string; displayName: string | null };
    role: "owner" | "admin" | "member";
  };
  return { handle: data.org.handle, displayName: data.org.displayName, role: data.role };
}

/**
 * Register a per-DVM lock pubkey on the platform. Used by
 * `dvmctl deploy` on first deploy, when the CLI doesn't yet know the dvmId
 * at metadata-build time. On subsequent deploys, the pubkey is sent inline
 * via the deploy `lockPubkey` field instead.
 */
export async function setDvmLockPubkey(
  platformUrl: string,
  token: string,
  dvmId: string,
  pubkey: string
): Promise<void> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/lock-pubkey`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw platformResponseError(
      "platform_error",
      body.error,
      "Failed to register per-DVM lock pubkey.",
      { hint: "Ensure the pubkey is a valid 33-byte compressed secp256k1 key (66 hex chars)." }
    );
  }
}

/** Response body from `POST /api/v1/builder/dvms/:dvmId/rotate-lock-pubkey`. */
export interface RotateDvmLockPubkeyResponse {
  current: string;
  retired: { pubkey: string; retired_at_ms: number }[];
  /**
   * Non-null when the post-rotate sync of `dvms.lock_pubkey` failed. The
   * accumulator rotation itself committed; this is bookkeeping for the next
   * redeploy's `inheritSecrets` injection. CLI surfaces it as a warning.
   */
  lock_pubkey_sync_warning?: string | null;
}

/**
 * Rotate an isolate-tier DVM's lock pubkey via the platform.
 * Container DVMs rotate via the SDK admin endpoint instead — this helper is
 * only invoked from the CLI's isolate branch after a `getDvm` runtime check.
 *
 * Returns the post-rotation `{ current, retired }`. Throws a `DvmError` with
 * code `no_op_rotation` (carrying status 409) when the supplied pubkey is
 * already current — callers can branch on the code for the resync recovery
 * path used by `dvmctl rotate`.
 */
export async function rotateDvmLockPubkey(
  platformUrl: string,
  token: string,
  dvmId: string,
  newPubkey: string
): Promise<RotateDvmLockPubkeyResponse> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/rotate-lock-pubkey`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ new_pubkey: newPubkey }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    const code = body.error?.code ?? "platform_error";
    throw platformResponseError(
      code,
      body.error,
      `Failed to rotate per-DVM lock pubkey (HTTP ${res.status}).`,
      {
        hint:
          code === "no_op_rotation"
            ? undefined
            : "Ensure the pubkey is a valid compressed secp256k1 key and the DVM is isolate-tier.",
      }
    );
  }
  return (await res.json()) as RotateDvmLockPubkeyResponse;
}

/** Validate an API key against the platform. Throws DvmError on failure. */
export async function validateAuth(platformUrl: string, token: string): Promise<void> {
  const res = await platformFetch(`${platformUrl}/api/v1/builder/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw markPlatformError(new DvmError(
      "auth_failed",
      "Invalid API key.",
      "Check your DVMKIT_API_KEY or run `dvmctl auth`."
    ));
  }
}

/** Start a deploy by uploading a tarball to the platform. Returns the deploy ID. */
export async function startDeploy(
  platformUrl: string,
  token: string,
  opts: {
    slug: string;
    name: string;
    /** Project tarball. Required for hosted deploys; omitted for Connect-tier
     *  deploys (no build step server-side). */
    tarball?: Buffer;
    env?: Record<string, string>;
    runtime?: "container" | "isolate";
    /** Optional git commit metadata captured from the local working tree. */
    commit?: {
      sha: string;
      ref: string;
      message: string;
      authorName?: string | null;
    };
    /** Builder-declared VM resources from package.json#dvmkit. */
    vmConfig?: VmConfig;
    /** Builder-declared platform-secret patterns to inherit, from
     *  package.json#dvmkit.inheritSecrets. Validated server-side. */
    inheritSecrets?: string[];
    /** Builder-declared optional-feature manifest from package.json#dvmkit.features.
     * Validated + reconciled server-side against the deploy's
     *  forwarded secrets to flag an advertised-but-unservable capability. */
    features?: FeatureManifest;
    /** Connect-tier upstream URL — required when the builder's plan has
     *  `features.hosts_compute = false`. Ignored on hosted plans. */
    endpointUrl?: string;
    /** Path to the Dockerfile relative to the tarball root. Set when the
     *  build context is a parent of the DVM directory (monorepo layout) so
     *  flyctl picks the right Dockerfile out of the extracted tarball. */
    dockerfilePath?: string;
    /** Persistent org context from `dvmctl switch <handle>`. When set, the
     *  platform creates the DVM under this org's billing account. */
    orgHandle?: string;
    /** Per-DVM lock pubkey. Derived locally from the builder's
     *  mnemonic at `m/1789'/0'/hashed(canonical_dvm_id)'/0'`. The platform
     *  persists this to `dvms.lock_pubkey` and injects it as
     *  `DVMKIT_CASHU_LOCK_PUBKEY`. Sent inline on redeploys; on first deploy
     *  the CLI doesn't yet know the dvmId, so it follows up with a PUT (see
     *  `expectLockPubkey`). */
    lockPubkey?: string;
    /** First-deploy intent signal. Set when the CLI has a mnemonic
     *  and will PUT `dvms.lock_pubkey` right after `startDeploy` returns the
     *  dvmId. The deploy pipeline briefly awaits that PUT before reading the
     *  pubkey for injection, so a fresh first deploy advertises Cashu without
     *  a redeploy. */
    expectLockPubkey?: boolean;
    /** Complete the ID-bound receipt attestation after the platform returns dvmId. */
    expectIdentityFinalization?: boolean;
    /** Builder identity pubkey for the deploy-time attestation.
     *  x-only secp256k1, 32 bytes hex. The platform asserts this matches the
     *  builder's stored binding on every deploy after the first. */
    identityPubkey?: string;
    /** Canonical attestation payload. The platform stores this
     *  verbatim on `dvms.builder_attestation_payload` so the DVM's `/v1/info`
     *  can serve it without re-canonicalising. */
    attestationPayload?: AttestationPayload;
    /** Schnorr signature of `canonicaliseForSigning(payload)` under
     *  `identityPubkey`. 64 bytes hex. */
    attestationSignature?: string;
    /** Declared capabilities block. The platform re-hashes this and
     *  cross-checks it against `attestationPayload.capabilities_hash`. */
    capabilities?: JsonValue;
  }
): Promise<{ deployId: string; dvmId: string; slug: string }> {
  const form = new FormData();
  if (opts.tarball) {
    form.append("tarball", new Blob([new Uint8Array(opts.tarball)]), "project.tar.gz");
  }
  form.append(
    "metadata",
    JSON.stringify({
      slug: opts.slug,
      name: opts.name,
      env: opts.env,
      runtime: opts.runtime,
      commit: opts.commit,
      vmConfig: opts.vmConfig,
      inheritSecrets: opts.inheritSecrets,
      features: opts.features,
      endpointUrl: opts.endpointUrl,
      dockerfilePath: opts.dockerfilePath,
      orgHandle: opts.orgHandle,
      lockPubkey: opts.lockPubkey,
      expectLockPubkey: opts.expectLockPubkey,
      expectIdentityFinalization: opts.expectIdentityFinalization,
      identityPubkey: opts.identityPubkey,
      attestationPayload: opts.attestationPayload,
      attestationSignature: opts.attestationSignature,
      capabilities: opts.capabilities,
    })
  );

  const res = await platformFetch(`${platformUrl}/api/v1/builder/deploy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; data?: Record<string, unknown> };
    };
    const code = body.error?.code ?? "deploy_failed";
    throw platformResponseError(code, body.error, `Deploy failed with status ${res.status}`);
  }

  const body = (await res.json()) as Record<string, unknown>;
  if (
    typeof body.deployId !== "string" ||
    typeof body.dvmId !== "string" ||
    typeof body.slug !== "string"
  ) {
    throw markPlatformError(new DvmError(
      "platform_response_invalid",
      "Platform deploy response is missing required fields (deployId, dvmId, or slug).",
      "Your platform may be outdated. Update it with: fly deploy --config fly.platform.toml"
    ));
  }
  return body as { deployId: string; dvmId: string; slug: string };
}

/**
 * Finalize a deploy's builder attestation after the platform assigns its
 * immutable DVM ID. The receipt secret is transient: the platform holds it
 * only long enough to set the deploy's runtime secret.
 */
export async function finalizeDvmDeployIdentity(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: {
    deployId: string;
    identityPubkey: string;
    attestationPayload: AttestationPayload;
    attestationSignature: string;
    capabilities: JsonValue;
    receiptSecret: string;
  }
): Promise<void> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/deploy-identity`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }
  );
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  throw platformResponseError(
    body.error?.code ?? "deploy_identity_finalize_failed",
    body.error,
    `Identity finalization failed with status ${res.status}`
  );
}

/** Result of a `dvmctl deploy --local` registration. */
export interface LocalDeployResult {
  dvmId: string;
  slug: string;
  url: string;
  /** Effective platform state after registration; local registration does not implicitly resume. */
  status: "deployed" | "suspended";
  /** Whether the builder's pause latch remains set. */
  paused: boolean;
  /** Why the DVM remains suspended, null when it is deployed. */
  suspensionReason: SuspensionReason | null;
  dvmkitUrl: string | null;
}

/**
 * Register a locally-running DVM into the local platform, pointing at its
 * localhost URL. No Fly, no build — the platform writes the `dvms`
 * row owned by the authenticated builder so the DVM resolves through the local
 * router and shows in the dashboard. An existing suspension remains in force;
 * dev-only: the platform returns `local_deploy_disabled` (403) unless
 * `DVMKIT_ALLOW_LOCAL_DEPLOY=true`.
 */
export async function deployLocal(
  platformUrl: string,
  token: string,
  opts: {
    slug: string;
    name: string;
    /** Reachable localhost URL the router proxies to (loopback/.internal host). */
    url: string;
    /** Runtime tier. Omitted → the platform registers a container. */
    runtime?: "container" | "isolate";
    /** Optional builder identity attestation. Sent only when an
     *  identity exists on disk; the platform verifies + persists it. */
    identityPubkey?: string;
    attestationPayload?: AttestationPayload;
    attestationSignature?: string;
    /** Declared capabilities block. The platform re-hashes this and
     *  cross-checks it against `attestationPayload.capabilities_hash`. */
    capabilities?: JsonValue;
    /** Org handle to create or redeploy within. */
    orgHandle?: string;
  }
): Promise<LocalDeployResult> {
  const res = await platformFetch(`${platformUrl}/api/v1/builder/deploy/local`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      slug: opts.slug,
      name: opts.name,
      url: opts.url,
      runtime: opts.runtime,
      identityPubkey: opts.identityPubkey,
      attestationPayload: opts.attestationPayload,
      attestationSignature: opts.attestationSignature,
      capabilities: opts.capabilities,
      orgHandle: opts.orgHandle,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    const code = body.error?.code ?? "local_deploy_failed";
    throw platformResponseError(code, body.error, `Local deploy failed with status ${res.status}`, {
      hint:
        code === "local_deploy_disabled"
          ? "Start the local stack with `npm run dev:stack` (it sets DVMKIT_ALLOW_LOCAL_DEPLOY=true)."
          : undefined,
    });
  }
  return (await res.json()) as LocalDeployResult;
}

/** Poll cadence for the `streamDeployLogs` progress + safety-net poller. */
export const DEPLOY_POLL_INTERVAL_MS = 15_000;

/** Get a deploy's current status. Used by the poller in `streamDeployLogs` and
 *  by `dvmctl deploy-status`. */
export async function getDeployStatus(
  platformUrl: string,
  token: string,
  deployId: string
): Promise<DeployStatusResponse> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/deploys/${encodeURIComponent(deployId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "deploy_status_failed",
      body.error,
      `Failed to get deploy status: ${res.status}`
    );
  }
  return (await res.json()) as DeployStatusResponse;
}

/**
 * Stream deploy logs via SSE, with a parallel status poller covering long
 * silences and SSE drops.
 *
 * Two cooperating loops:
 *
 * - **SSE consumer.** Reads `event: log` lines into `opts.onLog`. On
 *   `complete`/`error`, resolves/rejects. If the stream closes without a
 *   terminal event — owning platform machine restarted mid-build —
 *   opens one follow-up SSE request after a 1.5s pause. If that also drops,
 *   the poller takes over for a bounded recovery window.
 *
 * - **Status poller.** Every {@link DEPLOY_POLL_INTERVAL_MS} ms, fetches
 *   `GET /api/v1/builder/deploys/:id` and emits `opts.onPhase`. When the row hits a
 *   terminal status it short-circuits with a synthesized result (mirrors the
 *   shape the SSE's `complete`/`error` event would carry), so the CLI exits
 *   cleanly even when the SSE never delivers.
 *
 * Whichever loop reaches a terminal outcome first wins; the loser is
 * cancelled via the shared `AbortController`.
 */
export async function streamDeployLogs(
  platformUrl: string,
  token: string,
  deployId: string,
  opts: {
    onLog: (line: string) => void;
    onPhase?: (phase: DeployPhase) => void;
    onAccepted?: (release: AcceptedDeployRelease) => void;
    /** Override the status-poll cadence. Test-only; production callers should
     *  leave this unset and accept the {@link DEPLOY_POLL_INTERVAL_MS} default. */
    pollIntervalMs?: number;
    /** Bound after both SSE connections drop before returning a typed unknown outcome. Test-only. */
    recoveryTimeoutMs?: number;
    /** Delay before the one SSE reconnect. Test-only. */
    streamRetryDelayMs?: number;
  }
): Promise<DeployResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEPLOY_POLL_INTERVAL_MS;
  const recoveryTimeoutMs = opts.recoveryTimeoutMs ?? 75_000;
  const startTime = Date.now();
  const abortController = new AbortController();
  let acceptedRelease: AcceptedDeployRelease | undefined;
  let lastTransportError: unknown;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let streamLost = false;

  // Function-wrapped getter (rather than a bare `let` or even a ref object)
  // so TS doesn't narrow the settled flag to `false` across the awaits inside
  // the SSE consumer — `resolve`/`reject` mutate it from the poller closure,
  // and lint's `no-unnecessary-condition` rule flags any form TS can narrow.
  const state = { settled: false };
  const isSettled = (): boolean => state.settled;
  let resolveOuter!: (r: DeployResult) => void;
  let rejectOuter!: (e: unknown) => void;
  const outerPromise = new Promise<DeployResult>((res, rej) => {
    resolveOuter = res;
    rejectOuter = rej;
  });

  const resolve = (result: DeployResult): void => {
    if (isSettled()) return;
    state.settled = true;
    abortController.abort();
    resolveOuter(result);
  };
  const reject = (err: unknown): void => {
    if (isSettled()) return;
    state.settled = true;
    abortController.abort();
    rejectOuter(err);
  };

  // ── Status poller (load-bearing for long silences and SSE drops) ──
  const pollerInterval = setInterval(() => {
    if (isSettled()) return;
    void getDeployStatus(platformUrl, token, deployId).then(
      ({ deploy, dvm, recovery }) => {
        if (isSettled()) return;
        opts.onPhase?.({ status: deploy.status, elapsedMs: Date.now() - startTime });
        if (deploy.status === "deployed") {
          resolve({
            url: dvm.url ?? "",
            status: acceptedRelease && streamLost ? "deployed_unverified" : "deployed",
            dvmkitUrl: dvm.dvmkitUrl ?? null,
          });
        } else if (deploy.status === "failed" || deploy.status === "superseded") {
          const providerMessage = deploy.error ?? undefined;
          const healthFailure = deploy.releaseAcceptedAt != null;
          reject(
            new DvmError(
              deploy.status === "superseded"
                ? "deploy_superseded"
                : healthFailure
                  ? "deploy_health_verification_failed"
                  : "deploy_failed",
              providerMessage ??
                (deploy.status === "superseded"
                  ? "Deploy was superseded by a recovery rollout."
                  : "Deploy failed"),
              undefined,
              healthFailure
                ? {
                    release_accepted: true,
                    rollback: recovery
                      ? {
                          attempted: true,
                          status: recovery.status,
                          deploy_id: recovery.deployId,
                          target_deploy_id: recovery.targetDeployId,
                          error: recovery.error,
                        }
                      : { attempted: false, status: "not_available" },
                  }
                : undefined,
              undefined,
              providerMessage ? { message: "provider" } : undefined
            )
          );
        }
      },
      (err: unknown) => {
        lastTransportError = err;
        // Swallow poll errors — transient platform blips shouldn't kill the
        // deploy. The SSE may still win, or the next tick may succeed.
      }
    );
  }, pollIntervalMs);

  // ── SSE consumer (fast path) ───────────────────────────────────────
  void (async () => {
    try {
      const streamOnce = async () => {
        try {
          return await streamDeployLogsOnce(
            platformUrl,
            token,
            deployId,
            opts.onLog,
            (release) => {
              acceptedRelease = release;
              opts.onAccepted?.(release);
            },
            abortController.signal
          );
        } catch (err) {
          if (isAbortError(err)) throw err;
          if (!isDeployStreamTransportError(err)) throw err;
          lastTransportError = err;
          streamLost = true;
          return { kind: "dropped" } as const;
        }
      };

      const first = await streamOnce();
      if (isSettled()) return;
      if (first.kind === "result") {
        resolve(first.result);
        return;
      }
      if (first.kind === "error") {
        reject(
          acceptedRelease
            ? deployAcceptedReleaseError(deployId, acceptedRelease, first.error)
            : first.error
        );
        return;
      }
      streamLost = true;
      // Dropped without a terminal event. Give the server's recovery path
      // (~1.5s of SIGTERM drain or reconciler tick) time to flip the row.
      await new Promise((r) => setTimeout(r, opts.streamRetryDelayMs ?? 1500));
      if (isSettled()) return;
      const second = await streamOnce();
      if (isSettled()) return;
      if (second.kind === "result") {
        resolve(second.result);
        return;
      }
      if (second.kind === "error") {
        reject(
          acceptedRelease
            ? deployAcceptedReleaseError(deployId, acceptedRelease, second.error)
            : second.error
        );
        return;
      }
      // Both SSE attempts dropped without a terminal event. Don't reject —
      // the poller is still running and will catch terminal state when the
      // platform's Fly state reconciler flips the row, or when the build
      // actually finishes.
      recoveryTimer = setTimeout(() => {
        reject(deployRecoveryError(deployId, acceptedRelease, lastTransportError));
      }, recoveryTimeoutMs);
      recoveryTimer.unref();
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") return;
      reject(err);
    }
  })();

  try {
    return await outerPromise;
  } finally {
    clearInterval(pollerInterval);
    if (recoveryTimer) clearTimeout(recoveryTimer);
    abortController.abort();
  }
}

/**
 * Single SSE pass. Returns the final result, a parsed error, or `dropped` if
 * the connection closed without a terminal event. Used by `streamDeployLogs`
 * to layer a single retry on top.
 */
async function streamDeployLogsOnce(
  platformUrl: string,
  token: string,
  deployId: string,
  onLog: (line: string) => void,
  onAccepted: (release: AcceptedDeployRelease) => void,
  signal?: AbortSignal
): Promise<
  | { kind: "result"; result: DeployResult }
  | { kind: "error"; error: DvmError }
  | { kind: "dropped" }
> {
  const url = `${platformUrl}/api/v1/builder/deploys/${deployId}/logs`;
  const res = await platformFetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal,
  });
  if (!res.ok) {
    return {
      kind: "error",
      error: markPlatformError(new DvmError("deploy_stream_failed", `Failed to stream deploy logs: ${res.status}`)),
    };
  }
  const reader = res.body?.getReader();
  if (!reader) {
    return {
      kind: "error",
      error: markPlatformError(new DvmError("deploy_stream_failed", "No response body")),
    };
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    const { value } = chunk;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEvent = "";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ")) {
        dataLines.push(line.slice(6));
      } else if (line === "" && currentEvent) {
        const currentData = dataLines.join("\n");
        dataLines.length = 0;
        if (currentEvent === "log") {
          onLog(currentData);
        } else if (currentEvent === "accepted") {
          try {
            const release = JSON.parse(currentData) as AcceptedDeployRelease;
            if (
              typeof release.deployId !== "string" ||
              typeof release.url !== "string" ||
              (release.commitSha !== null && typeof release.commitSha !== "string")
            ) {
              throw new Error("invalid accepted-release payload");
            }
            onAccepted(release);
          } catch {
            return {
              kind: "error",
              error: new DvmError(
                "deploy_stream_failed",
                "Platform returned a malformed accepted-release event."
              ),
            };
          }
        } else if (currentEvent === "complete") {
          try {
            return { kind: "result", result: JSON.parse(currentData) as DeployResult };
          } catch {
            return {
              kind: "error",
              error: new DvmError(
                "deploy_failed",
                `Malformed deploy result: ${currentData}`,
                undefined,
                undefined,
                undefined,
                { message: "provider" }
              ),
            };
          }
        } else if (currentEvent === "error") {
          try {
            const err = JSON.parse(currentData) as {
              message: string;
              code?: string;
              releaseAccepted?: boolean;
              rollback?: Record<string, unknown>;
            };
            return {
              kind: "error",
              error: new DvmError(
                err.code ?? "deploy_failed",
                err.message,
                undefined,
                err.releaseAccepted
                  ? { release_accepted: true, rollback: err.rollback }
                  : undefined,
                undefined,
                { message: "provider" }
              ),
            };
          } catch {
            return {
              kind: "error",
              error: new DvmError("deploy_failed", currentData, undefined, undefined, undefined, {
                message: "provider",
              }),
            };
          }
        }
        currentEvent = "";
      }
    }
    chunk = await reader.read();
  }
  return { kind: "dropped" };
}

function isDeployStreamTransportError(err: unknown): boolean {
  return (
    (err instanceof DvmError && err.code === "platform_unreachable") ||
    err instanceof TypeError ||
    transportErrorCode(err) !== undefined
  );
}

function deployRecoveryError(
  deployId: string,
  release: AcceptedDeployRelease | undefined,
  transportError: unknown
): DvmError {
  const transportCode =
    transportError instanceof DvmError
      ? typeof transportError.data?.transport_code === "string"
        ? transportError.data.transport_code
        : undefined
      : transportErrorCode(transportError);
  if (!release) {
    return new DvmError(
      "deploy_status_unknown",
      `Deploy ${deployId} is still running or its final status could not be read.`,
      `Run \`dvmctl deploy-status ${deployId}\` to recover the authoritative result.`,
      {
        deploy_id: deployId,
        ...(transportCode ? { transport_code: transportCode } : {}),
      }
    );
  }

  const verificationUrl = `${release.url.replace(/\/$/, "")}/healthz`;
  const shaCheck = release.commitSha
    ? `confirm \`gitSha\` is \`${release.commitSha}\``
    : "read the served `gitSha`";
  return new DvmError(
    "deploy_release_accepted_status_unknown",
    `Fly accepted deploy ${deployId}, but dvmctl could not confirm its final platform status.`,
    `Run \`curl -s ${verificationUrl}\` and ${shaCheck}; then run \`dvmctl deploy-status ${deployId}\` to recover the platform result.`,
    {
      outcome: "partial_success",
      deploy_id: deployId,
      release_url: release.url,
      verification_url: verificationUrl,
      ...(release.commitSha ? { expected_git_sha: release.commitSha } : {}),
      ...(transportCode ? { transport_code: transportCode } : {}),
    },
    `Fly accepted deploy ${deployId}; only the final metadata/status confirmation was interrupted.`
  );
}

function deployAcceptedReleaseError(
  deployId: string,
  release: AcceptedDeployRelease,
  terminalError: DvmError
): DvmError {
  const verificationUrl = `${release.url.replace(/\/$/, "")}/healthz`;
  const shaCheck = release.commitSha
    ? `confirm \`gitSha\` is \`${release.commitSha}\``
    : "read the served `gitSha`";
  const providerMessage = terminalError.proseSources?.message === "provider";
  if (terminalError.code === "deploy_health_verification_failed") {
    return new DvmError(
      terminalError.code,
      terminalError.message,
      "Inspect the rollback outcome, then fix the candidate process and deploy again.",
      {
        outcome: "failed",
        deploy_id: deployId,
        release_accepted: true,
        release_url: release.url,
        ...(release.commitSha ? { expected_git_sha: release.commitSha } : {}),
        ...terminalError.data,
      },
      `Fly accepted deploy ${deployId}, but the candidate application did not become healthy.`,
      providerMessage ? { message: "provider" } : undefined
    );
  }
  return new DvmError(
    "deploy_release_accepted_epilogue_failed",
    `Fly accepted deploy ${deployId}, then the platform reported: ${terminalError.message}`,
    `Run \`curl -s ${verificationUrl}\` and ${shaCheck}; then run \`dvmctl deploy-status ${deployId}\` to recover the authoritative platform result.`,
    {
      outcome: "partial_success",
      deploy_id: deployId,
      release_url: release.url,
      verification_url: verificationUrl,
      ...(release.commitSha ? { expected_git_sha: release.commitSha } : {}),
      terminal_error_code: terminalError.code,
      terminal_error: providerMessage
        ? { _source: "provider", text: terminalError.message }
        : terminalError.message,
    },
    `Fly accepted deploy ${deployId}, but its post-release finalization reported an error.`,
    providerMessage ? { message: "provider" } : undefined
  );
}

export async function getMetrics(
  platformUrl: string,
  token: string,
  dvmId: string,
  hours: number
): Promise<RequestMetric[]> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/metrics?hours=${hours}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "metrics_failed",
      body.error,
      `Failed to get metrics: ${res.status}`
    );
  }
  const body = (await res.json()) as { metrics: RequestMetric[] };
  return body.metrics;
}

/** Chronological event feed for a DVM, as returned by `GET /dvms/:slug/events`. */
export interface EventsResult {
  slug: string;
  /** The look-back window applied, as a duration string (e.g. `7d`). */
  since: string;
  events: DvmEventEntry[];
  /** Present only when a partial source (e.g. Fly machine events) was unavailable. */
  warnings?: string[];
}

/** Get the recent event feed (deploys, restarts, scale, env, machine state) for a deployed DVM. */
export async function getEvents(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: { since?: string } = {}
): Promise<EventsResult> {
  const params = new URLSearchParams();
  if (opts.since) params.set("since", opts.since);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/events${qs}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "events_failed",
      body.error,
      `Failed to get events: ${res.status}`
    );
  }
  return (await res.json()) as EventsResult;
}

/** Get env var names for a deployed DVM. */
export async function getEnv(platformUrl: string, token: string, dvmId: string): Promise<string[]> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/env`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "env_failed",
      body.error,
      `Failed to get env: ${res.status}`
    );
  }
  const body = (await res.json()) as { env: string[] };
  return body.env;
}

/** A secret's name + last-applied metadata as returned by the platform. Never the value. */
export interface SecretInfo {
  /** Secret name, e.g. `SCRAPFLY_API_KEY`. */
  name: string;
  /** ISO timestamp the secret was last applied. */
  last_applied_at: string;
  /** Fly's content digest of the value (changes when the value changes). */
  digest_hash: string;
}

/**
 * List a DVM's builder-configured secrets — names + last-applied metadata,
 * never values. Platform-injected keys are excluded by the platform.
 */
export async function listSecrets(
  platformUrl: string,
  token: string,
  dvmId: string
): Promise<SecretInfo[]> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/secrets`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "secrets_failed",
      body.error,
      `Failed to list secrets: ${res.status}`
    );
  }
  const body = (await res.json()) as { secrets: SecretInfo[] };
  return body.secrets;
}

export async function setEnv(
  platformUrl: string,
  token: string,
  dvmId: string,
  changes: { set?: Record<string, string>; unset?: string[] }
): Promise<void> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/env`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; hint?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "env_failed",
      body.error,
      `Failed to update env: ${res.status}`
    );
  }
}

/** Result of superseding a stuck deploy with corrected secrets and a known-good image. */
export interface SecretRecoveryResult {
  deployId: string;
  slug: string;
  supersededDeployId: string;
  targetDeployId: string;
}

/**
 * Atomically supersede a stuck deploy, stage corrected secrets, and redeploy a
 * caller-selected successful image. Private values exist only in the request.
 */
export async function recoverDvmSecrets(
  platformUrl: string,
  token: string,
  dvmId: string,
  body: {
    set: Record<string, string>;
    to: string;
  }
): Promise<SecretRecoveryResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/secret-recovery`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const response = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; hint?: string; data?: Record<string, unknown> };
    };
    throw platformResponseError(
      response.error?.code ?? "secret_recovery_failed",
      response.error,
      `Secret recovery failed: ${res.status}`
    );
  }
  return (await res.json()) as SecretRecoveryResult;
}

export async function getLogs(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: { lines?: number; since?: string } = {}
): Promise<string[]> {
  const params = new URLSearchParams({ stream: "false" });
  if (opts.lines != null) params.set("lines", String(opts.lines));
  if (opts.since) params.set("since", opts.since);
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/logs?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "logs_failed",
      body.error,
      `Failed to get logs: ${res.status}`
    );
  }
  const body = (await res.json()) as { logs: string[] };
  return body.logs;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  machine_id: string;
}

export async function execCommand(
  platformUrl: string,
  token: string,
  dvmId: string,
  command: string,
  opts: { machine?: string } = {}
): Promise<ExecResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/exec`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command,
        ...(opts.machine ? { machine: opts.machine } : {}),
      }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; hint?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "ssh_failed",
      body.error,
      `SSH command failed: ${res.status}`
    );
  }
  return (await res.json()) as ExecResult;
}

/** Post-restart state of a single Fly machine. */
export interface RestartedMachine {
  id: string;
  state: string;
}

export interface RestartResult {
  machines: RestartedMachine[];
  restarted: number;
}

/** Restart a deployed DVM's running Fly machines (all, or a single `--machine`). */
export async function restartMachines(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: { machine?: string } = {}
): Promise<RestartResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/restart`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.machine ? { machine: opts.machine } : {}),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; hint?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "restart_failed",
      body.error,
      `Restart failed: ${res.status}`
    );
  }
  return (await res.json()) as RestartResult;
}

/**
 * Result of pausing or resuming a DVM: the post-call state of every Fly
 * machine. `status` / `paused` carry the same meaning as in {@link StatusResult}
 * — a paused DVM is a `suspended` one whose suspension is the builder's own.
 */
export interface PauseResult {
  slug: string;
  status: DvmStatus;
  paused: boolean;
  machines: RestartedMachine[];
  /** Machines the call acted on — stopped by `pause`, started by `resume`. */
  stopped?: number;
  started?: number;
}

/** Take a deployed DVM offline: stop its Fly machines, keep slug, data, secrets and DB. */
export async function pauseDvm(
  platformUrl: string,
  token: string,
  dvmId: string
): Promise<PauseResult> {
  return pauseCall(platformUrl, token, dvmId, "pause");
}

/** Bring a paused or idle-suspended DVM back: start its Fly machines again, same image, no redeploy. */
export async function resumeDvm(
  platformUrl: string,
  token: string,
  dvmId: string
): Promise<PauseResult> {
  return pauseCall(platformUrl, token, dvmId, "resume");
}

async function pauseCall(
  platformUrl: string,
  token: string,
  dvmId: string,
  verb: "pause" | "resume"
): Promise<PauseResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/${verb}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; hint?: string };
    };
    throw platformResponseError(
      body.error?.code ?? `${verb}_failed`,
      body.error,
      `${verb === "pause" ? "Pause" : "Resume"} failed: ${res.status}`
    );
  }
  return (await res.json()) as PauseResult;
}

/** A resolved VM config as returned by the scale endpoint. */
export interface ScaleVmConfig {
  memoryMb: number;
  cpuCount: number;
  cpuKind: "shared" | "performance";
  minMachinesRunning: number;
  maxMachines: number;
}

/** Result of scaling a deployed DVM — machine config before and after the change. */
export interface ScaleResult {
  slug: string;
  before: ScaleVmConfig;
  after: ScaleVmConfig;
}

export async function scaleDvm(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: { count?: number; size?: string }
): Promise<ScaleResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/scale`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(opts.count !== undefined ? { count: opts.count } : {}),
        ...(opts.size !== undefined ? { size: opts.size } : {}),
      }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; hint?: string; data?: Record<string, unknown> };
    };
    throw platformResponseError(
      body.error?.code ?? "scale_failed",
      body.error,
      `Scale failed: ${res.status}`
    );
  }
  return (await res.json()) as ScaleResult;
}

export interface RollbackResult {
  /** ID of the new `trigger: "rollback"` deploy. Poll via `deploy-status` or stream its logs. */
  deployId: string;
  slug: string;
  /** ID of the deploy whose image is being redeployed. */
  rolledBackTo: string;
}

/**
 * Roll a deployed DVM back to a previous successful deploy's image. Default
 * target is the previous deploy; `opts.to` picks a specific `deploy_id`. The
 * platform redeploys asynchronously — the returned `deployId` streams progress
 * via {@link streamDeployLogs}, same as a normal deploy.
 */
export async function rollbackDvm(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: { to?: string } = {}
): Promise<RollbackResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/rollback`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.to ? { to: opts.to } : {}),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; hint?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "rollback_failed",
      body.error,
      `Rollback failed: ${res.status}`
    );
  }
  return (await res.json()) as RollbackResult;
}

/** Image a DVM's Fly machine is running. */
export interface MachineImage {
  version: string | null;
  sha: string | null;
}

/** Live result of one health check on a DVM's Fly machine. */
export interface MachineHealthCheck {
  name: string | null;
  status: string | null;
  output: string | null;
  endpoint: string | null;
}

/** Live runtime state of a single Fly machine backing a deployed DVM. */
export interface MachineStatus {
  id: string;
  state: string;
  region: string | null;
  instance_id: string | null;
  created: string | null;
  started: string | null;
  image: MachineImage;
  checks: MachineHealthCheck[];
}

/** Scale summary across a DVM's Fly machines. */
export interface StatusScale {
  count: number;
  vm_size: { cpus: number | null; cpu_kind: string | null; memory_mb: number | null } | null;
}

/** Live Fly-side runtime state for a deployed DVM. */
export interface StatusResult {
  slug: string;
  /** DVM-level status from the platform DB — `deployed`, `suspended`, … */
  status: DvmStatus;
  /**
   * True when the builder's `dvmctl pause` is on record. Stays true while a
   * platform suspension sits on top of the pause, so it doesn't on its own mean
   * `dvmctl resume` will bring the DVM back — read it with `suspensionReason`.
   */
  paused: boolean;
  /**
   * Why the DVM is suspended; null when it isn't. `builder_pause` is the
   * builder's own pause and `free_tier_idle` is the platform parking a quiet
   * free-tier DVM — `dvmctl resume` lifts either. Every other reason is a
   * platform suspension and `dvmctl resume` refuses it.
   */
  suspensionReason: SuspensionReason | null;
  /**
   * Set while a destroy is winding the DVM down because callers still hold
   * prepaid balances: it is deleted after `delete_after` (Unix ms).
   */
  withdrawal: { started_at: number; delete_after: number; keep_db: boolean } | null;
  /** Whether callers can reclaim balances right now; false only under a hard suspension. */
  reclaimsOpen: boolean;
  machines: MachineStatus[];
  scale: StatusScale;
}

/** Fetch live Fly-side runtime state (machines, region, image, health, scale) for a deployed DVM. */
export async function getMachineStatus(
  platformUrl: string,
  token: string,
  dvmId: string
): Promise<StatusResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/status`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "status_failed",
      body.error,
      `Status failed: ${res.status}`
    );
  }
  return (await res.json()) as StatusResult;
}

/**
 * Build the websocket URL for an interactive ssh session. Maps the platform's
 * http(s) base to ws(s) and appends the optional machine selector. Exported for
 * unit testing.
 */
export function buildSshWsUrl(platformUrl: string, dvmId: string, machine?: string): string {
  const wsBase = platformUrl
    .replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`)
    .replace(/\/+$/, "");
  const query = machine ? `?machine=${encodeURIComponent(machine)}` : "";
  return `${wsBase}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/ssh${query}`;
}

/**
 * Open an interactive PTY shell on a running Fly machine of a deployed DVM,
 * relayed over a websocket. Puts the local terminal in raw mode and pipes bytes
 * both ways; resolves with the remote shell's exit code. Requires an
 * interactive TTY (a pipe can't drive a shell — use `execCommand` instead).
 */
export async function openSshSession(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: { machine?: string } = {}
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new DvmError(
      "not_a_tty",
      "An interactive shell requires a terminal.",
      'Run `dvmctl ssh <slug>` from an interactive terminal, or pass --command "..." for a one-shot command.'
    );
  }

  const { default: WebSocket } = await import("ws");
  const url = buildSshWsUrl(platformUrl, dvmId, opts.machine);

  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const stdin = process.stdin;
    let exitCode = 0;
    let settled = false;

    const onStdin = (chunk: Buffer): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    };
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onStdin);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      done();
    };

    // Auth/ownership/state/selection failures arrive as a non-101 HTTP response
    // on the handshake; surface the platform's error code (e.g. 404 not_found,
    // 409 suspended_by_platform) and its hint.
    ws.on("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        let code = "ssh_failed";
        let message = `Failed to open shell: ${res.statusCode}`;
        let hint: string | undefined;
        let remote: PlatformErrorBody | undefined;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            error?: { code?: string; message?: string; hint?: string };
          };
          if (body.error?.code) code = body.error.code;
          if (body.error?.message) message = body.error.message;
          hint = body.error?.hint;
          remote = body.error;
        } catch {
          // non-JSON error body — keep defaults
        }
        finish(() => {
          reject(platformResponseError(code, remote, message, { hint }));
        });
      });
    });

    ws.on("open", () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onStdin);
    });

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      if (isBinary) {
        process.stdout.write(buf);
        return;
      }
      // Text control frame: { type: "exit", code } | { type: "error", message }
      try {
        const msg = JSON.parse(buf.toString()) as {
          type?: string;
          code?: number;
          message?: string;
        };
        if (msg.type === "exit") {
          exitCode = msg.code ?? 0;
        } else if (msg.type === "error") {
          finish(() => {
            reject(
              new DvmError(
                "ssh_failed",
                msg.message ?? "Remote shell error",
                undefined,
                undefined,
                undefined,
                msg.message ? { message: "provider" } : undefined
              )
            );
          });
        }
      } catch {
        // Unrecognised text frame — write through so nothing is silently lost.
        process.stdout.write(buf);
      }
    });

    ws.on("close", () => {
      finish(() => {
        resolve(exitCode);
      });
    });
    ws.on("error", (err: Error) => {
      finish(() => {
        reject(new DvmError("ssh_failed", err.message));
      });
    });
  });
}

/** Stream logs via SSE from a deployed DVM. Returns a stop handle. */
export async function streamLogs(
  platformUrl: string,
  token: string,
  dvmId: string,
  opts: { since?: string },
  onLine: (line: string) => void
): Promise<{ stop: () => void }> {
  const params = new URLSearchParams({ stream: "true" });
  if (opts.since) params.set("since", opts.since);
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/logs?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
    }
  );

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "logs_failed",
      body.error,
      `Failed to stream logs: ${res.status}`
    );
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw markPlatformError(new DvmError("logs_failed", "No response body"));
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const readLoop = async () => {
    let chunk = await reader.read();
    while (!chunk.done) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7);
        } else if (line.startsWith("data: ") && currentEvent === "log") {
          onLine(line.slice(6));
        } else if (line === "") {
          currentEvent = "";
        }
      }
      chunk = await reader.read();
    }
  };

  readLoop().catch(() => {
    /* stream ended */
  });

  return {
    stop: () => {
      void reader.cancel();
    },
  };
}

// ── DVM Transfer ──────────────────────────────────────────

/** Body for the transfer endpoint — either an existing target or create-and-transfer. */
export type TransferBody =
  | { to: string }
  | { to: { create: { handle: string; displayName?: string } } };

export interface TransferResult {
  status: "transferred" | "noop";
  slug: string;
  to: string;
  org?: { id: string; handle: string };
  treasuryRekeyPending?: boolean;
}

/** Transfer a DVM to an existing org, to personal, or into a newly created org. */
export async function transferDvm(
  platformUrl: string,
  token: string,
  dvmId: string,
  body: TransferBody
): Promise<TransferResult> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/transfer`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      data.error?.code ?? "transfer_failed",
      data.error,
      `Transfer failed: ${res.status}`
    );
  }
  return (await res.json()) as TransferResult;
}

// ── Revenue ──────────────────────────────────────────────

/** Response from `GET /api/v1/builder/revenue/series`. */
export interface RevenueSeriesResult {
  summary: {
    fiat_currency: string;
    period: { from: string; to: string };
    by_source_type_rail: {
      source_type: string;
      rail: string;
      gross_fiat_minor: number;
      count: number;
    }[];
    total_gross_fiat_minor: number;
    total_count: number;
    cross_rate_note?: string;
  };
  series: {
    monthly_by_rail: Record<string, unknown>[];
    monthly_by_source_type: Record<string, unknown>[];
    cumulative_net_by_date: Record<string, unknown>[];
  };
  stale_fx_warnings: string[];
  org: ReadScopeInfo;
}

/** Single revenue event from `GET /api/v1/builder/revenue/events`. */
export interface RevenueEvent {
  date: string;
  source_type: string;
  rail: string;
  dvm_slug: string;
  line_description: string;
  fiat_amount_minor: number;
  fiat_currency: string;
  net_fiat_minor: number;
  [key: string]: unknown;
}

/** Response from `GET /api/v1/builder/revenue/events`. */
export interface RevenueEventsResult {
  events: RevenueEvent[];
  total: number;
  org: ReadScopeInfo;
}

/**
 * Fetch the revenue summary series for the caller's org scope. Aggregates
 * need `member`; the raw events and the CSV export need `admin`, matching
 * the role gates on the `/orgs/:handle/revenue/*` routes.
 */
export async function getRevenueSeries(
  platformUrl: string,
  token: string,
  opts: { from: string; to: string; currency?: string; rail?: string; org?: string }
): Promise<RevenueSeriesResult> {
  const params = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.currency) params.set("currency", opts.currency);
  if (opts.rail) params.set("rail", opts.rail);
  if (opts.org) params.set("org", opts.org);
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/revenue/series?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    throw await orgScopedError(res, "revenue_series_failed", "Failed to get revenue", opts.org);
  }
  return (await res.json()) as RevenueSeriesResult;
}

/** Fetch paginated revenue events for the caller's org scope (admin+). */
export async function getRevenueEvents(
  platformUrl: string,
  token: string,
  opts: {
    from?: string;
    to?: string;
    currency?: string;
    rail?: string;
    limit?: number;
    offset?: number;
    org?: string;
  } = {}
): Promise<RevenueEventsResult> {
  const params = new URLSearchParams();
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  if (opts.currency) params.set("currency", opts.currency);
  if (opts.rail) params.set("rail", opts.rail);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.org) params.set("org", opts.org);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const res = await platformFetch(`${platformUrl}/api/v1/builder/revenue/events${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw await orgScopedError(
      res,
      "revenue_events_failed",
      "Failed to get revenue events",
      opts.org
    );
  }
  return (await res.json()) as RevenueEventsResult;
}

/** A CSV export plus the label of the org it was exported from. */
export interface RevenueCsvResult {
  csv: string;
  /** Org handle, or `"personal"` — read off the response's `X-Org` header. */
  org: string;
}

/**
 * Download revenue data as CSV for the caller's org scope (admin+). The body
 * is CSV, so the scope echo every other read carries in its JSON rides the
 * `X-Org` header here instead.
 */
export async function getRevenueCsv(
  platformUrl: string,
  token: string,
  opts: { from: string; to: string; currency?: string; rail?: string; org?: string }
): Promise<RevenueCsvResult> {
  const params = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.currency) params.set("currency", opts.currency);
  if (opts.rail) params.set("rail", opts.rail);
  if (opts.org) params.set("org", opts.org);
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/revenue/csv?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    throw await orgScopedError(res, "revenue_csv_failed", "Failed to get revenue CSV", opts.org);
  }
  return { csv: await res.text(), org: res.headers.get("X-Org") ?? "personal" };
}

// ── API Keys ─────────────────────────────────────────────

/** API key metadata (raw key is only returned on create). */
export interface ApiKeyInfo {
  id: string;
  label: string | null;
  key_prefix: string | null;
  created_at: number;
  last_used_at: number | null;
}

/** Response from `GET /api/v1/builder/api-keys`. */
export interface ApiKeysListResult {
  keys: ApiKeyInfo[];
  count: number;
  limit: number;
}

/** Response from `POST /api/v1/builder/api-keys` (includes raw key). */
export interface ApiKeyCreateResult {
  id: string;
  key: string;
  label: string;
  created_at: number;
}

export async function listApiKeys(platformUrl: string, token: string): Promise<ApiKeysListResult> {
  const res = await platformFetch(`${platformUrl}/api/v1/builder/api-keys`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "api_keys_failed",
      body.error,
      `Failed to list API keys: ${res.status}`
    );
  }
  return (await res.json()) as ApiKeysListResult;
}

export async function createApiKey(
  platformUrl: string,
  token: string,
  opts: { label?: string } = {}
): Promise<ApiKeyCreateResult> {
  const res = await platformFetch(`${platformUrl}/api/v1/builder/api-keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ label: opts.label }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      limit?: number;
      max?: number;
    };
    if (body.error === "api_key_limit_reached") {
      throw markPlatformError(new DvmError(
        "api_key_limit_reached",
        `API key limit reached (max ${body.limit ?? 10}).`,
        "Revoke an unused key first with `dvmctl api-keys revoke <id>`.",
        undefined,
        undefined,
        { message: "provider" }
      ));
    }
    if (body.error === "label_too_long") {
      throw markPlatformError(new DvmError(
        "label_too_long",
        `Label exceeds max length (${body.max ?? 64} chars).`,
        undefined,
        undefined,
        undefined,
        { message: "provider" }
      ));
    }
    const msg = (body as Record<string, unknown>).message;
    throw markPlatformError(new DvmError(
      "api_key_create_failed",
      typeof msg === "string" ? msg : `Failed to create API key: ${res.status}`,
      undefined,
      undefined,
      undefined,
      typeof msg === "string" ? { message: "provider" } : undefined
    ));
  }
  return (await res.json()) as ApiKeyCreateResult;
}

/** Fetch a trace by ID from the builder API (isolate-dataset spans only, redacted). */
export async function getBuilderTrace(
  platformUrl: string,
  token: string,
  traceId: string,
  opts: { org?: string } = {}
): Promise<TraceResult> {
  const url = new URL(`${platformUrl}/api/v1/builder/traces/${encodeURIComponent(traceId)}`);
  if (opts.org) url.searchParams.set("org", opts.org);
  const res = await platformFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw await orgScopedError(res, "trace_fetch_failed", "Failed to fetch trace", opts.org);
  }
  return (await res.json()) as TraceResult;
}

export async function deleteApiKey(platformUrl: string, token: string, id: string): Promise<void> {
  const res = await platformFetch(
    `${platformUrl}/api/v1/builder/api-keys/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string };
    };
    throw platformResponseError(
      body.error?.code ?? "api_key_delete_failed",
      body.error,
      `Failed to revoke API key: ${res.status}`
    );
  }
}

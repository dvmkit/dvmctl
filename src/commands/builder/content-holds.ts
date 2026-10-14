import { DvmError } from "@dvmkit/sdk/internal";
import type { ContentHoldsResponse } from "@dvmkit/sdk/server";

import { info, json, raw } from "../../shared/output.ts";
import { adminCall, connectAdmin } from "./admin-connection.ts";

export interface ContentHoldOptions {
  endpoint?: string;
  org?: string;
  human?: boolean;
  purpose?: string;
  reason?: string;
  reviewDueAt?: string;
}

export async function contentHolds(
  action: "list" | "place" | "renew" | "clear",
  handle: string,
  jobId: string,
  holdId: string | undefined,
  opts: ContentHoldOptions,
): Promise<void> {
  const reason = action === "list" ? undefined : requireReason(opts.reason);
  const reviewDueAt = action === "place" || action === "renew" ? requireReviewDate(opts.reviewDueAt) : undefined;
  if (action === "place" && opts.purpose !== "support" && opts.purpose !== "dispute") {
    throw new DvmError("invalid_purpose", "A hold needs a support or dispute purpose.", "Pass --purpose support or --purpose dispute.");
  }
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await adminCall<ContentHoldsResponse>(() => {
    switch (action) {
      case "list": return client.getContentHolds(jobId);
      case "place": return client.placeContentHold(jobId, { purpose: opts.purpose as "support" | "dispute", reason: reason!, review_due_at: reviewDueAt! });
      case "renew": return client.renewContentHold(jobId, holdId!, { reason: reason!, review_due_at: reviewDueAt! });
      case "clear": return client.clearContentHold(jobId, holdId!, { reason: reason! });
    }
  });
  const active = res.holds.filter((hold) => hold.cleared_at === null);
  const overdue = active.filter((hold) => hold.review_overdue);
  const display = `${active.length} active content hold(s); ${overdue.length} overdue for review. Effective expiry: ${deadline(res.content_expires_at)}. Baseline expiry: ${deadline(res.baseline_content_expires_at)}. Content ${res.content_available ? "available" : "unavailable"}.`;
  const hint = active.length > 0
    ? "Review each active hold, then renew its review date or explicitly clear it. A review date never clears a hold or deletes content. Clearing the last hold restores the baseline expiry, which may already be past."
    : "No active hold prevents automatic expiry. Place a support or dispute hold before content expires when retention is needed.";
  if (opts.human) {
    info(display);
    for (const hold of res.holds) {
      raw(`${hold.id}  ${hold.purpose}  ${hold.cleared_at === null ? "active" : "cleared"}  review=${deadline(hold.review_due_at)}${hold.review_overdue ? " overdue" : ""}  actor=${hold.actor}`);
    }
    info(hint);
    return;
  }
  json({ op: `content_holds_${action}`, handle, dvmId, ...res, active_count: active.length, review_overdue_count: overdue.length, display, hint });
}

function requireReason(reason: string | undefined): string {
  if (!reason || reason.trim().length === 0 || reason.length > 1000) {
    throw new DvmError("invalid_reason", "A reason must contain 1 to 1000 characters.", "Pass --reason with the support, dispute, review, or clearance reason.");
  }
  return reason;
}

function requireReviewDate(value: string | undefined): number {
  const date = value && /^\d+$/.test(value) ? Number(value) : value ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(date) || date <= Date.now()) {
    throw new DvmError("invalid_review_due_at", "The review date must be in the future.", "Pass --review-due-at as epoch milliseconds or an ISO 8601 date with a timezone, such as 2030-01-01T00:00:00Z. This is a review deadline, not a deletion date.");
  }
  if (value && !/^\d+$/.test(value) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new DvmError("invalid_review_due_at", "Use a review date with an explicit timezone.", "Pass epoch milliseconds or an ISO 8601 timestamp ending in Z or a timezone offset.");
  }
  return date;
}

function deadline(value: number | null): string {
  if (value === null) return "none";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? `${value} epoch milliseconds` : date.toISOString();
}

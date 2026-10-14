import { parseSince } from "../../lib/parse-since.ts";
import { resolveOrgScope } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { scopeLabel } from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface FeedbackListOptions {
  verdict?: "up" | "down";
  /** Look-back window: relative duration ("24h", "7d") or ISO 8601 timestamp. */
  since?: string;
  /** Opaque cursor returned by a prior page's `next_cursor`. */
  cursor?: string;
  /** Max rows to return. Platform caps at 100. */
  limit?: string;
  human?: boolean;
  /** Org handle to read as, overriding the `dvmctl switch` context. */
  org?: string;
}

export interface FeedbackEnableOptions {
  human?: boolean;
  /** Org handle to target, overriding the active `dvmctl switch` context. */
  org?: string;
}

export interface FeedbackDisableOptions {
  human?: boolean;
  /** Org handle to target, overriding the active `dvmctl switch` context. */
  org?: string;
}

/**
 * List caller-submitted feedback for a DVM in the caller's org scope.
 * Cursor-paginated; pass the response's `next_cursor` back via
 * `--cursor` to walk older pages.
 */
export async function feedbackList(slug: string, opts: FeedbackListOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const sinceMs = opts.since !== undefined ? parseSince(opts.since) : undefined;
  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;

  const result = await platformClient.listBuilderFeedback(platformUrl, token, {
    dvmId,
    verdict: opts.verdict,
    sinceMs,
    cursor: opts.cursor,
    limit,
    org: resolveOrgScope(opts),
  });

  if (opts.human) {
    info(`Org: ${scopeLabel(result.org)}`);
    if (result.feedback.length === 0) {
      info(`No feedback found for '${slug}' in ${scopeLabel(result.org)}.`);
      return;
    }
    info(`${result.feedback.length} feedback row(s):\n`);
    const idW = 8;
    const tsW = 20;
    const slugW = Math.max(4, ...result.feedback.map((r) => (r.slug ?? "(platform)").length));
    const pkW = 12;
    const traceW = 12;
    info(
      `  ${"ID".padEnd(idW)}  ${"CREATED".padEnd(tsW)}  ${"SLUG".padEnd(slugW)}  ${"CALLER".padEnd(pkW)}  ${"TRACE".padEnd(traceW)}  VERDICT  TIER              BODY`
    );
    for (const r of result.feedback) {
      const ts = r.created_at.replace("T", " ").slice(0, 19);
      const s = r.slug ?? "(platform)";
      const caller = (r.caller_pubkey ?? "-").slice(0, pkW);
      const trace = (r.trace_id ?? "-").slice(0, traceW);
      const body = r.body.length > 60 ? `${r.body.slice(0, 57)}…` : r.body;
      info(
        `  ${r.id.slice(0, idW).padEnd(idW)}  ${ts.padEnd(tsW)}  ${s.padEnd(slugW)}  ${caller.padEnd(pkW)}  ${trace.padEnd(traceW)}  ${(r.verdict ?? "-").padEnd(7)}  ${(r.tier ?? "-").padEnd(16)}  ${body}`
      );
    }
    if (result.next_cursor) {
      info(`\nMore results available — re-run with --cursor ${result.next_cursor}`);
    }
  } else {
    json({
      dvmId,
      slug,
      feedback: result.feedback,
      next_cursor: result.next_cursor,
      org: result.org,
    });
  }
}

/**
 * Enable caller-feedback collection for one of the authenticated builder's
 * DVMs. Subsequent `POST /api/v1/feedback` submissions for this
 * slug succeed.
 */
export async function feedbackEnable(slug: string, opts: FeedbackEnableOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const result = await platformClient.updateDvmSettings(platformUrl, token, dvmId, {
    feedback_enabled: true,
  });
  if (opts.human) {
    info(`Feedback notes enabled for '${slug}'.`);
  } else {
    json({ ...result, dvmId, slug });
  }
}

/**
 * Disable caller-feedback collection for one of the authenticated builder's
 * DVMs. Subsequent `POST /api/v1/feedback` submissions for this
 * slug without a verdict are rejected; verdicts are recorded without notes.
 */
export async function feedbackDisable(slug: string, opts: FeedbackDisableOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const result = await platformClient.updateDvmSettings(platformUrl, token, dvmId, {
    feedback_enabled: false,
  });
  if (opts.human) {
    info(`Feedback notes disabled for '${slug}'.`);
  } else {
    json({ ...result, dvmId, slug });
  }
}

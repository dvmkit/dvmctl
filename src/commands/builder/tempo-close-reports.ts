import { DvmError } from "@dvmkit/sdk/internal";

import { type AdminCashuClient } from "../../lib/admin-cashu-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, type AdminConnectionOptions, connectAdmin } from "./admin-connection.ts";

export interface TempoCloseReportsOptions extends AdminConnectionOptions {
  human?: boolean;
  limit?: number;
  after?: string;
  all?: boolean;
}

export interface TempoCloseReportActionOptions extends AdminConnectionOptions {
  human?: boolean;
  note?: string;
}

const AMOUNT_UNIT = "native token units";
const MAX_AMOUNT_PAGES = 5;
const QUEUE_HINT = "Check the target DVM, then run `dvmctl credit tempo-close-reports <handle> --all` to check the obligation ID, current state, retryable, and write_off_allowed flags before deciding again.";

export async function tempoCloseReports(handle: string, opts: TempoCloseReportsOptions): Promise<void> {
  const limit = opts.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new DvmError("invalid_limit", "--limit must be an integer in 1..50.", "Use --after with next_after to read the next page.");
  }
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await reportCall(() => client.getTempoCloseReports({ limit, after: opts.after, all: opts.all }));
  const display = `${res.reports.length} Tempo close report(s). Each amount is a potential builder payout in ${AMOUNT_UNIT}.`;
  const hint = "Retry reopens the search for the close so the builder's payout report can still be sent. Write-off permanently gives up that payout report if the close lands later; it does not refund the caller.";
  if (opts.human) {
    for (const report of res.reports) {
      raw(`${report.obligation_id}  ${report.status}  ${report.amount_native} ${AMOUNT_UNIT}` +
        `  channel=${report.channel_id}  retryable=${report.retryable}  write_off_allowed=${report.write_off_allowed}` +
        `  written_off=${report.written_off}  write-off-note=${JSON.stringify(report.write_off_note)}` +
        `  written_off_at_ms=${report.written_off_at_ms ?? "-"}`);
    }
    info(display);
    info(hint);
    if (res.next_after) info(`More rows: re-run with ${opts.all ? "--all " : ""}--after ${res.next_after}.`);
    return;
  }
  json({ op: "credit_tempo_close_reports", handle, dvmId, slug: handle, ...res,
    report_count: res.reports.length, amount_unit: AMOUNT_UNIT, display, hint });
}

export async function tempoCloseReportRetry(
  handle: string, obligationId: string, opts: TempoCloseReportActionOptions
): Promise<void> {
  const id = resolveId(obligationId);
  const { client, dvmId } = await connectAdmin(handle, opts);
  // The retry response contains no amount. Read the audit pages for a pre-retry
  // snapshot, but leave transition eligibility to the server's atomic check.
  const amount = await findAmount(client, id);
  const res = await reportCall(() => client.retryTempoCloseReport({ obligation_id: id }));
  const display = `Reopened the search for close ${res.obligation_id} (${amount ?? "amount unavailable"} ${AMOUNT_UNIT}) so the builder's payout report can still be sent.`;
  const hint = "The next service sweep searches again without broadcasting or changing the caller's drain. Check service events for delivery; the report has not been sent by this command.";
  if (opts.human) {
    info(display);
    info(hint);
    return;
  }
  json({ op: "credit_tempo_close_report_retry", handle, dvmId, slug: handle, ...res,
    amount_native: amount, amount_unit: AMOUNT_UNIT, display, hint });
}

export async function tempoCloseReportWriteOff(
  handle: string, obligationId: string, opts: TempoCloseReportActionOptions
): Promise<void> {
  const id = resolveId(obligationId);
  const note = opts.note?.trim();
  if (!note || note.length > 2000) {
    throw new DvmError("invalid_note", "--note must contain 1 to 2000 characters after trimming.",
      "Supply the reason for permanently giving up the builder's payout report with --note.");
  }
  const { client, dvmId } = await connectAdmin(handle, opts);
  const res = await reportCall(() => client.writeOffTempoCloseReport({ obligation_id: id, note }));
  const display = `Wrote off ${res.obligation_id}: ${res.amount_forgone_native} ${AMOUNT_UNIT} forgone. This permanently gives up the builder's payout report if the close lands later.`;
  const hint = "No caller funds moved or refund liability was discharged. If recovery becomes possible, explicitly retry before the close lands; a payout from a close that lands while written off will not be reported.";
  if (opts.human) {
    info(display);
    info(`Note: ${res.note}`);
    info(hint);
    return;
  }
  json({ op: "credit_tempo_close_report_write_off", handle, dvmId, slug: handle, ...res,
    amount_unit: AMOUNT_UNIT, display, hint });
}

function resolveId(value: string): string {
  const id = value.trim();
  if (!id) throw new DvmError("invalid_obligation_id", "An obligation ID is required.", QUEUE_HINT);
  return id;
}

async function findAmount(client: AdminCashuClient, id: string): Promise<string | null> {
  let after: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_AMOUNT_PAGES; pageIndex++) {
    const page = await reportCall(() => client.getTempoCloseReports({ limit: 50, all: true, after }));
    const report = page.reports.find((row) => row.obligation_id === id);
    if (report) return report.amount_native;
    after = page.next_after;
    if (!after) break;
  }
  return null;
}

async function reportCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await adminCall(fn);
  } catch (err) {
    if (err instanceof DvmError && !err.hint) {
      if (err.code === "tempo_close_report_conflict" || err.code === "tempo_close_report_not_found") {
        err.hint = QUEUE_HINT;
      } else if (err.code === "not_found" && err.data?.http_status === 404) {
        err.hint = "This DVM does not serve close-report routes. Upgrade the DVM to @dvmkit/sdk 0.10.0 or later, then retry.";
      } else if (err.code === "tempo_close_report_unavailable") {
        err.hint = "Configure hosted settlement reports on the DVM with @dvmkit/sdk 0.10.0 or later, then retry.";
      }
    }
    throw err;
  }
}

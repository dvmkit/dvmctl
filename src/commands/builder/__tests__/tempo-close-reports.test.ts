import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../lib/cashu/builder-lock-identity", () => ({
  resolveBuilderLockKeyringByHandle: vi.fn(async () => ({
    canonicalDvmId: "service-test",
    currentKeypair: { privkey: "11".repeat(32) },
  })),
  resolveBuilderLockKeyring: vi.fn(),
}));
vi.mock("../../../shared/output", () => ({ json: vi.fn(), info: vi.fn(), raw: vi.fn() }));

import { info, json, raw } from "../../../shared/output";
import { tempoWedged } from "../tempo-drains";

let server: Server;
let endpoint: string;
let requests: { method: string; url: string; body: unknown }[];
let status: number;
let listStatus: number;
let response: unknown;
let pages: Record<string, unknown>;
const report = {
  obligation_id: "close-test", channel_id: "0x1234", amount_native: "9007199254740993",
  status: "unmatched", created_at_ms: 1000, updated_at_ms: 2000, delivered_at_ms: null,
  retryable: true, write_off_allowed: true, written_off: false, write_off_note: null,
  written_off_at_ms: null,
};

beforeEach(async () => {
  vi.clearAllMocks();
  requests = [];
  status = 200;
  listStatus = 200;
  response = { reports: [report] };
  pages = {};
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : undefined });
    res.writeHead(req.method === "GET" && req.url?.includes("tempo-close-reports") ? listStatus : status,
      { "content-type": "application/json" });
    const url = new URL(req.url!, "http://localhost");
    const result = req.method === "GET" && url.pathname.endsWith("tempo-close-reports") && listStatus === 200
      ? pages[url.searchParams.get("after") ?? ""] ?? { reports: [report] }
      : response;
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

it.each([false, true])("directs timed recovery only when no close is confirmed with human=%s", async (human) => {
  response = { drains: [{
    credit_id: "credit-test", drain_id: "drain-test", channel_id: "0x1234", amount_micro: 10,
    amount_native: 10, currency: "usd", caller_pubkey: "test", status: "exit_required",
    created_at: 1000, written_off_at: null, write_off_note: null, chain: { chain: "unconfirmed" },
  }] };
  await tempoWedged("service", { endpoint, human });
  expect(requests[0].url).toContain("/admin/credit/tempo-drains?");
  if (human) {
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("exit_required"));
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/cooperative close is unavailable.*caller must recover.*timed exit/i));
  } else {
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      drains: [expect.objectContaining({ status: "exit_required" })], exit_required_count: 1,
      wedged_count: 0, repairable_count: 0,
      display: expect.stringMatching(/cooperative close is unavailable.*caller must recover.*timed exit/i),
    }));
  }
});

it.each([false, true])("lists report amounts, action flags, and audit history with human=%s", async (human) => {
  const { tempoCloseReports } = await import("../tempo-close-reports");
  pages["older"] = { reports: [{ ...report, status: "no_report", written_off: true,
    write_off_allowed: false, write_off_note: "History unavailable", written_off_at_ms: 3000 }], next_after: "next" };
  await tempoCloseReports("service", { endpoint, human, all: true, limit: 10, after: "older" });
  expect(requests).toEqual([{ method: "GET", url: "/admin/credit/tempo-close-reports?limit=10&after=older&all=1", body: undefined }]);
  if (human) {
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("9007199254740993 native token units"));
    expect(raw).toHaveBeenCalledWith(expect.stringContaining('write-off-note="History unavailable"'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("--all --after next"));
  } else {
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      reports: [expect.objectContaining({ amount_native: "9007199254740993", status: "no_report", written_off: true })],
      amount_unit: "native token units", next_after: "next",
    }));
  }
});

it("defaults to the action queue without the audit flag", async () => {
  const { tempoCloseReports } = await import("../tempo-close-reports");
  await tempoCloseReports("service", { endpoint });
  expect(requests[0].url).toBe("/admin/credit/tempo-close-reports?limit=20");
});

it.each([false, true])("reopens only the selected report and prints its exact amount with human=%s", async (human) => {
  const { tempoCloseReportRetry } = await import("../tempo-close-reports");
  pages[""] = { reports: [], next_after: "second" };
  pages["second"] = { reports: [report] };
  response = { status: "reserved", obligation_id: "close-test" };
  await tempoCloseReportRetry("service", " close-test ", { endpoint, human });
  expect(requests.map((r) => r.url)).toEqual([
    "/admin/credit/tempo-close-reports?limit=50&all=1",
    "/admin/credit/tempo-close-reports?limit=50&after=second&all=1",
    "/admin/credit/retry-tempo-close-report",
  ]);
  expect(requests[2]).toMatchObject({ method: "POST", body: { obligation_id: "close-test" } });
  if (human) expect(info).toHaveBeenCalledWith(expect.stringMatching(/9007199254740993 native token units.*payout report can still be sent/));
  else expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: "reserved", amount_native: "9007199254740993", amount_unit: "native token units" }));
});

it.each([false, true])("writes off only the named report with a trimmed note and exact forgone amount with human=%s", async (human) => {
  const { tempoCloseReportWriteOff } = await import("../tempo-close-reports");
  response = { status: "written_off", obligation_id: "close-test", channel_id: "0x1234",
    amount_forgone_native: "9007199254740993", note: "History unavailable" };
  await tempoCloseReportWriteOff("service", " close-test ", { endpoint, human, note: " History unavailable " });
  expect(requests).toEqual([{ method: "POST", url: "/admin/credit/write-off-tempo-close-report",
    body: { obligation_id: "close-test", note: "History unavailable" } }]);
  if (human) expect(info).toHaveBeenCalledWith(expect.stringMatching(/9007199254740993 native token units.*permanently gives up.*payout report/));
  else expect(json).toHaveBeenCalledWith(expect.objectContaining({ amount_forgone_native: "9007199254740993", amount_unit: "native token units" }));
});

it.each([
  { label: "missing", note: undefined }, { label: "empty", note: " " },
  { label: "oversized", note: "x".repeat(2001) },
])("rejects a $label write-off note before HTTP", async ({ note }) => {
  const { tempoCloseReportWriteOff } = await import("../tempo-close-reports");
  await expect(tempoCloseReportWriteOff("service", "close-test", { endpoint, note })).rejects.toMatchObject({ code: "invalid_note" });
  expect(requests).toEqual([]);
});

it.each([
  ["retry", 409, "tempo_close_report_conflict"], ["retry", 404, "tempo_close_report_not_found"],
  ["write-off", 409, "tempo_close_report_conflict"], ["write-off", 404, "tempo_close_report_not_found"],
] as const)("preserves the server's %s refusal at HTTP %s with a next step", async (action, httpStatus, code) => {
  const commands = await import("../tempo-close-reports");
  status = httpStatus;
  response = { error: code, message: "Report state refused by the service." };
  const command = action === "retry" ? commands.tempoCloseReportRetry : commands.tempoCloseReportWriteOff;
  await expect(command("service", "close-test", { endpoint, note: "Reviewed" })).rejects.toMatchObject({
    code, message: "Report state refused by the service.", data: { http_status: httpStatus },
    hint: expect.stringContaining("tempo-close-reports"),
  });
  expect(json).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(requests.at(-1)?.url).toBe(`/admin/credit/${action === "retry" ? "retry" : "write-off"}-tempo-close-report`);
});

it.each(["list", "retry", "write-off"] as const)("preserves unavailability and gives setup guidance for %s", async (action) => {
  const commands = await import("../tempo-close-reports");
  listStatus = 503;
  status = 503;
  response = { error: "tempo_close_report_unavailable", message: "Hosted settlement reports are not configured on this DVM." };
  const operation = action === "list" ? commands.tempoCloseReports("service", { endpoint })
    : action === "retry" ? commands.tempoCloseReportRetry("service", "close-test", { endpoint })
    : commands.tempoCloseReportWriteOff("service", "close-test", { endpoint, note: "Reviewed" });
  await expect(operation).rejects.toMatchObject({
    code: "tempo_close_report_unavailable", data: { http_status: 503 },
    hint: expect.stringContaining("Configure hosted settlement reports"),
  });
  expect(json).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
  expect(requests).toHaveLength(1);
});

const terminalDrain = {
  credit_id: "credit-test", drain_id: "drain-test", channel_id: "0x1234", amount_micro: 10,
  amount_native: 10, currency: "usd", caller_pubkey: "test", status: "exit_required",
  created_at: 1000, written_off_at: null, write_off_note: null,
};

it.each([false, true])("offers reconciliation for an exit_required close covering the debit with human=%s", async (human) => {
  response = { drains: [{ ...terminalDrain, chain: {
    chain: "found", transaction: "0x5678", refundedToPayer: "10", settledToPayee: "5",
  } }] };
  await tempoWedged("service", { endpoint, human });
  if (human) {
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("chain=refunded:10"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("1 whose on-chain refund covers the debit"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("tempo-reconcile"));
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("timed exit"));
  } else {
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      wedged_count: 1, repairable_count: 1, exit_required_count: 1, timed_exit_count: 0,
      hint: expect.stringContaining("tempo-reconcile"),
    }));
    expect(vi.mocked(json).mock.calls[0][0]).not.toMatchObject({ display: expect.stringContaining("timed exit") });
  }
});

it.each([false, true])("directs a landed short exit_required refund to full operator booking with human=%s", async (human) => {
  response = { drains: [{ ...terminalDrain, chain: {
    chain: "found", transaction: "0x5678", refundedToPayer: "9", settledToPayee: "6",
  } }] };
  await tempoWedged("service", { endpoint, human });
  if (human) {
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/credit-test.*drain-test.*close landed.*short.*tempo-book/i));
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/tempo-reconcile|tempo-write-off|timed exit/));
  } else {
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      wedged_count: 0, repairable_count: 0, short_refund_count: 0, timed_exit_count: 0,
      exit_required_short_refund_count: 1,
      display: expect.stringMatching(/close.*landed.*short.*tempo-book/i),
    }));
    expect(vi.mocked(json).mock.calls[0][0]).not.toMatchObject({ hint: expect.stringMatching(/tempo-reconcile|tempo-write-off|timed exit/) });
  }
});

it.each(["list", "retry", "write-off"] as const)("gives an SDK upgrade hint when the %s route is missing", async (action) => {
  const commands = await import("../tempo-close-reports");
  status = 404;
  if (action === "list") listStatus = 404;
  response = { error: "not_found" };
  const operation = action === "list" ? commands.tempoCloseReports("service", { endpoint })
    : action === "retry" ? commands.tempoCloseReportRetry("service", "close-test", { endpoint })
    : commands.tempoCloseReportWriteOff("service", "close-test", { endpoint, note: "Reviewed" });
  await expect(operation).rejects.toMatchObject({
    code: "not_found", data: { http_status: 404 },
    hint: expect.stringMatching(/upgrade.*@dvmkit\/sdk 0\.10\.0 or later/i),
  });
  expect(json).not.toHaveBeenCalled();
});

it.each([false, true])("bounds the pre-retry amount search to five pages with human=%s", async (human) => {
  const { tempoCloseReportRetry } = await import("../tempo-close-reports");
  pages[""] = { reports: [], next_after: "page-1" };
  for (let i = 1; i < 5; i++) pages[`page-${i}`] = { reports: [], next_after: `page-${i + 1}` };
  pages["page-5"] = { reports: [report] };
  response = { status: "reserved", obligation_id: "close-test" };
  await tempoCloseReportRetry("service", "close-test", { endpoint, human });
  expect(requests.filter((r) => r.method === "GET")).toHaveLength(5);
  expect(requests.at(-1)).toEqual({ method: "POST", url: "/admin/credit/retry-tempo-close-report", body: { obligation_id: "close-test" } });
  if (human) expect(info).toHaveBeenCalledWith(expect.stringContaining("amount unavailable"));
  else expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: "reserved", amount_native: null, amount_unit: "native token units" }));
});

const uncertainDrainCases = [
  { label: "unchecked chain", chain: undefined, amount_native: 10 },
  { label: "failed chain read", chain: { chain: "unreachable", error: "timeout" }, amount_native: 10 },
  { label: "missing close receipt", chain: { chain: "unreported", reference: "close-reference" }, amount_native: 10 },
  { label: "unknown chain result", chain: { chain: "unknown" }, amount_native: 10 },
  { label: "landed close with unknown debit", chain: { chain: "found", transaction: "0x5678", refundedToPayer: "10", settledToPayee: "5" }, amount_native: null },
  { label: "landed close with unreadable refund", chain: { chain: "found", transaction: "0x5678", refundedToPayer: "unknown", settledToPayee: "5" }, amount_native: 10 },
];

it.each(uncertainDrainCases.flatMap((row) => [false, true].map((human) => ({ ...row, human }))))(
  "requires checking $label before recovery with human=$human", async ({ chain, amount_native, human }) => {
    response = { drains: [{ ...terminalDrain, chain, amount_native }] };
    await tempoWedged("service", { endpoint, human, ...(chain === undefined ? { evidence: false } : {}) });
    if (human) {
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/credit-test.*drain-test.*chain evidence unavailable/i));
      expect(info).toHaveBeenCalledWith(expect.stringMatching(/re-run with chain lookups.*check the channel.*before choosing/i));
      expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/caller must recover.*timed exit/i));
    } else {
      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        timed_exit_count: 0, exit_required_evidence_unavailable_count: 1, repairable_count: 0,
        display: expect.stringMatching(/chain evidence unavailable/i),
        hint: expect.stringMatching(/re-run with chain lookups.*check the channel.*before choosing/i),
      }));
      expect(vi.mocked(json).mock.calls[0][0]).not.toMatchObject({ display: expect.stringMatching(/caller must recover.*timed exit/i) });
    }
  }
);

it.each([false, true])("keeps written-off audit rows visible without adding them to action counts with human=%s", async (human) => {
  const active = [
    { ...terminalDrain, drain_id: "cover-live", chain: { chain: "found", transaction: "0x5678", refundedToPayer: "10", settledToPayee: "5" } },
    { ...terminalDrain, drain_id: "short-live", chain: { chain: "found", transaction: "0x5678", refundedToPayer: "9", settledToPayee: "6" } },
    { ...terminalDrain, drain_id: "exit-live", chain: { chain: "unconfirmed" } },
    { ...terminalDrain, drain_id: "unknown-live", chain: { chain: "unreachable", error: "timeout" } },
  ];
  response = { drains: [...active, ...active.map((row) => ({ ...row, drain_id: row.drain_id.replace("live", "resolved"), written_off_at: 3000, write_off_note: "Reviewed" }))] };
  await tempoWedged("service", { endpoint, human, includeResolved: true });
  expect(requests[0].url).toContain("include_resolved=true");
  if (human) {
    expect(raw).toHaveBeenCalledTimes(8);
    expect(vi.mocked(raw).mock.calls.filter(([line]) => line.includes("written-off"))).toHaveLength(4);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("1 awaiting a decision, 1 whose on-chain refund covers the debit"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("1 drain(s): cooperative close is unavailable"));
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("resolved"));
  } else {
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      drains: expect.arrayContaining([expect.objectContaining({ drain_id: "short-resolved", written_off_at: 3000 })]),
      wedged_count: 1, repairable_count: 1, short_refund_count: 0, awaiting_close_count: 0,
      exit_required_count: 4, exit_required_short_refund_count: 1, timed_exit_count: 1,
      exit_required_evidence_unavailable_count: 1,
    }));
    expect((vi.mocked(json).mock.calls[0][0] as { drains: unknown[] }).drains).toHaveLength(8);
  }
});

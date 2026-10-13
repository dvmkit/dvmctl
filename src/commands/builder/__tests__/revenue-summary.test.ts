import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PlatformClientModule from "../../../lib/platform-client";

// Partial mock: `scopeLabel` is a pure formatter the command output depends on.
vi.mock("../../../lib/platform-client", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformClientModule>();
  return { ...actual, getRevenueSeries: vi.fn() };
});
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import type { ReadScopeInfo, RevenueSeriesResult } from "../../../lib/platform-client";
import * as platformClient from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { revenueSummary } from "../revenue-summary";

const PERSONAL: ReadScopeInfo = { id: "org-1", handle: null, role: "owner", personal: true };
const SHARED: ReadScopeInfo = { id: "org-2", handle: "dvmkit", role: "member", personal: false };

const fixture: RevenueSeriesResult = {
  summary: {
    fiat_currency: "usd",
    period: { from: "2026-01-01", to: "2026-01-31" },
    by_source_type_rail: [
      { source_type: "job_revenue", rail: "cashu", gross_fiat_minor: 1050, count: 3 },
      { source_type: "subscription", rail: "stripe", gross_fiat_minor: 2000, count: 1 },
    ],
    total_gross_fiat_minor: 3050,
    total_count: 4,
  },
  series: {
    monthly_by_rail: [],
    monthly_by_source_type: [],
    cumulative_net_by_date: [],
  },
  stale_fx_warnings: [],
  org: PERSONAL,
};

describe("dvmctl revenue summary", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits JSON with the full series response", async () => {
    vi.mocked(platformClient.getRevenueSeries).mockResolvedValue(fixture);

    await revenueSummary({ from: "2026-01-01", to: "2026-01-31" });

    expect(platformClient.getRevenueSeries).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      { from: "2026-01-01", to: "2026-01-31", currency: undefined, org: undefined }
    );
    expect(json).toHaveBeenCalledWith(fixture);
    expect(info).not.toHaveBeenCalled();
  });

  it("forwards currency option to the client", async () => {
    vi.mocked(platformClient.getRevenueSeries).mockResolvedValue(fixture);

    await revenueSummary({ from: "2026-01-01", to: "2026-01-31", currency: "eur" });

    expect(platformClient.getRevenueSeries).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      { from: "2026-01-01", to: "2026-01-31", currency: "eur", org: undefined }
    );
  });

  it("renders human summary with totals and breakdown", async () => {
    vi.mocked(platformClient.getRevenueSeries).mockResolvedValue(fixture);

    await revenueSummary({ from: "2026-01-01", to: "2026-01-31", human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("$30.50"))).toBe(true);
    expect(calls.some((c) => c.includes("4 events"))).toBe(true);
    expect(calls.some((c) => c.includes("cashu"))).toBe(true);
    expect(calls.some((c) => c.includes("stripe"))).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });

  it("prints stale FX warnings in human mode", async () => {
    const withWarnings = {
      ...fixture,
      stale_fx_warnings: ["BTC/USD rate is 3 days old"],
    };
    vi.mocked(platformClient.getRevenueSeries).mockResolvedValue(withWarnings);

    await revenueSummary({ from: "2026-01-01", to: "2026-01-31", human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("BTC/USD rate is 3 days old"))).toBe(true);
  });

  // The summary header names its org, so a member of a shared org
  // can tell whose revenue they are looking at.
  it("sends --org and names the scope in the header", async () => {
    vi.mocked(platformClient.getRevenueSeries).mockResolvedValue({ ...fixture, org: SHARED });

    await revenueSummary({ from: "2026-01-01", to: "2026-01-31", human: true, org: "dvmkit" });

    expect(vi.mocked(platformClient.getRevenueSeries).mock.calls[0][2]).toMatchObject({
      org: "dvmkit",
    });
    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("Revenue summary for dvmkit"))).toBe(true);
  });
});

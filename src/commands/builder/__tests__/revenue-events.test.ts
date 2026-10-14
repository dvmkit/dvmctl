import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PlatformClientModule from "../../../lib/platform-client";

// Partial mock: `scopeLabel` is a pure formatter the command output depends on.
vi.mock("../../../lib/platform-client", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformClientModule>();
  return { ...actual, getRevenueEvents: vi.fn() };
});
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import type { ReadScopeInfo, RevenueEventsResult } from "../../../lib/platform-client";
import * as platformClient from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { revenueEvents } from "../revenue-events";

const PERSONAL: ReadScopeInfo = { id: "org-1", handle: null, role: "owner", personal: true };
const SHARED: ReadScopeInfo = { id: "org-2", handle: "dvmkit", role: "admin", personal: false };

const fixture: RevenueEventsResult = {
  events: [
    {
      date: "2026-01-15",
      source_type: "job_revenue",
      rail: "cashu",
      dvm_slug: "cast",
      line_description: "Job abc123",
      fiat_amount_minor: 500,
      fiat_currency: "usd",
      net_fiat_minor: 480,
    },
  ],
  total: 1,
  org: PERSONAL,
};

describe("dvmctl revenue events", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits JSON with events and total", async () => {
    vi.mocked(platformClient.getRevenueEvents).mockResolvedValue(fixture);

    await revenueEvents({});

    expect(platformClient.getRevenueEvents).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      { from: undefined, to: undefined, rail: undefined, limit: undefined, org: undefined }
    );
    expect(json).toHaveBeenCalledWith(fixture);
    expect(info).not.toHaveBeenCalled();
  });

  it("forwards from, to, rail, and limit to the client", async () => {
    vi.mocked(platformClient.getRevenueEvents).mockResolvedValue(fixture);

    await revenueEvents({ from: "2026-01-01", to: "2026-01-31", rail: "cashu", limit: "10" });

    expect(platformClient.getRevenueEvents).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      { from: "2026-01-01", to: "2026-01-31", rail: "cashu", limit: 10, org: undefined }
    );
  });

  it("renders human table with event rows", async () => {
    vi.mocked(platformClient.getRevenueEvents).mockResolvedValue(fixture);

    await revenueEvents({ human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("1 total events"))).toBe(true);
    expect(calls.some((c) => c.includes("2026-01-15"))).toBe(true);
    expect(calls.some((c) => c.includes("cashu"))).toBe(true);
    expect(calls.some((c) => c.includes("cast"))).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });

  it("shows empty-state message in human mode", async () => {
    vi.mocked(platformClient.getRevenueEvents).mockResolvedValue({
      events: [],
      total: 0,
      org: PERSONAL,
    });

    await revenueEvents({ human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["  Org: personal", "  No revenue events found for personal."]);
  });

  // Revenue reads now resolve through the same org scope as the
  // rest of the CLI, so an empty report names the org it was empty for.
  it("sends --org and names the scope in the empty state", async () => {
    vi.mocked(platformClient.getRevenueEvents).mockResolvedValue({
      events: [],
      total: 0,
      org: SHARED,
    });

    await revenueEvents({ human: true, org: "dvmkit" });

    expect(vi.mocked(platformClient.getRevenueEvents).mock.calls[0][2]).toMatchObject({
      org: "dvmkit",
    });
    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["  Org: dvmkit", "  No revenue events found for dvmkit."]);
  });
});

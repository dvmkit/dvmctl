import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PlatformClientModule from "../../../lib/platform-client";

// Partial mock: `scopeLabel` is a pure formatter the command output depends on,
// so it stays real while the network calls are stubbed.
vi.mock("../../../lib/platform-client", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformClientModule>();
  return {
    ...actual,
    listDvms: vi.fn(),
    listBuilderFeedback: vi.fn(),
    updateDvmSettings: vi.fn(),
  };
});
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import type { ReadScopeInfo } from "../../../lib/platform-client";
import * as platformClient from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { feedbackDisable, feedbackEnable, feedbackList } from "../feedback";

const PERSONAL: ReadScopeInfo = { id: "org-1", handle: null, role: "owner", personal: true };
const SHARED: ReadScopeInfo = { id: "org-2", handle: "dvmkit", role: "member", personal: false };

const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  dvm_id: "dvm-cast",
  slug: "cast",
  owner_handle: "dvmkit",
  job_id: null,
  trace_id: null,
  caller_pubkey: "0".repeat(64),
  body: "great DVM",
  verdict: "down" as const,
  tier: "receipt_verified" as const,
  created_at: "2026-05-26T12:00:00.000Z",
};

describe("dvmctl feedback list", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
    vi.mocked(platformClient.listDvms).mockResolvedValue({
      dvms: [{ id: "dvm-cast", slug: "cast" }],
      org: PERSONAL,
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("forwards slug + options to the platform client and emits JSON", async () => {
    vi.mocked(platformClient.listBuilderFeedback).mockResolvedValue({
      feedback: [ROW],
      next_cursor: "next-cur",
      org: PERSONAL,
    });

    await feedbackList("cast", { limit: "10", cursor: "in-cur", verdict: "down" });

    expect(platformClient.listBuilderFeedback).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      {
        dvmId: "dvm-cast",
        sinceMs: undefined,
        cursor: "in-cur",
        limit: 10,
        org: undefined,
        verdict: "down",
      }
    );
    expect(json).toHaveBeenCalledWith({
      dvmId: "dvm-cast",
      slug: "cast",
      feedback: [ROW],
      next_cursor: "next-cur",
      org: PERSONAL,
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("resolves --since to a Unix-ms cutoff before calling the platform client", async () => {
    vi.mocked(platformClient.listBuilderFeedback).mockResolvedValue({
      feedback: [],
      next_cursor: null,
      org: PERSONAL,
    });

    const before = Date.now();
    await feedbackList("cast", { since: "24h" });
    const after = Date.now();

    const call = vi.mocked(platformClient.listBuilderFeedback).mock.calls[0]?.[2];
    if (call?.sinceMs === undefined) {
      throw new Error("expected listBuilderFeedback to be called with sinceMs");
    }
    expect(call.sinceMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(call.sinceMs).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000);
  });

  it("renders a column table + cursor hint in --human mode", async () => {
    vi.mocked(platformClient.listBuilderFeedback).mockResolvedValue({
      feedback: [ROW],
      next_cursor: "more-cur",
      org: PERSONAL,
    });

    await feedbackList("cast", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("CREATED"))).toBe(true);
    expect(calls.some((c) => c.includes("great DVM"))).toBe(true);
    expect(calls.some((c) => c.includes("more-cur"))).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });

  // The platform clears the key 90 days after the feedback arrived.
  it("renders a row whose caller key was cleared in --human mode", async () => {
    vi.mocked(platformClient.listBuilderFeedback).mockResolvedValue({
      feedback: [{ ...ROW, caller_pubkey: null }],
      next_cursor: null,
      org: PERSONAL,
    });

    await feedbackList("cast", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("great DVM"))).toBe(true);
  });

  it("reports an empty set in --human mode", async () => {
    vi.mocked(platformClient.listBuilderFeedback).mockResolvedValue({
      feedback: [],
      next_cursor: null,
      org: PERSONAL,
    });

    await feedbackList("cast", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["Org: personal", "No feedback found for 'cast' in personal."]);
  });

  // Reading a shared org's feedback used to return an empty array
  // from the caller's personal org, with no way to tell the two apart.
  it("sends --org and names the org an empty page was empty for", async () => {
    vi.mocked(platformClient.listBuilderFeedback).mockResolvedValue({
      feedback: [],
      next_cursor: null,
      org: SHARED,
    });

    await feedbackList("cast", { human: true, org: "dvmkit" });

    expect(vi.mocked(platformClient.listBuilderFeedback).mock.calls[0][2]).toMatchObject({
      org: "dvmkit",
    });
    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["Org: dvmkit", "No feedback found for 'cast' in dvmkit."]);
  });
});

describe("dvmctl feedback enable", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends feedback_enabled:true and emits JSON of the response", async () => {
    vi.mocked(platformClient.updateDvmSettings).mockResolvedValue({
      dvm_id: "dvm-cast",
      slug: "cast",
      settings: { feedback_enabled: true },
    });

    await feedbackEnable("cast", {});

    expect(platformClient.updateDvmSettings).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      "dvm-cast",
      { feedback_enabled: true }
    );
    expect(json).toHaveBeenCalledWith({
      dvm_id: "dvm-cast",
      dvmId: "dvm-cast",
      slug: "cast",
      settings: { feedback_enabled: true },
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("prints a confirmation in --human mode", async () => {
    vi.mocked(platformClient.updateDvmSettings).mockResolvedValue({
      dvm_id: "dvm-cast",
      slug: "cast",
      settings: { feedback_enabled: true },
    });

    await feedbackEnable("cast", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["Feedback notes enabled for 'cast'."]);
    expect(json).not.toHaveBeenCalled();
  });
});

describe("dvmctl feedback disable", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends feedback_enabled:false and emits JSON of the response", async () => {
    vi.mocked(platformClient.updateDvmSettings).mockResolvedValue({
      dvm_id: "dvm-cast",
      slug: "cast",
      settings: { feedback_enabled: false },
    });

    await feedbackDisable("cast", {});

    expect(platformClient.updateDvmSettings).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      "dvm-cast",
      { feedback_enabled: false }
    );
    expect(json).toHaveBeenCalledWith({
      dvm_id: "dvm-cast",
      dvmId: "dvm-cast",
      slug: "cast",
      settings: { feedback_enabled: false },
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("prints a confirmation in --human mode", async () => {
    vi.mocked(platformClient.updateDvmSettings).mockResolvedValue({
      dvm_id: "dvm-cast",
      slug: "cast",
      settings: { feedback_enabled: false },
    });

    await feedbackDisable("cast", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["Feedback notes disabled for 'cast'."]);
    expect(json).not.toHaveBeenCalled();
  });
});

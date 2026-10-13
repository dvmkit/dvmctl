import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../admin-connection.ts", () => ({ connectAdmin: vi.fn(), adminCall: (fn: () => Promise<unknown>) => fn() }));
vi.mock("../../../shared/output.ts", () => ({ info: vi.fn(), json: vi.fn(), raw: vi.fn() }));

import { connectAdmin } from "../admin-connection.ts";
import { contentHolds } from "../content-holds.ts";
import { info, json, raw } from "../../../shared/output.ts";

const client = { getContentHolds: vi.fn(), placeContentHold: vi.fn(), renewContentHold: vi.fn(), clearContentHold: vi.fn() };
const response = {
  job_id: "job-1", content_expires_at: null, content_available: true, baseline_content_expires_at: 1700000000000,
  holds: [{ id: "hold-1", purpose: "support", reason: "Investigate", actor: "public-key", job_id: "job-1", created_at: 1, review_due_at: 1700000000000, cleared_at: null, review_overdue: true }], events: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connectAdmin).mockResolvedValue({ client, dvmId: "service-id" } as never);
  for (const fn of Object.values(client)) fn.mockResolvedValue(response);
});

describe("content holds", () => {
  it("reports baseline and effective expiry separately, with overdue review action", async () => {
    await contentHolds("list", "service", "job-1", undefined, { endpoint: "https://service.example" });
    expect(client.getContentHolds).toHaveBeenCalledWith("job-1");
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ content_expires_at: null, baseline_content_expires_at: 1700000000000, active_count: 1, review_overdue_count: 1, hint: expect.stringContaining("never clears") }));
  });

  it("sends only reason, purpose, and a millisecond review deadline on placement", async () => {
    await contentHolds("place", "service", "job-1", undefined, { purpose: "dispute", reason: "Customer dispute", reviewDueAt: "2030-01-01T00:00:00Z" });
    expect(client.placeContentHold).toHaveBeenCalledWith("job-1", { purpose: "dispute", reason: "Customer dispute", review_due_at: 1893456000000 });
  });

  it("renews the selected hold and clears only that hold with a recorded reason", async () => {
    await contentHolds("renew", "service", "job-1", "hold-1", { reason: "Continue", reviewDueAt: "1893456000000" });
    expect(client.renewContentHold).toHaveBeenCalledWith("job-1", "hold-1", { reason: "Continue", review_due_at: 1893456000000 });
    await contentHolds("clear", "service", "job-1", "hold-1", { reason: "Resolved" });
    expect(client.clearContentHold).toHaveBeenCalledWith("job-1", "hold-1", { reason: "Resolved" });
  });

  it.each([
    { purpose: "other", reason: "Investigate", reviewDueAt: "2030-01-01T00:00:00Z" },
    { purpose: "support", reason: " ", reviewDueAt: "2030-01-01T00:00:00Z" },
    { purpose: "support", reason: "x".repeat(1001), reviewDueAt: "2030-01-01T00:00:00Z" },
    { purpose: "support", reason: "Investigate", reviewDueAt: "1700000000000" },
    { purpose: "support", reason: "Investigate", reviewDueAt: "2030-01-01" },
  ])("rejects invalid placement before opening a connection", async (opts) => {
    await expect(contentHolds("place", "service", "job-1", undefined, opts)).rejects.toMatchObject({ code: expect.stringMatching(/^invalid_/) });
    expect(connectAdmin).not.toHaveBeenCalled();
  });

  it("human output preserves hold ID, actor, deadlines, and explicit clearance warning", async () => {
    await contentHolds("list", "service", "job-1", undefined, { human: true });
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("hold-1  support  active  review=2023-11-14T22:13:20.000Z overdue  actor=public-key"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Baseline expiry: 2023-11-14T22:13:20.000Z"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("never clears"));
    expect(json).not.toHaveBeenCalled();
  });
  it("renders a valid server epoch beyond the ISO date range without failing after the operation", async () => {
    client.getContentHolds.mockResolvedValue({ ...response, holds: [{ ...response.holds[0], review_due_at: Number.MAX_SAFE_INTEGER }] });
    await contentHolds("list", "service", "job-1", undefined, { human: true });
    expect(raw).toHaveBeenCalledWith(expect.stringContaining("review=9007199254740991 epoch milliseconds"));
  });

});

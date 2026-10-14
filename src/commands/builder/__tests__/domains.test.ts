import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform-client");
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "test-token", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import * as platformClient from "../../../lib/platform-client";
import { info } from "../../../shared/output";
import { domains } from "../domains";

describe("dvmctl domains add", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(platformClient.listDvms).mockResolvedValue({
      dvms: [{ id: "dvm-cast", slug: "cast" }],
      org: { id: "org", handle: null, role: "owner", personal: true },
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prints hint when API returns one", async () => {
    vi.mocked(platformClient.addDomain).mockResolvedValue({
      hint: "Ensure your CNAME record points to dvmkit-router.fly.dev (`dvmctl domains verify cast cast.example.com`)",
    });

    await domains("add", "cast", { domain: "cast.example.com", human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("added");
    expect(calls[1]).toContain("CNAME");
  });

  it("skips hint when API returns none", async () => {
    vi.mocked(platformClient.addDomain).mockResolvedValue({});

    await domains("add", "cast", { domain: "cast.dvmkit.ai", human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("added");
  });
});

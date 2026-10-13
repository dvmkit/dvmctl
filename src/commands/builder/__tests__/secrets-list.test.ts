import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform-client");
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import * as platformClient from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { secretsList } from "../secrets-list";

describe("dvmctl secrets list", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
    vi.mocked(platformClient.listDvms).mockResolvedValue({
      dvms: [{ id: "dvm-scrape", slug: "scrape" }],
      org: { id: "org", handle: null, role: "owner", personal: true },
    } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits JSON with the slug and the platform's secrets array", async () => {
    const secrets = [
      { name: "SCRAPFLY_API_KEY", last_applied_at: "2026-01-01T00:00:00Z", digest_hash: "aaa" },
    ];
    vi.mocked(platformClient.listSecrets).mockResolvedValue(secrets);

    await secretsList("scrape", {});

    expect(platformClient.listSecrets).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      "dvm-scrape"
    );
    expect(json).toHaveBeenCalledWith({ dvmId: "dvm-scrape", slug: "scrape", secrets });
    expect(info).not.toHaveBeenCalled();
  });

  it("prints names + timestamps in --human mode", async () => {
    vi.mocked(platformClient.listSecrets).mockResolvedValue([
      { name: "SCRAPFLY_API_KEY", last_applied_at: "2026-01-01T00:00:00Z", digest_hash: "aaa" },
    ]);

    await secretsList("scrape", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("SCRAPFLY_API_KEY");
    expect(calls[0]).toContain("2026-01-01T00:00:00Z");
    expect(json).not.toHaveBeenCalled();
  });

  it("reports an empty set in --human mode", async () => {
    vi.mocked(platformClient.listSecrets).mockResolvedValue([]);

    await secretsList("scrape", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["No secrets set."]);
  });
});

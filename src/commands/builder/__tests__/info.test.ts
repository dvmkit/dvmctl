import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../../../lib/platform-client", () => ({
  getDvm: vi.fn(),
  listDvms: vi.fn(),
}));

import type { BuilderDvmView, ListDvmsResult } from "../../../lib/platform-client";
import { getDvm, listDvms } from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { dvmInfo } from "../info";

function response(overrides: Partial<BuilderDvmView> = {}) {
  return {
    dvm: {
      id: "dvm-xyz",
      orgId: "org-1",
      slug: "scrape",
      name: "Scrape",
      url: "https://dvmkit-scrape.fly.dev",
      dvmkitUrl: "https://builder--scrape.example.com",
      status: "deployed" as const,
      runtime: "container" as const,
      dvmMeta: null,
      hidden: false,
      region: "iad",
      suspensionReason: null,
      pausedAt: null,
      githubRepoFullName: null,
      gitBranch: null,
      rootDir: null,
      entrypoint: null,
      endpointUrl: null,
      lastJobAt: null,
      feedbackEnabled: true,
      lifetimeRevenueFiatMinor: 0,
      orgHandle: null,
      createdAt: 1_747_500_000_000,
      updatedAt: 1_747_500_090_000,
      ...overrides,
    },
    deploys: [],
    domains: [],
  };
}

const selection = (): ListDvmsResult => ({
  dvms: [response().dvm],
  org: { id: "org-1", handle: null, role: "owner", personal: true },
});

/** Every `info()` line joined, so assertions don't depend on line ordering. */
function printed(): string {
  return vi
    .mocked(info)
    .mock.calls.map((c) => c[0])
    .join("\n");
}

describe("dvmInfo", () => {
  beforeEach(() => {
    vi.mocked(info).mockReset();
    vi.mocked(json).mockReset();
    vi.mocked(getDvm).mockReset();
    vi.mocked(listDvms).mockResolvedValue(selection());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a cloud DVM's router address once", async () => {
    vi.mocked(getDvm).mockResolvedValue(response({ url: "https://builder--scrape.example.com" }));
    await dvmInfo("scrape", { human: true });

    expect(printed()).toContain("Public URL: https://builder--scrape.example.com");
    expect(printed().split("https://builder--scrape.example.com")).toHaveLength(2);
    expect(printed()).not.toContain("Upstream:");
    expect(getDvm).toHaveBeenCalledWith("https://platform.example", "tok", "dvm-xyz");
  });

  it("shows a connect-tier DVM's upstream beside its public URL", async () => {
    vi.mocked(getDvm).mockResolvedValue(
      response({ url: "https://scrape.example.com", endpointUrl: "https://scrape.example.com" })
    );
    await dvmInfo("scrape", { human: true });

    expect(printed()).toContain("Public URL: https://builder--scrape.example.com");
    expect(printed()).toContain("Upstream:   https://scrape.example.com");
  });

  it("points a handle-less builder at `dvmctl handle set` instead of an empty URL", async () => {
    vi.mocked(getDvm).mockResolvedValue(response({ dvmkitUrl: null }));
    await dvmInfo("scrape", { human: true });

    expect(printed()).toContain("dvmctl handle set");
  });

  it("carries dvmkitUrl in the JSON output", async () => {
    vi.mocked(getDvm).mockResolvedValue(response());
    await dvmInfo("scrape", {});

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        dvm: expect.objectContaining({ dvmkitUrl: "https://builder--scrape.example.com" }),
      })
    );
    expect(info).not.toHaveBeenCalled();
  });

  it("tells a builder who paused the DVM themselves how to bring it back", async () => {
    vi.mocked(getDvm).mockResolvedValue(
      response({
        status: "suspended",
        suspensionReason: "builder_pause",
        pausedAt: 1_747_500_100_000,
      })
    );
    await dvmInfo("scrape", { human: true });

    expect(printed()).toContain("paused — run `dvmctl resume` to bring it back");
  });

  it("names the platform's reason when it suspended a DVM the builder had also paused", async () => {
    vi.mocked(getDvm).mockResolvedValue(
      response({
        status: "suspended",
        suspensionReason: "request_limit",
        pausedAt: 1_747_500_100_000,
      })
    );
    await dvmInfo("scrape", { human: true });

    const out = printed();
    expect(out).toContain("request_limit");
    expect(out).toContain("you had also paused it");
  });
});

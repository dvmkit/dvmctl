import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PlatformClientModule from "../../../lib/platform-client";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../../../lib/platform-client", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformClientModule>();
  return { ...actual, listDvms: vi.fn() };
});

import type { ListDvmsResult, ReadScopeInfo } from "../../../lib/platform-client";
import { listDvms } from "../../../lib/platform-client";
import type { BuilderDvmWithRevenue } from "../../../builder-platform/types";
import { info, json } from "../../../shared/output";
import { list } from "../list";

function row(overrides: Partial<BuilderDvmWithRevenue> = {}): BuilderDvmWithRevenue {
  return {
    id: "dvm-xyz",
    orgId: "org-1",
    slug: "scrape",
    name: "Scrape",
    url: "https://dvmkit-scrape.fly.dev",
    dvmkitUrl: "https://builder--scrape.example.com",
    status: "deployed",
    runtime: "container",
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
    createdAt: 1_747_500_000_000,
    updatedAt: 1_747_500_090_000,
    ...overrides,
  };
}

const PERSONAL: ReadScopeInfo = { id: "org-1", handle: null, role: "owner", personal: true };
const SHARED: ReadScopeInfo = { id: "org-2", handle: "dvmkit", role: "member", personal: false };

function result(dvms: BuilderDvmWithRevenue[], org: ReadScopeInfo = PERSONAL): ListDvmsResult {
  return { dvms, org };
}

/** Every `info()` line joined, so assertions don't depend on line ordering. */
function printed(): string {
  return vi
    .mocked(info)
    .mock.calls.map((c) => c[0])
    .join("\n");
}

describe("list", () => {
  beforeEach(() => {
    vi.mocked(info).mockReset();
    vi.mocked(json).mockReset();
    vi.mocked(listDvms).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the public dvmkit.ai URL in the table, not the Fly origin", async () => {
    vi.mocked(listDvms).mockResolvedValue(result([row()]));
    await list({ human: true });

    expect(printed()).toContain("https://builder--scrape.example.com");
    expect(printed()).not.toContain("fly.dev");
  });

  it("falls back to the origin when the owner has no handle", async () => {
    vi.mocked(listDvms).mockResolvedValue(result([row({ dvmkitUrl: null })]));
    await list({ human: true });

    expect(printed()).toContain("https://dvmkit-scrape.fly.dev");
  });

  it("carries dvmkitUrl on every JSON row", async () => {
    vi.mocked(listDvms).mockResolvedValue(result([row(), row({ slug: "cast", dvmkitUrl: null })]));
    await list({});

    expect(json).toHaveBeenCalledWith({
      dvms: [
        expect.objectContaining({ dvmkitUrl: "https://builder--scrape.example.com" }),
        expect.objectContaining({ dvmkitUrl: null }),
      ],
      org: PERSONAL,
    });
    expect(info).not.toHaveBeenCalled();
  });

  // An empty fleet used to be indistinguishable from a scoping miss.
  it("names the org an empty result was empty for", async () => {
    vi.mocked(listDvms).mockResolvedValue(result([], SHARED));
    await list({ human: true, org: "dvmkit" });

    expect(printed()).toContain("No DVMs found in dvmkit.");
  });

  it("echoes the resolved scope in JSON so an agent can tell which org answered", async () => {
    vi.mocked(listDvms).mockResolvedValue(result([row()], SHARED));
    await list({ org: "dvmkit" });

    expect(vi.mocked(listDvms).mock.calls[0][2]).toEqual({ org: "dvmkit" });
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ org: SHARED }));
  });
});

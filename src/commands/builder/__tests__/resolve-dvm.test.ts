import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as PlatformClientModule from "../../../lib/platform-client";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org ?? "dvmkit"),
}));

vi.mock("../../../lib/platform-client", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformClientModule>();
  return { ...actual, listDvms: vi.fn() };
});

import { listDvms } from "../../../lib/platform-client";
import { resolveDvm } from "../resolve-dvm";

const scopedResult = {
  dvms: [
    { id: "dvm-dvmkit-scrape", slug: "scrape", dvmkitUrl: "https://dvmkit--scrape.dvmkit.ai" },
  ] as never,
  org: { id: "org-dvmkit", handle: "dvmkit", role: "admin" as const, personal: false },
};

describe("resolveDvm", () => {
  beforeEach(() => {
    vi.mocked(listDvms).mockReset();
    vi.mocked(listDvms).mockResolvedValue(scopedResult);
  });

  it("uses the saved active org to resolve a bare slug before returning its ID", async () => {
    await expect(resolveDvm("scrape")).resolves.toEqual({
      dvmId: "dvm-dvmkit-scrape",
      dvmkitUrl: "https://dvmkit--scrape.dvmkit.ai",
      platformUrl: "https://platform.example",
      token: "tok",
    });

    expect(listDvms).toHaveBeenCalledWith("https://platform.example", "tok", { org: "dvmkit" });
  });

  it("chooses the duplicate slug from the active or explicit org scope", async () => {
    vi.mocked(listDvms).mockImplementation(async (_platformUrl, _token, opts) => {
      if (opts?.org === "acme") {
        return {
          dvms: [
            { id: "dvm-acme-scrape", slug: "scrape", dvmkitUrl: "https://acme--scrape.dvmkit.ai" },
          ],
          org: { id: "org-acme", handle: "acme", role: "member", personal: false },
        } as never;
      }
      return scopedResult;
    });

    await expect(resolveDvm("scrape")).resolves.toMatchObject({ dvmId: "dvm-dvmkit-scrape" });
    await expect(resolveDvm("scrape", { org: "acme" })).resolves.toMatchObject({
      dvmId: "dvm-acme-scrape",
    });
    expect(listDvms).toHaveBeenNthCalledWith(1, "https://platform.example", "tok", { org: "dvmkit" });
    expect(listDvms).toHaveBeenNthCalledWith(2, "https://platform.example", "tok", { org: "acme" });
  });

  it("does not look outside the selected org when the slug is absent", async () => {
    vi.mocked(listDvms).mockResolvedValue({ ...scopedResult, dvms: [] });

    await expect(resolveDvm("scrape")).rejects.toMatchObject({
      code: "not_found",
      message: 'DVM "scrape" not found in dvmkit.',
    });
  });
});

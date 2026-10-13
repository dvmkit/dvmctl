import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform-client", () => ({ scaleDvm: vi.fn() }));
vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn() }));
vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({
    token: "token",
    platformUrl: "https://platform.example",
    dvmId: "dvm-id",
  })),
}));

import * as platformClient from "../../../lib/platform-client";
import { scale } from "../scale";

describe("dvmctl scale count", () => {
  beforeEach(() => vi.clearAllMocks());

  it("forwards a Studio-sized count for plan validation by the platform", async () => {
    vi.mocked(platformClient.scaleDvm).mockResolvedValue({
      slug: "my-dvm",
      before: {
        memoryMb: 256,
        cpuCount: 1,
        cpuKind: "shared",
        minMachinesRunning: 0,
        maxMachines: 1,
      },
      after: {
        memoryMb: 256,
        cpuCount: 1,
        cpuKind: "shared",
        minMachinesRunning: 0,
        maxMachines: 20,
      },
    });
    await scale("my-dvm", { count: "20" });
    expect(platformClient.scaleDvm).toHaveBeenCalledWith(
      "https://platform.example",
      "token",
      "dvm-id",
      { count: 20, size: undefined }
    );
  });

  it("rejects a count above the platform ceiling before contacting the scale route", async () => {
    await expect(scale("my-dvm", { count: "101" })).rejects.toMatchObject({
      code: "bad_request",
      message: "--count must be an integer between 1 and 100.",
    });
    expect(platformClient.scaleDvm).not.toHaveBeenCalled();
  });
});

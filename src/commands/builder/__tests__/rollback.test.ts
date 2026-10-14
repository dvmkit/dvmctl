import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform-client");
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
  progress: vi.fn(),
}));

import * as platformClient from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { rollback } from "../rollback";

describe("dvmctl rollback", () => {
  beforeEach(() => {
    vi.mocked(platformClient.listDvms).mockResolvedValue({
      dvms: [{ id: "dvm-cast", slug: "cast" }],
      org: { id: "org", handle: null, role: "owner", personal: true },
    } as never);
    vi.mocked(platformClient.rollbackDvm).mockResolvedValue({
      deployId: "dep-new",
      slug: "cast",
      rolledBackTo: "dep-prev",
    });
    vi.mocked(platformClient.streamDeployLogs).mockResolvedValue({
      url: "https://cast.fly.dev",
      status: "deployed",
      dvmkitUrl: "https://h--cast.dvmkit.ai",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rolls back to the previous deploy and emits JSON", async () => {
    await rollback("cast", {});

    expect(platformClient.rollbackDvm).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      "dvm-cast",
      { to: undefined }
    );
    expect(platformClient.streamDeployLogs).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      "dep-new",
      expect.any(Object)
    );
    expect(json).toHaveBeenCalledWith({
      status: "deployed",
      url: "https://cast.fly.dev",
      dvmkitUrl: "https://h--cast.dvmkit.ai",
      slug: "cast",
      dvmId: "dvm-cast",
      deployId: "dep-new",
      rolledBackTo: "dep-prev",
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("passes --to through to the platform client", async () => {
    await rollback("cast", { to: "dep-xyz" });

    expect(platformClient.rollbackDvm).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      "dvm-cast",
      { to: "dep-xyz" }
    );
  });

  it("prints human-readable progress in --human mode", async () => {
    await rollback("cast", { human: true });

    const lines = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(lines.some((l) => l.includes("dep-prev"))).toBe(true);
    expect(lines.some((l) => l.includes("dep-new"))).toBe(true);
    expect(lines.some((l) => l.includes("https://cast.fly.dev"))).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });
});

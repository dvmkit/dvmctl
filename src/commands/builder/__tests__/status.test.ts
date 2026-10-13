import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../../../lib/platform-client", () => ({
  getMachineStatus: vi.fn(),
  listDvms: vi.fn(),
}));

import type { ListDvmsResult, StatusResult } from "../../../lib/platform-client";
import { getMachineStatus, listDvms } from "../../../lib/platform-client";
import { info } from "../../../shared/output";
import { status } from "../status";

/**
 * `paused` is the builder's pause latch, which survives a platform
 * suspension layered on top of it — so the human copy has to read the
 * suspension reason to know whether `dvmctl resume` will actually work.
 */
function result(over: Partial<StatusResult>): StatusResult {
  return {
    slug: "my-dvm",
    status: "deployed",
    paused: false,
    suspensionReason: null,
    withdrawal: null,
    reclaimsOpen: true,
    machines: [],
    scale: { count: 0, vm_size: null },
    ...over,
  };
}

function lines(): string {
  return vi
    .mocked(info)
    .mock.calls.map((c) => c[0])
    .join("\n");
}

const selection: ListDvmsResult = {
  dvms: [{ id: "dvm-xyz", slug: "my-dvm" }] as never,
  org: { id: "org-1", handle: null, role: "owner", personal: true },
};

describe("dvmctl status --human suspension copy", () => {
  beforeEach(() => {
    vi.mocked(info).mockReset();
    vi.mocked(listDvms).mockResolvedValue(selection);
  });

  it("points a paused DVM's builder at `dvmctl resume`", async () => {
    vi.mocked(getMachineStatus).mockResolvedValue(
      result({ status: "suspended", paused: true, suspensionReason: "builder_pause" })
    );

    await status("my-dvm", { human: true });

    expect(lines()).toContain("is paused. Run `dvmctl resume my-dvm`");
    expect(getMachineStatus).toHaveBeenCalledWith("https://platform.example", "tok", "dvm-xyz");
  });

  it("does not offer `resume` when the platform suspended a DVM its builder had paused", async () => {
    vi.mocked(getMachineStatus).mockResolvedValue(
      result({ status: "suspended", paused: true, suspensionReason: "behaviour" })
    );

    await status("my-dvm", { human: true });

    const out = lines();
    expect(out).toContain("suspended by the platform (behaviour)");
    expect(out).toContain("`dvmctl resume` won't lift it");
    // The pause isn't lost — say so, or the builder resumes and finds it offline.
    expect(out).toContain("returns to paused");
  });

  it("reads an idle free-tier DVM as normal, not as enforcement", async () => {
    vi.mocked(getMachineStatus).mockResolvedValue(
      result({ status: "suspended", paused: false, suspensionReason: "free_tier_idle" })
    );

    await status("my-dvm", { human: true });

    const out = lines();
    expect(out).toContain("is idle");
    expect(out).toContain("next request wakes it");
    // ...and `resume` lifts it, which is what a builder needs to deploy, scale,
    // restart, exec or ssh — all of which refuse while the DVM is idle.
    expect(out).toContain("dvmctl resume my-dvm");
    // The steady state for most free-tier DVMs — it must not read as a sanction.
    expect(out).not.toContain("suspended by the platform");
  });

  it("reports a platform suspension with no pause behind it", async () => {
    vi.mocked(getMachineStatus).mockResolvedValue(
      result({ status: "suspended", paused: false, suspensionReason: null })
    );

    await status("my-dvm", { human: true });

    const out = lines();
    expect(out).toContain("suspended by the platform (operator)");
    expect(out).not.toContain("returns to paused");
  });

  it("gives a withdrawn DVM's deletion date instead of a suspension", async () => {
    vi.mocked(getMachineStatus).mockResolvedValue(
      result({
        status: "suspended",
        suspensionReason: "withdrawn",
        withdrawal: {
          started_at: Date.UTC(2026, 8, 1),
          delete_after: Date.UTC(2026, 9, 1, 12),
          keep_db: false,
        },
      })
    );

    await status("my-dvm", { human: true });

    const out = lines();
    expect(out).toContain("is being withdrawn");
    expect(out).toContain("until 2026-10-01 12:00:00 UTC");
    expect(out).not.toContain("suspended by the platform");
    expect(out).not.toContain("Reclaims are currently closed");
  });

  it("says nothing about suspension for a deployed DVM", async () => {
    vi.mocked(getMachineStatus).mockResolvedValue(result({}));

    await status("my-dvm", { human: true });

    expect(lines()).not.toContain("suspended");
  });
});

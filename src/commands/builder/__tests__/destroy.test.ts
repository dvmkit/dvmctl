import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn() }));
vi.mock("../../../lib/platform-client", () => ({ destroyDvm: vi.fn(), listDvms: vi.fn() }));
vi.mock("../admin-connection", () => ({ connectAdmin: vi.fn() }));

import type { AdminBitcoinLiabilityResponse } from "../../../lib/admin-cashu-client";
import type { ListDvmsResult } from "../../../lib/platform-client";
import { destroyDvm, listDvms } from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { connectAdmin } from "../admin-connection";
import { destroy } from "../destroy";

const liability: AdminBitcoinLiabilityResponse = {
  deposit_liability_sats: 1200,
  deposit_credits: 2,
  deposit_by_rail: [],
  deposit_by_currency: [],
  drain_liability_sats: 0,
  drain_count: 1,
  total_owed_sats: 1200,
  uncovered_credits: 0,
  uncovered_micro: 0,
  unbacked_credits: 1,
  unbacked_micro: 5,
  unpriced_drains: 0,
};

describe("dvmctl destroy", () => {
  beforeEach(() => {
    vi.mocked(info).mockReset();
    vi.mocked(json).mockReset();
    vi.mocked(destroyDvm).mockReset();
    vi.mocked(listDvms).mockResolvedValue({
      dvms: [{ id: "dvm-xyz", slug: "my-dvm" }] as never,
      org: { id: "org-1", handle: null, role: "owner", personal: true },
    } satisfies ListDvmsResult);
  });

  it("sends what the DVM's own ledger owes, so the platform can wind it down", async () => {
    vi.mocked(connectAdmin).mockResolvedValue({
      client: { getBitcoinLiability: vi.fn(async () => liability) },
      dvmId: "dvm-xyz",
    } as never);
    vi.mocked(destroyDvm).mockResolvedValue({
      status: "winding_down",
      dvmId: "dvm-xyz",
      slug: "my-dvm",
      keptDb: false,
      startedAt: 1,
      deleteAfter: 2,
      alreadyWindingDown: false,
      display: "my-dvm still owes callers prepaid balances…",
    });

    await destroy("my-dvm", { confirm: true });

    expect(destroyDvm).toHaveBeenCalledWith("https://platform.example", "tok", "dvm-xyz", {
      keepDb: false,
      ledger: { open_credits: 2, pending_drains: 1, gaps: 1 },
    });
    // A wind-down is not reported as a deletion.
    expect(vi.mocked(json).mock.calls[0][0]).toMatchObject({ status: "winding_down" });
  });

  it("still destroys when the ledger can't be read, leaving the platform's records to decide", async () => {
    vi.mocked(connectAdmin).mockRejectedValue(new Error("no builder mnemonic"));
    vi.mocked(destroyDvm).mockResolvedValue({
      status: "destroyed",
      dvmId: "dvm-xyz",
      slug: "my-dvm",
      keptDb: false,
    });

    await destroy("my-dvm", { confirm: true });

    expect(destroyDvm).toHaveBeenCalledWith("https://platform.example", "tok", "dvm-xyz", {
      keepDb: false,
    });
    expect(vi.mocked(json).mock.calls[0][0]).toEqual({
      status: "destroyed",
      dvmId: "dvm-xyz",
      slug: "my-dvm",
      keptDb: false,
    });
  });

  it.each([false, true])("gives export-order guidance before destruction, keepDb=%s", async (keepDb) => {
    vi.mocked(connectAdmin).mockRejectedValue(new Error("offline"));
    vi.mocked(destroyDvm).mockImplementation(async () => {
      expect(info).toHaveBeenCalledWith(expect.stringContaining("before destroying compute, with or without --keep-db"));
      expect(info).toHaveBeenCalledWith(expect.stringContaining("--keep-db preserves storage but removes compute and its database tunnel"));
      expect(info).toHaveBeenCalledWith(expect.stringContaining("reattaching the retained database before db connect or db proxy can work"));
      return { status: "destroyed", dvmId: "dvm-xyz", slug: "my-dvm", keptDb: keepDb };
    });
    await destroy("my-dvm", { confirm: true, keepDb });
    expect(destroyDvm).toHaveBeenCalledWith("https://platform.example", "tok", "dvm-xyz", { keepDb });
  });

  it.each([false, true])("keeps the selected org and destruction variant in safely quoted hints, keepDb=%s", async (keepDb) => {
    const org = "target'$(touch marker)";
    const scopedTarget = String.raw`my-dvm --org 'target'\''$(touch marker)'`;
    await expect(destroy("my-dvm", { org, keepDb })).rejects.toMatchObject({
      code: "confirmation_required",
      hint: expect.stringContaining(`dvmctl destroy ${scopedTarget}${keepDb ? " --keep-db" : ""} --confirm`),
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`dvmctl db proxy ${scopedTarget}`));
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`dvmctl db connect ${scopedTarget}`));
    expect(listDvms).toHaveBeenCalledWith("https://platform.example", "tok", { org });
    expect(destroyDvm).not.toHaveBeenCalled();
  });

});

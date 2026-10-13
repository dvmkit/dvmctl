import type * as SdkInternal from "@dvmkit/sdk/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/builder-store", async () => {
  const { DvmError } = await import("@dvmkit/sdk/internal");
  const getBuilderDvm = vi.fn();
  return {
    getBuilderDvm,
    patchBuilderDvm: vi.fn(),
    // The real store's typed refusals, over the same fixture knob the suites
    // already set: `getBuilderDvm` returning undefined means "no entry here".
    requireSelectedBuilderDvm: vi.fn((dvmId: string) => {
      const entry = getBuilderDvm(dvmId);
      if (!entry) {
        throw new DvmError(
          "dvm_not_initialized",
          `No builder.json entry for selected DVM ${dvmId}.`,
          "Run `dvmctl deploy` first so this DVM's canonical_dvm_id is recorded."
        );
      }
      return entry;
    }),
    requireBuilderDvmByHandle: vi.fn((handle: string) => {
      const entry = getBuilderDvm(handle);
      if (!entry) {
        throw new DvmError(
          "dvm_not_initialized",
          `No builder.json entry on this machine for "${handle}".`,
          "…every proof locked under the old one becomes underivable."
        );
      }
      return entry;
    }),
  };
});

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkInternal>()),
  validateLnAddress: vi.fn(),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({ dvmId: "dvm-fixture-1" })),
}));

import { DvmError } from "@dvmkit/sdk/internal";
import * as lnurl from "@dvmkit/sdk/internal";

import * as builderStore from "../../../shared/builder-store";
import * as output from "../../../shared/output";
import { resolveDvm } from "../resolve-dvm";
import { setPayout } from "../set-payout";

describe("dvmctl set-payout", () => {
  beforeEach(() => {
    vi.mocked(builderStore.getBuilderDvm).mockReset();
    vi.mocked(builderStore.patchBuilderDvm).mockReset();
    vi.mocked(lnurl.validateLnAddress).mockReset();
    vi.mocked(output.json).mockReset();
    vi.mocked(output.info).mockReset();
    vi.mocked(resolveDvm).mockReset();
    vi.mocked(resolveDvm).mockResolvedValue({ dvmId: "dvm-fixture-1" } as never);
  });

  it("rejects when no builder.json entry exists for the handle", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue(undefined);
    await expect(setPayout("my-dvm", "alice@example.com", {})).rejects.toThrow(DvmError);
    expect(builderStore.patchBuilderDvm).not.toHaveBeenCalled();
  });

  it("pre-flights the LN address and persists on success", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: "dvm-fixture-1",
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00Z",
    });
    vi.mocked(lnurl.validateLnAddress).mockResolvedValue(undefined);

    await setPayout("my-dvm", "alice@example.com", {});

    expect(lnurl.validateLnAddress).toHaveBeenCalledWith("alice@example.com");
    expect(builderStore.patchBuilderDvm).toHaveBeenCalledWith("dvm-fixture-1", {
      payout_ln_address: "alice@example.com",
    });
    expect(output.json).toHaveBeenCalledWith({
      status: "set",
      handle: "my-dvm",
      dvmId: "dvm-fixture-1",
      slug: "my-dvm",
      payout_ln_address: "alice@example.com",
    });
  });

  it("skips the LN pre-flight when --skip-preflight is set", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: "dvm-fixture-1",
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00Z",
    });
    await setPayout("my-dvm", "bob@example.com", { skipPreflight: true });
    expect(lnurl.validateLnAddress).not.toHaveBeenCalled();
    expect(builderStore.patchBuilderDvm).toHaveBeenCalled();
  });

  it("propagates the LNURL pre-flight error when validation fails", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: "dvm-fixture-1",
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00Z",
    });
    vi.mocked(lnurl.validateLnAddress).mockRejectedValue(
      new DvmError("lnurl_preflight_failed", "down")
    );
    await expect(setPayout("my-dvm", "alice@example.com", {})).rejects.toThrow(DvmError);
    expect(builderStore.patchBuilderDvm).not.toHaveBeenCalled();
  });

  it("emits human-readable output when --human is set", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: "dvm-fixture-1",
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00Z",
    });
    await setPayout("my-dvm", "alice@example.com", { human: true, skipPreflight: true });
    expect(output.json).not.toHaveBeenCalled();
    expect(output.info).toHaveBeenCalled();
  });

  it("keeps payout state separate for same-slug DVMs in two orgs", async () => {
    vi.mocked(resolveDvm).mockImplementation(async (_handle, opts) =>
      opts?.org === "acme"
        ? ({ dvmId: "dvm-acme-scrape" } as never)
        : ({ dvmId: "dvm-personal-scrape" } as never)
    );
    vi.mocked(builderStore.getBuilderDvm).mockImplementation((dvmId) => ({
      handle: "scrape",
      canonical_dvm_id: dvmId,
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00Z",
    }));

    await setPayout("scrape", "personal@example.com", { org: "personal", skipPreflight: true });
    await setPayout("scrape", "ops@acme.example", { org: "acme", skipPreflight: true });

    expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(1, "dvm-personal-scrape", {
      payout_ln_address: "personal@example.com",
    });
    expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(2, "dvm-acme-scrape", {
      payout_ln_address: "ops@acme.example",
    });
  });

  it("writes a self-hosted DVM's local state only when explicitly requested", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: "local-dvm-id",
      current_rotation_index: 0,
      self_hosted: true,
      updated_at: "2026-05-01T00:00:00Z",
    });

    await setPayout("my-dvm", "alice@example.com", { selfHosted: true, skipPreflight: true });

    expect(resolveDvm).not.toHaveBeenCalled();
    expect(builderStore.patchBuilderDvm).toHaveBeenCalledWith("local-dvm-id", {
      payout_ln_address: "alice@example.com",
    });
    expect(output.json).toHaveBeenCalledWith({
      status: "set",
      handle: "my-dvm",
      dvmId: "local-dvm-id",
      slug: "my-dvm",
      payout_ln_address: "alice@example.com",
    });
  });

  it("rejects an org selector for an explicitly self-hosted DVM", async () => {
    await expect(
      setPayout("my-dvm", "alice@example.com", {
        selfHosted: true,
        org: "acme",
        skipPreflight: true,
      })
    ).rejects.toMatchObject({ code: "invalid_scope" });

    expect(resolveDvm).not.toHaveBeenCalled();
    expect(builderStore.patchBuilderDvm).not.toHaveBeenCalled();
  });
});

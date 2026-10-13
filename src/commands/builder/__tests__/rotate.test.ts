import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as AdminCashuClientModule from "../../../lib/admin-cashu-client";

vi.mock("../../../lib/builder-mnemonic", () => ({
  readBuilderMnemonic: vi.fn(),
}));

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

vi.mock("../../../lib/platform", () => ({
  resolveAuth: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("../../../lib/platform-client", () => ({
  getDvm: vi.fn(),
  setDvmLockPubkey: vi.fn(),
  rotateDvmLockPubkey: vi.fn(),
}));

vi.mock("../../../lib/admin-cashu-client", async (importOriginal) => {
  const actual = await importOriginal<typeof AdminCashuClientModule>();
  const AdminCashuClient = vi.fn();
  AdminCashuClient.prototype.rotateLockPubkey = vi.fn();
  return { ...actual, AdminCashuClient };
});

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({
    dvmId: "11111111-1111-4111-8111-111111111111",
    token: "t",
    platformUrl: "https://api.example.com",
  })),
}));

import { deriveBuilderLockKeypair, DvmError } from "@dvmkit/sdk/internal";

import { AdminApiError, AdminCashuClient } from "../../../lib/admin-cashu-client";
import * as builderMnemonic from "../../../lib/builder-mnemonic";
import * as platform from "../../../lib/platform";
import * as platformClient from "../../../lib/platform-client";
import * as builderStore from "../../../shared/builder-store";
import * as output from "../../../shared/output";
import { rotate } from "../rotate";

// Use a real BIP-39 mnemonic so derivations work end-to-end inside the test.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CANONICAL_DVM_ID = "11111111-1111-4111-8111-111111111111";

function getRotateMock(): ReturnType<typeof vi.fn> {
  const proto = AdminCashuClient.prototype as unknown as {
    rotateLockPubkey: ReturnType<typeof vi.fn>;
  };
  return proto.rotateLockPubkey;
}

describe("dvmctl rotate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue(MNEMONIC);
  });

  it("derives the next-index keypair, calls rotateLockPubkey on the DVM, bumps builder.json", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: CANONICAL_DVM_ID,
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    vi.mocked(platform.resolveAuth).mockReturnValue({
      token: "t",
      account: "api-key",
    });
    vi.mocked(platform.requireAuth).mockReturnValue({
      token: "t",
      platformUrl: "https://api.example.com",
    });
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm: { url: "https://my-dvm.example.com" } as never,
    } as never);
    const nextPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 1).pubkey;
    const rotateMock = getRotateMock();
    rotateMock.mockResolvedValue({
      current: nextPubkey,
      retired: [
        {
          pubkey: deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 0).pubkey,
          retired_at_ms: 1_700_000_000_000,
        },
      ],
    });

    await rotate("my-dvm", { human: false });

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(rotateMock.mock.calls[0][0]).toEqual({ new_pubkey: nextPubkey });
    expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(1, CANONICAL_DVM_ID, {
      current_rotation_index: 1,
      pending_platform_lock_sync: true,
    });
    expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(2, CANONICAL_DVM_ID, {
      pending_platform_lock_sync: undefined,
    });
    expect(platformClient.setDvmLockPubkey).toHaveBeenCalledWith(
      "https://api.example.com",
      "t",
      CANONICAL_DVM_ID,
      nextPubkey
    );
    expect(output.json).toHaveBeenCalledTimes(1);
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
      status: "rotated",
      dvmId: CANONICAL_DVM_ID,
      slug: "my-dvm",
      previous_rotation_index: 0,
      current_rotation_index: 1,
      current_pubkey: nextPubkey,
    });
  });

  it("throws when no mnemonic is on disk", async () => {
    vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue(null);
    await expect(rotate("my-dvm", {})).rejects.toThrow(DvmError);
  });

  it("throws when there's no builder.json entry for the handle", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue(undefined);
    await expect(rotate("my-dvm", {})).rejects.toThrow(/No builder.json entry/);
  });

  it("requires --endpoint for self-hosted DVMs", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: CANONICAL_DVM_ID,
      current_rotation_index: 0,
      self_hosted: true,
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    await expect(rotate("my-dvm", {})).rejects.toThrow(/Self-hosted DVM/);
  });

  it("skips platform sync for self-hosted DVMs (only calls the DVM admin endpoint)", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: CANONICAL_DVM_ID,
      current_rotation_index: 0,
      self_hosted: true,
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    const nextPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 1).pubkey;
    const rotateMock = getRotateMock();
    rotateMock.mockResolvedValue({ current: nextPubkey, retired: [] });

    await rotate("my-dvm", { endpoint: "https://self.example.com" });

    expect(rotateMock).toHaveBeenCalledTimes(1);
    expect(platformClient.setDvmLockPubkey).not.toHaveBeenCalled();
    expect(builderStore.patchBuilderDvm).toHaveBeenCalledWith(CANONICAL_DVM_ID, {
      current_rotation_index: 1,
    });
  });

  it("refuses to leave a platform DVM's lock pubkey unsynced", async () => {
    // Reachable only since --endpoint stopped implying self-hosted: rotating a
    // platform DVM from a machine with no platform auth. Warning-and-exit-0
    // here leaves the platform holding the pre-rotation pubkey, which the next
    // `dvmctl deploy` re-injects — and every melt afterwards then fails
    // admin_bad_signature.
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: CANONICAL_DVM_ID,
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    const nextPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 1).pubkey;
    getRotateMock().mockResolvedValue({ current: nextPubkey, retired: [] });
    vi.mocked(platform.requireAuth).mockImplementation(() => {
      throw new Error("no platform auth on this machine");
    });

    await expect(rotate("my-dvm", { endpoint: "https://cast.dvmkit.ai" })).rejects.toMatchObject({
      code: "platform_lock_sync_failed",
      hint: expect.stringContaining("--sync-platform"),
      data: { current_rotation_index: 1, platform_sync_pending: true },
    });
    expect(builderStore.patchBuilderDvm).toHaveBeenCalledWith(CANONICAL_DVM_ID, {
      current_rotation_index: 1,
      pending_platform_lock_sync: true,
    });
  });

  it("does not bump builder.json when the DVM admin call fails", async () => {
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: CANONICAL_DVM_ID,
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    vi.mocked(platform.resolveAuth).mockReturnValue({ token: "t", account: "api-key" });
    vi.mocked(platform.requireAuth).mockReturnValue({ token: "t", platformUrl: "u" });
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm: { url: "https://my-dvm.example.com" } as never,
    } as never);
    const rotateMock = getRotateMock();
    rotateMock.mockRejectedValue(new Error("network"));

    await expect(rotate("my-dvm", {})).rejects.toThrow();
    expect(builderStore.patchBuilderDvm).not.toHaveBeenCalled();
  });

  it("treats a 409 from the DVM as a resync: bumps builder.json, re-runs platform sync, succeeds", async () => {
    // A prior `dvmctl rotate` reached the DVM but didn't finish bumping
    // builder.json (crash/network blip). The DVM is at next-index pubkey;
    // builder.json is one behind. Re-running must heal the divergence, not
    // wedge the operator into the same 409 forever.
    vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: CANONICAL_DVM_ID,
      current_rotation_index: 0,
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    vi.mocked(platform.resolveAuth).mockReturnValue({ token: "t", account: "api-key" });
    vi.mocked(platform.requireAuth).mockReturnValue({
      token: "t",
      platformUrl: "https://api.example.com",
    });
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm: { url: "https://my-dvm.example.com" } as never,
    } as never);
    const rotateMock = getRotateMock();
    rotateMock.mockRejectedValue(
      new AdminApiError(409, { error: "no_op_rotation", message: "no-op", raw: {} })
    );
    const nextPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 1).pubkey;

    await rotate("my-dvm", { human: false });

    expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(1, CANONICAL_DVM_ID, {
      current_rotation_index: 1,
      pending_platform_lock_sync: true,
    });
    expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(2, CANONICAL_DVM_ID, {
      pending_platform_lock_sync: undefined,
    });
    expect(platformClient.setDvmLockPubkey).toHaveBeenCalledWith(
      "https://api.example.com",
      "t",
      CANONICAL_DVM_ID,
      nextPubkey
    );
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
      status: "resynced",
      previous_rotation_index: 0,
      current_rotation_index: 1,
      current_pubkey: nextPubkey,
    });
  });

  // Isolate-tier DVMs have no SDK admin route — the CLI routes to
  // the platform-side rotation endpoint instead. The container/SDK path
  // above is unchanged.
  describe("isolate-tier DVMs", () => {
    it("calls platformClient.rotateDvmLockPubkey, bumps builder.json, skips setDvmLockPubkey", async () => {
      vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
        handle: "iso",
        canonical_dvm_id: CANONICAL_DVM_ID,
        current_rotation_index: 0,
        updated_at: "2026-05-01T00:00:00.000Z",
      });
      vi.mocked(platform.resolveAuth).mockReturnValue({ token: "t", account: "api-key" });
      vi.mocked(platform.requireAuth).mockReturnValue({
        token: "t",
        platformUrl: "https://api.example.com",
      });
      vi.mocked(platformClient.getDvm).mockResolvedValue({
        dvm: { url: "https://iso.example.com", runtime: "isolate" } as never,
      } as never);
      const nextPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 1).pubkey;
      const priorPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 0).pubkey;
      vi.mocked(platformClient.rotateDvmLockPubkey).mockResolvedValue({
        current: nextPubkey,
        retired: [{ pubkey: priorPubkey, retired_at_ms: 1_700_000_000_000 }],
      });

      await rotate("iso", { human: false });

      expect(platformClient.rotateDvmLockPubkey).toHaveBeenCalledWith(
        "https://api.example.com",
        "t",
        CANONICAL_DVM_ID,
        nextPubkey
      );
      // SDK admin client must not be touched for isolate DVMs.
      expect(getRotateMock()).not.toHaveBeenCalled();
      // The platform endpoint already attempted bookkeeping sync on success.
      expect(platformClient.setDvmLockPubkey).not.toHaveBeenCalled();
      expect(builderStore.patchBuilderDvm).toHaveBeenCalledWith(CANONICAL_DVM_ID, {
        current_rotation_index: 1,
      });
      expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
        status: "rotated",
        previous_rotation_index: 0,
        current_rotation_index: 1,
        current_pubkey: nextPubkey,
      });
    });

    it("treats no_op_rotation from the platform as a resync", async () => {
      vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
        handle: "iso",
        canonical_dvm_id: CANONICAL_DVM_ID,
        current_rotation_index: 0,
        updated_at: "2026-05-01T00:00:00.000Z",
      });
      vi.mocked(platform.resolveAuth).mockReturnValue({ token: "t", account: "api-key" });
      vi.mocked(platform.requireAuth).mockReturnValue({
        token: "t",
        platformUrl: "https://api.example.com",
      });
      vi.mocked(platformClient.getDvm).mockResolvedValue({
        dvm: { url: "https://iso.example.com", runtime: "isolate" } as never,
      } as never);
      vi.mocked(platformClient.rotateDvmLockPubkey).mockRejectedValue(
        new DvmError("no_op_rotation", "new_pubkey already matches the current lock pubkey.")
      );
      const nextPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 1).pubkey;

      await rotate("iso", { human: false });

      expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(1, CANONICAL_DVM_ID, {
        current_rotation_index: 1,
        pending_platform_lock_sync: true,
      });
      expect(platformClient.setDvmLockPubkey).toHaveBeenCalledWith(
        "https://api.example.com",
        "t",
        CANONICAL_DVM_ID,
        nextPubkey
      );
      expect(builderStore.patchBuilderDvm).toHaveBeenNthCalledWith(2, CANONICAL_DVM_ID, {
        pending_platform_lock_sync: undefined,
      });
      expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
        status: "resynced",
        previous_rotation_index: 0,
        current_rotation_index: 1,
        current_pubkey: nextPubkey,
      });
    });

    it("records the accepted index and requires recovery when isolate platform sync warns", async () => {
      // The platform endpoint's `setDvmLockPubkey` follow-up is best-effort:
      // when it fails the accumulator state is still correct, and the
      // response carries the failure message in `lock_pubkey_sync_warning`.
      // The CLI must surface this so the operator can retry the bookkeeping
      // sync without re-rotating.
      vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
        handle: "iso",
        canonical_dvm_id: CANONICAL_DVM_ID,
        current_rotation_index: 0,
        updated_at: "2026-05-01T00:00:00.000Z",
      });
      vi.mocked(platform.resolveAuth).mockReturnValue({ token: "t", account: "api-key" });
      vi.mocked(platform.requireAuth).mockReturnValue({
        token: "t",
        platformUrl: "https://api.example.com",
      });
      vi.mocked(platformClient.getDvm).mockResolvedValue({
        dvm: { url: "https://iso.example.com", runtime: "isolate" } as never,
      } as never);
      const nextPubkey = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_DVM_ID, 1).pubkey;
      vi.mocked(platformClient.rotateDvmLockPubkey).mockResolvedValue({
        current: nextPubkey,
        retired: [],
        lock_pubkey_sync_warning: "dvms_lock_pubkey_write_failed",
      });

      await expect(rotate("iso", { human: false })).rejects.toMatchObject({
        code: "platform_lock_sync_failed",
        hint: expect.stringContaining("--sync-platform"),
        data: { current_rotation_index: 1, platform_sync_pending: true },
      });

      expect(builderStore.patchBuilderDvm).toHaveBeenCalledWith(CANONICAL_DVM_ID, {
        current_rotation_index: 1,
        pending_platform_lock_sync: true,
      });
      expect(output.json).not.toHaveBeenCalled();
    });

    it("does not bump builder.json when the platform call fails", async () => {
      vi.mocked(builderStore.getBuilderDvm).mockReturnValue({
        handle: "iso",
        canonical_dvm_id: CANONICAL_DVM_ID,
        current_rotation_index: 0,
        updated_at: "2026-05-01T00:00:00.000Z",
      });
      vi.mocked(platform.resolveAuth).mockReturnValue({ token: "t", account: "api-key" });
      vi.mocked(platform.requireAuth).mockReturnValue({
        token: "t",
        platformUrl: "https://api.example.com",
      });
      vi.mocked(platformClient.getDvm).mockResolvedValue({
        dvm: { url: "https://iso.example.com", runtime: "isolate" } as never,
      } as never);
      vi.mocked(platformClient.rotateDvmLockPubkey).mockRejectedValue(
        new DvmError("platform_error", "boom")
      );

      await expect(rotate("iso", {})).rejects.toThrow();
      expect(builderStore.patchBuilderDvm).not.toHaveBeenCalled();
    });
  });
});

import { rmSync } from "node:fs";

import {
  buildAdminChallenge,
  deriveBuilderLockKeypair,
  verifyChallenge,
} from "@dvmkit/sdk/internal";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/defaults", async (importOriginal) => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const actual = await importOriginal<typeof import("../../../shared/defaults")>();
  const dir = mkdtempSync(join(tmpdir(), "dvmctl-rotate-recovery-"));
  return { ...actual, BUILDER_CONFIG_DIR: dir, BUILDER_FILE: join(dir, "builder.json") };
});

vi.mock("../../../lib/builder-mnemonic", () => ({ readBuilderMnemonic: vi.fn() }));
vi.mock("../../../lib/platform", () => ({ requireAuth: vi.fn(), resolveAuth: vi.fn() }));
vi.mock("../../../lib/platform-client", () => ({
  getDvm: vi.fn(),
  setDvmLockPubkey: vi.fn(),
  rotateDvmLockPubkey: vi.fn(),
}));
vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn() }));
vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({
    dvmId: "22222222-2222-4222-8222-222222222222",
    token: "token",
    platformUrl: "https://platform.example",
  })),
}));

import * as builderMnemonic from "../../../lib/builder-mnemonic";
import * as platform from "../../../lib/platform";
import * as platformClient from "../../../lib/platform-client";
import { BUILDER_CONFIG_DIR } from "../../../shared/defaults";
import * as output from "../../../shared/output";
import { getBuilderDvm, upsertBuilderDvm } from "../../../shared/builder-store";
import { rotate } from "../rotate";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DVM_ID = "22222222-2222-4222-8222-222222222222";
const HANDLE = "recovery-fixture";
const ENDPOINT = "https://dvm.example";

function key(index: number) {
  return deriveBuilderLockKeypair(MNEMONIC, DVM_ID, index);
}

describe("rotate platform-sync recovery", () => {
  let dvmPubkey: string;
  let platformPubkey: string;
  let adminRequests: number;

  beforeEach(() => {
    vi.mocked(builderMnemonic.readBuilderMnemonic).mockReturnValue(MNEMONIC);
    upsertBuilderDvm(DVM_ID, {
      handle: HANDLE,
      canonical_dvm_id: DVM_ID,
      current_rotation_index: 0,
    });
    dvmPubkey = key(0).pubkey;
    platformPubkey = dvmPubkey;
    adminRequests = 0;
    vi.mocked(platform.requireAuth).mockReturnValue({
      token: "token",
      platformUrl: "https://platform.example",
    });
    vi.mocked(platform.resolveAuth).mockReturnValue({ token: "token", account: "api-key" });
    vi.mocked(platformClient.setDvmLockPubkey).mockImplementation(async (_url, _token, _id, pubkey) => {
      platformPubkey = pubkey;
    });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      adminRequests++;
      const auth = (init.headers as Record<string, string>).Authorization;
      const [nonceHex, unixSeconds, signature] = auth.slice(5).split(".");
      const challenge = buildAdminChallenge({
        method: "POST",
        path: "/admin/cashu/rotate-lock-pubkey",
        dvmId: DVM_ID,
        nonceHex,
        unixSeconds,
      });
      if (!verifyChallenge(dvmPubkey, challenge, signature)) {
        return new Response(JSON.stringify({ error: "unauthorized", reason: "bad_signature" }), {
          status: 401,
        });
      }
      const { new_pubkey: nextPubkey } = JSON.parse(init.body as string) as {
        new_pubkey: string;
      };
      if (nextPubkey === dvmPubkey) {
        return new Response(JSON.stringify({ error: "no_op_rotation" }), { status: 409 });
      }
      const retired = [{ pubkey: dvmPubkey, retired_at_ms: 1_700_000_000_000 }];
      dvmPubkey = nextPubkey;
      return new Response(JSON.stringify({ current: dvmPubkey, retired }), { status: 200 });
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    rmSync(BUILDER_CONFIG_DIR, { recursive: true, force: true });
  });

  it.each(["missing authentication", "platform write failure"])(
    "persists accepted rotation and reconciles without another admin call after %s",
    async (failure) => {
      if (failure === "missing authentication") {
        vi.mocked(platform.requireAuth).mockImplementationOnce(() => {
          throw new Error("no platform auth");
        });
      } else {
        vi.mocked(platformClient.setDvmLockPubkey).mockRejectedValueOnce(new Error("write failed"));
      }

      await expect(rotate(HANDLE, { endpoint: ENDPOINT })).rejects.toMatchObject({
        code: "platform_lock_sync_failed",
        data: {
          current_rotation_index: 1,
          current_pubkey: key(1).pubkey,
          platform_sync_pending: true,
        },
      });
      expect(getBuilderDvm(DVM_ID)).toMatchObject({
        current_rotation_index: 1,
        pending_platform_lock_sync: true,
      });
      expect(dvmPubkey).toBe(key(1).pubkey);
      expect(platformPubkey).toBe(key(0).pubkey);
      expect(adminRequests).toBe(1);

      await expect(rotate(HANDLE, { endpoint: ENDPOINT })).rejects.toMatchObject({
        code: "platform_lock_sync_pending",
      });
      expect(adminRequests).toBe(1);

      vi.mocked(platformClient.setDvmLockPubkey).mockRejectedValueOnce(new Error("still unavailable"));
      await expect(rotate(HANDLE, { syncPlatform: true })).rejects.toMatchObject({
        code: "platform_lock_sync_failed",
      });
      expect(getBuilderDvm(DVM_ID)?.pending_platform_lock_sync).toBe(true);
      expect(adminRequests).toBe(1);

      await rotate(HANDLE, { syncPlatform: true });
      expect(platformPubkey).toBe(key(1).pubkey);
      expect(getBuilderDvm(DVM_ID)?.current_rotation_index).toBe(1);
      expect(getBuilderDvm(DVM_ID)?.pending_platform_lock_sync).toBeUndefined();
      expect(adminRequests).toBe(1);
      expect(vi.mocked(output.json).mock.lastCall?.[0]).toMatchObject({
        status: "platform_resynced",
        current_rotation_index: 1,
        current_pubkey: key(1).pubkey,
      });

      await rotate(HANDLE, { endpoint: ENDPOINT });
      expect(adminRequests).toBe(2);
      expect(dvmPubkey).toBe(key(2).pubkey);
      expect(getBuilderDvm(DVM_ID)?.current_rotation_index).toBe(2);
    }
  );

  it("rejects a stale signer before the SDK's no-op check", async () => {
    dvmPubkey = key(1).pubkey;

    await expect(rotate(HANDLE, { endpoint: ENDPOINT })).rejects.toMatchObject({
      code: "admin_bad_signature",
    });

    expect(adminRequests).toBe(1);
    expect(getBuilderDvm(DVM_ID)?.current_rotation_index).toBe(0);
    expect(platformClient.setDvmLockPubkey).not.toHaveBeenCalled();
  });

  it("reconciles an isolate bookkeeping warning without a second rotation", async () => {
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm: { runtime: "isolate" } as never,
    } as never);
    vi.mocked(platformClient.rotateDvmLockPubkey).mockImplementationOnce(async () => {
      dvmPubkey = key(1).pubkey;
      return { current: dvmPubkey, retired: [], lock_pubkey_sync_warning: "write failed" };
    });

    await expect(rotate(HANDLE, {})).rejects.toMatchObject({
      code: "platform_lock_sync_failed",
      data: { current_rotation_index: 1, platform_sync_pending: true },
    });
    expect(getBuilderDvm(DVM_ID)?.pending_platform_lock_sync).toBe(true);

    await rotate(HANDLE, { syncPlatform: true });
    expect(platformPubkey).toBe(key(1).pubkey);
    expect(getBuilderDvm(DVM_ID)?.pending_platform_lock_sync).toBeUndefined();
    expect(platformClient.rotateDvmLockPubkey).toHaveBeenCalledTimes(1);
    expect(adminRequests).toBe(0);
  });

  it("refuses sync-only mode when no platform update is pending", async () => {
    await expect(rotate(HANDLE, { syncPlatform: true })).rejects.toMatchObject({
      code: "no_pending_platform_lock_sync",
    });
    expect(platformClient.setDvmLockPubkey).not.toHaveBeenCalled();
    expect(adminRequests).toBe(0);
  });
});

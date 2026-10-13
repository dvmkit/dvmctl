import { describe, expect, it, vi } from "vitest";

import { mintAndDepositCliAuth } from "../cli-auth";

// ── mintAndDepositCliAuth ─────────────────────────────────────────────

describe("mintAndDepositCliAuth", () => {
  function makePlatform(
    overrides: {
      depositRejects?: Error;
      deleteRejects?: Error;
    } = {}
  ) {
    return {
      createBuilderApiKey: vi.fn(async () => ({ id: "key_fakeid", key: "dvmk_fake_raw" })),
      depositCliAuth: vi.fn(async () => {
        if (overrides.depositRejects) throw overrides.depositRejects;
      }),
      deleteBuilderApiKey: vi.fn(async () => {
        if (overrides.deleteRejects) throw overrides.deleteRejects;
      }),
    };
  }

  it("mints then deposits on the happy path", async () => {
    const platform = makePlatform();

    await mintAndDepositCliAuth({
      platform,
      label: "dvmctl on my-laptop",
      session: "a".repeat(32),
      verifierHash: "b".repeat(64),
      account: "alice@example.com",
    });

    expect(platform.createBuilderApiKey).toHaveBeenCalledWith("dvmctl on my-laptop");
    expect(platform.depositCliAuth).toHaveBeenCalledWith({
      session: "a".repeat(32),
      verifierHash: "b".repeat(64),
      apiKey: "dvmk_fake_raw",
      account: "alice@example.com",
    });
    expect(platform.deleteBuilderApiKey).not.toHaveBeenCalled();
  });

  it("revokes the minted key when deposit fails", async () => {
    const platform = makePlatform({ depositRejects: new Error("platform unreachable") });

    await expect(
      mintAndDepositCliAuth({
        platform,
        label: "dvmctl on my-laptop",
        session: "a".repeat(32),
        verifierHash: "b".repeat(64),
        account: "alice@example.com",
      })
    ).rejects.toThrow("platform unreachable");

    expect(platform.createBuilderApiKey).toHaveBeenCalledOnce();
    expect(platform.depositCliAuth).toHaveBeenCalledOnce();
    expect(platform.deleteBuilderApiKey).toHaveBeenCalledWith("key_fakeid");
  });

  it("swallows deleteBuilderApiKey failures during rollback so the original error still surfaces", async () => {
    const platform = makePlatform({
      depositRejects: new Error("platform conflict"),
      deleteRejects: new Error("revoke failed"),
    });

    await expect(
      mintAndDepositCliAuth({
        platform,
        label: "dvmctl on my-laptop",
        session: "a".repeat(32),
        verifierHash: "b".repeat(64),
        account: "alice@example.com",
      })
    ).rejects.toThrow("platform conflict"); // original, not "revoke failed"

    expect(platform.deleteBuilderApiKey).toHaveBeenCalledWith("key_fakeid");
  });

  it("propagates createBuilderApiKey failures without calling deposit or delete", async () => {
    const platform = {
      createBuilderApiKey: vi.fn(async () => {
        throw new Error("mint failed");
      }),
      depositCliAuth: vi.fn(),
      deleteBuilderApiKey: vi.fn(),
    };

    await expect(
      mintAndDepositCliAuth({
        platform,
        label: "dvmctl on my-laptop",
        session: "a".repeat(32),
        verifierHash: "b".repeat(64),
        account: "alice@example.com",
      })
    ).rejects.toThrow("mint failed");

    expect(platform.depositCliAuth).not.toHaveBeenCalled();
    expect(platform.deleteBuilderApiKey).not.toHaveBeenCalled();
  });
});

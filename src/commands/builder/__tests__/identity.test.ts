import type * as SdkInternal from "@dvmkit/sdk/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkInternal>()),
  generateIdentity: vi.fn(),
  writeIdentity: vi.fn(),
}));

vi.mock("../../../shared/builder-store", () => ({
  loadIdentityPubkey: vi.fn(),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("../../../lib/platform-client", () => ({
  getAuthenticatedBuilderProfile: vi.fn(),
}));

import * as builderIdentity from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";

import * as platform from "../../../lib/platform";
import * as platformClient from "../../../lib/platform-client";
import * as builderStore from "../../../shared/builder-store";
import * as output from "../../../shared/output";
import { identityCreate, identityShow } from "../identity";

const PROFILE = { id: "b1", email: null, handle: null, displayName: null };

describe("dvmctl identity create", () => {
  beforeEach(() => {
    vi.mocked(platform.requireAuth).mockReturnValue({ token: "tok", platformUrl: "https://platform.example" });
    vi.mocked(platformClient.getAuthenticatedBuilderProfile).mockResolvedValue(PROFILE);
    vi.mocked(builderIdentity.writeIdentity).mockReset();
    vi.mocked(builderIdentity.generateIdentity).mockReset();
  });

  it("generates a keypair and persists it via writeIdentity", async () => {
    vi.mocked(builderIdentity.generateIdentity).mockReturnValue({
      pubkey: "a".repeat(64),
      secret: "b".repeat(64),
    });
    const write = vi.mocked(builderIdentity.writeIdentity);
    write.mockClear();

    vi.mocked(output.json).mockClear();
    await identityCreate({});

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({
      pubkey: "a".repeat(64),
      secret: "b".repeat(64),
    });
    expect(write.mock.calls[0][1]).toEqual({ force: undefined });
    expect(output.json).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "created", identity_pubkey: "a".repeat(64) })
    );
  });

  it("forwards --force to writeIdentity", async () => {
    vi.mocked(builderIdentity.generateIdentity).mockReturnValue({
      pubkey: "a".repeat(64),
      secret: "b".repeat(64),
    });
    const write = vi.mocked(builderIdentity.writeIdentity);
    write.mockClear();

    await identityCreate({ force: true });

    expect(write.mock.calls[0][1]).toEqual({ force: true });
  });

  it("re-throws writeIdentity's `identity_exists` without overwriting", async () => {
    vi.mocked(builderIdentity.generateIdentity).mockReturnValue({
      pubkey: "a".repeat(64),
      secret: "b".repeat(64),
    });
    vi.mocked(builderIdentity.writeIdentity).mockImplementation(() => {
      throw new DvmError(
        "identity_exists",
        "A builder identity already exists.",
        "Pass --force to overwrite."
      );
    });

    await expect(identityCreate({})).rejects.toThrow(/already exists/);
  });

  describe("account binding preflight", () => {
    const BOUND = "ab12cd34" + "0".repeat(56);

    function bindAccount(identity_pubkey: string | null | undefined): void {
      vi.mocked(platformClient.getAuthenticatedBuilderProfile).mockResolvedValue({
        ...PROFILE,
        ...(identity_pubkey === undefined ? {} : { identity_pubkey }),
      });
    }

    async function createRefusedBeforeAnyWrite(opts: Parameters<typeof identityCreate>[0]): Promise<void> {
      await expect(identityCreate(opts)).rejects.toMatchObject({
        code: "identity_bound_elsewhere",
        message: expect.stringContaining("ab12cd34"),
        hint: expect.stringContaining("dvmctl identity import"),
      });
      expect(builderIdentity.generateIdentity).not.toHaveBeenCalled();
      expect(builderIdentity.writeIdentity).not.toHaveBeenCalled();
    }

    it("refuses before generating or writing a key when the account is bound", async () => {
      bindAccount(BOUND);
      await createRefusedBeforeAnyWrite({});
    });

    it("still refuses with --force, since a fresh key can never match the bound one", async () => {
      bindAccount(BOUND);
      await createRefusedBeforeAnyWrite({ force: true });
    });

    it("does not reveal more of the bound pubkey than its prefix", async () => {
      bindAccount(BOUND);
      const error = await identityCreate({}).catch((e: unknown) => e as DvmError);
      expect(`${(error as DvmError).message} ${(error as DvmError).hint}`).not.toContain(BOUND);
    });

    it.each([
      ["unbound", null],
      ["absent on an older platform", undefined],
    ])("creates the key when the account is %s", async (_label, bound) => {
      bindAccount(bound);
      vi.mocked(builderIdentity.generateIdentity).mockReturnValue({ pubkey: "a".repeat(64), secret: "b".repeat(64) });

      await identityCreate({});

      expect(builderIdentity.writeIdentity).toHaveBeenCalledTimes(1);
    });

    it("skips the check when logged out", async () => {
      vi.mocked(platform.requireAuth).mockImplementation(() => {
        throw new DvmError("auth_required", "Not authenticated.");
      });
      vi.mocked(builderIdentity.generateIdentity).mockReturnValue({ pubkey: "a".repeat(64), secret: "b".repeat(64) });

      await identityCreate({});

      expect(platformClient.getAuthenticatedBuilderProfile).not.toHaveBeenCalled();
      expect(builderIdentity.writeIdentity).toHaveBeenCalledTimes(1);
    });

    it("skips the check when the platform cannot be reached", async () => {
      vi.mocked(platformClient.getAuthenticatedBuilderProfile).mockRejectedValue(new Error("offline"));
      vi.mocked(builderIdentity.generateIdentity).mockReturnValue({ pubkey: "a".repeat(64), secret: "b".repeat(64) });

      await identityCreate({});

      expect(builderIdentity.writeIdentity).toHaveBeenCalledTimes(1);
    });

    it("skips the check for deploy targets that never contact the platform", async () => {
      bindAccount(BOUND);
      vi.mocked(builderIdentity.generateIdentity).mockReturnValue({ pubkey: "a".repeat(64), secret: "b".repeat(64) });

      await identityCreate({ quiet: true, skipBindingCheck: true });

      expect(platformClient.getAuthenticatedBuilderProfile).not.toHaveBeenCalled();
      expect(builderIdentity.writeIdentity).toHaveBeenCalledTimes(1);
    });
  });
});

describe("dvmctl identity show", () => {
  it("prints the pubkey from disk", () => {
    vi.mocked(builderStore.loadIdentityPubkey).mockReturnValue("c".repeat(64));
    const jsonSpy = vi.mocked(output.json);
    jsonSpy.mockClear();

    identityShow({});

    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(jsonSpy.mock.calls[0][0]).toMatchObject({
      identity_pubkey: "c".repeat(64),
    });
  });

  it("throws `identity_missing` when no identity is on disk", () => {
    vi.mocked(builderStore.loadIdentityPubkey).mockReturnValue(null);
    expect(() => {
      identityShow({});
    }).toThrow(/No builder identity exists/);
  });
});

import type * as SdkInternal from "@dvmkit/sdk/internal";
import { describe, expect, it, vi } from "vitest";

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

import * as builderIdentity from "@dvmkit/sdk/internal";
import { DvmError } from "@dvmkit/sdk/internal";

import * as builderStore from "../../../shared/builder-store";
import * as output from "../../../shared/output";
import { identityCreate, identityShow } from "../identity";

describe("dvmctl identity create", () => {
  it("generates a keypair and persists it via writeIdentity", () => {
    vi.mocked(builderIdentity.generateIdentity).mockReturnValue({
      pubkey: "a".repeat(64),
      secret: "b".repeat(64),
    });
    const write = vi.mocked(builderIdentity.writeIdentity);
    write.mockClear();

    vi.mocked(output.json).mockClear();
    identityCreate({});

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

  it("forwards --force to writeIdentity", () => {
    vi.mocked(builderIdentity.generateIdentity).mockReturnValue({
      pubkey: "a".repeat(64),
      secret: "b".repeat(64),
    });
    const write = vi.mocked(builderIdentity.writeIdentity);
    write.mockClear();

    identityCreate({ force: true });

    expect(write.mock.calls[0][1]).toEqual({ force: true });
  });

  it("re-throws writeIdentity's `identity_exists` without overwriting", () => {
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

    expect(() => {
      identityCreate({});
    }).toThrow(/already exists/);
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

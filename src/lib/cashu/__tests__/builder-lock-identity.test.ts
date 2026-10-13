/** Expectations cover wrapper argument wiring to SDK derivation; disk and endpoint responses are fixtures. */
import { deriveBuilderLockKeypair, DvmError, toLockPubkey } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuilderDvmEntry } from "../../../shared/builder-store";
import {
  resolveBuilderLockIdentity,
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../builder-lock-identity";

vi.mock("../../builder-mnemonic", () => ({
  readBuilderMnemonic: vi.fn(),
}));
vi.mock("../../../shared/builder-store", () => ({
  findBuilderDvmsByHandle: vi.fn(),
  requireSelectedBuilderDvm: vi.fn(),
  requireBuilderDvmByHandle: vi.fn(),
}));

const { readBuilderMnemonic } = await import("../../builder-mnemonic");
const { findBuilderDvmsByHandle, requireSelectedBuilderDvm, requireBuilderDvmByHandle } =
  await import("../../../shared/builder-store");

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const CANONICAL_ID = "11111111-2222-3333-4444-555555555555";

function entry(rotationIndex: number): BuilderDvmEntry {
  return {
    handle: "my-dvm",
    canonical_dvm_id: CANONICAL_ID,
    current_rotation_index: rotationIndex,
    self_hosted: true,
    updated_at: "2026-07-30T00:00:00.000Z",
  };
}

function candidate(canonicalDvmId: string, rotationIndex: number): BuilderDvmEntry {
  return {
    ...entry(rotationIndex),
    canonical_dvm_id: canonicalDvmId,
  };
}

function advertise(pubkey: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        cashu: {
          mints: ["https://mint.example"],
          lock_pubkeys: [pubkey],
          min_locktime: 604800,
          canonical_id: null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveBuilderLockIdentity", () => {
  beforeEach(() => {
    vi.mocked(readBuilderMnemonic).mockReturnValue(MNEMONIC);
    vi.mocked(requireSelectedBuilderDvm).mockReturnValue(entry(0));
    vi.mocked(requireBuilderDvmByHandle).mockReturnValue(entry(0));
  });

  it("derives the pubkey deploy would have published for the same handle", () => {
    const identity = resolveBuilderLockIdentity("my-dvm");
    expect(identity).toEqual({
      handle: "my-dvm",
      canonicalDvmId: CANONICAL_ID,
      rotationIndex: 0,
      lockPubkey: deriveBuilderLockKeypair(MNEMONIC, CANONICAL_ID, 0).pubkey,
    });
    expect(requireBuilderDvmByHandle).toHaveBeenLastCalledWith("my-dvm");
  });

  it("follows the current rotation index, not index 0", () => {
    vi.mocked(requireBuilderDvmByHandle).mockReturnValue(entry(3));
    expect(resolveBuilderLockIdentity("my-dvm").lockPubkey).toBe(
      deriveBuilderLockKeypair(MNEMONIC, CANONICAL_ID, 3).pubkey
    );
  });

  it("names `dvmctl lock create` when no mnemonic exists", () => {
    vi.mocked(readBuilderMnemonic).mockReturnValue(null);
    expect(() => resolveBuilderLockIdentity("my-dvm")).toThrow(
      expect.objectContaining({
        code: "no_builder_mnemonic",
        hint: expect.stringMatching(/lock create/),
      })
    );
  });

  it("surfaces the store's refusal when the handle is unknown", () => {
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => {
      throw new DvmError("dvm_not_initialized", "no entry", "…becomes underivable.");
    });
    expect(() => resolveBuilderLockIdentity("my-dvm")).toThrow(
      expect.objectContaining({ code: "dvm_not_initialized" })
    );
  });
});

describe("resolveBuilderLockKeyring", () => {
  beforeEach(() => {
    vi.mocked(readBuilderMnemonic).mockReturnValue(MNEMONIC);
    vi.mocked(requireSelectedBuilderDvm).mockReturnValue(entry(2));
    vi.mocked(requireBuilderDvmByHandle).mockReturnValue(entry(2));
  });

  it("walks every rotation index so grace-window proofs stay spendable", () => {
    const keyring = resolveBuilderLockKeyring(CANONICAL_ID);
    expect(requireSelectedBuilderDvm).toHaveBeenLastCalledWith(CANONICAL_ID);
    expect(keyring.currentKeypair).toEqual(deriveBuilderLockKeypair(MNEMONIC, CANONICAL_ID, 2));
    expect(keyring.keypairsByPubkey.size).toBe(3);
    for (const i of [0, 1, 2]) {
      const kp = deriveBuilderLockKeypair(MNEMONIC, CANONICAL_ID, i);
      expect(keyring.keypairsByPubkey.get(toLockPubkey(kp.pubkey))).toEqual(kp);
    }
  });

});

describe("resolveBuilderLockKeyringByHandle endpoint disambiguation", () => {
  beforeEach(() => {
    vi.mocked(readBuilderMnemonic).mockReturnValue(MNEMONIC);
  });

  it("keeps a uniquely resolved handle local even when an endpoint is available", async () => {
    vi.mocked(requireBuilderDvmByHandle).mockReturnValue(entry(1));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const keyring = await resolveBuilderLockKeyringByHandle("my-dvm", "https://dvm.example");

    expect(keyring.canonicalDvmId).toBe(CANONICAL_ID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the original refusal without probing when no endpoint is available", async () => {
    const ambiguity = new DvmError("ambiguous_dvm_handle", "original message", "original hint");
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => {
      throw ambiguity;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveBuilderLockKeyringByHandle("my-dvm")).rejects.toBe(ambiguity);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects the only entry that derives the DVM's advertised current pubkey", async () => {
    const personal = candidate("dvm-personal", 1);
    const acme = candidate("dvm-acme", 2);
    const ambiguity = new DvmError(
      "ambiguous_dvm_handle",
      '2 builder.json entries claim the handle "my-dvm".',
      "original refusal"
    );
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => {
      throw ambiguity;
    });
    vi.mocked(findBuilderDvmsByHandle).mockReturnValue([personal, acme]);
    advertise(deriveBuilderLockKeypair(MNEMONIC, acme.canonical_dvm_id, 2).pubkey);

    const keyring = await resolveBuilderLockKeyringByHandle("my-dvm", "https://dvm.example/");

    expect(keyring.canonicalDvmId).toBe("dvm-acme");
    expect(keyring.rotationIndex).toBe(2);
    expect(keyring.currentKeypair).toEqual(
      deriveBuilderLockKeypair(MNEMONIC, acme.canonical_dvm_id, 2)
    );
  });

  it("matches an advertised pubkey at a retired local rotation index", async () => {
    const retiredMatch = candidate("dvm-retired-match", 3);
    const other = candidate("dvm-other", 1);
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => {
      throw new DvmError("ambiguous_dvm_handle", "ambiguous", "original refusal");
    });
    vi.mocked(findBuilderDvmsByHandle).mockReturnValue([retiredMatch, other]);
    advertise(deriveBuilderLockKeypair(MNEMONIC, retiredMatch.canonical_dvm_id, 1).pubkey);

    const keyring = await resolveBuilderLockKeyringByHandle("my-dvm", "https://dvm.example");

    expect(keyring.canonicalDvmId).toBe("dvm-retired-match");
    expect(keyring.keypairsByPubkey.size).toBe(4);
    expect(keyring.currentKeypair).toEqual(
      deriveBuilderLockKeypair(MNEMONIC, retiredMatch.canonical_dvm_id, 1)
    );
    expect(keyring.currentKeypair).not.toEqual(
      deriveBuilderLockKeypair(MNEMONIC, retiredMatch.canonical_dvm_id, 3)
    );
  });

  it("refuses with a no-match diagnostic when no entry derives the advertised key", async () => {
    const candidates = [candidate("dvm-personal", 1), candidate("dvm-acme", 2)];
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => {
      throw new DvmError("ambiguous_dvm_handle", "ambiguous", "original refusal");
    });
    vi.mocked(findBuilderDvmsByHandle).mockReturnValue(candidates);
    advertise(deriveBuilderLockKeypair(MNEMONIC, "unrecorded-dvm", 0).pubkey);

    await expect(
      resolveBuilderLockKeyringByHandle("my-dvm", "https://dvm.example")
    ).rejects.toMatchObject({
      code: "ambiguous_dvm_handle",
      hint: expect.stringContaining("None of your entries derive the key this DVM advertises"),
      data: { matching_candidates: [] },
    });
  });

  it("refuses when two records derive the advertised key", async () => {
    const duplicateA = candidate("dvm-duplicate", 1);
    const duplicateB = { ...candidate("dvm-duplicate", 1), updated_at: "2026-08-01" };
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => {
      throw new DvmError("ambiguous_dvm_handle", "ambiguous", "original refusal");
    });
    vi.mocked(findBuilderDvmsByHandle).mockReturnValue([duplicateA, duplicateB]);
    advertise(deriveBuilderLockKeypair(MNEMONIC, "dvm-duplicate", 1).pubkey);

    await expect(
      resolveBuilderLockKeyringByHandle("my-dvm", "https://dvm.example")
    ).rejects.toMatchObject({
      code: "ambiguous_dvm_handle",
      hint: expect.stringContaining("2 of your entries derive the key this DVM advertises"),
      data: { matching_candidates: ["dvm-duplicate", "dvm-duplicate"] },
    });
  });

  it("rethrows the original ambiguity when the endpoint is unreachable", async () => {
    const ambiguity = new DvmError("ambiguous_dvm_handle", "original message", "original hint");
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => {
      throw ambiguity;
    });
    vi.mocked(findBuilderDvmsByHandle).mockReturnValue([
      candidate("dvm-personal", 1),
      candidate("dvm-acme", 2),
    ]);
    const fetchMock = vi.fn().mockRejectedValue(new Error("endpoint down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveBuilderLockKeyringByHandle("my-dvm", "https://dvm.example")).rejects.toBe(
      ambiguity
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://dvm.example/v1/info",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });
});

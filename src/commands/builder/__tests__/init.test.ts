import { describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/builder-store", () => ({
  findBuilderDvmsByHandle: vi.fn(),
  upsertBuilderDvm: vi.fn(),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import { DvmError } from "@dvmkit/sdk/internal";

import * as builderStore from "../../../shared/builder-store";
import * as output from "../../../shared/output";
import { init } from "../init";

describe("dvmctl init", () => {
  it("requires --self-hosted", () => {
    expect(() => {
      init("my-dvm", {});
    }).toThrow(DvmError);
  });

  it("rejects invalid slug-shaped handles", () => {
    expect(() => {
      init("Bad_Handle", { selfHosted: true });
    }).toThrow(/not a valid DVM slug/);
  });

  it("persists a UUIDv4 canonical_dvm_id when the handle is fresh", () => {
    vi.mocked(builderStore.findBuilderDvmsByHandle).mockReturnValue([]);
    const upsert = vi.mocked(builderStore.upsertBuilderDvm);
    upsert.mockClear();
    vi.mocked(output.json).mockClear();
    init("my-dvm", { selfHosted: true });
    expect(upsert).toHaveBeenCalledTimes(1);
    const [dvmId, entry] = upsert.mock.calls[0];
    expect(dvmId).toBe(entry.canonical_dvm_id);
    expect(entry.handle).toBe("my-dvm");
    expect(entry.canonical_dvm_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(entry.current_rotation_index).toBe(0);
    expect(entry.self_hosted).toBe(true);
    expect(output.json).toHaveBeenCalledExactlyOnceWith({
      status: "initialized",
      handle: "my-dvm",
      canonical_dvm_id: dvmId,
      current_rotation_index: 0,
      self_hosted: true,
    });
  });

  it("refuses to overwrite an existing handle (would invalidate locked proofs)", () => {
    vi.mocked(builderStore.findBuilderDvmsByHandle).mockReturnValue([
      {
        handle: "my-dvm",
        canonical_dvm_id: "prior",
        current_rotation_index: 0,
        self_hosted: true,
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ]);
    expect(() => {
      init("my-dvm", { selfHosted: true });
    }).toThrow(/already initialized/);
  });

  it("refuses over a platform-deployed entry, which carries no self_hosted flag", () => {
    // Identity changes must preserve the deployed lock. This used to be reachable,
    // and the melter's own `dvm_not_initialized` hint told the operator to run. It
    // mints a second canonical ID that shadows the deployed one on every
    // by-handle lookup, orphaning every proof locked under the first.
    vi.mocked(builderStore.findBuilderDvmsByHandle).mockReturnValue([
      {
        handle: "my-dvm",
        canonical_dvm_id: "dvm-platform-uuid",
        current_rotation_index: 3,
        updated_at: "2026-05-01T00:00:00.000Z",
      },
    ]);
    const upsert = vi.mocked(builderStore.upsertBuilderDvm);
    upsert.mockClear();

    expect(() => {
      init("my-dvm", { selfHosted: true });
    }).toThrow(
      expect.objectContaining({
        code: "already_initialized",
        message: expect.stringContaining("already belongs to a deployed DVM"),
        hint: expect.stringContaining("underivable"),
      })
    );
    expect(upsert).not.toHaveBeenCalled();
  });

});

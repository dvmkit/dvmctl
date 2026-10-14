import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/builder-mnemonic", () => ({
  generateRecoveryMnemonic: vi.fn(),
  isValidMnemonic: vi.fn(),
  readBuilderMnemonic: vi.fn(),
  writeBuilderMnemonic: vi.fn(),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import { DvmError } from "@dvmkit/sdk/internal";

import * as mnemonicLib from "../../../lib/builder-mnemonic";
import * as output from "../../../shared/output";
import { lockCreate } from "../lock";

const GENERATED = "gen1 gen2 gen3 gen4 gen5 gen6 gen7 gen8 gen9 gen10 gen11 gen12";
const IMPORTED = "imp1 imp2 imp3 imp4 imp5 imp6 imp7 imp8 imp9 imp10 imp11 imp12";
const EXISTING = "old1 old2 old3 old4 old5 old6 old7 old8 old9 old10 old11 old12";

describe("dvmctl lock create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mnemonicLib.generateRecoveryMnemonic).mockReturnValue(GENERATED);
    vi.mocked(mnemonicLib.isValidMnemonic).mockReturnValue(true);
    vi.mocked(mnemonicLib.readBuilderMnemonic).mockReturnValue(null);
    vi.mocked(mnemonicLib.writeBuilderMnemonic).mockReturnValue({ backupFile: null });
  });

  it("generates and writes when no mnemonic exists", () => {
    lockCreate({});

    const write = vi.mocked(mnemonicLib.writeBuilderMnemonic);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(GENERATED);
    expect(write.mock.calls[0][1]).toEqual({ force: false });
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({ status: "generated" });
    expect(vi.mocked(output.json).mock.calls[0][0]).not.toHaveProperty("backupFile");
  });

  it("reports already_exists and writes nothing when a mnemonic is present", () => {
    vi.mocked(mnemonicLib.readBuilderMnemonic).mockReturnValue(EXISTING);

    lockCreate({});

    expect(mnemonicLib.writeBuilderMnemonic).not.toHaveBeenCalled();
    const payload = vi.mocked(output.json).mock.calls[0][0] as { status: string; hint: string };
    expect(payload.status).toBe("already_exists");
    // The hint is an agent's only signal that a next step exists.
    expect(payload.hint).toMatch(/--force/);
    expect(payload.hint).toMatch(/--import/);
  });

  it("human already_exists names the flags, not the delete-the-file route", () => {
    vi.mocked(mnemonicLib.readBuilderMnemonic).mockReturnValue(EXISTING);

    lockCreate({ human: true });

    const text = vi
      .mocked(output.info)
      .mock.calls.map((c) => c[0])
      .join("\n");
    expect(text).toMatch(/--force/);
    expect(text).toMatch(/--import/);
    expect(text).not.toMatch(/delete the file/i);
  });

  it("--import restores over an existing mnemonic, opting into the overwrite", () => {
    vi.mocked(mnemonicLib.readBuilderMnemonic).mockReturnValue(EXISTING);
    vi.mocked(mnemonicLib.writeBuilderMnemonic).mockReturnValue({
      backupFile: "/cfg/builder.mnemonic.2026-08-01T00-00-00-000Z.bak",
    });

    lockCreate({ import: IMPORTED });

    const write = vi.mocked(mnemonicLib.writeBuilderMnemonic);
    expect(write.mock.calls[0][0]).toBe(IMPORTED);
    expect(write.mock.calls[0][1]).toEqual({ force: true });
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
      status: "imported",
      backupFile: "/cfg/builder.mnemonic.2026-08-01T00-00-00-000Z.bak",
    });
  });

  it("--force regenerates over an existing mnemonic", () => {
    vi.mocked(mnemonicLib.readBuilderMnemonic).mockReturnValue(EXISTING);
    vi.mocked(mnemonicLib.writeBuilderMnemonic).mockReturnValue({
      backupFile: "/cfg/builder.mnemonic.2026-08-01T00-00-00-000Z.bak",
    });

    lockCreate({ force: true });

    const write = vi.mocked(mnemonicLib.writeBuilderMnemonic);
    expect(write.mock.calls[0][0]).toBe(GENERATED);
    expect(write.mock.calls[0][1]).toEqual({ force: true });
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({ status: "generated" });
  });

  it("rejects an invalid --import before touching the existing mnemonic", () => {
    vi.mocked(mnemonicLib.readBuilderMnemonic).mockReturnValue(EXISTING);
    vi.mocked(mnemonicLib.isValidMnemonic).mockReturnValue(false);

    expect(() => {
      lockCreate({ import: "not a mnemonic" });
    }).toThrow(DvmError);
    expect(mnemonicLib.writeBuilderMnemonic).not.toHaveBeenCalled();
  });

  it("surfaces the backup path in --human output", () => {
    vi.mocked(mnemonicLib.readBuilderMnemonic).mockReturnValue(EXISTING);
    vi.mocked(mnemonicLib.writeBuilderMnemonic).mockReturnValue({
      backupFile: "/cfg/builder.mnemonic.2026-08-01T00-00-00-000Z.bak",
    });

    lockCreate({ import: IMPORTED, human: true });

    const lines = vi.mocked(output.info).mock.calls.map((c) => c[0]);
    expect(lines.some((l) => l.includes("builder.mnemonic.2026-08-01T00-00-00-000Z.bak"))).toBe(
      true
    );
  });
});

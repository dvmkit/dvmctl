import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DvmError } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let mnemonicPath: string;
let renamedLegacyPath: string;
let splitLegacyPath: string;
let explicitBuilderDir: boolean;

vi.mock("../../shared/defaults", async () => {
  return {
    get BUILDER_CONFIG_DIR() {
      return tmpDir;
    },
    get BUILDER_CONFIG_DIR_EXPLICIT() {
      return explicitBuilderDir;
    },
    get BUILDER_MNEMONIC_FILE() {
      return mnemonicPath;
    },
    get LEGACY_BUILDER_MNEMONIC_FILE() {
      return renamedLegacyPath;
    },
    get RECOVERY_MNEMONIC_FILE() {
      return splitLegacyPath;
    },
  };
});

vi.mock("../../shared/output", () => ({ info: vi.fn() }));

// Imported after the mock so the module picks up the dynamic getters. Real
// files on a real tmpdir, not a mocked `fs` — the mode the file ends up with
// *after* the rename is the whole point, and only the filesystem can answer it.
import {
  generateRecoveryMnemonic,
  getBuilderMnemonicMigrationHint,
  readBuilderMnemonic,
  writeBuilderMnemonic,
} from "../builder-mnemonic";

const WORDS_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const WORDS_B = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

/** Backup siblings the writer left behind, in creation order. */
function backups(): string[] {
  return readdirSync(tmpDir)
    .filter((f) => f.startsWith("builder.mnemonic.") && f.endsWith(".bak"))
    .sort();
}

describe("writeBuilderMnemonic", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dvmkit-builder-mnemonic-"));
    mnemonicPath = join(tmpDir, "builder.mnemonic");
    renamedLegacyPath = join(tmpDir, "recovery.mnemonic");
    splitLegacyPath = join(tmpDir, "legacy", "recovery.mnemonic");
    explicitBuilderDir = false;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes with mode 0600 when no mnemonic exists, and reports no backup", () => {
    const result = writeBuilderMnemonic(WORDS_A);

    expect(readFileSync(mnemonicPath, "utf-8").trim()).toBe(WORDS_A);
    expect(statSync(mnemonicPath).mode & 0o777).toBe(0o600);
    expect(result.backupFile).toBeNull();
    expect(backups()).toEqual([]);
    expect(readBuilderMnemonic()).toBe(WORDS_A);
  });

  it("refuses to overwrite an existing mnemonic without force", () => {
    writeBuilderMnemonic(WORDS_A);

    expect(() => writeBuilderMnemonic(WORDS_B)).toThrow(DvmError);
    try {
      writeBuilderMnemonic(WORDS_B);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DvmError).code).toBe("mnemonic_exists");
    }

    // The whole point: the existing words survived untouched.
    expect(readFileSync(mnemonicPath, "utf-8").trim()).toBe(WORDS_A);
    expect(backups()).toEqual([]);
  });

  it("refuses when only the legacy ~/.dvm mnemonic exists", () => {
    mkdirSync(join(tmpDir, "legacy"), { mode: 0o700 });
    writeFileSync(splitLegacyPath, WORDS_A + "\n", { mode: 0o600 });

    // A caller that writes without reading first never triggers the migration
    // in `readBuilderMnemonic`, so the guard has to see the legacy path too —
    // otherwise it writes a root that silently shadows live words.
    try {
      writeBuilderMnemonic(WORDS_B);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as DvmError).code).toBe("mnemonic_exists");
      expect((err as DvmError).message).toContain(splitLegacyPath);
    }

    expect(existsSync(mnemonicPath)).toBe(false);
    expect(readFileSync(splitLegacyPath, "utf-8").trim()).toBe(WORDS_A);
  });

  it("force past a legacy mnemonic backs the legacy words up", () => {
    writeFileSync(renamedLegacyPath, WORDS_A + "\n", { mode: 0o600 });

    const result = writeBuilderMnemonic(WORDS_B, { force: true });

    expect(readFileSync(mnemonicPath, "utf-8").trim()).toBe(WORDS_B);
    const backup = String(result.backupFile);
    expect(readFileSync(backup, "utf-8").trim()).toBe(WORDS_A);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
  });

  it("force replaces the mnemonic and leaves the prior words in a 0600 backup", () => {
    writeBuilderMnemonic(WORDS_A);

    const result = writeBuilderMnemonic(WORDS_B, { force: true });

    expect(readFileSync(mnemonicPath, "utf-8").trim()).toBe(WORDS_B);
    expect(statSync(mnemonicPath).mode & 0o777).toBe(0o600);

    expect(result.backupFile).not.toBeNull();
    const backup = String(result.backupFile);
    expect(readFileSync(backup, "utf-8").trim()).toBe(WORDS_A);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(backups()).toHaveLength(1);
    expect(existsSync(`${mnemonicPath}.tmp`)).toBe(false);
  });

  it("skips the backup when the forced write is the same mnemonic", () => {
    writeBuilderMnemonic(WORDS_A);

    const result = writeBuilderMnemonic(WORDS_A, { force: true });

    expect(result.backupFile).toBeNull();
    expect(backups()).toEqual([]);
    expect(readFileSync(mnemonicPath, "utf-8").trim()).toBe(WORDS_A);
  });

  it("keeps every backup when the same mnemonic is replaced twice", () => {
    writeBuilderMnemonic(WORDS_A);
    const first = writeBuilderMnemonic(WORDS_B, { force: true });
    const second = writeBuilderMnemonic(generateRecoveryMnemonic(), { force: true });

    expect(first.backupFile).not.toBe(second.backupFile);
    expect(backups()).toHaveLength(2);
    expect(backups().map((f) => readFileSync(join(tmpDir, f), "utf-8").trim())).toEqual(
      expect.arrayContaining([WORDS_A, WORDS_B])
    );
  });

  it("creates the config dir at 0700 so a backup can't be world-readable", () => {
    rmSync(tmpDir, { recursive: true, force: true });

    writeBuilderMnemonic(WORDS_A);

    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
  });

  it("migrates the former builder filename once and keeps mode 0600", () => {
    writeFileSync(renamedLegacyPath, WORDS_A + "\n", { mode: 0o644 });

    expect(readBuilderMnemonic()).toBe(WORDS_A);
    expect(readBuilderMnemonic()).toBe(WORDS_A);

    expect(existsSync(renamedLegacyPath)).toBe(false);
    expect(readFileSync(mnemonicPath, "utf-8").trim()).toBe(WORDS_A);
    expect(statSync(mnemonicPath).mode & 0o777).toBe(0o600);
  });

  it("still migrates the pre-state-split ~/.dvm filename", () => {
    mkdirSync(join(tmpDir, "legacy"), { mode: 0o700 });
    writeFileSync(splitLegacyPath, WORDS_A + "\n", { mode: 0o600 });

    expect(readBuilderMnemonic()).toBe(WORDS_A);

    expect(existsSync(splitLegacyPath)).toBe(false);
    expect(readFileSync(mnemonicPath, "utf-8").trim()).toBe(WORDS_A);
  });

  it.each(["caller", "builder"])("leaves the %s legacy mnemonic untouched with an explicit builder tree", (location) => {
    explicitBuilderDir = true;
    mkdirSync(join(tmpDir, "legacy"), { mode: 0o700 });
    const legacyPath = location === "caller" ? splitLegacyPath : renamedLegacyPath;
    writeFileSync(legacyPath, WORDS_A + "\n", { mode: 0o644 });
    const before = readdirSync(tmpDir);

    expect(readBuilderMnemonic()).toBeNull();
    expect(readBuilderMnemonic()).toBeNull();

    expect(readdirSync(tmpDir)).toEqual(before);
    expect(readFileSync(legacyPath, "utf-8")).toBe(WORDS_A + "\n");
    expect(statSync(legacyPath).mode & 0o777).toBe(0o644);
    const hint = getBuilderMnemonicMigrationHint();
    expect(hint).toContain(legacyPath);
    expect(hint).toContain("DVMKIT_CONFIG_DIR");
    expect(hint).toContain("dvmctl lock create --import");
    expect(hint).not.toContain(WORDS_A);
  });

  it("does not create an explicit builder directory on a legacy-only read", () => {
    explicitBuilderDir = true;
    const root = tmpDir;
    splitLegacyPath = join(root, "recovery.mnemonic");
    writeFileSync(splitLegacyPath, WORDS_A + "\n");
    tmpDir = join(root, "builder");
    mnemonicPath = join(tmpDir, "builder.mnemonic");
    renamedLegacyPath = join(tmpDir, "recovery.mnemonic");
    try {
      expect(readBuilderMnemonic()).toBeNull();
      expect(existsSync(tmpDir)).toBe(false);
      expect(readFileSync(splitLegacyPath, "utf-8")).toBe(WORDS_A + "\n");
    } finally {
      tmpDir = root;
    }
  });

  it("reads the current mnemonic in an explicit tree without touching a legacy file", () => {
    explicitBuilderDir = true;
    writeFileSync(mnemonicPath, WORDS_B + "\n");
    writeFileSync(renamedLegacyPath, WORDS_A + "\n");

    expect(readBuilderMnemonic()).toBe(WORDS_B);
    expect(getBuilderMnemonicMigrationHint()).toBeNull();
    expect(readFileSync(renamedLegacyPath, "utf-8")).toBe(WORDS_A + "\n");
  });
});

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeMnemonicBackups,
  findMnemonicBackups,
  formatMnemonicBackupAge,
} from "../mnemonic-backups";

const NOW = Date.parse("2026-08-23T12:00:00.000Z");

let dir: string;
let mnemonicFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dvmkit-mnemonic-backups-"));
  mnemonicFile = join(dir, "wallet.mnemonic");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findMnemonicBackups", () => {
  it("returns only matching regular files with paths and ages, oldest first", () => {
    const older = `${mnemonicFile}.2026-08-20T12-00-00-000Z.bak`;
    const newer = `${mnemonicFile}.2026-08-23T09-00-00-000Z.bak`;
    writeFileSync(newer, "newer words\n");
    writeFileSync(older, "older words\n");
    writeFileSync(join(dir, "recovery.mnemonic.2026-08-20.bak"), "builder words\n");
    writeFileSync(`${mnemonicFile}.tmp`, "temporary words\n");
    mkdirSync(`${mnemonicFile}.directory.bak`);
    utimesSync(
      older,
      new Date(NOW - 3 * 24 * 60 * 60 * 1000),
      new Date(NOW - 3 * 24 * 60 * 60 * 1000)
    );
    utimesSync(newer, new Date(NOW - 3 * 60 * 60 * 1000), new Date(NOW - 3 * 60 * 60 * 1000));

    expect(findMnemonicBackups(mnemonicFile, NOW)).toEqual([
      {
        path: older,
        modifiedAt: "2026-08-20T12:00:00.000Z",
        ageMs: 3 * 24 * 60 * 60 * 1000,
        ageDays: 3,
        age: "3 days old",
      },
      {
        path: newer,
        modifiedAt: "2026-08-23T09:00:00.000Z",
        ageMs: 3 * 60 * 60 * 1000,
        ageDays: 0,
        age: "3 hours old",
      },
    ]);
  });

  it("treats a missing config directory as no backups", () => {
    expect(findMnemonicBackups(join(dir, "missing", "wallet.mnemonic"), NOW)).toEqual([]);
  });
});

describe("describeMnemonicBackups", () => {
  it("is silent without backups", () => {
    expect(describeMnemonicBackups(mnemonicFile, NOW)).toBeNull();
  });

  it("names every backup and explains when deletion is safe", () => {
    const first = `${mnemonicFile}.first.bak`;
    const second = `${mnemonicFile}.second.bak`;
    writeFileSync(first, "first words\n");
    writeFileSync(second, "second words\n");
    utimesSync(first, new Date(NOW - 24 * 60 * 60 * 1000), new Date(NOW - 24 * 60 * 60 * 1000));
    utimesSync(second, new Date(NOW - 60 * 60 * 1000), new Date(NOW - 60 * 60 * 1000));

    const warning = describeMnemonicBackups(mnemonicFile, NOW);

    expect(warning).toMatchObject({
      details: { count: 2, paths: [first, second] },
    });
    expect(warning?.display).toBe(
      `2 plaintext builder-mnemonic backups remain on disk: ${first} (1 day old); ${second} (1 hour old).`
    );
    expect(warning?.hint).toContain("Deleting them is safe");
    expect(warning?.hint).toContain("password-manager and offline backups");
  });

  it("combines backups from current and legacy mnemonic paths without duplicates", () => {
    const legacyDir = join(dir, "legacy");
    const legacyMnemonic = join(legacyDir, "recovery.mnemonic");
    const current = `${mnemonicFile}.current.bak`;
    const legacy = `${legacyMnemonic}.legacy.bak`;
    mkdirSync(legacyDir);
    writeFileSync(current, "current words\n");
    writeFileSync(legacy, "legacy words\n");
    utimesSync(current, new Date(NOW - 60 * 60 * 1000), new Date(NOW - 60 * 60 * 1000));
    utimesSync(legacy, new Date(NOW - 2 * 60 * 60 * 1000), new Date(NOW - 2 * 60 * 60 * 1000));

    const warning = describeMnemonicBackups([mnemonicFile, legacyMnemonic, mnemonicFile], NOW);

    expect(warning?.details).toMatchObject({
      count: 2,
      paths: [legacy, current],
    });
    expect(warning?.display).toContain(`${legacy} (2 hours old)`);
    expect(warning?.display).toContain(`${current} (1 hour old)`);
  });
});

describe("formatMnemonicBackupAge", () => {
  it.each([
    [30_000, "less than a minute old"],
    [60_000, "1 minute old"],
    [2 * 60 * 60 * 1000, "2 hours old"],
    [2 * 24 * 60 * 60 * 1000, "2 days old"],
  ])("formats %i milliseconds as %s", (ageMs, expected) => {
    expect(formatMnemonicBackupAge(ageMs)).toBe(expected);
  });
});

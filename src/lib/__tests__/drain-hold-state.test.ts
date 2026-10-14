
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the `vi.mock` factory that consumes it, so it runs before any
// import — hence the string-built path rather than `mkdtempSync`. The module
// creates the directory itself on first write.
const paths = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const dir = `${root}/dvmkit-drain-hold-${process.pid}-${Date.now()}`;
  return { dir, file: `${dir}/drain-hold.json` };
});

vi.mock("../../shared/defaults", () => ({
  BUILDER_CONFIG_DIR: paths.dir,
  DRAIN_HOLD_STATE_FILE: paths.file,
}));

import { drainHoldElapsedMs, recordDrainState } from "../drain-hold-state";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-07-01T00:00:00.000Z");

describe("recordDrainState", () => {
  beforeEach(() => {
    rmSync(paths.file, { force: true });
  });

  afterAll(() => {
    rmSync(paths.dir, { recursive: true, force: true });
  });

  it("returns null while the surface answers, and writes nothing", () => {
    expect(recordDrainState("dvm-fixture-1", true, T0)).toBeNull();
    expect(() => statSync(paths.file)).toThrow();
  });

  it("stamps the start of a streak and holds it steady across later runs", () => {
    const first = recordDrainState("dvm-fixture-1", false, T0);
    expect(first).toBe(new Date(T0).toISOString());
    // The point of persisting: run two must not reset the clock run one started.
    expect(recordDrainState("dvm-fixture-1", false, T0 + 30 * HOUR)).toBe(first);
  });

  it("forgets the streak once the surface answers again", () => {
    recordDrainState("dvm-fixture-1", false, T0);
    expect(recordDrainState("dvm-fixture-1", true, T0 + HOUR)).toBeNull();
    expect(recordDrainState("dvm-fixture-1", false, T0 + 2 * HOUR)).toBe(
      new Date(T0 + 2 * HOUR).toISOString()
    );
  });

  it("keeps one streak per DVM — five first-party handles share this file", () => {
    recordDrainState("dvm-fixture-1", false, T0);
    recordDrainState("dvm-fixture-2", false, T0 + HOUR);
    expect(recordDrainState("dvm-fixture-1", true, T0 + 2 * HOUR)).toBeNull();
    expect(recordDrainState("dvm-fixture-2", false, T0 + 3 * HOUR)).toBe(new Date(T0 + HOUR).toISOString());
  });

  it("writes the state file 0600 — it names every DVM this workstation melts", () => {
    recordDrainState("dvm-fixture-1", false, T0);
    expect(statSync(paths.file).mode & 0o777).toBe(0o600);
  });

  it("starts a fresh streak on a corrupt file rather than failing the sweep", () => {
    writeFileSync(paths.file, "{not json");
    expect(recordDrainState("dvm-fixture-1", false, T0)).toBe(new Date(T0).toISOString());
    expect(JSON.parse(readFileSync(paths.file, "utf-8"))).toEqual({
      "dvm-fixture-1": { unknown_since: new Date(T0).toISOString() },
    });
  });
});

describe("drainHoldElapsedMs", () => {
  it("measures the streak from its recorded start", () => {
    expect(drainHoldElapsedMs(new Date(T0).toISOString(), T0 + 25 * HOUR)).toBe(25 * HOUR);
  });

  it("returns null for no streak, and for one it cannot read", () => {
    expect(drainHoldElapsedMs(null, T0)).toBeNull();
    expect(drainHoldElapsedMs("last tuesday", T0)).toBeNull();
  });

  it("floors at zero rather than reporting a negative hold on a clock skew", () => {
    expect(drainHoldElapsedMs(new Date(T0).toISOString(), T0 - HOUR)).toBe(0);
  });
});

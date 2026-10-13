
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the `vi.mock` factory that consumes it, so it runs before any
// import — hence the string-built path rather than `mkdtempSync`. The module
// creates the directory itself on first write.
const paths = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const dir = `${root}/dvmkit-melt-success-${process.pid}-${Date.now()}`;
  return { dir, file: `${dir}/melt-success.json` };
});

vi.mock("../../shared/defaults", () => ({
  BUILDER_CONFIG_DIR: paths.dir,
  MELT_SUCCESS_FILE: paths.file,
}));

import {
  meltRunAgeMs,
  readMeltSuccess,
  readMeltSuccesses,
  recordMeltSuccess,
} from "../melt-success-state";

const T0 = Date.parse("2026-08-20T06:00:00.000Z");
const HOUR = 3_600_000;

const RUN = {
  handle: "cast",
  batches_melted: 3,
  sats_melted: 42_000,
  drains_parked: 1,
};

describe("recordMeltSuccess", () => {
  beforeEach(() => {
    rmSync(paths.file, { force: true });
  });

  afterAll(() => {
    rmSync(paths.dir, { recursive: true, force: true });
  });

  it("stamps the run and reads it back whole", () => {
    recordMeltSuccess("dvm-fixture-1", "sweep", RUN, T0);
    expect(statSync(paths.file).mode & 0o777).toBe(0o600);

    expect(readMeltSuccess("dvm-fixture-1")).toEqual({
      sweep: { ...RUN, at: "2026-08-20T06:00:00.000Z" },
      drains_only: null,
    });
  });

  it("keeps one clock per DVM — five first-party DVMs alarm independently", () => {
    recordMeltSuccess("dvm-fixture-1", "sweep", RUN, T0);
    recordMeltSuccess("dvm-fixture-2", "sweep", { ...RUN, handle: "scrape" }, T0 + HOUR);

    expect(readMeltSuccess("dvm-fixture-1")?.sweep?.at).toBe("2026-08-20T06:00:00.000Z");
    expect(readMeltSuccess("dvm-fixture-2")?.sweep?.at).toBe("2026-08-20T07:00:00.000Z");
    expect([...readMeltSuccesses().keys()]).toEqual(["dvm-fixture-1", "dvm-fixture-2"]);
  });

  it("advances the stamp on a later run", () => {
    recordMeltSuccess("dvm-fixture-1", "sweep", RUN, T0);
    recordMeltSuccess("dvm-fixture-2", "sweep", { ...RUN, handle: "scrape" }, T0);
    recordMeltSuccess("dvm-fixture-1", "sweep", { ...RUN, sats_melted: 7 }, T0 + 24 * HOUR);
    expect(JSON.parse(readFileSync(paths.file, "utf-8"))["dvm-fixture-2"]).toEqual({
      sweep: { ...RUN, handle: "scrape", at: "2026-08-20T06:00:00.000Z" },
      drains_only: null,
    });

    expect(readMeltSuccess("dvm-fixture-1")?.sweep).toMatchObject({
      at: "2026-08-21T06:00:00.000Z",
      sats_melted: 7,
    });
  });

  it("keeps a --drains-only run on its own clock, never touching the sweep's", () => {
    recordMeltSuccess("dvm-fixture-1", "sweep", RUN, T0);
    recordMeltSuccess(
      "dvm-fixture-1",
      "drains_only",
      { ...RUN, batches_melted: 0, sats_melted: 0 },
      T0 + 30 * HOUR
    );

    expect(readMeltSuccess("dvm-fixture-1")?.sweep?.at).toBe("2026-08-20T06:00:00.000Z");
    expect(readMeltSuccess("dvm-fixture-1")?.drains_only?.at).toBe("2026-08-21T12:00:00.000Z");
  });

  it("records a drains-only run on a DVM that has never swept, without inventing a sweep", () => {
    recordMeltSuccess("dvm-fixture-1", "drains_only", RUN, T0);

    expect(readMeltSuccess("dvm-fixture-1")?.sweep).toBeNull();
    expect(readMeltSuccess("dvm-fixture-1")?.drains_only?.at).toBe("2026-08-20T06:00:00.000Z");
  });

  it("returns null for a DVM that has never had a clean run here", () => {
    expect(readMeltSuccess("dvm-unknown")).toBeNull();
    expect(readMeltSuccesses().size).toBe(0);
  });

  it("survives a corrupt file rather than failing the run that just succeeded", () => {
    writeFileSync(paths.file, "{not json");

    expect(readMeltSuccesses().size).toBe(0);
    recordMeltSuccess("dvm-fixture-1", "sweep", RUN, T0);
    expect(readMeltSuccess("dvm-fixture-1")?.sweep?.at).toBe("2026-08-20T06:00:00.000Z");
  });

  it("drops a run with no timestamp — the timestamp is the whole point", () => {
    writeFileSync(
      paths.file,
      JSON.stringify({
        "dvm-fixture-1": { sweep: { handle: "cast" } },
        "dvm-fixture-2": { sweep: { ...RUN, at: "x" } },
      })
    );

    expect(readMeltSuccess("dvm-fixture-1")).toBeNull();
    expect(readMeltSuccess("dvm-fixture-2")?.sweep?.at).toBe("x");
  });

});

describe("meltRunAgeMs", () => {
  it("measures the gap since the recorded run", () => {
    expect(meltRunAgeMs({ ...RUN, at: "2026-08-20T06:00:00.000Z" }, T0 + 26 * HOUR)).toBe(
      26 * HOUR
    );
  });

  it("answers null for a missing run and for an unreadable timestamp", () => {
    expect(meltRunAgeMs(null, T0)).toBeNull();
    expect(meltRunAgeMs({ ...RUN, at: "never" }, T0)).toBeNull();
  });

  it("refuses to age a future-dated stamp rather than calling it fresh", () => {
    expect(meltRunAgeMs({ ...RUN, at: "2026-08-20T06:00:00.001Z" }, T0)).toBeNull();
  });

  it("still ages a stamp made this instant", () => {
    expect(meltRunAgeMs({ ...RUN, at: "2026-08-20T06:00:00.000Z" }, T0)).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as meltSuccessStateModule from "../../../lib/melt-success-state";

vi.mock("../../../shared/defaults", () => ({
  BUILDER_FILE: "/mock/.dvmkit/builder.json",
  MELT_SUCCESS_FILE: "/mock/.dvmkit/melt-success.json",
}));

vi.mock("../../../shared/builder-store", async () => {
  const { DvmError } = await import("@dvmkit/sdk/internal");
  const entries: Record<string, { handle: string; canonical_dvm_id: string }> = {};
  return {
    __entries: entries,
    loadBuilderStore: vi.fn(() => ({ version: 2, dvms: entries })),
    requireBuilderDvmByHandle: vi.fn((handle: string) => {
      const entry = Object.values(entries).find((candidate) => candidate.handle === handle);
      if (!entry) {
        throw new DvmError(
          "dvm_not_initialized",
          `No builder.json entry on this machine for "${handle}".`,
          "An entry is recorded by the deploy that created the DVM."
        );
      }
      return entry;
    }),
  };
});

vi.mock("../../../lib/melt-success-state", async (importOriginal) => ({
  ...(await importOriginal<typeof meltSuccessStateModule>()),
  readMeltSuccesses: vi.fn(() => new Map()),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import type { MeltRunRecord, MeltSuccessRecord } from "../../../lib/melt-success-state";
import * as meltSuccessState from "../../../lib/melt-success-state";
import * as builderStore from "../../../shared/builder-store";
import * as output from "../../../shared/output";
import { meltStatus, type MeltStatusEntry } from "../melt-status";

const entries = (
  builderStore as unknown as {
    __entries: Record<string, { handle: string; canonical_dvm_id: string }>;
  }
).__entries;

/** Reset the builder.json fixture in place — the mock closes over this object. */
function seedEntries(seed: Record<string, { handle: string; canonical_dvm_id: string }>): void {
  for (const key of Object.keys(entries)) {
    entries[key] = seed[key] ?? entries[key];
  }
  for (const key of Object.keys(entries)) {
    if (!(key in seed)) Reflect.deleteProperty(entries, key);
  }
  Object.assign(entries, seed);
}

function run(agoMs: number): MeltRunRecord {
  return {
    at: new Date(Date.now() - agoMs).toISOString(),
    handle: "cast",
    batches_melted: 2,
    sats_melted: 1_000,
    drains_parked: 0,
  };
}

/** A record carrying only a clean sweep, which is the ordinary case. */
function record(agoMs: number): MeltSuccessRecord {
  return { sweep: run(agoMs), drains_only: null };
}

/** The JSON the command emitted, as an agent would read it. */
function emitted(): {
  dvms: MeltStatusEntry[];
  max_age_seconds: number | null;
  excepted: string[];
  orphaned: string[];
} {
  expect(output.json).toHaveBeenCalled();
  const call = vi.mocked(output.json).mock.calls.at(-1);
  return call?.[0] as ReturnType<typeof emitted>;
}

const HOUR = 3_600_000;

describe("dvmctl melt-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedEntries({
      "dvm-cast": { handle: "cast", canonical_dvm_id: "dvm-cast" },
      "dvm-scrape": { handle: "scrape", canonical_dvm_id: "dvm-scrape" },
    });
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(new Map());
  });

  it("reports every DVM on this machine when no handle is named", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([["dvm-cast", record(2 * HOUR)]])
    );

    meltStatus(undefined, {});

    expect(emitted().dvms.map((entry) => entry.handle)).toEqual(["cast", "scrape"]);
    expect(emitted().dvms[0].age_seconds).toBeGreaterThanOrEqual(7199);
    expect(emitted().dvms[1].last_success_at).toBeNull();
    expect(output.json).toHaveBeenCalledWith(expect.objectContaining({
      state_file: "/mock/.dvmkit/melt-success.json",
    }));
  });

  it("surfaces orphaned records without treating them as watched DVMs", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([
        ["dvm-cast", record(2 * HOUR)],
        ["dvm-scrape", record(2 * HOUR)],
        ["dvm-retired-z", record(40 * HOUR)],
        ["dvm-retired-a", record(40 * HOUR)],
      ])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h" })).not.toThrow();
    expect(emitted().orphaned).toEqual(["dvm-retired-a", "dvm-retired-z"]);
    expect(emitted().dvms.map((entry) => entry.dvm_id)).toEqual(["dvm-cast", "dvm-scrape"]);
  });

  it("names orphaned records in human output without failing the query", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([["dvm-retired", record(40 * HOUR)]])
    );

    expect(() => meltStatus(undefined, { human: true })).not.toThrow();
    expect(vi.mocked(output.info)).toHaveBeenCalledWith(
      "Orphaned melt records (not watched): dvm-retired"
    );
  });

  it("narrows to one DVM when a handle is named", () => {
    meltStatus("scrape", {});

    expect(emitted().dvms.map((entry) => entry.handle)).toEqual(["scrape"]);
  });

  it("exits clean when every DVM melted inside --max-age", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([
        ["dvm-cast", record(2 * HOUR)],
        ["dvm-scrape", record(29 * HOUR)],
      ])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h" })).not.toThrow();
    expect(emitted().dvms.every((entry) => !entry.stale)).toBe(true);
  });

  it("refuses when a DVM has not melted inside --max-age", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([
        ["dvm-cast", record(2 * HOUR)],
        ["dvm-scrape", record(40 * HOUR)],
      ])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h" })).toThrow(
      expect.objectContaining({ code: "melt_stale" })
    );
  });

  it("never lets a --drains-only run stand in for a sweep", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([
        ["dvm-cast", { sweep: run(40 * HOUR), drains_only: run(1 * HOUR) }],
        ["dvm-scrape", record(2 * HOUR)],
      ])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h" })).toThrow(
      expect.objectContaining({ code: "melt_stale" })
    );
    expect(emitted().dvms[0]).toMatchObject({ stale: true, drains_only_age_seconds: 3600 });
  });

  it("reports the drains-only clock even though it never counts", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([["dvm-cast", { sweep: run(2 * HOUR), drains_only: run(HOUR) }]])
    );

    meltStatus("cast", {});

    expect(emitted().dvms[0].last_drains_only_at).not.toBeNull();
  });

  it("treats a DVM with no record at all as stale, not as fine", () => {
    expect(() => meltStatus("cast", { maxAge: "30h" })).toThrow(
      expect.objectContaining({
        code: "melt_stale",
        message: expect.stringContaining("cast (never swept on this machine)"),
        hint: expect.stringMatching(/no caller refund is parking.*--except <handle>/),
      })
    );
    expect(emitted().dvms[0].stale).toBe(true);
  });

  it("alarms on an unnamed DVM that has never swept — no record means tell me", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([["dvm-cast", record(2 * HOUR)]])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h" })).toThrow(
      expect.objectContaining({ code: "melt_stale" })
    );
    expect(emitted().dvms).toMatchObject([
      { handle: "cast", stale: false },
      { handle: "scrape", stale: true },
    ]);
  });

  it("exempts a DVM only when the builder says so, and reports that it did", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([["dvm-cast", record(2 * HOUR)]])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h", except: ["scrape"] })).not.toThrow();
    expect(emitted().dvms.map((entry) => entry.handle)).toEqual(["cast", "scrape"]);
    expect(emitted().dvms[1].stale).toBe(false);
    expect(emitted().excepted).toEqual(["scrape"]);
  });

  it("keeps --except out of a plain report when no alarm window was requested", () => {
    meltStatus(undefined, { except: ["scrape"] });

    expect(emitted().dvms.map((entry) => entry.handle)).toEqual(["cast", "scrape"]);
    expect(emitted().excepted).toEqual(["scrape"]);
  });

  it("keeps alarming on a DVM whose handle --except misspells", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([["dvm-cast", record(2 * HOUR)]])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h", except: ["scrap"] })).toThrow(
      expect.objectContaining({ code: "melt_stale" })
    );
    expect(emitted().excepted).toEqual([]);
  });

  it("refuses --except on a handle two entries claim, rather than dropping both", () => {
    seedEntries({
      "dvm-cast-old": { handle: "cast", canonical_dvm_id: "dvm-cast-old" },
      "dvm-cast-new": { handle: "cast", canonical_dvm_id: "dvm-cast-new" },
    });

    expect(() => meltStatus(undefined, { maxAge: "30h", except: ["cast"] })).toThrow(
      expect.objectContaining({
        code: "ambiguous_dvm_handle",
        hint: expect.stringMatching(/dvm-cast-old.*dvm-cast-new/),
      })
    );
  });

  it("refuses an --except value that is not a handle", () => {
    expect(() => meltStatus(undefined, { except: ["--max-age"] })).toThrow(
      expect.objectContaining({ code: "invalid_except_handle" })
    );
    expect(() => meltStatus(undefined, { maxAge: "30h", except: [""] })).toThrow(
      expect.objectContaining({ code: "invalid_except_handle" })
    );
  });

  it("refuses a future-dated sweep instead of calling it fresh forever", () => {
    vi.mocked(meltSuccessState.readMeltSuccesses).mockReturnValue(
      new Map([
        ["dvm-cast", { sweep: run(-400 * 24 * HOUR), drains_only: null }],
        ["dvm-scrape", record(2 * HOUR)],
      ])
    );

    expect(() => meltStatus(undefined, { maxAge: "30h" })).toThrow(
      expect.objectContaining({ code: "melt_stale" })
    );
    expect(emitted().dvms[0]).toMatchObject({ stale: true, age_seconds: null });
  });

  it("refuses when --except excludes every DVM, rather than watching nothing", () => {
    expect(() => meltStatus(undefined, { maxAge: "30h", except: ["cast", "scrape"] })).toThrow(
      expect.objectContaining({ code: "no_dvms_recorded" })
    );
    expect(emitted().dvms.map((entry) => entry.handle)).toEqual(["cast", "scrape"]);
  });

  it("never calls anything stale without --max-age — reading is not alarming", () => {
    expect(() => meltStatus(undefined, {})).not.toThrow();
    expect(emitted().dvms.every((entry) => !entry.stale)).toBe(true);
    expect(emitted().max_age_seconds).toBeNull();
  });

  it("refuses an unparseable --max-age rather than alarming on a guess", () => {
    expect(() => meltStatus(undefined, { maxAge: "soon" })).toThrow(
      expect.objectContaining({ code: "invalid_duration" })
    );
  });

  it("refuses --max-age when this machine records no DVMs at all", () => {
    seedEntries({});

    expect(() => meltStatus(undefined, { maxAge: "30h" })).toThrow(
      expect.objectContaining({
        code: "no_dvms_recorded",
        message: expect.stringContaining("/mock/.dvmkit/builder.json"),
        hint: expect.stringContaining("DVMKIT_CONFIG_DIR"),
      })
    );
    expect(emitted().dvms).toEqual([]);
  });

  it("still reads clean on an empty machine without --max-age — reading is not alarming", () => {
    seedEntries({});

    expect(() => meltStatus(undefined, {})).not.toThrow();
    expect(emitted().dvms).toEqual([]);
  });

  it("passes an unknown handle through the store's own refusal", () => {
    expect(() => meltStatus("nope", {})).toThrow(
      expect.objectContaining({ code: "dvm_not_initialized" })
    );
  });
});

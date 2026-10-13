import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let logPath: string;

vi.mock("../../shared/defaults", async () => {
  return {
    get BUILDER_CONFIG_DIR() {
      return tmpDir;
    },
    get MELT_PENDING_LOG_FILE() {
      return logPath;
    },
  };
});

// Imported after the mock so the module picks up the dynamic getters.
import { appendPostMelt, appendPreMelt, readInFlight } from "../melt-pending-log";

describe("melt-pending-log", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dvmkit-melt-log-"));
    logPath = join(tmpDir, "melt-pending.log");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends pre/post entries as JSONL with mode 0600", () => {
    appendPreMelt({
      dvm_id: "dvm-fixture-1",
      row_ids: ["r1"],
      mint_url: "https://mint",
      quote_id: "q1",
      lock_pubkey: "p1",
      total_sats: 10,
    });
    appendPostMelt({
      dvm_id: "dvm-fixture-1",
      row_ids: ["r1"],
      quote_id: "q1",
      status: "success",
      preimage: "abc",
    });
    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe("pre_melt");
    expect(JSON.parse(lines[1]).kind).toBe("post_melt");
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it("readInFlight returns pre-melt entries without a paired post-melt", () => {
    appendPreMelt({
      dvm_id: "dvm-fixture-1",
      row_ids: ["r1"],
      mint_url: "https://mint",
      quote_id: "q1",
      lock_pubkey: "p1",
      total_sats: 10,
    });
    appendPreMelt({
      dvm_id: "dvm-fixture-1",
      row_ids: ["r2"],
      mint_url: "https://mint",
      quote_id: "q2",
      lock_pubkey: "p1",
      total_sats: 20,
    });
    appendPostMelt({
      dvm_id: "dvm-fixture-1",
      row_ids: ["r2"],
      quote_id: "q2",
      status: "success",
      preimage: "x",
    });
    const inFlight = readInFlight("dvm-fixture-1");
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].quoteId).toBe("q1");
    expect(inFlight[0].rowIds).toEqual(["r1"]);
    expect(inFlight[0].totalSats).toBe(10);
  });

  it("readInFlight scopes by dvm_id", () => {
    appendPreMelt({
      dvm_id: "dvm-a",
      row_ids: ["r1"],
      mint_url: "https://mint",
      quote_id: "q1",
      lock_pubkey: "p",
      total_sats: 5,
    });
    appendPreMelt({
      dvm_id: "dvm-b",
      row_ids: ["r2"],
      mint_url: "https://mint",
      quote_id: "q1",
      lock_pubkey: "p",
      total_sats: 5,
    });
    expect(readInFlight("dvm-a")).toHaveLength(1);
    expect(readInFlight("dvm-b")).toHaveLength(1);
    expect(readInFlight("dvm-c")).toHaveLength(0);
  });

  it("returns [] when the log file does not exist", () => {
    expect(readInFlight("dvm-fixture-1")).toEqual([]);
  });

  it("skips malformed JSONL lines without crashing", () => {
    writeFileSync(
      logPath,
      JSON.stringify({
        kind: "pre_melt",
        ts: 1,
        dvm_id: "dvm-fixture-1",
        row_ids: ["r1"],
        mint_url: "m",
        quote_id: "q",
        lock_pubkey: "p",
        total_sats: 1,
      }) + "\nnot-json-garbage\n",
      { mode: 0o600 }
    );
    const inFlight = readInFlight("dvm-fixture-1");
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].quoteId).toBe("q");
  });
});

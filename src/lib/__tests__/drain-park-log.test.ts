
import { mkdtempSync, rmSync } from "node:fs";
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
    get DRAIN_PARK_LOG_FILE() {
      return logPath;
    },
  };
});

// Imported after the mock so the module picks up the dynamic getters.
import {
  appendMintAbandoned,
  appendMintOutputs,
  appendMintPaid,
  appendMintPaymentAttempt,
  appendMintPaymentRejected,
  appendMintQuote,
  appendParked,
  appendSwapped,
  readOpenMintQuotes,
  readUnparked,
} from "../drain-park-log";

const IDS = { dvm_id: "dvm-fixture-1", credit_id: "c1", drain_id: "d1" };

function quote(overrides: Record<string, unknown> = {}): Parameters<typeof appendMintQuote>[0] {
  return {
    ...IDS,
    mint_url: "https://mint.example.com",
    quote_id: "q1",
    bolt11: "lnbc4u1pexample",
    invoice_msats: 400_400,
    face_sats: 392,
    reserve_sats: 8,
    expires_at: null,
    refund_pubkey: "02" + "cd".repeat(32),
    ...overrides,
  };
}

describe("drain-park-log — mint quote lifecycle", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dvmkit-drain-park-log-"));
    logPath = join(tmpDir, "drain-park.log");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports a fresh quote as open, with nothing paid or minted yet", () => {
    appendMintQuote(quote());
    const open = readOpenMintQuotes("dvm-fixture-1");
    expect(open).toHaveLength(1);
    expect(open[0].quote).toMatchObject({ quote_id: "q1", face_sats: 392 });
    expect(open[0].paid).toBeUndefined();
    expect(open[0].outputs).toBeUndefined();
  });

  it("carries how far the last run got, so recovery resumes rather than restarts", () => {
    appendMintQuote(quote());
    appendMintPaid({ ...IDS, quote_id: "q1", preimage: "ff".repeat(32), fees_paid_msats: 900 });
    appendMintOutputs({ ...IDS, quote_id: "q1", keyset_id: "009a1f293253e41e", outputs: [] });

    const [open] = readOpenMintQuotes("dvm-fixture-1");
    expect(open.paid).toMatchObject({ preimage: "ff".repeat(32), fees_paid_msats: 900 });
    expect(open.outputs).toMatchObject({ keyset_id: "009a1f293253e41e" });
  });

  it("carries only the latest attempt's definitive rejection", () => {
    appendMintQuote(quote());
    appendMintPaymentAttempt({ ...IDS, quote_id: "q1" });
    appendMintPaymentRejected({ ...IDS, quote_id: "q1", error_code: "INTERNAL" });

    expect(readOpenMintQuotes("dvm-fixture-1")[0].paymentRejected).toMatchObject({
      quote_id: "q1",
      error_code: "INTERNAL",
    });

    // Starting another attempt makes the earlier rejection stale. If this
    // attempt becomes unknown, recovery must freeze rather than retry again.
    appendMintPaymentAttempt({ ...IDS, quote_id: "q1" });
    expect(readOpenMintQuotes("dvm-fixture-1")[0].paymentRejected).toBeUndefined();
  });

  /**
   * `swapped` means the proofs are in hand and only the park is left, which
   * `readUnparked` already drives. Leaving the quote open too would send the
   * mint side round again against a quote it has already issued.
   */
  it("closes a quote once its proofs reach the park log", () => {
    appendMintQuote(quote());
    appendSwapped({ ...IDS, token: "cashuBjit", consumed_row_ids: [], keep_proofs: [] });
    expect(readOpenMintQuotes("dvm-fixture-1")).toEqual([]);
    expect(readUnparked("dvm-fixture-1")).toHaveLength(1);
  });

  it("closes a quote once the park commits", () => {
    appendMintQuote(quote());
    appendSwapped({ ...IDS, token: "cashuBjit", consumed_row_ids: [], keep_proofs: [] });
    appendParked(IDS);
    expect(readOpenMintQuotes("dvm-fixture-1")).toEqual([]);
    expect(readUnparked("dvm-fixture-1")).toEqual([]);
  });

  it("closes an abandoned quote, freeing its drain to quote again", () => {
    appendMintQuote(quote());
    appendMintAbandoned({ ...IDS, quote_id: "q1", reason: "quote_expired_unpaid" });
    expect(readOpenMintQuotes("dvm-fixture-1")).toEqual([]);
  });

  /**
   * The trap this exists to close: a drain that abandoned one quote and opened
   * another must not read the first one's payment as progress on the second.
   * Doing so would skip the payment the live quote actually needs.
   */
  it("never reads an earlier quote's payment as progress on a later one", () => {
    appendMintQuote(quote());
    appendMintPaid({ ...IDS, quote_id: "q1", preimage: "aa".repeat(32) });
    appendMintAbandoned({ ...IDS, quote_id: "q1", reason: "quote_expired_unpaid" });
    appendMintQuote(quote({ quote_id: "q2", bolt11: "lnbc4u1psecond" }));

    const [open] = readOpenMintQuotes("dvm-fixture-1");
    expect(open.quote.quote_id).toBe("q2");
    expect(open.paid).toBeUndefined();
  });

  it("never reads an earlier quote's rejection as permission to retry a later one", () => {
    appendMintQuote(quote());
    appendMintPaymentAttempt({ ...IDS, quote_id: "q1" });
    appendMintPaymentRejected({ ...IDS, quote_id: "q1", error_code: "INTERNAL" });
    appendMintAbandoned({ ...IDS, quote_id: "q1", reason: "quote_expired_unpaid" });
    appendMintQuote(quote({ quote_id: "q2", bolt11: "lnbc4u1psecond" }));

    expect(readOpenMintQuotes("dvm-fixture-1")[0].paymentRejected).toBeUndefined();
  });

  it("keeps the mint evidence on a swapped entry, so the park retry carries it", () => {
    appendSwapped({
      ...IDS,
      token: "cashuBjit",
      consumed_row_ids: [],
      keep_proofs: [],
      mint_evidence: {
        source: "jit_mint",
        mint_url: "https://mint.example.com",
        quote_id: "q1",
        face_sats: 392,
        reserve_sats: 8,
        invoice_msats: 400_400,
        routing_fee_msats: 1_100,
      },
    });
    expect(readUnparked("dvm-fixture-1")[0].mint_evidence).toMatchObject({ source: "jit_mint" });
  });

  it("scopes both reads to one DVM", () => {
    appendMintQuote(quote());
    appendMintQuote(quote({ dvm_id: "dvm-fixture-2", quote_id: "q-other" }));
    expect(readOpenMintQuotes("dvm-fixture-1")).toHaveLength(1);
    expect(readOpenMintQuotes("dvm-fixture-2")).toHaveLength(1);
  });
});

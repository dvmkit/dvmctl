import { describe, expect, it } from "vitest";

import { bolt11AmountMsats } from "../bolt11-amount";

// The data part is bech32, whose charset excludes `1` — every fixture below
// keeps that property so the separator is unambiguous, exactly as a real
// invoice does.
const DATA = "pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypdq";

describe("bolt11AmountMsats", () => {
  it("reads each multiplier", () => {
    expect(bolt11AmountMsats(`lnbc2500u1${DATA}`)).toBe(250_000_000);
    expect(bolt11AmountMsats(`lnbc20m1${DATA}`)).toBe(2_000_000_000);
    expect(bolt11AmountMsats(`lnbc9678785340p1${DATA}`)).toBe(967_878_534);
    expect(bolt11AmountMsats(`lnbc10n1${DATA}`)).toBe(1000);
  });

  it("reads a whole-BTC amount rather than swallowing the separator", () => {
    // `lnbc11` + separator `1`: the naive prefix match reads `111` BTC.
    expect(bolt11AmountMsats(`lnbc111${DATA}`)).toBe(11 * 1e11);
    expect(bolt11AmountMsats(`lnbc11${DATA}`)).toBe(1e11);
  });

  it("returns null for an amountless invoice", () => {
    // The one that matters on a money path: `1p…` must not read as 0 msat.
    expect(bolt11AmountMsats(`lnbc1${DATA}`)).toBeNull();
    expect(bolt11AmountMsats(`lntb1${DATA}`)).toBeNull();
  });

  it("handles the other network prefixes and case", () => {
    expect(bolt11AmountMsats(`lntb100n1${DATA}`)).toBe(10_000);
    expect(bolt11AmountMsats(`lnbcrt500n1${DATA}`)).toBe(50_000);
    expect(bolt11AmountMsats(`LNBC2500U1${DATA.toUpperCase()}`)).toBe(250_000_000);
    expect(bolt11AmountMsats(`  lnbc10n1${DATA}  `)).toBe(1000);
  });

  it("returns null for anything it cannot read", () => {
    expect(bolt11AmountMsats("")).toBeNull();
    expect(bolt11AmountMsats("not-an-invoice")).toBeNull();
    expect(bolt11AmountMsats("lnbc10n")).toBeNull();
    expect(bolt11AmountMsats(`lnxx10n1${DATA}`)).toBeNull();
    expect(bolt11AmountMsats(`lnbc10x1${DATA}`)).toBeNull();
  });
});

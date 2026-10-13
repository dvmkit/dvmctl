import { describe, expect, it } from "vitest";

import { parseDurationMs } from "../duration";

describe("parseDurationMs", () => {
  it("parses each unit", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDurationMs("  10m ")).toBe(600_000);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "5", "m", "5x", "1.5h", "-5m", "5 m", "5min", "abc"]) {
      expect(() => parseDurationMs(bad)).toThrow();
    }
  });
});

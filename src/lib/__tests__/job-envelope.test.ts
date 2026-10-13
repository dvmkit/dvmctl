import { describe, expect, it } from "vitest";

import { buildJobEnvelope } from "../job-envelope";

describe("buildJobEnvelope", () => {
  it("builds envelope from input", () => {
    const env = buildJobEnvelope({ input: "hello" });
    expect(env.input).toBe("hello");
    expect(env.params).toBeUndefined();
    expect(env.outputType).toBeUndefined();
  });

  it("parses key=value param strings", () => {
    const env = buildJobEnvelope({
      input: "hi",
      params: ["lang=en", "foo=bar=baz"],
    });
    expect(env.params).toEqual([
      ["lang", "en"],
      ["foo", "bar=baz"],
    ]);
  });

  it("includes outputType when provided", () => {
    const env = buildJobEnvelope({ input: "hi", outputType: "text/plain" });
    expect(env.outputType).toBe("text/plain");
  });

  it("includes bidMsats when provided", () => {
    const env = buildJobEnvelope({ input: "hi", bidMsats: 5000 });
    expect(env.bidMsats).toBe(5000);
  });

  it("includes data when provided", () => {
    const env = buildJobEnvelope({ input: "hi", data: { duration_seconds: 120 } });
    expect(env.data).toEqual({ duration_seconds: 120 });
  });

  it("handles missing optional fields", () => {
    const env = buildJobEnvelope({ input: "text" });
    expect(env.params).toBeUndefined();
    expect(env.data).toBeUndefined();
    expect(env.outputType).toBeUndefined();
    expect(env.bidMsats).toBeUndefined();
  });

  it("includes bidMsats of 0", () => {
    const env = buildJobEnvelope({ input: "hi", bidMsats: 0 });
    expect(env.bidMsats).toBe(0);
  });

  // ── Structured `data` synthesised from --param ─────────────────────────

  it("synthesises data from --param with bool / number / string coercion", () => {
    const env = buildJobEnvelope({
      input: "",
      params: ["url=https://example.com", "format=markdown", "screenshot=true", "wait_for_ms=500"],
    });
    expect(env.data).toEqual({
      url: "https://example.com",
      format: "markdown",
      screenshot: true,
      wait_for_ms: 500,
    });
  });

  it("coerces 'false' to boolean false", () => {
    const env = buildJobEnvelope({ input: "", params: ["screenshot=false"] });
    expect(env.data).toEqual({ screenshot: false });
  });

  it("coerces decimals to numbers", () => {
    const env = buildJobEnvelope({ input: "", params: ["temperature=0.7"] });
    expect(env.data).toEqual({ temperature: 0.7 });
  });

  it("preserves leading-zero strings as strings", () => {
    const env = buildJobEnvelope({ input: "", params: ["zip=01234"] });
    expect(env.data).toEqual({ zip: "01234" });
  });

  it("rejects non-canonical numeric strings (preserves them as strings)", () => {
    const env = buildJobEnvelope({
      input: "",
      params: ["a=1.", "b=.5", "c=1e3", "d=NaN"],
    });
    expect(env.data).toEqual({ a: "1.", b: ".5", c: "1e3", d: "NaN" });
  });

  it("groups repeated keys into an array, coercing each value independently", () => {
    const env = buildJobEnvelope({
      input: "",
      params: ["tag=a", "tag=b", "tag=42", "tag=true"],
    });
    expect(env.data).toEqual({ tag: ["a", "b", 42, true] });
  });

  it("first repeat upgrades scalar to array", () => {
    const env = buildJobEnvelope({ input: "", params: ["x=1", "x=2"] });
    expect(env.data).toEqual({ x: [1, 2] });
  });

  it("explicit --data takes precedence over --param", () => {
    const env = buildJobEnvelope({
      input: "",
      params: ["url=https://from-param.com"],
      data: { url: "https://from-data.com" },
    });
    expect(env.data).toEqual({ url: "https://from-data.com" });
  });

  it("does not include data when neither --param nor --data is provided", () => {
    const env = buildJobEnvelope({ input: "hi" });
    expect(env.data).toBeUndefined();
  });

  it("handles bare key (no =) as empty string", () => {
    const env = buildJobEnvelope({ input: "", params: ["flag"] });
    expect(env.data).toEqual({ flag: "" });
  });

  it("does not pollute Object.prototype via --param __proto__=...", () => {
    const env = buildJobEnvelope({ input: "", params: ["__proto__=evil"] });
    // The key lands on the data map as a plain own-property (null-prototype
    // object) — never reaches Object.prototype's __proto__ setter.
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("evil");
    expect(Object.getPrototypeOf(env.data)).toBeNull();
    expect(JSON.stringify(env.data)).toBe('{"__proto__":"evil"}');
  });

  it("preserves the params array on the envelope alongside data (back-compat)", () => {
    const env = buildJobEnvelope({
      input: "",
      params: ["url=https://example.com", "format=markdown"],
    });
    expect(env.params).toEqual([
      ["url", "https://example.com"],
      ["format", "markdown"],
    ]);
    expect(env.data).toEqual({ url: "https://example.com", format: "markdown" });
  });
});

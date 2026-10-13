import { describe, expect, it } from "vitest";
import { parseFeatures, FeatureManifestError } from "./capability-manifest";
describe("parseFeatures", () => {
  it("returns an empty manifest for undefined / null", () => {
    expect(parseFeatures(undefined)).toEqual({});
    expect(parseFeatures(null)).toEqual({});
  });

  it("parses requires and requiresAny", () => {
    const raw = {
      natural_language: { requires: ["ANTHROPIC_API_KEY"] },
      polish: { requiresAny: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
    };
    expect(parseFeatures(raw)).toEqual(raw);
  });

  it("rejects a non-object manifest", () => {
    expect(() => parseFeatures(["nope"])).toThrow(FeatureManifestError);
    expect(() => parseFeatures("nope")).toThrow(FeatureManifestError);
  });

  it("rejects a feature with neither requires nor requiresAny", () => {
    expect(() => parseFeatures({ premium: {} })).toThrow(/at least one key/);
  });

  it("rejects a non-array requires", () => {
    expect(() => parseFeatures({ premium: { requires: "ASSEMBLYAI_API_KEY" } })).toThrow(
      /must be an array/
    );
  });

  it("rejects a non-uppercase env name", () => {
    expect(() => parseFeatures({ premium: { requires: ["assemblyai_api_key"] } })).toThrow(
      /uppercase env-var names/
    );
  });
});

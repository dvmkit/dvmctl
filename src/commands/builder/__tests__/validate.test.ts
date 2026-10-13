import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import { DvmError } from "@dvmkit/sdk/internal";

import { info, json } from "../../../shared/output";
import { validate, validateManifest } from "../validate";

const sdkEntry = fileURLToPath(import.meta.resolve("@dvmkit/sdk"));

function writeHandler(dir: string, overrides = ""): void {
  writeFileSync(
    join(dir, "handler.js"),
    `const { z } = require(${JSON.stringify(sdkEntry)});
    module.exports = {
      config: {
        name: "Hand written",
        capability: "echo",
        tags: ["text"],
        input: z.object({ text: z.string() }),
        example: { text: "hello" },
        price: "$0.01",
        onJob() {},
        ${overrides}
      }
    };`,
    "utf-8"
  );
}

describe("validateManifest", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dvmctl-validate-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a summary for a well-formed manifest", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "Scribe",
        dvmkit: {
          memory_mb: 1024,
          cpu_kind: "shared",
          min_machines_running: 0,
          max_machines: 3,
          inheritSecrets: ["GROQ_*", "RATE_FAST_PER_MIN_USD"],
        },
      }),
      "utf-8"
    );

    const summary = validateManifest(dir);

    expect(summary.slug).toBe("scribe");
    expect(summary.name).toBe("Scribe");
    expect(summary.vmConfig).toEqual({
      memoryMb: 1024,
      cpuKind: "shared",
      minMachinesRunning: 0,
      maxMachines: 3,
    });
    expect(summary.inheritSecrets).toEqual(["GROQ_*", "RATE_FAST_PER_MIN_USD"]);
  });

  it("accepts a manifest with no dvmkit field", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bare-dvm" }), "utf-8");

    const summary = validateManifest(dir);

    expect(summary.slug).toBe("bare-dvm");
    expect(summary.vmConfig).toBeNull();
    expect(summary.inheritSecrets).toEqual([]);
  });

  // Compatibility with the legacy `RATE_*_PER_MIN_USD` pattern with a
  // mid-string `*` sat broken on master for months because nothing validated
  // the field until `dvmctl deploy` was invoked.
  it("rejects mid-string `*` in inheritSecrets patterns", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "scribe",
        dvmkit: { inheritSecrets: ["RATE_*_PER_MIN_USD"] },
      }),
      "utf-8"
    );

    let thrown: unknown;
    try {
      validateManifest(dir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DvmError);
    const err = thrown as DvmError;
    expect(err.code).toBe("invalid_dvmkit_config");
    expect(err.message).toContain("RATE_*_PER_MIN_USD");
  });

  it("rejects out-of-range memory_mb", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "tiny", dvmkit: { memory_mb: 64 } }),
      "utf-8"
    );

    let thrown: unknown;
    try {
      validateManifest(dir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DvmError);
    const err = thrown as DvmError;
    expect(err.code).toBe("invalid_dvmkit_config");
    expect(err.message).toMatch(/memory_mb/);
  });

  it("rejects bare `*` in inheritSecrets", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "greedy", dvmkit: { inheritSecrets: ["*"] } }),
      "utf-8"
    );

    expect(() => validateManifest(dir)).toThrow(/bare `\*`/);
  });

  it("throws when package.json is missing", () => {
    let thrown: unknown;
    try {
      validateManifest(dir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DvmError);
    const err = thrown as DvmError;
    expect(err.code).toBe("missing_package_json");
  });
});

describe("validate command", () => {
  let dir: string;
  const jsonMock = vi.mocked(json);
  const infoMock = vi.mocked(info);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dvmctl-validate-cmd-"));
    writeHandler(dir);
    jsonMock.mockClear();
    infoMock.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits a JSON ok summary on success", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "cast",
        dvmkit: { memory_mb: 256, cpu_kind: "shared", inheritSecrets: ["ELEVENLABS_*"] },
      }),
      "utf-8"
    );

    await validate({}, dir);

    expect(jsonMock).toHaveBeenCalledTimes(1);
    const payload = jsonMock.mock.calls[0]?.[0];
    const out = JSON.stringify(payload);
    expect(out).toContain('"status":"ok"');
    expect(out).toContain('"slug":"cast"');
    expect(out).toContain('"name":"cast"');
    expect(out).toContain('"inherit_secrets":["ELEVENLABS_*"]');
  });

  it("emits a human-readable summary with --human", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "cast", dvmkit: { memory_mb: 256 } }),
      "utf-8"
    );

    await validate({ human: true }, dir);

    const infoLines = infoMock.mock.calls.map((c) => c[0]);
    expect(infoLines.some((line) => line.includes("Validating cast"))).toBe(true);
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it("propagates parser errors verbatim from the platform", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "scribe", dvmkit: { inheritSecrets: ["RATE_*_PER_MIN_USD"] } }),
      "utf-8"
    );

    await expect(validate({}, dir)).rejects.toThrow(/RATE_\*_PER_MIN_USD/);
  });

  it("rejects a handler capability without an input schema", async () => {
    writeFileSync(
      join(dir, "handler.js"),
      `module.exports = { config: { name: "Bare", capability: "echo", tags: ["text"], example: { text: "hello" }, price: "$0.01", onJob() {} } };`,
      "utf-8"
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bare" }), "utf-8");

    await expect(validate({}, dir)).rejects.toMatchObject({ code: "invalid_input_schema" });
  });

  it("rejects an object that only resembles a schema", async () => {
    writeFileSync(
      join(dir, "handler.js"),
      `module.exports = { config: { name: "Fake", capability: "echo", tags: ["text"], input: { type: "object" }, example: { text: "hello" }, price: "$0.01", onJob() {} } };`,
      "utf-8"
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-schema" }), "utf-8");

    await expect(validate({}, dir)).rejects.toMatchObject({ code: "invalid_input_schema" });
  });

  it("rejects malformed tags with a specific error", async () => {
    writeHandler(dir, `tags: ["Bad Tag"],`);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "bad-tag" }), "utf-8");

    await expect(validate({}, dir)).rejects.toMatchObject({ code: "invalid_tag" });
  });

  it("rejects non-string tags without coercion", async () => {
    writeHandler(dir, `tags: [123],`);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "numeric-tag" }), "utf-8");

    await expect(validate({}, dir)).rejects.toMatchObject({ code: "invalid_tag" });
  });
});

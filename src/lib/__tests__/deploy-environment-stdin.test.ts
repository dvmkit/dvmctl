import { PassThrough } from "node:stream";

import { DvmError } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readDeployEnvironmentStdin, redactDeployEnvironmentError } from "../deploy-environment-stdin.ts";

function input() {
  const stream = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
  return stream;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("deploy environment error redaction", () => {
  it("redacts the supplied network while preserving a longer network in the hint", () => {
    const error = new DvmError(
      "invalid_deployment",
      "Unsupported network eip155:8453.",
      "Set DVMKIT_X402_NETWORK=eip155:84532."
    );

    expect(redactDeployEnvironmentError(error, { DVMKIT_X402_NETWORK: "eip155:8453" })).toMatchObject({
      message: "Unsupported network [redacted].",
      hint: "Set DVMKIT_X402_NETWORK=eip155:84532.",
    });
  });

  it("matches literal eight-character values only at token boundaries", () => {
    const error = new DvmError("invalid_deployment", "Values: (a.b$[c]d), éa.b$[c]d, a.b$[c]d9, axb$[c]d.");

    expect(redactDeployEnvironmentError(error, { DVMKIT_MODE: "a.b$[c]d" })).toMatchObject({
      message: "Values: ([redacted]), éa.b$[c]d, a.b$[c]d9, axb$[c]d.",
    });
  });

  it("preserves a short boolean value under an ordinary key", () => {
    const error = new DvmError("invalid_deployment", "Enable DVMKIT_FAIL_FAST=true before retrying.");

    expect(redactDeployEnvironmentError(error, { DVMKIT_FAIL_FAST: "true", EMPTY_SECRET: "" })).toMatchObject({
      message: "Enable DVMKIT_FAIL_FAST=true before retrying.",
    });
  });

  it("redacts a short value from a secret key even when an ordinary key has the same value", () => {
    const error = new DvmError("invalid_deployment", "Provider rejected the value 'abc123'.");

    expect(redactDeployEnvironmentError(error, { DVMKIT_MODE: "abc123", provider_password: "abc123" })).toMatchObject({
      message: "Provider rejected the value '[redacted]'.",
    });
  });

  it("redacts overlapping values without reprocessing the replacement", () => {
    const error = new DvmError("invalid_deployment", "Provider rejected (left.middle-right).");

    expect(redactDeployEnvironmentError(error, {
      FIRST_TOKEN: "left.middle",
      SECOND_TOKEN: "middle-right",
      THIRD_TOKEN: "redacted",
    })).toMatchObject({ message: "Provider rejected ([redacted])." });
  });

  it("redacts a literal value that fills the stdin allowance", () => {
    const secret = "+".repeat(65_524);
    const error = new DvmError("invalid_deployment", `Provider rejected (${secret}).`);

    expect(redactDeployEnvironmentError(error, { TOKEN: secret })).toMatchObject({
      message: "Provider rejected ([redacted]).",
    });
  });
});

describe("deploy environment input", () => {
  it("preserves string values across split UTF-8 chunks, including empty values and prototype keys", async () => {
    const stream = input();
    const result = readDeployEnvironmentStdin();
    const bytes = Buffer.from('{"TOKEN":"secret-\u00e9","EMPTY":"","__proto__":"literal"}');
    const split = bytes.indexOf(0xc3) + 1;
    stream.write(bytes.subarray(0, split));
    stream.end(bytes.subarray(split));
    await expect(result).resolves.toEqual({ TOKEN: "secret-é", EMPTY: "", ["__proto__"]: "literal" });
  });

  it.each(["", "  \n", '{"TOKEN":"hidden"', "null", "[]", '"hidden"', "1", '{"TOKEN":null}', '{"TOKEN":1}', '{"TOKEN":{"secret":"hidden"}}', '{"TOKEN":true}'])("rejects invalid input without echoing its contents: %s", async (text) => {
    const stream = input();
    const result = readDeployEnvironmentStdin();
    stream.end(text);
    const error = await result.catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_env_stdin" });
    expect(String(error)).not.toContain("hidden");
    expect(JSON.stringify(error)).not.toContain("hidden");
  });

  it("accepts exactly 64 KiB and rejects more by UTF-8 byte count", async () => {
    const stream = input();
    const text = JSON.stringify({ TOKEN: "é".repeat((65_536 - 12) / 2) });
    expect(Buffer.byteLength(text)).toBe(65_536);
    const result = readDeployEnvironmentStdin();
    stream.end(text);
    await expect(result).resolves.toHaveProperty("TOKEN");
    const oversized = input();
    const rejection = readDeployEnvironmentStdin();
    oversized.write(Buffer.from(JSON.stringify({ TOKEN: "é".repeat(32_768) })));
    await expect(rejection).rejects.toMatchObject({ code: "invalid_env_stdin", message: expect.stringContaining("64 KiB") });
    expect(oversized.isPaused()).toBe(true);
  });

  it("rejects terminal input before reading", async () => {
    const stream = input();
    Object.assign(stream, { isTTY: true });
    await expect(readDeployEnvironmentStdin()).rejects.toMatchObject({ code: "invalid_env_stdin", message: expect.stringContaining("piped input") });
    expect(stream.listenerCount("data")).toBe(0);
  });

  it("bounds an open pipe that never supplies input", async () => {
    vi.useFakeTimers();
    const stream = input();
    const result = readDeployEnvironmentStdin();
    const check = expect(result).rejects.toMatchObject({ code: "invalid_env_stdin", message: expect.stringContaining("5 seconds") });
    await vi.advanceTimersByTimeAsync(5_000);
    await check;
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.isPaused()).toBe(true);
  });

  it("rejects early stream closure and redacts read failures", async () => {
    const stream = input();
    const result = readDeployEnvironmentStdin();
    const check = expect(result).rejects.toMatchObject({ code: "invalid_env_stdin", message: "Could not read --env-stdin input." });
    stream.destroy(new Error("hidden-secret"));
    await check;
    const closed = input();
    const incomplete = readDeployEnvironmentStdin();
    const closedCheck = expect(incomplete).rejects.toMatchObject({ code: "invalid_env_stdin" });
    closed.destroy();
    await closedCheck;
  });
});

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readDeployEnvironmentStdin } from "../deploy-environment-stdin.ts";

function input() {
  const stream = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stream as unknown as typeof process.stdin);
  return stream;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

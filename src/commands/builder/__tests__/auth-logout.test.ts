import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthToken, saveAuthToken } from "../../../lib/platform";
import { json } from "../../../shared/output";
import { auth } from "../auth";

vi.mock("../../../shared/output", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/output")>()),
  json: vi.fn(),
}));

const stored = { token: "dvmk_stored_test_key", account: "builder@example.test" };
const matchingKeys = { keys: [{ id: "stored-key", key_prefix: "dvmk_stored" }], count: 1, limit: 10 };

// Model a transport waiting for headers and a stream waiting for the rest of its
// body. Both react to the same fetch signal, as the native transport does.
function stalledRequest(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function stalledBody(signal: AbortSignal | null | undefined, status: number): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  }), { status });
}

describe("logout revocation deadline", () => {
  let directory: string;

  beforeEach(() => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), "dvmctl-logout-"));
    vi.stubEnv("DVMCTL_CONFIG_DIR", directory);
    saveAuthToken(stored);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(["list request", "list body", "delete request", "delete error body"])(
    "cancels a stalled %s and clears stored auth after five seconds",
    async (stage) => {
      const signals: (AbortSignal | null | undefined)[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
        const signal = init?.signal;
        signals.push(signal);
        if (signals.length === 1 && stage.startsWith("delete")) return Response.json(matchingKeys);
        return stage.endsWith("request") ? stalledRequest(signal) : stalledBody(signal, stage === "list body" ? 200 : 503);
      });
      vi.stubGlobal("fetch", fetchMock);
      let completed = false;
      const result = auth({ logout: true }).then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(completed).toBe(false);
      expect(loadAuthToken()).toEqual(stored);
      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toBe(true);
      await result;
      expect(loadAuthToken()).toBeNull();
      expect(json).toHaveBeenCalledWith({ status: "logged_out", revoked: false, hint: expect.stringContaining("dvmctl api-keys revoke <id>") }, { feedback: false });
      expect(fetchMock).toHaveBeenCalledTimes(stage.startsWith("delete") ? 2 : 1);
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
      expect(new Set(signals).size).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("shares one deadline across a slow list and a stalled delete", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve(Response.json(matchingKeys)), 4000);
      }))
      .mockImplementationOnce((_input, init) => stalledRequest(init!.signal!));
    vi.stubGlobal("fetch", fetchMock);
    let completed = false;
    const result = auth({ logout: true }).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toBe(true);
    await result;
    expect(loadAuthToken()).toBeNull();
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ revoked: false }), { feedback: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after successful revocation", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(matchingKeys))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await auth({ logout: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loadAuthToken()).toBeNull();
    expect(json).toHaveBeenCalledWith({ status: "logged_out", revoked: true }, { feedback: false });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
  });
});

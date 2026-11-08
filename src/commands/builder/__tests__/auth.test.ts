import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import type * as NodeOs from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  clearAuthToken: vi.fn(),
  loadAuthToken: vi.fn(() => null),
  resolveAuth: vi.fn(() => null),
  saveAuthToken: vi.fn(),
}));

vi.mock("../../../shared/output", () => ({ progress: vi.fn() }));

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, hostname: () => "test-host" };
});

import {
  CLI_AUTH_MAX_POLL_ATTEMPTS,
  CLI_AUTH_POLL_INTERVAL_MS,
} from "../../../lib/cli-auth";
import * as platform from "../../../lib/platform";
import { progress } from "../../../shared/output";
import { auth } from "../auth";

const mockPlatform = vi.mocked(platform);

describe("dvmctl auth login", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // Pin jitter to 0 so the poll-window math in the tests is exact.
    vi.spyOn(Math, "random").mockReturnValue(0);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // process.exit is sentinel-throwing so tests can catch it
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`__exit(${code ?? 0})__`);
    }) as unknown as ReturnType<typeof vi.spyOn>;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.mocked(progress).mockClear();
    mockPlatform.loadAuthToken.mockReturnValue(null);
    mockPlatform.saveAuthToken.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns early if already authenticated", async () => {
    mockPlatform.loadAuthToken.mockReturnValue({
      token: "dvmk_existing",
      account: "existing@example.com",
    });

    await auth({ human: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockPlatform.saveAuthToken).not.toHaveBeenCalled();
  });

  it("skips 404 responses and keeps polling until a token arrives", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "dvmk_eventually", account: "late@example.com" }),
      });

    const result = auth({ human: true });
    await vi.advanceTimersByTimeAsync(3 * CLI_AUTH_POLL_INTERVAL_MS);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockPlatform.saveAuthToken).toHaveBeenCalledWith({
      token: "dvmk_eventually",
      account: "late@example.com",
    });
  });

  it("swallows transient network errors and keeps polling", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "dvmk_after_blip", account: "recovered@example.com" }),
    });

    const result = auth({ human: true });
    await vi.advanceTimersByTimeAsync(2 * CLI_AUTH_POLL_INTERVAL_MS);
    await result;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockPlatform.saveAuthToken).toHaveBeenCalledWith({
      token: "dvmk_after_blip",
      account: "recovered@example.com",
    });
  });

  it("swallows malformed JSON and keeps polling", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("unexpected end of JSON");
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ token: "dvmk_after_garbage", account: "ok@example.com" }),
      });

    const result = auth({ human: true });
    await vi.advanceTimersByTimeAsync(2 * CLI_AUTH_POLL_INTERVAL_MS);
    await result;

    expect(mockPlatform.saveAuthToken).toHaveBeenCalledWith({
      token: "dvmk_after_garbage",
      account: "ok@example.com",
    });
  });

  it.each([true, false])("supports open signup and labels the session code before browser launch (human=%s)", async (human) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "dvmk_newkey", account: "alice@example.com" }),
    });
    const browser = vi.mocked(exec);
    browser.mockClear();
    let outputBeforeBrowser: unknown;
    browser.mockImplementationOnce(() => {
      outputBeforeBrowser = human
        ? vi.mocked(console.log).mock.calls.map(([message]) => message)
        : vi.mocked(progress).mock.calls.map(([event]) => event);
      return undefined as never;
    });
    const result = auth({ human });
    await vi.advanceTimersByTimeAsync(CLI_AUTH_POLL_INTERVAL_MS);
    await result;
    expect(JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(progress).mock.calls,
    ])).not.toMatch(/closed beta|invit(?:e|ed)|waitlist/i);
    if (human) {
      expect(outputBeforeBrowser).toEqual([
        "\nOpening browser to authenticate...",
        expect.any(String),
        expect.stringContaining("/cli-auth?session="),
        expect.stringContaining("Session code:"),
      ]);
    } else {
      expect(outputBeforeBrowser).toEqual([
        {
          status: "opening_browser",
          url: expect.stringMatching(/^https:\/\/dvmkit.com\/cli-auth\?session=/),
          fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
          display: expect.any(String),
          hint: expect.any(String),
        },
      ]);
    }
    expect(browser).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) },
    });
    const authorization = (fetchMock.mock.calls[0]?.[1] as {
      headers: { Authorization: string };
    }).headers.Authorization;
    const browserCommand = browser.mock.calls[0]?.[0] as string;
    const browserUrl = new URL(browserCommand.match(/"(https:[^"]+)"/)?.[1] ?? "");
    const advertisedHash = browserUrl.searchParams.get("hash");
    expect(createHash("sha256").update(authorization.slice("Bearer ".length)).digest("hex"))
      .toBe(advertisedHash);
    const sessionCode = browserUrl.searchParams.get("session")!.slice(0, 12);
    if (human) {
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Session code: ${sessionCode}`));
    } else {
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({
        fingerprint: sessionCode,
        display: expect.stringContaining(`Session code: ${sessionCode}`),
      }));
    }
    if (!human) expect(console.log).toHaveBeenCalledTimes(1);
    expect(mockPlatform.saveAuthToken).toHaveBeenCalledWith({
      token: "dvmk_newkey",
      account: "alice@example.com",
    });
  });

  it.each([true, false])("cancellation preserves its shape without claiming signup is restricted (human=%s)", async (human) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ cancelled: true }),
    });
    const result = auth({ human }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CLI_AUTH_POLL_INTERVAL_MS);
    expect(await result).toEqual(new Error("__exit(1)__"));
    if (human) {
      expect(console.log).toHaveBeenCalledWith("\nSign-in cancelled.");
      expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining("dvmctl auth"));
    } else {
      expect(JSON.parse(vi.mocked(console.log).mock.lastCall?.[0] as string)).toEqual({
        authenticated: false,
        cancelled: true,
        display: "Sign-in cancelled.",
        hint: expect.stringContaining("dvmctl auth"),
      });
    }
    expect(JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(progress).mock.calls,
    ])).not.toMatch(/closed beta|invit(?:e|ed)|waitlist/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockPlatform.saveAuthToken).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])(
    "auth timeout preserves retry and API key guidance without signup restrictions (human=%s)",
    async (human) => {
      fetchMock.mockResolvedValue({ ok: false, status: 404 });
      const result = auth({ human }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CLI_AUTH_MAX_POLL_ATTEMPTS * CLI_AUTH_POLL_INTERVAL_MS);
      expect(await result).toEqual(new Error("__exit(1)__"));
      if (human) {
        expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Authentication timed out.*Try again.*DVMKIT_API_KEY/s));
      } else {
        expect(JSON.parse(vi.mocked(console.log).mock.lastCall?.[0] as string)).toEqual({
          authenticated: false,
          timed_out: true,
          display: expect.stringMatching(/Authentication timed out.*Try again.*DVMKIT_API_KEY/s),
          hint: expect.stringMatching(/Try again.*DVMKIT_API_KEY/s),
        });
      }
      expect(JSON.stringify([
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
        ...vi.mocked(progress).mock.calls,
      ])).not.toMatch(/closed beta|invit(?:e|ed)|waitlist/i);
      expect(fetchMock).toHaveBeenCalledTimes(CLI_AUTH_MAX_POLL_ATTEMPTS);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockPlatform.saveAuthToken).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});

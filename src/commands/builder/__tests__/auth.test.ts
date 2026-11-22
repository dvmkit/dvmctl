import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as NodeOs from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  clearAuthToken: vi.fn(),
  loadAuthToken: vi.fn(() => null),
  resolveAuth: vi.fn(() => null),
  saveAuthToken: vi.fn(),
}));

vi.mock("../../../lib/platform-client", () => ({ listApiKeys: vi.fn(), deleteApiKey: vi.fn() }));

vi.mock("../../../shared/output", () => ({ json: vi.fn(), progress: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, hostname: () => "test-host" };
});

import {
  CLI_AUTH_TTL_MS,
  CLI_AUTH_MAX_POLL_ATTEMPTS,
  CLI_AUTH_POLL_INTERVAL_MS,
} from "../../../lib/cli-auth";
import * as platform from "../../../lib/platform";
import { listApiKeys, deleteApiKey } from "../../../lib/platform-client";
import { json, progress } from "../../../shared/output";
import { auth } from "../auth";

const mockPlatform = vi.mocked(platform);

function browserProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), { unref: vi.fn() }) as unknown as ChildProcess;
}

function successfulBrowser(): ChildProcess {
  const child = browserProcess();
  void Promise.resolve().then(() => {
    child.emit("spawn");
    child.emit("exit", 0, null);
  });
  return child;
}

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
    vi.mocked(spawn).mockReset().mockImplementation(successfulBrowser);
    vi.stubEnv("BROWSER", "");
    vi.mocked(listApiKeys).mockReset();
    vi.mocked(deleteApiKey).mockReset();
    mockPlatform.clearAuthToken.mockClear();
    // A browser launch is attempted only where a display exists; pin it so the
    // suite behaves the same on a headless Linux CI host.
    vi.stubEnv("DISPLAY", ":0");
    mockPlatform.loadAuthToken.mockReturnValue(null);
    mockPlatform.saveAuthToken.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it.each([true, false])("supports open signup and preserves the session code and verifier binding (human=%s)", async (human) => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ token: "dvmk_newkey", account: "alice@example.com" }),
    });
    const browser = vi.mocked(spawn);
    browser.mockClear();
    let outputBeforeBrowser: unknown;
    browser.mockImplementationOnce(() => {
      outputBeforeBrowser = human
        ? vi.mocked(console.log).mock.calls.map(([message]) => message)
        : vi.mocked(progress).mock.calls.map(([event]) => event);
      return successfulBrowser();
    });
    const startedAt = Date.now();
    const result = auth({ human });
    await vi.advanceTimersByTimeAsync(CLI_AUTH_POLL_INTERVAL_MS);
    await result;
    expect(JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(progress).mock.calls,
      ...vi.mocked(json).mock.calls,
    ])).not.toMatch(/closed beta|invit(?:e|ed)|waitlist/i);
    if (human) {
      expect(outputBeforeBrowser).toEqual([
        "\nOpening browser to authenticate...",
        expect.any(String),
        expect.stringContaining("/cli-auth?session="),
        expect.stringContaining("Session code:"),
      ]);
    } else {
      expect(outputBeforeBrowser).toEqual([]);
      expect(progress).toHaveBeenCalledWith({
        status: "awaiting_human",
        url: expect.stringMatching(/^https:\/\/dvmkit.com\/cli-auth\?session=/),
        fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
        expires_at: new Date(startedAt + CLI_AUTH_TTL_MS).toISOString(),
        browser_opened: true,
        instruction: expect.any(String),
        display: expect.any(String),
        hint: expect.any(String),
      });
    }
    expect(browser).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) },
    });
    const authorization = (fetchMock.mock.calls[0]?.[1] as {
      headers: { Authorization: string };
    }).headers.Authorization;
    const browserUrl = new URL(browser.mock.calls[0]![1]!.at(-1)!);
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
    if (!human) {
      expect(console.log).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalledTimes(1);
      expect(json).toHaveBeenCalledWith({ authenticated: true, account: "alice@example.com" }, { feedback: false });
    }
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
      expect(json).toHaveBeenCalledWith({
        authenticated: false,
        cancelled: true,
        display: "Sign-in cancelled.",
        hint: expect.stringContaining("dvmctl auth"),
      }, { feedback: false });
    }
    expect(JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(progress).mock.calls,
      ...vi.mocked(json).mock.calls,
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
        expect(json).toHaveBeenCalledWith({
          authenticated: false,
          timed_out: true,
          display: expect.stringMatching(/Authentication timed out.*Try again.*DVMKIT_API_KEY/s),
          hint: expect.stringMatching(/Try again.*DVMKIT_API_KEY/s),
        }, { feedback: false });
      }
      expect(JSON.stringify([
        ...vi.mocked(console.log).mock.calls,
        ...vi.mocked(console.error).mock.calls,
        ...vi.mocked(progress).mock.calls,
        ...vi.mocked(json).mock.calls,
      ])).not.toMatch(/closed beta|invit(?:e|ed)|waitlist/i);
      expect(fetchMock).toHaveBeenCalledTimes(CLI_AUTH_MAX_POLL_ATTEMPTS);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockPlatform.saveAuthToken).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  describe("telling the agent to relay the link", () => {
    const approved = {
      ok: true,
      status: 200,
      json: async () => ({ token: "dvmk_newkey", account: "alice@example.com" }),
    };

    let startedAt = 0;

    async function run(human: boolean, platformName?: string): Promise<void> {
      startedAt = Date.now();
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      if (platformName) Object.defineProperty(process, "platform", { value: platformName });
      try {
        fetchMock.mockResolvedValueOnce(approved);
        const result = auth({ human });
        await vi.advanceTimersByTimeAsync(CLI_AUTH_POLL_INTERVAL_MS);
        await result;
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    }

    function events(): Array<Record<string, unknown>> {
      return vi.mocked(progress).mock.calls.map(([event]) => event as Record<string, unknown>);
    }

    function failBrowserLaunch(): void {
      vi.mocked(spawn).mockImplementation(() => {
        const child = browserProcess();
        void Promise.resolve().then(() => child.emit("error", new Error("not found")));
        return child;
      });
    }

    it("emits awaiting_human with the link, code, expiry and both routes, and no secret, when a browser opens", async () => {
      await run(false);

      expect(events()).toHaveLength(1);
      const event = events()[0]!;
      expect(event).toMatchObject({ status: "awaiting_human", browser_opened: true });
      expect(Date.parse(event.expires_at as string)).toBe(startedAt + CLI_AUTH_TTL_MS);
      expect(event.instruction).toContain(event.url);
      expect(event.instruction).toContain(event.fingerprint);
      expect(event.instruction).toMatch(/any device/);
      expect(event.instruction).toContain("DVMKIT_API_KEY");
      expect(event.instruction).toContain("https://dvmkit.com/docs/cli-auth.md");
      const headers = (fetchMock.mock.calls[0]?.[1] as { headers: { Authorization: string } }).headers;
      const verifier = headers.Authorization.slice("Bearer ".length);
      expect(JSON.stringify(events())).not.toContain(verifier);
    });

    it("reports a browser that fails to launch (asynchronously) and still asks for a relay", async () => {
      vi.stubEnv("BROWSER", "missing-browser");
      failBrowserLaunch();
      await run(false);

      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        status: "awaiting_human",
        browser_opened: false,
        display: expect.stringMatching(/could not open a browser.*relayed/i),
        instruction: expect.stringContaining("Send them this link"),
      });
    });

    it("says so in human mode when the browser fails to launch", async () => {
      failBrowserLaunch();
      await run(true);

      expect(vi.mocked(console.log).mock.calls.join("\n")).toMatch(/could not open a browser/i);
    });

    it("does not claim to open a browser on a headless Linux host (JSON)", async () => {
      vi.stubEnv("DISPLAY", "");
      vi.stubEnv("WAYLAND_DISPLAY", "");
      await run(false, "linux");

      expect(spawn).not.toHaveBeenCalled();
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        status: "awaiting_human",
        browser_opened: false,
        display: expect.stringMatching(/could not open a browser.*relayed/i),
        instruction: expect.stringContaining("Send them this link"),
      });
      expect(JSON.stringify(events())).not.toMatch(/opening browser/i);
    });

    it("prints the relay instruction instead of 'Opening browser' on a headless Linux host (human)", async () => {
      vi.stubEnv("DISPLAY", "");
      vi.stubEnv("WAYLAND_DISPLAY", "");
      await run(true, "linux");

      const output = vi.mocked(console.log).mock.calls.join("\n");
      expect(spawn).not.toHaveBeenCalled();
      expect(output).not.toMatch(/opening browser/i);
      expect(output).toMatch(/could not open a browser/i);
      expect(output).toContain("Send them this link");
    });

    it("still opens a browser on Linux when only WAYLAND_DISPLAY is set", async () => {
      vi.stubEnv("DISPLAY", "");
      vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
      await run(false, "linux");

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(events()[0]).toMatchObject({ browser_opened: true });
    });
  });

  describe("browser selection and launch outcome", () => {
    function pendingBrowser(): ChildProcess {
      const child = browserProcess();
      vi.mocked(spawn).mockReturnValue(child);
      return child;
    }

    async function complete(options: Parameters<typeof auth>[0] = {}): Promise<void> {
      fetchMock.mockImplementation(async () => {
        if (!options.human) expect(progress).toHaveBeenCalledTimes(1);
        return { ok: true, json: async () => ({ token: "test-token", account: "builder@example.test" }) };
      });
      const result = auth(options);
      await vi.advanceTimersByTimeAsync(CLI_AUTH_POLL_INTERVAL_MS);
      await result;
    }

    function event(): Record<string, unknown> {
      expect(progress).toHaveBeenCalledTimes(1);
      return vi.mocked(progress).mock.calls[0]![0] as Record<string, unknown>;
    }

    it.each([
      ['test-browser --private', "test-browser", ["--private", "URL"]],
      ['test-browser --profile "isolated profile" %s --new-window', "test-browser", ["--profile", "isolated profile", "URL", "--new-window"]],
      ['"/browser path/browser" \'%s\' ""', "/browser path/browser", ["URL", ""]],
      ['test-browser --url=%s --copy=%s', "test-browser", ["--url=URL", "--copy=URL"]],
      ['"C:\\Browser Files\\browser.exe" --profile isolated\\ profile', "C:\\Browser Files\\browser.exe", ["--profile", "isolated profile", "URL"]],
      ['test-browser "$(touch nope)" ";"', "test-browser", ["$(touch nope)", ";", "URL"]],
    ])("uses BROWSER=%s with literal arguments and one intact URL", async (configured, executable, expected) => {
      vi.stubEnv("BROWSER", configured);
      await complete();
      const url = event().url as string;
      expect(url).toContain("&hash=");
      expect(spawn).toHaveBeenCalledExactlyOnceWith(executable,
        expected.map((arg) => arg.replace("URL", url)),
        { stdio: "ignore", detached: true, shell: false });
      expect(event().browser_opened).toBe(true);
    });

    it.each([true, false])("--no-browser preserves the link and code without launching (human=%s)", async (human) => {
      vi.stubEnv("BROWSER", "test-browser");
      await complete({ human, browser: false });
      expect(spawn).not.toHaveBeenCalled();
      if (human) {
        const output = vi.mocked(console.log).mock.calls.flat().join("\n");
        const session = output.match(/session=([a-f0-9]{32})/)![1]!;
        expect(output).toContain(`Session code: ${session.slice(0, 12)}`);
        expect(output).toContain("Send them this link");
      } else {
        const result = event();
        const url = new URL(result.url as string);
        expect(result.browser_opened).toBe(false);
        expect(result.fingerprint).toBe(url.searchParams.get("session")!.slice(0, 12));
        expect(result.instruction).toContain(result.url);
        expect(result.display).toContain(`Session code: ${result.fingerprint}`);
      }
    });

    it("allows an explicit browser on a headless host", async () => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "linux" });
      vi.stubEnv("DISPLAY", "");
      vi.stubEnv("WAYLAND_DISPLAY", "");
      vi.stubEnv("BROWSER", "text-browser");
      try {
        await complete();
        expect(spawn).toHaveBeenCalledWith("text-browser", [event().url], expect.any(Object));
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    });

    it.each([
      ["darwin", "open", []],
      ["linux", "xdg-open", []],
      ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler"]],
    ])("uses the default opener on %s when BROWSER is blank", async (platformName, executable, args) => {
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platformName });
      vi.stubEnv("BROWSER", "  ");
      try {
        await complete();
        expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, [...args, event().url], expect.objectContaining({ shell: false }));
      } finally {
        Object.defineProperty(process, "platform", original);
      }
    });

    it.each([1, null])("reports an opener exiting with %s as failed", async (code) => {
      const child = pendingBrowser();
      const result = complete();
      child.emit("spawn");
      expect(progress).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      child.emit("exit", code, code === null ? "SIGTERM" : null);
      await result;
      expect(event().browser_opened).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])("bounds the opener wait and requires a spawn event (started=%s)", async (started) => {
      const child = pendingBrowser();
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ token: "test-token", account: "builder@example.test" }) });
      const result = auth({});
      if (started) child.emit("spawn");
      await vi.advanceTimersByTimeAsync(2999);
      expect(progress).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(event().browser_opened).toBe(started);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(child.unref).toHaveBeenCalledOnce();
      child.emit("error", new Error("late failure"));
      child.emit("exit", 1);
      expect(progress).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(CLI_AUTH_POLL_INTERVAL_MS);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reports a synchronous spawn failure without falling back to another browser", async () => {
      vi.stubEnv("BROWSER", "missing-browser");
      vi.mocked(spawn).mockImplementation(() => { throw new Error("launch failed"); });
      await complete();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(event().browser_opened).toBe(false);
    });

    it("rejects an unclosed BROWSER quote without opening the default browser", async () => {
      vi.stubEnv("BROWSER", 'test-browser "unclosed');
      await complete();
      expect(spawn).not.toHaveBeenCalled();
      expect(event().browser_opened).toBe(false);
    });
  });

  describe("logout", () => {
    const stored = { token: "dvmk_matching_secret", account: "builder@example.test" };
    const key = (id: string, prefix: string | null) => ({ id, key_prefix: prefix, label: null, created_at: 0, last_used_at: null });

    beforeEach(() => {
      mockPlatform.loadAuthToken.mockReturnValue(stored);
      vi.stubEnv("DVMKIT_API_KEY", "other-environment-key");
    });

    it.each([true, false])("revokes only the matching stored key before clearing it (human=%s)", async (human) => {
      vi.mocked(listApiKeys).mockResolvedValue({ keys: [key("unrelated", "dvmk_other"), key("matching", "dvmk_match"), key("legacy", null)], count: 3, limit: 10 });
      vi.mocked(deleteApiKey).mockImplementation(async () => {
        expect(mockPlatform.clearAuthToken).not.toHaveBeenCalled();
      });
      await auth({ logout: true, human });
      expect(listApiKeys).toHaveBeenCalledExactlyOnceWith(expect.any(String), stored.token, expect.any(AbortSignal));
      expect(deleteApiKey).toHaveBeenCalledExactlyOnceWith(expect.any(String), stored.token, "matching", expect.any(AbortSignal));
      expect(mockPlatform.clearAuthToken).toHaveBeenCalledOnce();
      if (human) expect(console.log).toHaveBeenCalledWith(expect.stringContaining("API key revoked"));
      else expect(json).toHaveBeenCalledWith({ status: "logged_out", revoked: true }, { feedback: false });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it.each(["list fails", "delete fails", "no match", "ambiguous", "empty prefix", "missing stored key"])("clears local credentials and reports unconfirmed revocation when %s", async (failure) => {
      const keys = failure === "no match" ? [key("other", "dvmk_other")] :
        failure === "ambiguous" ? [key("one", "dvmk_match"), key("two", "dvmk_match")] :
          failure === "empty prefix" ? [key("empty", ""), key("null", null)] : [key("matching", "dvmk_match")];
      vi.mocked(listApiKeys).mockResolvedValue({ keys, count: keys.length, limit: 10 });
      if (failure === "list fails") vi.mocked(listApiKeys).mockRejectedValue(new Error("offline"));
      if (failure === "delete fails") vi.mocked(deleteApiKey).mockRejectedValue(new Error("already revoked"));
      if (failure === "missing stored key") mockPlatform.loadAuthToken.mockReturnValue(null);
      await auth({ logout: true });
      expect(mockPlatform.clearAuthToken).toHaveBeenCalledOnce();
      const result = vi.mocked(json).mock.lastCall?.[0];
      expect(result).toMatchObject({ status: "logged_out", revoked: false, hint: expect.stringContaining("dvmctl api-keys revoke <id>") });
      expect(result).toHaveProperty("hint", expect.stringContaining("dashboard"));
      expect(JSON.stringify(result)).not.toContain(stored.token);
      if (failure !== "delete fails") expect(deleteApiKey).not.toHaveBeenCalled();
      if (failure === "missing stored key") expect(listApiKeys).not.toHaveBeenCalled();
    });

    it("explains unconfirmed server revocation in human output", async () => {
      vi.mocked(listApiKeys).mockRejectedValue(new Error("offline"));
      await auth({ logout: true, human: true });
      expect(mockPlatform.clearAuthToken).toHaveBeenCalledOnce();
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/Logged out locally.*dashboard.*dvmctl api-keys revoke/));
    });
  });
});

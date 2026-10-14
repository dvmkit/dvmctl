import { afterEach, describe, expect, it, vi } from "vitest";

import { blockUntilShutdown } from "../keep-alive";

describe("blockUntilShutdown", () => {
  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    vi.restoreAllMocks();
  });

  it("does not resolve on its own", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn();
    const sentinel = Symbol("timeout");

    const winner = await Promise.race([
      blockUntilShutdown(() => ({ close })),
      new Promise((r) => {
        setTimeout(() => {
          r(sentinel);
        }, 30);
      }),
    ]);

    expect(winner).toBe(sentinel);
    expect(close).not.toHaveBeenCalled();
  });

  it("reads the live server via the getter", async () => {
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const first = vi.fn();
    const second = vi.fn();
    let current = { close: first };

    void blockUntilShutdown(() => current);
    current = { close: second }; // simulate a hot reload swapping the server
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 0));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across repeated signals", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const close = vi.fn().mockResolvedValue(undefined);

    void blockUntilShutdown(() => ({ close }));
    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 0));

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

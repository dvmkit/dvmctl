import { DvmError } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it } from "vitest";

import { mapHandshakeError, openDbTunnel, toWsUrl } from "../db-tunnel-client";
import type { DbTunnelStub } from "./db-tunnel-stub";
import { startDbTunnelStub } from "./db-tunnel-stub";

let stub: DbTunnelStub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe("toWsUrl", () => {
  it("rewrites https → wss", () => {
    expect(toWsUrl("https://api.dvmkit.dev", "cast")).toBe(
      "wss://api.dvmkit.dev/api/v1/builder/dvms/cast/db-tunnel"
    );
  });

  it("rewrites http → ws (local dev)", () => {
    expect(toWsUrl("http://localhost:8080", "cast")).toBe(
      "ws://localhost:8080/api/v1/builder/dvms/cast/db-tunnel"
    );
  });

  it("strips a trailing slash on the base URL", () => {
    expect(toWsUrl("https://api.dvmkit.dev/", "cast")).toBe(
      "wss://api.dvmkit.dev/api/v1/builder/dvms/cast/db-tunnel"
    );
  });

  it("appends and encodes the machine query param", () => {
    expect(toWsUrl("https://api.dvmkit.dev", "cast", "m-123")).toBe(
      "wss://api.dvmkit.dev/api/v1/builder/dvms/cast/db-tunnel?machine=m-123"
    );
  });

  it("encodes the slug", () => {
    expect(toWsUrl("https://api.dvmkit.dev", "a/b")).toContain("/dvms/a%2Fb/db-tunnel");
  });
});

describe("mapHandshakeError", () => {
  it("maps 401 to an auth error with a hint", () => {
    const err = mapHandshakeError(401, "cast");
    expect(err).toBeInstanceOf(DvmError);
    expect(err.code).toBe("auth_required");
    expect(err.hint).toContain("dvmctl auth");
  });

  it("maps 403 to forbidden", () => {
    expect(mapHandshakeError(403, "cast").code).toBe("forbidden");
  });

  it("maps 404 to not_found", () => {
    expect(mapHandshakeError(404, "cast").code).toBe("not_found");
  });

  it("maps 409 to db_not_provisioned", () => {
    expect(mapHandshakeError(409, "cast").code).toBe("db_not_provisioned");
  });

  it("maps 410 to gone", () => {
    expect(mapHandshakeError(410, "cast").code).toBe("gone");
  });

  it("prefers the platform's error code and message when present", () => {
    const err = mapHandshakeError(409, "cast", "custom_code", "custom message");
    expect(err.code).toBe("custom_code");
    expect(err.message).toBe("custom message");
    expect(err.proseSources).toEqual({ message: "provider" });
  });

  it("falls back to tunnel_failed for unexpected statuses", () => {
    expect(mapHandshakeError(500, "cast").code).toBe("tunnel_failed");
  });
});

describe("openDbTunnel", () => {
  it("resolves with the ready frame's credentials and authenticates the request", async () => {
    stub = await startDbTunnelStub({
      ready: { user: "cast_app", password: "pw", database: "cast_db" },
    });

    const tunnel = await openDbTunnel({
      platformUrl: stub.platformUrl,
      token: "tok_123",
      dvmId: "dvm-cast",
      machine: "m-1",
    });

    expect(tunnel.ready).toEqual({ user: "cast_app", password: "pw", database: "cast_db" });
    expect(stub.sessions).toHaveLength(1);
    expect(stub.sessions[0].auth).toBe("Bearer tok_123");
    expect(stub.sessions[0].url).toBe("/api/v1/builder/dvms/dvm-cast/db-tunnel?machine=m-1");
    expect(stub.activeConnections()).toBe(1);
    await tunnel.close();
    await expect.poll(() => stub?.activeConnections()).toBe(0);
  });

  it("force-closes a peer that does not complete the close handshake", async () => {
    // Keep the peer silent beyond this test's timeout; the forced close is what lets it finish.
    stub = await startDbTunnelStub({ stallClientCloseMs: 60_000 });
    const tunnel = await openDbTunnel({
      platformUrl: stub.platformUrl,
      token: "tok",
      dvmId: "dvm-cast",
    });

    await tunnel.close();
    await expect.poll(() => stub?.activeConnections()).toBe(0);
  });

  it("cancels a tunnel that never finishes opening", async () => {
    stub = await startDbTunnelStub({ readySessionLimit: 0 });
    const controller = new AbortController();
    const opening = openDbTunnel({
      platformUrl: stub.platformUrl,
      token: "tok",
      dvmId: "dvm-cast",
      signal: controller.signal,
    });

    await expect.poll(() => stub?.activeConnections()).toBe(1);
    controller.abort();

    await expect(opening).rejects.toMatchObject({ code: "tunnel_closed" });
    await expect.poll(() => stub?.activeConnections()).toBe(0);
  });

  it("rejects with the platform's error class when the handshake is refused", async () => {
    stub = await startDbTunnelStub({
      reject: {
        status: 404,
        code: "not_found",
        message: "DVM 'cast' not found, or you don't own it.",
      },
    });

    await expect(
      openDbTunnel({ platformUrl: stub.platformUrl, token: "tok", dvmId: "dvm-cast" })
    ).rejects.toMatchObject({
      code: "not_found",
      proseSources: { message: "provider" },
    });
  });

  it("rejects with a hint when the platform sends a no_running_machine error frame", async () => {
    stub = await startDbTunnelStub({
      errorFrame: { code: "no_running_machine", message: "No running machine." },
    });

    await expect(
      openDbTunnel({ platformUrl: stub.platformUrl, token: "tok", dvmId: "dvm-cast" })
    ).rejects.toMatchObject({
      code: "no_running_machine",
      hint: expect.stringContaining("Start"),
      proseSources: { message: "provider" },
    });
  });

  it("notifies onClose once the tunnel tears down after ready", async () => {
    stub = await startDbTunnelStub();
    const { platformUrl } = stub;
    const closed = new Promise<void>((resolve) => {
      void openDbTunnel({
        platformUrl,
        token: "tok",
        dvmId: "dvm-cast",
        onClose: () => {
          resolve();
        },
      }).then((tunnel) => {
        void tunnel.close();
      });
    });

    await expect(closed).resolves.toBeUndefined();
  });
});

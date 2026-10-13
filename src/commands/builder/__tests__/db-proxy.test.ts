import { connect, type Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DbTunnelStub } from "../../../lib/__tests__/db-tunnel-stub";
import { startDbTunnelStub } from "../../../lib/__tests__/db-tunnel-stub";
import { buildDatabaseUrl, type DbProxyHandle, startDbProxy } from "../db-proxy";

/** Set per test before `startDbProxy` runs, since `requireAuth` is mocked module-wide. */
const auth = vi.hoisted(() => ({ platformUrl: "" }));

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: auth.platformUrl })),
}));

vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({
    dvmId: "dvm-cast",
    token: "tok",
    platformUrl: auth.platformUrl,
  })),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
  progress: vi.fn(),
}));

let stub: DbTunnelStub | undefined;
let proxy: DbProxyHandle | undefined;
const clients: Socket[] = [];

function target() {
  return { dvmId: "dvm-cast", token: "tok", platformUrl: auth.platformUrl, dvmkitUrl: null };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await proxy?.close();
  proxy = undefined;
  await stub?.close();
  stub = undefined;
});

/** Open a TCP client against the proxy and wait for the connection to land. */
async function dial(port: number): Promise<Socket> {
  const sock = connect({ host: "127.0.0.1", port });
  clients.push(sock);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  return sock;
}

/** Write bytes and wait for the stub's reply to come back through the tunnel. */
async function roundTrip(sock: Socket, payload: string): Promise<string> {
  const reply = new Promise<string>((resolve) =>
    sock.once("data", (b: Buffer) => {
      resolve(b.toString());
    })
  );
  sock.write(payload);
  return reply;
}

describe("startDbProxy", () => {
  it("binds a local port and round-trips bytes through the tunnel", async () => {
    stub = await startDbTunnelStub();
    auth.platformUrl = stub.platformUrl;

    proxy = await startDbProxy(target(), {});
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.ready).toEqual({ user: "postgres", password: "s3cret", database: "cast" });

    const sock = await dial(proxy.port);
    await expect(roundTrip(sock, "select 1")).resolves.toBe("SELECT 1");
  });

  it("gives each concurrent client its own tunnel (the platform never multiplexes)", async () => {
    stub = await startDbTunnelStub();
    auth.platformUrl = stub.platformUrl;
    proxy = await startDbProxy(target(), {});

    const [a, b] = await Promise.all([dial(proxy.port), dial(proxy.port)]);
    const [replyA, replyB] = await Promise.all([roundTrip(a, "from-a"), roundTrip(b, "from-b")]);

    expect(replyA).toBe("FROM-A");
    expect(replyB).toBe("FROM-B");

    // One probe tunnel at startup + one per client, each carrying only its own bytes.
    expect(stub.sessions).toHaveLength(3);
    const perClient = stub.sessions
      .slice(1)
      .map((s) => Buffer.concat(s.received).toString())
      .sort();
    expect(perClient).toEqual(["from-a", "from-b"]);
  });

  it("waits for the probe and accepted tunnels to close before teardown completes", async () => {
    // A normal close handshake would outlive the test; both tunnels must take the forced path.
    stub = await startDbTunnelStub({ stallClientCloseMs: 60_000 });
    auth.platformUrl = stub.platformUrl;
    proxy = await startDbProxy(target(), {});

    await expect.poll(() => stub?.activeConnections()).toBe(0);
    await dial(proxy.port);
    await expect.poll(() => stub?.sessions).toHaveLength(2);
    expect(stub.activeConnections()).toBe(1);

    await proxy.close();
    proxy = undefined;
    await expect.poll(() => stub?.activeConnections()).toBe(0);
  });

  it("closes a tunnel that finishes opening after proxy shutdown starts", async () => {
    stub = await startDbTunnelStub({ readyDelayMs: 100 });
    auth.platformUrl = stub.platformUrl;
    proxy = await startDbProxy(target(), {});

    await dial(proxy.port);
    await expect.poll(() => stub?.sessions).toHaveLength(2);
    await proxy.close();
    proxy = undefined;

    await expect.poll(() => stub?.activeConnections()).toBe(0);
  });

  it("cancels a tunnel that never finishes opening when shutdown starts", async () => {
    // The probe is session one; the accepted client's WebSocket upgrades but
    // never receives `ready`, so only explicit cancellation can settle it.
    stub = await startDbTunnelStub({ readySessionLimit: 1 });
    auth.platformUrl = stub.platformUrl;
    proxy = await startDbProxy(target(), {});

    await dial(proxy.port);
    await expect.poll(() => stub?.sessions).toHaveLength(2);
    await proxy.close();
    proxy = undefined;

    await expect.poll(() => stub?.activeConnections()).toBe(0);
  });

  it("survives a client that resets while its tunnel is still opening", async () => {
    // The tunnel takes a beat to open, so the reset lands in the window before
    // the socket is attached — an unhandled 'error' here would kill the process.
    stub = await startDbTunnelStub({ readyDelayMs: 60 });
    auth.platformUrl = stub.platformUrl;
    proxy = await startDbProxy(target(), {});

    const aborting = await dial(proxy.port);
    aborting.resetAndDestroy(); // RST, not a graceful FIN

    // The proxy is still up and still serving other clients.
    const sock = await dial(proxy.port);
    await expect(roundTrip(sock, "select 1")).resolves.toBe("SELECT 1");
  });

  it("honours an explicit --port", async () => {
    stub = await startDbTunnelStub();
    auth.platformUrl = stub.platformUrl;

    // Bind an OS-assigned port first to learn a free one, then re-bind it explicitly.
    const scout = await startDbProxy(target(), {});
    const port = scout.port;
    await scout.close();

    proxy = await startDbProxy(target(), { port: String(port) });
    expect(proxy.port).toBe(port);
  });

  it.each(["not-a-port", "0", "70000", "5432.5"])(
    "rejects --port %s before opening anything",
    async (port) => {
      stub = await startDbTunnelStub();
      auth.platformUrl = stub.platformUrl;

      await expect(startDbProxy(target(), { port })).rejects.toMatchObject({
        code: "invalid_port",
      });
      expect(stub.sessions).toHaveLength(0);
    }
  );

  it("surfaces an ownership failure instead of binding a port", async () => {
    stub = await startDbTunnelStub({
      reject: {
        status: 404,
        code: "not_found",
        message: "DVM 'cast' not found, or you don't own it.",
      },
    });
    auth.platformUrl = stub.platformUrl;

    await expect(startDbProxy(target(), {})).rejects.toMatchObject({ code: "not_found" });
  });

  it("closing the proxy stops accepting new connections", async () => {
    stub = await startDbTunnelStub();
    auth.platformUrl = stub.platformUrl;

    const handle = await startDbProxy(target(), {});
    const port = handle.port;
    await handle.close();

    await expect(dial(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("buildDatabaseUrl", () => {
  it("percent-encodes credentials that would otherwise break the URL", () => {
    expect(buildDatabaseUrl({ user: "a@b", password: "p@ss:w/rd?", database: "my db" }, 5432)).toBe(
      "postgres://a%40b:p%40ss%3Aw%2Frd%3F@127.0.0.1:5432/my%20db?sslmode=disable"
    );
  });
});

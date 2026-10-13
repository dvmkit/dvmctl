import type { AddressInfo, Socket } from "node:net";
import { createServer } from "node:net";

import {
  asProviderText,
  DvmError,
  type ProviderText,
  providerTextToString,
} from "@dvmkit/sdk/internal";

import type { DbTunnel, DbTunnelReady } from "../../lib/db-tunnel-client.ts";
import { openDbTunnel } from "../../lib/db-tunnel-client.ts";
import { blockUntilShutdown } from "../../lib/keep-alive.ts";
import { info, json, progress } from "../../shared/output.ts";
import { type ResolvedDvm, resolveDvm } from "./resolve-dvm.ts";

export interface DbProxyOptions {
  /** Local port to bind (default: an OS-assigned free port). */
  port?: string;
  /** Broker through a specific machine (default: first running machine). */
  machine?: string;
  human?: boolean;
  org?: string;
}

/** A bound proxy: the local port, the far-end credentials, and a teardown hook. */
export interface DbProxyHandle {
  /** The port actually bound on 127.0.0.1. */
  port: number;
  /** Credentials for the database on the far end. */
  ready: DbTunnelReady;
  /** Stop accepting connections and resolve once every live tunnel has closed. */
  close: () => Promise<void>;
}

/**
 * Bind a local TCP port to a DVM's per-DVM Postgres, brokered by the platform
 * (no flyctl required builder-side), and hold it open until Ctrl-C. Any Postgres
 * client can then connect — `pg_dump`, drizzle-kit, TablePlus — with no local
 * `psql` requirement.
 *
 * Each inbound connection opens its own tunnel, so concurrent clients (a GUI
 * opening a pool, say) work; the platform relays one Postgres connection per
 * tunnel.
 */
export async function dbProxy(slug: string, opts: DbProxyOptions): Promise<void> {
  if (opts.human) info(`Opening a tunnel to ${slug}'s database…`);

  const target = await resolveDvm(slug, opts);
  const handle = await startDbProxy(target, opts);
  const url = buildDatabaseUrl(handle.ready, handle.port);

  if (opts.human) {
    info(`\nProxying ${slug}'s database on 127.0.0.1:${handle.port}\n`);
    info(`  DATABASE_URL  ${url}`);
    info(`  user          ${handle.ready.user}`);
    info(`  password      ${handle.ready.password}`);
    info(`  database      ${handle.ready.database}\n`);
    info(`  psql "${url}"`);
    info(`  pg_dump "${url}" > ${slug}.sql\n`);
    info("Press Ctrl-C to close the tunnel.");
  } else {
    json({
      dvmId: target.dvmId,
      slug,
      host: "127.0.0.1",
      port: handle.port,
      user: handle.ready.user,
      database: handle.ready.database,
      database_url: url,
      display: `Postgres proxy for ${slug} listening on 127.0.0.1:${handle.port}.`,
      hint: `Point any Postgres client at database_url (psql, pg_dump, drizzle-kit, a GUI client). The proxy stays up until it is interrupted.`,
    });
  }

  await blockUntilShutdown(() => handle);
}

/**
 * Bind the local port for an already resolved DVM and verify access, without
 * blocking. Exported so callers (and tests) can drive the proxy's lifecycle
 * themselves; `dbProxy` wraps this with output and a Ctrl-C block.
 */
export async function startDbProxy(
  target: ResolvedDvm,
  opts: DbProxyOptions
): Promise<DbProxyHandle> {
  const { token, platformUrl, dvmId } = target;
  const port = parsePort(opts.port);
  const opening = new Set<AbortController>();
  const open = async (): Promise<DbTunnel> => {
    const controller = new AbortController();
    opening.add(controller);
    try {
      return await openDbTunnel({
        platformUrl,
        token,
        dvmId,
        machine: opts.machine,
        signal: controller.signal,
      });
    } finally {
      opening.delete(controller);
    }
  };

  // Probe once up-front: it is the only way to learn the credentials, and it
  // means auth/ownership/no-machine failures surface before we print a port
  // rather than on some later client's confusing connection reset. Each inbound
  // connection then gets a fresh tunnel (and a fresh platform session budget).
  const probe = await open();
  await probe.close();

  const tunnels = new Set<DbTunnel>();
  const sockets = new Set<Socket>();
  const connections = new Set<Promise<void>>();
  let closing = false;
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.once("close", () => sockets.delete(sock));
    // Before anything that awaits: opening this client's tunnel is a full
    // round-trip to the platform, and a client that resets in that window would
    // otherwise emit an unhandled 'error' and take the whole proxy down with it.
    sock.on("error", () => {
      sock.destroy();
    });
    if (closing) {
      sock.destroy();
      return;
    }
    const connection = serveConnection(sock, open, tunnels, () => closing, opts.human);
    connections.add(connection);
    void connection.then(
      () => connections.delete(connection),
      () => connections.delete(connection)
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: Error): void => {
      reject(new DvmError("local_listener_failed", `Could not open a local port: ${err.message}`));
    };
    server.once("error", onListenError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onListenError);
      // Once bound, a server error (a failed accept, say) is not fatal to the
      // clients already served — report it and keep listening.
      server.on("error", (err: Error) => {
        reportError("proxy_error", "local_listener_failed", err.message, opts.human);
      });
      resolve();
    });
  });

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      for (const controller of opening) controller.abort();
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      for (const socket of sockets) socket.destroy();
      await Promise.all([...tunnels].map((tunnel) => tunnel.close()));
      await Promise.all([...connections]);
      await Promise.all([...tunnels].map((tunnel) => tunnel.close()));
      await serverClosed;
      tunnels.clear();
    })();
    return closePromise;
  };

  return {
    port: (server.address() as AddressInfo).port,
    ready: probe.ready,
    close,
  };
}

/**
 * Build the connection string a client should use. `sslmode=disable` is
 * required: the hop to the local port is plaintext (the encrypted leg is the
 * platform WebSocket).
 */
export function buildDatabaseUrl(ready: DbTunnelReady, port: number): string {
  const user = encodeURIComponent(ready.user);
  const password = encodeURIComponent(ready.password);
  const database = encodeURIComponent(ready.database);
  return `postgres://${user}:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
}

/** Give an accepted client its own tunnel; a failure drops that client, not the proxy. */
async function serveConnection(
  sock: Socket,
  open: () => Promise<DbTunnel>,
  tunnels: Set<DbTunnel>,
  isClosing: () => boolean,
  human?: boolean
): Promise<void> {
  let tunnel: DbTunnel;
  try {
    tunnel = await open();
  } catch (err) {
    if (!isClosing()) {
      const { code, message } = asDvmError(err);
      reportError("connection_error", code, message, human);
    }
    sock.destroy();
    return;
  }

  if (sock.destroyed || isClosing()) {
    // The client gave up while we were opening the tunnel.
    sock.destroy();
    await tunnel.close();
    return;
  }

  tunnels.add(tunnel);
  sock.on("close", () => {
    void tunnel.close().then(() => tunnels.delete(tunnel));
  });
  tunnel.attach(sock);
}

/** Report a non-fatal failure on the side channel; the proxy stays up either way. */
function reportError(
  event: "connection_error" | "proxy_error",
  code: string,
  message: string | ProviderText,
  human?: boolean
): void {
  const label = event === "connection_error" ? "Connection failed" : "Proxy error";
  if (human) info(`${label}: ${providerTextToString(message)}`);
  else progress({ event, code, message });
}

function asDvmError(err: unknown): { code: string; message: string | ProviderText } {
  if (err instanceof DvmError) {
    return {
      code: err.code,
      message: err.proseSources?.message === "provider" ? asProviderText(err.message) : err.message,
    };
  }
  return { code: "tunnel_failed", message: err instanceof Error ? err.message : String(err) };
}

function parsePort(raw?: string): number {
  if (raw === undefined) return 0; // OS-assigned
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DvmError(
      "invalid_port",
      `'${raw}' is not a valid port.`,
      "Pass --port 1-65535, or omit --port for an OS-assigned one."
    );
  }
  return port;
}

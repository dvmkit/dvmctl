import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";

import type { DbTunnelReady } from "../db-tunnel-client";

/** One accepted WebSocket on the stub — the platform's end of a single tunnel. */
export interface StubSession {
  /** The `Authorization` header the CLI sent. */
  auth?: string;
  /** Request path + query, so tests can assert slug/machine routing. */
  url?: string;
  /** Every byte chunk the CLI pushed through this tunnel. */
  received: Buffer[];
  /** Push bytes back down the tunnel, as the far-end Postgres would. */
  send: (data: Buffer | string) => void;
}

/** How the stub should behave for every tunnel it accepts. */
export interface DbTunnelStubOptions {
  /** Credentials for the `ready` frame (default: a plausible set). */
  ready?: DbTunnelReady;
  /** Refuse the WebSocket upgrade with this HTTP status + JSON error body. */
  reject?: { status: number; code: string; message: string };
  /** Accept the upgrade, then send an `error` control frame instead of `ready`. */
  errorFrame?: { code: string; message: string };
  /** Hold the `ready` frame back this long, so tests can act while a tunnel is still opening. */
  readyDelayMs?: number;
  /** Send `ready` for at most this many accepted sessions; later opens remain pending. */
  readySessionLimit?: number;
  /** Hold outbound writes this long after `ready`, delaying the peer's close reply. */
  stallClientCloseMs?: number;
  /** Handle client bytes (default: echo them back, uppercased, so tests can prove a round trip). */
  onData?: (session: StubSession, chunk: Buffer) => void;
}

/** A running stub of the platform's `/db-tunnel` WebSocket endpoint. */
export interface DbTunnelStub {
  /** Base URL to hand `requireAuth`-mocked commands. */
  platformUrl: string;
  /** Accepted tunnels, in order — one per client connection (the platform never multiplexes). */
  sessions: StubSession[];
  /** Number of WebSocket tunnels that have not closed yet. */
  activeConnections: () => number;
  close: () => Promise<void>;
}

/**
 * Stand up an in-process stand-in for the platform's db-tunnel endpoint: the
 * same handshake, the same `ready`/`error` control frames, and the same raw
 * byte passthrough, minus Fly and Postgres. Lets the CLI's tunnel client and
 * `db proxy` be exercised over real sockets.
 */
export async function startDbTunnelStub(opts: DbTunnelStubOptions = {}): Promise<DbTunnelStub> {
  const ready: DbTunnelReady = opts.ready ?? {
    user: "postgres",
    password: "s3cret",
    database: "cast",
  };
  const sessions: StubSession[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer();

  server.on("upgrade", (req, socket, head) => {
    if (opts.reject) {
      const body = JSON.stringify({
        error: { code: opts.reject.code, message: opts.reject.message },
      });
      socket.write(
        `HTTP/1.1 ${opts.reject.status} Rejected\r\n` +
          "Content-Type: application/json\r\n" +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          "Connection: close\r\n\r\n" +
          body
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const session: StubSession = {
        auth: req.headers.authorization,
        url: req.url,
        received: [],
        send: (data) => {
          ws.send(data);
        },
      };
      sessions.push(session);

      if (opts.errorFrame) {
        ws.send(JSON.stringify({ type: "error", ...opts.errorFrame }));
        ws.close();
        return;
      }

      if (opts.readySessionLimit !== undefined && sessions.length > opts.readySessionLimit) return;

      const sendReady = (): void => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: "ready", ...ready }), () => {
            if (opts.stallClientCloseMs) {
              socket.cork();
              setTimeout(() => socket.uncork(), opts.stallClientCloseMs).unref();
            }
          });
        }
      };
      if (opts.readyDelayMs) setTimeout(sendReady, opts.readyDelayMs).unref();
      else sendReady();

      ws.on("message", (data: Buffer) => {
        const chunk = Buffer.from(data);
        session.received.push(chunk);
        if (opts.onData) opts.onData(session, chunk);
        else ws.send(Buffer.from(chunk.toString("utf8").toUpperCase()));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    platformUrl: `http://127.0.0.1:${port}`,
    sessions,
    activeConnections: () => wss.clients.size,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    },
  };
}

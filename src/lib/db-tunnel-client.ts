import type { Socket } from "node:net";

import { DvmError } from "@dvmkit/sdk/internal";
import WebSocket from "ws";

/** Connection credentials the platform sends once the Postgres socket is live. */
export interface DbTunnelReady {
  user: string;
  password: string;
  database: string;
}

export interface OpenDbTunnelOptions {
  /** Platform base URL (http/https; rewritten to ws/wss). */
  platformUrl: string;
  /** Bearer token for the builder. */
  token: string;
  /** Immutable ID of the DVM whose database to reach. */
  dvmId: string;
  /** Broker through a specific machine (default: first running machine). */
  machine?: string;
  /** Called when the tunnel tears down *after* it was ready (never before). */
  onClose?: (err?: DvmError) => void;
  /** Cancel an opening or live tunnel; an opening promise settles after the WebSocket closes. */
  signal?: AbortSignal;
}

/** A live platform-brokered tunnel carrying one Postgres connection. */
export interface DbTunnel {
  /** Credentials for the database on the far end. */
  ready: DbTunnelReady;
  /** Pipe one TCP socket both ways; client-to-Postgres pauses until each send flushes. */
  attach: (socket: Socket) => void;
  /** Tear the tunnel down and resolve once the WebSocket has closed (idempotent). */
  close: () => Promise<void>;
}

/**
 * Open a platform-brokered tunnel to a DVM's per-DVM Postgres. The platform
 * relays the raw Postgres wire protocol over a WebSocket from the DVM's Fly
 * Postgres app, so no flyctl and no Fly credential is needed builder-side.
 *
 * Resolves once the platform's `ready` control frame lands, carrying the
 * database credentials; rejects with a `DvmError` if the handshake is refused
 * (auth/ownership/no-db), if the platform sends an `error` frame, or if the
 * socket closes before it is ready. Failures *after* ready go to `onClose`.
 *
 * One tunnel carries exactly one Postgres connection — the platform does not
 * multiplex. Callers wanting N concurrent connections open N tunnels.
 */
export function openDbTunnel(opts: OpenDbTunnelOptions): Promise<DbTunnel> {
  const { platformUrl, token, dvmId, machine, onClose, signal } = opts;
  const ws = new WebSocket(toWsUrl(platformUrl, dvmId, machine), {
    headers: { Authorization: `Bearer ${token}` },
  });

  return new Promise<DbTunnel>((resolve, reject) => {
    let ready = false;
    let settled = false;
    let socket: Socket | undefined;
    const pending: Buffer[] = [];
    let closeRequested = false;
    let forceCloseTimer: NodeJS.Timeout | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const terminate = (): void => {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
    };

    const requestClose = (): void => {
      if (closeRequested || ws.readyState === WebSocket.CLOSED) return;
      closeRequested = true;
      if (ws.readyState === WebSocket.OPEN) {
        forceCloseTimer = setTimeout(terminate, CLOSE_GRACE_MS);
        forceCloseTimer.unref();
        ws.close();
      } else {
        terminate();
      }
    };

    const close = async (): Promise<void> => {
      socket?.destroy();
      requestClose();
      await closed;
    };

    // Before ready, every failure rejects the open. After ready, the caller owns
    // the tunnel and hears about teardown through `onClose`.
    const fail = (err?: DvmError): void => {
      if (settled) return;
      settled = true;
      if (ready) {
        socket?.destroy();
        onClose?.(err);
      } else {
        const openingError =
          err ?? new DvmError("tunnel_closed", "The database tunnel closed before it was ready.");
        // A rejected open gives the caller no handle to close later. Keep the
        // opening promise pending until this socket is actually gone, so a
        // proxy can await cancellation without leaving an upgraded connection
        // behind its server teardown.
        void closed.then(() => {
          reject(openingError);
        });
      }
      requestClose();
    };

    const onAbort = (): void => {
      fail(new DvmError("tunnel_closed", "The database tunnel was closed."));
    };

    // The handshake was rejected before the socket opened (auth/ownership/no-db).
    // Read the JSON error body the platform returned to surface a precise code.
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => {
        let code: string | undefined;
        let message: string | undefined;
        try {
          const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
          code = parsed.error?.code;
          message = parsed.error?.message;
        } catch {
          /* non-JSON body */
        }
        fail(mapHandshakeError(res.statusCode ?? 0, dvmId, code, message));
      });
    });

    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (settled) return;
      if (!ready) {
        // First frame is a JSON control frame: `ready` or `error`.
        const frame = parseControlFrame(data);
        if (!frame) {
          fail(new DvmError("tunnel_protocol", "Unexpected response from the database tunnel."));
          return;
        }
        if (frame.type === "error") {
          fail(mapTunnelError(frame));
          return;
        }
        ready = true;
        const { user, password, database } = frame;
        resolve({ ready: { user, password, database }, attach, close });
        return;
      }
      // Postgres → client: forward the bytes (buffer until a socket attaches).
      const buf = toBuffer(data, isBinary);
      if (socket && !socket.destroyed) socket.write(buf);
      else pending.push(buf);
    });

    ws.on("error", (err: Error) => {
      fail(new DvmError("tunnel_failed", `Database tunnel error: ${err.message}`));
    });

    // The relay ended (db side closed, session timed out, or we closed it).
    ws.on("close", () => {
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      signal?.removeEventListener("abort", onAbort);
      fail();
      resolveClosed();
    });

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const attach = (sock: Socket): void => {
      socket = sock;
      for (const buf of pending.splice(0)) sock.write(buf);

      // Client → Postgres, with backpressure: hold the source until each chunk
      // is flushed onto the wire so a slow link can't balloon the send buffer.
      sock.on("data", (chunk: Buffer) => {
        sock.pause();
        ws.send(chunk, () => sock.resume());
      });
      sock.on("close", () => {
        fail();
      });
      sock.on("error", () => {
        fail();
      });
    };
  });
}

export function toWsUrl(platformUrl: string, dvmId: string, machine?: string): string {
  const base = platformUrl
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:")
    .replace(/\/$/, "");
  const path = `${base}/api/v1/builder/dvms/${encodeURIComponent(dvmId)}/db-tunnel`;
  return machine ? `${path}?machine=${encodeURIComponent(machine)}` : path;
}

export function mapHandshakeError(
  status: number,
  slug: string,
  code?: string,
  message?: string
): DvmError {
  const proseSources = message ? { message: "provider" as const } : undefined;
  if (status === 401) {
    return new DvmError(
      code ?? "auth_required",
      message ?? "Not authenticated.",
      "Set DVMKIT_API_KEY or run `dvmctl auth`.",
      undefined,
      undefined,
      proseSources
    );
  }
  if (status === 403) {
    return new DvmError(
      code ?? "forbidden",
      message ?? "You don't have admin access to this DVM's database.",
      undefined,
      undefined,
      undefined,
      proseSources
    );
  }
  if (status === 404) {
    return new DvmError(
      code ?? "not_found",
      message ?? `DVM '${slug}' not found, or you don't own it.`,
      undefined,
      undefined,
      undefined,
      proseSources
    );
  }
  if (status === 409) {
    return new DvmError(
      code ?? "db_not_provisioned",
      message ?? `'${slug}' has no managed Postgres database.`,
      undefined,
      undefined,
      undefined,
      proseSources
    );
  }
  if (status === 410) {
    return new DvmError(
      code ?? "gone",
      message ?? `DVM '${slug}' has been destroyed.`,
      undefined,
      undefined,
      undefined,
      proseSources
    );
  }
  return new DvmError(
    code ?? "tunnel_failed",
    message ?? `Database tunnel handshake failed (HTTP ${status}).`,
    undefined,
    undefined,
    undefined,
    proseSources
  );
}

interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
}

interface ReadyFrame extends DbTunnelReady {
  type: "ready";
}

/** Give the peer one second to complete a normal close handshake before forcing the socket down. */
const CLOSE_GRACE_MS = 1_000;

function mapTunnelError(frame: ErrorFrame): DvmError {
  const hint =
    frame.code === "no_running_machine"
      ? "Start the DVM (it must have a running machine to broker the connection)."
      : undefined;
  return new DvmError(
    frame.code || "tunnel_failed",
    frame.message || "Database tunnel failed.",
    hint,
    undefined,
    undefined,
    frame.message ? { message: "provider" } : undefined
  );
}

function parseControlFrame(data: WebSocket.RawData): ReadyFrame | ErrorFrame | undefined {
  try {
    const text = toBuffer(data, false).toString("utf8");
    const parsed = JSON.parse(text) as { type?: string };
    if (parsed.type === "ready" || parsed.type === "error") {
      return parsed as ReadyFrame | ErrorFrame;
    }
  } catch {
    /* not a control frame */
  }
  return undefined;
}

function toBuffer(data: WebSocket.RawData, isBinary: boolean): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data), isBinary ? "binary" : "utf8");
}

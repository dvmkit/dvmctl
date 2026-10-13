import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";

import { DvmError } from "@dvmkit/sdk/internal";

import type { DbTunnel, DbTunnelReady } from "../../lib/db-tunnel-client.ts";
import { openDbTunnel } from "../../lib/db-tunnel-client.ts";
import { info } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface DbConnectOptions {
  /** Target a specific machine to broker through (default: first running machine). */
  machine?: string;
  /** Human-readable status output instead of staying quiet. */
  human?: boolean;
  org?: string;
}

/**
 * Open an interactive `psql` session against a DVM's per-DVM Postgres database,
 * brokered by the platform (no flyctl required builder-side). The platform
 * relays the raw Postgres wire protocol over a WebSocket; this command pipes a
 * local `psql` through it. The session — and the tunnel — close when psql exits.
 *
 * Requires a local `psql` (the postgresql client) on PATH. For a long-lived
 * local port that any Postgres client can use, see `dvmctl db proxy`.
 */
export async function dbConnect(slug: string, opts: DbConnectOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  if (opts.human) info(`Connecting to ${slug}'s database…`);

  // Assigned synchronously by the promise executor below.
  let settle!: (err?: DvmError) => void;
  const finished = new Promise<void>((resolve, reject) => {
    let settled = false;
    settle = (err?: DvmError): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
  });

  // Failures before the tunnel is ready (auth, ownership, no running machine)
  // reject here; failures after it is ready arrive through `onClose`.
  const tunnel = await openDbTunnel({
    platformUrl,
    token,
    dvmId,
    machine: opts.machine,
    onClose: (err) => {
      settle(err);
    },
  });

  startLocalBridge(tunnel, settle, opts.human);
  await finished;
}

/** Bind an ephemeral loopback port, point psql at it, and pipe it through the tunnel. */
function startLocalBridge(
  tunnel: DbTunnel,
  settle: (err?: DvmError) => void,
  human?: boolean
): void {
  const server = createServer((sock) => {
    server.close(); // one psql, one connection — stop accepting others
    tunnel.attach(sock);
    sock.on("close", () => {
      settle();
    });
  });

  server.on("error", (err: Error) => {
    void tunnel.close();
    settle(new DvmError("local_listener_failed", `Could not open a local port: ${err.message}`));
  });

  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    spawnPsql(port, tunnel, settle, human);
  });
}

function spawnPsql(
  port: number,
  tunnel: DbTunnel,
  settle: (err?: DvmError) => void,
  human?: boolean
): void {
  if (human) info("Tunnel ready — launching psql.");
  const ready: DbTunnelReady = tunnel.ready;
  const psql = spawn(
    "psql",
    ["-h", "127.0.0.1", "-p", String(port), "-U", ready.user, "-d", ready.database],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PGPASSWORD: ready.password,
        PGSSLMODE: "disable",
        PGCONNECT_TIMEOUT: "10",
      },
    }
  );

  psql.on("error", (err: NodeJS.ErrnoException) => {
    void tunnel.close();
    if (err.code === "ENOENT") {
      settle(
        new DvmError(
          "psql_not_found",
          "psql was not found on your PATH.",
          "Install the PostgreSQL client (e.g. `brew install libpq` or `apt install postgresql-client`)."
        )
      );
    } else {
      settle(new DvmError("psql_failed", `Failed to launch psql: ${err.message}`));
    }
  });

  // psql owns the exit code (matches `psql` run directly). Pre-empt the
  // command's default exit(0) by exiting here once the session ends.
  psql.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

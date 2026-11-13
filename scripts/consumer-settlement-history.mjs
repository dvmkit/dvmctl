// @ts-check
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isHealthyResponse } from "./consumer-health.mjs";
import { INSTALL_COMMAND_TIMEOUT_MS, observeProcess, preservePrimaryFailure, processCommand, removeTemporaryDirectory, stopProcess } from "./consumer-process.mjs";

/** @param {string} cli @param {string} project @param {NodeJS.ProcessEnv} environment */
export async function assertSettlementHistory(cli, project, environment) {
  assert.ok(environment.DATABASE_URL, "settlement history checks require disposable PostgreSQL");
  /** @type {typeof import("pg")} */
  const { Pool } = createRequire(join(project, "package.json"))("pg");
  const admin = new Pool({ connectionString: environment.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  const legacy = mkdtempSync(join(tmpdir(), "dvmctl-history-control-"));
  const env = { ...environment };
  // These boots must depend only on a database and durable DVM identity, with no payment or hosting settings.
  for (const key of Object.keys(env)) if (key.startsWith("DVMKIT_")) delete env[key];
  const dvmId = randomUUID();
  env.DVMKIT_DVM_ID = dvmId;
  await preservePrimaryFailure(async () => {
    cpSync(join(project, "dist"), join(legacy, "dist"), { recursive: true });
    writeFileSync(join(legacy, "package.json"), JSON.stringify({
      private: true, type: "module", dependencies: { "@dvmkit/sdk": "0.28.0", pg: "8.20.0" },
    }));
    const installArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"];
    if (process.platform === "win32") await processCommand("cmd.exe", ["/d", "/s", "/c", "npm.cmd " + installArgs.join(" ")], { cwd: legacy, env, timeout: INSTALL_COMMAND_TIMEOUT_MS });
    else await processCommand("npm", installArgs, { cwd: legacy, env, timeout: INSTALL_COMMAND_TIMEOUT_MS });

    // Identical compiled starter bytes must expose the missing-history defect on the previous runtime.
    await checkBoot(legacy, [join(legacy, "dist/serve.js")], false, true);
    await checkBoot(project, [join(project, "dist/serve.js")], false);
    await checkBoot(project, [resolve(cli), "serve", "handler.ts"], false);
    await checkBoot(project, [resolve(cli), "dev", "handler.ts", "--no-reload"], false);
    await checkBoot(project, [resolve(cli), "dev", "handler.ts"], false);
    // An earlier financial table must never be mistaken for a complete historical ledger.
    await checkBoot(project, [join(project, "dist/serve.js")], true);
    console.log("consumer smoke: generated server, serve and dev initialize settlement history before their first job; legacy runtime lacks history and upgrade history stays incomplete");
  }, async () => {
    await admin.end();
    await removeTemporaryDirectory(legacy);
  });

  /** @param {string} cwd @param {string[]} args @param {boolean} upgrade @param {boolean} [control] */
  async function checkBoot(cwd, args, upgrade, control = false) {
    const name = `dvmctl_history_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(environment.DATABASE_URL ?? "");
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 10_000 });
    /** @type {import("node:child_process").ChildProcess | undefined} */
    let child;
    let output = "";
    await preservePrimaryFailure(async () => {
      if (upgrade) {
        // Pre-history SDKs wrote this outbox without a completeness marker.
        await pool.query(`CREATE TABLE pending_dvm_reports (
          id TEXT PRIMARY KEY, payload JSONB NOT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at BIGINT NOT NULL DEFAULT 0,
          stale BOOLEAN NOT NULL DEFAULT false, stale_reason TEXT,
          created_at BIGINT NOT NULL, kind TEXT NOT NULL DEFAULT 'revenue'
        )`);
      }
      const port = await boot(args, cwd);
      if (control) {
        await assert.rejects(assertHistory(pool, dvmId, true), /settlement history tables missing/);
      } else {
        await assertHistory(pool, dvmId, !upgrade);
      }
      const response = await fetch(`http://127.0.0.1:${port}/v1/job`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability: "first-project", input: JSON.stringify({ text: "history smoke" }) }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, "generated handler request must succeed");
      const job = await response.json();
      assert.equal(job.status, "completed");
      assert.equal(job.summary, "history smoke");
    }, async () => {
      await stop();
      await pool.end();
      await admin.query(`DROP DATABASE "${name}"`);
    });

    /** @param {string[]} command @param {string} directory */
    async function boot(command, directory) {
      const port = await availablePort();
      output = "";
      child = spawn(process.execPath, command, {
        cwd: directory, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
        env: { ...env, DATABASE_URL: url.href, PORT: String(port) },
      });
      observeProcess(child);
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { output += chunk; });
      await waitForHealth(child, port, () => output);
      return port;
    }
    async function stop() {
      if (child && !await stopProcess(child)) throw new Error("settlement-history server did not stop; its database was retained");
      child = undefined;
    }
  }
}

/** @param {import("pg").Pool} pool @param {string} dvmId @param {boolean} complete */
async function assertHistory(pool, dvmId, complete) {
  const tables = await pool.query(`SELECT
    to_regclass('sdk_hosted_settlement_report_history') AS history,
    to_regclass('sdk_hosted_settlement_report_obligations') AS obligations,
    to_regclass('sdk_hosted_settlement_report_identity') AS identity,
    to_regclass('sdk_hosting_control') AS control`);
  assert.ok(tables.rows[0].history && tables.rows[0].obligations && tables.rows[0].identity, "settlement history tables missing before the first job");
  assert.equal(tables.rows[0].control, null, "boot must not create the removed hosting-control table");
  assert.deepEqual((await pool.query("SELECT complete FROM sdk_hosted_settlement_report_history WHERE singleton=TRUE")).rows, [{ complete }]);
  const identities = await pool.query("SELECT scope,instance_id,boot_epoch FROM sdk_hosted_settlement_report_identity WHERE dvm_id=$1", [dvmId]);
  assert.equal(identities.rowCount, 1, "the DVM must own one reporting identity");
  assert.equal(identities.rows[0].scope, "default");
  assert.ok(identities.rows[0].instance_id);
  assert.equal(identities.rows[0].boot_epoch, "1");
  assert.equal((await pool.query("SELECT count(*) FROM sdk_hosted_settlement_report_obligations")).rows[0].count, "0");
}

/** @param {import("node:child_process").ChildProcess} child @param {number} port @param {() => string} output */
async function waitForHealth(child, port, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assert.ok(child.exitCode === null && child.signalCode === null, `history server exited before health: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (isHealthyResponse(response.status, await response.text())) return;
    } catch { /* The listener may still be starting. */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`settlement-history server did not become healthy: ${output()}`);
}

/** @returns {Promise<number>} */
function availablePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("could not allocate a history server port")));
      server.close((error) => error ? reject(error) : done(address.port));
    });
  });
}

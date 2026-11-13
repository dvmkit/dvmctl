// @ts-check
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { INSTALL_COMMAND_TIMEOUT_MS, preservePrimaryFailure, processCommand, removeTemporaryDirectory } from "../scripts/consumer-process.mjs";

// The hosted build job has Docker; local verification needs no container daemon or network listeners.
test("installed scaffold boots with independent settlement history and serves real jobs", {
  skip: process.env.GITHUB_ACTIONS !== "true" || process.platform !== "linux",
  timeout: 15 * 60_000,
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-scaffold-runtime-"));
  const consumer = join(directory, "consumer");
  const container = `dvmctl-scaffold-${randomUUID()}`;
  let started = false;
  await preservePrimaryFailure(async () => {
    await processCommand("docker", ["run", "--detach", "--rm", "--name", container,
      "--publish", "127.0.0.1::5432", "--env", "POSTGRES_DB=dvmctl_smoke",
      "--env", "POSTGRES_USER=dvmctl_smoke", "--env", "POSTGRES_PASSWORD=dvmctl_smoke",
      "postgres:17-alpine"], { capture: true, timeout: INSTALL_COMMAND_TIMEOUT_MS });
    started = true;
    await waitForDatabase(container);
    const ports = await processCommand("docker", ["port", container, "5432/tcp"], { capture: true });
    const port = ports.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/u)?.[1];
    assert.ok(port, "PostgreSQL must be published on loopback");

    const packed = await processCommand("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], { cwd: root, capture: true });
    const archive = join(directory, JSON.parse(packed.stdout)[0].filename);
    mkdirSync(consumer);
    await processCommand("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", archive], {
      cwd: consumer, timeout: INSTALL_COMMAND_TIMEOUT_MS,
    });
    await processCommand(process.execPath, [join(root, "scripts/consumer-smoke.mjs"), join(consumer, "node_modules/@dvmkit/dvmctl/dist/dvmctl.js"), "--database"], {
      env: { ...process.env, DATABASE_URL: `postgresql://dvmctl_smoke:dvmctl_smoke@127.0.0.1:${port}/dvmctl_smoke` },
      timeout: 12 * 60_000,
    });
  }, async () => {
    const removed = await processCommand("docker", ["rm", "--force", "--volumes", container], { capture: true, allowFailure: true });
    if (started) assert.equal(removed.code, 0, "disposable PostgreSQL container must be removed");
    await removeTemporaryDirectory(directory);
  });
});

/** @param {string} container */
async function waitForDatabase(container) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = await processCommand("docker", ["exec", container, "pg_isready", "--host", "127.0.0.1", "--username", "dvmctl_smoke", "--dbname", "dvmctl_smoke"], { capture: true, allowFailure: true, timeout: 5_000 });
    if (ready.code === 0) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("disposable PostgreSQL did not become ready");
}

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DVM_ID = "concurrent-fixture";
const fixture = fileURLToPath(new URL("../../../../test-support/fixtures/melt-pending-process.mjs", import.meta.url));
interface Event { kind: string; code?: string; request?: unknown }

describe("cross-process melt exclusion", () => {
  let stateDir: string;
  let children: ChildProcess[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "melt-processes-"));
    children = [];
    vi.stubEnv("DVMKIT_CONFIG_DIR", stateDir);
    vi.resetModules();
  });

  afterEach(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }));
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function start(pause = "none", state = "UNPAID", dvmId = DVM_ID) {
    const child = spawn(process.execPath, [
      "--experimental-test-module-mocks", "--import", "tsx", fixture, pause, state,
    ], { env: { ...process.env, DVMKIT_CONFIG_DIR: stateDir, MELT_TEST_DVM_ID: dvmId },
      stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    const events: Event[] = [];
    let output = "";
    child.stdout!.on("data", data => { output += data; });
    child.stderr!.on("data", data => { output += data; });
    child.on("message", event => events.push(event as Event));
    const closed = once(child, "close");
    async function wait(kind: string) {
      await vi.waitFor(() => {
        const event = events.find(event => event.kind === kind);
        if (!event) throw new Error(`Waiting for ${kind}: ${output}`);
      }, { timeout: 10_000, interval: 10 });
      return events.find(event => event.kind === kind)!;
    }
    return { child, events, wait, release: () => child.send("resume"),
      done: async () => {
        const result = await wait("done");
        expect(await closed, output).toEqual([0, null]);
        return result;
      },
    };
  }

  async function seedRecovery() {
    const journal = await import("../../../lib/melt-pending-log");
    journal.appendPreMelt({
      dvm_id: DVM_ID, row_ids: ["row-1"], quote_id: "original-quote",
      mint_url: "https://mint.invalid", lock_pubkey: "02" + "aa".repeat(32), total_sats: 60,
    });
    return journal;
  }

  it("excludes a competing sweep before reading recovery and preserves the later row hold", async () => {
    const first = start("batches");
    await first.wait("paused");
    const second = start();
    expect(await second.done()).toMatchObject({ code: "melt_pending_locked" });
    expect(second.events.map(event => event.kind)).toEqual(["done"]);
    first.release();
    expect(await first.done()).toMatchObject({ code: "batches_failed" });
    const next = start();
    expect(await next.done()).not.toHaveProperty("code");
    expect([...first.events, ...second.events, ...next.events].filter(event => event.kind === "quote")).toHaveLength(1);
    expect([...first.events, ...second.events, ...next.events].filter(event => event.kind === "submit")).toHaveLength(1);
    const journal = await import("../../../lib/melt-pending-log");
    expect(journal.readInFlight(DVM_ID)).toHaveLength(1);
    expect(readdirSync(stateDir).filter(name => name.endsWith(".lock"))).toEqual([]);
  }, 20_000);

  it("forwards the original preimage once across overlapping recovery processes", async () => {
    const journal = await seedRecovery();
    const first = start("mark", "PAID");
    await first.wait("paused");
    const second = start("none", "PAID");
    expect(await second.done()).toMatchObject({ code: "melt_pending_locked" });
    first.release();
    expect(await first.done()).not.toHaveProperty("code");
    const next = start("none", "PAID");
    expect(await next.done()).not.toHaveProperty("code");
    const events = [...first.events, ...second.events, ...next.events];
    expect(events.filter(event => event.kind === "mark")).toEqual([{
      kind: "mark", request: { row_ids: ["row-1"], melt_quote_id: "original-quote", payment_preimage: "original-preimage" },
    }]);
    expect(events.filter(event => event.kind === "quote" || event.kind === "submit")).toEqual([]);
    expect(journal.readInFlight(DVM_ID)).toEqual([]);
  }, 20_000);

  it("reclaims a stale lock after a killed submitter and recovers its journal instead of resubmitting", async () => {
    const first = start("submit");
    await first.wait("paused");
    const closed = once(first.child, "close");
    first.child.kill("SIGKILL");
    await closed;
    const [lock] = readdirSync(stateDir).filter(name => name.endsWith(".lock"));
    expect(lock).toBeDefined();
    // Simulate the documented crash grace period without a wall-clock delay.
    const stale = new Date(Date.now() - 31_000);
    utimesSync(join(stateDir, lock), stale, stale);
    const next = start("none", "PAID");
    expect(await next.done()).not.toHaveProperty("code");
    expect(next.events.filter(event => event.kind === "submit" || event.kind === "quote")).toEqual([]);
    expect(next.events.filter(event => event.kind === "mark")).toHaveLength(1);
    const journal = await import("../../../lib/melt-pending-log");
    expect(journal.readInFlight(DVM_ID)).toEqual([]);
    expect(readdirSync(stateDir).filter(name => name.endsWith(".lock"))).toEqual([]);
  }, 20_000);

  it("allows a different DVM to sweep while one DVM is locked", async () => {
    const first = start("batches");
    await first.wait("paused");
    const other = start("none", "UNPAID", "other-fixture");
    expect(await other.done()).toMatchObject({ code: "batches_failed" });
    expect(other.events.filter(event => event.kind === "submit")).toHaveLength(1);
    first.release();
    await first.done();
  }, 20_000);
});

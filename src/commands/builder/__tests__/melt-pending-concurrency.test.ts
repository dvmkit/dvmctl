import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DVM_ID = "concurrent-fixture";
const fixture = fileURLToPath(new URL("../../../../test-support/fixtures/melt-pending-process.mjs", import.meta.url));
interface Event { kind: string; code?: string; hint?: string; request?: unknown }

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

  function lockPath() {
    const key = createHash("sha256").update(DVM_ID).digest("hex");
    return join(stateDir, `melt-pending-${key}.lock`);
  }

  it.each([
    ["a live or reused PID", (): string => JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() })],
    ["a different host", (): string => JSON.stringify({ pid: 2_147_483_647, host: `${hostname()}.invalid`, token: randomUUID() })],
    ["an unknown host", (): string => JSON.stringify({ pid: 2_147_483_647, token: randomUUID() })],
    ["an invalid PID", (): string => JSON.stringify({ pid: -1, host: hostname(), token: randomUUID() })],
    ["incomplete metadata", (): string => "{"],
  ] as const)("refuses an aged lock with %s and explains manual clearance", async (_label, metadata) => {
    const path = lockPath();
    const contents = metadata();
    writeFileSync(path, contents);
    const stale = new Date(Date.now() - 86_400_000);
    utimesSync(path, stale, stale);
    const contender = start();
    const result = await contender.done();
    expect(result).toMatchObject({ code: "melt_pending_locked" });
    expect(result.hint).toContain(path);
    expect(result.hint).toContain("confirm no melt-pending run is active on any host");
    expect(result.hint).toContain("then remove");
    expect(contender.events.map(event => event.kind)).toEqual(["done"]);
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("requires manual clearance of a legacy lock directory", async () => {
    mkdirSync(lockPath());
    const contender = start();
    expect(await contender.done()).toMatchObject({ code: "melt_pending_locked" });
    expect(contender.events.map(event => event.kind)).toEqual(["done"]);
  });

  it("refuses when permission to inspect the owner is denied", async () => {
    const contents = JSON.stringify({ pid: 2_147_483_647, host: hostname(), token: randomUUID() });
    writeFileSync(lockPath(), contents);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    const { withMeltPendingLock } = await import("../../../lib/melt-pending-lock");
    let calls = 0;
    await expect(withMeltPendingLock(DVM_ID, () => { calls++; })).rejects.toMatchObject({ code: "melt_pending_locked" });
    expect(calls).toBe(0);
    expect(readFileSync(lockPath(), "utf8")).toBe(contents);
  });

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

  it.each(["batches", "mark"])("keeps a suspended owner exclusive past the former stale interval at %s", async stage => {
    const journal = stage === "mark" ? await seedRecovery() : undefined;
    const first = start(stage, "PAID");
    await first.wait("paused");
    expect(first.child.kill("SIGSTOP")).toBe(true);
    await setTimeout(32_000);
    expect(() => process.kill(first.child.pid!, 0)).not.toThrow();
    const second = start("none", "PAID");
    expect(await second.done()).toMatchObject({ code: "melt_pending_locked" });
    expect(second.events.map(event => event.kind)).toEqual(["done"]);
    expect(first.child.kill("SIGCONT")).toBe(true);
    first.release();
    const result = await first.done();
    const next = start("none", "PAID");
    expect(await next.done()).not.toHaveProperty("code");
    const events = [...first.events, ...second.events, ...next.events];
    if (journal) {
      expect(result).not.toHaveProperty("code");
      expect(events.filter(event => event.kind === "mark")).toHaveLength(1);
      expect(events.filter(event => event.kind === "quote" || event.kind === "submit")).toEqual([]);
      expect(journal.readInFlight(DVM_ID)).toEqual([]);
    } else {
      expect(result).toMatchObject({ code: "batches_failed" });
      expect(events.filter(event => event.kind === "quote")).toHaveLength(1);
      expect(events.filter(event => event.kind === "submit")).toHaveLength(1);
      expect(events.filter(event => event.kind === "mark")).toHaveLength(1);
    }
  }, 50_000);

  it("reclaims a dead submitter's fresh lock and recovers its journal instead of resubmitting", async () => {
    const first = start("submit");
    await first.wait("paused");
    const closed = once(first.child, "close");
    first.child.kill("SIGKILL");
    await closed;
    const [lock] = readdirSync(stateDir).filter(name => name.endsWith(".lock"));
    expect(lock).toBeDefined();
    const next = start("none", "PAID");
    expect(await next.done()).not.toHaveProperty("code");
    expect(next.events.filter(event => event.kind === "submit" || event.kind === "quote")).toEqual([]);
    expect(next.events.filter(event => event.kind === "mark")).toHaveLength(1);
    const journal = await import("../../../lib/melt-pending-log");
    expect(journal.readInFlight(DVM_ID)).toEqual([]);
    expect(readdirSync(stateDir).filter(name => name.endsWith(".lock"))).toEqual([]);
  }, 20_000);

  it("lets only one contender reclaim a dead submitter's lock", async () => {
    const first = start("submit");
    await first.wait("paused");
    const closed = once(first.child, "close");
    first.child.kill("SIGKILL");
    await closed;
    const contenders = [start("batches", "PAID"), start("batches", "PAID")];
    await vi.waitFor(() => {
      expect(contenders.filter(run => run.events.some(event => event.kind === "paused"))).toHaveLength(1);
      expect(contenders.filter(run => run.events.some(event => event.kind === "done"))).toHaveLength(1);
    }, { timeout: 10_000, interval: 10 });
    const winner = contenders.find(run => run.events.some(event => event.kind === "paused"))!;
    const loser = contenders.find(run => run !== winner)!;
    expect(await loser.done()).toMatchObject({ code: "melt_pending_locked" });
    expect(loser.events.map(event => event.kind)).toEqual(["done"]);
    winner.release();
    expect(await winner.done()).not.toHaveProperty("code");
    const events = contenders.flatMap(run => run.events);
    expect(events.filter(event => event.kind === "mark")).toHaveLength(1);
    expect(events.filter(event => event.kind === "quote" || event.kind === "submit")).toEqual([]);
    expect(readdirSync(stateDir).filter(name => name.includes(".lock"))).toEqual([]);
  }, 20_000);

  it("serializes different DVMs sharing the same proof inventory", async () => {
    const first = start("batches");
    await first.wait("paused");
    const other = start("none", "UNPAID", "other-fixture");
    expect(await other.done()).toMatchObject({ code: "melt_pending_locked" });
    expect(other.events.filter(event => event.kind === "submit")).toHaveLength(0);
    first.release();
    await first.done();
    const next = start("none", "UNPAID", "other-fixture");
    expect(await next.done()).toMatchObject({ code: "batches_failed" });
    expect(next.events.filter(event => event.kind === "submit")).toHaveLength(1);
  }, 20_000);
});

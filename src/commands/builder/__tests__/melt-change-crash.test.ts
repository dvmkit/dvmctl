import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = fileURLToPath(new URL("../../../../test-support/fixtures/melt-custody-process.mjs", import.meta.url));
describe("private change custody after process death", () => {
  let root: string;
  let children: ChildProcess[];
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "payout-crash-")); children = []; });
  afterEach(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, "close"); child.kill("SIGKILL"); await closed;
    }));
    rmSync(root, { recursive: true, force: true });
  });
  function start(stage = "none") {
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", fixture, stage], {
      env: { ...process.env, DVMKIT_CONFIG_DIR: root }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = ""; let stderr = "";
    child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { stderr += data; });
    const closed = once(child, "close");
    async function wait(field: "checkpoint" | "done") {
      await vi.waitFor(() => expect(output, stderr).toContain(`"${field}":`), { timeout: 15_000, interval: 10 });
      return JSON.parse(output.trim().split("\n").find(line => line.includes(`"${field}":`))!);
    }
    return { child, wait, closed, output: () => output + stderr, done: async () => {
      const done = await wait("done"); expect(await closed, stderr).toEqual([0, null]); return done;
    } };
  }
  function snapshot() { return JSON.parse(readFileSync(join(root, "melt-custody.json"), "utf8")).data; }

  it.each(["before_prepared", "prepared", "intent", "sent", "response", "imported", "acknowledged", "audit"])(
    "recovers the same proof identities after termination at %s", async stage => {
      const first = start(stage); await first.wait("checkpoint");
      const before = snapshot(); const saved = before.operations[0]?.outputs;
      first.child.kill("SIGKILL"); await first.closed;
      const next = start(); expect(await next.done()).not.toHaveProperty("code");
      const recovered = snapshot();
      if (["prepared", "intent"].includes(stage)) {
        // No request reached the offline mint. An uncertain intent is held indefinitely.
        expect(recovered.proofs).toHaveLength(0);
        expect(recovered.operations[0].outputs).toEqual(saved);
        expect((await start().done()).submissions).toBe(0);
      } else {
        expect(recovered.proofs.map((p: { proof: { amount: string } }) => p.proof.amount)).toEqual(["8", "1"]);
        if (saved) expect(recovered.operations[0].outputs).toEqual(saved);
        const identities = recovered.proofs.map((p: { identity: string }) => p.identity);
        expect((await start().done()).submissions).toBe(0);
        expect(snapshot().proofs.map((p: { identity: string }) => p.identity)).toEqual(identities);
        for (const record of recovered.proofs) expect(first.output() + next.output()).not.toContain(record.proof.secret);
      }
    }, 30_000
  );

  it("excludes a second recovery process and credits each output once", async () => {
    const first = start("sent"); await first.wait("checkpoint"); first.child.kill("SIGKILL"); await first.closed;
    const owner = start("check"); await owner.wait("checkpoint");
    const contender = start(); expect(await contender.done()).toMatchObject({ code: "melt_pending_locked", submissions: 0 });
    owner.child.kill("SIGCONT"); expect(await owner.done()).not.toHaveProperty("code");
    expect((await start().done()).submissions).toBe(0);
    expect(snapshot().proofs).toHaveLength(2);
    expect(snapshot().proofs.reduce((n: number, p: { proof: { amount: string } }) => n + Number(p.proof.amount), 0)).toBe(9);
  }, 30_000);
});

import type * as NodeFs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DevPaymentTracker,
  type DevSessionEvent,
  type ReloadingSession,
  startReloadingSession,
} from "../dev";

// Passes through to the real watcher so a test can read which directory it was given.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

// The real CLI entry under tsx, so each instance runs the same worker path an
// installed `dvmctl dev` spawns. tsx is resolved here because a bare `--import`
// resolves from the worker's cwd, which one test moves into the tmp project.
const CLI = [
  process.execPath,
  "--import",
  pathToFileURL(createRequire(__filename).resolve("tsx")).href,
  resolve(__dirname, "../../cli/dvmctl.ts"),
];

const suiteCwd = process.cwd();
let project: string;
let session: ReloadingSession | null;
let events: DevSessionEvent[];
let eventTimes: number[];
let testStartedAt: number;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "dvmctl-dev-reload-")));
  writeFileSync(join(project, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(project, "handler.ts"),
    [
      'import { message } from "./helper";',
      "export default {",
      '  config: { name: "Reload fixture", tags: ["text"], onJob(ctx: { complete(text: string): void }) { ctx.complete(message()); } },',
      "};",
      "",
    ].join("\n")
  );
  writeHelper("v1");
  session = null;
  events = [];
  eventTimes = [];
  testStartedAt = Date.now();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await session?.close();
  process.chdir(suiteCwd);
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

describe("dvmctl dev reload", () => {
  it("serves an edited helper after a reload triggered only by the helper", async () => {
    const port = await freePort();
    await start(port);
    expect(await runJob(port)).toBe("v1");

    writeHelper("v2");
    await nextEvent("serving");
    expect(await runJob(port)).toBe("v2");
  }, 60_000);

  it("coalesces a burst of edits into one replacement and leaves one live process", async () => {
    const port = await freePort();
    await start(port);
    for (let n = 2; n <= 6; n++) {
      writeHelper(`v${String(n)}`);
      await delay(40);
    }
    await nextEvent("serving");
    await delay(1_000);

    expect(events.filter((event) => event.type === "serving")).toHaveLength(2);
    expect(await runJob(port)).toBe("v6");
    const live = startedPids().filter(alive);
    expect(live).toEqual([lastServingPid()]);
  }, 60_000);

  it("keeps the previous version serving through a syntax error and recovers on the fix", async () => {
    const port = await freePort();
    await start(port);

    writeFileSync(join(project, "helper.ts"), 'export const message = (): string => "v2" +;\n');
    const failed = await nextEvent("reload-failed");
    expect(failed).toMatchObject({ serving: true });
    const message = failed.type === "reload-failed" ? failed.message : "";
    expect(message).toContain("helper.ts:1:");
    expect(message.match(/helper\.ts:\d+:\d+/g)).toHaveLength(1);
    expect(await runJob(port)).toBe("v1");

    writeHelper("v3");
    await nextEvent("serving");
    expect(await runJob(port)).toBe("v3");
  }, 60_000);

  it("names the local line that threw while a helper evaluated", async () => {
    const port = await freePort();
    // Each reload's worker inherits this cwd, as it inherits the directory a
    // builder runs `dvmctl dev` from, and paths are shown relative to it.
    process.chdir(project);
    await start(port);

    // The throw originates in a dependency; the report must skip its frame for
    // the helper line that called it, mapped back through the stripped types.
    mkdirSync(join(project, "node_modules", "fail-at-load"), { recursive: true });
    writeFileSync(
      join(project, "node_modules", "fail-at-load", "package.json"),
      '{"name":"fail-at-load","type":"module","exports":"./index.js"}\n'
    );
    writeFileSync(
      join(project, "node_modules", "fail-at-load", "index.js"),
      "export function fail(message) {\n  throw new Error(message);\n}\n"
    );
    writeFailingHelper("helper.ts could not load");
    const failed = await nextEvent("reload-failed");
    expect(failed).toMatchObject({ serving: true });
    const message = failed.type === "reload-failed" ? failed.message : "";
    // A message that names its own file still gets the line appended.
    expect(message).toBe("helper.ts could not load (at helper.ts:6:1)");
    expect(console.error).toHaveBeenCalledWith(`Reload failed: ${message}`);
    expect(await runJob(port)).toBe("v1");

    // A worker started outside the project shows the absolute path rather
    // than a relative climb.
    process.chdir(suiteCwd);
    writeFailingHelper("boom at load");
    const outside = await nextEvent("reload-failed");
    expect(outside.type === "reload-failed" ? outside.message : "").toBe(
      `boom at load (at ${join(project, "helper.ts")}:6:1)`
    );
    expect(await runJob(port)).toBe("v1");

    writeHelper("v3");
    await nextEvent("serving");
    expect(await runJob(port)).toBe("v3");
  }, 60_000);

  it("releases every process and the port when closed while a reload is in flight", async () => {
    const port = await freePort();
    await start(port);
    const before = startedPids().length;

    writeHelper("v2");
    await waitFor(() => startedPids().length > before);
    await session?.close();
    session = null;

    expect(startedPids().filter(alive)).toEqual([]);
    await expect(freePort(port)).resolves.toBe(port);
  }, 60_000);
});

// A stand-in worker that speaks the IPC protocol, reports its entry as the whole
// graph, and reports one paid job per instance.
const FAKE_WORKER = [
  process.execPath,
  "-e",
  `process.on("message", (m) => {
    if (m.type === "start") process.send({ type: "loaded", files: [process.argv.at(-1)] });
    if (m.type === "listen") {
      process.send({ type: "paid", event: { jobId: "job-" + process.pid, rail: "cashu", amountMicro: 10000, currency: "usd", testFunds: true } });
      process.send({ type: "listening" });
    }
    if (m.type === "close") process.exit(0);
  });`,
];

describe("dvmctl dev reload payment totals", () => {
  // Each instance reports one paid job, so the session total must survive the
  // instance it came from.
  it("accumulates paid jobs from every instance into one session total", async () => {
    const payments = new DevPaymentTracker();
    session = await startReloadingSession({
      entry: join(project, "handler.ts"),
      port: 0,
      env: {},
      payments,
      workerCommand: FAKE_WORKER,
      onEvent: recordEvent,
    });
    writeFileSync(join(project, "handler.ts"), "// touched\n");
    await nextEvent("serving", 2);

    const log = vi.mocked(console.log);
    log.mockClear();
    payments.printSummary();
    expect(log).toHaveBeenCalledWith("  Session total (2 paid jobs): $0.02 USD test funds");
  }, 30_000);
});

describe("dvmctl dev reload watcher", () => {
  it("recovers a write made before a new native watch delivers events", async () => {
    vi.mocked(watch).mockImplementationOnce(
      () =>
        ({
          on() {
            return this;
          },
          close() {},
        }) as unknown as ReturnType<typeof watch>
    );
    session = await startReloadingSession({
      entry: join(project, "handler.ts"),
      port: 0,
      env: {},
      payments: new DevPaymentTracker(),
      workerCommand: FAKE_WORKER,
      onEvent: recordEvent,
    });

    writeFileSync(join(project, "handler.ts"), "// touched before watch ready\n");
    await waitFor(() => events.filter((event) => event.type === "serving").length === 2, 2_000);
    await delay(450);
    expect(events.filter((event) => event.type === "serving")).toHaveLength(2);
  }, 10_000);

  it("watches a project reached through a path alias by its canonical directory", async () => {
    // A Windows 8.3 short name is such an alias, and watching one aborts the
    // process on the first change; a symlink is the portable stand-in.
    const aliasRoot = realpathSync(mkdtempSync(join(tmpdir(), "dvmctl-dev-alias-")));
    const alias = join(aliasRoot, "project");
    symlinkSync(project, alias, "junction");
    try {
      vi.mocked(watch).mockClear();
      session = await startReloadingSession({
        entry: join(alias, "handler.ts"),
        port: 0,
        env: {},
        payments: new DevPaymentTracker(),
        workerCommand: FAKE_WORKER,
        onEvent: recordEvent,
      });
      expect(vi.mocked(watch).mock.calls.map(([dir]) => dir)).toEqual([project]);

      writeFileSync(join(alias, "handler.ts"), "// touched\n");
      await nextEvent("serving", 2);
    } finally {
      await session?.close();
      session = null;
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

async function start(port: number): Promise<void> {
  session = await startReloadingSession({
    entry: join(project, "handler.ts"),
    port,
    env: {},
    payments: new DevPaymentTracker(),
    workerCommand: CLI,
    onEvent: recordEvent,
  });
}

function recordEvent(event: DevSessionEvent): void {
  events.push(event);
  eventTimes.push(Date.now() - testStartedAt);
}

function writeHelper(value: string): void {
  writeFileSync(
    join(project, "helper.ts"),
    `export const message = (): string => ${JSON.stringify(value)};\n`
  );
}

function writeFailingHelper(message: string): void {
  writeFileSync(
    join(project, "helper.ts"),
    [
      'import { fail } from "fail-at-load";',
      "interface Shape {",
      "  value: string;",
      "}",
      'const shape: Shape = { value: "v2" };',
      `fail(${JSON.stringify(message)});`,
      "export const message = (): string => shape.value;",
      "",
    ].join("\n")
  );
}

/** Resolve when the `count`-th event of `type` has arrived, counting from the session's start. */
async function nextEvent<T extends DevSessionEvent["type"]>(
  type: T,
  count?: number
): Promise<Extract<DevSessionEvent, { type: T }>> {
  const seen = events.filter((event) => event.type === type).length;
  const target = count ?? seen + 1;
  const since = events.length;
  await waitFor(
    () => {
      if (events.filter((event) => event.type === type).length >= target) return true;
      if (type === "serving") {
        const failure = events.slice(since).find((event) => event.type === "reload-failed");
        if (failure) throw new Error(`reload failed while waiting for serving: ${eventState()}`);
      }
      return false;
    },
    20_000,
    () => `event ${type} #${String(target)}: ${eventState()}`
  );
  return events.filter((event) => event.type === type)[target - 1] as Extract<
    DevSessionEvent,
    { type: T }
  >;
}

function eventState(): string {
  const timeline = events.map((event, index) => ({ atMs: eventTimes[index], ...event }));
  const watched = vi.mocked(watch).mock.calls.map(([directory]) => directory);
  const children = startedPids().map((pid) => ({ pid, alive: alive(pid) }));
  return JSON.stringify({ timeline, watched, children });
}

function startedPids(): number[] {
  return events.flatMap((event) => (event.type === "starting" ? [event.pid] : []));
}

function lastServingPid(): number | undefined {
  return events.flatMap((event) => (event.type === "serving" ? [event.pid] : [])).at(-1);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runJob(port: number): Promise<string> {
  const endpoint = `http://127.0.0.1:${String(port)}`;
  const submitted = (await (
    await fetch(`${endpoint}/v1/job`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "reload-fixture", data: "x" }),
    })
  ).json()) as { job_id: string; job_token: string };
  let result: string | undefined;
  await waitFor(async () => {
    const job = (await (
      await fetch(`${endpoint}/v1/job/${submitted.job_id}`, {
        headers: { "x-job-token": submitted.job_token },
      })
    ).json()) as { status: string; summary?: string };
    if (job.status !== "completed") return false;
    result = job.summary;
    return true;
  });
  return result ?? "";
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  describe = () => "condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${describe()}`);
    }
    await delay(50);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function freePort(port = 0): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        done(typeof address === "object" && address ? address.port : port);
      });
    });
  });
}

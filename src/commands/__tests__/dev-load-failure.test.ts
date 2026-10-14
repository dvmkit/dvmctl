import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  observeProcess,
  stopProcess,
  waitForProcessClose,
} from "../../../scripts/consumer-process.mjs";

const CLI = [resolve(__dirname, "../../../dist/dvmctl.js")];
const children = new Set<ChildProcess>();
const collections = new WeakMap<ChildProcess, Promise<void>>();

let project: string;

beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "dvmctl-dev-load-")));
  writeFileSync(join(project, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(project, "handler.ts"),
    [
      'import { message } from "./helper";',
      "export default {",
      '  config: { name: "Load fixture", tags: ["text"], onJob(ctx: { complete(text: string): void }) { ctx.complete(message()); } },',
      "};",
      "",
    ].join("\n")
  );
});

afterEach(async () => {
  await collectOwnedChildren();
  rmSync(project, { recursive: true, force: true });
});

async function collectOwnedChildren(): Promise<void> {
  await Promise.all([...children].map(collectChild));
}

function ownChild(child: ChildProcess): void {
  observeProcess(child);
  children.add(child);
}

function collectChild(child: ChildProcess): Promise<void> {
  const existing = collections.get(child);
  if (existing) return existing;
  const collecting = (async () => {
    // Retain ownership after the leader exits: its worker may still hold pipes or a port.
    if (!(await stopProcess(child)) || !(await waitForProcessClose(child, 1_000))) {
      throw new Error(`dev process tree ${String(child.pid)} did not stop`);
    }
    children.delete(child);
  })();
  collections.set(child, collecting);
  return collecting;
}

it.each([
  { name: "abandoned leader", exitLeader: false },
  ...(process.platform === "win32" ? [] : [{ name: "worker after leader exit", exitLeader: true }]),
])("collects an owned $name", async ({ exitLeader }) => {
  const ready = join(project, "worker.pid");
  const workerCode = `process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1_000);`;
  const leaderCode = `const child = require("node:child_process").spawn(process.execPath,
    ["-e", ${JSON.stringify(workerCode)}, ${JSON.stringify(ready)}], { stdio: "ignore" });
    ${exitLeader ? "child.unref();" : "setInterval(() => {}, 1_000);"}`;
  const child = spawn(process.execPath, ["-e", leaderCode], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  ownChild(child);
  let workerPid: number | undefined;
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error("owned worker did not start");
      await new Promise((done) => setTimeout(done, 20));
    }
    workerPid = Number(readFileSync(ready, "utf8"));
    if (exitLeader) expect(await waitForProcessClose(child, 1_000)).toBe(true);
    await collectOwnedChildren();
    expect(() => process.kill(workerPid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    // The failure control must not itself abandon the deliberately stubborn worker.
    await collectChild(child);
    if (workerPid) {
      try { process.kill(workerPid, "SIGKILL"); } catch { /* Already collected. */ }
    }
  }
}, 15_000);

const modes = [
  { name: "reload", flags: [] },
  { name: "--no-reload", flags: ["--no-reload"] },
];

describe.each(modes)("dvmctl dev first load ($name)", ({ flags }) => {
  it("reports the builder's throw with the local line that raised it", async () => {
    writeFailingHelper();
    const run = await dev(flags);
    expect(run.code).toBe(1);
    expect(run.error).toEqual({
      code: "handler_load_failed",
      message: "The handler failed to load: helper boom (at helper.ts:6:1)",
      hint: "Fix the error in the file it names, then run `dvmctl dev` again.",
    });
  }, 30_000);

  it("reports a syntax error with its location", async () => {
    writeFileSync(join(project, "helper.ts"), 'export const message = (): string => "v2" +;\n');
    const run = await dev(flags);
    expect(run.code).toBe(1);
    expect(run.error?.code).toBe("handler_load_failed");
    expect(run.error?.message).toMatch(/helper\.ts:1:\d+/);
  }, 30_000);

  it("reports a module that exports no descriptor", async () => {
    writeFileSync(join(project, "handler.ts"), "export const unrelated = 1;\n");
    const run = await dev(flags);
    expect(run.code).toBe(1);
    expect(run.error?.code).toBe("handler_load_failed");
    expect(run.error?.message).toContain(
      `No DVMDescriptor found in ${join(project, "handler.ts")}`
    );
  }, 30_000);
});

it("prints the builder's message and next step under --human", async () => {
  writeFailingHelper();
  const run = await dev(["--human"]);
  expect(run.code).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain(
    "Error: The handler failed to load: helper boom (at helper.ts:6:1)\nFix the error in the file it names, then run `dvmctl dev` again."
  );
}, 30_000);

describe("dvmctl dev port that cannot be bound", () => {
  let held: Server;
  let port: number;

  beforeEach(async () => {
    writeFileSync(join(project, "helper.ts"), 'export const message = (): string => "ok";\n');
    held = createServer();
    await new Promise<void>((done) => held.listen(0, done));
    port = (held.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((done) => held.close(() => done()));
  });

  it.each(modes)(
    "reports a taken port with the next step ($name)",
    async ({ flags }) => {
      const run = await dev(flags, String(port));
      expect(run.code).toBe(1);
      expect(run.error).toEqual({
        code: "dev_port_in_use",
        message: `Port ${port} is already in use.`,
        hint: "Stop the process listening on it (often an earlier `dvmctl dev` still running), or pass `--port` with a free port.",
        port,
      });
    },
    30_000
  );

  it("prints the taken port and next step under --human", async () => {
    const run = await dev(["--human"], String(port));
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(
      `Error: Port ${port} is already in use.\nStop the process listening on it`
    );
  }, 30_000);

  it.each(modes)(
    "reports any other listen failure ($name)",
    async ({ flags }) => {
      const run = await dev(flags, "70000");
      expect(run.code).toBe(1);
      expect(run.error?.code).toBe("dev_listen_failed");
      expect(run.error?.message).toMatch(/^Could not listen on port 70000: /);
      expect(run.error?.hint).toBe("Pass a different port with `--port`.");
    },
    30_000
  );
});

it.each(modes)("keeps a handler boot failure parseable ($name)", async ({ flags }) => {
  writeFileSync(join(project, "helper.ts"), 'export const message = (): string => "ok";\n');
  writeFileSync(
    join(project, "handler.ts"),
    'export default { config: { name: "Boot fixture", tags: ["text"], onBoot() { throw new Error("boot boom"); }, onJob() {} } };\n'
  );
  const run = await dev(flags);
  expect(run.code).toBe(1);
  const response = JSON.parse(run.stdout) as { error: { code: string } };
  expect(response.error.code).toBe("internal");
  expect(run.stderr).toContain('"event":"payment_mode"');
}, 30_000);

it("keeps SDK boot diagnostics visible under --human", async () => {
  writeFileSync(
    join(project, "handler.ts"),
    'export default { config: { name: "Boot fixture", tags: ["text"], onBoot() { throw new Error("boot boom"); }, onJob() {} } };\n'
  );
  const run = await dev(["--human"]);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain('"event":"payment_mode"');
  expect(run.stderr).toContain("Error: An unexpected internal error occurred (Error).");
}, 30_000);

it("delivers boot diagnostics before exiting when console.error is asynchronous", async () => {
  writeFileSync(
    join(project, "handler.ts"),
    'export default { config: { name: "Boot fixture", tags: ["text"], onBoot() { console.log("boot diagnostic %s", "READY"); throw new Error("boot boom"); }, onJob() {} } };\n'
  );
  const preload = join(project, "async-stderr.cjs");
  writeFileSync(
    preload,
    'const { format } = require("node:util"); console.error = (...args) => { setTimeout(() => process.stderr.write(format(...args) + "\\n"), 100); };\n'
  );
  const run = await dev(["--no-reload"], "0", ["--require", preload]);
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("boot diagnostic READY");
  expect(run.stderr).not.toContain("boot diagnostic %s");
  expect(run.error?.code).toBe("internal");
}, 30_000);

it.each(modes)("prints SDK diagnostics after successful startup ($name)", async ({ flags }) => {
  writeFileSync(join(project, "helper.ts"), 'export const message = (): string => "ok";\n');
  const stdout = await devUntilStarted(flags);
  expect(stdout).toContain('"event":"payment_mode"');
  expect(stdout).toContain('"event":"diagnostic.message"');
  expect(stdout).toContain("Dev server running at http://localhost:");
}, 30_000);

/** A helper whose throw originates in a dependency, so the local frame must be found below it. */
function writeFailingHelper(): void {
  mkdirSync(join(project, "node_modules", "fail-at-load"), { recursive: true });
  writeFileSync(
    join(project, "node_modules", "fail-at-load", "package.json"),
    '{"name":"fail-at-load","type":"module","exports":"./index.js"}\n'
  );
  writeFileSync(
    join(project, "node_modules", "fail-at-load", "index.js"),
    "export function fail(message) {\n  throw new Error(message);\n}\n"
  );
  writeFileSync(
    join(project, "helper.ts"),
    [
      'import { fail } from "fail-at-load";',
      "interface Shape {",
      "  value: string;",
      "}",
      'const shape: Shape = { value: "v2" };',
      'fail("helper boom");',
      "export const message = (): string => shape.value;",
      "",
    ].join("\n")
  );
}

interface DevRun {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: { code: string; message: string; hint?: string; port?: number };
}

function dev(flags: readonly string[], port = "0", nodeArgs: readonly string[] = []): Promise<DevRun> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...nodeArgs, ...CLI, "dev", "handler.ts", "--port", port, ...flags], {
      cwd: project,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    ownChild(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", fail);
    child.once("exit", (code) => {
      void collectChild(child).then(() => {
        let error: DevRun["error"];
        try {
          error = (JSON.parse(stdout) as { error?: DevRun["error"] }).error;
        } catch {
          error = undefined;
        }
        done({ code, stdout, stderr, error });
      }, fail);
    });
  });
}

function devUntilStarted(flags: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...CLI, "dev", "handler.ts", "--port", "0", ...flags], {
      cwd: project,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    ownChild(child);
    let stdout = "";
    let stderr = "";
    let started = false;
    const timer = setTimeout(() => {
      fail(new Error(`dev did not finish starting: ${stdout}\n${stderr}`));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!started && stdout.includes("Dev server running at http://localhost:")) {
        started = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", (err) => {
      clearTimeout(timer);
      fail(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      void collectChild(child).then(() => {
        if (started) done(stdout);
        else fail(new Error(`dev exited before startup (${String(code)}): ${stdout}\n${stderr}`));
      }, fail);
    });
  });
}

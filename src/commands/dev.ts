import { type ChildProcess, spawn } from "node:child_process";
import { type FSWatcher, realpathSync, statSync, watch } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";

import type { DVMDescriptor, ZodLike } from "@dvmkit/sdk";
import { DvmError } from "@dvmkit/sdk/internal";
import { type DVMServeResult, type PaidJobCompletion, serve } from "@dvmkit/sdk/server";

import { loadProjectEnvironment, mergeProjectEnvironment } from "../lib/dev-environment.ts";
import { blockUntilShutdown } from "../lib/keep-alive.ts";
import { loadDescriptor } from "../lib/load-handler.ts";
import { info } from "../shared/output.ts";

export interface DevOptions {
  port?: string;
  reload?: boolean;
  human?: boolean;
}

export async function dev(handlerPath: string, opts: DevOptions): Promise<void> {
  const absPath = resolve(process.cwd(), handlerPath);
  if (process.env[WORKER_ENV] === "1" && process.send) {
    await runDevWorker(absPath);
    return;
  }

  const env = resolveDevEnvironment();

  const configuredPort = Object.hasOwn(env, "PORT") ? env.PORT : undefined;
  const port = Number(opts.port ?? configuredPort ?? "3000");
  const payments = new DevPaymentTracker();

  if (opts.reload === false) {
    const loaded = await loadTracked(absPath);
    if (!loaded.ok) throw handlerLoadFailed(loaded.message);
    const { descriptor } = loaded;
    const server = await startServer(descriptor, port, env, (event) => {
      payments.observe(event);
    });
    printStartup(descriptor, port, server.paymentModes);
    payments.installExitSummary();
    await blockUntilShutdown(() => server);
    return;
  }

  const session = await startReloadingSession({ entry: absPath, port, env, payments });
  payments.installExitSummary();
  await blockUntilShutdown(() => session);
}

export function resolveDevEnvironment(
  cwd = process.cwd(),
  parent: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return mergeProjectEnvironment(parent, loadProjectEnvironment(cwd));
}

export interface ReloadingSessionOptions {
  entry: string;
  port: number;
  env: Record<string, string>;
  payments: DevPaymentTracker;
  /**
   * Executable plus leading arguments that start a dvmctl CLI; `dev <entry>` is
   * appended. Defaults to re-running the current CLI with its Node flags.
   */
  workerCommand?: readonly string[];
  debounceMs?: number;
  onEvent?: (event: DevSessionEvent) => void;
}

export type DevSessionEvent =
  | { type: "starting"; pid: number }
  | { type: "serving"; pid: number; files: string[] }
  | { type: "reload-failed"; message: string; serving: boolean }
  | { type: "exited"; pid: number };

export interface ReloadingSession {
  close: () => Promise<void>;
}

/**
 * Serve the handler from a child process and replace that process when any
 * local module in its import graph changes. A fresh process is the module-graph
 * isolation: Node's ESM cache cannot be invalidated in place, and handler
 * top-level timers, pools and sockets die with the process that owns them.
 *
 * A replacement is loaded before the serving instance is closed, so a syntax or
 * import error leaves the previous version answering on the port.
 */
export async function startReloadingSession(
  opts: ReloadingSessionOptions
): Promise<ReloadingSession> {
  const command = opts.workerCommand ?? defaultWorkerCommand();
  const debounceMs = opts.debounceMs ?? 300;
  const emit = opts.onEvent ?? (() => undefined);
  const spawnWorker = (): DevWorker => {
    const worker = new DevWorker(command, opts.entry, opts.port, opts.env, opts.payments);
    emit({ type: "starting", pid: worker.pid });
    return worker;
  };

  let active: DevWorker | null = null;
  let candidate: DevWorker | null = null;
  let graph: string[] = [opts.entry];
  // Mutated by close() while reloads are awaiting; read through isStopping().
  const lifecycle = { stopping: false };
  const isStopping = (): boolean => lifecycle.stopping;
  let pending = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let reconciliation: ReturnType<typeof setTimeout> | null = null;
  let draining: Promise<void> | null = null;
  let ready = false;
  let changedDuringStartup = false;

  const clearReconciliation = (): void => {
    if (reconciliation) clearTimeout(reconciliation);
    reconciliation = null;
  };

  const scheduleReload = (): void => {
    if (isStopping()) return;
    if (!ready) {
      changedDuringStartup = true;
      return;
    }
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      pending = true;
      draining ??= drain().finally(() => {
        draining = null;
      });
    }, debounceMs);
  };

  const watcher = new GraphWatcher(() => {
    scheduleReload();
  });

  const reconcileAfterRegistration = (before: Map<string, string>): void => {
    clearReconciliation();
    reconciliation = setTimeout(() => {
      reconciliation = null;
      if (isStopping()) return;
      if ([...before].some(([file, state]) => fileFingerprint(file) !== state)) {
        scheduleReload();
      }
    }, 100);
  };

  const watchGraph = (files: readonly string[]): void => {
    const before = graphFingerprints(files);
    watcher.watch(files);
    reconcileAfterRegistration(before);
  };

  const adopt = (worker: DevWorker, files: string[], initialSnapshot?: Map<string, string>): void => {
    active = worker;
    // Without tsx no graph is reported; a fresh process per reload still makes
    // watching the entry alone correct, just coarser.
    graph = union([opts.entry], files);
    if (initialSnapshot) reconcileAfterRegistration(initialSnapshot);
    else watchGraph(graph);
    ready = true;
    if (changedDuringStartup) {
      changedDuringStartup = false;
      scheduleReload();
    }
    worker.onUnexpectedExit = (code) => {
      if (active !== worker) return;
      active = null;
      console.error(
        `Dev server process exited unexpectedly (${code}). Save a watched file to start it again.`
      );
      emit({ type: "exited", pid: worker.pid });
    };
    emit({ type: "serving", pid: worker.pid, files });
  };

  const reloadOnce = async (): Promise<void> => {
    console.log("\nFile changed, reloading...");
    const next = spawnWorker();
    candidate = next;
    try {
      const loaded = await next.loaded;
      if (isStopping()) return;
      if (!loaded.ok) {
        graph = union(graph, loaded.files);
        watchGraph(graph);
        console.error(`Reload failed: ${loaded.message}`);
        console.log(
          active
            ? "Still serving the previous version. Fix the error and save again."
            : "No version is serving. Fix the error and save again."
        );
        emit({ type: "reload-failed", message: loaded.message, serving: active !== null });
        return;
      }
      const previous = active;
      active = null;
      if (previous) await previous.close();
      if (isStopping()) return;
      try {
        await next.listen();
      } catch (err) {
        if (isStopping()) return;
        const message = errorMessage(err);
        graph = union(graph, loaded.files);
        watchGraph(graph);
        console.error(`Reload failed: ${message}`);
        console.log("No version is serving. Fix the error and save again.");
        emit({ type: "reload-failed", message, serving: false });
        return;
      }
      if (isStopping()) return;
      adopt(next, loaded.files);
    } finally {
      candidate = null;
      if (active !== next) await next.kill();
    }
  };

  const drain = async (): Promise<void> => {
    while (pending && !isStopping()) {
      pending = false;
      await reloadOnce();
    }
  };

  const first = spawnWorker();
  const loaded = await first.loaded;
  if (!loaded.ok) {
    await first.kill();
    throw handlerLoadFailed(loaded.message);
  }
  graph = union([opts.entry], loaded.files);
  const initialSnapshot = graphFingerprints(graph);
  watcher.watch(graph);
  try {
    await first.listen();
  } catch (err) {
    watcher.close();
    await first.kill();
    throw err;
  }
  adopt(first, loaded.files, initialSnapshot);

  return {
    close: async () => {
      lifecycle.stopping = true;
      pending = false;
      if (debounce) clearTimeout(debounce);
      clearReconciliation();
      watcher.close();
      await candidate?.kill();
      await draining;
      await active?.close();
    },
  };
}

export function printStartup(
  descriptor: DVMDescriptor<unknown, ZodLike | undefined>,
  port: number,
  paymentModes: DVMServeResult["paymentModes"]
): void {
  console.log("");
  console.log(`  Dev server running at http://localhost:${port}`);
  console.log(`  Name:   ${descriptor.name}`);
  console.log(`  Tags:   ${descriptor.tags.join(", ")}`);
  if (descriptor.price !== undefined) console.log(`  Price:  ${JSON.stringify(descriptor.price)}`);
  printPaymentMode(paymentModes);
  console.log("");
  console.log(`  Test page: http://localhost:${port}/_dev`);
  console.log("");
  console.log(`  First call:`);
  console.log(firstCall(descriptor, port, paymentModes));
  console.log("");
}

/** Session-wide paid completion accumulator. Kept outside each reloaded SDK host. */
export class DevPaymentTracker {
  private readonly jobs = new Set<string>();
  private readonly totals = new Map<
    string,
    { amountMicro: number; currency: string; testFunds: boolean | null }
  >();

  observe(event: PaidJobCompletion): void {
    if (this.jobs.has(event.jobId)) return;
    this.jobs.add(event.jobId);
    const classification =
      event.testFunds === true ? "test" : event.testFunds === false ? "live" : "unknown";
    const key = `${event.currency}:${classification}`;
    const prior = this.totals.get(key);
    this.totals.set(key, {
      amountMicro: (prior?.amountMicro ?? 0) + event.amountMicro,
      currency: event.currency,
      testFunds: event.testFunds,
    });
    const funds =
      event.testFunds === true
        ? " test funds"
        : event.testFunds === false
          ? " live funds"
          : " funds not classified";
    console.log(
      `  Paid job ${event.jobId}: ${formatMoney(event.amountMicro, event.currency)} via ${event.rail}${funds}`
    );
    console.log(
      `  Session total (${this.jobs.size} job${this.jobs.size === 1 ? "" : "s"}): ${this.totalDisplay()}`
    );
  }

  printSummary(): void {
    if (this.jobs.size === 0) {
      console.log("  Session total: no paid jobs.");
      return;
    }
    console.log(
      `  Session total (${this.jobs.size} paid job${this.jobs.size === 1 ? "" : "s"}): ${this.totalDisplay()}`
    );
  }

  installExitSummary(): void {
    const print = (): void => {
      this.printSummary();
    };
    process.once("SIGINT", print);
    process.once("SIGTERM", print);
  }

  private totalDisplay(): string {
    return [...this.totals.values()]
      .map(({ amountMicro, currency, testFunds }) => {
        const classification =
          testFunds === true
            ? "test funds"
            : testFunds === false
              ? "live funds"
              : "funds not classified";
        return `${formatMoney(amountMicro, currency)} ${classification}`;
      })
      .join(" + ");
  }
}

const WORKER_ENV = "DVMKIT_DEV_WORKER";
const WORKER_CLOSE_TIMEOUT_MS = 5_000;

type ParentMessage =
  | { type: "start"; port: number; env: Record<string, string> }
  | { type: "listen" }
  | { type: "close" };

type WorkerMessage =
  | { type: "loaded"; files: string[] }
  | { type: "load-failed"; message: string; files: string[] }
  | { type: "listening" }
  | {
      type: "listen-failed";
      message: string;
      code?: string;
      hint?: string;
      data?: Record<string, unknown>;
    }
  | { type: "paid"; event: PaidJobCompletion };

type LoadResult = { ok: true; files: string[] } | { ok: false; message: string; files: string[] };

/** Parent-side handle for one child serving instance. */
class DevWorker {
  readonly pid: number;
  readonly loaded: Promise<LoadResult>;
  onUnexpectedExit: ((code: string) => void) | null = null;
  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private listening: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private closing = false;

  constructor(
    command: readonly string[],
    entry: string,
    port: number,
    env: Record<string, string>,
    payments: DevPaymentTracker
  ) {
    const [executable, ...args] = command;
    this.child = spawn(executable, [...args, "dev", entry], {
      env: { ...process.env, [WORKER_ENV]: "1" },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    this.pid = this.child.pid ?? -1;
    let settleLoad: (result: LoadResult) => void = () => undefined;
    this.loaded = new Promise((done) => {
      settleLoad = done;
    });
    this.exited = new Promise((done) => {
      this.child.once("exit", (code, signal) => {
        const status = signal ?? `exit code ${String(code)}`;
        settleLoad({
          ok: false,
          message: `the handler process ended before it loaded (${status})`,
          files: [],
        });
        this.listening?.reject(new Error(`the handler process ended (${status})`));
        this.listening = null;
        if (!this.closing) this.onUnexpectedExit?.(status);
        done();
      });
    });
    this.child.once("error", (err) => {
      settleLoad({
        ok: false,
        message: `could not start the handler process: ${err.message}`,
        files: [],
      });
    });
    this.child.on("message", (raw) => {
      const message = raw as WorkerMessage;
      switch (message.type) {
        case "loaded":
          settleLoad({ ok: true, files: message.files });
          break;
        case "load-failed":
          settleLoad({ ok: false, message: message.message, files: message.files });
          break;
        case "listening":
          this.listening?.resolve();
          this.listening = null;
          break;
        case "listen-failed":
          this.listening?.reject(
            message.code === undefined
              ? new Error(message.message)
              : new DvmError(message.code, message.message, message.hint, message.data)
          );
          this.listening = null;
          break;
        case "paid":
          payments.observe(message.event);
          break;
      }
    });
    this.send({ type: "start", port, env });
  }

  listen(): Promise<void> {
    return new Promise((done, fail) => {
      this.listening = { resolve: done, reject: fail };
      this.send({ type: "listen" });
    });
  }

  /** Ask the instance to close its server, and force it after a timeout. */
  async close(): Promise<void> {
    if (!this.running()) return;
    this.closing = true;
    this.send({ type: "close" });
    const timer = setTimeout(() => this.child.kill("SIGKILL"), WORKER_CLOSE_TIMEOUT_MS);
    await this.exited;
    clearTimeout(timer);
  }

  async kill(): Promise<void> {
    if (!this.running()) return;
    this.closing = true;
    this.child.kill("SIGKILL");
    await this.exited;
  }

  private running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null && this.pid > 0;
  }

  private send(message: ParentMessage): void {
    if (this.child.connected) this.child.send(message);
  }
}

/**
 * Child side of the reloading session: load once, serve when told to, forward
 * paid completions, and exit when closed or when the parent disappears.
 */
async function runDevWorker(entry: string): Promise<void> {
  Reflect.deleteProperty(process.env, WORKER_ENV);
  const send = (message: WorkerMessage): Promise<void> =>
    new Promise((done) => {
      if (!process.connected || !process.send) {
        done();
        return;
      }
      process.send(message, undefined, {}, () => {
        done();
      });
    });
  // The terminal delivers Ctrl-C to the whole process group; the parent owns
  // shutdown and closes this server through IPC instead.
  process.on("SIGINT", () => undefined);
  process.on("SIGTERM", () => undefined);

  // process.exit drops IPC writes still queued, so paid reports in flight are
  // awaited before exiting.
  const inFlight = new Set<Promise<void>>();
  const forward = (message: WorkerMessage): Promise<void> => {
    const sent = send(message).finally(() => inFlight.delete(sent));
    inFlight.add(sent);
    return sent;
  };

  let server: DVMServeResult | null = null;
  let exiting = false;
  const exit = async (code: number): Promise<never> => {
    if (!exiting) {
      exiting = true;
      await server?.close();
      await Promise.all(inFlight);
    }
    process.exit(code);
  };
  process.once("disconnect", () => void exit(0));

  const messages = messageQueue();
  const start = await messages.next("start");
  const loaded = await loadTracked(entry);
  if (!loaded.ok) {
    await send({ type: "load-failed", message: loaded.message, files: loaded.files });
    return exit(1);
  }
  const { descriptor } = loaded;
  await send({ type: "loaded", files: loaded.files });

  await messages.next("listen");
  try {
    server = await startServer(descriptor, start.port, start.env, (event) =>
      forward({ type: "paid", event })
    );
  } catch (err) {
    await send(
      err instanceof DvmError
        ? {
            type: "listen-failed",
            message: err.message,
            code: err.code,
            hint: err.hint,
            data: err.data,
          }
        : { type: "listen-failed", message: errorMessage(err) }
    );
    return exit(1);
  }
  printStartup(descriptor, start.port, server.paymentModes);
  await send({ type: "listening" });

  await messages.next("close");
  return exit(0);
}

function messageQueue(): {
  next: <T extends ParentMessage["type"]>(type: T) => Promise<Extract<ParentMessage, { type: T }>>;
} {
  const received: ParentMessage[] = [];
  const waiters: (() => void)[] = [];
  process.on("message", (raw) => {
    received.push(raw as ParentMessage);
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    next: async <T extends ParentMessage["type"]>(type: T) => {
      for (;;) {
        const index = received.findIndex((message) => message.type === type);
        if (index !== -1) {
          return received.splice(index, 1)[0] as Extract<ParentMessage, { type: T }>;
        }
        await new Promise<void>((wake) => waiters.push(wake));
      }
    },
  };
}

/**
 * Load the handler while collecting its local import graph, which both names
 * the files a reload watches and locates the builder's own frame in a failure.
 */
async function loadTracked(
  entry: string
): Promise<
  | { ok: true; descriptor: DVMDescriptor<unknown, ZodLike | undefined>; files: string[] }
  | { ok: false; message: string; files: string[] }
> {
  const imported = new Set<string>();
  try {
    const descriptor = await loadDescriptor(entry, { onImport: (url) => imported.add(url) });
    await loaderSettled();
    return { ok: true, descriptor, files: localFiles(imported) };
  } catch (err) {
    await loaderSettled();
    const files = localFiles(imported);
    return { ok: false, message: loadFailureMessage(err, files), files };
  }
}

/**
 * The generic error boundary redacts unknown errors because a dependency's
 * message can carry secrets. This one comes from the builder's own code running
 * on their machine, so it is published whole.
 */
function handlerLoadFailed(detail: string): DvmError {
  return new DvmError(
    "handler_load_failed",
    `The handler failed to load: ${detail}`,
    "Fix the error in the file it names, then run `dvmctl dev` again."
  );
}

/**
 * tsx reports imports over a MessagePort, so the last reports can trail the
 * import promise; a short turn of the event loop lets them arrive.
 */
function loaderSettled(): Promise<void> {
  return new Promise((done) => setTimeout(done, 25));
}

/** Local source in the import graph: `file:` modules outside any `node_modules`. */
function localFiles(urls: Iterable<string>): string[] {
  const files = new Set<string>();
  for (const url of urls) {
    if (!url.startsWith("file:")) continue;
    const path = fileURLToPath(url.split("?")[0]);
    if (path.split(/[\\/]/).includes("node_modules")) continue;
    files.add(path);
  }
  return [...files];
}

/**
 * An exception thrown while a module evaluates carries its location only in the
 * stack, so the first frame in the builder's own modules is appended. Frames in
 * dependencies, Node internals and dvmctl itself are never in the local graph,
 * nor are the esbuild frames that make up a syntax error's stack, so a syntax
 * error keeps the location tsx already put in its message.
 */
function loadFailureMessage(err: unknown, files: readonly string[]): string {
  const message = errorMessage(err);
  const stack = err instanceof Error ? err.stack : undefined;
  if (!stack) return message;
  const local = new Set(files);
  for (const line of stack.split("\n")) {
    const frame = /^\s*at (?:.*\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!frame) continue;
    const [, location, row, column] = frame;
    const path = location.startsWith("file:") ? fileURLToPath(location.split("?")[0]) : location;
    if (!local.has(path)) continue;
    const shown = relative(process.cwd(), path);
    const display = shown.startsWith("..") || isAbsolute(shown) ? path : shown;
    return `${message} (at ${display}:${row}:${column})`;
  }
  return message;
}

/**
 * Watches the directories that hold the graph's files rather than the files
 * themselves: editors that save by writing a temp file and renaming it replace
 * the inode, which silently ends a per-file watch.
 */
class GraphWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private files = new Set<string>();

  constructor(private readonly onChange: () => void) {}

  watch(files: readonly string[]): void {
    const canonical = files.map(canonicalPath);
    this.files = new Set(canonical);
    const dirs = new Set(canonical.map((file) => dirname(file)));
    for (const [dir, watcher] of this.watchers) {
      if (dirs.has(dir)) continue;
      watcher.close();
      this.watchers.delete(dir);
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, (_event, filename) => {
          if (filename === null || this.files.has(join(dir, basename(filename)))) this.onChange();
        });
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch {
        // A directory removed between load and watch has nothing left to watch.
      }
    }
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

function graphFingerprints(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => canonicalPath(file)).map((file) => [file, fileFingerprint(file)]));
}

function fileFingerprint(file: string): string {
  try {
    const { dev, ino, size, mtimeNs, ctimeNs } = statSync(file, { bigint: true });
    return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  } catch {
    return "missing";
  }
}

/**
 * Resolve a file's directory to its canonical spelling before watching it.
 * libuv 1.52 on Windows expands each changed file to its long name and asserts
 * that it starts with the watched directory, so watching an 8.3 short-name
 * directory such as `C:\PROGRA~1\app` aborts the process on the first save.
 */
function canonicalPath(file: string): string {
  try {
    return join(realpathSync.native(dirname(file)), basename(file));
  } catch {
    // A directory that no longer exists cannot be watched either.
    return file;
  }
}

function defaultWorkerCommand(): string[] {
  // An inspector flag would make the child fight the parent for its port.
  const nodeFlags = process.execArgv.filter((flag) => !flag.startsWith("--inspect"));
  return [process.execPath, ...nodeFlags, process.argv[1]];
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function startServer(
  descriptor: DVMDescriptor<unknown, ZodLike | undefined>,
  port: number,
  env: Record<string, string>,
  onPaid: (event: PaidJobCompletion) => void | Promise<void>
): Promise<DVMServeResult> {
  const mintsRaw = "DVMKIT_CASHU_MINTS" in env ? env.DVMKIT_CASHU_MINTS : undefined;
  const mints = mintsRaw ? mintsRaw.split(",").map((m) => m.trim()) : undefined;
  // The SDK prints before binding; a failed boot must leave stdout for the
  // CLI's JSON error envelope, while its diagnostics remain visible on stderr.
  const log = console.log;
  const startupLines: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    startupLines.push(args);
  };
  let listenError = false;
  let started = false;
  try {
    const server = await serve(descriptor, {
      port,
      env,
      devMode: true,
      mints,
      onPaidJobCompleted: onPaid,
    });
    started = true;
    return server;
  } catch (err) {
    if (isListenFailure(err)) {
      listenError = true;
      throw listenFailed(port, err);
    }
    throw err;
  } finally {
    console.log = log;
    if (!listenError) {
      for (const args of startupLines) {
        if (started) log(...args);
        else info(format(...args));
      }
    }
  }
}

function isListenFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const { code, syscall } = err as NodeJS.ErrnoException;
  return code === "EADDRINUSE" || syscall === "listen" || code === "ERR_SOCKET_BAD_PORT";
}

function listenFailed(port: number, err: unknown): DvmError {
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    return new DvmError(
      "dev_port_in_use",
      `Port ${port} is already in use.`,
      "Stop the process listening on it (often an earlier `dvmctl dev` still running), or pass `--port` with a free port.",
      { port }
    );
  }
  return new DvmError(
    "dev_listen_failed",
    `Could not listen on port ${port}: ${errorMessage(err)}`,
    "Pass a different port with `--port`.",
    { port }
  );
}

function printPaymentMode(paymentModes: DVMServeResult["paymentModes"]): void {
  const rails = ["cashu", "x402", "tempo"] as const;
  const configured = new Set<string>();
  let verificationRequired = false;
  let verifierAvailable = false;
  for (const mode of paymentModes) {
    if (mode.verification === "required") verificationRequired = true;
    for (const [rail, state] of Object.entries(mode.rails)) {
      if (state.status !== "absent") configured.add(rail);
      if (mode.verification === "required" && state.status === "verifying") {
        verifierAvailable = true;
      }
    }
  }
  for (const rail of rails) {
    const states = paymentModes.map((mode) => mode.rails[rail]);
    const state = states.find((candidate) => candidate.status !== "absent") ?? states[0];
    if (state.status === "absent") {
      console.log(`  ${rail}: absent (not configured)`);
    } else {
      const funds =
        state.testFunds === true
          ? "test funds"
          : state.testFunds === false
            ? "live funds"
            : "fund type unknown";
      console.log(`  ${rail}: ${state.status} (${funds})`);
    }
  }
  if (configured.size === 0) {
    console.log("  Payments: skipped; no payment rail is configured");
    console.log(
      "            Enable Cashu with DVMKIT_CASHU_MINTS, x402 with DVMKIT_X402_PAY_TO, or Tempo with DVMKIT_TEMPO_RECIPIENT."
    );
    console.log(
      "  dev_auto: /_dev may approve synthetic payments; CLI calls are free in this mode."
    );
    return;
  }
  if (verificationRequired && !verifierAvailable) {
    console.log("  Payments: required but unavailable; paid CLI calls fail closed");
  } else {
    console.log(`  Payments: ${verificationRequired ? "real verification" : "skipped"}`);
  }
  console.log(
    "  dev_auto: applies only to /_dev; caller CLI payments use the configured verifier."
  );
}

function firstCall(
  descriptor: DVMDescriptor<unknown, ZodLike | undefined>,
  port: number,
  paymentModes: DVMServeResult["paymentModes"]
): string {
  const capabilities = Object.entries(descriptor.capabilities);
  if (capabilities.length !== 1) {
    const names = capabilities.map(([name]) => name).join(", ");
    const first = capabilities[0]?.[0] ?? "<capability>";
    return `    Local endpoint calls cannot select among ${names || "multiple capabilities"}. Use /_dev, or after deployment run dvm request -d <handle>--<slug>/${first} --data <json>.`;
  }
  const capability = capabilities[0][1];
  const data = capability.example ?? "hello";
  const rail = effectiveRail(paymentModes);
  if (paymentModes.some((mode) => mode.verification === "required") && !rail) {
    return "    No paid caller command is available until a configured payment verifier recovers.";
  }
  const cap = typeof capability.price === "string" ? capability.price : undefined;
  const payment =
    rail && cap
      ? ` --rail ${rail} --budget ${shellQuote(cap)} --auto-pay-below ${shellQuote(cap)} --max-increment ${shellQuote(cap)} --max-payments 1`
      : "";
  return `    dvm request --endpoint http://localhost:${port} --data ${shellQuote(JSON.stringify(data))}${payment} </dev/null`;
}

function effectiveRail(paymentModes: DVMServeResult["paymentModes"]): string | undefined {
  for (const rail of ["cashu", "tempo", "x402"] as const) {
    if (paymentModes.some((mode) => mode.rails[rail].status === "verifying")) return rail;
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatMoney(amountMicro: number, currency: string): string {
  const amount = (amountMicro / 1_000_000).toFixed(6).replace(/\.?0+$/, "");
  return currency.toLowerCase() === "usd"
    ? `$${amount} USD`
    : `${amount} ${currency.toUpperCase()}`;
}

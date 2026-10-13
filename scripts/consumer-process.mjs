// @ts-check
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { basename } from "node:path";

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const INSTALL_COMMAND_TIMEOUT_MS = 300_000;
export const PROCESS_STOP_TIMEOUT_MS = 10_000;
const closeStates = new WeakMap();

/** @param {number} pid @param {NodeJS.Platform} [platform] */
export function processTreeTerminationCommand(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process tree termination requires a process id");
  return platform === "win32"
    ? { executable: "taskkill.exe", args: ["/pid", String(pid), "/t", "/f"] }
    : { executable: "kill", args: ["-TERM", `-${pid}`] };
}

/** @param {string} executable @param {string[]} args @param {{cwd?: string, env?: NodeJS.ProcessEnv, capture?: boolean, allowFailure?: boolean, timeout?: number}} [options] */
export async function processCommand(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  observeProcess(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const result = waitForResult(child);
  const timeout = options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let timeoutTimer;
  const timeoutSignal = new Promise((resolve) => { timeoutTimer = setTimeout(resolve, timeout); });
  const outcome = await Promise.race([result, timeoutSignal]);
  clearTimeout(timeoutTimer);
  // args[0] alone names only a flag for wrapped commands such as `cmd.exe /d /s /c ...`.
  const command = [basename(executable), ...args].join(" ");
  if (outcome === undefined) {
    const stopped = await stopProcess(child);
    if (!stopped) throw new Error(`${command} timed out after ${timeout}ms and its process tree did not stop within ${PROCESS_STOP_TIMEOUT_MS}ms`);
    throw new Error(`${command} timed out after ${timeout}ms`);
  }
  if (outcome.code !== 0 && !options.allowFailure) throw new Error(`${command} failed (${outcome.code}): ${stderr}`);
  return { code: outcome.code, stdout, stderr };
}

/** @param {import("node:child_process").ChildProcess} child */
export async function stopProcess(child) {
  observeProcess(child);
  if (process.platform === "win32") {
    if (child.exitCode !== null) return waitForProcessClose(child, PROCESS_STOP_TIMEOUT_MS);
    if (!child.pid) return false;
    const command = processTreeTerminationCommand(child.pid);
    await run(command.executable, command.args);
    return waitForProcessClose(child, PROCESS_STOP_TIMEOUT_MS);
  }
  if (!child.pid) return false;
  // The leader may have already exited, leaving children behind in its process group; signal the group regardless.
  // The leader's own close event says nothing about the rest of the group once the leader is already gone, so poll the group itself instead.
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (!isMissingProcess(error)) throw error; }
  if (await waitForProcessGroupExit(child.pid, 1_000)) return true;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (!isMissingProcess(error)) throw error; }
  return waitForProcessGroupExit(child.pid, PROCESS_STOP_TIMEOUT_MS);
}

/** @param {number} pid @param {number} timeout */
function waitForProcessGroupExit(pid, timeout) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeout;
    check();
    function check() {
      if (!isProcessGroupAlive(pid)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 20);
    }
  });
}

/** @param {number} pid */
function isProcessGroupAlive(pid) {
  // ESRCH is the only outcome that proves the group is empty; anything else (e.g. a transient EPERM
  // right as a just-spawned member is still settling into the group) must be treated as still alive.
  try { process.kill(-pid, 0); return true; } catch (error) { return !isMissingProcess(error); }
}

/** @param {string} directory */
export async function removeTemporaryDirectory(directory) {
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** @template T @param {() => Promise<T>} work @param {() => Promise<void>} cleanup */
export async function preservePrimaryFailure(work, cleanup) {
  return work().then(
    async (result) => { await cleanup(); return result; },
    async (primaryError) => { try { await cleanup(); } catch { /* Preserve the failure that made cleanup necessary. */ } throw primaryError; }
  );
}

/** @param {Array<() => Promise<void>>} cleanups */
export async function cleanupAll(cleanups) {
  const outcomes = await Promise.all(cleanups.map(async (cleanup) => {
    try { await cleanup(); return undefined; } catch (error) { return error; }
  }));
  const errors = outcomes.filter((outcome) => outcome !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "consumer smoke cleanup failed");
}

/** @param {import("node:child_process").ChildProcess} child */
export function observeProcess(child) {
  if (closeStates.has(child)) return;
  const state = { closed: false };
  closeStates.set(child, state);
  child.once("close", () => { state.closed = true; });
}

/** @param {import("node:child_process").ChildProcess} child */
function waitForResult(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1 }));
  });
}

/** @param {import("node:child_process").ChildProcess} child @param {number} timeout */
export function waitForProcessClose(child, timeout) {
  observeProcess(child);
  if (closeStates.get(child)?.closed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.removeListener("close", closed); resolve(false); }, timeout);
    function closed() { clearTimeout(timer); resolve(true); }
    child.once("close", closed);
  });
}

/** @param {string} executable @param {string[]} args */
function run(executable, args) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, PROCESS_STOP_TIMEOUT_MS);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** @param {unknown} error */
function isMissingProcess(error) { return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"; }

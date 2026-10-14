/**
 * Closes the two doors an ordinary test has onto killing its own vitest worker.
 * Wired into every vitest config through
 * `src/__tests__/setup-process-guard.ts`.
 *
 * Both doors land as the same thing, and it is the worst failure shape this repo
 * has: the worker dies before its file reports, so the run prints a full
 * **green** summary with no failing test, an `Unhandled Errors` block, and exit
 * 1. The main-process reporter can say "a worker died" from the main process; it
 * cannot say why, because by then the only process that knew is gone. These
 * guards run *inside* the worker, which is the only place the cause is visible.
 *
 * **Door one — emitting a signal.** `signal-exit` (v3, in the host's dependency
 * tree) keeps a `SIGINT`/`SIGTERM` listener, and when the live listener count
 * matches its own it reads the signal as fatal, unloads, and re-raises it for
 * real: `process.kill(process.pid, sig)`, `index.js:133`. Whether a test's
 * `process.emit("SIGINT")` lands while the code under test has registered its
 * handler is a race against an async boot, so this is a flake, not a property of
 * the file — which can kill the worker before it reports its file.
 * {@link installSignalGuards} keeps a listener of its own attached, so the count
 * never matches and `signal-exit` stays quiet.
 *
 * That listener discriminates between the two kinds of delivery, and it has to:
 * a listener that absorbed everything would also absorb vitest's own teardown.
 * `stop()` sends a fork `SIGTERM` and only `SIGKILL`s it 500 ms later
 * (`SIGKILL_TIMEOUT`, cli-api's `ForksPoolWorker`), and with `isolate: true` —
 * the default — that happens after *every test file*, not once at cancel. A
 * blanket absorb leaves each retired worker resident for that extra half-second
 * holding its heap, which on a suite retiring ~10 files/sec is several extra
 * live workers at all times: more peak RSS on the box whose documented failure
 * class is workers killed under memory pressure, which
 * is the shape this file exists to reduce.
 *
 * The discriminator is the argument. Node invokes a signal listener *with* the
 * signal name; a test's `process.emit("SIGINT")` passes nothing, and every
 * `process.emit` in this repo is argument-less — pinned by a test, since the
 * guard's correctness now rests on it. So {@link signalGuard} returns on the
 * argument-less call and re-raises the real one, which costs a real signal only
 * one extra pass over any listener registered ahead of the re-raise.
 *
 * That re-raise is unreachable under the threads pool `vitest.config.e2e.ts`
 * selects, and deliberately so: Node delivers a signal to the main thread only,
 * so a worker thread's listener fires for a synthetic emit and nothing else
 * (probed). A worker there can therefore never reach the `process.kill` below
 * and take the whole vitest process with it.
 *
 * **Door two — reaching `process.exit`.** Sixteen call sites stub it with
 * `vi.spyOn`, which `restoreMocks: true` unwinds the instant the test ends, so
 * an exit landing one tick late — a `.finally` after an async close, a timer, a
 * detached promise — reaches the real one and exits the worker with code 0.
 * {@link installExitGuard} replaces it with a throw. A synchronous call fails
 * the running test by name; a late one becomes an unhandled rejection vitest
 * reports against the run. Either way the worker lives and the stack names the
 * caller.
 *
 * A test that means to assert on an exit needs no migration: `vi.spyOn(process,
 * "exit")` shadows the guard, and `restoreMocks` restores *the guard* rather
 * than the real `process.exit` — so the escape hatch leaves the door shut.
 *
 * `src/test-support/__tests__/process-guard.test.ts` pins both guards and the
 * wiring.
 */
import { expect } from "vitest";

/** The signals `signal-exit` re-raises, and therefore the ones worth guarding. */
export const GUARDED_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Thrown in place of a worker-killing `process.exit` under test. */
export class StrayProcessExitError extends Error {
  /** The code the caller asked to exit with. */
  readonly exitCode: number | string | null | undefined;

  constructor(code: number | string | null | undefined, message: string) {
    super(message);
    this.name = "StrayProcessExitError";
    this.exitCode = code;
  }
}

/**
 * Attach this module's `SIGINT`/`SIGTERM` listeners, so `signal-exit` never
 * counts itself as the only listener and never re-raises a test's synthetic
 * emit for real. A real signal still terminates the worker — see the header.
 *
 * Idempotent, and cheap enough to call before every test — which the setup file
 * does, because `dev.test.ts` and `keep-alive.test.ts` both call
 * `process.removeAllListeners("SIGINT")` in an `afterEach` and would otherwise
 * disarm the guard for every file that follows in that worker.
 */
export function installSignalGuards(): void {
  for (const signal of GUARDED_SIGNALS) {
    if (!process.listeners(signal).includes(signalGuard)) process.on(signal, signalGuard);
  }
}

/**
 * Replace `process.exit` with a throw.
 *
 * A plain assignment on purpose: `restoreMocks: true` unwinds a `vi.spyOn` after
 * every test, which is the very hazard this guards. Nothing is handed back to
 * restore with, and nothing needs to be: setup files run once per test file, so
 * whatever the previous file left behind is overwritten here at the top of the
 * next one. Under the forks pool vitest also restores the real `process.exit`
 * after each file (its worker bootstrap captures it before any setup file
 * runs); the threads pool that `vitest.config.e2e.ts` selects has no equivalent,
 * which is why this reinstall — not that restore — is what the guard rests on.
 */
export function installExitGuard(): void {
  process.exit = exitGuard as typeof process.exit;
}

// --- Internal ---

function strayExitMessage(code: number | string | null | undefined): string {
  const where = currentTestName();
  return [
    `process.exit(${code === undefined ? "" : String(code)}) was called during a test.`,
    where ? `Running test: ${where}.` : null,
    "The exit was refused — letting it through kills the vitest worker, and a run that loses a",
    "worker prints an all-green summary and exits 1 with no failing test to read.",
    "The stack below names the caller. If this test means to assert on the exit, stub it:",
    '  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)',
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// A named function, so `process.listeners(sig).includes(signalGuard)` can tell
// this module's listener from anyone else's.
function signalGuard(signal?: NodeJS.Signals): void {
  // A test's `process.emit("SIGINT")` passes no argument. Absorbing it is the
  // whole mechanism: merely being listed already stopped `signal-exit` from
  // re-raising, and returning here keeps the worker alive.
  if (signal === undefined) return;
  // Node passes the name, so this is the kernel's — vitest retiring this worker
  // after its file, or someone at a terminal. Step out of the way and re-raise,
  // so the process dies now rather than at the SIGKILL 500 ms behind it.
  process.removeListener(signal, signalGuard);
  process.kill(process.pid, signal);
}

function exitGuard(code?: number | string | null): never {
  throw new StrayProcessExitError(code, strayExitMessage(code));
}

function currentTestName(): string | undefined {
  try {
    return expect.getState().currentTestName;
  } catch {
    // Called outside a test (a stray timer between files) — the stack still names the caller.
    return undefined;
  }
}

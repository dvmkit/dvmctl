/**
 * Installs the worker-survival guards for every test file. The two
 * doors they close — a stray signal `signal-exit` re-raises for real, and a
 * `process.exit` that outlives the spy stubbing it — are documented in
 * `src/test-support/process-guard.ts`.
 *
 * A setup file rather than a `globalSetup` entry: both guards act on the
 * `process` of the worker running the tests, and `globalSetup` runs in the main
 * process, where neither hazard lives. Ordering against the other setup files
 * does not matter — nothing here touches `fetch`, the environment, or a module
 * registry.
 *
 * The exit guard is installed once, at load. Reinstalling it per test would
 * clobber a file that legitimately assigns its own stub in a `beforeAll` (as
 * `dev.test.ts` does). The signal guard is the opposite case: two files clear
 * every signal listener in an `afterEach`, so it is reattached before each test.
 *
 * `src/test-support/__tests__/process-guard.test.ts` pins both, and pins this
 * file into all four vitest configs.
 */
import { beforeEach } from "vitest";

import { installExitGuard, installSignalGuards } from "./process-guard";

installExitGuard();
installSignalGuards();

beforeEach(installSignalGuards);

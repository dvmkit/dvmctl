/**
 * Redirects every CLI state root into a throwaway tree for the duration of a
 * `vitest` run, so a test suite can never write into the developer's real
 * `$HOME`. Consumed by the vitest configs as `test.env`.
 *
 * What it fixes: a full `npm test` used to leave three artifacts in the real
 * `~/.dvm` — `btc-rate.json` (any suite reaching `fetchBtcUsdRate` through
 * production code, e.g. `https-e2e.test.ts` → `deriveAdvisorySats`),
 * `config.json` (any config mutation), and `messages/job-*.jsonl`. The rate
 * cache is the sharp one: the suite stamped the canned `TEST_BTC_USD_RATE` over the
 * operator's genuine cached rate, so a `dvm quote` in the next five minutes
 * priced against a fake number. And since every worktree and every
 * concurrently-running agent shares one `$HOME`, those were cross-agent writes
 * to a single non-atomic file.
 *
 * Why `test.env` and not a fifth `setupFiles` entry: `src/defaults.ts` resolves
 * `CONFIG_DIR` **once at import time**, so the override has to be in
 * `process.env` before any module reads it. Vitest applies `test.env` in
 * `setupCommonEnv`, which runs before `startTests` — i.e. before setup files
 * are imported, let alone test files — so there is no ordering assumption to
 * make against the four existing setup files (one of which already imports
 * from `src/lib/`). It is also re-applied per test file, so `defaults.test.ts`
 * deleting `DVM_CONFIG_DIR` to assert the `~/.dvm` default can't leak into the
 * next file sharing that worker.
 *
 * One root per `vitest` invocation, shared by every fork. That is exactly the
 * shape CI's `~/.dvm` already has — empty at the start of a run, accumulating
 * as it goes — so it adds no cross-file coupling that CI doesn't already prove
 * stable. Suites needing *pristine* state per test set their own
 * `DVM_CONFIG_DIR` in a `beforeEach` (see `wallet-set-default-rail.test.ts`).
 *
 * An env var already set by the caller wins, so
 * `DVM_CONFIG_DIR=$(mktemp -d) npm test` still directs state where you asked.
 * (The money-loop and payment-smoke harnesses are `tsx` entrypoints rather than
 * `vitest` runs, so none of this reaches them either way — `npm run smoke`
 * picks its own `DVM_CONFIG_DIR` in `package.json`.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `test.env` entries pointing the consumer (`~/.dvm`), builder (`~/.dvmkit`)
 * and builder-auth (`~/.dvmctl`) state roots at a fresh temp tree. Creates the
 * root on first call; {@link removeCliStateSandbox} takes it away again.
 *
 * The root is parked on `DVMKIT_TEST_STATE_ROOT` because vitest bundles the
 * config separately from the `globalSetup` module, so this file can evaluate
 * more than once per run — going through the environment keeps both instances
 * pointed at the same directory instead of each minting one and leaking the
 * other.
 *
 * The vars are also applied to the calling process, not just returned. `test.env`
 * only reaches the *workers* (it is applied in `setupCommonEnv`), so without this
 * the vitest main process — and therefore any `globalSetup` file — would still
 * resolve the real `~/.dvm`. Nothing in a `globalSetup` touches CLI state today
 * (`src/e2e/global-setup.ts` is Postgres-only), but assigning here makes the
 * invariant hold process-wide for free.
 */
export function cliStateSandboxEnv(): Record<string, string> {
  const root = (process.env.DVMKIT_TEST_STATE_ROOT ??= mkdtempSync(
    join(tmpdir(), "dvmkit-test-state-")
  ));
  const env = {
    DVM_CONFIG_DIR: process.env.DVM_CONFIG_DIR ?? join(root, ".dvm"),
    DVMKIT_CONFIG_DIR: process.env.DVMKIT_CONFIG_DIR ?? join(root, ".dvmkit"),
    DVMCTL_CONFIG_DIR: process.env.DVMCTL_CONFIG_DIR ?? join(root, ".dvmctl"),
  };
  Object.assign(process.env, env);
  return env;
}

/** Remove the sandbox root, so a run leaves no temp directory behind. */
export function removeCliStateSandbox(): void {
  const root = process.env.DVMKIT_TEST_STATE_ROOT;
  if (!root) return;
  rmSync(root, { recursive: true, force: true });
  delete process.env.DVMKIT_TEST_STATE_ROOT;
}

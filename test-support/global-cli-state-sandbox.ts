/**
 * `globalSetup` half of the CLI state sandbox. The `test.env` half
 * — `cliStateSandboxEnv()` in `./cli-state-sandbox.ts` — creates the throwaway
 * root when the config is evaluated; this removes it once the run is over, so
 * no temp directory survives a `vitest` invocation.
 */
import { removeCliStateSandbox } from "./cli-state-sandbox";

/** Runs before any test file; the returned teardown runs after the last one. */
export function setup(): () => void {
  return () => {
    removeCliStateSandbox();
  };
}

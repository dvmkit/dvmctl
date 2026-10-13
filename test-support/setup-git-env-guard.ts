/**
 * Sanitises the worker's own environment so **nothing** a test run spawns can be
 * redirected at the checkout it is running inside. The mechanism, and
 * the `core.bare = true` a leaked `GIT_DIR` writes into the shared config, is
 * documented in `src/test-support/git-sandbox.ts`.
 *
 * Why a setup file rather than a fifth `test.env` entry, next to the CLI state
 * sandbox: this fix is an **unset**, and `test.env` can only set keys. Setup files
 * run inside the worker before the test module loads, so the sanitised environment
 * is inherited by every `git` a test spawns — including the ones production code
 * spawns on its own (`isPackagedTreeDirty`, `readGitHead`, `src/lib/git-distance.ts`),
 * which a per-fixture helper cannot reach. Ordering against the other setup files
 * does not matter: none of them read the environment at import time, and no test
 * module has been loaded yet.
 *
 * `git-config-isolation.test.ts` pins both the effect and the wiring.
 */
import { sanitizeGitEnv } from "../src/test-support/git-sandbox";

sanitizeGitEnv(process.env);

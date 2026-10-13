/**
 * Isolation for tests that drive real `git`, so a suite can neither read the
 * operator's git configuration nor write to the repository it is running inside.
 *
 * The failure this exists for. Git exports a set of *checkout-local* variables —
 * `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and friends —
 * before it invokes a hook, and anything the hook runs inherits them. A fixture
 * that then initialises its own throwaway repository does not get one: `git init`
 * honours the inherited `GIT_DIR` and re-initialises the *invoking* checkout.
 * Worse, a worktree's git dir is `…/.git/worktrees/<name>`, which does not end in
 * `.git`, so with no `GIT_WORK_TREE` to contradict it git infers the repository is
 * bare and writes `core.bare = true` — into the **common** config, shared by the
 * main checkout and every worktree off it. Every sibling then reports
 * `git rev-parse --is-inside-work-tree` as `false`, and any test that shells out
 * to git fails for reasons that live in another agent's session. Reproduced
 * end-to-end in `src/__tests__/git-config-isolation.test.ts`.
 *
 * This module guards every test regardless of the invoking environment, so
 * no test can reach the
 * checkout it is running in.
 *
 * Two layers, because a helper alone is not enough. `src/__tests__/setup-git-env-guard.ts`
 * sanitises `process.env` in every worker, which is what covers the *production*
 * code a test drives — `isPackagedTreeDirty`, `readGitHead`, `src/lib/git-distance.ts`
 * all spawn git with the ambient environment. {@link gitRunner} / {@link gitSandboxEnv}
 * are for fixtures that spawn git themselves, and additionally supply a committer
 * identity so no fixture has to write `user.name` / `user.email` into a config file
 * at all.
 */
import { execFileSync } from "node:child_process";

/**
 * The variables git reports as belonging to one checkout (`git rev-parse
 * --local-env-vars`), any of which redirects a `git` invocation away from its
 * `cwd` and at whatever repository exported them.
 *
 * Hardcoded rather than shelled out for, so the guard costs no spawn per worker —
 * and a superset of what any one git release lists, since deleting a variable this
 * git does not know is free. `git-config-isolation.test.ts` asserts this list
 * covers the local git's own answer, so a release that adds one fails there
 * instead of quietly reopening the hole.
 */
export const GIT_CHECKOUT_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

/** The committer a fixture repository gets, unless it asks for another. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "DVMKit Test",
  GIT_AUTHOR_EMAIL: "test@dvmkit.local",
  GIT_COMMITTER_NAME: "DVMKit Test",
  GIT_COMMITTER_EMAIL: "test@dvmkit.local",
} as const;

/**
 * Strip every {@link GIT_CHECKOUT_ENV_VARS} entry from `env` and point git's
 * global and system config at `/dev/null`, in place.
 *
 * The unset is the part that keeps a run from writing to the checkout it is in.
 * Pinning the config files is the other half of the same idea, and lands a local
 * run on CI's behaviour — an empty config — rather than the developer's: a global
 * `commit.gpgsign = true` otherwise blocks a fixture's first commit on a pinentry
 * prompt until the test times out, and a global `core.hooksPath` fires the
 * repository's own hooks inside a fixture. The one behaviour it takes away is the
 * operator's `core.excludesFile`, which `git ls-files --exclude-standard` reads —
 * the two repo-wide source scans that use it (`source-hygiene.test.ts`,
 * `fx-network-isolation.test.ts`) already run that way in CI.
 */
export function sanitizeGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // `Reflect.deleteProperty` rather than `delete env[name]`: assigning `undefined`
  // to a `process.env` key stores the string "undefined", so the variable has to go
  // away rather than be blanked.
  for (const name of GIT_CHECKOUT_ENV_VARS) Reflect.deleteProperty(env, name);
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

/**
 * A sanitised copy of `process.env` carrying a committer identity, for a test
 * spawning `git` itself. `overrides` win, so a suite asserting on a particular
 * author name sets it here rather than writing it into a config file.
 */
export function gitSandboxEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...sanitizeGitEnv({ ...process.env }),
    ...IDENTITY,
    // Nothing a fixture does should be able to sit waiting for a credential.
    GIT_TERMINAL_PROMPT: "0",
    ...overrides,
  };
}

/**
 * A `git` runner bound to a working directory, isolated per {@link gitSandboxEnv}
 * and returning stdout as a string.
 *
 * `cwd` takes a getter as well as a path, so a suite that mints a fresh temp
 * repository per test can build the runner once at describe scope. A failing
 * command throws with git's stderr in the message — `execFileSync` puts it on the
 * error object where a test report never shows it.
 */
export function gitRunner(
  cwd: string | (() => string),
  overrides: Record<string, string> = {}
): (...args: string[]) => string {
  const env = gitSandboxEnv(overrides);
  return (...args: string[]): string => {
    const dir = typeof cwd === "function" ? cwd() : cwd;
    try {
      return execFileSync("git", args, {
        cwd: dir,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
      throw new Error(`git ${args.join(" ")} failed in ${dir}${stderr ? `\n${stderr}` : ""}`, {
        cause: error,
      });
    }
  };
}

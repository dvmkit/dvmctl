/**
 * `globalSetup` half of the git-configuration guard: reads the state
 * that decides whether this checkout is still a usable working tree, once before
 * the first test file and once after the last, and fails the run if it moved.
 *
 * The failure it catches is not local. `.git/config` is shared by the main
 * checkout and every worktree off it, so one fixture that initialises a repository
 * under a leaked `GIT_DIR` sets `core.bare = true` for all of them — and the agent
 * who notices is whichever one next runs a test that shells out to git, in a
 * session with no visibility into what wrote it (see `src/test-support/git-sandbox.ts`
 * for the mechanism). `setup-git-env-guard.ts` is what prevents it; this is what
 * would say so, in one message, if some other path found its way in.
 *
 * Only the keys that invalidate a worktree are compared, not the whole config
 * file: a sibling worktree's `git push -u` legitimately writes `branch.*` into the
 * same shared file mid-run, and a guard that reds a green suite for that would be
 * turned off within a week.
 *
 * No-op outside a git repository (an unpacked tarball, a Docker build context), and
 * every read is best-effort — a diagnostic must not be the reason a run fails.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { gitSandboxEnv } from "../src/test-support/git-sandbox";

const ROOT = resolve(import.meta.dirname, "..");

/** The git state a stray `git init` in this checkout would change. */
const PROBES = [
  ["core.bare", ["config", "--get", "core.bare"]],
  ["core.worktree", ["config", "--get", "core.worktree"]],
  ["is-inside-work-tree", ["rev-parse", "--is-inside-work-tree"]],
  ["is-bare-repository", ["rev-parse", "--is-bare-repository"]],
] as const;

/** One reading of {@link PROBES}; a key is absent when the command exits non-zero. */
export type GitState = Record<string, string | undefined>;

/** Runs before any test file; the returned teardown runs after the last one. */
export function setup(): () => void {
  const before = readGitState();
  if (!before) return noop;

  return () => {
    const after = readGitState();
    if (!after) return;

    const message = describeGitDrift(before, after, ROOT);
    if (!message) return;

    // Printed as well as thrown: a teardown error can be reported at a distance
    // from the run's own output, and this one needs to be read.
    console.error(message);
    throw new Error(message);
  };
}

/**
 * The message for a run that moved the checkout's git state, or `null` when it
 * didn't. Separate from {@link setup} so the wording and the repair commands are
 * testable without mutating a real repository — a guard whose failure path has
 * never run is a guard nobody has checked.
 */
export function describeGitDrift(before: GitState, after: GitState, root: string): string | null {
  const drifted = PROBES.map(([key]) => key).filter((key) => before[key] !== after[key]);
  if (drifted.length === 0) return null;

  const repair = drifted
    .filter((key) => key.startsWith("core."))
    .map((key) =>
      before[key] === undefined
        ? `git -C ${root} config --unset ${key}`
        : `git -C ${root} config ${key} ${before[key]}`
    );

  return [
    "── SHARED GIT CONFIG MUTATED ──",
    `The run changed this checkout's git state at ${root}:`,
    ...drifted.map((key) => `  ${key}: ${format(before[key])} → ${format(after[key])}`),
    "",
    ".git/config is shared with every sibling worktree, so this breaks them too.",
    "A test that spawns `git` must go through src/test-support/git-sandbox.ts.",
    ...(repair.length > 0 ? ["", "Restore with:", ...repair.map((cmd) => `  ${cmd}`)] : []),
  ].join("\n");
}

/**
 * The probe values for a checkout, or `undefined` when `root` is not one. Takes the
 * root so the guard can be pointed at a throwaway repository under test.
 */
export function readGitState(root: string = ROOT): GitState | undefined {
  const env = gitSandboxEnv();
  const run = (args: readonly string[]): string | undefined => {
    try {
      return execFileSync("git", [...args], {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // An unset config key exits 1, as does every command outside a repository.
      return undefined;
    }
  };

  if (run(["rev-parse", "--git-dir"]) === undefined) return undefined;
  return Object.fromEntries(PROBES.map(([key, args]) => [key, run(args)]));
}

function format(value: string | undefined): string {
  return value ?? "unset";
}

function noop(): void {
  // Not a git checkout, so there is no shared configuration to protect.
}

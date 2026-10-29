import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DvmError } from "@dvmkit/sdk/internal";

import { readPackageJson } from "../../lib/deploy-attestation.ts";

/** Extra exclusions apply even to tracked files, at any depth. */
export const TARBALL_EXCLUDES = [
  "node_modules", ".git", "dist", ".env", ".env.*", ".vercel", ".next",
  ".turbo", "coverage", "*.tsbuildinfo", ".cache",
  // Verification logs, screenshot baselines, and agent state are not image inputs.
  ".verify-logs",
  "*.spec.*-snapshots", "*.test.*-snapshots", ".claude", ".codex",
  // Credential stores never belong in an image, however wide the context is.
  ".ssh", ".aws", ".dvm", ".dvmkit", ".dvmctl",
] as const;

/** Markers that a folder installs its own dependencies, across package managers. */
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

export interface BuildContext {
  /** Absolute folder uploaded for the remote build. */
  contextRoot: string;
  /** Dockerfile location relative to `contextRoot`, posix-separated. */
  dockerfilePath: string;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function gitTopLevel(cwd: string): string | null {
  try {
    const top = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
    return top ? realpathSync(top) : null;
  } catch {
    return null;
  }
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function configuredBuildContext(cwd: string, override: string | undefined): { value: string; source: string } | null {
  if (override !== undefined) return { value: override, source: "--context" };
  const dvmkit = readPackageJson(cwd)?.dvmkit;
  if (dvmkit == null || typeof dvmkit !== "object") return null;
  const raw = (dvmkit as { buildContext?: unknown }).buildContext;
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new DvmError("invalid_build_context",
      "`package.json#dvmkit.buildContext` must be a folder path relative to the DVM folder.",
      "Set `dvmkit.buildContext` to a string such as \"..\" or remove it to upload the DVM folder alone.");
  }
  return { value: raw, source: "package.json#dvmkit.buildContext" };
}

/**
 * Decide which folder a deploy uploads. The DVM folder itself unless `--context` or
 * `package.json#dvmkit.buildContext` names a folder that contains it; never a guess.
 * A lockfile-less DVM under a repository folder that has one is refused rather than
 * silently widened, because that layout is where the whole parent used to ship.
 */
export function resolveBuildContext(cwd: string, override?: string): BuildContext {
  const dvmDir = realpathSync(cwd);
  const topLevel = gitTopLevel(dvmDir);
  const configured = configuredBuildContext(cwd, override);
  if (configured === null) {
    if (topLevel !== null && !LOCKFILES.some((name) => existsSync(join(dvmDir, name)))) {
      for (let dir = dirname(dvmDir); contains(topLevel, dir); dir = dirname(dir)) {
        const lockfile = LOCKFILES.find((name) => existsSync(join(dir, name)));
        if (lockfile) {
          throw new DvmError("build_context_required",
            `The DVM folder has no lockfile, but ${join(dir, lockfile)} is in the same repository. Only the DVM folder is uploaded unless a wider build context is named explicitly.`,
            `Set \`dvmkit.buildContext\` in package.json (or pass --context) to "${toPosix(relative(dvmDir, dir))}" to upload that folder, or add the DVM's own lockfile to build it alone.`,
            { dvm_dir: dvmDir, lockfile_dir: dir });
        }
        if (dir === topLevel) break;
      }
    }
    return { contextRoot: dvmDir, dockerfilePath: "Dockerfile" };
  }
  const refuse = (reason: string): DvmError => new DvmError("invalid_build_context",
    `Invalid build context ${JSON.stringify(configured.value)} from ${configured.source}: ${reason}`,
    "Name a folder relative to the DVM folder that contains it, such as \"..\" or \"../..\", or remove the setting to upload the DVM folder alone.",
    { value: configured.value, source: configured.source });
  if (configured.value.trim() === "" || isAbsolute(configured.value)) throw refuse("expected a non-empty relative path.");
  const candidate = resolve(dvmDir, configured.value);
  let contextRoot: string;
  try {
    contextRoot = realpathSync(candidate);
    if (!statSync(contextRoot).isDirectory()) throw refuse("not a folder.");
  } catch (error) {
    if (error instanceof DvmError) throw error;
    throw refuse("the folder does not exist.");
  }
  if (!contains(contextRoot, dvmDir)) throw refuse("the build context must contain the DVM folder.");
  if (topLevel !== null && !contains(topLevel, contextRoot)) throw refuse(`the build context must stay inside the repository at ${topLevel}.`);
  return { contextRoot, dockerfilePath: toPosix(relative(contextRoot, join(dvmDir, "Dockerfile"))) };
}

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

const excludePatterns = TARBALL_EXCLUDES.map((pattern) => new RegExp(`^${pattern.split("*")
  .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));

function isPackaged(path: string): boolean {
  return !path.split("/").some((segment) => excludePatterns.some((pattern) => pattern.test(segment)));
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
}

function gitContextError(): DvmError {
  return new DvmError("deploy_context_git_failed", "Could not inspect git-visible build context files.",
    "Check that git rev-parse --is-inside-work-tree and git ls-files --cached --others --exclude-standard succeed in the build context, then retry.");
}

function hasGitBoundary(cwd: string): boolean {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return true;
  try {
    let dir = realpathSync(cwd);
    for (;;) {
      try {
        lstatSync(join(dir, ".git"));
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return true;
      }
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  } catch {
    // An inaccessible boundary cannot establish that an unrestricted walk is safe.
    return true;
  }
}

function gitVisiblePaths(cwd: string): string[] | null {
  let insideWorkTree = false;
  try {
    insideWorkTree = git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    // Only a context with no repository boundary may use the non-git fallback.
  }
  if (!insideWorkTree) {
    if (hasGitBoundary(cwd)) throw gitContextError();
    return null;
  }
  try {
    return [...new Set(git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."])
      .split("\0").filter(Boolean))].filter(isPackaged);
  } catch {
    // Do not silently fall back to shipping ignored files when enumeration fails.
    throw gitContextError();
  }
}

function existingPaths(cwd: string, paths: string[]): string[] {
  return paths.filter((path) => {
    try {
      // A leaf symlink may ship, but following a symlink ancestor could read outside the context.
      let parent = cwd;
      for (const segment of path.split("/").slice(0, -1)) {
        parent = join(parent, segment);
        if (!lstatSync(parent).isDirectory()) return false;
      }
      lstatSync(join(cwd, path));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  });
}

function diskPaths(cwd: string, parent = ""): string[] {
  return readdirSync(join(cwd, parent), { withFileTypes: true }).flatMap((entry) => {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (!isPackaged(path)) return [];
    return entry.isDirectory() ? diskPaths(cwd, path) : [path];
  });
}

function largestDirectories(cwd: string, paths: string[]): { path: string; size_bytes: number }[] {
  const sizes = new Map<string, number>();
  for (const path of existingPaths(cwd, paths)) {
    const entry = lstatSync(join(cwd, path));
    const top = path.includes("/") ? path.split("/")[0] : "(root files)";
    sizes.set(top, (sizes.get(top) ?? 0) + (entry.isFile() ? entry.size : 0));
  }
  return [...sizes].map(([path, size_bytes]) => ({ path, size_bytes }))
    .sort((a, b) => b.size_bytes - a.size_bytes || a.path.localeCompare(b.path)).slice(0, 5);
}

/** Write gzip output to disk before reading the bounded upload buffer. */
export function createTarball(cwd: string, maxBytes = MAX_ARCHIVE_BYTES): Buffer {
  const paths = gitVisiblePaths(cwd);
  const files = paths === null ? null : existingPaths(cwd, paths);
  const workspace = mkdtempSync(join(tmpdir(), "dvmkit-archive-"));
  const archive = join(workspace, "context.tar.gz");
  try {
    const fd = openSync(archive, "w");
    try {
      execFileSync("tar", ["czf", "-", ...TARBALL_EXCLUDES.map((e) => `--exclude=${e}`),
        ...(files === null ? ["."] : ["--no-recursion", "--null", "-T", "-"])], {
        cwd,
        // Prefixing paths also prevents option-like filenames being interpreted by tar.
        input: files === null ? undefined : files.map((path) => `./${path}\0`).join(""),
        stdio: ["pipe", fd, "pipe"],
      });
    } finally {
      closeSync(fd);
    }
    const size = statSync(archive).size;
    if (size > maxBytes) {
      const largest = largestDirectories(cwd, files ?? diskPaths(cwd));
      throw new DvmError("deploy_context_too_large",
        `Compressed build context is ${size} bytes, exceeding the ${maxBytes} byte limit. Largest top-level directories (uncompressed): ${largest.map((entry) => `${entry.path}: ${entry.size_bytes} bytes`).join(", ")}.`,
        "Check for build output in these directories. Remove unnecessary files from the build context then retry. In a git work tree, add untracked build output to .gitignore.",
        { size_bytes: size, limit_bytes: maxBytes, largest_directories: largest });
    }
    return readFileSync(archive);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Deletions and both sides of renames matter even when the old file no longer exists. */
export function packagedTreeDirtyPaths(cwd: string): string[] {
  try {
    const prefix = git(cwd, ["rev-parse", "--show-prefix"]).replace(/\n$/, "");
    const raw = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all", "--", "."]);
    return raw.split("\0").filter(Boolean)
      .map((field) => /^[ MADRCU?!][ MADRCU?!] /.test(field) ? field.slice(3) : field)
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length)).filter(isPackaged).sort();
  } catch {
    return [];
  }
}

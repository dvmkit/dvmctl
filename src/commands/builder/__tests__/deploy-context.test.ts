import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DvmError } from "@dvmkit/sdk/internal";
import { afterEach, describe, expect, it } from "vitest";

import { gitRunner } from "../../../test-support/git-sandbox.ts";
import { SPAWN_HEAVY_TIMEOUT } from "../../../test-support/spawn-budget.ts";

import { createTarball, packagedTreeDirtyPaths } from "../deploy-context.ts";

const directories: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-files-"));
  directories.push(dir);
  return dir;
}
function git(dir: string, ...args: string[]): void {
  gitRunner(dir)(...args);
}
function entries(dir: string): string[] {
  return execFileSync("tar", ["tzf", "-"], { input: createTarball(dir) })
    .toString("utf8").trim().split("\n").map((path) => path.replace(/^\.\//, "")).sort();
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git-visible deploy context", { timeout: SPAWN_HEAVY_TIMEOUT }, () => {
  it("ships tracked and untracked inputs without ignored output or deleted index entries", () => {
    const dir = fixture();
    git(dir, "init");
    writeFileSync(join(dir, ".gitignore"), "build-output/\ntracked.txt\n");
    mkdirSync(join(dir, "build-output"));
    writeFileSync(join(dir, "build-output", "large.bin"), randomBytes(2 * 1024 * 1024));
    writeFileSync(join(dir, "tracked.txt"), "tracked despite ignore rule");
    writeFileSync(join(dir, "deleted.txt"), "removed after staging");
    writeFileSync(join(dir, ".env.local"), "excluded even when tracked");
    git(dir, "add", "-f", ".gitignore", "tracked.txt", "deleted.txt", ".env.local");
    rmSync(join(dir, "deleted.txt"));
    writeFileSync(join(dir, "untracked.txt"), "include me");
    writeFileSync(join(dir, "-input.txt"), "option-like filename");
    symlinkSync("missing-target", join(dir, "broken-link"));

    expect(entries(dir)).toEqual(["-input.txt", ".gitignore", "broken-link", "tracked.txt", "untracked.txt"]);
  });

  it("scopes archive entries and dirty paths to a nested context", () => {
    const dir = fixture();
    git(dir, "init");
    writeFileSync(join(dir, ".gitignore"), "build-output/\n");
    writeFileSync(join(dir, "sibling.txt"), "outside context");
    const context = join(dir, "app");
    mkdirSync(context);
    writeFileSync(join(context, "handler.ts"), "source");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "seed");
    writeFileSync(join(dir, "sibling.txt"), "changed outside context");
    mkdirSync(join(context, "build-output"));
    writeFileSync(join(context, "build-output", "ignored.txt"), "ignored");
    mkdirSync(join(context, "new", "dist"), { recursive: true });
    writeFileSync(join(context, "new", "dist", "ignored.js"), "excluded");
    expect(packagedTreeDirtyPaths(context)).toEqual([]);
    writeFileSync(join(context, "new", "input.txt"), "untracked nested input");
    expect(packagedTreeDirtyPaths(context)).toEqual(["new/input.txt"]);
    expect(entries(context)).toEqual(["handler.ts", "new/input.txt"]);
    rmSync(join(context, "handler.ts"));
    expect(packagedTreeDirtyPaths(context)).toEqual(["handler.ts", "new/input.txt"]);
    expect(entries(context)).toEqual(["new/input.txt"]);
  });

  it("drops credential stores at any depth even when they are tracked", () => {
    const dir = fixture();
    git(dir, "init");
    writeFileSync(join(dir, "handler.ts"), "source");
    for (const path of [".ssh/id_ed25519", ".aws/credentials", ".dvm/state.json", ".dvmkit/builder.key", "tools/.dvmctl/token"]) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), "secret marker");
    }
    git(dir, "add", "-f", ".");
    git(dir, "commit", "-m", "seed");

    expect(entries(dir)).toEqual(["handler.ts"]);
  });

  it("does not follow a symlink replacing a tracked directory", () => {
    const dir = fixture();
    const external = fixture();
    git(dir, "init");
    mkdirSync(join(dir, "linked"));
    writeFileSync(join(dir, "linked", "input.txt"), "tracked input");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "seed");
    writeFileSync(join(external, "input.txt"), "external secret marker");
    rmSync(join(dir, "linked"), { recursive: true });
    symlinkSync(external, join(dir, "linked"));

    expect(entries(dir)).toEqual(["linked"]);
  });

  it.each([".", "nested/context"])("rejects a broken repository probe for context %s", (contextPath) => {
    const dir = fixture();
    git(dir, "init");
    const context = join(dir, contextPath);
    mkdirSync(context, { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "private-data/\n");
    mkdirSync(join(context, "private-data"));
    writeFileSync(join(context, "private-data", "secret.txt"), "must not ship");
    writeFileSync(join(dir, ".git", "config"), "[invalid config\n");

    let failure: unknown;
    try {
      createTarball(context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DvmError);
    expect(failure).toMatchObject({
      code: "deploy_context_git_failed",
      hint: expect.stringContaining("git rev-parse"),
    });
  });

  it.each([" app", "\napp", " app\n"])("preserves pathname whitespace in a dirty context prefix %j", (name) => {
    const dir = fixture();
    git(dir, "init");
    const context = join(dir, name);
    mkdirSync(context);
    writeFileSync(join(context, "input.txt"), "committed input");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "seed");
    writeFileSync(join(context, "input.txt"), "changed input");

    expect(entries(context)).toEqual(["input.txt"]);
    expect(packagedTreeDirtyPaths(context)).toEqual(["input.txt"]);
  });

  it("retains exclude-list behavior outside git, including files named in .gitignore", () => {
    const dir = fixture();
    writeFileSync(join(dir, ".gitignore"), "build-output/\n");
    mkdirSync(join(dir, "build-output"));
    writeFileSync(join(dir, "build-output", "input.txt"), "ships outside git");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "bundle.js"), "excluded");
    expect(entries(dir)).toEqual(["", ".gitignore", "build-output/", "build-output/input.txt"]);
  });

  it.each([true, false])("returns an actionable typed size error (git context: %s)", (inGit) => {
    const dir = fixture();
    if (inGit) git(dir, "init");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "payload.bin"), randomBytes(4096));
    mkdirSync(join(dir, "small"));
    writeFileSync(join(dir, "small", "input.txt"), "small");
    try {
      createTarball(dir, 100);
      expect.fail("oversized context must fail before upload");
    } catch (error) {
      expect(error).toBeInstanceOf(DvmError);
      const failure = error as DvmError;
      expect(failure.code).toBe("deploy_context_too_large");
      expect(failure.data).toMatchObject({
        size_bytes: expect.any(Number), limit_bytes: 100,
        largest_directories: [{ path: "assets", size_bytes: 4096 }, { path: "small", size_bytes: 5 }],
      });
      expect(failure.data?.size_bytes).toBeGreaterThan(100);
      expect(failure.message).toContain(`${failure.data?.size_bytes} bytes`);
      expect(failure.message).toContain("assets: 4096 bytes");
      expect(failure.hint).toContain("build output");
      expect(failure.hint).toContain(".gitignore");
    }
  });
});

// @ts-check
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { releaseChannel } from "./release-channel.mjs";

const root = resolve(import.meta.dirname, "..");
if (isMainModule()) main(root, process.argv.slice(2));

/** @param {string} root @param {string[]} args */
function main(root, args) {
  const options = parse(args);
  if (!options.tag?.startsWith("v")) fail("--tag must be vX.Y.Z or vX.Y.Z-rc.N");
  releaseChannel(options.tag.slice(1));
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const manifest = JSON.parse(readFileSync(join(root, ".release-please-manifest.json"), "utf8"))["."];
  if (version !== manifest || options.tag !== `v${version}`) fail("package and release manifest must agree with the release tag");
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") fail("worktree is not clean");
  const remote = git(root, ["ls-remote", "--symref", "--exit-code", "origin", "HEAD"]); const tip = remote.split("\n").find((line) => /^[0-9a-f]{40}\s+HEAD$/u.test(line))?.split(/\s+/u)[0];
  if (!tip || git(root, ["rev-parse", "HEAD"]) !== tip) fail("HEAD is not the live default branch tip");
  if (spawn(root, ["show-ref", "--verify", "--quiet", `refs/tags/${options.tag}`]).status === 0 || spawn(root, ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${options.tag}`]).status === 0) fail("release tag already exists");
  probeSigning(root);
  if (options.dryRun) { process.stdout.write(`release tag dry run passed: ${options.tag}\n`); } else { git(root, ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${join(root, ".github/release-signers")}`, "tag", "-s", "-m", `Release ${options.tag}`, options.tag, "HEAD"]); git(root, ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${join(root, ".github/release-signers")}`, "verify-tag", options.tag]); }
}
/** @param {string[]} args @returns {{tag?: string, dryRun: boolean}} */
function parse(args) {
  /** @type {{tag?: string, dryRun: boolean}} */
  const result = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--dry-run") result.dryRun = true;
    else if (args[index] === "--tag" && args[index + 1]) { result.tag = args[index + 1]; index += 1; }
    else fail(`unknown argument: ${args[index]}`);
  }
  return result;
}
// A clone does not inherit repository-local signing config, so the probe passes root's effective identity through explicitly.
/** @param {string} root */
export function probeSigning(root) {
  const allowedSignersFile = join(root, ".github/release-signers");
  const identity = effectiveSigningIdentity(root).flatMap((assignment) => ["-c", assignment]);
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-signing-probe-"));
  try {
    git(root, ["clone", "--no-checkout", "--local", root, directory]);
    git(root, ["-C", directory, ...identity, "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, "tag", "-s", "-m", "signing probe", "release-signing-probe", "HEAD"]);
    git(root, ["-C", directory, ...identity, "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${allowedSignersFile}`, "verify-tag", "release-signing-probe"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
/** @param {string} root @returns {string[]} */
function effectiveSigningIdentity(root) { return ["user.name", "user.email", "user.signingkey"].map((key) => `${key}=${configValue(root, key)}`); }
/** @param {string} root @param {string} key */
function configValue(root, key) { const result = spawn(root, ["config", "--get", key]); if (result.status !== 0) throw new Error(`effective ${key} is not configured`); return result.stdout.trim(); }
/** @param {string} root @param {string[]} args */ function git(root, args) { const result = spawn(root, args); if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`); return result.stdout.trim(); }
/** @param {string} root @param {string[]} args */ function spawn(root, args) { return spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); }
/** @param {string} message @returns {never} */ function fail(message) { console.error(`release tag: ${message}`); process.exit(1); }
function isMainModule() { return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href; }

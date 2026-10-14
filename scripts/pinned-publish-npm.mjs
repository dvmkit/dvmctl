// @ts-check
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const npmVersion = "11.16.0";
const integrity = "sha512-A74XL8OxmcegZDMWPkWb5bEQppg8HdYwW3rBD2sPoS4UQHVajfaxBkqyzLeJ3wR0kZ+5xoTjItxXaF7eIXUsyw==";
const tooling = resolve(process.env.DVMCTL_RELEASE_TOOLING ?? join(root, ".tooling"));
const archive = join(tooling, `npm-${npmVersion}.tgz`);
const unpacked = join(tooling, "release-npm");
const cli = join(unpacked, "package", "bin", "npm-cli.js");
const command = process.argv.slice(2);
if (command[0] === "--") command.shift();
if (command.length === 0) fail("pass an external command to run with pinned npm on PATH");
mkdirSync(dirname(archive), { recursive: true });
let bytes = existsSync(archive) ? readFileSync(archive) : undefined;
if (!bytes || digest(bytes) !== integrity) {
  const response = await fetch(`https://registry.npmjs.org/npm/-/npm-${npmVersion}.tgz`, { redirect: "error" });
  if (!response.ok) fail(`could not download pinned npm (${response.status})`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== integrity) fail("pinned npm archive failed integrity verification");
  writeFileSync(archive, bytes);
}
rmSync(unpacked, { recursive: true, force: true }); mkdirSync(unpacked, { recursive: true });
execFileSync("tar", ["-xzf", "-", "-C", unpacked], { input: bytes });
if (execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim() !== npmVersion) fail("pinned npm reported an unexpected version");
const shim = join(tooling, "release-bin", "npm"); mkdirSync(dirname(shim), { recursive: true });
writeFileSync(join(dirname(shim), "package.json"), '{"type":"commonjs"}\n');
writeFileSync(shim, `#!/usr/bin/env node\nconst { spawnSync } = require("node:child_process");\nconst result = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });\nif (result.error) throw result.error; process.exit(result.status ?? 1);\n`); chmodSync(shim, 0o755);
execFileSync(command[0], command.slice(1), { cwd: root, env: { ...process.env, DVMCTL_RELEASE_NPM_ROOT: join(unpacked, "package"), PATH: `${dirname(shim)}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` }, stdio: "inherit" });
/** @param {Buffer} value */ function digest(value) { return `sha512-${createHash("sha512").update(value).digest("base64")}`; }
/** @param {string} message @returns {never} */ function fail(message) { console.error(`release npm: ${message}`); process.exit(1); }

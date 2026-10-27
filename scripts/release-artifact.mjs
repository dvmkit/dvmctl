// @ts-check
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { checkBundledSkillLinks } from "./check-bundled-skills.mjs";

import { releaseChannel } from "./release-channel.mjs";
import { sdkVersion } from "./sdk-version.mjs";

const expectedFiles = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "dist/dvmctl.js",
  "package.json",
  "skills/build-dvm/SKILL.md",
  "skills/build-dvm/deploying.md",
  "skills/build-dvm/new-builder.md",
  "skills/build-dvm/operating.md",
  "skills/build-dvm/recovery.md",
  "skills/build-dvm/references/content-holds.md",
  "skills/build-dvm/references/financial-export.md",
  "skills/build-dvm/references/lightning-credit-test.md",
  "skills/build-dvm/references/local-cashu-test.md",
  "skills/build-dvm/references/local-tempo-test.md",
  "skills/build-dvm/references/local-x402-test.md",
  "skills/build-dvm/references/tempo-close-reports.md",
  "skills/build-dvm/retirement.md",
  "skills/build-dvm/testing.md",
];
const expectedName = "@dvmkit/dvmctl";
const options = parseArguments(process.argv.slice(2));
const command = options._[0];

if (command === "create") {
  const release = releaseIdentity(options);
  const first = archiveDetails(requiredPath(options, "first"));
  const second = archiveDetails(requiredPath(options, "second"));
  if (first.sha256 !== second.sha256 || JSON.stringify(first.files) !== JSON.stringify(second.files)) fail("two package archives differ");
  assertBinding(first, release);
  writeFileSync(requiredPath(options, "output"), `${JSON.stringify({ artifact: basename(requiredPath(options, "first")), distTag: release.distTag, files: first.files, packageName: first.name, packageVersion: first.version, sha256: first.sha256, tag: release.tag, commit: release.commit }, null, 2)}\n`);
} else if (command === "verify") {
  const release = releaseIdentity(options);
  const directory = requiredPath(options, "directory");
  const manifestPath = join(directory, "release-digest.json");
  if (!existsSync(manifestPath)) fail("release-digest.json is missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isManifest(manifest)) fail("release digest has an invalid shape");
  const entries = readdirSync(directory).sort();
  if (entries.length !== 2 || !entries.includes("release-digest.json") || !entries.includes(manifest.artifact)) fail("release artifact directory must contain only one tarball and its digest");
  if (manifest.tag !== release.tag || manifest.packageVersion !== release.version || manifest.distTag !== release.distTag || manifest.commit !== release.commit) fail("release digest does not bind the expected release identity");
  const archive = join(directory, manifest.artifact);
  const details = archiveDetails(archive);
  if (details.sha256 !== manifest.sha256 || details.name !== manifest.packageName || JSON.stringify(details.files) !== JSON.stringify(manifest.files)) fail("release tarball does not match its digest");
  assertBinding(details, release);
  process.stdout.write(`${archive}\n`);
} else fail("use create or verify");

/** @param {string[]} args */
function parseArguments(args) {
  /** @type {{ _: string[], [key: string]: string | string[] }} */
  const result = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) { result._.push(argument); continue; }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${argument}`);
    result[argument.slice(2)] = value;
    index += 1;
  }
  return result;
}
/** @param {{ [key: string]: string | string[] }} args @param {string} name */
function required(args, name) { const value = args[name]; if (typeof value !== "string" || !value) fail(`--${name} is required`); return value; }
/** @param {{ [key: string]: string | string[] }} args @param {string} name */
function requiredPath(args, name) { return resolve(required(args, name)); }
/** @param {{ [key: string]: string | string[] }} args */
function releaseIdentity(args) {
  const tag = required(args, "tag"); const version = required(args, "version"); const distTag = required(args, "dist-tag"); const commit = required(args, "commit");
  if (tag !== `v${version}` || distTag !== releaseChannel(version)) fail("release tag and dist-tag must match the version's channel");
  if (!/^[0-9a-f]{40}$/u.test(commit)) fail("commit must be a full immutable SHA-1");
  return { tag, version, distTag, commit };
}
/** @param {string} archive */
function archiveDetails(archive) {
  if (!existsSync(archive)) fail(`archive does not exist: ${archive}`);
  const listing = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" });
  if (listing.split("\n").filter(Boolean).some((line) => !line.startsWith("-") && !line.startsWith("d"))) fail("archive contains a non-regular entry");
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).split("\n").filter((entry) => entry && !entry.endsWith("/")).map((entry) => { if (!entry.startsWith("package/") || entry.includes("../")) fail("archive has an unsafe file path"); return entry.slice(8); }).sort();
  /** @type {Map<string, string>} */ const packedSkills = new Map();
  for (const file of files) {
    const contents = tarText(archive, `package/${file}`);
    if (file.startsWith("skills/")) packedSkills.set(file, contents);
    if (/\bregression-\d+\b/iu.test(contents) || /\bDVM-\d+\b|linear\.app\/|\/Users\/|github\.com-anon|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{20,}\b/u.test(contents)) fail(`archive contains non-public material in ${file}`);
  }
  const linkProblems = checkBundledSkillLinks(packedSkills);
  if (linkProblems.length) fail(`invalid bundled skill links: ${linkProblems.join("; ")}`);
  const manifest = JSON.parse(tarText(archive, "package/package.json"));
  for (const hook of ["prepublish", "prepare", "prepublishOnly", "prepack", "postpack", "publish", "postpublish", "preinstall", "install", "postinstall"]) if (typeof manifest.scripts?.[hook] === "string") fail(`archive package manifest declares forbidden ${hook} lifecycle hook`);
  return { files, manifest, license: tarBytes(archive, "package/LICENSE"), name: manifest.name, notice: tarBytes(archive, "package/NOTICE"), version: manifest.version, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") };
}
/** @param {string} archive @param {string} entry */
function tarText(archive, entry) { return /** @type {string} */ (tarRead(archive, entry, "utf8")); }
/** @param {string} archive @param {string} entry */
function tarBytes(archive, entry) { return /** @type {Buffer} */ (tarRead(archive, entry, "buffer")); }
/** @param {string} archive @param {string} entry @param {"utf8" | "buffer"} encoding */
function tarRead(archive, entry, encoding) {
  try { return execFileSync("tar", ["-xOf", archive, entry], { encoding, maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) { fail(`could not safely read packed ${entry}: ${error instanceof Error ? error.message : "tar failed"}`); }
}
/** @param {{files: string[], manifest: any, license: Buffer, name: unknown, notice: Buffer, version: unknown}} details @param {{version: string}} release */
function assertBinding(details, release) {
  if (details.name !== expectedName || details.version !== release.version) fail("archive package metadata does not match the release");
  if (JSON.stringify(details.files) !== JSON.stringify(expectedFiles)) fail("archive file list is not the standalone package shape");
  const manifest = details.manifest;
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ dvmctl: "dist/dvmctl.js" })) fail("archive must expose only dvmctl at dist/dvmctl.js");
  if (JSON.stringify(Object.entries(manifest.dependencies ?? {}).sort()) !== JSON.stringify(Object.entries({ "@dvmkit/sdk": sdkVersion, "@cashu/cashu-ts": "4.10.2" }).sort())) fail("archive must have only the exact SDK and Cashu runtime dependencies");
  if (JSON.stringify(manifest.exports) !== JSON.stringify({ "./skill": "./skills/build-dvm/SKILL.md" })) fail("archive must export the bundled build-dvm skill");
  if (manifest.peerDependencies && Object.keys(manifest.peerDependencies).length > 0) fail("archive must not declare peer dependencies");
  if (JSON.stringify(manifest.optionalDependencies) !== JSON.stringify({ pg: "8.20.0", tsx: "^4" })) fail("archive must declare exact pg and tsx optional dependencies");
  if (manifest.engines?.node !== ">=22") fail("archive must declare engines.node as >=22");
  if (manifest.license !== "Apache-2.0") fail("archive must declare Apache-2.0 licensing");
  if (manifest.publishConfig?.provenance !== true) fail("archive must require npm provenance");
  if (manifest.repository?.url !== "git+https://github.com/dvmkit/dvmctl.git") fail("archive repository URL is not the standalone repository");
  if (!details.license.equals(readFileSync(resolve(import.meta.dirname, "..", "LICENSE"))) || !details.notice.equals(readFileSync(resolve(import.meta.dirname, "..", "NOTICE")))) fail("archive LICENSE or NOTICE differs from the reviewed source legal file");
}
/** @param {any} value */
function isManifest(value) { return value && typeof value === "object" && typeof value.artifact === "string" && typeof value.distTag === "string" && Array.isArray(value.files) && value.files.every((/** @type {unknown} */ entry) => typeof entry === "string") && typeof value.packageName === "string" && typeof value.packageVersion === "string" && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256) && typeof value.tag === "string" && /^[0-9a-f]{40}$/u.test(value.commit); }
/** @param {string} message @returns {never} */
function fail(message) { console.error(`release artifact: ${message}`); process.exit(1); }

// @ts-check
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertProvenanceIdentity, inspectProvenance } from "./release-provenance.mjs";

import { releaseChannel } from "./release-channel.mjs";

const registry = "https://registry.npmjs.org";
const name = "@dvmkit/dvmctl";
export const PROPAGATION_TIMEOUT_MS = 180_000;
export const PROPAGATION_RETRY_DELAY_MS = 5_000;
export const PROPAGATION_ATTEMPTS = Math.floor(PROPAGATION_TIMEOUT_MS / PROPAGATION_RETRY_DELAY_MS) + 1;
const options = parseArguments(process.argv.slice(2));
if (isMainModule() && options.archive) await publishRelease({ archive: options.archive, distTag: required(options, "dist-tag"), repository: required(options, "repository"), tag: required(options, "tag"), commit: required(options, "commit") });

/** @param {{archive: string, distTag: string, repository: string, tag: string, commit: string, verifyBundleFn?: import("./release-provenance.mjs").BundleVerifier, fetchFn?: typeof fetch, publishFn?: (archive: string, distTag: string) => number | Promise<number>, attempts?: number, waitFn?: (ms: number) => Promise<void>}} options */
export async function publishRelease({ archive, distTag, repository, tag, commit, verifyBundleFn, fetchFn = fetch, publishFn = publishArchive, attempts = PROPAGATION_ATTEMPTS, waitFn = wait }) {
  const local = archiveIdentity(resolve(archive));
  if (local.name !== name || distTag !== releaseChannel(local.version)) throw new Error("package and dist-tag must match the release channel");
  const latest = distTag === "next" ? await readLatest(fetchFn) : local.version;
  const expected = { ...local, distTag, repository, tag, commit };
  assertProvenanceIdentity(expected);
  const before = await inspectPublishedRelease({ expected, fetchFn, verifyBundleFn });
  if (before === "match") { await assertPostPublishLatest(latest, fetchFn, attempts, waitFn); return "already-published"; }
  if (before === "mismatch") throw new Error("existing npm release does not match the reviewed archive and dist-tag");
  if (before === "pending") {
    await waitForPublishedRelease({ expected, fetchFn, verifyBundleFn, attempts, waitFn });
    await assertPostPublishLatest(latest, fetchFn, attempts, waitFn);
    return "already-published";
  }
  const status = await publishFn(resolve(archive), distTag);
  await waitForPublishedRelease({ expected, fetchFn, verifyBundleFn, attempts, waitFn, publishStatus: status });
  await assertPostPublishLatest(latest, fetchFn, attempts, waitFn);
  return "published";
}
/** @param {typeof fetch} [fetchFn] */
export async function readLatest(fetchFn = fetch) {
  const response = await fetchFn(`${registry}/${encodeURIComponent(name)}?channel_check=${Date.now()}`, { cache: "no-store", redirect: "error" });
  if (!response.ok) throw new Error(`npm registry channel metadata request failed (${response.status})`);
  const metadata = await response.json();
  const latest = metadata?.["dist-tags"]?.latest;
  if (typeof latest !== "string" || releaseChannel(latest) !== "latest") throw new Error("npm latest must be a stable version");
  return latest;
}
/** @param {string} expected @param {typeof fetch} [fetchFn] @param {number} [attempts] @param {(ms: number) => Promise<void>} [waitFn] */
export async function assertPostPublishLatest(expected, fetchFn = fetch, attempts = PROPAGATION_ATTEMPTS, waitFn = wait) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("propagation attempts must be at least one");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A metadata 404 may be a replica lag; other failures remain fatal.
    try {
      if (await readLatest(fetchFn) !== expected) throw new Error("npm latest does not match the expected stable version");
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith("(404)")) throw error;
    }
    if (attempt < attempts) await waitFn(PROPAGATION_RETRY_DELAY_MS);
  }
  throw new Error(`npm registry channel metadata did not appear within ${PROPAGATION_TIMEOUT_MS}ms`);
}
/** @param {{expected: import("./release-provenance.mjs").ProvenanceIdentity & {sha256: string, distTag: string}, verifyBundleFn?: import("./release-provenance.mjs").BundleVerifier, fetchFn?: typeof fetch}} options */
export async function inspectPublishedRelease({ expected, fetchFn = fetch, verifyBundleFn }) {
  const response = await fetchFn(`${registry}/${encodeURIComponent(expected.name)}?release_check=${Date.now()}`, { cache: "no-store", redirect: "error" });
  if (response.status === 404) return "missing";
  if (!response.ok) throw new Error(`npm registry metadata request failed (${response.status})`);
  const metadata = await response.json(); const version = metadata?.versions?.[expected.version];
  if (!version) return "missing";
  if (version.name !== expected.name || version.version !== expected.version || metadata?.["dist-tags"]?.[expected.distTag] !== expected.version || typeof version.dist?.tarball !== "string" || new URL(version.dist.tarball).origin !== registry) return "mismatch";
  const tarball = await fetchFn(version.dist.tarball, { cache: "no-store", redirect: "error" });
  if (tarball.status === 404) return "pending";
  if (!tarball.ok) throw new Error(`npm registry tarball request failed (${tarball.status})`);
  const bytes = Buffer.from(await tarball.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) return "mismatch";
  return inspectProvenance({ expected, attestations: version.dist.attestations, fetchFn, verifyBundleFn });
}
/** @param {{archive: string, distTag: string, repository: string, tag: string, commit: string, verifyBundleFn?: import("./release-provenance.mjs").BundleVerifier, fetchFn?: typeof fetch, attempts?: number, waitFn?: (ms: number) => Promise<void>}} options */
export async function verifyPublishedRelease({ archive, distTag, repository, tag, commit, verifyBundleFn, fetchFn = fetch, attempts = PROPAGATION_ATTEMPTS, waitFn = wait }) {
  const local = archiveIdentity(resolve(archive));
  if (local.name !== name || distTag !== releaseChannel(local.version)) throw new Error("package and dist-tag must match the release channel");
  const expected = { ...local, distTag, repository, tag, commit };
  assertProvenanceIdentity(expected);
  await waitForPublishedRelease({ expected, fetchFn, verifyBundleFn, attempts, waitFn });
  const latest = distTag === "next" ? await readLatest(fetchFn) : local.version;
  await assertPostPublishLatest(latest, fetchFn, attempts, waitFn);
}
/** @param {{expected: import("./release-provenance.mjs").ProvenanceIdentity & {sha256: string, distTag: string}, fetchFn: typeof fetch, verifyBundleFn?: import("./release-provenance.mjs").BundleVerifier, attempts: number, waitFn: (ms: number) => Promise<void>, publishStatus?: number}} options */
export async function waitForPublishedRelease({ expected, fetchFn, verifyBundleFn, attempts, waitFn, publishStatus }) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("propagation attempts must be at least one");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observed = await inspectPublishedRelease({ expected, fetchFn, verifyBundleFn });
    if (observed === "match") return;
    if (observed === "mismatch") throw new Error("published npm release does not match the reviewed archive and dist-tag");
    if (attempt < attempts) await waitFn(PROPAGATION_RETRY_DELAY_MS);
  }
  const context = publishStatus === undefined ? "exact release" : `npm publish exited ${publishStatus}, and the exact release`;
  throw new Error(`${context} did not appear in the registry within ${PROPAGATION_TIMEOUT_MS}ms`);
}
/** @param {string} archive */
export function archiveIdentity(archive) { const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })); return { name: manifest.name, version: manifest.version, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), sha512: createHash("sha512").update(readFileSync(archive)).digest("hex") }; }
/** @param {string} archive @param {string} distTag */
export function publishArchive(archive, distTag) { const result = spawnSync("npm", ["publish", archive, "--tag", distTag, "--provenance", "--ignore-scripts"], { stdio: "inherit" }); if (result.error) throw result.error; return result.status ?? 1; }
/** @param {string[]} args @returns {Record<string, string>} */
function parseArguments(args) { /** @type {Record<string, string>} */ const result = Object.create(null); for (let index = 0; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; if (!key?.startsWith("--") || !value) throw new Error(`invalid argument: ${key ?? ""}`); result[key.slice(2)] = value; } return result; }
/** @param {Record<string, string>} args @param {string} key */
function required(args, key) { if (!args[key]) throw new Error(`--${key} is required`); return args[key]; }
/** @param {number} ms */
function wait(ms) { return new Promise((done) => setTimeout(done, ms)); }
function isMainModule() { return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href; }

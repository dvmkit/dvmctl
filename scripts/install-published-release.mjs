// @ts-check
import { spawnSync } from "node:child_process";
import { PROPAGATION_ATTEMPTS, PROPAGATION_RETRY_DELAY_MS, PROPAGATION_TIMEOUT_MS } from "./publish-release.mjs";

import { releaseChannel } from "./release-channel.mjs";
import { sdkVersion as selectedSdkVersion } from "./sdk-version.mjs";

const options = parseArguments(process.argv.slice(2));
if (options.version || options.prefix || options["sdk-version"]) await installPublishedRelease({ version: required(options, "version"), prefix: required(options, "prefix"), sdkVersion: selectedSdkVersion });

/** @param {{version: string, prefix: string, sdkVersion: string, attempts?: number, waitFn?: (ms: number) => Promise<void>, runNpm?: (args: string[], prefix: string) => {status: number | null, stdout?: string, stderr?: string, error?: Error}}} options */
export async function installPublishedRelease({ version, prefix, sdkVersion, attempts = PROPAGATION_ATTEMPTS, waitFn = wait, runNpm = runNpmInstall }) {
  releaseChannel(version);
  releaseChannel(sdkVersion);
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("propagation attempts must be at least one");
  const args = ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@dvmkit/dvmctl@${version}`, `@dvmkit/sdk@${sdkVersion}`];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runNpm(args, prefix);
    if (result.error) throw result.error;
    if (result.status === 0) return;
    if (!isDvmctlPropagationFailure(result, version)) throw new Error(`npm install failed (${result.status ?? "unknown"}): ${result.stderr ?? result.stdout ?? ""}`);
    if (attempt < attempts) await waitFn(PROPAGATION_RETRY_DELAY_MS);
  }
  throw new Error(`exact @dvmkit/dvmctl@${version} did not propagate within ${PROPAGATION_TIMEOUT_MS}ms`);
}
/** @param {{stdout?: string, stderr?: string}} result @param {string} version */
export function isDvmctlPropagationFailure(result, version) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const target = `@dvmkit/dvmctl@${version}`;
  const records = new Set([...output.matchAll(/npm error (?:code )?(E[A-Z0-9]+|[1-5]\d\d)\b/gu)].map((match) => normalizeCode(match[1])));
  if (records.size !== 1) return false;
  const code = records.values().next().value;
  if (code === "ETARGET") return new RegExp(`No matching version found for ${escapeRegExp(target)}(?:\\s|$|\\.(?=\\s|$))`, "u").test(output) && !mentionsOtherPackage(output, target);
  if (code === "E404") return trustedRegistryUrl(output, target, version) && !mentionsOtherPackage(output, target);
  return false;
}
/** @param {string} code */
function normalizeCode(code) { return /^\d{3}$/u.test(code) ? `E${code}` : code; }
/** @param {string} output @param {string} target */
function mentionsOtherPackage(output, target) {
  return [...output.matchAll(/(?:No matching version found for\s+|['"])(@(?:[a-z0-9-]+\/)?[a-z0-9-]+@[\w.+-]+)/giu)]
    .map((match) => match[1].endsWith(".") ? match[1].slice(0, -1) : match[1]).some((packageSpec) => packageSpec !== target);
}
/** @param {string} output @param {string} target @param {string} version */
function trustedRegistryUrl(output, target, version) {
  const urls = [...output.matchAll(/https?:\/\/[^\s'"]+/gu)].map((match) => match[0]);
  if (urls.length === 0) return false;
  const exactTarget = new RegExp(escapeRegExp(target) + "(?:[.\\s']|$)", "u").test(output);
  return urls.every((value) => {
    let url; try { url = new URL(value); } catch { return false; }
    if (url.origin !== "https://registry.npmjs.org") return false;
    let path; try { path = decodeURIComponent(url.pathname); } catch { return false; }
    return path === "/@dvmkit/dvmctl" ? exactTarget : path === `/@dvmkit/dvmctl/-/dvmctl-${version}.tgz`;
  });
}
/** @param {string} value */
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
/** @param {string[]} args @param {string} prefix */
function runNpmInstall(args, prefix) { return spawnSync("npm", args, { cwd: prefix, encoding: "utf8", stdio: "pipe" }); }
/** @param {number} ms */
function wait(ms) { return new Promise((done) => setTimeout(done, ms)); }
/** @param {string[]} args @returns {Record<string, string>} */
function parseArguments(args) { const result = Object.create(null); for (let index = 0; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; if (!key?.startsWith("--") || !value) throw new Error(`invalid argument: ${key ?? ""}`); result[key.slice(2)] = value; } return result; }
/** @param {Record<string, string>} args @param {string} key */
function required(args, key) { if (!args[key]) throw new Error(`--${key} is required`); return args[key]; }

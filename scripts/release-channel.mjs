// @ts-check
import { pathToFileURL } from "node:url";

/** @param {string} version */
export function releaseChannel(version) {
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) return "latest";
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/u.test(version)) return "next";
  throw new Error("release version must be X.Y.Z or X.Y.Z-rc.N");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(`${releaseChannel(process.argv[2])}\n`);

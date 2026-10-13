// @ts-check
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const sdkVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@dvmkit/sdk"];
if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u.test(sdkVersion)) throw new Error("SDK dependency must be one exact registry version");
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.stdout.write(`${sdkVersion}\n`);

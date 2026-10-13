// @ts-check
import { verifyPublishedRelease } from "./publish-release.mjs";

const options = parseArguments(process.argv.slice(2));
await verifyPublishedRelease({ archive: required(options, "archive"), distTag: required(options, "dist-tag"), repository: required(options, "repository"), tag: required(options, "tag"), commit: required(options, "commit") });

/** @param {string[]} args @returns {Record<string, string>} */
function parseArguments(args) { const result = Object.create(null); for (let index = 0; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; if (!key?.startsWith("--") || !value) throw new Error(`invalid argument: ${key ?? ""}`); result[key.slice(2)] = value; } return result; }
/** @param {Record<string, string>} args @param {string} key */
function required(args, key) { if (!args[key]) throw new Error(`--${key} is required`); return args[key]; }

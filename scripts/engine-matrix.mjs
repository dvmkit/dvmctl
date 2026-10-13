// @ts-check
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (manifest.engines?.node !== ">=22") throw new Error("the hosted runtime matrix must be updated with any engines.node change");
process.stdout.write(JSON.stringify({ node: ["22.0.0", "22", "24", "26"] }));

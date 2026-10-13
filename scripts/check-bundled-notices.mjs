// @ts-check
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = join(root, "dist/metafile-esm.json");
/** @type {{ outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> }} */
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const notice = readFileSync(join(root, "NOTICE"), "utf8");
const packageRoots = new Set();

for (const output of Object.values(metadata.outputs)) {
  for (const [input, contribution] of Object.entries(output.inputs)) {
    if (!input.includes("node_modules/") || contribution.bytesInOutput === 0) continue;
    let directory = dirname(resolve(root, input));
    let found = false;
    while (directory !== root && !relative(root, directory).startsWith("..")) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name === "string" && typeof manifest.version === "string") {
          packageRoots.add(directory);
          found = true;
          break;
        }
      }
      directory = dirname(directory);
    }
    if (!found) throw new Error("Cannot identify a bundled dependency's license owner");
  }
}

if (packageRoots.size === 0) throw new Error("Bundle license metadata has no dependency inputs");
for (const directory of packageRoots) {
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const identity = `${manifest.name}@${manifest.version}`;
  if (!notice.split("\n").includes(identity)) {
    throw new Error(`NOTICE is missing bundled dependency ${identity}`);
  }
  const licenseFiles = readdirSync(directory).filter(
    (name) =>
      /^(LICENSE|LICENCE|COPYING|NOTICE)(?:\.[^.]+)?$/i.test(name) &&
      statSync(join(directory, name)).isFile()
  );
  if (licenseFiles.length === 0)
    throw new Error(`No license file found for ${identity}; review its license manually`);
  for (const file of licenseFiles) {
    const text = readFileSync(join(directory, file), "utf8").trimEnd();
    if (!text || !notice.includes(text)) {
      throw new Error(`NOTICE does not contain the complete ${file} for ${identity}`);
    }
  }
}

// The build metadata is verification input, not part of the installed package.
rmSync(metadataPath);
console.log(`Bundled license notices verified for ${packageRoots.size} dependency locations`);

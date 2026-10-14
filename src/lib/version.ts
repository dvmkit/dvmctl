import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the CLI version: the `version` field of the
 * nearest ancestor `package.json`. Read once at module load and surfaced by
 * every CLI entry's `--version` output plus `dvm doctor`,
 * so they can never drift from the published package version.
 *
 * Resolves correctly in dev/test (running from `src/`) and in the bundled
 * `dist/` output (one level under repo root) because it walks up to the first
 * `package.json` rather than assuming a fixed relative depth.
 */
const manifest = readManifest();
export const CLI_VERSION: string = manifest.version;
export const SDK_VERSION: string = manifest.dependencies["@dvmkit/sdk"];

function readManifest(): { version: string; dependencies: { "@dvmkit/sdk": string } } {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8"));
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`tracked change: no package.json found walking up from ${import.meta.url}`);
    }
    dir = parent;
  }
}

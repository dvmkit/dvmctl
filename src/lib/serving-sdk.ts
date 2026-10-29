import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { info } from "../shared/output.ts";
import { SDK_VERSION } from "./version.ts";

/** Inspect the handler's installation, including workspace-hoisted and linked packages. */
export function projectSdkVersion(handlerPath: string): string | undefined {
  let directory = dirname(resolve(handlerPath));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "node_modules/@dvmkit/sdk/package.json"), "utf8")) as { name?: unknown; version?: unknown };
      return manifest.name === "@dvmkit/sdk" && typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version)
        ? manifest.version
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function warnSdkMismatch(handlerPath: string): void {
  const installed = projectSdkVersion(handlerPath);
  if (installed && installed !== SDK_VERSION) {
    info(`Warning: dvmctl serves with @dvmkit/sdk ${SDK_VERSION}; the project has @dvmkit/sdk ${installed} installed. dev and serve use dvmctl's pinned SDK. Align the versions if you need the same runtime behavior.`);
  }
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DvmError } from "@dvmkit/sdk/internal";

export function parseProjectEnvironment(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Load an optional project .env, while surfacing read failures other than a missing file. */
export function loadProjectEnvironment(cwd = process.cwd()): Record<string, string> {
  const envPath = resolve(cwd, ".env");
  try {
    return parseProjectEnvironment(readFileSync(envPath, "utf8"));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return {};
    const code = errorCode(err);
    throw new DvmError(
      "project_env_unreadable",
      "Could not read the project .env file.",
      `Check that ${envPath} is a readable file and its parent directory is accessible.`,
      { path: envPath, ...(code ? { error_code: code } : {}) }
    );
  }
}

/** Merge inherited variables with project values, which deliberately take precedence. */
export function mergeProjectEnvironment(
  parent: NodeJS.ProcessEnv,
  project: Readonly<Record<string, string>>
): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...project };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

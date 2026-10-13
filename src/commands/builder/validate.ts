import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isZodSchema } from "@dvmkit/sdk";
import { DvmError } from "@dvmkit/sdk/internal";

import { deriveSlug } from "../../lib/deploy-attestation.ts";
import { loadDescriptor } from "../../lib/load-handler.ts";
import type { FeatureManifest } from "../../builder-platform/capability-manifest.ts";
import type { VmConfig } from "../../builder-platform/types.ts";
import { info, json } from "../../shared/output.ts";
import { readFeatures, readInheritSecrets, readVmConfig } from "./deploy.ts";

export interface ValidateOptions {
  human?: boolean;
  /** Handler module; defaults to handler.ts then handler.js. */
  handler?: string;
}

export interface ManifestSummary {
  slug: string;
  name: string;
  vmConfig: VmConfig | null;
  inheritSecrets: string[];
  features: FeatureManifest;
}

/**
 * Validate `package.json#dvmkit` in `cwd` by running the platform's parsers
 * (`parseVmConfig` + `parseInheritSecrets` + `parseFeatures`) offline. Throws `DvmError` on a
 * missing or malformed manifest; on success returns the parsed summary.
 *
 * Single source of truth for pre-deploy validation: invoked by `dvmctl
 * validate` (standalone command), `dvmctl deploy` (fast-fail before
 * platform contact), and the CI gate that loops over `projects`.
 *
 * Pure — no network, no auth, no filesystem writes.
 */
export function validateManifest(cwd: string): ManifestSummary {
  if (!existsSync(resolve(cwd, "package.json"))) {
    throw new DvmError(
      "missing_package_json",
      `No package.json found in ${cwd}.`,
      "Run this from a DVM project directory."
    );
  }
  const slug = deriveSlug(cwd);
  const name = readDvmName(cwd) ?? slug;
  const vmConfig = readVmConfig(cwd);
  const inheritSecrets = readInheritSecrets(cwd);
  const features = readFeatures(cwd);
  return { slug, name, vmConfig, inheritSecrets, features };
}

/**
 * `dvmctl validate` — lint `package.json#dvmkit` locally without contacting
 * the platform. Exits 0 with a one-line summary on success; exits non-zero
 * with the platform-side error message on failure.
 */
export async function validate(opts: ValidateOptions, cwd?: string): Promise<void> {
  cwd ??= process.cwd();
  const { slug, name, vmConfig, inheritSecrets, features } = validateManifest(cwd);
  const featureNames = Object.keys(features);
  const handlerPath = resolveHandlerPath(cwd, opts.handler);
  let descriptor: Awaited<ReturnType<typeof loadDescriptor>>;
  try {
    descriptor = await loadDescriptor(handlerPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new DvmError(
      "invalid_handler",
      `Could not load DVM handler ${handlerPath}: ${message}`,
      "Fix the handler import or descriptor configuration, then run `dvmctl validate` again."
    );
  }
  const capabilityNames = validateDescriptor(descriptor);

  if (opts.human) {
    info(`Validating ${name} (${slug}): ok`);
    if (vmConfig) {
      const mem = vmConfig.memoryMb != null ? `${vmConfig.memoryMb} MB` : "(default)";
      info(`  resources ${mem} / ${vmConfig.cpuCount ?? 1} cpu`);
    }
    if (inheritSecrets.length > 0) {
      info(`  inheritSecrets ${inheritSecrets.length} pattern(s)`);
    }
    if (featureNames.length > 0) {
      info(`  features ${featureNames.join(", ")}`);
    }
    info(`  handler ${handlerPath}`);
    info(`  capabilities ${capabilityNames.join(", ")}`);
  } else {
    json({
      status: "ok",
      slug,
      name,
      vm_config: vmConfig,
      inherit_secrets: inheritSecrets.length > 0 ? inheritSecrets : undefined,
      features: featureNames.length > 0 ? features : undefined,
      handler: handlerPath,
      capabilities: capabilityNames,
      display: `${name} is valid with ${capabilityNames.length} ${capabilityNames.length === 1 ? "capability" : "capabilities"}.`,
      hint: "Run `dvmctl dev <handler>` to make the first local call.",
    });
  }
}

function resolveHandlerPath(cwd: string, requested?: string): string {
  if (requested) {
    const path = resolve(cwd, requested);
    if (!existsSync(path)) {
      throw new DvmError(
        "handler_not_found",
        `Handler file not found: ${path}.`,
        "Pass --handler <path> or create handler.ts / handler.js in this project."
      );
    }
    return path;
  }
  for (const name of ["handler.ts", "handler.js"]) {
    const path = resolve(cwd, name);
    if (existsSync(path)) return path;
  }
  throw new DvmError(
    "handler_not_found",
    `No handler.ts or handler.js found in ${cwd}.`,
    "Add a handler module or pass --handler <path>. A scaffold is not required."
  );
}

function validateDescriptor(descriptor: Awaited<ReturnType<typeof loadDescriptor>>): string[] {
  const entries = Object.entries(descriptor.capabilities);
  if (entries.length === 0) {
    throw new DvmError("missing_capability", "The handler declares no capabilities.");
  }
  const names = new Set<string>();
  for (const [name, capability] of entries) {
    if (names.has(name)) {
      throw new DvmError(
        "duplicate_capability",
        `Capability name ${JSON.stringify(name)} is duplicated.`
      );
    }
    names.add(name);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new DvmError(
        "invalid_capability",
        `Capability name ${JSON.stringify(name)} is not well formed.`
      );
    }
    if (!isZodSchema(capability.input)) {
      throw new DvmError(
        "invalid_input_schema",
        `Capability ${JSON.stringify(name)} does not have a valid Zod input schema.`,
        "Declare `input: z.object(...)` so callers and the handler agree on request data."
      );
    }
    if (capability.example === undefined) {
      throw new DvmError(
        "missing_input_example",
        `Capability ${JSON.stringify(name)} has no example input.`,
        "Declare an `example` that satisfies this capability's input schema."
      );
    }
    if (!capability.input.safeParse(capability.example).success) {
      throw new DvmError(
        "invalid_input_example",
        `Capability ${JSON.stringify(name)} has an example that does not satisfy its input schema.`,
        "Update `example` to satisfy every field and refinement in the Zod input schema."
      );
    }
    if (capability.price !== undefined && typeof capability.price !== "string") {
      throw new DvmError(
        "invalid_price",
        `Capability ${JSON.stringify(name)} has an invalid price.`
      );
    }
  }
  for (const tag of descriptor.tags) {
    if (typeof tag !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) {
      throw new DvmError(
        "invalid_tag",
        `Tag ${JSON.stringify(tag)} is not well formed.`,
        "Use lowercase letters, digits, and single hyphens."
      );
    }
  }
  return [...names];
}

function readDvmName(cwd: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf-8")) as {
      name?: string;
    };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

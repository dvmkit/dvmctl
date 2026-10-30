import { pathToFileURL } from "node:url";

import type { DVMConfig, DVMDescriptor, ZodLike } from "@dvmkit/sdk";
import { configureDVM, isConfiguredDVMDescriptor } from "@dvmkit/sdk";

export function isDescriptor(value: unknown): value is DVMDescriptor<unknown, ZodLike | undefined> {
  return isConfiguredDVMDescriptor(value);
}

export interface LoadDescriptorOptions {
  /**
   * When this call first registers tsx, receive its asynchronous module URLs.
   * Let the event loop turn after import before reading the collection. If tsx
   * is unavailable or was already registered, this callback collects nothing.
   */
  onImport?: (url: string) => void;
}

/**
 * Dynamically import a module and extract a DVMDescriptor from it.
 *
 * Looks for (in order): default export, named `dvm` export, first matching
 * export. Descriptors created by this SDK module instance pass through
 * unchanged; sketches and descriptors from another SDK installation are
 * normalized through `configureDVM`. Registers tsx for .ts files if available.
 */
export async function loadDescriptor(
  modulePath: string,
  opts: LoadDescriptorOptions = {}
): Promise<DVMDescriptor<unknown, ZodLike | undefined>> {
  if (opts.onImport) await registerTsx(opts.onImport);
  else await registerTsxIfNeeded(modulePath);
  const url = modulePath.startsWith("file://") ? modulePath : pathToFileURL(modulePath).href;
  const mod = (await import(url)) as Record<string, unknown>;

  const preferred = [mod.default, mod.dvm];
  for (const value of preferred) {
    const descriptor = descriptorFromExport(value, modulePath);
    if (descriptor) return descriptor;
  }

  for (const value of Object.values(mod)) {
    const descriptor = descriptorFromExport(value, modulePath);
    if (descriptor) return descriptor;
  }

  throw new Error(
    `No DVMDescriptor found in ${modulePath}. Export a configureDVM() result as default, "dvm", or any named export.`
  );
}

interface DescriptorSketch extends Record<string, unknown> {
  config: Record<string, unknown>;
}

function descriptorFromExport(
  value: unknown,
  modulePath: string
): DVMDescriptor<unknown, ZodLike | undefined> | undefined {
  if (isDescriptor(value)) return value;
  if (!isDescriptorSketch(value)) return undefined;

  const { config, capabilities: resolvedCapabilities, inputSchema, ...topLevel } = value;
  // SDK descriptors mirror state at the top level even with explicit capabilities.
  // Only config.state is a flat declaration in that shape; sketches keep their fallback.
  if (resolvedCapabilities !== undefined && config.capabilities !== undefined) {
    delete topLevel.state;
  }
  const normalizedConfig: Record<string, unknown> = {
    ...topLevel,
    ...(inputSchema !== undefined ? { input: inputSchema } : {}),
    ...config,
  };
  if (typeof normalizedConfig.name !== "string") {
    throw new Error(
      `Invalid DVM descriptor export in ${modulePath}: missing required "name" field.`
    );
  }

  try {
    return configureDVM(normalizedConfig as unknown as DVMConfig<unknown, ZodLike | undefined>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid DVM descriptor export in ${modulePath}: ${message}`, { cause: err });
  }
}

function isDescriptorSketch(value: unknown): value is DescriptorSketch {
  if (!isRecord(value) || !isRecord(value.config)) return false;
  return "onJob" in value.config || "capabilities" in value.config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let tsxRegistered = false;

async function registerTsxIfNeeded(path: string): Promise<void> {
  if (!path.endsWith(".ts")) return;
  await registerTsx();
}

async function registerTsx(onImport?: (url: string) => void): Promise<void> {
  if (tsxRegistered) return;
  try {
    const tsx = await import("tsx/esm/api");
    tsx.register(onImport ? { onImport } : undefined);
    tsxRegistered = true;
  } catch {
    // tsx not available — will fail on import if it's actually .ts
  }
}

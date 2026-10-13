import type { VmConfig } from "./types.ts";

export const MAX_MACHINES_HARD_CEILING = 100;
const DEFAULT_MAX_MACHINES = 1;

/**
 * Structured error thrown by vm-config parse/resolve/validate. Carries a
 * machine-readable code and optional data for upgrade-hint responses.
 */
export class VmConfigError extends Error {
  constructor(
    public code: "invalid_vm_config" | "plan_limit_exceeded",
    message: string,
    public data?: {
      limit?: "memory_mb" | "max_machines" | "cpu_kind";
      requested?: number | string;
      cap?: number | null;
      planName?: string;
      upgradeUrl?: string;
    }
  ) {
    super(message);
    this.name = "VmConfigError";
  }
}

/**
 * Parse an unknown value (from package.json or deploy metadata JSON) into a
 * VmConfig. Validates types, ranges, and inter-field constraints. Throws
 * VmConfigError("invalid_vm_config") on violations.
 */
export function parseVmConfig(raw: unknown): VmConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new VmConfigError(
      "invalid_vm_config",
      "`dvmkit` must be an object with VM resource fields."
    );
  }

  const src = raw as Record<string, unknown>;
  const config: VmConfig = {};

  // Accept both snake_case (package.json convention) and camelCase (internal).
  const memory = pick(src, "memory_mb", "memoryMb");
  if (memory !== undefined) {
    config.memoryMb = parseIntInRange(memory, "memory_mb", 256, 16384);
  }

  const cpu = pick(src, "cpu_count", "cpuCount");
  if (cpu !== undefined) {
    config.cpuCount = parseIntInRange(cpu, "cpu_count", 1, 16);
  }

  const kind = pick(src, "cpu_kind", "cpuKind");
  if (kind !== undefined) {
    if (kind !== "shared" && kind !== "performance") {
      throw new VmConfigError("invalid_vm_config", '`cpu_kind` must be "shared" or "performance".');
    }
    config.cpuKind = kind;
  }

  const minMachines = pick(src, "min_machines_running", "minMachinesRunning");
  if (minMachines !== undefined) {
    config.minMachinesRunning = parseIntInRange(
      minMachines,
      "min_machines_running",
      0,
      MAX_MACHINES_HARD_CEILING
    );
  }

  const maxMachines = pick(src, "max_machines", "maxMachines");
  if (maxMachines !== undefined) {
    config.maxMachines = parseIntInRange(maxMachines, "max_machines", 1, MAX_MACHINES_HARD_CEILING);
  }

  const effectiveMaxMachines = config.maxMachines ?? DEFAULT_MAX_MACHINES;
  if (config.minMachinesRunning !== undefined && effectiveMaxMachines < config.minMachinesRunning) {
    throw new VmConfigError(
      "invalid_vm_config",
      `\`max_machines\` (${effectiveMaxMachines}) must be >= \`min_machines_running\` (${config.minMachinesRunning}).`
    );
  }

  return config;
}


/** Return whichever of `snake` / `camel` is set on `src`. Throws on both-present
 *  to catch typo cases like `{memory_mb: 1024, memoryMb: 2048}`. */
function pick(src: Record<string, unknown>, snake: string, camel: string): unknown {
  const hasSnake = src[snake] !== undefined;
  const hasCamel = src[camel] !== undefined;
  if (hasSnake && hasCamel) {
    throw new VmConfigError(
      "invalid_vm_config",
      `\`${snake}\` and \`${camel}\` are both set; use one or the other.`
    );
  }
  return hasSnake ? src[snake] : src[camel];
}

function parseIntInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new VmConfigError(
      "invalid_vm_config",
      `\`${field}\` must be an integer between ${min} and ${max}.`
    );
  }
  if (value < min || value > max) {
    throw new VmConfigError(
      "invalid_vm_config",
      `\`${field}\` must be an integer between ${min} and ${max} (got ${value}).`
    );
  }
  return value;
}

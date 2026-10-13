import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { loadProjectEnvironment, mergeProjectEnvironment } from "../../lib/dev-environment.ts";
import { describeMnemonicBackups } from "../../lib/mnemonic-backups.ts";
import { CLI_VERSION } from "../../lib/version.ts";
import {
  BUILDER_CONFIG_DIR,
  BUILDER_MNEMONIC_FILE,
  LEGACY_BUILDER_MNEMONIC_FILE,
  RECOVERY_MNEMONIC_FILE,
} from "../../shared/defaults.ts";
import { info, json } from "../../shared/output.ts";

const execFileAsync = promisify(execFile);

export interface BuilderDoctorOptions {
  human?: boolean;
}

export interface BuilderDoctorCheck {
  name: string;
  group: "runtime" | "files" | "network";
  status: "ok" | "warn" | "fail";
  display: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export interface BuilderDoctorReport {
  checks: BuilderDoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
  configDir: string;
  cliVersion: string;
  nodeVersion: string;
}

export interface BuilderDoctorDeps {
  dockerVersion(): Promise<string>;
  probeMint(url: string): Promise<void>;
}

const defaultDeps: BuilderDoctorDeps = {
  async dockerVersion() {
    const result = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 3_000,
    });
    return result.stdout.trim();
  },
  async probeMint(url) {
    const response = await fetch(new URL("/v1/info", ensureTrailingSlash(url)), {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  },
};

/** Diagnose builder-side local state without modifying it. */
export async function builderDoctor(
  opts: BuilderDoctorOptions,
  deps: BuilderDoctorDeps = defaultDeps
): Promise<void> {
  const checks: BuilderDoctorCheck[] = [nodeCheck(), callerConfigCheck()];

  try {
    const warning = describeMnemonicBackups([
      BUILDER_MNEMONIC_FILE,
      LEGACY_BUILDER_MNEMONIC_FILE,
      RECOVERY_MNEMONIC_FILE,
    ]);
    if (warning) {
      checks.push({ name: "mnemonic_backups", group: "files", status: "warn", ...warning });
    }
  } catch (err) {
    checks.push({
      name: "mnemonic_backups",
      group: "files",
      status: "fail",
      display:
        "Could not check the current or legacy builder mnemonic locations for plaintext backups.",
      hint: `Check that ${BUILDER_CONFIG_DIR} and the directory containing ${RECOVERY_MNEMONIC_FILE} are readable.`,
      details: { error: message(err) },
    });
  }

  try {
    const version = await deps.dockerVersion();
    checks.push({
      name: "docker",
      group: "runtime",
      status: "ok",
      display: `Docker server ${version || "is reachable"}.`,
      hint: "Docker is used by deploy --dry-run and container-backed tests.",
    });
  } catch (err) {
    checks.push({
      name: "docker",
      group: "runtime",
      status: "warn",
      display: "Docker is unavailable; Docker-free paid dev still works.",
      hint: "Start Docker only for deploy --dry-run, container builds, or container-backed tests.",
      details: { error: message(err) },
    });
  }

  for (const mint of configuredMints()) {
    try {
      await deps.probeMint(mint);
      checks.push({
        name: `cashu_mint:${mint}`,
        group: "network",
        status: "ok",
        display: `Cashu mint reachable: ${mint}.`,
      });
    } catch (err) {
      checks.push({
        name: `cashu_mint:${mint}`,
        group: "network",
        status: "fail",
        display: `Cashu mint is not reachable: ${mint}.`,
        hint: "Check this mint URL or remove it from DVMKIT_CASHU_MINTS before starting paid dev.",
        details: { error: message(err), mint },
      });
    }
  }

  const summary = countSummary(checks);
  const report: BuilderDoctorReport = {
    checks,
    summary,
    configDir: BUILDER_CONFIG_DIR,
    cliVersion: CLI_VERSION,
    nodeVersion: process.version,
  };
  if (summary.fail > 0) process.exitCode = 1;
  if (opts.human) renderHuman(report);
  else json(report);
}

function nodeCheck(): BuilderDoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22
    ? {
        name: "node",
        group: "runtime",
        status: "ok",
        display: `Node ${process.versions.node} is supported.`,
      }
    : {
        name: "node",
        group: "runtime",
        status: "fail",
        display: `Node ${process.versions.node} is unsupported; Node 22 or newer is required.`,
        hint: "Install Node 22, then re-run dvmctl doctor.",
      };
}

function callerConfigCheck(): BuilderDoctorCheck {
  const dir = process.env.DVM_CONFIG_DIR;
  const scratchRoot = `${resolve(tmpdir())}${sep}`;
  const resolved = dir && isAbsolute(dir) ? resolve(dir) : undefined;
  if (resolved?.startsWith(scratchRoot)) {
    return {
      name: "caller_config",
      group: "files",
      status: "ok",
      display: `Caller state uses checked scratch location ${resolved}.`,
    };
  }
  return {
    name: "caller_config",
    group: "files",
    status: "warn",
    display: dir
      ? `Caller state location is ${dir}; it is not a checked scratch directory.`
      : "DVM_CONFIG_DIR is not set; paid tests could use the caller's normal wallet.",
    hint: "Set DVM_CONFIG_DIR to a new absolute temporary directory before a local paid test.",
  };
}

function configuredMints(): string[] {
  const env = mergeProjectEnvironment(process.env, loadProjectEnvironment());
  const raw = Object.hasOwn(env, "DVMKIT_CASHU_MINTS") ? env.DVMKIT_CASHU_MINTS : "";
  return [
    ...new Set(
      raw
        .split(",")
        .map((mint) => mint.trim())
        .filter(Boolean)
    ),
  ];
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countSummary(checks: BuilderDoctorCheck[]): { ok: number; warn: number; fail: number } {
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status]++;
  return summary;
}

function renderHuman(report: BuilderDoctorReport): void {
  const { summary } = report;
  info(`Doctor — OK ${summary.ok}  WARN ${summary.warn}  FAIL ${summary.fail}`);
  info(`configDir: ${report.configDir}`);
  info(`cli: ${report.cliVersion}  node: ${report.nodeVersion}`);
  for (const check of report.checks) {
    const badge = check.status === "ok" ? "OK  " : check.status === "warn" ? "WARN" : "FAIL";
    info(`  ${badge}  ${check.display}`);
    if (check.hint) info(`        ↳ ${check.hint}`);
  }
}

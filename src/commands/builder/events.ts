import { parseDurationMs } from "../../lib/duration.ts";
import * as platformClient from "../../lib/platform-client.ts";
import type { DvmEventEntry } from "../../builder-platform/types.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface EventsOptions {
  since?: string;
  human?: boolean;
  org?: string;
}

export async function events(slug: string, opts: EventsOptions): Promise<void> {
  // Validate eagerly so a bad duration fails before any network call.
  if (opts.since) parseDurationMs(opts.since);

  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const result = await platformClient.getEvents(platformUrl, token, dvmId, { since: opts.since });

  if (opts.human) {
    info(`  Events for ${result.slug} (last ${result.since}):`);
    if (result.events.length === 0) {
      info("    (none)");
    } else {
      for (const e of result.events) {
        info(`    ${fmtDate(e.timestamp)}  ${e.type.padEnd(16)}  ${summarise(e)}`);
      }
    }
    for (const w of result.warnings ?? []) {
      info(`  ! ${w}`);
    }
  } else {
    json({ ...result, dvmId, slug });
  }
}

/** Stringify an unknown detail value without tripping `no-base-to-string`. */
function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** One-line human summary of an event's salient detail. */
function summarise(e: DvmEventEntry): string {
  const d = e.details;
  switch (e.source) {
    case "deploy": {
      const parts = [str(d.status)];
      if (d.trigger) parts.push(`via ${str(d.trigger)}`);
      if (typeof d.durationMs === "number") parts.push(`in ${fmtDuration(d.durationMs)}`);
      if (d.error) parts.push(`— ${str(d.error)}`);
      return parts.filter(Boolean).join(" ");
    }
    case "machine":
      return `${str(d.machineId)}${d.status ? ` (${str(d.status)})` : ""}`;
    case "audit":
      return summariseAudit(e.type, d, e.actor);
  }
}

interface VmShape {
  maxMachines?: number;
  memoryMb?: number;
  cpuCount?: number;
}

function summariseAudit(type: string, d: Record<string, unknown>, actor: string | null): string {
  const by = actor ? ` by ${actor}` : "";
  switch (type) {
    case "scale": {
      const before = d.before as VmShape | undefined;
      const after = d.after as VmShape | undefined;
      const bits: string[] = [];
      if (before?.maxMachines !== after?.maxMachines) {
        bits.push(`count ${before?.maxMachines}→${after?.maxMachines}`);
      }
      if (before?.memoryMb !== after?.memoryMb || before?.cpuCount !== after?.cpuCount) {
        bits.push(
          `size ${before?.cpuCount}cpu/${before?.memoryMb}mb→${after?.cpuCount}cpu/${after?.memoryMb}mb`
        );
      }
      return `${bits.join(", ") || "no change"}${by}`;
    }
    case "env_set":
    case "env_unset":
      return `${((d.keys as string[] | undefined) ?? []).join(", ")}${by}`;
    case "restart":
      return `${((d.machines as string[] | undefined) ?? []).length} machine(s)${by}`;
    case "pause":
      return `${((d.machines as string[] | undefined) ?? []).length} machine(s) stopped${by}`;
    case "resume":
      return `${((d.machines as string[] | undefined) ?? []).length} machine(s) started${by}`;
    case "visibility":
      return `hidden=${str(d.hidden)}${by}`;
    default:
      return by.trim();
  }
}

function fmtDate(epoch: number): string {
  return new Date(epoch)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

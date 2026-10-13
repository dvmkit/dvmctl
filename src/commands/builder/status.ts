import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface StatusOptions {
  human?: boolean;
  org?: string;
}

/**
 * Show a deployed DVM's live Fly-side runtime state: which machines are
 * running, in what region, on what image, their health-check results, and the
 * current scale. Platform-mediated (no flyctl builder-side) via the Fly
 * Machines API. Complements `dvmctl info`, which shows DVM-level info from the
 * platform DB rather than live runtime state.
 */
export async function status(slug: string, opts: StatusOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const result = await platformClient.getMachineStatus(platformUrl, token, dvmId);

  if (opts.human) {
    // `paused` is the builder's own pause; `suspensionReason` is what's actually
    // holding the DVM down. A platform suspension layered over a pause leaves
    // both set — pointing the builder at `dvmctl resume` there would send them
    // into a 403.
    if (result.withdrawal) {
      // Checked first: a withdrawal outlasts any suspension reason layered on it.
      info(
        `"${slug}" is being withdrawn. Callers still hold prepaid balances at it, so it answers reclaims until ${fmtDate(new Date(result.withdrawal.delete_after).toISOString())} and is deleted then. It takes no new jobs or deposits.`
      );
      if (!result.reclaimsOpen) info("Reclaims are currently closed by the platform.");
    } else if (result.suspensionReason === "builder_pause") {
      info(`"${slug}" is paused. Run \`dvmctl resume ${slug}\` to bring it back online.`);
    } else if (result.suspensionReason === "free_tier_idle") {
      // Not enforcement — the platform idles a quiet free-tier DVM to save it
      // compute, and the router wakes it on the next request. Most free-tier
      // DVMs sit here, so it must not read like something is wrong. `resume` is
      // named anyway: it's what the builder needs to deploy, scale, restart,
      // exec or ssh, all of which refuse while the DVM is idle.
      info(
        `"${slug}" is idle — the platform stopped its machines after a quiet spell. The next request wakes it automatically; nothing to fix. Run \`dvmctl resume ${slug}\` to bring it back now.`
      );
    } else if (result.status === "suspended") {
      const reason = result.suspensionReason ?? "operator";
      const pause = result.paused
        ? ` Your pause is still on record — "${slug}" returns to paused once the suspension is lifted.`
        : "";
      info(
        `"${slug}" is suspended by the platform (${reason}); \`dvmctl resume\` won't lift it.${pause}`
      );
    }
    if (result.machines.length === 0) {
      info("No machines (DVM is not currently running any).");
    }
    for (const m of result.machines) {
      info("");
      info(`  Machine:  ${m.id}`);
      info(`  State:    ${m.state}`);
      info(`  Region:   ${m.region ?? "—"}`);
      info(`  Image:    ${m.image.version ?? "—"}`);
      info(`  Created:  ${fmtDate(m.created)}`);
      info(`  Started:  ${fmtDate(m.started)}`);
      if (m.checks.length > 0) {
        info("  Checks:");
        for (const check of m.checks) {
          const endpoint = check.endpoint ? ` (${check.endpoint})` : "";
          info(`    ${check.name ?? "?"}: ${check.status ?? "?"}${endpoint}`);
        }
      }
    }
    info("");
    const vm = result.scale.vm_size;
    const size = vm ? `${vm.cpus ?? "?"}× ${vm.cpu_kind ?? "?"}, ${vm.memory_mb ?? "?"}MB` : "—";
    info(
      `  Scale:    ${result.scale.count} machine${result.scale.count === 1 ? "" : "s"} (${size})`
    );
  } else {
    json({ ...result, dvmId, slug });
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

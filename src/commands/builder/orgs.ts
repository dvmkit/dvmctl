import { loadActiveOrg, requireAuth } from "../../lib/platform.ts";
import type { BuilderOrgMembership } from "../../lib/platform-client.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";

export interface OrgsOptions {
  human?: boolean;
}

export async function orgs(opts: OrgsOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const activeOrg = loadActiveOrg();
  const memberships = await platformClient.listBuilderOrgs(platformUrl, token);

  if (opts.human) {
    printHuman(memberships, activeOrg);
    return;
  }

  const sharedCount = memberships.filter((membership) => !membership.isPersonal).length;
  json({
    activeOrg,
    memberships: memberships.map((membership) => outputMembership(membership, activeOrg)),
    display:
      sharedCount === 0
        ? `No shared org memberships. Active context: ${activeOrg ?? "personal"}.`
        : `${sharedCount} shared org membership${sharedCount === 1 ? "" : "s"}. Active context: ${activeOrg ?? "personal"}.`,
    hint:
      sharedCount === 0
        ? "Create or join a shared org in the dashboard. After you join, run `dvmctl switch <handle>`."
        : "Run `dvmctl switch <handle>` to choose a shared org, or `dvmctl switch --personal` for your personal context.",
  });
}

function outputMembership(membership: BuilderOrgMembership, activeOrg: string | null): object {
  const active = membership.isPersonal ? activeOrg === null : membership.handle === activeOrg;
  if (membership.isPersonal) {
    // A personal org's handle is an implementation detail. It cannot be
    // selected with `dvmctl switch`, so never give an agent a handle to try.
    return {
      displayName: membership.displayName,
      role: membership.role,
      personal: true,
      active,
    };
  }
  return {
    handle: membership.handle,
    displayName: membership.displayName,
    role: membership.role,
    personal: false,
    active,
  };
}

function printHuman(memberships: BuilderOrgMembership[], activeOrg: string | null): void {
  info(`Active context: ${activeOrg ?? "personal"}`);
  const shared = memberships.filter((membership) => !membership.isPersonal);
  if (shared.length === 0) info("No shared org memberships.");
  if (memberships.length === 0) return;

  const rows = memberships.map((membership) => ({
    handle: membership.isPersonal ? "—" : membership.handle,
    name: membership.isPersonal
      ? `${membership.displayName ?? "Personal context"} (personal)`
      : (membership.displayName ?? "—"),
    role: membership.role,
    active: membership.isPersonal ? activeOrg === null : membership.handle === activeOrg,
  }));
  const handleW = Math.max(6, ...rows.map((row) => row.handle.length));
  const nameW = Math.max(4, ...rows.map((row) => row.name.length));
  const roleW = Math.max(4, ...rows.map((row) => row.role.length));
  info("");
  info(`  ${"HANDLE".padEnd(handleW)}  ${"NAME".padEnd(nameW)}  ${"ROLE".padEnd(roleW)}  ACTIVE`);
  for (const row of rows) {
    info(
      `  ${row.handle.padEnd(handleW)}  ${row.name.padEnd(nameW)}  ${row.role.padEnd(roleW)}  ${row.active ? "yes" : "no"}`
    );
  }
}

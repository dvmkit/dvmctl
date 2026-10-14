import { loadActiveOrg, requireAuth } from "../../lib/platform.ts";
import type { AuthenticatedBuilderProfile, BuilderOrgMembership } from "../../lib/platform-client.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { loadIdentityPubkey } from "../../shared/builder-store.ts";
import { info, json } from "../../shared/output.ts";

export interface WhoamiOptions {
  human?: boolean;
}

type LocalIdentity =
  | { status: "available"; pubkey: string }
  | { status: "missing"; pubkey: null }
  | { status: "unreadable"; pubkey: null; detail: string };

export async function whoami(opts: WhoamiOptions): Promise<void> {
  const { token, platformUrl } = requireAuth();
  const activeOrg = loadActiveOrg();
  const identity = readLocalIdentity();
  const [builder, memberships] = await Promise.all([
    platformClient.getAuthenticatedBuilderProfile(platformUrl, token),
    platformClient.listBuilderOrgs(platformUrl, token),
  ]);

  if (opts.human) {
    printHuman(builder, memberships, activeOrg, identity);
    return;
  }

  json({
    identity_pubkey: identity.pubkey,
    identity_status: identity.status,
    ...(identity.status === "unreadable" ? { identity_detail: identity.detail } : {}),
    builder,
    activeOrg,
    memberships: memberships.map((membership) => outputMembership(membership, activeOrg)),
    display: `Builder ${builder.email ?? builder.handle ?? builder.id}. Active context: ${activeOrg ?? "personal"}.`,
    hint:
      identity.status === "missing"
        ? "Run `dvmctl identity create` before a cloud or Connect deploy."
        : identity.status === "unreadable"
          ? "Repair the local builder configuration before a cloud or Connect deploy."
          : "Every listed membership can deploy a new DVM. The role shows its existing access level.",
  });
}

function readLocalIdentity(): LocalIdentity {
  try {
    const pubkey = loadIdentityPubkey();
    if (pubkey === null) return { status: "missing", pubkey: null };
    if (!/^[0-9a-f]{64}$/.test(pubkey)) {
      return {
        status: "unreadable",
        pubkey: null,
        detail: "Local builder identity pubkey is not a 64-character hexadecimal key.",
      };
    }
    return { status: "available", pubkey };
  } catch (error) {
    return {
      status: "unreadable",
      pubkey: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function outputMembership(membership: BuilderOrgMembership, activeOrg: string | null): object {
  const active = membership.isPersonal ? activeOrg === null : membership.handle === activeOrg;
  if (membership.isPersonal) {
    return {
      displayName: membership.displayName,
      role: membership.role,
      personal: true,
      deployable: true,
      active,
    };
  }
  return {
    handle: membership.handle,
    displayName: membership.displayName,
    role: membership.role,
    personal: false,
    deployable: true,
    active,
  };
}

function printHuman(
  builder: AuthenticatedBuilderProfile,
  memberships: BuilderOrgMembership[],
  activeOrg: string | null,
  identity: LocalIdentity
): void {
  info(`Builder: ${builder.displayName ?? builder.email ?? builder.handle ?? builder.id}`);
  info(`  id: ${builder.id}`);
  info(`  email: ${builder.email ?? "—"}`);
  info(`  handle: ${builder.handle ?? "—"}`);
  info(`  identity pubkey: ${identity.pubkey ?? "—"} (${identity.status})`);
  if (identity.status === "unreadable") info(`  identity detail: ${identity.detail}`);
  info(`Active context: ${activeOrg ?? "personal"}`);

  if (memberships.length === 0) {
    info("No org memberships found.");
    return;
  }

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
  info(
    `  ${"HANDLE".padEnd(handleW)}  ${"NAME".padEnd(nameW)}  ${"ROLE".padEnd(roleW)}  DEPLOY  ACTIVE`
  );
  for (const row of rows) {
    info(
      `  ${row.handle.padEnd(handleW)}  ${row.name.padEnd(nameW)}  ${row.role.padEnd(roleW)}  yes     ${row.active ? "yes" : "no"}`
    );
  }
}

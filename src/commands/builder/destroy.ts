import { createInterface } from "node:readline";

import { DvmError, shellQuoteArg } from "@dvmkit/sdk/internal";

import * as platformClient from "../../lib/platform-client.ts";
import { info, json } from "../../shared/output.ts";
import { connectAdmin } from "./admin-connection.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface DestroyOptions {
  confirm?: boolean;
  keepDb?: boolean;
  human?: boolean;
  /** Org handle to target, overriding the active `dvmctl switch` context. */
  org?: string;
}

/**
 * Destroy a deployed DVM. By default both the Fly compute app and its paired
 * Postgres cluster are destroyed. Pass --keep-db to preserve the cluster.
 *
 * A DVM whose callers still hold prepaid balances is not deleted at once: the
 * platform winds it down for 30 days so they can reclaim, and says
 * so in its answer.
 */
export async function destroy(slug: string, opts: DestroyOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);
  const keepDb = opts.keepDb ?? false;

  const target = `${shellQuoteArg(slug)}${opts.org === undefined ? "" : ` --org ${shellQuoteArg(opts.org)}`}`;

  info(`Complete and verify your financial export before destroying compute, with or without --keep-db. Run dvmctl db proxy ${target} or dvmctl db connect ${target}, then use psql with @dvmkit/sdk's recipes/postgres/financial-export-v1.sql. You own the export file; platform-retained history does not replace it. --keep-db preserves storage but removes compute and its database tunnel. Later access requires redeploying and reattaching the retained database before db connect or db proxy can work. See the bundled build-dvm financial-export reference.`);

  if (opts.human) {
    const prompt = keepDb
      ? `This will destroy the compute app for "${slug}" (${dvmId}). Its database will be preserved and can be re-attached on redeploy. Type the DVM ID to confirm: `
      : `This will permanently delete "${slug}" (${dvmId}) and its database. This cannot be undone. Type the DVM ID to confirm: `;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
    if (answer !== dvmId) {
      throw new DvmError("cancelled", "Destroy cancelled.");
    }
  } else if (!opts.confirm) {
    throw new DvmError(
      "confirmation_required",
      "Pass --confirm to destroy in non-interactive mode.",
      `Complete and verify the financial export via dvmctl db proxy ${target} or dvmctl db connect ${target} and the SDK financial-export-v1.sql recipe before removing compute. --keep-db retains storage, not the tunnel; later access requires redeployment and database reattachment. Then use: dvmctl destroy ${target}${keepDb ? " --keep-db" : ""} --confirm`
    );
  } else if (!keepDb) {
    info(
      `Note: --keep-db not passed; "${slug}"'s database will be destroyed. ` +
        `(Default changed: pass --keep-db to preserve the cluster for re-attachment.)`
    );
  }

  const ledger = await readLedgerReport(slug, opts);
  const result = await platformClient.destroyDvm(platformUrl, token, dvmId, {
    keepDb,
    ...(ledger ? { ledger } : {}),
  });

  if (result.status === "winding_down") {
    if (opts.human) {
      info(result.display);
      info(`Run \`dvmctl status ${slug}\` to check the deletion date.`);
    } else {
      json(result);
    }
    return;
  }
  if (opts.human) {
    if (keepDb) {
      info(`Destroyed "${slug}". Database has been preserved.`);
    } else {
      info(`Destroyed "${slug}". Fly app and database have been removed.`);
    }
  } else {
    json({ status: "destroyed", dvmId, slug, keptDb: keepDb });
  }
}

/**
 * Ask the DVM's own ledger what it owes callers, signed with this builder's
 * lock key, so the platform weighs it beside its own records. Best-effort: a
 * DVM that is down, or a machine without the builder mnemonic, sends nothing
 * and the platform's records decide alone.
 */
async function readLedgerReport(
  slug: string,
  opts: DestroyOptions
): Promise<platformClient.DestroyLedgerReport | null> {
  try {
    const { client } = await connectAdmin(slug, { org: opts.org });
    const res = await client.getBitcoinLiability();
    return {
      open_credits: res.deposit_credits,
      pending_drains: res.drain_count,
      gaps: res.uncovered_credits + res.unbacked_credits + res.unpriced_drains,
    };
  } catch {
    return null;
  }
}

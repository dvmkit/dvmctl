// Builder-owned liability surface shipped with dvmctl.
import { DvmError } from "@dvmkit/sdk/internal";

import type { AdminBitcoinLiabilityResponse } from "../../lib/admin-cashu-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, type AdminConnectionOptions, connectAdmin } from "./admin-connection.ts";

export interface CreditLiabilityOptions extends AdminConnectionOptions {
  /**
   * The hub's current spendable balance in sats. Supplying it turns the read
   * into the sweep decision itself: what is above the floor is yours.
   */
  hubSats?: string;
  human?: boolean;
}

/** One DVM's share of the floor, as this command publishes it. */
interface DvmLiability extends AdminBitcoinLiabilityResponse {
  handle: string;
  dvm_id: string;
}

/**
 * What your DVMs owe callers in satoshis, and how much of the hub is yours.
 *
 * A reusable Bitcoin credit is a deposit: the caller can ask for it back at any
 * moment, and since tracked change what they get back is the asset they sent, pro
 * rata, rather than a dollar figure re-priced at reclaim time. So the hub's
 * balance is two pots — deposits, which are theirs, and earnings, which are
 * yours — and the sweep rule is to bank the second and never the first.
 *
 * Every figure is read off the funding lots each deposit recorded, at the rate
 * that funding actually landed at. Nothing here consults an exchange rate,
 * because nothing about the obligation depends on one.
 *
 * Takes several handles because one hub normally backs several DVMs, and a
 * sweep netted against a single DVM's floor is wrong by the rest of them.
 * Read-only.
 */
export async function creditLiability(
  handles: string[],
  opts: CreditLiabilityOptions
): Promise<void> {
  const hubSats = parseHubSats(opts.hubSats);
  const dvms: DvmLiability[] = [];
  for (const handle of handles) {
    const { client, dvmId } = await connectAdmin(handle, opts);
    const res = await adminCall(() => client.getBitcoinLiability());
    dvms.push({ ...res, handle, dvm_id: dvmId });
  }

  const depositSats = sum(dvms, (d) => d.deposit_liability_sats);
  const drainSats = sum(dvms, (d) => d.drain_liability_sats);
  const totalOwed = depositSats + drainSats;
  const sweepable = hubSats === undefined ? undefined : hubSats - totalOwed;
  const gaps =
    sum(dvms, (d) => d.uncovered_credits) +
    sum(dvms, (d) => d.unbacked_credits) +
    sum(dvms, (d) => d.unpriced_drains);
  const gapBalances = collectGapBalances(dvms);

  if (opts.human) {
    for (const dvm of dvms) {
      raw(
        `${dvm.handle}  deposits=${dvm.deposit_liability_sats} sats (${dvm.deposit_credits} credit(s))` +
          `  reclaims=${dvm.drain_liability_sats} sats  owed=${dvm.total_owed_sats} sats`
      );
    }
    info(
      `Owed to callers: ${totalOwed} sats (${depositSats} undrawn deposits, ${drainSats} promised reclaims). ` +
        (sweepable === undefined
          ? "Subtract that from your hub balance — the rest is earnings you can sweep."
          : sweepable >= 0
            ? `Hub holds ${hubSats ?? 0} sats, so ${sweepable} sats are earnings you can sweep.`
            : `Hub holds only ${hubSats ?? 0} sats — that is ${-sweepable} sats SHORT of what callers are owed.`)
    );
    if (gaps > 0) info(gapSentence(gapBalances, gaps));
    return;
  }

  json({
    op: "credit_liability",
    handles,
    dvms,
    deposit_liability_sats: depositSats,
    drain_liability_sats: drainSats,
    total_owed_sats: totalOwed,
    hub_sats: hubSats ?? null,
    sweepable_sats: sweepable ?? null,
    solvent: sweepable === undefined ? null : sweepable >= 0,
    display:
      `Callers are owed ${totalOwed} sats across ${dvms.length} DVM(s): ${depositSats} sats of prepaid balance nobody has drawn yet, ` +
      `and ${drainSats} sats already promised to reclaims in flight. ` +
      (sweepable === undefined
        ? "Whatever the hub holds above that figure is earnings."
        : sweepable >= 0
          ? `The hub holds ${hubSats ?? 0} sats, so ${sweepable} sats of it are earnings and the rest has to stay put.`
          : `The hub holds ${hubSats ?? 0} sats, which is ${-sweepable} sats less than callers are owed — top it up before sweeping anything.`),
    hint:
      sweepable === undefined
        ? "Re-run with `--hub-sats <balance>` to get the sweepable figure directly instead of subtracting by hand."
        : "Sweep no more than `sweepable_sats`. These are satoshis the DVMs owe back as satoshis, so the figure does not move with the exchange rate.",
    ...(gaps > 0
      ? {
          gap_note: gapSentence(gapBalances, gaps),
          gap_by_currency: gapBalances.byCurrency,
          gap_unknown_credits: gapBalances.unknownCredits,
        }
      : {}),
  });
}

function sum(dvms: DvmLiability[], pick: (dvm: DvmLiability) => number): number {
  return dvms.reduce((total, dvm) => total + pick(dvm), 0);
}

interface GapBalances {
  byCurrency: { currency: string; micro: number; credits: number }[];
  unknownCredits: number;
  unpricedDrains: number;
}

function collectGapBalances(dvms: DvmLiability[]): GapBalances {
  const totals = new Map<string, { currency: string; micro: number; credits: number }>();
  let unknownCredits = 0;
  for (const dvm of dvms) {
    for (const category of ["uncovered", "unbacked"] as const) {
      const balances = dvm[`${category}_by_currency`];
      if (balances === undefined) {
        unknownCredits += dvm[`${category}_credits`];
        continue;
      }
      for (const balance of balances) {
        const total = totals.get(balance.currency) ?? {
          currency: balance.currency,
          micro: 0,
          credits: 0,
        };
        total.micro += balance.micro;
        total.credits += balance.credits;
        totals.set(balance.currency, total);
      }
    }
  }
  return {
    byCurrency: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    unknownCredits,
    unpricedDrains: sum(dvms, (dvm) => dvm.unpriced_drains),
  };
}

/**
 * One sentence about balance the sats figures cannot speak for.
 *
 * Kept as a note rather than folded into the totals, because the two are
 * different kinds of number: the totals are exact obligations in sats, and
 * these are balances that will be converted at whatever the rate is when they
 * are reclaimed. Adding a guess to an exact figure would make the sweep less
 * safe, not more.
 */
function gapSentence(balances: GapBalances, gaps: number): string {
  const known = balances.byCurrency.length
    ? `Ledger balances: ${balances.byCurrency.map((balance) => `${(balance.micro / 1_000_000).toFixed(6)} ${balance.currency}`).join("; ")}. `
    : "";
  const unknown = balances.unknownCredits > 0
    ? `${balances.unknownCredits} credit(s): denomination and amount are unknown. `
    : "";
  const reclaims = balances.unpricedDrains > 0
    ? `${balances.unpricedDrains} reclaim(s): denomination and amount are unknown. `
    : "";
  return (
    `${gaps} credit(s) or reclaim(s) have no in-kind figure. ${known}${unknown}${reclaims}` +
    `These balances are excluded from the satoshi totals and use the rate current when reclaimed. Leave headroom for them, and check the DVM's ` +
    `\`credit_funding_lot_backfill\` log line if the count is not falling.`
  );
}

function parseHubSats(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const sats = Number(value);
  if (!Number.isSafeInteger(sats) || sats < 0) {
    throw new DvmError(
      "invalid_hub_balance",
      `\`--hub-sats\` must be a whole number of satoshis (got ${value}).`,
      "Pass your hub's spendable balance in sats, e.g. `--hub-sats 250000`. Omit the flag to print what is owed and subtract it yourself."
    );
  }
  return sats;
}

import { createHash } from "node:crypto";

import { DvmError } from "@dvmkit/sdk/internal";

import { deriveSlug } from "../../lib/deploy-attestation.ts";
import { info, json } from "../../shared/output.ts";
import { adminCall, type AdminConnectionOptions, connectAdmin } from "./admin-connection.ts";

export interface RefundOptions extends AdminConnectionOptions {
  dvm?: string;
  amount?: string;
  reason?: string;
  refundId?: string;
  confirm?: boolean;
  human?: boolean;
}

const REFUSAL_HINTS: Record<string, string> = {
  draw_not_found: "Check the DVM and job ID. Only jobs charged to prepaid credit can be refunded with dvmctl; per-job payments are unsupported. If the IDs are correct, an operator must inspect independent ownership evidence; retrying alone cannot establish it.",
  draw_not_completed: "This draw has not completed. A failed job's held charge is released by its failure path; inspect the job before deciding on a refund.",
  refund_exceeds_draw: "The amount exceeds the remaining unrefunded charge. Check earlier refunds, then omit --amount to refund the remainder or choose a smaller amount.",
  credit_not_open: "This credit is closed, so this payment cannot be refunded through dvmctl. The owner or operator must review how to make the caller whole separately.",
  credit_refund_channel_unsupported: "Tempo channel payments and x402 batch-channel payments cannot be refunded through dvmctl. Their escrow returns unused credit at channel exit; the owner or operator must review a separate remedy for a completed charge.",
  credit_refund_basis_unavailable: "dvmctl cannot automatically refund this older Bitcoin payment because its original paid amount is unproven. An operator must inspect independent original-payment evidence. Retrying alone or using today's exchange rate cannot repair missing evidence.",
  credit_refund_state_unavailable: "The retained records do not establish this credit's historical open state. An operator must inspect independent funding and drain evidence before any repair. Retrying alone cannot repair that evidence.",
  refund_conflict: "This refund ID was already used with different arguments. Repeat the original arguments, or deliberately choose a new --refund-id for a separate partial refund.",
  credit_refund_unavailable: "Have the DVM owner or operator configure the persistent credit store and platform refund reporter, then retry with the original refund ID. This refusal did not queue a refund.",
};

export async function refund(jobId: string, opts: RefundOptions): Promise<void> {
  const job = jobId.trim();
  if (!job) throw new DvmError("invalid_job_id", "A job ID is required.", "Pass the completed job's ID.");
  const handle = opts.dvm === undefined ? deriveSlug(process.cwd()) : opts.dvm.trim();
  if (!handle) throw new DvmError("invalid_dvm", "A DVM name is required.", "Pass --dvm with the intended service's slug.");
  const amountMicro = parseAmount(opts.amount);
  if (opts.reason !== undefined && opts.reason.length > 280) {
    throw new DvmError("invalid_reason", "A refund reason must be at most 280 characters.", "Shorten --reason and repeat the same refund intent.");
  }
  if (opts.refundId !== undefined && !opts.refundId.trim()) {
    throw new DvmError("invalid_refund_id", "A refund ID must not be empty.", "Pass a nonempty --refund-id and keep it for retries of this refund.");
  }
  const intent = amountMicro === undefined
    ? "the remaining unrefunded charge"
    : `${formatMicro(amountMicro)} in this job's credit currency`;
  // A preview cannot resolve an endpoint or read current pricing/balance: even
  // discovery is HTTP, and neither value establishes the original charge.
  if (!opts.confirm) {
    throw new DvmError("confirmation_required", "Refund confirmation is required.",
      "Repeat the same command with --confirm to submit this intent. The DVM will check eligibility and the refundable amount; no HTTP request has been sent.",
      { handle, job_id: job, amount_micro: amountMicro ?? null, amount_intent: amountMicro === undefined ? "remainder" : "explicit", ...(opts.refundId === undefined ? {} : { refund_id: opts.refundId }) },
      `Would refund ${intent} for job ${job} on ${handle} to the caller's credit. This local intent does not establish eligibility.`);
  }

  const { client, dvmId } = await connectAdmin(handle, opts);
  // Hash canonical identity and normalized amount, never a balance snapshot.
  // Leaving reason out makes a changed-reason retry conflict rather than pay twice.
  const refundId = opts.refundId ?? `refund-${createHash("sha256").update(JSON.stringify(["dvmctl-refund-v1", dvmId, job, amountMicro ?? "remainder"])).digest("hex")}`;
  const res = await refundCall(() => client.refundDraw({
    jobId: job, refundId,
    ...(amountMicro === undefined ? {} : { amountMicro }),
    ...(opts.reason === undefined ? {} : { reason: opts.reason }),
  }));
  const amount = `${formatMicro(res.amount_micro)} ${res.currency.toUpperCase()}`;
  const display = res.replayed
    ? `This refund already returned ${amount} to the caller's credit on ${handle}. Nothing changed; the amount and balance_after_micro describe the original refund, not the current balance.`
    : `Refunded ${amount} to the caller's credit on ${handle}. They can use it on another job or reclaim it with \`dvm credit drain ${handle}\`.`;
  const hint = `Keep refund ID ${res.refund_id} and the original arguments for retries. Use a new --refund-id only for a deliberate additional partial refund. The caller can inspect their balance with \`dvm credit balance ${handle}\` or reclaim it with \`dvm credit drain ${handle}\`.`;
  if (opts.human) {
    info(display);
    info(hint);
    return;
  }
  json({ op: "refund", handle, dvmId, ...res, display, hint });
}

function parseAmount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return invalidAmount();
  const [whole, fraction = ""] = value.split(".");
  const micro = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micro <= 0n || micro > BigInt(Number.MAX_SAFE_INTEGER)) return invalidAmount();
  return Number(micro);
}

function invalidAmount(): never {
  throw new DvmError("invalid_amount", "--amount must be a positive decimal with at most six fractional digits and a safe integer micro-unit value.", "Use an amount in the job's credit currency, such as 0.003, or omit --amount to refund the remaining unrefunded charge. Exponents and rounding are unsupported.");
}

function formatMicro(value: number): string {
  const micro = BigInt(value);
  const fraction = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${micro / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

async function refundCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await adminCall(fn);
  } catch (err) {
    if (err instanceof DvmError) {
      const hint = (Object.hasOwn(REFUSAL_HINTS, err.code) ? REFUSAL_HINTS[err.code] : undefined)
        ?? (err.code === "not_found" && err.data?.http_status === 404
          ? "This DVM does not serve completed-job refunds. Upgrade the service to @dvmkit/sdk 0.11.0-rc.1 or a compatible later release, then retry with the original refund ID."
          : undefined);
      if (hint) {
        const { hint: _providerHint, ...proseSources } = err.proseSources ?? {};
        throw new DvmError(err.code, err.message, hint, err.data, err.display, proseSources);
      }
    }
    throw err;
  }
}

// Builder-owned x402 exact-settlement repair surface shipped with dvmctl.
import { info, json, raw } from "../../shared/output.ts";
import { adminCall, connectAdmin } from "./admin-connection.ts";

export interface X402ExactWedgedOptions {
  endpoint?: string;
  limit?: number;
  includeResolved?: boolean;
  human?: boolean;
  org?: string;
}

export interface X402ExactReconcileOptions {
  endpoint?: string;
  human?: boolean;
  org?: string;
}

/** List exact x402 payments whose chain and local outcomes have not converged. */
export async function x402ExactWedged(handle: string, opts: X402ExactWedgedOptions): Promise<void> {
  const limit = opts.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("limit must be an integer in 1..50");
  }
  const { client, dvmId } = await connectAdmin(handle, opts);
  const response = await adminCall(() =>
    client.getX402ExactSettlements({
      limit,
      ...(opts.includeResolved ? { includeResolved: true } : {}),
    })
  );
  if (opts.human) {
    if (response.settlements.length === 0) {
      info("No exact x402 payments are waiting for recovery.");
      return;
    }
    for (const settlement of response.settlements) {
      raw(
        `${settlement.settlement_intent_id}  ${settlement.status}  tx=${settlement.transaction ?? "unknown"}` +
          `  credit=${settlement.credit_id ?? "-"} job=${settlement.job_id ?? "-"}`
      );
    }
    info(
      `Finish a chain-evidenced payment with \`dvmctl credit x402-exact-reconcile ${handle} <settlement-intent-id>\`.`
    );
    return;
  }
  json({
    op: "credit_x402_exact_wedged",
    handle,
    dvmId,
    slug: handle,
    settlements: response.settlements,
    wedged_count: response.settlements.filter(
      (settlement) => settlement.status !== "complete" && settlement.status !== "rejected"
    ).length,
    display:
      response.settlements.length === 0
        ? "No exact x402 payments are waiting for recovery."
        : `${response.settlements.length} exact x402 payment(s) need an operator decision or local finalization.`,
    hint: "Run `dvmctl credit x402-exact-reconcile <handle> <settlement-intent-id>` only after this queue shows the authorization; the DVM derives the transaction and amount from its own evidence.",
  });
}

/** Finish the local effect of one chain-evidenced exact x402 payment. */
export async function x402ExactReconcile(
  handle: string,
  settlementIntentId: string,
  opts: X402ExactReconcileOptions
): Promise<void> {
  const { client, dvmId } = await connectAdmin(handle, opts);
  const response = await adminCall(() => client.reconcileX402ExactSettlement(settlementIntentId));
  const admissionPending = response.settlement_status === "local_committed";
  if (opts.human) {
    info(
      admissionPending
        ? `Recorded settlement ${response.transaction ?? response.settlement_intent_id}; its original job will be admitted when the caller retries the same request.`
        : response.replayed
          ? `Settlement ${response.settlement_intent_id} was already recorded locally. Nothing changed.`
          : `Recorded settlement ${response.transaction ?? response.settlement_intent_id} against its original local effect.`
    );
    return;
  }
  json({
    op: "credit_x402_exact_reconcile",
    handle,
    dvmId,
    slug: handle,
    ...response,
    display: admissionPending
      ? `Recorded exact x402 transaction ${response.transaction ?? "from the DVM's chain evidence"}; its original job is still waiting for admission.`
      : response.replayed
        ? "This exact x402 payment was already finalized locally. Nothing changed."
        : `Finalized the original local effect for exact x402 transaction ${response.transaction ?? "recorded by the DVM"}.`,
    hint: admissionPending
      ? "Have the caller retry the identical signed request and x402 authorization. The DVM will reuse the settled payment and original job id; do not create a new authorization."
      : response.job_id
        ? "The caller can retry or query its original request; no new payment authorization is needed."
        : "The original credit funding is now recorded; the caller can read that credit without paying again.",
  });
}

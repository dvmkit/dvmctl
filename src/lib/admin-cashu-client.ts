import type { ContentHoldsResponse } from "@dvmkit/sdk/server";
import type { SerializedDLEQ } from "@cashu/cashu-ts";
import { ADMIN_STATE_UNAVAILABLE, buildAdminAuthHeader, DvmError } from "@dvmkit/sdk/internal";

/**
 * One proof tuple as returned by `GET /admin/cashu/pending-batches`. The
 * shape mirrors NUT-00 with the DVM's accumulator row id elided — `row_ids`
 * sits one level up on the batch.
 */
export interface AdminBatchProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  /** Mint-issued DLEQ evidence; absent for legacy and non-DLEQ proofs. */
  dleq?: SerializedDLEQ;
}

/**
 * Single melt-ready batch as returned by `GET /admin/cashu/pending-batches`.
 * `lock_pubkey` is the pubkey that locked the proofs — the builder's CLI
 * derives the matching privkey from its mnemonic before melting.
 */
export interface AdminBatch {
  mint_url: string;
  lock_pubkey: string;
  row_ids: string[];
  proofs: AdminBatchProof[];
  total_sats: number;
  t_expire: number | null;
}

/** Response body shape from `GET /admin/cashu/pending-batches`. */
export interface AdminPendingBatchesResponse {
  batches: AdminBatch[];
}

/** Request body for `POST /admin/cashu/mark-melted`. */
export interface AdminMarkMeltedRequest {
  row_ids: string[];
  melt_quote_id: string;
  payment_preimage: string;
}

/** Response body from `POST /admin/cashu/mark-melted`. */
export interface AdminMarkMeltedResponse {
  melted: number;
}

/** One pending drain as returned by `GET /admin/credit/pending-drains`. */
export interface AdminPendingDrain {
  credit_id: string;
  drain_id: string;
  method: "cashu" | "x402" | "tempo";
  /** Method-specific payout target the caller signed. */
  payout: Record<string, string>;
  currency: string;
  amount_micro: number;
  /**
   * The cashu reclaim's obligation in sats: the in-kind figure the drain
   * recorded, or — where its lots could not price it — the fiat
   * debit converted at serve time. `null` for the on-chain methods, which
   * nothing here prices or pays. `sats_basis` says which.
   */
  amount_sats: number | null;
  amount_msats: number | null;
  /**
   * The debit in the funding rail's own units — the figure an on-chain payout
   * has to be sized against, and the one an operator settling a `manual` row
   * actually sends. `null` on a credit that records no rail basis, where the
   * fiat `amount_micro` is all the ledger knows.
   */
  amount_native: number | null;
  /**
   * Where `amount_sats` came from: `in_kind` is the obligation the drain
   * recorded off the credit's funding lots, `rate` is the fallback
   * conversion of the fiat debit for a credit whose lots cannot price it.
   * `null` wherever `amount_sats` is.
   */
  sats_basis: "in_kind" | "rate" | null;
  /**
   * Who settles this row: `automatic` is what the batch job can pay from a
   * builder-held key — cashu alone, parking a token locked to the caller's
   * refund key;
   * `manual` is a one-payment stablecoin payout with no such key, filed for a
   * person; `channel` is a channel-backed reclaim its own
   * cooperative close settles, which is `pending` here while that close
   * reconciles and is nobody's worklist item. It is also why
   * `amount_sats` is null on the latter two — nothing here prices or pays
   * them, so the null is not an fx failure.
   */
  settlement: "automatic" | "manual" | "channel";
  /**
   * The channel a `channel` row settles through; `null` on every other row.
   * `payout` cannot stand in for it — a channel-backed mpp drain carries `{}`.
   */
  channel_id: string | null;
  created_at: number;
}

/** Response body from `GET /admin/credit/pending-drains`. */
export interface AdminPendingDrainsResponse {
  drains: AdminPendingDrain[];
  /**
   * The mints this DVM currently accepts, health-filtered — where
   * the servicer may buy a refund when the accumulator cannot cover it.
   * Absent from a DVM that predates the field, which reads as "nowhere to
   * mint" and leaves such a drain queued rather than mis-minting it.
   */
  mints?: string[];
  /** Outstanding (un-fulfilled) refund liability by rail. */
  liability: {
    cashu_sats: number;
    by_method_micro: Record<string, number>;
    /** The `manual` rows' total — what no batch job will ever pay down. */
    manual_micro: number;
    /** The `channel` rows' total — owed, but by a close already in flight. */
    channel_micro: number;
  };
}

export interface AdminRefundDrawRequest {
  jobId: string;
  refundId: string;
  /** Omission is a stable request for the draw's unrefunded remainder. */
  amountMicro?: number;
  reason?: string;
}

export interface AdminRefundDrawResponse {
  status: "refunded";
  refund_id: string;
  credit_id: string;
  draw_id: string;
  job_id: string;
  amount_micro: number;
  currency: string;
  ledger_seq: number;
  refunded_at: number;
  /** The original refund's balance snapshot, including on replay. */
  balance_after_micro: number;
  replayed: boolean;
}

/**
 * Response body from `GET /admin/credit/bitcoin-liability` — what
 * this DVM owes callers in satoshis, priced off funding lots rather than a
 * live rate.
 */
export interface AdminBitcoinLiabilityResponse {
  /**
   * Sats owed if every open non-channel Bitcoin credit reclaimed right now.
   * Counts only credits whose reclaim settles in kind; the gap fields below
   * are excluded from it rather than partly folded in.
   */
  deposit_liability_sats: number;
  deposit_credits: number;
  deposit_by_rail: { rail: string; sats: number; credits: number }[];
  /** The same deposits in ledger currency, grouped — micro across currencies never sums. */
  deposit_by_currency: { currency: string; micro: number; credits: number }[];
  /** Sats already promised to registered, unfulfilled cashu reclaims. */
  drain_liability_sats: number;
  drain_count: number;
  /** The floor a payout sweep must never bank below for this DVM. */
  total_owed_sats: number;
  /** Credits whose lots fall short of their balance — a defect, and money the totals cannot speak for. */
  uncovered_credits: number;
  /** Whole balances needing live-rate reclaim, grouped by their ledger denomination. */
  uncovered_by_currency?: { currency: string; micro: number; credits: number }[];
  /** Older endpoints omit denomination; this scalar cannot supply a monetary warning. */
  uncovered_micro?: number;
  /** Credits holding any open micro with no sats basis, so their reclaim prices off a live rate. */
  unbacked_credits: number;
  unbacked_by_currency?: { currency: string; micro: number; credits: number }[];
  /** Older endpoints omit denomination; this scalar cannot supply a monetary warning. */
  unbacked_micro?: number;
  /** Registered reclaims with no in-kind figure, excluded from `drain_liability_sats`. */
  unpriced_drains: number;
}

/**
 * What a just-in-time mint cost, sent with the park it justifies.
 *
 * Its presence is also what tells the route which park shape this is: with it,
 * `consumed_row_ids` and `keep_proofs` must be empty, because the notes were
 * bought over Lightning rather than swapped out of proofs the DVM held.
 */
export interface AdminMintEvidence {
  source: "jit_mint";
  mint_url: string;
  quote_id: string;
  /** Face value of the parked notes — must equal the token's own amount. */
  face_sats: number;
  /** Delivery reserve withheld from the gross obligation at request time. */
  reserve_sats: number;
  /** What the mint's quote charged for that face value. */
  invoice_msats: number;
  /** Routing the sending wallet reported, where it reported any. */
  routing_fee_msats?: number | null;
}

/** Request body for `POST /admin/credit/park-drain`. */
export interface AdminParkDrainRequest {
  credit_id: string;
  drain_id: string;
  /** Encoded Cashu token P2PK-locked to the drain's refund_pubkey. */
  token: string;
  /** Accumulator rows whose proofs were consumed by the swap. Empty on a JIT mint. */
  consumed_row_ids: string[];
  /** Change proofs re-locked to the builder, to re-enter the accumulator. Empty on a JIT mint. */
  keep_proofs: AdminBatchProof[];
  /** Cost evidence, present only on a just-in-time mint. */
  mint_evidence?: AdminMintEvidence;
}

/** Request body for `POST /admin/credit/mark-drain-sent`. */
export interface AdminMarkDrainSentRequest {
  credit_id: string;
  drain_id: string;
  /** Settlement evidence, e.g. `{ tx_hash }` for a stablecoin payout. */
  sent_ref: Record<string, unknown>;
}

/** Response body from `POST /admin/credit/mark-drain-sent`. */
export interface AdminMarkDrainSentResponse {
  status: "sent";
  credit_id: string;
  drain_id: string;
  /**
   * True when the drain was already `sent` and this call changed nothing — no
   * second reclaim reached the platform, and the recorded `sent_ref` is the
   * first one. An operator who believes they just paid this refund is being
   * told they may have paid it twice.
   */
  replayed: boolean;
}

/** One blocked (or operator-resolved) Lightning funding invoice. */
export interface AdminBlockedInvoice {
  /** The wallet's own identifier for the payment — how the operator names it. */
  payment_hash: string;
  /** The top-up the invoice was minted against, which is what could not be credited. */
  credit_id: string;
  fund_id: string;
  caller_pubkey: string;
  currency: string;
  amount_micro: number;
  amount_msats: number;
  status: "blocked" | "reconciled" | "written_off";
  /** Why the ledger refused it permanently, e.g. `funding_replayed_on_cashu`. */
  blocked_reason: string | null;
  created_at: number;
  settled_at: number | null;
  /** Where an operator sent the money, once they did. */
  reconciled_credit_id: string | null;
  /** When an operator resolved the row. */
  resolved_at: number | null;
  write_off_note: string | null;
}

/** Response body from `GET /admin/credit/blocked-invoices`. */
export interface AdminBlockedInvoicesResponse {
  invoices: AdminBlockedInvoice[];
  /** Opaque keyset cursor; present only when the page was full. */
  next_after?: string;
}

/** Request body for `POST /admin/credit/reconcile-invoice`. */
export interface AdminReconcileInvoiceRequest {
  payment_hash: string;
  /** Credit the payment should land on. The caller identity comes off the invoice row. */
  credit_id: string;
}

/** Response body from `POST /admin/credit/reconcile-invoice`. */
export interface AdminReconcileInvoiceResponse {
  status: "reconciled";
  payment_hash: string;
  credit_id: string;
  fund_id: string;
  amount_micro: number;
  currency: string;
  /** True when this reconcile had already been applied — nothing moved. */
  replayed: boolean;
  credit?: {
    credit_id: string;
    currency: string;
    balance_micro: number;
    remaining_micro: number;
    expiry_ms: number;
  };
}

/** Request body for `POST /admin/credit/write-off-invoice`. */
export interface AdminWriteOffInvoiceRequest {
  payment_hash: string;
  /** Why the operator is not crediting this payment. Recorded on the row. */
  note?: string;
}

/** Response body from `POST /admin/credit/write-off-invoice`. */
export interface AdminWriteOffInvoiceResponse {
  status: "written_off";
  payment_hash: string;
  amount_micro: number;
  currency: string;
  note: string | null;
  /** True when the invoice was already written off, so this call changed nothing. */
  replayed: boolean;
}

/** What the chain says about one wedged x402 settlement. */
export type AdminX402ChainEvidence =
  | { chain: "found"; transaction: string; amount: string }
  | { chain: "absent" }
  | { chain: "unreachable"; error: string }
  | { chain: "unbookmarked" };

/** One x402 settlement stuck between "chain paid" and "ledger booked". */
export interface AdminX402Settlement {
  /** The settlement's own id — how the operator names it in the repair verbs. */
  settlement_id: string;
  channel_id: string;
  operation: "fund" | "refund";
  effect_id: string;
  /** Credit bound to the channel; `null` when nothing is bound to it any more. */
  credit_id: string | null;
  /** Drain the effect encodes; `null` on a deposit or an effect off another credit. */
  drain_id: string | null;
  /** Funded balance still on the credit while this refund is unresolved. */
  credit_balance_micro: number | null;
  /** The spendable part of that balance — holds subtracted. */
  credit_remaining_micro: number | null;
  credit_currency: string | null;
  /** Whether draws on that credit are being refused `settlement_pending`. */
  spending_blocked: boolean;
  status: "submitting" | "settled" | "written_off" | "complete";
  submission_block: string | null;
  /** What the facilitator said it settled — the figure that can disagree with the chain. */
  settled_amount: string | null;
  settled_transaction: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  write_off_note: string | null;
  /** Absent when the listing was asked to skip chain lookups. */
  chain?: AdminX402ChainEvidence;
}

/** Response body from `GET /admin/credit/x402-settlements`. */
export interface AdminX402SettlementsResponse {
  settlements: AdminX402Settlement[];
  /** Opaque keyset cursor; present only when the page was full. */
  next_after?: string;
}

/** One exact x402 authorization waiting for local settlement finalization. */
export interface AdminX402ExactSettlement {
  settlement_intent_id: string;
  status:
    | "prepared"
    | "submitting"
    | "settled"
    | "local_committed"
    | "ambiguous"
    | "rejected"
    | "complete";
  network: string;
  asset: string;
  authorizer: string;
  recipient: string;
  amount: string;
  nonce: string;
  transaction: string | null;
  submission_block: string | null;
  last_outcome: string | null;
  credit_id: string | null;
  draw_id: string | null;
  job_id: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  attempts: {
    outcome: string;
    detail: string | null;
    transaction: string | null;
    created_at: number;
  }[];
}

/** Response from the exact x402 settlement repair queue. */
export interface AdminX402ExactSettlementsResponse {
  settlements: AdminX402ExactSettlement[];
}

/** Response after reconciling one exact x402 settlement. */
export interface AdminReconcileX402ExactResponse {
  status: "reconciled";
  settlement_status: AdminX402ExactSettlement["status"];
  settlement_intent_id: string;
  transaction: string | null;
  amount: string;
  credit_id: string | null;
  draw_id: string | null;
  job_id: string | null;
  replayed: boolean;
}

/** Request body for `POST /admin/credit/reconcile-x402-settlement`. */
export interface AdminReconcileX402Request {
  settlement_id: string;
}

/** Response body from `POST /admin/credit/reconcile-x402-settlement`. */
export interface AdminReconcileX402Response {
  status: "reconciled";
  settlement_id: string;
  channel_id: string;
  credit_id: string;
  drain_id: string;
  /** The chain transaction the ledger leg was completed against. */
  transaction: string | null;
  /** The chain's own figure for the refund, in the channel token's atomic units. */
  settled_amount: string | null;
  amount_micro: number | null;
  currency: string | null;
  /** True when the settlement was already complete — nothing was booked again. */
  replayed: boolean;
}

/** Request body for `POST /admin/credit/write-off-x402-settlement`. */
export interface AdminWriteOffX402Request {
  settlement_id: string;
  /** Why the operator is not booking it. Recorded on the settlement row. */
  note?: string;
}

/** Response body from `POST /admin/credit/write-off-x402-settlement`. */
export interface AdminWriteOffX402Response {
  status: "written_off";
  settlement_id: string;
  channel_id: string;
  effect_id: string;
  note: string | null;
  /** True when it was already written off, so this call changed nothing. */
  replayed: boolean;
}

/**
 * What the chain says about one wedged Tempo cooperative close.
 *
 * `unreported` is the Tempo analogue of x402's `absent` without being the same
 * claim: the close reference names no transaction receipt, so the chain states
 * no figure at all — which is silence, not a refund of zero.
 */
export type AdminTempoChainEvidence =
  | { chain: "found"; transaction: string; refundedToPayer: string; settledToPayee: string }
  | { chain: "unreported"; reference: string }
  | { chain: "unreachable"; error: string }
  | { chain: "unconfirmed" };

export interface AdminTempoDrainDecision {
  source: "operator";
  decision: "book_refunded" | "release";
  reason: string;
  evidence?: string;
  decidedAt: number;
}

export interface AdminTempoDrainDecisionRequest {
  credit_id: string;
  drain_id: string;
  reason: string;
  evidence?: string;
}

export interface AdminTempoDrainDecisionResponse {
  status: "sent" | "released";
  credit_id: string;
  drain_id: string;
  channel_id: string | null;
  amount_micro: number;
  amount_native: number | null;
  currency: string;
  decision: AdminTempoDrainDecision;
  /** Current balances, including on replay; these are not decision-time snapshots. */
  balance_micro: number;
  spendable_micro: number;
  replayed: boolean;
}

/** A held Tempo drain, or a terminal drain included in the audit view. */
export interface AdminTempoDrain {
  credit_id: string;
  drain_id: string;
  channel_id: string | null;
  /** What the caller was debited, in the ledger's currency. */
  amount_micro: number;
  /** The same debit in the channel token's own units — what the refund must cover. */
  amount_native: number | null;
  currency: string;
  caller_pubkey: string;
  status: "pending" | "parked" | "picked_up" | "sent" | "released" | "exit_required";
  created_at: number;
  /** A write-off annotation leaves the debit held; it does not pay the caller. */
  write_off_note: string | null;
  written_off_at: number | null;
  /** New audit fields are absent on older servers. */
  decision?: AdminTempoDrainDecision | null;
  held_reason?: "close_evidence_missing" | "close_history_unmatched" | "collateral_missing" | "refund_short" | "exit_required" | "refund_unproven" | null;
  /** Receipt-derived exact amount; payer-exit lower bounds never populate it. */
  proven_refund_native?: string | null;
  /** Sticky positive-payment fact; false does not establish nonpayment. */
  refund_payment_proven?: boolean;
  close_reports?: { obligation_id: string; status: "unmatched" | "no_report"; written_off: boolean }[];
  /** Absent when the listing was asked to skip chain lookups. */
  chain?: AdminTempoChainEvidence;
}

/** Response body from `GET /admin/credit/tempo-drains`. */
export interface AdminTempoDrainsResponse {
  drains: AdminTempoDrain[];
  /** Opaque keyset cursor; present only when the page was full. */
  next_after?: string;
}

/** Immutable audit row for a Tempo-backed credit terminalized after lost collection. */
export interface AdminTempoCreditLoss {
  credit_id: string;
  channel_id: string;
  caller_pubkey: string;
  currency: string;
  former_balance_micro: number;
  settled_on_chain_native: string;
  highest_voucher_native: string;
  consumed_service_micro: number;
  consumed_native: string;
  observed_at: number;
  status: "unbacked";
}

export interface AdminTempoCloseReport {
  obligation_id: string;
  channel_id: string;
  /** Potential builder payout, as a decimal string in native token units. */
  amount_native: string;
  status: "unmatched" | "no_report";
  created_at_ms: number;
  updated_at_ms: number;
  delivered_at_ms: number | null;
  retryable: boolean;
  write_off_allowed: boolean;
  /** A retained write-off decision can remain true after an explicit retry. */
  written_off: boolean;
  write_off_note: string | null;
  written_off_at_ms: number | null;
}

export interface AdminTempoCloseReportsResponse {
  reports: AdminTempoCloseReport[];
  next_after?: string;
}

export interface AdminRetryTempoCloseReportRequest {
  obligation_id: string;
}

export interface AdminRetryTempoCloseReportResponse {
  status: "reserved";
  obligation_id: string;
}

export interface AdminWriteOffTempoCloseReportRequest {
  obligation_id: string;
  note: string;
}

export interface AdminWriteOffTempoCloseReportResponse {
  status: "written_off";
  obligation_id: string;
  channel_id: string;
  /** Builder payout abandoned, as a decimal string in native token units. */
  amount_forgone_native: string;
  note: string;
}

/** Response body from `GET /admin/credit/tempo-losses`. */
export interface AdminTempoCreditLossesResponse {
  losses: AdminTempoCreditLoss[];
}

/** Request body for `POST /admin/credit/reconcile-tempo-drain`. */
export interface AdminReconcileTempoRequest {
  credit_id: string;
  drain_id: string;
}

/** Response body from `POST /admin/credit/reconcile-tempo-drain`. */
export interface AdminReconcileTempoResponse {
  status: "reconciled";
  credit_id: string;
  drain_id: string;
  channel_id: string;
  /** The close transaction the drain was booked against. */
  transaction: string | null;
  /** The chain's own refund figure, in the channel token's atomic units. */
  settled_amount: string | null;
  amount_micro: number;
  amount_native: number | null;
  currency: string;
  /** True when the drain was already booked — nothing was booked again. */
  replayed: boolean;
}

/** Request body for `POST /admin/credit/write-off-tempo-drain`. */
export interface AdminWriteOffTempoRequest {
  credit_id: string;
  drain_id: string;
  /** Why the operator is not booking it. Recorded on the drain row. */
  note?: string;
}

/** Response body from `POST /admin/credit/write-off-tempo-drain`. */
export interface AdminWriteOffTempoResponse {
  status: "written_off";
  credit_id: string;
  drain_id: string;
  channel_id: string | null;
  amount_micro: number;
  amount_native: number | null;
  currency: string;
  note: string | null;
  /** True when it was already written off, so this call changed nothing. */
  replayed: boolean;
}

/** Request body for `POST /admin/cashu/rotate-lock-pubkey`. */
export interface AdminRotateLockPubkeyRequest {
  new_pubkey: string;
}

/** Response body from `POST /admin/cashu/rotate-lock-pubkey`. */
export interface AdminRotateLockPubkeyResponse {
  /** The post-rotation current pubkey — should match what the caller sent. */
  current: string;
  /** Retired pubkeys still within the grace window after this rotation. */
  retired: { pubkey: string; retired_at_ms: number }[];
}

export interface AdminCashuClientOpts {
  /** Base URL of the DVM (e.g. `https://builder--cast.example.com`). No trailing path. */
  endpoint: string;
  /** Identifier bound into the signed challenge. Matches `dvm_id` server-side. */
  dvmId: string;
  /** 32-byte (hex) per-DVM lock privkey derived via BIP-32. */
  privkeyHex: string;
  /** Optional fetch override. Defaults to global `fetch`. Used in tests. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Typed HTTP client for the DVM-side `/admin/cashu/*` endpoints from
 * tracked change. Each call signs a fresh BIP-340 schnorr challenge with the
 * builder's per-DVM lock privkey before submitting — privkey never leaves
 * memory.
 */
export class AdminCashuClient {
  private readonly endpoint: string;
  private readonly dvmId: string;
  private readonly privkeyHex: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: AdminCashuClientOpts) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.dvmId = opts.dvmId;
    this.privkeyHex = opts.privkeyHex;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? Date.now;
  }

  async getContentHolds(jobId: string): Promise<ContentHoldsResponse> {
    return this.contentHoldRequest("GET", jobId);
  }

  async placeContentHold(jobId: string, body: { purpose: "support" | "dispute"; reason: string; review_due_at: number }): Promise<ContentHoldsResponse> {
    return this.contentHoldRequest("POST", jobId, undefined, body);
  }

  async renewContentHold(jobId: string, holdId: string, body: { reason: string; review_due_at: number }): Promise<ContentHoldsResponse> {
    return this.contentHoldRequest("POST", jobId, `${encodeURIComponent(holdId)}/renew`, body);
  }

  async clearContentHold(jobId: string, holdId: string, body: { reason: string }): Promise<ContentHoldsResponse> {
    return this.contentHoldRequest("POST", jobId, `${encodeURIComponent(holdId)}/clear`, body);
  }

  private async contentHoldRequest(method: "GET" | "POST", jobId: string, suffix?: string, body?: unknown): Promise<ContentHoldsResponse> {
    const path = `/admin/jobs/${encodeURIComponent(jobId)}/content-holds${suffix ? `/${suffix}` : ""}`;
    try {
      return await this.requestJson<ContentHoldsResponse>(method, path, body);
    } catch (err) {
      if (err instanceof AdminApiError && ((err.status === 404 && err.body.error !== "job_not_found") || err.body.error === "content_holds_unavailable")) {
        throw new DvmError("content_holds_unavailable", "This service cannot manage content holds.", "Upgrade the service to @dvmkit/sdk 0.8.0 or later with a content-hold-capable store, then retry.");
      }
      throw err;
    }
  }

  /** Fetch unmelted batches from the DVM, sorted by oldest `t_expire`. */
  async getPendingBatches(): Promise<AdminPendingBatchesResponse> {
    return this.requestJson<AdminPendingBatchesResponse>(
      "GET",
      "/admin/cashu/pending-batches",
      undefined
    );
  }

  /**
   * Mark a set of accumulator rows as melted. The DVM verifies independently
   * via NUT-7 checkstate that every proof is `SPENT` before transitioning —
   * the caller-supplied audit fields don't bypass that check.
   */
  async markMelted(body: AdminMarkMeltedRequest): Promise<AdminMarkMeltedResponse> {
    return this.requestJson<AdminMarkMeltedResponse>("POST", "/admin/cashu/mark-melted", body);
  }

  /**
   * Publish a new lock pubkey and demote the prior current entry to retired.
   * Signed by the **current** privkey — the DVM rejects signatures
   * from already-retired pubkeys on this route specifically. Returns the
   * post-rotation `{ current, retired }` so the caller can confirm without a
   * follow-up `/v1/info` poll.
   */
  async rotateLockPubkey(
    body: AdminRotateLockPubkeyRequest
  ): Promise<AdminRotateLockPubkeyResponse> {
    return this.requestJson<AdminRotateLockPubkeyResponse>(
      "POST",
      "/admin/cashu/rotate-lock-pubkey",
      body
    );
  }

  /** Fetch unfulfilled drain liabilities plus the liability rollup. */
  async getPendingDrains(): Promise<AdminPendingDrainsResponse> {
    return this.requestJson<AdminPendingDrainsResponse>(
      "GET",
      "/admin/credit/pending-drains",
      undefined
    );
  }

  async refundDraw(body: AdminRefundDrawRequest): Promise<AdminRefundDrawResponse> {
    return this.requestJson<AdminRefundDrawResponse>("POST", "/admin/credit/refund-draw", body);
  }

  /**
   * Read the sats this DVM owes callers: undrawn Bitcoin deposits
   * plus registered reclaims, both priced in kind off the funding lots.
   */
  async getBitcoinLiability(): Promise<AdminBitcoinLiabilityResponse> {
    return this.requestJson<AdminBitcoinLiabilityResponse>(
      "GET",
      "/admin/credit/bitcoin-liability",
      undefined
    );
  }

  /**
   * Park a caller-locked refund token against a pending cashu drain.
   * The DVM independently re-verifies the lock target and NUT-7
   * state; idempotent under retry with the same token.
   */
  async parkDrain(body: AdminParkDrainRequest): Promise<{ status: string }> {
    return this.requestJson<{ status: string }>("POST", "/admin/credit/park-drain", body);
  }

  /**
   * Record a settled x402/mpp send-back. Idempotent —
   * `replayed` says whether this call was the one that moved the row.
   */
  async markDrainSent(body: AdminMarkDrainSentRequest): Promise<AdminMarkDrainSentResponse> {
    return this.requestJson<AdminMarkDrainSentResponse>(
      "POST",
      "/admin/credit/mark-drain-sent",
      body
    );
  }

  /**
   * Fetch paid Lightning top-ups the ledger can never credit.
   * Keyset-paginated: pass the previous response's `next_after` to continue.
   */
  async getBlockedInvoices(opts?: {
    limit?: number;
    after?: string;
    includeResolved?: boolean;
  }): Promise<AdminBlockedInvoicesResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.after !== undefined) params.set("after", opts.after);
    if (opts?.includeResolved) params.set("include_resolved", "true");
    return this.requestJson<AdminBlockedInvoicesResponse>(
      "GET",
      "/admin/credit/blocked-invoices",
      undefined,
      params.size === 0 ? undefined : `?${params.toString()}`
    );
  }

  /**
   * Credit a blocked invoice's payment onto a credit the operator names.
   * Idempotent: a second run with the same target credits once.
   */
  async reconcileInvoice(
    body: AdminReconcileInvoiceRequest
  ): Promise<AdminReconcileInvoiceResponse> {
    return this.requestJson<AdminReconcileInvoiceResponse>(
      "POST",
      "/admin/credit/reconcile-invoice",
      body
    );
  }

  /** Record "reviewed, not crediting" against a blocked invoice. */
  async writeOffInvoice(body: AdminWriteOffInvoiceRequest): Promise<AdminWriteOffInvoiceResponse> {
    return this.requestJson<AdminWriteOffInvoiceResponse>(
      "POST",
      "/admin/credit/write-off-invoice",
      body
    );
  }

  /**
   * Fetch x402 settlements stuck between chain and ledger.
   * Keyset-paginated like the blocked-invoice queue; each row carries what the
   * chain says unless `evidence: false` skips those lookups.
   */
  async getX402Settlements(opts?: {
    limit?: number;
    after?: string;
    includeResolved?: boolean;
    minAgeMs?: number;
    evidence?: boolean;
  }): Promise<AdminX402SettlementsResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.after !== undefined) params.set("after", opts.after);
    if (opts?.includeResolved) params.set("include_resolved", "true");
    if (opts?.minAgeMs !== undefined) params.set("min_age_ms", String(opts.minAgeMs));
    if (opts?.evidence === false) params.set("evidence", "false");
    return this.requestJson<AdminX402SettlementsResponse>(
      "GET",
      "/admin/credit/x402-settlements",
      undefined,
      params.size === 0 ? undefined : `?${params.toString()}`
    );
  }

  /**
   * Finish the ledger leg of a settled-on-chain x402 refund. The
   * amount is re-derived from chain evidence, never sent from here. Idempotent.
   */
  async reconcileX402Settlement(
    body: AdminReconcileX402Request
  ): Promise<AdminReconcileX402Response> {
    return this.requestJson<AdminReconcileX402Response>(
      "POST",
      "/admin/credit/reconcile-x402-settlement",
      body
    );
  }

  /** Record "reviewed, not booking" against a wedged x402 settlement. */
  async writeOffX402Settlement(body: AdminWriteOffX402Request): Promise<AdminWriteOffX402Response> {
    return this.requestJson<AdminWriteOffX402Response>(
      "POST",
      "/admin/credit/write-off-x402-settlement",
      body
    );
  }

  /** Fetch exact x402 authorizations whose local economic effect is unfinished. */
  async getX402ExactSettlements(opts?: {
    limit?: number;
    includeResolved?: boolean;
  }): Promise<AdminX402ExactSettlementsResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.includeResolved) params.set("include_resolved", "true");
    return this.requestJson<AdminX402ExactSettlementsResponse>(
      "GET",
      "/admin/credit/x402-exact-settlements",
      undefined,
      params.size === 0 ? undefined : `?${params.toString()}`
    );
  }

  /** Finish one exact x402 intent from its durable chain evidence. */
  async reconcileX402ExactSettlement(
    settlementIntentId: string
  ): Promise<AdminReconcileX402ExactResponse> {
    return this.requestJson<AdminReconcileX402ExactResponse>(
      "POST",
      "/admin/credit/reconcile-x402-exact-settlement",
      { settlement_intent_id: settlementIntentId }
    );
  }

  /** Tempo cooperative closes stuck between chain and ledger. */
  async getTempoDrains(opts?: {
    limit?: number;
    after?: string;
    includeResolved?: boolean;
    minAgeMs?: number;
    evidence?: boolean;
  }): Promise<AdminTempoDrainsResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.after !== undefined) params.set("after", opts.after);
    if (opts?.includeResolved) params.set("include_resolved", "true");
    if (opts?.minAgeMs !== undefined) params.set("min_age_ms", String(opts.minAgeMs));
    if (opts?.evidence === false) params.set("evidence", "false");
    return this.requestJson<AdminTempoDrainsResponse>(
      "GET",
      "/admin/credit/tempo-drains",
      undefined,
      params.size === 0 ? undefined : `?${params.toString()}`
    );
  }

  async getTempoCloseReports(opts?: {
    limit?: number;
    after?: string;
    all?: boolean;
  }): Promise<AdminTempoCloseReportsResponse> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.after !== undefined) params.set("after", opts.after);
    if (opts?.all) params.set("all", "1");
    return this.requestJson<AdminTempoCloseReportsResponse>(
      "GET", "/admin/credit/tempo-close-reports", undefined,
      params.size === 0 ? undefined : `?${params.toString()}`
    );
  }

  async retryTempoCloseReport(
    body: AdminRetryTempoCloseReportRequest
  ): Promise<AdminRetryTempoCloseReportResponse> {
    return this.requestJson<AdminRetryTempoCloseReportResponse>(
      "POST", "/admin/credit/retry-tempo-close-report", body
    );
  }

  async writeOffTempoCloseReport(
    body: AdminWriteOffTempoCloseReportRequest
  ): Promise<AdminWriteOffTempoCloseReportResponse> {
    return this.requestJson<AdminWriteOffTempoCloseReportResponse>(
      "POST", "/admin/credit/write-off-tempo-close-report", body
    );
  }

  /** Tempo credits closed after their channel finalized below accepted vouchers. */
  async getTempoCreditLosses(opts?: { limit?: number }): Promise<AdminTempoCreditLossesResponse> {
    const query = opts?.limit === undefined ? undefined : `?limit=${String(opts.limit)}`;
    return this.requestJson<AdminTempoCreditLossesResponse>(
      "GET",
      "/admin/credit/tempo-losses",
      undefined,
      query
    );
  }

  /**
   * Book a Tempo drain whose cooperative close already paid. The
   * amount is re-read from the close receipt, never sent from here. Idempotent.
   */
  async reconcileTempoDrain(
    body: AdminReconcileTempoRequest
  ): Promise<AdminReconcileTempoResponse> {
    return this.requestJson<AdminReconcileTempoResponse>(
      "POST",
      "/admin/credit/reconcile-tempo-drain",
      body
    );
  }

  async bookTempoDrain(body: AdminTempoDrainDecisionRequest): Promise<AdminTempoDrainDecisionResponse> {
    return this.requestJson("POST", "/admin/credit/book-tempo-drain", body);
  }

  async releaseTempoDrain(body: AdminTempoDrainDecisionRequest): Promise<AdminTempoDrainDecisionResponse> {
    return this.requestJson("POST", "/admin/credit/release-tempo-drain", body);
  }

  /** Record "reviewed, not booking" against a wedged Tempo drain. */
  async writeOffTempoDrain(body: AdminWriteOffTempoRequest): Promise<AdminWriteOffTempoResponse> {
    return this.requestJson<AdminWriteOffTempoResponse>(
      "POST",
      "/admin/credit/write-off-tempo-drain",
      body
    );
  }

  /**
   * `query` is appended to the URL but **not** signed: the DVM builds its side
   * of the challenge from `c.req.path`, which excludes the query string, so
   * folding it in would fail every signature. Nothing that moves money may ride
   * a query param — keep those in the JSON body, which is what the signature
   * covers via the route path it is bound to.
   */
  private async requestJson<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    query?: string
  ): Promise<T> {
    const { header } = buildAdminAuthHeader({
      method,
      path,
      dvmId: this.dvmId,
      privkeyHex: this.privkeyHex,
      now: this.now,
    });
    const init: RequestInit = {
      method,
      headers: {
        Authorization: header,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}${path}${query ?? ""}`, init);
    } catch (err) {
      throw new DvmError(
        "admin_unreachable",
        `Failed to reach DVM admin endpoint ${this.endpoint}${path}: ${err instanceof Error ? err.message : String(err)}`,
        "The DVM may be down or the endpoint URL is wrong. Verify with `dvmctl info <handle>`."
      );
    }
    if (res.status === 404 && path.startsWith("/admin/jobs/") && path.includes("/content-holds") && !res.headers.get("content-type")?.includes("json")) {
      throw new DvmError("content_holds_unavailable", "This service cannot manage content holds.", "Upgrade the service to @dvmkit/sdk 0.8.0 or later with a content-hold-capable store, then retry.");
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      if (res.status === 404 && ["/admin/credit/refund-draw", "/admin/credit/book-tempo-drain", "/admin/credit/release-tempo-drain"].includes(path)) {
        throw new AdminApiError(404, { error: "not_found", raw: text });
      }
      throw new DvmError(
        "admin_invalid_json",
        `DVM admin endpoint ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
        "The DVM may not be running the tracked change SDK. Redeploy with the latest SDK.",
        undefined,
        undefined,
        { message: "provider" }
      );
    }
    if (!res.ok) {
      const body = parsed as {
        error?: unknown;
        reason?: unknown;
        message?: unknown;
        hint?: unknown;
        display?: unknown;
      };
      const apiError = new AdminApiError(res.status, {
        error: typeof body.error === "string" ? body.error : "admin_error",
        reason: typeof body.reason === "string" ? body.reason : undefined,
        message: typeof body.message === "string" ? body.message : undefined,
        hint: typeof body.hint === "string" ? body.hint : undefined,
        display: typeof body.display === "string" ? body.display : undefined,
        raw: parsed,
      });
      if (res.status === 503 && apiError.body.error === ADMIN_STATE_UNAVAILABLE) {
        throw new DvmError(
          ADMIN_STATE_UNAVAILABLE,
          "DVM admin authentication state is temporarily unavailable; the requested DVM operation did not run.",
          "Retry the same command. If this keeps happening, inspect the DVM's database health and restart the DVM. Do not rotate or replace the lock key."
        );
      }
      throw apiError;
    }
    return parsed as T;
  }
}

/** Structured failure surfacing a non-2xx response from an admin endpoint. */
export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: {
      error: string;
      reason?: string;
      message?: string;
      hint?: string;
      display?: string;
      raw: unknown;
    }
  ) {
    super(
      `Admin endpoint returned HTTP ${status}: ${body.error}${body.reason ? ` (${body.reason})` : ""}`
    );
    this.name = "AdminApiError";
  }

  /** True when the 401 carries `reason: "bad_signature"` — fatal under `--watch`. */
  get isBadSignature(): boolean {
    return this.status === 401 && this.body.reason === "bad_signature";
  }
}

/**
 * Rethrow a `401 bad_signature` from any admin route as `admin_bad_signature`,
 * and pass anything else through untouched for the caller to classify.
 *
 * A bad signature means the DVM advertises a lock pubkey this mnemonic cannot
 * derive: never transient, never self-healing, and identical whichever admin
 * route hit it first. Every catch site on a path that tolerates transport
 * failures has to run this before its own handling, or the configuration fault
 * hides inside a retry-and-hope branch built for outages.
 */
export function rethrowIfBadSignature(err: unknown): void {
  if (!(err instanceof AdminApiError) || !err.isBadSignature) return;
  throw new DvmError(
    "admin_bad_signature",
    "DVM admin endpoint rejected our signed challenge (bad_signature).",
    "The DVM's DVMKIT_CASHU_LOCK_PUBKEY does not match the privkey derived from this mnemonic. " +
      "Re-deploy with the matching pubkey or switch mnemonics."
  );
}

/** Preserve the actionable transient admin-state failure through tolerant command paths. */
export function rethrowIfAdminStateUnavailable(err: unknown): void {
  if (err instanceof DvmError && err.code === ADMIN_STATE_UNAVAILABLE) throw err;
}

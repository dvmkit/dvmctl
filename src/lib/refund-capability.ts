import { isCreditFundRail, parseCreditTerms } from "@dvmkit/sdk/internal";

import { dvmFetch, withDecodableAcceptEncoding } from "./http.ts";
import { canonicalMint } from "./melt-change-custody.ts";

export interface RefundCapability {
  accumulator: boolean;
  mints: string[];
}

/** Read current capability from the same origin as the signed refund state. */
export async function readRefundCapability(
  endpoint: string,
  fetchImpl: typeof fetch = dvmFetch
): Promise<RefundCapability> {
  const url = `${endpoint}/v1/info`;
  const response = await fetchImpl(url, withDecodableAcceptEncoding(url, {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
    redirect: "error",
    headers: { "Cache-Control": "no-cache" },
  }));
  if (!response.ok) throw new Error(`Refund metadata returned HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (
    !record(data) || data.protocol_version !== 1 ||
    typeof data.name !== "string" || !data.name.trim() ||
    !strings(data.auth) || data.auth.length === 0 || !record(data.capabilities) ||
    !record(data.payment) || !strings(data.payment.methods) || !mintUrls(data.mints)
  ) {
    throw new Error("Unknown or malformed refund metadata");
  }
  if (Object.hasOwn(data, "cashu")) {
    const cashu = data.cashu;
    if (
      !record(cashu) || !mintUrls(cashu.mints) || !strings(cashu.lock_pubkeys) ||
      cashu.lock_pubkeys.length === 0 ||
      !cashu.lock_pubkeys.every((key) => /^0[23][0-9a-fA-F]{64}$/.test(key))
    ) {
      throw new Error("Malformed accumulator metadata");
    }
    return { accumulator: true, mints: data.mints };
  }
  // The existing parser checks the credit wire shape; require usable prepaid
  // terms as well, so a missing cashu field alone never authorizes a purchase.
  const credit = parseCreditTerms(data.credit);
  if (
    !credit || credit.balance_payment !== true || !credit.currency.trim() ||
    credit.funding.length === 0 || !credit.funding.every(isCreditFundRail) ||
    !Number.isSafeInteger(credit.min_micro) || credit.min_micro < 0 ||
    !Number.isSafeInteger(credit.max_micro) || credit.max_micro < credit.min_micro ||
    !Number.isSafeInteger(credit.ttl_ms) || credit.ttl_ms <= 0
  ) {
    throw new Error("Missing or malformed prepaid refund terms");
  }
  return { accumulator: false, mints: data.mints };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function mintUrls(value: unknown): value is string[] {
  return strings(value) && value.length > 0 && value.every((mint) => {
    try {
      canonicalMint(mint);
      return true;
    } catch {
      return false;
    }
  });
}

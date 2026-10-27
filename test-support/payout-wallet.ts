import type { AdminBatchProof } from "../src/lib/admin-cashu-client.ts";

import { Amount, type MeltPreview, type Wallet } from "@cashu/cashu-ts";

// Transport fixture for existing authorization/rejection tests. Custody tests use a real Wallet.
export function payoutWallet(
  submit: (quote: unknown, proofs: AdminBatchProof[], config: { privkey: string }) => Promise<{ quote?: Record<string, unknown> }>,
  options: { mint?: string | (() => string); quote?: () => Promise<Record<string, unknown>>; fee?: () => Promise<number>; check?: (quote: string) => Promise<Record<string, unknown>> } = {}
): Wallet {
  let fee = 0;
  let count = 1;
  const originals = new Map<string, Record<string, unknown>>();
  const observations = new Map<string, Record<string, unknown>>();
  return {
    unit: "sat",
    mint: {
      get mintUrl() { return typeof options.mint === "function" ? options.mint() : options.mint ?? "https://mint"; },
      checkMeltQuoteBolt11: async (quote: string) => ({ ...await options.quote?.(), ...originals.get(quote),
        ...(options.check ? await options.check(quote) : observations.get(quote)), quote }),
      restore: async () => ({ outputs: [], signatures: [] }),
    },
    ensureOperableKeysets: async (ids: string[]) => { count = ids.length || count; fee = await options.fee?.() ?? fee; },
    getKeyset: () => ({ unit: "sat", fee: fee * 1000 / count }),
    prepareMelt: async (_method: string, quote: Record<string, unknown>, inputs: unknown[]) => {
      originals.set(quote.quote as string, { ...quote, fee_reserve: Amount.from(0), ...await options.quote?.() });
      return { method: "bolt11", inputs, outputData: [], keysetId: "keyset", quote };
    },
    completeMelt: async (preview: MeltPreview, privkey: string) => {
      const result = await submit(preview.quote, preview.inputs as unknown as AdminBatchProof[], { privkey });
      observations.set(preview.quote.quote, result?.quote ?? {});
      return result;
    },
    createMeltChangeProofs: () => [],
  } as unknown as Wallet;
}

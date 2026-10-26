import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";

const sdk = await import("@dvmkit/sdk/internal");
const adminModule = await import("../../src/lib/admin-cashu-client.ts");
const dvmId = process.env.MELT_TEST_DVM_ID;
const pubkey = "02" + "aa".repeat(32);
const keypair = { privkey: "11".repeat(32), pubkey };
const marked = join(process.env.DVMKIT_CONFIG_DIR, `marked-${dvmId}`);
const batch = {
  mint_url: "https://mint.invalid", lock_pubkey: pubkey, row_ids: ["row-1"],
  proofs: [{ id: "keyset", amount: 60, secret: "synthetic-input", C: "synthetic-point" }],
  total_sats: 60, t_expire: null,
};
const emit = (kind, data = {}) => process.send({ kind, ...data });
let resume;
const resumed = new Promise(resolve => { resume = resolve; });
process.on("message", () => resume());
async function pause(stage) {
  if (process.argv[2] !== stage) return;
  emit("paused");
  await resumed;
}

mock.module("@dvmkit/sdk/internal", { namedExports: {
  ...sdk,
  getInputFeesForProofs: async () => 0,
  fetchLnurlPayInvoice: async () => "synthetic-invoice",
  fetchMeltQuote: async () => {
    emit("quote");
    return { amountSats: 60, feeReserveSats: 0, rawQuote: { quote: "original-quote" } };
  },
  checkMeltQuoteState: async () => {
    emit("check");
    return { state: process.argv[3], payment_preimage: "original-preimage" };
  },
  getWallet: async () => ({ meltProofsBolt11: async () => {
    emit("submit");
    await pause("submit");
    throw new Error("submission response lost");
  } }),
} });
const keyring = () => ({ canonicalDvmId: dvmId, currentKeypair: keypair,
  keypairsByPubkey: new Map([[pubkey, keypair]]) });
mock.module(new URL("../../src/lib/cashu/builder-lock-identity.ts", import.meta.url), {
  namedExports: { resolveBuilderLockKeyring: keyring, resolveBuilderLockKeyringByHandle: keyring },
});
mock.module(new URL("../../src/shared/builder-store.ts", import.meta.url), {
  namedExports: { getBuilderDvm: () => ({ payout_ln_address: "payout@example.invalid" }) },
});
mock.module(new URL("../../src/lib/admin-cashu-client.ts", import.meta.url), { namedExports: {
  ...adminModule,
  AdminCashuClient: class {
    async getPendingDrains() {
      return { drains: [], liability: { cashu_sats: 0, by_method_micro: {} } };
    }
    async getPendingBatches() {
      await pause("batches");
      return { batches: existsSync(marked) ? [] : [batch] };
    }
    async markMelted(request) {
      emit("mark", { request });
      await pause("mark");
      writeFileSync(marked, "acknowledged");
      return { melted: 1 };
    }
  },
} });

try {
  const { meltPending } = await import("../../src/commands/builder/melt-pending.ts");
  await meltPending("fixture", { endpoint: "https://dvm.invalid" });
  emit("done");
} catch (error) {
  emit("done", { code: error.code, message: error.message, hint: error.hint });
} finally {
  process.disconnect();
}

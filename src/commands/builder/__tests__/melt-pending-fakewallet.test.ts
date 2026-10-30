import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Amount, blindMessage, getPubKeyFromPrivKey, OutputData } from "@cashu/cashu-ts";
import type * as Sdk from "@dvmkit/sdk/internal";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startFakeWalletMint } from "../../../../test-support/fakewallet-mint.ts";
import type { AdminBatch } from "../../../lib/admin-cashu-client.ts";

const fixture = vi.hoisted(() => ({ batches: vi.fn(), mark: vi.fn(), invoice: vi.fn() }));
const PRIVKEY = "11".repeat(32);
const LOCK = Buffer.from(getPubKeyFromPrivKey(Buffer.from(PRIVKEY, "hex"))).toString("hex");
const DVM = "fakewallet-isolation";
vi.mock("@dvmkit/sdk/internal", async importOriginal => ({
  ...(await importOriginal<typeof Sdk>()), fetchLnurlPayInvoice: fixture.invoice,
}));
vi.mock("../../../lib/cashu/builder-lock-identity.ts", () => ({
  resolveBuilderLockKeyringByHandle: () => ({ canonicalDvmId: DVM,
    currentKeypair: { privkey: PRIVKEY, pubkey: LOCK },
    keypairsByPubkey: new Map([[LOCK, { privkey: PRIVKEY, pubkey: LOCK }]]) }),
}));
vi.mock("../../../shared/builder-store.ts", () => ({
  getBuilderDvm: () => ({ payout_ln_address: "payout@example.invalid" }),
}));
vi.mock("../../../lib/admin-cashu-client.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/admin-cashu-client.ts")>()),
  AdminCashuClient: class {
    getPendingBatches = fixture.batches;
    markMelted = fixture.mark;
    async getPendingDrains() { return { drains: [], liability: { cashu_sats: 0, by_method_micro: {} } }; }
  },
}));
vi.mock("../../../shared/output.ts", () => ({ info: vi.fn(), json: vi.fn() }));

let mintUrl = process.env.DVMCTL_FAKEWALLET_MINT_URL;
let payoutUrl = process.env.DVMCTL_FAKEWALLET_PAYOUT_URL;
const hosted = process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted" && process.platform === "linux";
describe.skipIf(!mintUrl && !hosted)("proof isolation against Nutshell FakeWallet", () => {
  let root: string | undefined;
  const mints: Awaited<ReturnType<typeof startFakeWalletMint>>[] = [];
  beforeAll(async () => {
    if (!mintUrl && hosted) {
      const source = await startFakeWalletMint(); mints.push(source); mintUrl = source.url;
      // A separate database forces an external Lightning payout. An internal
      // mint-to-mint-quote transfer would not exercise payment reconciliation.
      const payout = await startFakeWalletMint(); mints.push(payout); payoutUrl = payout.url;
    }
  }, 180_000);
  afterAll(async () => { await Promise.all(mints.map(mint => mint.stop())); });
  afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

  it("pays usable siblings after a real mint witness rejection and leaves only that row unspent", async () => {
    if (!payoutUrl) throw new Error("The FakeWallet tier needs a separate payout mint URL");
    for (const url of [mintUrl!, payoutUrl]) {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
        throw new Error("The FakeWallet tier accepts only loopback mint URLs");
      }
    }
    root = mkdtempSync(join(tmpdir(), "fakewallet-isolation-"));
    vi.stubEnv("DVMKIT_CONFIG_DIR", root);
    vi.resetModules();
    const sdk = await import("@dvmkit/sdk/internal");
    const wallet = await sdk.getWallet(mintUrl!);
    const payout = await sdk.getWallet(payoutUrl);
    fixture.invoice.mockImplementation(async (_address: string, msats: number) =>
      (await payout.createMintQuoteBolt11(msats / 1000)).request);

    const outputs = [0, 1, 2].map(index => {
      const secret = new TextEncoder().encode(JSON.stringify(["P2PK", {
        nonce: `fakewallet-${index}`, data: LOCK, tags: index === 1 ? [["n_sigs", "2"]] : [],
      }]));
      const { B_, r } = blindMessage(secret);
      return new OutputData({ amount: Amount.from(64), id: wallet.getKeyset().id, B_: B_.toHex(true) }, r, secret);
    });
    const funding = await wallet.createMintQuoteBolt11(192);
    expect((await wallet.checkMintQuoteBolt11(funding.quote)).state).toBe("PAID");
    const minted = await wallet.mintProofsBolt11(192, funding, {}, { type: "custom", data: outputs });
    const batch: AdminBatch = { mint_url: mintUrl!, lock_pubkey: LOCK,
      row_ids: ["good-a", "isolated", "good-b"], total_sats: 192, t_expire: null,
      proofs: minted.map(p => ({ ...p, amount: p.amount.toNumber() })) };
    const { getP2PKWitnessSignatures } = await import("@cashu/cashu-ts");
    const signed = wallet.signP2PKProofs([batch.proofs[1]], PRIVKEY);
    expect(getP2PKWitnessSignatures(signed[0].witness)).toHaveLength(1);
    fixture.batches.mockResolvedValue({ batches: [batch] });
    const marked: string[] = [];
    fixture.mark.mockImplementation(async ({ row_ids }: { row_ids: string[] }) => {
      const inputs = row_ids.map(row => batch.proofs[batch.row_ids.indexOf(row)]);
      expect((await wallet.checkProofsStates(inputs)).every(p => p.state === "SPENT")).toBe(true);
      marked.push(...row_ids); return { melted: row_ids.length };
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { meltPending } = await import("../melt-pending.ts");
    const { json } = await import("../../../shared/output.ts");
    const { MeltCustody } = await import("../../../lib/melt-change-custody.ts");
    await meltPending("fixture", { endpoint: "https://dvm.invalid" });
    expect(marked).toEqual(["good-a", "good-b"]);
    expect((await wallet.checkProofsStates(batch.proofs)).map(p => p.state)).toEqual(["SPENT", "UNSPENT", "SPENT"]);
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({
      batches_melted: 1, batches_failed: 0, batches_partial_failed: 0,
      rows_set_aside: 1, sats_set_aside: 64, sats_melted: 128,
    }));
    const operations = new MeltCustody().operations(DVM);
    expect(operations.some(op => op.submission === "rejected" && op.rows.includes("isolated"))).toBe(true);
    expect(operations.filter(op => op.submission !== "rejected").every(op => op.acknowledged)).toBe(true);
  }, 60_000);
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Amount, blindMessage, getEncodedToken, getPubKeyFromPrivKey, OutputData } from "@cashu/cashu-ts";
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

  it.skipIf(!process.env.DATABASE_URL)("delivers a refund through the installed SDK with Cashu receiving off", async () => {
    const database = process.env.DATABASE_URL!;
    const databaseUrl = new URL(database);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) ||
        !/^\/dvmctl_refund_test_[a-z0-9_]+$/i.test(databaseUrl.pathname)) {
      throw new Error("Refund integration requires an explicitly disposable loopback test database");
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(mintUrl!).hostname)) {
      throw new Error("Refund integration accepts only a loopback FakeWallet mint");
    }
    root = mkdtempSync(join(tmpdir(), "refund-delivery-"));
    vi.stubEnv("DVMKIT_CONFIG_DIR", root);
    vi.resetModules();
    const sdk = await import("@dvmkit/sdk/internal");
    const { configureDVM, z } = await import("@dvmkit/sdk");
    const { createDVMHost, secp256k1Auth, createSignedRequestVerifier, CREDIT_REQUEST_SCHEMA, fundingCommitment } = await import("@dvmkit/sdk/server");
    const { AdminCashuClient } = await vi.importActual<typeof import("../../../lib/admin-cashu-client.ts")>("../../../lib/admin-cashu-client.ts");
    const { serviceDrains } = await import("../drain-service.ts");
    const callerKey = "22".repeat(32);
    const caller = Buffer.from(getPubKeyFromPrivKey(Buffer.from(callerKey, "hex"))).toString("hex").slice(2);
    const refundKey = "33".repeat(32);
    const refundPubkey = Buffer.from(getPubKeyFromPrivKey(Buffer.from(refundKey, "hex"))).toString("hex");
    const dvmId = "fakewallet-refund-delivery";
    const unused = vi.fn().mockRejectedValue(new Error("Unexpected receive-wallet operation"));
    const host = createDVMHost({
      database, mints: [mintUrl!], paymentMethods: [],
      env: { DVMKIT_DVM_ID: dvmId, DVMKIT_CASHU_LOCK_PUBKEY: LOCK,
        DVMKIT_ALLOW_TEST_MINTS: "true" },
      fx: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
      lightningReceive: { backend: { getInfo: unused, getBalance: unused, createInvoice: unused, lookupInvoice: unused, payInvoice: unused } },
    });
    host.mount(configureDVM({ name: "Refund integration", capability: "echo", input: z.object({ text: z.string() }),
      price: "$0.01", credit: { min: "$0.001", max: "$5" }, auth: secp256k1Auth(), onJob(ctx) { ctx.complete("done"); } }));
    try {
      const { url } = await host.serve({ port: 0 });
      const signer = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
      const credit = async (body: Record<string, unknown>, token?: string) => fetch(`${url}/v1/credit`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Cashu": token } : {}) },
        body: JSON.stringify(signer.signRequest(Buffer.from(callerKey, "hex"), body)),
      });
      const info = await (await fetch(`${url}/v1/info`)).json();
      expect(info.credit).toMatchObject({ jit_refund_park: true, balance_payment: true, funding: ["lightning"] });
      expect(info).not.toHaveProperty("cashu");
      expect(info.payment.methods).not.toContain("cashu");
      const admin = new AdminCashuClient({ endpoint: url, dvmId, privkeyHex: PRIVKEY });
      await expect(admin.getPendingBatches()).rejects.toMatchObject({ status: 404, body: { error: "not_found" } });
      await host.creditLedger!.fund({ creditId: "refund-credit", callerPubkey: caller, currency: "usd", amountMicro: 400_000,
        expiryMs: Date.now() + 3_600_000, basis: { rail: "lightning", paidMsats: 400_000, fundingRef: "synthetic-deposit" } });
      const requested = await credit({ op: "drain", credit_id: "refund-credit", drain: {
        drain_id: "refund-drain", method: "cashu", payout: { refund_pubkey: refundPubkey },
      } });
      expect(requested.status).toBe(200);
      expect((await requested.json()).drain).toMatchObject({ status: "pending", owed_sats: 392 });
      const payInvoice = vi.fn().mockResolvedValue({ preimage: "aa".repeat(32), feesPaidMsats: 0, outcome: "paid" });
      const park = vi.spyOn(admin, "parkDrain");
      expect(await serviceDrains({ dvmId, handle: "refund-integration", client: admin,
        keypairsByPubkey: new Map([[sdk.toLockPubkey(LOCK), { privkey: PRIVKEY, pubkey: LOCK }]]),
        currentKeypair: { privkey: PRIVKEY, pubkey: LOCK },
        refundNwc: { uri: "nostr+walletconnect://" + "55".repeat(32) + "?relay=wss://relay.example&secret=" + "66".repeat(32) },
        payInvoice,
      })).toMatchObject({ drains_parked: 1, drains_jit_minted: 1, cashu_liability_sats_after: 0 });
      expect(payInvoice).toHaveBeenCalledTimes(1);
      const parked = park.mock.calls[0][0];
      expect(parked.mint_evidence).toMatchObject({ source: "jit_mint", face_sats: 392 });
      const pickup = await credit({ op: "drain", credit_id: "refund-credit", drain: { drain_id: "refund-drain" } });
      expect(pickup.status).toBe(200);
      expect((await pickup.json()).drain).toMatchObject({ status: "picked_up", token: parked.token });
      await expect(admin.parkDrain(parked)).resolves.toMatchObject({ status: "picked_up" });
      const wallet = await sdk.getWallet(mintUrl!);
      const redeemed = await wallet.receive(parked.token, { privkey: refundKey });
      expect(redeemed.reduce((total, proof) => total + proof.amount.toNumber(), 0)).toBe(392);
      const locked = await wallet.ops.send(8, redeemed).asLocked({ pubkey: LOCK }).run();
      const incoming = getEncodedToken({ mint: mintUrl!, proofs: locked.send });
      const receive = await credit({ op: "fund", credit_id: "receiving-probe", fund: {
        amount_micro: 8_000, fund_id: "incoming-probe", commitment: fundingCommitment(incoming),
      } }, incoming);
      expect(receive.status).toBe(402);
      expect((await receive.json()).error).toBe("cashu_not_p2pk_locked");
      expect((await wallet.checkProofsStates(locked.send)).every((proof) => proof.state === "UNSPENT")).toBe(true);
      expect((await host.pool!.query("SELECT to_regclass('wallet_accumulator') AS table_name")).rows[0].table_name).toBeNull();
      expect(unused).not.toHaveBeenCalled();
    } finally {
      await host.shutdown();
    }
  }, 60_000);

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

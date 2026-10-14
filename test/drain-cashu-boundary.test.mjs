import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

import { toLockPubkey } from "@dvmkit/sdk/internal";

const KEYSET_ID = "009a1f293253e41e";
const LOCK_PUBKEY = "02" + "aa".repeat(32);
const REFUND_PUBKEY = "02" + "cd".repeat(32);
const PRIVKEY = "11".repeat(32);
const TEST_NWC_URI =
  ["nostr", "walletconnect"].join("+") +
  "://wallet?relay=wss://r.example&" +
  ["se", "cret"].join("") +
  "=" +
  "ab".repeat(32);

function secret(pubkey, nonce) {
  return JSON.stringify(["P2PK", { nonce, data: pubkey }]);
}

function proof(amount, pubkey, nonce) {
  return { id: KEYSET_ID, amount, secret: secret(pubkey, nonce), C: "02" + "55".repeat(32) };
}

async function bundle() {
  const entry = join(process.cwd(), "test/drain-service-entry.ts");
  // Keep the temporary bundle under the release tree so its external SDK
  // imports resolve from that tree's node_modules, not the source checkout.
  const out = mkdtempSync(join(process.cwd(), ".cashu-boundary-"));
  const { build } = await import("tsup");
  await build({
    entry: [entry],
    format: ["esm"],
    target: "node22",
    outDir: out,
    external: ["@dvmkit/sdk", "@dvmkit/sdk/internal", "@dvmkit/sdk/server"],
    noExternal: ["@cashu/cashu-ts"],
    config: false,
    silent: true,
  });
  return { out, url: pathToFileURL(join(out, "drain-service-entry.js")).href };
}

async function sdkCashu() {
  // Resolve Cashu from the installed SDK itself. A published SDK can carry a
  // nested copy, which is exactly the module-identity split this test guards.
  const require = createRequire(import.meta.url);
  // `internal` is import-only in some SDK releases, so resolve it through the
  // ESM condition and use CommonJS resolution only for its nested dependency.
  const sdkInternal = fileURLToPath(import.meta.resolve("@dvmkit/sdk/internal"));
  const cashu = require.resolve("@cashu/cashu-ts", { paths: [dirname(sdkInternal)] });
  return import(pathToFileURL(cashu).href);
}

function wallet(SdkAmount, sendResult) {
  const chain = {
    asLocked: () => chain,
    keepAsLocked: () => chain,
    privkey: () => chain,
    includeFees: () => chain,
    run: async () => sendResult,
  };
  const keys = {};
  for (let amount = 1; amount <= 1024; amount *= 2) keys[amount] = "02" + "cc".repeat(32);
  return {
    ops: {
      send(amount, proofs) {
        assert.equal(amount, 400);
        assert.equal(proofs[0].amount, 256, "admin JSON amount stays primitive for SDK wallet");
        return chain;
      },
    },
    getKeyset: () => ({ id: KEYSET_ID, fee: 0, keys }),
    getFeesForKeyset: () => SdkAmount.zero(),
    getFeesForProofs: () => SdkAmount.zero(),
  };
}

let built;
let configRoot;
let priorConfig;
let SdkAmount;
let serviceDrains;
let BundledAmount;
let getDecodedToken;
before(async () => {
  configRoot = mkdtempSync(join(tmpdir(), "dvmctl-cashu-boundary-"));
  priorConfig = process.env.DVMKIT_CONFIG_DIR;
  // Config paths are fixed at import time; set temporary state before loading the bundle.
  process.env.DVMKIT_CONFIG_DIR = configRoot;
  ({ Amount: SdkAmount } = await sdkCashu());
  built = await bundle();
  ({ serviceDrains, BundledAmount, getDecodedToken } = await import(built.url));
});
after(() => {
  if (priorConfig === undefined) delete process.env.DVMKIT_CONFIG_DIR;
  else process.env.DVMKIT_CONFIG_DIR = priorConfig;
  if (configRoot) rmSync(configRoot, { recursive: true, force: true });
  if (built) rmSync(built.out, { recursive: true, force: true });
});

test("standalone service bridges the SDK Cashu Amount boundary", async () => {
  assert.notEqual(BundledAmount, SdkAmount, "the test uses two actual Cashu module instances");
  const foreign = SdkAmount.from(400);
  assert.throws(() => BundledAmount.from(foreign), /Unsupported amount input type/);

  const sent = proof(foreign, REFUND_PUBKEY, "send");
  const change = proof(SdkAmount.from(112), LOCK_PUBKEY, "change");
  const parked = [];
  const client = {
    getPendingDrains: async () => ({
      drains: [
        {
          credit_id: "c1",
          drain_id: "d1",
          method: "cashu",
          payout: { refund_pubkey: REFUND_PUBKEY },
          amount_sats: 400,
        },
      ],
      liability: { cashu_sats: 400, by_method_micro: {} },
    }),
    getPendingBatches: async () => ({
      batches: [
        {
          mint_url: "https://mint.example.com",
          lock_pubkey: LOCK_PUBKEY,
          row_ids: ["r1", "r2"],
          proofs: [proof(256, LOCK_PUBKEY, "input-1"), proof(256, LOCK_PUBKEY, "input-2")],
          total_sats: 512,
        },
      ],
    }),
    parkDrain: async (value) => void parked.push(value),
  };
  const summary = await serviceDrains({
    dvmId: "example-dvm",
    handle: "test",
    client,
    keypairsByPubkey: new Map([
      [toLockPubkey(LOCK_PUBKEY), { privkey: PRIVKEY, pubkey: LOCK_PUBKEY }],
    ]),
    walletProvider: async () => wallet(SdkAmount, { send: [sent], keep: [change] }),
  });

  assert.equal(summary.drains_parked, 1);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].keep_proofs[0].amount, 112);
  assert.equal(getDecodedToken(parked[0].token, [KEYSET_ID]).proofs[0].amount.toNumber(), 400);
});

test("standalone service encodes a foreign SDK proof after just-in-time minting", async () => {
  const foreign = SdkAmount.from(392);
  const keys = {};
  for (let amount = 1; amount <= 1024; amount *= 2) keys[amount] = "02" + "cc".repeat(32);
  const mint = {
    createLockedMintQuote: async () => ({
      quote: "q1",
      request: "lnbc4u1pexampleinvoice",
      amount: foreign,
      state: "UNPAID",
      expiry: null,
    }),
    checkMintQuoteBolt11: async () => ({
      quote: "q1",
      request: "lnbc4u1pexampleinvoice",
      amount: foreign,
      state: "PAID",
      expiry: null,
    }),
    prepareMint: async () => ({
      outputData: [
        {
          blindedMessage: { amount: SdkAmount.from(392), B_: "02" + "44".repeat(32), id: KEYSET_ID },
          blindingFactor: 1n,
          secret: new TextEncoder().encode(secret(REFUND_PUBKEY, "jit-output")),
          toProof: () => proof(foreign, REFUND_PUBKEY, "jit"),
        },
      ],
      blindedMessages: [],
    }),
    completeMint: async () => [proof(foreign, REFUND_PUBKEY, "jit")],
    keyChain: { getKeysets: () => [{ id: KEYSET_ID, isActive: true, hasKeys: true, keys }] },
  };
  const parked = [];
  const client = {
    getPendingDrains: async () => ({
      drains: [
        {
          credit_id: "c2",
          drain_id: "d2",
          method: "cashu",
          payout: { refund_pubkey: REFUND_PUBKEY },
          amount_sats: 392,
        },
      ],
      liability: { cashu_sats: 392, by_method_micro: {} },
      mints: ["https://mint.example.com"],
    }),
    getPendingBatches: async () => ({ batches: [] }),
    parkDrain: async (value) => void parked.push(value),
  };
  const summary = await serviceDrains({
    dvmId: "jit-dvm",
    handle: "test",
    client,
    refundNwc: { uri: TEST_NWC_URI },
    keypairsByPubkey: new Map([
      [toLockPubkey(LOCK_PUBKEY), { privkey: PRIVKEY, pubkey: LOCK_PUBKEY }],
    ]),
    currentKeypair: { privkey: PRIVKEY, pubkey: LOCK_PUBKEY },
    walletProvider: async () => mint,
    payInvoice: async () => ({ preimage: "ff".repeat(32), outcome: "paid" }),
  });

  assert.equal(summary.drains_jit_minted, 1);
  assert.equal(parked.length, 1);
  assert.equal(getDecodedToken(parked[0].token, [KEYSET_ID]).proofs[0].amount.toNumber(), 392);
});

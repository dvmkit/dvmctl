import * as fs from "node:fs";
import { join } from "node:path";
import { mock } from "node:test";

const root = process.env.DVMKIT_CONFIG_DIR;
const checkpoint = process.argv[2];
const ledger = join(root, "melt-custody.json");
const mintState = join(root, "submitted-outputs.json");
const acknowledgement = join(root, "acknowledged");
function stop(stage) {
  if (checkpoint !== stage) return;
  fs.writeSync(1, JSON.stringify({ checkpoint: stage }) + "\n");
  process.kill(process.pid, "SIGSTOP");
}
mock.module("node:fs", { namedExports: { ...fs, fsyncSync(fd) {
  fs.fsyncSync(fd);
  if (!fs.fstatSync(fd).isDirectory() || !fs.existsSync(ledger)) return;
  const { data } = JSON.parse(fs.readFileSync(ledger, "utf8"));
  const op = data.operations[0];
  if (!op) return;
  if (op.submission === "prepared") stop("prepared");
  else if (op.observations.length === 0) stop("intent");
  if (op.observations.some(o => o.kind === "submission") && data.proofs.length === 0) stop("response");
  if (data.proofs.length === 2 && !op.acknowledged) stop("imported");
  if (op.acknowledged) stop("acknowledged");
} } });
const { offlineMint, MINT } = await import("../offline-melt-mint.ts");
const { fixture, wallet, inputs, quote } = offlineMint();
if (checkpoint === "audit") { fixture.includeChange = false; fixture.responseChange = false; }
if (fs.existsSync(mintState)) fixture.outputs = JSON.parse(fs.readFileSync(mintState, "utf8"));
fixture.onSubmit = async () => {
  fs.writeFileSync(mintState, JSON.stringify(fixture.outputs), { mode: 0o600 });
  stop("sent");
};
fixture.onCheck = async () => stop("check");
if (checkpoint === "before_prepared") {
  const prepare = wallet.prepareMelt.bind(wallet);
  wallet.prepareMelt = async (...args) => { const result = await prepare(...args); stop("before_prepared"); return result; };
}
const sdk = await import("@dvmkit/sdk/internal");
mock.module("@dvmkit/sdk/internal", { namedExports: { ...sdk,
  getWallet: async () => wallet,
  fetchMeltQuote: async () => ({ amountSats: 210, feeReserveSats: 10, rawQuote: quote() }),
  getInputFeesForProofs: async () => 1,
  fetchLnurlPayInvoice: async () => "synthetic-invoice",
} });
const lock = "02" + "ab".repeat(32);
const pair = { privkey: "11".repeat(32), pubkey: lock };
const keyring = () => ({ canonicalDvmId: "process-custody", currentKeypair: pair, keypairsByPubkey: new Map([[lock, pair]]) });
mock.module(new URL("../../src/lib/cashu/builder-lock-identity.ts", import.meta.url), { namedExports: {
  resolveBuilderLockKeyringByHandle: keyring, resolveBuilderLockKeyring: keyring,
} });
mock.module(new URL("../../src/shared/builder-store.ts", import.meta.url), { namedExports: {
  getBuilderDvm: () => ({ payout_ln_address: "payout@example.invalid" }),
} });
const admin = await import("../../src/lib/admin-cashu-client.ts");
mock.module(new URL("../../src/lib/admin-cashu-client.ts", import.meta.url), { namedExports: { ...admin,
  AdminCashuClient: class {
    async getPendingDrains() { return { drains: [], liability: { cashu_sats: 0, by_method_micro: {} } }; }
    async getPendingBatches() { return { batches: fs.existsSync(acknowledgement) ? [] : [{ mint_url: MINT, lock_pubkey: lock,
      proofs: inputs, row_ids: ["row-1", "row-2", "row-3"], total_sats: 224, t_expire: null }] }; }
    async markMelted() { fs.writeFileSync(acknowledgement, "paid"); return { melted: 3 }; }
  },
} });
const journalUrl = new URL("../../src/lib/melt-pending-log.ts", import.meta.url);
const journal = await import(journalUrl.href);
mock.module(journalUrl, { namedExports: { ...journal, appendPostMelt(entry) {
  journal.appendPostMelt(entry);
  stop("audit");
} } });
let code; let failure;
try {
  const { meltPending } = await import("../../src/commands/builder/melt-pending.ts");
  await meltPending("fixture", { endpoint: "https://dvm.invalid" });
} catch (error) { code = error.code; failure = error.message; }
fs.writeSync(1, JSON.stringify({ done: true, code, failure, submissions: fixture.submitCount }) + "\n");

import { createHash } from "node:crypto";
import { chmodSync, existsSync, fstatSync, fsyncSync, mkdtempSync, readdirSync, renameSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Amount, deserializeProofs, hasValidDleq, hashToCurve, OutputData, serializeProofs } from "@cashu/cashu-ts";
import type * as Sdk from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blindSignature, GENERATOR, KEYSET, ROTATED_KEYSET, MINT, offlineMint } from "../../../../test-support/offline-melt-mint.ts";
import type { MeltPendingOptions } from "../melt-pending.ts";

const capturedWrites = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync),
    writeSync: vi.fn((fd: number, buffer: Uint8Array, offset: number, length: number) => {
      if (fd !== 1 && fd !== 2) return fs.writeSync(fd, buffer, offset, length);
      capturedWrites.push(Buffer.from(buffer).subarray(offset, offset + length).toString());
      return length;
    }) };
});

const mocked = vi.hoisted(() => ({
  wallet: vi.fn(), quote: vi.fn(), fee: vi.fn(), batches: vi.fn(), mark: vi.fn(),
}));
const DVM = "custody-fixture";
const LOCK = "02" + "ab".repeat(32);
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()), getWallet: mocked.wallet,
  fetchMeltQuote: mocked.quote, getInputFeesForProofs: mocked.fee,
  fetchLnurlPayInvoice: vi.fn(async () => "synthetic-invoice"),
}));
vi.mock("../../../lib/cashu/builder-lock-identity.ts", () => ({
  resolveBuilderLockKeyringByHandle: () => ({ canonicalDvmId: DVM,
    currentKeypair: { privkey: "11".repeat(32), pubkey: LOCK },
    keypairsByPubkey: new Map([[LOCK, { privkey: "11".repeat(32), pubkey: LOCK }]]) }),
}));
vi.mock("../../../shared/builder-store.ts", () => ({
  getBuilderDvm: () => ({ payout_ln_address: "payout@example.invalid" }),
}));
vi.mock("../../../lib/admin-cashu-client.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/admin-cashu-client.ts")>()),
  AdminCashuClient: class {
    getPendingBatches = mocked.batches;
    markMelted = mocked.mark;
    async getPendingDrains() { return { drains: [], liability: { cashu_sats: 0, by_method_micro: {} } }; }
  },
}));

async function processObjects() {
  vi.resetModules();
  const { meltPending } = await import("../melt-pending.ts");
  const custody = await import("../../../lib/melt-change-custody.ts");
  return { run: (options: MeltPendingOptions = {}) => meltPending("fixture", { endpoint: "https://dvm.invalid", ...options }), ...custody };
}

describe("builder payout change at the command and private disk boundary", () => {
  let root: string;
  let mint: ReturnType<typeof offlineMint>;
  let acknowledged: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWrites.length = 0;
    root = mkdtempSync(join(tmpdir(), "payout-custody-"));
    vi.stubEnv("DVMKIT_CONFIG_DIR", root);
    mint = offlineMint(); acknowledged = false;
    mocked.wallet.mockResolvedValue(mint.wallet);
    mocked.fee.mockImplementation(async (_mint, proofs) => mint.wallet.getFeesForProofs(proofs).toNumber());
    mocked.quote.mockImplementation(async () => ({ amountSats: mint.fixture.invoiceAmount,
      feeReserveSats: mint.fixture.reserve, rawQuote: mint.quote() }));
    mocked.batches.mockImplementation(async () => ({ batches: acknowledged ? [] : [{ mint_url: MINT,
      lock_pubkey: LOCK, proofs: mint.inputs, row_ids: ["row-1", "row-2", "row-3"], total_sats: 224, t_expire: null }] }));
    mocked.mark.mockImplementation(async () => { acknowledged = true; return { melted: 3 }; });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementation(fs.fsyncSync); vi.mocked(renameSync).mockImplementation(fs.renameSync);
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  });
  function captured() { return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls, capturedWrites].flat().join("\n"); }
  async function reopened() {
    const process = await processObjects();
    const store = new process.MeltCustody();
    const [op] = store.operations(DVM);
    return { ...process, store, op, records: store.records(op) };
  }
  function assertPrivate(outputs: string[]) {
    const publicText = captured() + readFileSync(join(root, "melt-pending.log"), "utf8");
    for (const secret of outputs) expect(publicText).not.toContain(secret);
    expect(publicText).not.toContain("secret-transport-sentinel");
    expect(publicText).not.toContain("synthetic-invoice");
  }

  it("durably owns 9 sat before acknowledgement and infers the independent 4 sat routing fee", async () => {
    mocked.mark.mockImplementation(async () => {
      const { records } = await reopened();
      expect(records.map(r => r.proof.amount)).toEqual(["8", "1"]);
      acknowledged = true; return { melted: 3 };
    });
    await (await processObjects()).run();
    const { store, op, records } = await reopened();
    expect(records).toHaveLength(2);
    expect(records.every(r => r.state === "available" && hasValidDleq({ ...r.proof, amount: Amount.from(r.proof.amount) }, mint.wallet.getKeyset(KEYSET)))).toBe(true);
    expect(store.status(op)).toMatchObject({ gross_input_amount: "224", input_fee_amount: "1", invoice_amount: "210",
      fee_reserve_amount: "10", custodied_change_amount: "9", returned_change_amount: "9", routing_fee_amount: "4", fee_provenance: "inferred", change_recovery_status: "complete" });
    expect(op.initialQuote).toMatchObject({ quote: "original-quote", amount: "210", fee_reserve: "10",
      unit: "sat", state: "UNPAID", expiry: 2_000_000_000, request: "synthetic-invoice", change: [] });
    expect(op.outputs).toHaveLength(4);
    expect(op.outputs.map(o => o.blindedMessage.B_)).toEqual(mint.fixture.outputs.map(o => o.B_));
    expect(op.observations[0].kind).toBe("submission");
    assertPrivate([...records.flatMap(r => [r.proof.secret, r.proof.C]), ...op.outputs.flatMap(o => [o.secret, o.blindingFactor])]);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it.each([true, false])("requires explicit fresh empty change to establish zero (own field: %s)", async own => {
    mint.fixture.invoiceAmount = 213; mint.fixture.quoteAmounts = []; mint.fixture.includeChange = own;
    await (await processObjects()).run();
    const { store, op } = await reopened();
    expect(op.complete).toBe(own);
    expect(store.status(op)).toMatchObject({ returned_change_amount: own ? "0" : null, routing_fee_amount: own ? "10" : null });
    expect(op.acknowledged).toBe(true);
  });

  it("retains inherited-empty outputs after acknowledgement and later imports once from the independent queue", async () => {
    mint.fixture.responseChange = false; mint.fixture.includeChange = false;
    const inherited = await mint.wallet.prepareMelt("bolt11", mint.quote(), mint.inputs, { nut08Change: true }, { type: "random" });
    expect((await mint.wallet.completeMelt(inherited)).quote.change).toEqual([]);
    mint.fixture.submitCount = 0;
    await (await processObjects()).run();
    let state = await reopened();
    expect(state.op.complete).toBe(false);
    expect(state.op.acknowledged).toBe(true);
    const submitted = state.op.observations.find(o => o.kind === "submission")!.data as { quote: object };
    expect(Object.hasOwn(submitted.quote, "change")).toBe(false);
    expect(state.records).toHaveLength(0);
    mint.fixture.includeChange = true;
    await (await processObjects()).run();
    await (await processObjects()).run();
    state = await reopened();
    expect(state.records.map(p => p.proof.amount)).toEqual(["8", "1"]);
    expect(state.op.complete).toBe(true);
    expect(mocked.mark).toHaveBeenCalledTimes(1);
    expect(mint.fixture.submitCount).toBe(1);
  });

  it("rejects the foreign raw GET even though real Mint rewrites the submission ID", async () => {
    mint.fixture.quoteId = "foreign-quote"; mint.fixture.freshQuoteId = "foreign-quote";
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    let state = await reopened();
    const submitted = state.op.observations[0].data as { quote: { quote: string } };
    expect(submitted.quote.quote).toBe("original-quote");
    expect(mocked.mark).not.toHaveBeenCalled(); expect(state.records).toHaveLength(0);
    mint.fixture.freshQuoteId = "original-quote";
    await (await processObjects()).run();
    state = await reopened();
    expect(state.records.map(p => p.proof.amount)).toEqual(["8", "1"]);
    expect(mint.fixture.submitCount).toBe(1);
  });

  it("branches on fresh PENDING after real MeltChangeError, then recovers the saved blanks", async () => {
    mint.fixture.malformedPending = true; mint.fixture.freshState = "PENDING"; mint.fixture.includeChange = false;
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    let state = await reopened();
    expect(state.op.payment).toBe("PENDING"); expect(state.op.outputs).toHaveLength(4);
    expect(mocked.mark).not.toHaveBeenCalled();
    mint.fixture.freshState = "PAID"; mint.fixture.includeChange = true;
    await (await processObjects()).run();
    state = await reopened(); expect(state.records).toHaveLength(2);
    expect(mocked.mark).toHaveBeenCalledTimes(1); expect(mint.fixture.submitCount).toBe(1);
  });

  it("recovers accepted timeout from saved outputs and reordered partial restore without inventing final totals", async () => {
    mint.fixture.timeout = true; mint.fixture.freshState = "PENDING"; mint.fixture.includeChange = false;
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    mint.fixture.freshState = "PAID"; mint.fixture.restoreOrder = [1];
    await (await processObjects()).run();
    let state = await reopened();
    expect(state.records.map(p => p.proof.amount)).toEqual(["1"]); expect(state.op.complete).toBe(false);
    expect(state.store.status(state.op).routing_fee_amount).toBeNull();
    mint.fixture.restoreOrder = [1, 0];
    await (await processObjects()).run();
    await (await processObjects()).run();
    state = await reopened(); expect(state.records.map(p => p.proof.amount)).toEqual(["1", "8"]);
    expect(state.op.complete).toBe(false);
    expect(mocked.mark).toHaveBeenCalledTimes(1); expect(mint.fixture.submitCount).toBe(1);
    mint.fixture.includeChange = true;
    await (await processObjects()).run(); state = await reopened(); expect(state.op.complete).toBe(true);
    assertPrivate(state.records.map(r => r.proof.secret));
  });

  it("keeps imported balance and retries acknowledgement without a second credit", async () => {
    mocked.mark.mockRejectedValueOnce(new Error("secret-transport-sentinel"));
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    expect((await reopened()).records).toHaveLength(2);
    await (await processObjects()).run();
    expect((await reopened()).records).toHaveLength(2);
    expect(mocked.mark).toHaveBeenCalledTimes(2); expect(mint.fixture.submitCount).toBe(1);
    assertPrivate([]);
  });

  it("does not create a new quote when the DVM repeats acknowledged rows after restart", async () => {
    mocked.batches.mockImplementation(async () => ({ batches: [{ mint_url: MINT, lock_pubkey: LOCK, proofs: mint.inputs,
      row_ids: ["row-1", "row-2", "row-3"], total_sats: 224, t_expire: null }] }));
    await (await processObjects()).run();
    await (await processObjects()).run();
    expect(mocked.quote).toHaveBeenCalledTimes(1); expect(mint.fixture.submitCount).toBe(1);
    expect(mocked.mark).toHaveBeenCalledTimes(1); expect((await reopened()).records).toHaveLength(2);
  });

  it("preserves exported/spent tombstones under repeated final and restore evidence", async () => {
    mint.fixture.includeChange = false; mint.fixture.restoreOrder = [1, 0];
    await (await processObjects()).run();
    let state = await reopened();
    state.records[0].state = "exported"; state.records[1].state = "spent"; state.store.commit();
    await (await processObjects()).run();
    mint.fixture.includeChange = true; await (await processObjects()).run();
    state = await reopened(); expect(state.records.map(p => p.state)).toEqual(["exported", "spent"]);
    expect(state.records).toHaveLength(2);
  });

  it("does not make already-spent restored proofs available", async () => {
    mint.fixture.includeChange = false; mint.fixture.restoreOrder = [0, 1];
    mint.fixture.onCheck = async () => {
      const secret = (await reopened()).op.outputs[0].secret;
      mint.fixture.spent.add(hashToCurve(Buffer.from(secret, "hex")).toHex(true));
    };
    await (await processObjects()).run();
    expect((await reopened()).records.map(r => r.state)).toEqual(["spent", "available"]);
  });

  it.each(["spent", "pending"] as const)("reconciles newly %s inventory during repeated recovery", async status => {
    mint.fixture.includeChange = false; mint.fixture.restoreOrder = [0, 1];
    await (await processObjects()).run();
    let state = await reopened();
    expect(state.records.map(r => r.state)).toEqual(["available", "available"]);
    const Y = hashToCurve(new TextEncoder().encode(state.records[0].proof.secret)).toHex(true);
    mint.fixture[status].add(Y);
    await (await processObjects()).run();
    state = await reopened();
    expect(state.records.map(r => r.state)).toEqual([status === "spent" ? "spent" : "held", "available"]);
    mint.fixture[status].clear();
    await (await processObjects()).run();
    state = await reopened();
    expect(state.records.map(r => r.state)).toEqual([status === "spent" ? "spent" : "available", "available"]);
    expect(state.records).toHaveLength(2);
    assertPrivate(state.records.map(r => r.proof.secret));
  });

  it.each([
    ["null change", (q: Record<string, unknown>) => ({ ...q, change: null })],
    ["wrong unit", (q: Record<string, unknown>) => ({ ...q, unit: "usd" })],
    ["wrong amount", (q: Record<string, unknown>) => ({ ...q, amount: 209 })],
    ["foreign invoice", (q: Record<string, unknown>) => ({ ...q, request: "foreign" })],
    ["inflated change", (q: Record<string, unknown>) => ({ ...q, change: [{ id: KEYSET, amount: 128, C_: "bad" }] })],
    ["negative change", (q: Record<string, unknown>) => ({ ...q, change: [{ id: KEYSET, amount: -1, C_: "bad" }] })],
    ["fractional change", (q: Record<string, unknown>) => ({ ...q, change: [{ id: KEYSET, amount: 0.5, C_: "bad" }] })],
  ] as const)("retains outputs and credits nothing for %s", async (_label, alter) => {
    mint.fixture.alterQuote = alter;
    await (await processObjects()).run().catch(error => expect(error).toMatchObject({ code: "batches_failed" }));
    const { op, records } = await reopened();
    expect(records).toHaveLength(0); expect(op.complete).toBe(false); expect(op.outputs).toHaveLength(4);
    assertPrivate(op.outputs.map(o => o.secret));
  });

  it.each(["unknown", "duplicate", "unequal"])("refuses %s restore output mapping", async defect => {
    mint.fixture.includeChange = false; mint.fixture.restoreOrder = [0, 1];
    mint.fixture.alterRestore = response => {
      const outputs = response.outputs as Record<string, unknown>[];
      if (defect === "unknown") outputs[0].B_ = GENERATOR;
      if (defect === "duplicate") outputs[1] = outputs[0];
      if (defect === "unequal") outputs.pop();
      return response;
    };
    await (await processObjects()).run().catch(error => expect(error).toMatchObject({ code: "batches_failed" }));
    expect((await reopened()).records).toHaveLength(0);
  });

  it("rejects contradictory final zero after a partial positive import", async () => {
    mint.fixture.includeChange = false; mint.fixture.restoreOrder = [0];
    await (await processObjects()).run();
    mint.fixture.quoteAmounts = []; mint.fixture.includeChange = true;
    await (await processObjects()).run();
    const { op, records } = await reopened();
    expect(op.complete).toBe(false); expect(records.map(p => p.proof.amount)).toEqual(["8"]);
  });

  it("sums mixed same-unit input fee rates before rounding once", async () => {
    mint.inputs[2] = { ...mint.inputs[2], id: ROTATED_KEYSET,
      C: (await import("@cashu/cashu-ts")).pointFromHex(mint.inputs[2].C).multiply(11n).toHex(true) };
    await (await processObjects()).run();
    const { op, store } = await reopened();
    expect(op.feeRates).toEqual([{ id: KEYSET, ppk: "100" }, { id: KEYSET, ppk: "100" }, { id: ROTATED_KEYSET, ppk: "100" }]);
    expect(store.status(op)).toMatchObject({ input_fee_amount: "1", gross_input_amount: "224", invoice_amount: "210" });
  });

  it("refuses foreign units before submitting", async () => {
    mocked.quote.mockImplementation(async () => ({ amountSats: 210, feeReserveSats: 10, rawQuote: { ...mint.quote(), unit: "usd" } }));
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(mint.fixture.submitCount).toBe(0); expect(mocked.mark).not.toHaveBeenCalled();
  });

  it.each(["gross mismatch", "fractional input"])("refuses a %s before invoice or melt submission", async defect => {
    if (defect === "gross mismatch") mocked.batches.mockResolvedValue({ batches: [{ mint_url: MINT, lock_pubkey: LOCK,
      proofs: mint.inputs, row_ids: ["row-1", "row-2", "row-3"], total_sats: 225, t_expire: null }] });
    else mint.inputs[0].amount = 127.5;
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(mocked.quote).not.toHaveBeenCalled(); expect(mint.fixture.submitCount).toBe(0);
  });

  it("refuses corrupt and symlinked private state rather than recreating a balance", async () => {
    await (await processObjects()).run();
    const path = join(root, "melt-custody.json");
    writeFileSync(path, "{");
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "melt_custody_invalid" });
    expect(readFileSync(path, "utf8")).toBe("{");
    const foreign = join(root, "foreign"); writeFileSync(foreign, "retained");
    rmSync(path); symlinkSync(foreign, path);
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "melt_custody_invalid" });
    expect(readFileSync(foreign, "utf8")).toBe("retained");
    expect(mint.fixture.submitCount).toBe(1);
  });

  it("refuses to recreate an empty balance when an initialized ledger disappears", async () => {
    await (await processObjects()).run();
    const path = join(root, "melt-custody.json"); rmSync(path);
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "melt_custody_invalid" });
    expect(existsSync(path)).toBe(false); expect(mint.fixture.submitCount).toBe(1);
  });

  it("tightens existing private permissions and refuses an altered output manifest", async () => {
    await (await processObjects()).run();
    const path = join(root, "melt-custody.json"); chmodSync(path, 0o644); chmodSync(root, 0o755);
    await reopened();
    expect(statSync(root).mode & 0o777).toBe(0o700); expect(statSync(path).mode & 0o777).toBe(0o600);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.data.operations[0].outputs[0].blindingFactor = "2";
    envelope.checksum = createHash("sha256").update(JSON.stringify(envelope.data)).digest("hex");
    writeFileSync(path, JSON.stringify(envelope));
    await expect(reopened()).rejects.toMatchObject({ code: "melt_custody_invalid" });
  });

  it("preserves zero-placeholder positions when reconstructing quote change", async () => {
    mint.fixture.quoteAmounts = [0, 8, 1];
    await (await processObjects()).run();
    const { op, records } = await reopened();
    expect(records.map(p => p.output)).toEqual([1, 2]);
    expect(records.map(p => p.proof.secret)).toEqual([op.outputs[1], op.outputs[2]].map(o => Buffer.from(o.secret, "hex").toString()));
    expect(records.map(p => p.proof.amount)).toEqual(["8", "1"]);
  });

  it("reconstructs legitimate same-unit signatures from a rotated keyset", async () => {
    mint.fixture.useRotated = true;
    await (await processObjects()).run();
    const { records } = await reopened();
    expect(records.map(p => p.proof.id)).toEqual([ROTATED_KEYSET, ROTATED_KEYSET]);
    expect(records.map(p => p.proof.amount)).toEqual(["8", "1"]);
    expect(records.every(p => p.state === "available")).toBe(true);
  });

  it("restores reordered outputs carrying their assigned amounts and rotated signature keysets", async () => {
    mint.fixture.includeChange = false; mint.fixture.useRotated = true; mint.fixture.restoreOrder = [1, 0];
    mint.fixture.restoreActualAmounts = true; mint.fixture.restoreSignatureKeysets = true;
    await (await processObjects()).run();
    let state = await reopened();
    expect(state.records.map(p => p.proof.amount)).toEqual(["1", "8"]);
    expect(state.records.every(p => p.proof.id === ROTATED_KEYSET && p.state === "available")).toBe(true);
    expect(state.op.complete).toBe(false);
    mint.fixture.includeChange = true; await (await processObjects()).run();
    state = await reopened(); expect(state.op.complete).toBe(true); expect(state.records).toHaveLength(2);
  });

  it("rejects a restored output amount that conflicts with its signature", async () => {
    mint.fixture.includeChange = false; mint.fixture.restoreOrder = [0, 1];
    mint.fixture.alterRestore = response => {
      (response.outputs as { amount: number }[])[0].amount = 4;
      return response;
    };
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    const { op, records } = await reopened();
    expect(records).toHaveLength(0); expect(op.complete).toBe(false); expect(op.quarantine).toBe(true);
  });

  it.each(["quote", "restore"])("holds signatures without DLEQ until later %s evidence verifies the same balance", async source => {
    mint = offlineMint({ requireSigDleq: false }); mocked.wallet.mockResolvedValue(mint.wallet);
    mint.fixture.alterQuote = quote => ({ ...quote, change: (quote.change as object[]).map(signature => ({ ...signature, dleq: undefined })) });
    await (await processObjects()).run();
    let { op, store, records } = await reopened();
    expect(records).toHaveLength(2); expect(op.complete).toBe(true);
    expect(records.every(p => p.state === "held" && p.verification === "unverified")).toBe(true);
    expect(store.status(op).available_change_amount).toBe("0");
    const identities = records.map(p => p.identity);
    mint.fixture.alterQuote = undefined;
    mint.fixture.includeChange = source === "quote"; mint.fixture.restoreOrder = [1, 0];
    await (await processObjects()).run();
    ({ op, store, records } = await reopened());
    expect(records.map(p => p.identity)).toEqual(identities);
    expect(records.every(p => p.state === "available" && p.verification === "dleq" &&
      hasValidDleq({ ...p.proof, amount: Amount.from(p.proof.amount) }, mint.wallet.getKeyset(KEYSET)))).toBe(true);
    expect(store.status(op).available_change_amount).toBe("9");
    await (await processObjects()).run();
    expect((await reopened()).records.map(p => p.identity)).toEqual(identities);
    expect(mint.fixture.submitCount).toBe(1); expect(mocked.mark).toHaveBeenCalledTimes(1);
    expect(mint.fixture.checkCount).toBe(source === "quote" ? 2 : 3);
  });

  it.each([
    ["quote", []], ["restore", []], ["quote", [4, 1]], ["restore", [4, 1]],
  ] as const)("reconciles saved positive %s evidence before a conflicting final set %j", async (source, finalAmounts) => {
    mint.fixture.invoiceAmount = 213; mint.fixture.timeout = true;
    mint.fixture.includeChange = source === "quote"; mint.fixture.restoreOrder = [0, 1];
    const ensure = vi.spyOn(mint.wallet, "ensureOperableKeysets");
    mint.fixture.onSubmit = async () => { ensure.mockRejectedValue(new Error("metadata temporarily unavailable")); };
    await (await processObjects()).run();
    let state = await reopened();
    expect(state.records).toHaveLength(0); expect(state.op.complete).toBe(false);
    const evidence = state.op.observations.find(o => o.kind === source)!.data;
    expect(evidence).toHaveProperty(source === "quote" ? "change" : "signatures",
      expect.arrayContaining([expect.objectContaining({ amount: "8" }), expect.objectContaining({ amount: "1" })]));
    ensure.mockRestore();
    mint.fixture.includeChange = true; mint.fixture.quoteAmounts = [...finalAmounts];
    await (await processObjects()).run();
    state = await reopened();
    expect(state.op.observations).toContainEqual(expect.objectContaining({ kind: source, data: evidence }));
    expect(state.records).toHaveLength(0); expect(state.op.complete).toBe(false);
    expect(state.store.status(state.op)).toMatchObject({ returned_change_amount: null, routing_fee_amount: null,
      change_recovery_status: "quarantined" });
    expect(mint.fixture.submitCount).toBe(1); expect(mocked.mark).toHaveBeenCalledTimes(1);
  });

  it("does not turn conflicting immediate positive candidates into fresh zero change", async () => {
    mint.fixture.alterQuote = quote => ({ ...quote, change: [] });
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    const { op, records, store } = await reopened();
    expect(records).toHaveLength(0); expect(op.complete).toBe(false);
    expect(store.status(op)).toMatchObject({ returned_change_amount: null, change_recovery_status: "quarantined" });
  });

  it("does not infer zero when a reconstruction error preserved positive change signatures", async () => {
    mint.fixture.invoiceAmount = 213;
    mint.fixture.malformedPending = true; mint.fixture.malformedState = "PAID"; mint.fixture.quoteAmounts = [];
    await (await processObjects()).run().catch(error => expect(error).toMatchObject({ code: "batches_failed" }));
    const { op, store } = await reopened();
    expect(op.payment).toBe("PAID"); expect(op.complete).toBe(false);
    expect(store.status(op)).toMatchObject({ available_change_amount: "0", returned_change_amount: null,
      routing_fee_amount: null, change_recovery_status: "quarantined" });
    expect(mint.fixture.submitCount).toBe(1);
  });

  it("does not classify excess input value as a routing fee above the reserve ceiling", async () => {
    mint.fixture.quoteAmounts = [];
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    const { op, store } = await reopened();
    expect(op.complete).toBe(false);
    expect(store.status(op)).toMatchObject({ returned_change_amount: null, routing_fee_amount: null,
      change_recovery_status: "quarantined" });
    expect(mint.fixture.submitCount).toBe(1);
    // Unreconciled change does not unspend the inputs: the paid rows must leave pending-batches.
    expect(mocked.mark).toHaveBeenCalledExactlyOnceWith({ row_ids: ["row-1", "row-2", "row-3"],
      melt_quote_id: "original-quote", payment_preimage: "receipt" });
    expect(op.acknowledged).toBe(true);
    const checks = mint.fixture.checkCount; const observations = op.observations.length;
    await (await processObjects()).run(); await (await processObjects()).run();
    expect(mocked.mark).toHaveBeenCalledTimes(1); expect(mint.fixture.submitCount).toBe(1);
    // Terminal quarantine: later ticks neither query the mint nor grow the custody file.
    expect(mint.fixture.checkCount).toBe(checks);
    expect((await reopened()).op.observations).toHaveLength(observations);
  });

  it("acknowledges a paid melt on recovery even when its change stays quarantined", async () => {
    mint.fixture.quoteAmounts = [];
    mocked.mark.mockRejectedValueOnce(new Error("admin endpoint unavailable"));
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    expect((await reopened()).op).toMatchObject({ payment: "PAID", acknowledged: false, quarantine: true });
    expect(captured()).not.toContain("melt_pending_change_unresolved");
    await (await processObjects()).run();
    const { op } = await reopened();
    expect(op.acknowledged).toBe(true);
    expect(mocked.mark).toHaveBeenLastCalledWith({ row_ids: ["row-1", "row-2", "row-3"],
      melt_quote_id: "original-quote", payment_preimage: "receipt" });
    expect(mint.fixture.submitCount).toBe(1);
    expect(captured()).not.toContain("melt_pending_recovery_check_failed");
    expect(captured()).toContain("melt_pending_change_unresolved");
  });

  it.each(["a different preimage", "no answer"])("does not acknowledge on recovery when the fresh quote gives %s", async variant => {
    mint.fixture.quoteAmounts = [];
    mocked.mark.mockRejectedValueOnce(new Error("admin endpoint unavailable"));
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    if (variant === "no answer") mint.fixture.onCheck = async () => { throw new Error("mint unreachable"); };
    else mint.fixture.alterQuote = quote => ({ ...quote, payment_preimage: "another-receipt" });
    await (await processObjects()).run().catch(() => undefined);
    expect((await reopened()).op.acknowledged).toBe(false);
    expect(mocked.mark).toHaveBeenCalledTimes(1);
    expect(captured()).toContain("melt_pending_recovery_check_failed");
    if (variant !== "no answer") expect(captured()).toContain("melt_pending_fresh_quote_contradicts");
  });

  it("keeps a failed held-change refresh on an acknowledged melt at error level", async () => {
    const states = vi.spyOn(mint.wallet, "checkProofsStates").mockRejectedValueOnce(new Error("checkstate unavailable"));
    await (await processObjects()).run();
    const first = await reopened();
    expect(first.op).toMatchObject({ acknowledged: true, complete: true });
    expect(first.records.every(r => r.state === "held")).toBe(true);
    states.mockRestore();
    vi.mocked(console.error).mockClear();
    mocked.wallet.mockRejectedValueOnce(new Error("wallet metadata unavailable"));
    await (await processObjects()).run().catch(() => undefined);
    const errors = vi.mocked(console.error).mock.calls.flat().join("\n");
    expect(errors).toContain("melt_pending_recovery_check_failed");
    expect((await reopened()).op.acknowledged).toBe(true);
  });

  it.each(["bad DLEQ", "too many", "foreign keyset", "bad point"])("never credits %s signature evidence", async defect => {
    mint.fixture.alterQuote = quote => {
      const change = quote.change as Record<string, unknown>[];
      if (defect === "bad DLEQ") change[0].dleq = { s: "00".repeat(32), e: "00".repeat(32) };
      if (defect === "too many") return { ...quote, change: Array(5).fill(change[0]) };
      if (defect === "foreign keyset") change[0].id = "00" + "ff".repeat(7);
      if (defect === "bad point") change[0].C_ = "02" + "ff".repeat(32);
      return quote;
    };
    await (await processObjects()).run().catch(error => expect(error).toMatchObject({ code: "batches_failed" }));
    const { op, records } = await reopened(); expect(records).toHaveLength(0); expect(op.complete).toBe(false);
  });

  it("rejects a replay assigning a different amount to an already imported output", async () => {
    mint.fixture.includeChange = false; mint.fixture.restoreOrder = [0];
    await (await processObjects()).run();
    mint.fixture.restoreAmounts = [4, 1];
    await (await processObjects()).run();
    const { op, records, store } = await reopened();
    expect(records.map(p => p.proof.amount)).toEqual(["8"]); expect(op.complete).toBe(false);
    expect(store.status(op).change_recovery_status).toBe("quarantined");
    expect(records[0].state).toBe("held");
  });

  it.each(["fsync", "rename"])("never submits when prepared output %s fails", async fault => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const prepare = mint.wallet.prepareMelt.bind(mint.wallet);
    vi.spyOn(mint.wallet, "prepareMelt").mockImplementation(async (...args) => {
      const preview = await prepare(...args);
      if (fault === "rename") vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("disk failure"); });
      else vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("disk failure"); });
      return preview;
    });
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(mint.fixture.submitCount).toBe(0); expect(mocked.mark).not.toHaveBeenCalled();
    const envelope = JSON.parse(readFileSync(join(root, "melt-custody.json"), "utf8"));
    expect(envelope.data.operations).toHaveLength(0);
    for (const name of readdirSync(root).filter(name => name.endsWith(".tmp"))) expect(statSync(join(root, name)).mode & 0o777).toBe(0o600);
    vi.mocked(fsyncSync).mockImplementation(realFs.fsyncSync); vi.mocked(renameSync).mockImplementation(realFs.renameSync);
  });

  it("syncs every new custody directory's parent before submission", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const parent = join(root, "private"); const directory = join(parent, "custody");
    vi.stubEnv("DVMKIT_CONFIG_DIR", directory);
    const synced: string[] = []; let beforeSubmission: string[] = [];
    vi.mocked(fsyncSync).mockImplementation(fd => {
      realFs.fsyncSync(fd);
      const stat = fstatSync(fd);
      for (const path of [root, parent, directory]) if (existsSync(path) && stat.isDirectory() && stat.ino === statSync(path).ino) synced.push(path);
    });
    mint.fixture.onSubmit = async () => { beforeSubmission = [...synced]; };
    await (await processObjects()).run();
    expect(beforeSubmission).toEqual(expect.arrayContaining([root, parent, directory]));
    expect(beforeSubmission.indexOf(root)).toBeLessThan(beforeSubmission.indexOf(parent));
    expect(statSync(parent).mode & 0o777).toBe(0o700); expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(mint.fixture.submitCount).toBe(1);
  });

  it.each(["outer", "inner"])("refuses submission when the %s parent directory fsync fails, then retries its barrier", async level => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const parent = join(root, "private"); const directory = join(parent, "custody");
    const failedParent = level === "outer" ? root : parent;
    vi.stubEnv("DVMKIT_CONFIG_DIR", directory);
    vi.mocked(fsyncSync).mockImplementation(fd => {
      const stat = fstatSync(fd);
      if (existsSync(failedParent) && stat.isDirectory() && stat.ino === statSync(failedParent).ino) throw new Error("parent durability unavailable");
      realFs.fsyncSync(fd);
    });
    await expect((await processObjects()).run()).rejects.toThrow();
    expect(mint.fixture.submitCount).toBe(0); expect(mocked.mark).not.toHaveBeenCalled();
    let retried = false;
    vi.mocked(fsyncSync).mockImplementation(fd => {
      realFs.fsyncSync(fd);
      if (fstatSync(fd).ino === statSync(failedParent).ino) retried = true;
    });
    let durableAtSubmission = false;
    mint.fixture.onSubmit = async () => { durableAtSubmission = retried; };
    await (await processObjects()).run();
    expect(durableAtSubmission).toBe(true); expect(mint.fixture.submitCount).toBe(1);
  });

  it.each([
    ["json", false], ["human", false], ["watch", false], ["human watch", false],
    ["json", true], ["human", true], ["watch", true], ["human watch", true],
  ] as const)("redacts all bearer material in %s output (lost response: %s)", async (mode, lost) => {
    mint.fixture.timeout = lost;
    const command = await processObjects();
    const watch = mode.includes("watch"); const human = mode.includes("human");
    const previous = new Map(["SIGTERM", "SIGINT"].map(signal => [signal, new Set(process.listeners(signal))]));
    const running = command.run({ human, watch, interval: 10 });
    if (watch) {
      try {
        await vi.waitFor(() => expect(captured()).toContain(human ? "seen=1" : '"batches_seen":1'));
      } finally {
        for (const signal of ["SIGTERM", "SIGINT"]) for (const listener of process.listeners(signal)) {
          if (previous.get(signal)!.has(listener)) continue;
          if (signal === "SIGTERM") listener();
          process.removeListener(signal, listener);
        }
        await running;
      }
    } else await running;
    const { op, records, store } = await reopened();
    expect(records).toHaveLength(2); expect(store.status(op).available_change_amount).toBe("9");
    if (lost) expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("melt_pending_melt_failed");
    if (human) expect(capturedWrites.join("\n")).toContain("seen=1");
    else expect(capturedWrites.join("\n")).toContain('"batches_seen":1');
    if (watch) expect(captured()).toContain("melt_pending_watch_stopping");
    assertPrivate([...mint.inputs.flatMap(p => [p.secret, p.C]), ...records.flatMap(p => [p.proof.secret, p.proof.C]),
      ...op.outputs.flatMap(o => [o.secret, Buffer.from(o.secret, "hex").toString(), o.blindingFactor])]);
  });

  it("retains paid outputs through a failed directory fsync and recovers once after restart", async () => {
    const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let failed = false;
    vi.mocked(fsyncSync).mockImplementation(fd => {
      realFs.fsyncSync(fd);
      const file = join(root, "melt-custody.json");
      if (failed || !fstatSync(fd).isDirectory() || !existsSync(file)) return;
      const { data } = JSON.parse(readFileSync(file, "utf8"));
      if (data.operations[0]?.payment === "PAID") { failed = true; throw new Error("directory durability unavailable"); }
    });
    await expect((await processObjects()).run()).rejects.toMatchObject({ code: "batches_failed" });
    expect(mocked.mark).not.toHaveBeenCalled(); expect(mint.fixture.submitCount).toBe(1);
    vi.mocked(fsyncSync).mockImplementation(realFs.fsyncSync);
    await (await processObjects()).run();
    expect((await reopened()).records.map(p => p.proof.amount)).toEqual(["8", "1"]);
    expect(mint.fixture.submitCount).toBe(1);
  });

  it("refreshes a held proof after an uncertain spend-state check without another melt", async () => {
    const check = vi.spyOn(mint.wallet, "checkProofsStates").mockRejectedValueOnce(new Error("state unavailable"));
    await (await processObjects()).run();
    expect((await reopened()).records.map(r => r.state)).toEqual(["held", "held"]);
    await (await processObjects()).run();
    expect((await reopened()).records.map(r => r.state)).toEqual(["available", "available"]);
    expect(mint.fixture.submitCount).toBe(1); expect(check).toHaveBeenCalledTimes(2);
  });

  it("uses saved random outputs even for a seeded wallet whose counter reservation is unavailable", async () => {
    const reserve = vi.fn(async () => { throw new Error("counter reservation is unavailable"); });
    mint = offlineMint({ bip39seed: new Uint8Array(64).fill(1), counterSource: { reserve, advanceToAtLeast: reserve } });
    mocked.wallet.mockResolvedValue(mint.wallet);
    await (await processObjects()).run();
    const { op, records } = await reopened();
    expect(op.generation).toBe("random"); expect(records.map(p => p.proof.amount)).toEqual(["8", "1"]);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("labels quote-only legacy journals without promising recovery of unsaved secrets", async () => {
    const process = await processObjects();
    const journal = await import("../../../lib/melt-pending-log.ts");
    journal.appendPreMelt({ dvm_id: DVM, row_ids: ["old-row"], mint_url: MINT, quote_id: "legacy-quote", lock_pubkey: LOCK, total_sats: 1 });
    journal.appendPostMelt({ dvm_id: DVM, row_ids: ["old-row"], quote_id: "legacy-quote", status: "success", preimage: "old-receipt" });
    mocked.batches.mockResolvedValue({ batches: [] });
    await process.run();
    expect(captured()).toContain('"change_recovery_status":"legacy_missing_material"');
    expect(new process.MeltCustody().operations(DVM)).toEqual([]);
    expect(mint.fixture.submitCount).toBe(0);
  });

  it.each(["missing fields", "non-string blinding factor"])("rejects a private proof record with %s in its DLEQ data", async defect => {
    await (await processObjects()).run();
    const path = join(root, "melt-custody.json");
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    const proof = envelope.data.proofs[0].proof;
    proof.dleq = defect === "missing fields" ? {} : { ...proof.dleq, r: [proof.dleq.r] };
    envelope.checksum = createHash("sha256").update(JSON.stringify(envelope.data)).digest("hex");
    writeFileSync(path, JSON.stringify(envelope));
    await expect(reopened()).rejects.toMatchObject({ code: "melt_custody_invalid" });
    expect(mint.fixture.submitCount).toBe(1);
  });

  it("keeps decimal ledger amounts distinct from the lossless proof wire codec", async () => {
    await (await processObjects()).run();
    const { records, loadProof, storeProof, store, op } = await reopened();
    const large = 2n ** 63n + 1n;
    const proof = { ...loadProof(records[0].proof), amount: Amount.from(large) };
    const wire = serializeProofs(proof)[0];
    expect(BigInt(JSON.parse(wire).amount)).not.toBe(large);
    expect(deserializeProofs([wire])[0].amount.toBigInt()).toBe(large);
    expect(loadProof(JSON.parse(JSON.stringify(storeProof(proof)))).amount.toBigInt()).toBe(large);
    const output = OutputData.createRandomData(0, mint.wallet.getKeyset(KEYSET), [0])[0];
    const largeOp = store.prepare({ dvm: "amount-fixture", mint: MINT, unit: "sat", method: "bolt11", quote: "large-quote", initialQuote: { quote: "large-quote", amount: "0", fee_reserve: "0", unit: "sat" }, invoice: "synthetic-invoice",
      rows: ["large-row"], lock: LOCK, gross: large.toString(), inputFee: "0", invoiceAmount: "0", reserve: "0",
      feeRates: [{ id: KEYSET, ppk: "0" }], inputs: [{ id: KEYSET, secret: "large-input", C: GENERATOR, amount: large.toString() }],
      outputs: [OutputData.serialize(output)], generation: "random" });
    largeOp.payment = "PAID";
    const unsigned = { id: KEYSET, secret: new TextDecoder().decode(output.secret), C: GENERATOR, amount: Amount.from(large) };
    store.import(largeOp, [{ proof: unsigned, output: 0, state: "held" }], false);
    const disk = new (await processObjects()).MeltCustody();
    const [persisted] = disk.records(disk.operations("amount-fixture")[0]);
    expect(loadProof(persisted.proof).amount.toBigInt()).toBe(large);
    expect(persisted.state).toBe("held");
  });
});

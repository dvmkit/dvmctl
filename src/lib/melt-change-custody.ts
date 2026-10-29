import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  Amount, hashToCurve, OutputData, pointFromHex,
  type MeltPreview, type Proof, type ProofLike, type SerializedBlindedSignature,
  type SerializedOutputData, type SerializedProof, type Wallet,
} from "@cashu/cashu-ts";
import { DvmError } from "@dvmkit/sdk/internal";

import { BUILDER_CONFIG_DIR } from "../shared/defaults.ts";

export type InventoryState = "available" | "held" | "spent" | "exported";
export interface CustodyProof {
  identity: string;
  mint: string;
  unit: "sat";
  proof: SerializedProof;
  operation: string;
  output: number;
  verification: "dleq" | "unverified";
  state: InventoryState;
}
interface Observation {
  kind: "submission" | "quote" | "restore";
  at: number;
  quote: string;
  ownChange: boolean;
  data: unknown;
}
export interface CustodyOperation {
  id: string;
  created: number;
  dvm: string;
  mint: string;
  unit: "sat";
  method: "bolt11";
  quote: string;
  initialQuote: Record<string, unknown>;
  invoice: string;
  rows: string[];
  lock: string;
  gross: string;
  inputFee: string;
  invoiceAmount: string;
  reserve: string;
  feeRates: { id: string; ppk: string }[];
  inputs: SerializedProof[];
  inputIdentities: string[];
  outputs: SerializedOutputData[];
  generation: "random";
  manifest: string;
  submission: "prepared" | "submission_possible" | "rejected";
  payment: "UNKNOWN" | "UNPAID" | "PENDING" | "PAID";
  preimage?: string;
  acknowledged: boolean;
  complete: boolean;
  imported: string[];
  observations: Observation[];
  evidence: "proofs" | "signatures_only" | "explicit_empty" | "partial" | "unavailable";
  signatureAmount: string | null;
  quarantine: boolean;
}
interface Snapshot { version: 1; operations: CustodyOperation[]; proofs: CustodyProof[] }

const fail = () => new DvmError("melt_custody_invalid", "Private melt custody is invalid or unavailable. No new melt is authorized; preserve the existing private files for recovery.");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unsigned = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
function requireValue(condition: unknown): asserts condition { if (!condition) throw fail(); }
function text(value: unknown): asserts value is string { requireValue(typeof value === "string" && value.length > 0); }
function amount(value: unknown): string {
  requireValue(typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Amount);
  if (typeof value === "number") requireValue(Number.isSafeInteger(value) && value >= 0);
  const result = Amount.from(value).toString();
  requireValue(unsigned(result));
  return result;
}
export function canonicalMint(value: string): string {
  const url = new URL(value);
  requireValue(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash);
  return url.toString().replace(/\/+$/, "");
}
function identity(mint: string, proof: Pick<ProofLike, "id" | "secret">): string {
  return digest([mint, proof.id, createHash("sha256").update(proof.secret).digest("hex")]);
}
export function storeProof(proof: ProofLike): SerializedProof {
  const stored = { ...proof, amount: amount(proof.amount) };
  validateProof(stored);
  return stored;
}
export function loadProof(proof: SerializedProof): Proof { return { ...proof, amount: Amount.from(proof.amount) }; }
function validateProof(proof: SerializedProof): void {
  text(proof.id); text(proof.secret); text(proof.C); requireValue(unsigned(proof.amount));
  pointFromHex(proof.C);
  if (proof.dleq !== undefined) {
    requireValue(proof.dleq && typeof proof.dleq === "object" && !Array.isArray(proof.dleq));
    for (const value of [proof.dleq.e, proof.dleq.s]) requireValue(typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value));
    if (proof.dleq.r !== undefined) requireValue(typeof proof.dleq.r === "string" && /^[a-fA-F0-9]{64}$/.test(proof.dleq.r));
  }
}
function sameProof(left: SerializedProof, right: SerializedProof): boolean {
  return left.id === right.id && left.secret === right.secret && left.C === right.C && left.amount === right.amount &&
    (!left.p2pk_e || !right.p2pk_e || left.p2pk_e === right.p2pk_e);
}
function immutable(op: CustodyOperation): unknown {
  return [op.id, op.created, op.dvm, op.mint, op.unit, op.method, op.quote, op.initialQuote, op.invoice, op.rows, op.lock,
    op.gross, op.inputFee, op.invoiceAmount, op.reserve, op.feeRates, op.inputs, op.inputIdentities, op.outputs, op.generation];
}
function validate(snapshot: Snapshot, checked = new Set<string>()): void {
  requireValue(snapshot.version === 1 && Array.isArray(snapshot.operations) && Array.isArray(snapshot.proofs));
  const operations = new Map<string, CustodyOperation>();
  const quotes = new Set<string>();
  for (const op of snapshot.operations) {
    for (const value of [op.id, op.dvm, op.mint, op.quote, op.invoice, op.lock]) text(value);
    requireValue(op.mint === canonicalMint(op.mint) && op.unit === "sat" && op.method === "bolt11" && op.generation === "random");
    requireValue(op.initialQuote && typeof op.initialQuote === "object" && !Array.isArray(op.initialQuote));
    requireValue(op.initialQuote.quote === op.quote && op.initialQuote.unit === op.unit &&
      op.initialQuote.amount === op.invoiceAmount && op.initialQuote.fee_reserve === op.reserve);
    requireValue(op.initialQuote.request === undefined || op.initialQuote.request === op.invoice);
    requireValue(Number.isSafeInteger(op.created) && op.created > 0);
    requireValue(!operations.has(op.id) && !quotes.has(digest([op.dvm, op.mint, op.quote])));
    operations.set(op.id, op); quotes.add(digest([op.dvm, op.mint, op.quote]));
    requireValue(Array.isArray(op.rows) && op.rows.length > 0 && new Set(op.rows).size === op.rows.length);
    op.rows.forEach(text);
    for (const value of [op.gross, op.inputFee, op.invoiceAmount, op.reserve]) requireValue(unsigned(value));
    requireValue(BigInt(op.gross) >= BigInt(op.inputFee) + BigInt(op.invoiceAmount) + BigInt(op.reserve));
    requireValue(Array.isArray(op.inputs) && op.inputs.length === op.rows.length && Array.isArray(op.feeRates));
    const manifest = digest(immutable(op));
    requireValue(op.manifest === manifest);
    if (!checked.has(manifest)) op.inputs.forEach(validateProof);
    requireValue(op.inputs.reduce((n, p) => n + BigInt(p.amount), 0n).toString() === op.gross);
    requireValue(Array.isArray(op.inputIdentities) && digest(op.inputIdentities) === digest(op.inputs.map(p => identity(op.mint, p))));
    requireValue(new Set(op.inputIdentities).size === op.inputs.length);
    let ppk = 0n;
    requireValue(op.feeRates.length === op.inputs.length);
    op.feeRates.forEach((rate, i) => { requireValue(rate.id === op.inputs[i].id && unsigned(rate.ppk)); ppk += BigInt(rate.ppk); });
    requireValue(((ppk + 999n) / 1000n).toString() === op.inputFee);
    requireValue(Array.isArray(op.outputs));
    const blanks = new Set<string>();
    for (const output of checked.has(manifest) ? [] : op.outputs) {
      requireValue(unsigned(output.blindedMessage.amount) && output.blindedMessage.amount === "0");
      requireValue(unsigned(output.blindingFactor) && /^[a-fA-F0-9]+$/.test(output.secret));
      requireValue(!blanks.has(output.blindedMessage.B_)); blanks.add(output.blindedMessage.B_);
      requireValue(digest(OutputData.serialize(OutputData.deserialize(output))) === digest(output));
    }
    checked.add(manifest);
    requireValue(["prepared", "submission_possible", "rejected"].includes(op.submission));
    requireValue(["UNKNOWN", "UNPAID", "PENDING", "PAID"].includes(op.payment));
    requireValue(typeof op.acknowledged === "boolean" && typeof op.complete === "boolean" && typeof op.quarantine === "boolean");
    requireValue(op.preimage === undefined || (typeof op.preimage === "string" && op.preimage.length > 0));
    requireValue(!op.acknowledged || (op.payment === "PAID" && typeof op.preimage === "string" && op.preimage.length > 0));
    requireValue(!op.complete || (op.payment === "PAID" && !op.quarantine));
    requireValue(Array.isArray(op.imported) && new Set(op.imported).size === op.imported.length && Array.isArray(op.observations));
    requireValue(["proofs", "signatures_only", "explicit_empty", "partial", "unavailable"].includes(op.evidence));
    requireValue(op.signatureAmount === null || unsigned(op.signatureAmount));
    requireValue(!op.complete || op.signatureAmount !== null);
    for (const observation of op.observations) {
      requireValue(["submission", "quote", "restore"].includes(observation.kind) && observation.quote === op.quote &&
        Number.isSafeInteger(observation.at) && typeof observation.ownChange === "boolean");
    }
  }
  const proofs = new Set<string>();
  const origins = new Set<string>();
  for (const record of snapshot.proofs) {
    const op = operations.get(record.operation);
    requireValue(op && op.mint === record.mint && record.unit === "sat");
    validateProof(record.proof);
    requireValue(record.identity === identity(record.mint, record.proof) && !proofs.has(record.identity)); proofs.add(record.identity);
    requireValue(Number.isSafeInteger(record.output) && record.output >= 0 && record.output < op.outputs.length);
    const origin = digest([op.id, record.output]); requireValue(!origins.has(origin)); origins.add(origin);
    requireValue(record.proof.secret === new TextDecoder().decode(Buffer.from(op.outputs[record.output].secret, "hex")));
    requireValue(op.imported.includes(record.identity));
    requireValue(["available", "held", "spent", "exported"].includes(record.state));
    requireValue(["dleq", "unverified"].includes(record.verification));
    requireValue(record.verification !== "dleq" || !!record.proof.dleq);
    requireValue(record.state !== "available" || (record.verification === "dleq" && !op.quarantine));
  }
  for (const op of snapshot.operations) {
    const records = snapshot.proofs.filter(p => p.operation === op.id);
    requireValue(op.imported.every(id => records.some(p => p.identity === id)));
    const total = records.reduce((n, p) => n + BigInt(p.proof.amount), 0n);
    requireValue(total <= residual(op) && (total === 0n || op.payment === "PAID"));
    requireValue(op.signatureAmount === null || BigInt(op.signatureAmount) <= residual(op));
    requireValue(!op.complete || (total.toString() === op.signatureAmount && residual(op) - total <= BigInt(op.reserve)));
  }
}

// O_NOFOLLOW and fstat protect both reads and writes from symlink substitution.
export function privateDirectory(path: string): void {
  text(path);
  durableDirectory(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireValue(stat.isDirectory() && stat.uid === process.getuid?.());
    fchmodSync(fd, 0o700);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function durableDirectory(path: string): void {
  const parentPath = dirname(path);
  if (parentPath === path) return;
  durableDirectory(parentPath);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  // The entry lives in its parent. Repeat this barrier on retry after a failed
  // bootstrap, even if the directory now exists; do not chmod existing ancestors.
  const parent = openSync(parentPath, constants.O_RDONLY);
  try { requireValue(fstatSync(parent).isDirectory()); fsyncSync(parent); }
  finally { closeSync(parent); }
}
function privateFile(fd: number): void {
  const stat = fstatSync(fd);
  requireValue(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.());
}

/** The command holds the global payout lock for this store's entire lifetime. */
export class MeltCustody {
  readonly path = join(BUILDER_CONFIG_DIR, "melt-custody.json");
  private readonly initialized = join(BUILDER_CONFIG_DIR, "melt-custody.initialized");
  private snapshot: Snapshot;
  private readonly checked = new Set<string>();
  constructor() {
    try {
      privateDirectory(BUILDER_CONFIG_DIR);
      let fd: number;
      try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          // Absence after initialization is lost custody, never a fresh empty wallet.
          try { lstatSync(this.initialized); throw fail(); }
          catch (markerError) {
            if (!(markerError instanceof Error && "code" in markerError && markerError.code === "ENOENT")) throw markerError;
          }
          this.snapshot = { version: 1, operations: [], proofs: [] };
          this.commit();
          this.markInitialized();
          return;
        }
        throw error;
      }
      try {
        privateFile(fd); fchmodSync(fd, 0o600);
        const envelope = JSON.parse(readFileSync(fd, "utf8"));
        requireValue(envelope.checksum === digest(envelope.data));
        validate(envelope.data, this.checked);
        this.snapshot = envelope.data;
      } finally { closeSync(fd); }
      this.markInitialized();
    } catch { throw fail(); }
  }
  private markInitialized(): void {
    let fd: number;
    try {
      fd = openSync(this.initialized, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { privateFile(fd); fchmodSync(fd, 0o600); writeFileSync(fd, "1\n"); fsyncSync(fd); }
      finally { closeSync(fd); }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      fd = openSync(this.initialized, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { privateFile(fd); fchmodSync(fd, 0o600); requireValue(readFileSync(fd, "utf8") === "1\n"); }
      finally { closeSync(fd); }
    }
    const directory = openSync(BUILDER_CONFIG_DIR, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  operations(dvm: string): CustodyOperation[] { return this.snapshot.operations.filter(op => op.dvm === dvm); }
  records(op: CustodyOperation): CustodyProof[] { return this.snapshot.proofs.filter(p => p.operation === op.id); }
  /**
   * Whether an accumulator row was spent by a payout melt the mint has
   * confirmed PAID. A pending melt does not count: its inputs read PENDING, not
   * SPENT, unless it failed and something else (such as a refund swap that lost
   * its response) spent them, and buying a refund then would pay it twice.
   */
  spentByPaidMelt(dvm: string, mintUrl: string, rowId: string): boolean {
    let mint: string;
    try { mint = canonicalMint(mintUrl); } catch { return false; }
    return this.snapshot.operations.some(op => op.dvm === dvm && op.mint === mint &&
      op.submission !== "rejected" && op.payment === "PAID" && op.rows.includes(rowId));
  }
  commit(): void {
    try {
      validate(this.snapshot, this.checked);
      // Refuse a substituted target instead of replacing a symlink or another owner's file.
      try {
        const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { privateFile(fd); } finally { closeSync(fd); }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const temp = `${this.path}.${randomUUID()}.tmp`;
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { privateFile(fd); fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify({ checksum: digest(this.snapshot), data: this.snapshot })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temp, this.path);
      const directory = openSync(BUILDER_CONFIG_DIR, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { throw new DvmError("melt_custody_io", "Private melt custody could not be committed. No further submission is authorized."); }
  }
  prepare(details: Omit<CustodyOperation, "id" | "created" | "manifest" | "submission" | "payment" | "acknowledged" | "complete" | "imported" | "observations" | "evidence" | "signatureAmount" | "quarantine" | "inputIdentities">): CustodyOperation {
    requireValue(!this.snapshot.operations.some(op => op.dvm === details.dvm && op.mint === details.mint && op.quote === details.quote));
    const inputIdentities = details.inputs.map(p => identity(details.mint, p));
    requireValue(!this.snapshot.operations.some(op => op.submission !== "rejected" &&
      (op.inputIdentities.some(id => inputIdentities.includes(id)) ||
        (!op.acknowledged && op.dvm === details.dvm && op.rows.some(row => details.rows.includes(row))))));
    const op: CustodyOperation = { ...details, inputIdentities, id: randomUUID(), created: Date.now(), manifest: "",
      submission: "prepared", payment: "UNKNOWN", acknowledged: false, complete: false, imported: [], observations: [],
      evidence: "unavailable", signatureAmount: null, quarantine: false };
    op.manifest = digest(immutable(op));
    this.snapshot.operations.push(op); this.commit();
    return op;
  }
  observe(op: CustodyOperation, kind: Observation["kind"], data: unknown): void {
    // Native Amount.toJSON emits decimal strings. Do not use the JSONInt proof wire codec here.
    op.observations.push({ kind, at: Date.now(), quote: op.quote,
      ownChange: !!data && typeof data === "object" && Object.hasOwn(data, "change"),
      data: JSON.parse(JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value)) });
    this.commit();
  }
  import(op: CustodyOperation, pairs: { proof: Proof; output: number; state: InventoryState }[], final: boolean): void {
    requireValue(op.payment === "PAID");
    // Immediate candidates are never credited independently. A final quote must agree
    // with every candidate; a partial restore must agree for each matched output.
    for (const observation of op.observations.filter(o => o.kind === "submission")) {
      const result = observation.data as { quote?: unknown; change?: SerializedProof[] } | null;
      const quoted = result && typeof result.quote === "object"
        ? result.quote as { change?: { amount?: unknown }[] } | null
        : result;
      if (final && pairs.length === 0 && Array.isArray(quoted?.change)) {
        requireValue(quoted.change.every(signature => amount(signature?.amount) === "0"));
      }
      if (!result || typeof result.quote !== "object" || !Array.isArray(result.change)) continue;
      for (const candidate of result.change) {
        const pair = pairs.find(p => p.proof.secret === candidate.secret);
        requireValue(!final || !!pair);
        if (pair) requireValue(sameProof(storeProof(pair.proof), candidate));
      }
    }
    const ids = pairs.map(({ proof }) => identity(op.mint, proof));
    requireValue(new Set(ids).size === ids.length);
    if (final) requireValue(op.imported.every(id => ids.includes(id)));
    for (const { proof, output, state } of pairs) {
      const id = identity(op.mint, proof);
      const stored = storeProof(proof);
      const previous = this.snapshot.proofs.find(p => p.identity === id);
      const origin = this.snapshot.proofs.find(p => p.operation === op.id && p.output === output);
      requireValue(!origin || origin.identity === id);
      if (previous) {
        requireValue(previous.operation === op.id && previous.output === output && sameProof(previous.proof, stored));
      }
    }
    const total = new Map(this.records(op).map(p => [p.identity, BigInt(p.proof.amount)]));
    pairs.forEach(({ proof }) => total.set(identity(op.mint, proof), proof.amount.toBigInt()));
    const changeAmount = [...total.values()].reduce((n, v) => n + v, 0n);
    requireValue(changeAmount <= residual(op) && (!final || residual(op) - changeAmount <= BigInt(op.reserve)));
    for (const { proof, output, state } of pairs) {
      const id = identity(op.mint, proof);
      const previous = this.snapshot.proofs.find(p => p.identity === id);
      if (!previous) {
        this.snapshot.proofs.push({ identity: id, mint: op.mint, unit: "sat", proof: storeProof(proof), operation: op.id, output,
          verification: proof.dleq ? "dleq" : "unverified", state: (!proof.dleq || op.quarantine) && state === "available" ? "held" : state });
        op.imported.push(id);
      } else {
        if (proof.dleq) { previous.proof = { ...previous.proof, ...storeProof(proof) }; previous.verification = "dleq"; }
        if (previous.state !== "spent" && previous.state !== "exported") {
          previous.state = state === "spent" ? "spent"
            : previous.verification === "dleq" && !op.quarantine ? state : "held";
        }
      }
    }
    op.complete = final && !op.quarantine;
    op.evidence = final ? (pairs.length ? "proofs" : "explicit_empty") : (op.imported.length ? "partial" : "unavailable");
    this.commit();
  }
  async refreshHeld(op: CustodyOperation, wallet: Wallet): Promise<void> {
    const held = this.records(op).filter(record => record.state === "held");
    const pairs = await reconcileSpendStates(wallet, held.map(record => loadProof(record.proof)), held.map(record => record.output));
    pairs.forEach((pair, i) => {
      if (pair.state === "spent" || (held[i].verification === "dleq" && !op.quarantine)) held[i].state = pair.state;
    });
    this.commit();
  }
  status(op: CustodyOperation): Record<string, unknown> {
    const custodied = this.records(op).reduce((n, p) => n + BigInt(p.proof.amount), 0n);
    const returned = op.complete ? op.signatureAmount : null;
    return { quote_id: op.quote, unit: op.unit, gross_input_amount: op.gross, input_fee_amount: op.inputFee,
      invoice_amount: op.invoiceAmount, fee_reserve_amount: op.reserve, payment_state: op.payment,
      available_change_amount: this.records(op).filter(p => p.state === "available").reduce((n, p) => n + BigInt(p.proof.amount), 0n).toString(),
      change_evidence: op.evidence, custodied_change_amount: custodied.toString(), signature_change_amount: op.signatureAmount,
      returned_change_amount: returned, routing_fee_amount: returned === null ? null : (residual(op) - BigInt(returned)).toString(),
      fee_provenance: returned === null ? "unavailable" : "inferred", unobserved_remainder: (residual(op) - custodied).toString(),
      change_recovery_status: op.quarantine ? "quarantined" : op.complete ? "complete" : "change_unresolved" };
  }
}
function residual(op: CustodyOperation): bigint { return BigInt(op.gross) - BigInt(op.invoiceAmount) - BigInt(op.inputFee); }

export async function prepareCustody(
  store: MeltCustody, wallet: Wallet,
  details: { dvm: string; mint: string; rows: string[]; lock: string; gross: number; inputFee: number; invoice: string },
  quote: { quote: string; amount: unknown; fee_reserve?: unknown; unit?: string; request?: string },
  proofs: ProofLike[]
): Promise<{ op: CustodyOperation; preview: MeltPreview<{ quote: string; amount: Amount; unit: string }> }> {
  const mint = canonicalMint(details.mint);
  requireValue(canonicalMint(wallet.mint.mintUrl) === mint && wallet.unit === "sat");
  text(quote.quote); requireValue(quote.unit === "sat");
  requireValue(quote.request === undefined || quote.request === details.invoice);
  const invoiceAmount = amount(quote.amount); const reserve = amount(quote.fee_reserve);
  await wallet.ensureOperableKeysets(proofs.map(p => p.id));
  const feeRates = proofs.map(p => {
    const keyset = wallet.getKeyset(p.id);
    requireValue(keyset.unit === "sat");
    return { id: p.id, ppk: amount(keyset.fee) };
  });
  const inputFee = ((feeRates.reduce((n, r) => n + BigInt(r.ppk), 0n) + 999n) / 1000n).toString();
  requireValue(inputFee === amount(details.inputFee));
  requireValue(proofs.reduce((n, p) => n + BigInt(amount(p.amount)), 0n).toString() === amount(details.gross));
  requireValue(BigInt(amount(details.gross)) >= BigInt(invoiceAmount) + BigInt(reserve) + BigInt(inputFee));
  const submissionQuote = { quote: quote.quote, amount: Amount.from(invoiceAmount), unit: "sat" };
  const preview = await wallet.prepareMelt("bolt11", submissionQuote, proofs, { nut08Change: true }, { type: "random" });
  for (const output of preview.outputData) requireValue(wallet.getKeyset(output.blindedMessage.id).unit === "sat");
  const op = store.prepare({ dvm: details.dvm, mint, rows: details.rows, lock: details.lock, gross: amount(details.gross), inputFee,
    unit: "sat", method: "bolt11", quote: quote.quote,
    initialQuote: JSON.parse(JSON.stringify({ ...quote, amount: invoiceAmount, fee_reserve: reserve },
      (_key, value) => typeof value === "bigint" ? value.toString() : value)),
    invoice: details.invoice, invoiceAmount, reserve,
    feeRates, inputs: proofs.map(storeProof), outputs: preview.outputData.map(OutputData.serialize), generation: "random" });
  return { op, preview };
}

/** Accept only a fresh same-quote GET. Submission results have already been merged/rewritten upstream. */
export async function recoverCustody(store: MeltCustody, op: CustodyOperation, wallet: Wallet): Promise<CustodyOperation["payment"]> {
  requireValue(canonicalMint(wallet.mint.mintUrl) === op.mint && wallet.unit === op.unit);
  const quote = await wallet.mint.checkMeltQuoteBolt11(op.quote);
  store.observe(op, "quote", quote);
  validateFreshQuote(op, quote);
  op.payment = quote.state;
  if (quote.payment_preimage) op.preimage = quote.payment_preimage;
  store.commit();
  if (quote.state !== "PAID") return quote.state;
  try {
    const outputs = op.outputs.map(OutputData.deserialize);
    if (Object.hasOwn(quote, "change")) {
      const signatures = quote.change!;
      await validateSignatures(wallet, op, signatures, outputs.length);
      reconcileSignatureEvidence(op, signatures.map((signature, output) => ({ signature, output })), true);
      op.signatureAmount = signatures.reduce((n, sig) => n + BigInt(amount(sig.amount)), 0n).toString();
      op.evidence = "signatures_only";
      store.commit();
      const proofs = wallet.createMeltChangeProofs(outputs, signatures);
      const indices = signatures.flatMap((sig, i) => Amount.from(sig.amount).isZero() ? [] : [i]);
      const pairs = await reconcileSpendStates(wallet, proofs, indices);
      store.import(op, pairs, true);
    } else if (outputs.length === 0 && residual(op) === 0n) {
      reconcileSignatureEvidence(op, [], true);
      op.signatureAmount = "0"; store.import(op, [], true);
    } else {
      const response = await wallet.mint.restore({ outputs: outputs.map(o => o.blindedMessage) });
      store.observe(op, "restore", response);
      requireValue(Array.isArray(response.outputs) && Array.isArray(response.signatures) && response.outputs.length === response.signatures.length);
      const seen = new Set<number>();
      const matched = response.outputs.map((output, i) => {
        pointFromHex(output.B_);
        const index = outputs.findIndex(o => o.blindedMessage.B_ === output.B_);
        requireValue(index >= 0 && !seen.has(index)); seen.add(index);
        const signature = response.signatures[i];
        requireValue(output.id === op.outputs[index].blindedMessage.id || output.id === signature.id);
        const restoredAmount = amount(output.amount);
        requireValue(restoredAmount === "0" || restoredAmount === amount(signature.amount));
        return { index, output: outputs[index], signature };
      });
      await validateSignatures(wallet, op, response.signatures, outputs.length);
      reconcileSignatureEvidence(op, matched.map(pair => ({ signature: pair.signature, output: pair.index })), false);
      const proofs = matched.flatMap(pair => wallet.createMeltChangeProofs([pair.output], [pair.signature]));
      const indices = matched.filter(pair => !Amount.from(pair.signature.amount).isZero()).map(pair => pair.index);
      store.import(op, await reconcileSpendStates(wallet, proofs, indices), false);
    }
  } catch (error) {
    if (error instanceof DvmError && error.code === "melt_custody_io") throw error;
    if (error instanceof DvmError && error.code === "melt_custody_invalid") {
      op.quarantine = true; op.complete = false;
      for (const record of store.records(op)) if (record.state === "available") record.state = "held";
      store.commit(); throw error;
    }
    // Mint availability and reconstruction failures retain payment evidence and all outputs.
    op.complete = false; store.commit();
  }
  return op.payment;
}
type FreshQuote = Awaited<ReturnType<Wallet["mint"]["checkMeltQuoteBolt11"]>>;
function validateFreshQuote(op: CustodyOperation, quote: FreshQuote): void {
  requireValue(quote.quote === op.quote && ["UNPAID", "PENDING", "PAID"].includes(quote.state));
  requireValue(quote.unit === undefined || quote.unit === op.unit);
  requireValue(quote.amount !== undefined && amount(quote.amount) === op.invoiceAmount);
  requireValue(quote.fee_reserve !== undefined && amount(quote.fee_reserve) === op.reserve);
  requireValue(quote.request === undefined || quote.request === op.invoice);
  if (Object.hasOwn(quote, "change")) requireValue(Array.isArray(quote.change));
  requireValue(quote.payment_preimage === undefined || quote.payment_preimage === null || typeof quote.payment_preimage === "string");
  requireValue(!op.preimage || !quote.payment_preimage || op.preimage === quote.payment_preimage);
  requireValue(op.payment !== "PAID" || quote.state === "PAID");
}
/**
 * Whether one recorded fresh quote answer, on its own, shows this operation
 * PAID with the preimage on record. Earlier observations do not count: a mint
 * that now answers differently must not have its rows acknowledged.
 */
export function freshQuoteConfirmsPaid(op: CustodyOperation, observation: unknown): boolean {
  if (!observation || typeof observation !== "object") return false;
  const quote = observation as FreshQuote;
  try { validateFreshQuote(op, quote); } catch { return false; }
  return quote.state === "PAID" && typeof quote.payment_preimage === "string" &&
    quote.payment_preimage.length > 0 && quote.payment_preimage === op.preimage;
}
function reconcileSignatureEvidence(
  op: CustodyOperation, current: { signature: SerializedBlindedSignature; output: number }[], final: boolean
): void {
  const positive = new Map(current.filter(pair => amount(pair.signature.amount) !== "0").map(pair => [pair.output, pair.signature]));
  for (const observation of op.observations) {
    // Submission proof candidates are checked by import; these raw signatures
    // must survive metadata/reconstruction outages before any proof exists.
    if (observation.kind === "submission") continue;
    const data = observation.data as { change?: SerializedBlindedSignature[]; signatures?: SerializedBlindedSignature[];
      outputs?: { B_: string }[] } | null;
    if (!data || typeof data !== "object") continue;
    let previous: { signature: SerializedBlindedSignature; output: number }[] = [];
    if (observation.kind === "quote" && Array.isArray(data.change)) {
      previous = data.change.map((signature, output) => ({ signature, output }));
    } else if (observation.kind === "restore" && Array.isArray(data.signatures)) {
      requireValue(Array.isArray(data.outputs) && data.outputs.length === data.signatures.length);
      previous = data.signatures.map((signature, i) => ({ signature,
        output: op.outputs.findIndex(output => output.blindedMessage.B_ === data.outputs![i].B_) }));
    }
    for (const { signature, output } of previous) {
      const value = amount(signature.amount);
      if (value === "0") continue;
      requireValue(output >= 0 && output < op.outputs.length);
      const next = positive.get(output);
      requireValue(!final || !!next);
      if (next) requireValue(next.id === signature.id && amount(next.amount) === value &&
        pointFromHex(next.C_).equals(pointFromHex(signature.C_)));
    }
  }
}
async function validateSignatures(wallet: Wallet, op: CustodyOperation, signatures: SerializedBlindedSignature[], limit: number): Promise<void> {
  requireValue(signatures.length <= limit);
  let total = 0n;
  for (const signature of signatures) {
    text(signature.id); const value = amount(signature.amount); total += BigInt(value);
    pointFromHex(signature.C_);
    if (signature.dleq) for (const field of [signature.dleq.e, signature.dleq.s]) requireValue(/^[a-fA-F0-9]{64}$/.test(field));
  }
  requireValue(total <= residual(op));
  await wallet.ensureOperableKeysets(signatures.filter(s => !Amount.from(s.amount).isZero()).map(s => s.id));
  for (const signature of signatures) if (!Amount.from(signature.amount).isZero()) requireValue(wallet.getKeyset(signature.id).unit === op.unit);
}
async function reconcileSpendStates(wallet: Wallet, proofs: Proof[], indices: number[]): Promise<{ proof: Proof; output: number; state: InventoryState }[]> {
  let states: Awaited<ReturnType<Wallet["checkProofsStates"]>> = [];
  try { states = proofs.length ? await wallet.checkProofsStates(proofs) : []; } catch { /* Uncertain proofs remain held. */ }
  return proofs.map((proof, i) => {
    const Y = hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
    const state = states.length === proofs.length && states[i]?.Y === Y ? states[i].state : undefined;
    return { proof, output: indices[i], state: state === "SPENT" ? "spent" : state === "UNSPENT" ? "available" : "held" };
  });
}

import {
  Amount, createBlindSignature, createDLEQProof, deriveKeysetId, hashToCurve, Mint,
  pointFromHex, Wallet, type RequestFn, type SerializedBlindedMessage,
} from "@cashu/cashu-ts";

export const GENERATOR = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export const MINT = "https://mint.invalid";
const point = pointFromHex(GENERATOR);
const scalars = Object.fromEntries([1, 2, 4, 8, 16, 32, 64, 128, 256].map((v, i) => [v, BigInt(i + 2)]));
export const keys = Object.fromEntries(Object.entries(scalars).map(([v, key]) => [v, point.multiply(key).toHex(true)]));
export const KEYSET = deriveKeysetId(keys, { unit: "sat", input_fee_ppk: 100 });
export const rotatedKeys = Object.fromEntries(Object.entries(scalars).map(([v, key]) => [v, point.multiply(key * 11n).toHex(true)]));
export const ROTATED_KEYSET = deriveKeysetId(rotatedKeys, { unit: "sat", input_fee_ppk: 100 });
export function blindSignature(output: Pick<SerializedBlindedMessage, "B_">, value: number, rotated = false) {
  if (value === 0) return { id: KEYSET, amount: Amount.from(0), C_: GENERATOR };
  const privateKey = Uint8Array.from(Buffer.from((scalars[value] * (rotated ? 11n : 1n)).toString(16).padStart(64, "0"), "hex"));
  const B = pointFromHex(output.B_);
  const id = rotated ? ROTATED_KEYSET : KEYSET;
  const signed = createBlindSignature(B, privateKey, id);
  const dleq = createDLEQProof(B, privateKey);
  return { id, amount: Amount.from(value), C_: signed.C_.toHex(true),
    dleq: { s: Buffer.from(dleq.s).toString("hex"), e: Buffer.from(dleq.e).toString("hex") } };
}
export function offlineMint(options: NonNullable<ConstructorParameters<typeof Wallet>[1]> = {}) {
  const fixture = {
    state: "PAID", freshState: "PAID", quoteId: "original-quote", freshQuoteId: "original-quote",
    invoiceAmount: 210, reserve: 10, includeChange: true, responseChange: true,
    timeout: false, malformedPending: false, malformedState: "PENDING", useRotated: false, submitCount: 0, checkCount: 0,
    outputs: [] as SerializedBlindedMessage[], restoreOrder: [] as number[],
    restoreActualAmounts: false, restoreSignatureKeysets: false,
    restoreAmounts: [8, 1], quoteAmounts: [8, 1], spent: new Set<string>(), pending: new Set<string>(),
    onSubmit: undefined as (() => Promise<void>) | undefined,
    onCheck: undefined as (() => Promise<void>) | undefined,
    alterQuote: undefined as ((value: Record<string, unknown>) => Record<string, unknown>) | undefined,
    alterRestore: undefined as ((value: Record<string, unknown>) => Record<string, unknown>) | undefined,
  };
  const response = (state: string, quote: string, include: boolean) => ({
    quote, state, amount: fixture.invoiceAmount, fee_reserve: fixture.reserve, unit: "sat",
    expiry: 2_000_000_000, request: "synthetic-invoice", payment_preimage: state === "PAID" ? "receipt" : null,
    ...(include ? { change: fixture.quoteAmounts.map((v, i) => blindSignature(fixture.outputs[i], v, fixture.useRotated)) } : {}),
  });
  const request: RequestFn = async ({ endpoint, requestBody }) => {
    let result: unknown;
    if (endpoint.endsWith("/melt/bolt11")) {
      fixture.submitCount++;
      fixture.outputs = (requestBody as { outputs: SerializedBlindedMessage[] }).outputs;
      await fixture.onSubmit?.();
      if (fixture.timeout) throw new Error("secret-transport-sentinel");
      result = response(fixture.state, fixture.quoteId, fixture.responseChange);
      if (fixture.malformedPending) result = { ...(result as object), state: fixture.malformedState,
        change: Array(fixture.outputs.length + 1).fill(blindSignature(fixture.outputs[0], 1)) };
    } else if (endpoint.includes("/melt/quote/bolt11/")) {
      fixture.checkCount++;
      await fixture.onCheck?.();
      result = response(fixture.freshState, fixture.freshQuoteId, fixture.includeChange);
      if (fixture.alterQuote) result = fixture.alterQuote(result as Record<string, unknown>);
    } else if (endpoint.endsWith("/restore")) {
      result = { outputs: fixture.restoreOrder.map(i => ({ ...fixture.outputs[i],
        amount: fixture.restoreActualAmounts ? fixture.restoreAmounts[i] : 0,
        id: fixture.restoreSignatureKeysets && fixture.useRotated ? ROTATED_KEYSET : fixture.outputs[i].id })),
        signatures: fixture.restoreOrder.map(i => blindSignature(fixture.outputs[i], fixture.restoreAmounts[i], fixture.useRotated)) };
          if (fixture.alterRestore) result = fixture.alterRestore(result as Record<string, unknown>);
    } else if (endpoint.endsWith("/checkstate")) {
      result = { states: (requestBody as { Ys: string[] }).Ys.map(Y => ({ Y,
        state: fixture.spent.has(Y) ? "SPENT" : fixture.pending.has(Y) ? "PENDING" : "UNSPENT", witness: null })) };
    } else throw new Error(`Unexpected offline request: ${endpoint}`);
    return result as never;
  };
  const mint = new Mint(MINT, { customRequest: request });
  const wallet = new Wallet(mint, { strictCachedKeysets: true, requireSigDleq: true, ...options });
  wallet.loadMintFromCache({ name: "offline", pubkey: keys[1], version: "offline", contact: [],
    nuts: { 4: { methods: [{ method: "bolt11", unit: "sat", min_amount: 0, max_amount: 1000000 }], disabled: false },
      5: { methods: [{ method: "bolt11", unit: "sat", min_amount: 0, max_amount: 1000000 }], disabled: false }, 12: { supported: true } } },
  { mintUrl: MINT, keysets: [{ id: KEYSET, unit: "sat", active: true, input_fee_ppk: 100, keys },
    { id: ROTATED_KEYSET, unit: "sat", active: false, input_fee_ppk: 100, keys: rotatedKeys }] });
  const inputs = [128, 64, 32].map((value, i) => {
    const secret = `synthetic-input-${i}`;
    return { id: KEYSET, amount: value, secret,
      C: hashToCurve(new TextEncoder().encode(secret)).multiply(scalars[value]).toHex(true) };
  });
  return { fixture, wallet, inputs, quote: () => ({ quote: "original-quote", amount: Amount.from(fixture.invoiceAmount),
    fee_reserve: Amount.from(fixture.reserve), unit: "sat", state: "UNPAID" as const,
    expiry: 2_000_000_000, request: "synthetic-invoice", change: [] }) };
}

import { getP2PKSigFlag, getP2PKWitnessSignatures, hashToCurve, type Wallet, type ProofLike } from "@cashu/cashu-ts";

import type { AdminBatch } from "../../lib/admin-cashu-client.ts";

export interface WitnessRejection {
  outcome: "witness_rejected";
  rowIds: string[];
  code: number | null;
}

/** A dry run: no metadata requests, invoices, or durable submission state. */
export function proofSigningGroup(wallet: Wallet, proof: ProofLike, privkey: string): string | null {
  let secret: unknown;
  try { secret = JSON.parse(proof.secret); } catch { return "inputs"; }
  if (!Array.isArray(secret) || !["P2PK", "HTLC"].includes(secret[0])) return "inputs";
  try {
    // Some mint parsers index scalar tags directly, while cashu-ts treats a
    // valueless tag as absent. A witness cannot make that condition spendable.
    const tags = secret[1]?.tags;
    if (Array.isArray(tags) && tags.some(tag => Array.isArray(tag) && tag.length === 1 &&
      ["n_sigs", "sigflag"].includes(tag[0]))) return null;
    const signed = wallet.signP2PKProofs([proof], privkey, [], "preflight")[0];
    if (getP2PKWitnessSignatures(signed.witness).length === 0) return null;
    return getP2PKSigFlag(proof.secret) === "SIG_ALL"
      ? JSON.stringify([secret[0], secret[1].data, secret[1].tags ?? []])
      : "inputs";
  } catch { return null; }
}

/** Nutshell's generic transaction code is final only for known witness validation failures. */
export function isWitnessRejection(code: number | null, err: unknown): boolean {
  if (code === 10001) return true;
  if (code !== 11000 || !(err instanceof Error)) return false;
  return /^(?:pubkeys must be unique\.|no signatures in proof\.|signatures must be unique\.|n_sigs must be positive\.|no witness in proof\.|witness data not allowed without a spending condition\.|not all secrets are equal\.|signature threshold not met\. \d+ < \d+\.|not enough pubkeys \(\d+\) or signatures \(\d+\) present for n_sigs \(\d+\)\.)$/.test(err.message);
}

/** Match complete mint identifiers or an explicitly quoted secret, never an input index guess. */
export function identifiedRejectedRows(err: unknown, batch: AdminBatch): string[] {
  if (!(err instanceof Error)) return [];
  const identifiers = new Set(err.message.match(/(?<![\da-fA-F])[\da-fA-F]{66}(?![\da-fA-F])/g) ?? []);
  return batch.proofs.flatMap((proof, index) => {
    const y = hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
    return identifiers.has(y) || identifiers.has(proof.C) || err.message.includes(JSON.stringify(proof.secret))
      ? [batch.row_ids[index]] : [];
  });
}

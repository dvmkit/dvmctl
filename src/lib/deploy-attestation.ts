/**
 * Keep deploy and serve on the same attestation and receipt-key derivation.
 * Signing is pure; the build wrapper reads identity and manifest from disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  type AttestationPayload,
  buildAttestation,
  deriveReceiptKeypair,
  DvmError,
  type JsonValue,
  loadIdentitySecret,
  signAttestation,
} from "@dvmkit/sdk/internal";

import { loadIdentityPubkey } from "../shared/builder-store.ts";

/**
 * A signed builder attestation, plus the receipt secret it binds when the
 * caller can actually put one in front of the running DVM.
 *
 * The payload is canonical-JSON signed with the builder identity key over
 * `canonicaliseForSigning(payload)`; the platform verifies before recording the
 * binding, and the DVM serves it verbatim on `/v1/info#builder`.
 */
export interface DeployAttestation {
  identityPubkey: string;
  payload: AttestationPayload;
  signature: string;
  /** The raw declared capabilities the payload's `capabilities_hash` covers.
   *  Sent to the platform so it can independently re-hash and reject
   *  an attestation re-bound to a different capability shape. */
  capabilities: JsonValue;
  /** Receipt-signing secret to provision as `DVMKIT_RECEIPT_KEY`.
   *  Present iff the payload carries a `receipt_pubkey` — the two travel
   *  together, since attesting a key the running DVM doesn't hold would make
   *  every receipt it signs unverifiable. */
  receiptSecret?: string;
}

export interface SignDeployAttestationArgs {
  /** Builder identity secret (32-byte hex). Never leaves the signing process. */
  builderSecret: string;
  /** Builder identity x-only pubkey (64 hex), matching {@link builderSecret}. */
  builderPubkey: string;
  /** Immutable DVM identity being attested and used as the receipt-key derivation tag. */
  dvmId: string;
  /** Human-readable DVM slug, retained as signed display metadata. */
  slug: string;
  /** Declared capabilities, hashed into the payload. */
  capabilities: JsonValue;
  /**
   * Derive and bind a receipt key. Pass it only where the matching secret can
   * reach the running DVM: attesting a pubkey the process doesn't hold makes
   * every receipt it signs verify as `invalid`, which is strictly worse than an
   * honestly unattested one.
   */
  withReceiptKey?: boolean;
}

/**
 * Derive receipts under the immutable DVM ID, so redeploys and restarts reuse
 * the same key. Takes keys already in hand and performs no disk reads.
 */
export function signDeployAttestation(args: SignDeployAttestationArgs): DeployAttestation {
  const receipt = args.withReceiptKey
    ? deriveReceiptKeypair(args.builderSecret, args.dvmId)
    : undefined;
  const payload = buildAttestation({
    dvmId: args.dvmId,
    slug: args.slug,
    capabilities: args.capabilities,
    builderPubkey: args.builderPubkey,
    receiptPubkey: receipt?.pubkey,
  });
  return {
    identityPubkey: args.builderPubkey,
    payload,
    signature: signAttestation(payload, args.builderSecret),
    capabilities: args.capabilities,
    receiptSecret: receipt?.secret,
  };
}

/**
 * Load the builder identity, read capabilities from
 * `package.json#dvmkit.capabilities`, and sign. Caller is responsible for the
 * `identity_required` preflight via {@link requireBuilderIdentity}.
 */
export function buildDeployAttestation(
  cwd: string,
  slug: string,
  dvmId: string,
  opts: { withReceiptKey?: boolean } = {}
): DeployAttestation {
  const pubkey = loadIdentityPubkey();
  const secret = loadIdentitySecret();
  if (!pubkey || !secret) {
    // Defensive: requireBuilderIdentity should have caught this upstream.
    // Surface the same code so the operator gets a consistent hint.
    throw new DvmError(
      "identity_required",
      "Builder identity is missing or partial (pubkey ≠ secret on disk).",
      "Run `dvmctl identity create --force` to regenerate."
    );
  }
  return signDeployAttestation({
    builderSecret: secret,
    builderPubkey: pubkey,
    dvmId,
    slug,
    capabilities: readCapabilitiesForAttestation(cwd),
    withReceiptKey: opts.withReceiptKey,
  });
}

/**
 * The env vars that put an attestation in front of a running SDK server.
 *
 * `DVMKIT_BUILDER_ATTESTATION` is a JSON string because Fly secrets can't carry
 * structured data, and the SDK parses it back (`app.ts#parseAttestationFromEnv`).
 * The identity and attestation fields move with the signing secret: the three
 * builder fields compose `/v1/info#builder`, both ID fields bind it to the
 * runtime identity, and the secret is the key whose pubkey that block attests.
 */
export function attestationEnv(attestation: DeployAttestation): Record<string, string> {
  const env: Record<string, string> = {
    DVMKIT_BUILDER_PUBKEY: attestation.identityPubkey,
    DVMKIT_BUILDER_ATTESTATION: JSON.stringify(attestation.payload),
    DVMKIT_BUILDER_SIGNATURE: attestation.signature,
    DVMKIT_DVM_ID: attestation.payload.dvm_id,
    DVMKIT_CANONICAL_DVM_ID: attestation.payload.dvm_id,
  };
  // Unlike the other three, this one is a *secret*. It's derived one-way from
  // the builder key, so leaking it doesn't expose the identity key — but anyone
  // holding it can sign receipts as this DVM.
  if (attestation.receiptSecret) env.DVMKIT_RECEIPT_KEY = attestation.receiptSecret;
  return env;
}

/** The env var names {@link attestationEnv} writes, for callers that check occupancy first. */
export const ATTESTATION_ENV_KEYS = [
  "DVMKIT_BUILDER_PUBKEY",
  "DVMKIT_BUILDER_ATTESTATION",
  "DVMKIT_BUILDER_SIGNATURE",
  "DVMKIT_RECEIPT_KEY",
  "DVMKIT_DVM_ID",
  "DVMKIT_CANONICAL_DVM_ID",
] as const;

/** Share the identity preflight across deployment modes for consistent remediation. */
export function requireBuilderIdentity(): void {
  if (loadIdentitySecret() === null) {
    throw new DvmError(
      "identity_required",
      "No builder identity found.",
      "Run `dvmctl identity create` once on this workstation, then re-run `dvmctl deploy`."
    );
  }
}

/**
 * Hash the declared manifest shape, accepting name arrays and detail objects.
 * Absence becomes an empty object; malformed declarations refuse rather than
 * silently hashing an unintended empty shape.
 */
export function readCapabilitiesForAttestation(cwd: string): JsonValue {
  const pkg = readPackageJson(cwd);
  const dvmkit = pkg?.dvmkit;
  if (dvmkit == null || typeof dvmkit !== "object") return {};
  const raw = (dvmkit as { capabilities?: unknown }).capabilities;
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object") {
    throw new DvmError(
      "invalid_capabilities",
      "`package.json#dvmkit.capabilities` must be an object or an array of capability names (or omitted).",
      "Remove the field, declare an array of capability names, or replace it with an object literal."
    );
  }
  return raw as JsonValue;
}

/**
 * Derive a URL-safe slug from the project.
 * Reads `name` from package.json, falls back to directory name.
 *
 * Lives here rather than in `deploy.ts` because deploy paths need a stable
 * human-readable display slug. Receipt identity derives from the platform or
 * self-hosted canonical DVM ID, never this mutable display value.
 */
export function deriveSlug(cwd: string): string {
  const raw = readPackageJson(cwd)?.name ?? basename(cwd);
  return slugify(raw);
}

/** Normalize and cap a display slug at 40 characters; minimum-length validation is separate. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.slice(0, 40).replace(/-$/, "");
}

/** Read and parse package.json from a directory. Returns null if missing or unparseable. */
export function readPackageJson(cwd: string): { name?: string; dvmkit?: unknown } | null {
  const pkgPath = resolve(cwd, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string; dvmkit?: unknown };
  } catch {
    return null;
  }
}

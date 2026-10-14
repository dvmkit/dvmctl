import {
  type BuilderLockKeypair,
  deriveBuilderLockKeypair,
  DvmError,
  type LockPubkey,
  toLockPubkey,
} from "@dvmkit/sdk/internal";

import {
  type BuilderDvmEntry,
  findBuilderDvmsByHandle,
  requireBuilderDvmByHandle,
  requireSelectedBuilderDvm,
} from "../../shared/builder-store.ts";
import { BUILDER_FILE } from "../../shared/defaults.ts";
import { readBuilderMnemonic } from "../builder-mnemonic.ts";
import { createDvmTransport } from "../transport/index.ts";

const DVM_INFO_PROBE_TIMEOUT_MS = 5_000;
const COMPRESSED_PUBKEY_PATTERN = /^0[23][0-9a-f]{64}$/i;

/**
 * A builder-owned self-hosted DVM's stable Cashu lock identity, derived from
 * the recovery mnemonic plus the `builder.json` entry for one local handle.
 * Pubkey only — this is what a serving process advertises on `/v1/info`.
 */
export interface BuilderLockIdentity {
  handle: string;
  /** The BIP-32 derivation input: the platform's `dvms.id` or a local UUIDv4. */
  canonicalDvmId: string;
  /** Newest published rotation index (`current_rotation_index`). */
  rotationIndex: number;
  /** 33-byte compressed secp256k1 pubkey, hex. */
  lockPubkey: string;
}

/**
 * The full keyring for a DVM selected by immutable ID: the current keypair
 * plus every historical rotation, keyed by lock pubkey. `dvmctl melt-pending`
 * signs admin challenges with the current one and witness-spends proofs locked
 * under a pre-rotation key still in the grace window with the rest.
 */
export interface BuilderLockKeyring {
  handle: string;
  canonicalDvmId: string;
  rotationIndex: number;
  /**
   * Keypair that signs admin-route challenges. Normally the newest recorded
   * rotation; endpoint disambiguation may select an older index when that is
   * the DVM's advertised current key.
   */
  currentKeypair: BuilderLockKeypair;
  /** Lock pubkey → keypair over `0..current_rotation_index`. */
  keypairsByPubkey: Map<LockPubkey, BuilderLockKeypair>;
}

/**
 * Resolve the lock pubkey a DVM should advertise for `handle`, without ever
 * materialising a privkey. Used by `dvmctl serve --dvm <handle>` so the DVM
 * advertises the same key its Cashu administration commands derive.
 */
export function resolveBuilderLockIdentity(handle: string): BuilderLockIdentity {
  const { mnemonic, canonicalDvmId, rotationIndex } = readBuilderContextByHandle(handle);
  return {
    handle,
    canonicalDvmId,
    rotationIndex,
    lockPubkey: deriveBuilderLockKeypair(mnemonic, canonicalDvmId, rotationIndex).pubkey,
  };
}

/**
 * Resolve every lock keypair for a platform DVM selected by immutable ID,
 * walking `0..current_rotation_index`. The map is bounded by the number of
 * rotations the operator has run, since every entry derives from one mnemonic
 * and canonical ID.
 */
export function resolveBuilderLockKeyring(dvmId: string): BuilderLockKeyring {
  return buildKeyring(readBuilderContext(dvmId));
}

/**
 * Resolve the full keyring for a DVM selected by its local handle — the only
 * selector available when the DVM is addressed directly rather than resolved
 * through the platform. When an endpoint is available, a same-handle store
 * ambiguity is settled only when exactly one candidate derives the DVM's
 * advertised current pubkey; probe failures, misses, and ties still refuse
 * (tracked change/tracked change).
 */
export async function resolveBuilderLockKeyringByHandle(
  handle: string,
  endpoint?: string
): Promise<BuilderLockKeyring> {
  const mnemonic = requireBuilderMnemonic();
  const resolved = await resolveBuilderEntryByHandle(handle, mnemonic, endpoint);
  return buildKeyring(
    {
      handle: resolved.entry.handle,
      mnemonic,
      canonicalDvmId: resolved.entry.canonical_dvm_id,
      rotationIndex: resolved.entry.current_rotation_index,
    },
    resolved.signingRotationIndex
  );
}

function buildKeyring(
  { handle, mnemonic, canonicalDvmId, rotationIndex }: BuilderContext,
  signingRotationIndex = rotationIndex
): BuilderLockKeyring {
  const keypairsByPubkey = new Map<LockPubkey, BuilderLockKeypair>();
  let currentKeypair: BuilderLockKeypair | undefined;
  for (let i = 0; i <= rotationIndex; i++) {
    const kp = deriveBuilderLockKeypair(mnemonic, canonicalDvmId, i);
    keypairsByPubkey.set(toLockPubkey(kp.pubkey), kp);
    if (i === signingRotationIndex) currentKeypair = kp;
  }
  if (!currentKeypair) {
    throw new Error("unreachable: signing rotation index walk produced no keypair");
  }

  return { handle, canonicalDvmId, rotationIndex, currentKeypair, keypairsByPubkey };
}

interface BuilderContext {
  handle: string;
  mnemonic: string;
  canonicalDvmId: string;
  rotationIndex: number;
}

interface ResolvedBuilderEntry {
  entry: BuilderDvmEntry;
  signingRotationIndex: number;
}

function readBuilderContext(dvmId: string): BuilderContext {
  const mnemonic = requireBuilderMnemonic();

  const entry = requireSelectedBuilderDvm(dvmId);

  return {
    handle: entry.handle,
    mnemonic,
    canonicalDvmId: entry.canonical_dvm_id,
    rotationIndex: entry.current_rotation_index,
  };
}

/**
 * Read the local state for a DVM selected by handle, which is the only
 * selector a caller has when it addresses the DVM directly instead of
 * resolving it through the platform. How the entry was recorded — a platform
 * deploy or a local `init` — does not change which keys it derives, so this
 * deliberately does not filter on `self_hosted`.
 */
function readBuilderContextByHandle(handle: string): BuilderContext {
  const mnemonic = requireBuilderMnemonic();

  const entry = requireBuilderDvmByHandle(handle);

  return {
    handle: entry.handle,
    mnemonic,
    canonicalDvmId: entry.canonical_dvm_id,
    rotationIndex: entry.current_rotation_index,
  };
}

function requireBuilderMnemonic(): string {
  const mnemonic = readBuilderMnemonic();
  if (!mnemonic) {
    throw new DvmError(
      "no_builder_mnemonic",
      "No builder mnemonic found.",
      "Run `dvmctl lock create` first to generate or import a mnemonic."
    );
  }
  return mnemonic;
}

/**
 * Resolve one handle record locally when possible. Only an existing
 * `ambiguous_dvm_handle` plus an explicit endpoint may trigger `/v1/info`:
 * the common path remains a local builder-store read, and a failed probe
 * rethrows the exact refusal it was trying to refine.
 */
async function resolveBuilderEntryByHandle(
  handle: string,
  mnemonic: string,
  endpoint: string | undefined
): Promise<ResolvedBuilderEntry> {
  let ambiguity: DvmError;
  try {
    const entry = requireBuilderDvmByHandle(handle);
    return { entry, signingRotationIndex: entry.current_rotation_index };
  } catch (err) {
    if (!(err instanceof DvmError) || err.code !== "ambiguous_dvm_handle" || !endpoint) {
      throw err;
    }
    ambiguity = err;
  }

  const advertised = await readAdvertisedCurrentLockPubkey(endpoint);
  if (!advertised) throw ambiguity;

  const candidates = findBuilderDvmsByHandle(handle);
  const matching = candidates.flatMap((entry) => {
    const signingRotationIndex = matchingRotationIndex(entry, mnemonic, advertised);
    return signingRotationIndex === undefined ? [] : [{ entry, signingRotationIndex }];
  });
  if (matching.length === 1) return matching[0];

  const candidateIds = candidates.map((entry) => entry.canonical_dvm_id);
  const matchingIds = matching.map(({ entry }) => entry.canonical_dvm_id);
  const diagnostic =
    matching.length === 0
      ? `None of your entries derive the key this DVM advertises (${advertised}) across their recorded rotation indexes.`
      : `${matching.length} of your entries derive the key this DVM advertises (${advertised}), so the endpoint cannot settle which record is right.`;
  throw new DvmError(
    "ambiguous_dvm_handle",
    ambiguity.message,
    `${diagnostic} Candidates: ${candidateIds.join(", ")}.${
      matchingIds.length > 0 ? ` Matching candidates: ${matchingIds.join(", ")}.` : ""
    } Restore the correct entry or rotation index in ${BUILDER_FILE}; nothing uses a guessed identity because the wrong keys would strand proofs.`,
    {
      advertised_lock_pubkey: advertised,
      candidates: candidateIds,
      matching_candidates: matchingIds,
    }
  );
}

async function readAdvertisedCurrentLockPubkey(endpoint: string): Promise<LockPubkey | undefined> {
  try {
    const provider = await createDvmTransport().describe(
      { endpoint: endpoint.replace(/\/+$/, "") },
      { timeoutMs: DVM_INFO_PROBE_TIMEOUT_MS }
    );
    const current = provider.cashu?.lock_pubkeys[0];
    return typeof current === "string" && COMPRESSED_PUBKEY_PATTERN.test(current.trim())
      ? toLockPubkey(current)
      : undefined;
  } catch {
    return undefined;
  }
}

function matchingRotationIndex(
  entry: BuilderDvmEntry,
  mnemonic: string,
  advertised: LockPubkey
): number | undefined {
  for (let i = 0; i <= entry.current_rotation_index; i++) {
    const derived = deriveBuilderLockKeypair(mnemonic, entry.canonical_dvm_id, i);
    if (toLockPubkey(derived.pubkey) === advertised) return i;
  }
  return undefined;
}

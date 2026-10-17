import { resolve } from "node:path";

import { DvmError, loadIdentitySecret } from "@dvmkit/sdk/internal";
import { type DVMHostOpts, serve as sdkServe } from "@dvmkit/sdk/server";

import {
  type BuilderLockIdentity,
  resolveBuilderLockIdentity,
} from "../../lib/cashu/builder-lock-identity.ts";
import {
  ATTESTATION_ENV_KEYS,
  attestationEnv,
  type DeployAttestation,
  readCapabilitiesForAttestation,
  signDeployAttestation,
} from "../../lib/deploy-attestation.ts";
import { blockUntilShutdown } from "../../lib/keep-alive.ts";
import { loadDescriptor } from "../../lib/load-handler.ts";
import { loadIdentityPubkey, requireBuilderDvmByHandle } from "../../shared/builder-store.ts";

export interface BuilderServeOptions {
  port?: string;
  /**
   * Builder handle to serve under. Binds the process to
   * the identity recorded in `~/.dvmkit` for that handle, on two axes:
   *
   * - the **lock identity** — the DVM advertises the Cashu pubkey derived from
   *   the builder's recovery mnemonic, and `dvmctl melt-pending <handle>`
   *   derives the matching privkey. Without configured mints, a missing
   *   mnemonic leaves this axis unset;
   * - the **receipt identity** — the DVM signs receipts under the key
   *   `dvmctl deploy` would derive for this canonical DVM ID, and serves the attestation
   *   binding it, so a caller can chain a receipt to the builder's cold key.
   *
   * Without it a self-hosted DVM has `DVMKIT_CASHU_LOCK_PUBKEY` and
   * `DVMKIT_DVM_ID` wired by hand, nothing checks that the two sides agree, and
   * its receipts (if it issues any) chain to nothing.
   */
  dvm?: string;
}

export async function builderServe(handlerPath: string, opts: BuilderServeOptions): Promise<void> {
  const absPath = resolve(process.cwd(), handlerPath);
  const descriptor = await loadDescriptor(absPath);
  const dvm = opts.dvm ? requireBuilderDvmByHandle(opts.dvm) : undefined;
  const identity = opts.dvm ? resolveServeLockIdentity(opts.dvm, process.env) : undefined;
  const attestation = opts.dvm
    ? resolveServeAttestation(
        process.cwd(),
        opts.dvm,
        dvm?.canonical_dvm_id,
        process.env as Record<string, string>
      )
    : undefined;
  const serveOpts = buildServeOpts(
    process.env as Record<string, string>,
    opts,
    identity,
    attestation
  );
  assertProductionDatabase(serveOpts);

  const { url, close } = await sdkServe(descriptor, serveOpts);
  console.log(`Serving ${descriptor.name} at ${url}`);
  if (identity) {
    console.log(`  lock identity: ${identity.handle} (rotation ${identity.rotationIndex})`);
    console.log(`  lock pubkey:   ${identity.lockPubkey}`);
  }
  if (attestation) {
    console.log(`  attested dvm id: ${attestation.payload.dvm_id}`);
    console.log(`  attested slug: ${attestation.payload.slug}`);
    console.log(`  receipt key:   ${attestation.payload.receipt_pubkey ?? "(none)"}`);
  } else if (opts.dvm) {
    console.log("  receipts:      unattested (see the note above)");
  }

  // Keep serving until Ctrl-C / SIGTERM.
  await blockUntilShutdown(() => ({ close }));
}

function resolveServeLockIdentity(
  handle: string,
  env: NodeJS.ProcessEnv
): BuilderLockIdentity | undefined {
  try {
    return resolveBuilderLockIdentity(handle);
  } catch (err) {
    // Receipt attestation needs the durable DVM ID, not Cashu recovery words.
    // Match the SDK's mint-configured gate so a Cashu boot still refuses.
    if (err instanceof DvmError && err.code === "no_builder_mnemonic" && !env.DVMKIT_CASHU_MINTS) {
      return undefined;
    }
    throw err;
  }
}

/**
 * `dvmctl serve` is the production entry point: unlike `dvmctl dev`, it never
 * supplies an ephemeral store. Fail in the CLI so the structured error keeps
 * its action and does not become the generic redacted unknown-error response.
 */
export function assertProductionDatabase(opts: DVMHostOpts): void {
  if (opts.database) return;
  throw new DvmError(
    "production_database_required",
    "Production serving requires a Postgres database.",
    "Set DATABASE_URL to a Postgres connection string, or use `dvmctl dev` for local development."
  );
}

export function buildServeOpts(
  env: Record<string, string>,
  opts?: { port?: string },
  identity?: BuilderLockIdentity,
  attestation?: DeployAttestation
): DVMHostOpts {
  const result: DVMHostOpts = {};

  const port = opts?.port ?? env.PORT;
  if (port) result.port = Number(port);

  if (env.DATABASE_URL) result.database = env.DATABASE_URL;

  const mintsRaw = (env as Record<string, string | undefined>).DVMKIT_CASHU_MINTS;
  if (mintsRaw) {
    result.mints = mintsRaw.split(",").map((m) => m.trim());
  }

  let serveEnv = env;
  if (identity) serveEnv = withLockIdentity(serveEnv, identity);
  if (attestation) serveEnv = { ...serveEnv, ...attestationEnv(attestation) };
  result.env = serveEnv;

  return result;
}

/**
 * Which of the attestation env vars this boot already carries.
 *
 * Non-empty means the operator has wired an attestation themselves — most
 * likely from `dvmctl deploy --target self-host`, which prints all four — and
 * `serve --dvm` must not derive over the top of it. Exported for testing.
 */
export function attestationEnvOccupied(env: Record<string, string>): string[] {
  return ATTESTATION_ENV_KEYS.filter((key) => env[key]);
}

/**
 * Sign the attestation this boot should serve, or return `undefined` to leave
 * the environment as it stands.
 *
 * `dvmctl deploy` binds a per-DVM-ID receipt key into the attestation it hands
 * the platform, and provisions the matching secret onto the container. A local
 * or self-hosted `serve` has no deploy pipeline in front of it, but it *does*
 * have the builder identity on disk and the same one-way derivation — so it can
 * establish both halves itself, and the pubkey it attests is provably the one
 * it signs under because a single call produced them.
 *
 * The identity secret is read here, in the CLI, and never crosses into the
 * server's environment; only the derived receipt secret does.
 *
 * **All-or-nothing.** A boot that already carries any identity-attestation var is left
 * alone: `dvmctl deploy --target self-host` prints an attestation stamped with
 * its own `deployed_at`, so a freshly-signed one would never byte-match a
 * correctly-wired operator's, and refusing on that would break a working boot.
 * The dangerous outcome is a *partial* overlay — a derived receipt key under
 * somebody else's attestation signs receipts that verify as `invalid`, and an
 * `invalid` receipt is filtered out of the caller's trust ladder, so the visible
 * symptom is "credits never open" with nothing pointing at the cause.
 */
function resolveServeAttestation(
  cwd: string,
  handle: string,
  dvmId: string | undefined,
  env: Record<string, string>
): DeployAttestation | undefined {
  const occupied = attestationEnvOccupied(env);
  if (occupied.length > 0) {
    console.log(
      `  note: ${occupied.join(", ")} already set — serving the environment's attestation, not deriving one for --dvm ${handle}.`
    );
    return undefined;
  }

  const secret = loadIdentitySecret();
  const pubkey = loadIdentityPubkey();
  if (!secret || !pubkey) {
    console.log(
      `  note: no builder identity on disk, so this DVM's receipts will be unattested. Run 'dvmctl identity create' to have --dvm ${handle} derive and attest a receipt key.`
    );
    return undefined;
  }
  if (!dvmId) {
    throw new DvmError(
      "durable_dvm_identity_required",
      `No durable DVM ID is recorded for "${handle}".`,
      "Run `dvmctl init <handle> --self-hosted` before serving receipts, then retry."
    );
  }

  return signDeployAttestation({
    builderSecret: secret,
    builderPubkey: pubkey,
    dvmId,
    slug: handle,
    capabilities: readCapabilitiesForAttestation(cwd),
    withReceiptKey: true,
  });
}

/**
 * Overlay the derived lock identity onto the serve environment.
 *
 * All three vars move together on purpose. `resolveCashuOptsFromEnv` reads
 * `DVMKIT_DVM_ID` into the id the admin routes verify challenges against,
 * while `dvmctl melt-pending` signs with `builder.json`'s `canonical_dvm_id` —
 * let those two diverge and every admin call 401s with `bad_signature`, which
 * leaves the accumulator unmeltable and owed refunds unparked. Deriving all
 * three from one source is what makes "the key the DVM advertises is the key
 * the builder holds" checkable rather than conventional.
 *
 * Only the pubkey crosses into the server's environment; the privkey is never
 * read on this path, so the SDK's refusal to boot with `BUILDER_LOCK_PRIVKEY`
 * set stays intact.
 */
function withLockIdentity(
  env: Record<string, string>,
  identity: BuilderLockIdentity
): Record<string, string> {
  assertNoConflict(env, "DVMKIT_CASHU_LOCK_PUBKEY", identity.lockPubkey, identity);
  assertNoConflict(env, "DVMKIT_DVM_ID", identity.canonicalDvmId, identity);
  assertNoConflict(env, "DVMKIT_CANONICAL_DVM_ID", identity.canonicalDvmId, identity);

  return {
    ...env,
    DVMKIT_CASHU_LOCK_PUBKEY: identity.lockPubkey,
    DVMKIT_DVM_ID: identity.canonicalDvmId,
    DVMKIT_CANONICAL_DVM_ID: identity.canonicalDvmId,
  };
}

/**
 * Refuse a conflicting environment value rather than silently overriding it —
 * serving under a key the operator didn't expect is the exact failure `--dvm`
 * exists to prevent.
 */
function assertNoConflict(
  env: Record<string, string>,
  key: string,
  derived: string,
  identity: BuilderLockIdentity
): void {
  const existing = env[key];
  if (!existing || existing.toLowerCase() === derived.toLowerCase()) return;
  throw new DvmError(
    "lock_identity_conflict",
    `${key} is set to "${existing}", but --dvm ${identity.handle} derives "${derived}".`,
    `Unset ${key} to serve under the builder-store identity, or drop --dvm to serve under the environment's.`
  );
}

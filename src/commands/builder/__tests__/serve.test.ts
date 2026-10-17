import type * as SdkInternal from "@dvmkit/sdk/internal";
import { deriveBuilderLockKeypair, deriveReceiptKeypair, DvmError, generateIdentity, loadIdentitySecret, receiptPubkeyFromSecret, verifyAttestation } from "@dvmkit/sdk/internal";
import type * as SdkServerModule from "@dvmkit/sdk/server";
import { serve as sdkServe } from "@dvmkit/sdk/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readBuilderMnemonic } from "../../../lib/builder-mnemonic";
import type { BuilderLockIdentity } from "../../../lib/cashu/builder-lock-identity";
import { ATTESTATION_ENV_KEYS, signDeployAttestation } from "../../../lib/deploy-attestation";
import { loadDescriptor } from "../../../lib/load-handler";
import { loadIdentityPubkey, requireBuilderDvmByHandle } from "../../../shared/builder-store";
import {
  assertProductionDatabase,
  attestationEnvOccupied,
  builderServe,
  buildServeOpts,
} from "../serve";

vi.mock("@dvmkit/sdk/server", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkServerModule>()),
  serve: vi.fn(),
}));

vi.mock("../../../lib/load-handler", () => ({ loadDescriptor: vi.fn() }));
vi.mock("../../../lib/keep-alive", () => ({ blockUntilShutdown: vi.fn() }));
vi.mock("../../../lib/builder-mnemonic", () => ({ readBuilderMnemonic: vi.fn() }));
vi.mock("../../../shared/builder-store", () => ({
  loadIdentityPubkey: vi.fn(),
  requireBuilderDvmByHandle: vi.fn(),
}));
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkInternal>()),
  loadIdentitySecret: vi.fn(),
}));

describe("builderServe identity resolution", () => {
  const builder = generateIdentity();

  beforeEach(() => {
    for (const key of [...ATTESTATION_ENV_KEYS, "DVMKIT_CASHU_MINTS", "DVMKIT_CASHU_LOCK_PUBKEY"]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("DATABASE_URL", "postgres://localhost/dvm");
    vi.mocked(loadDescriptor).mockResolvedValue({ name: "example" } as never);
    vi.mocked(sdkServe).mockResolvedValue({ url: "http://localhost:8080", close: vi.fn(), paymentModes: [] });
    vi.mocked(readBuilderMnemonic).mockReturnValue(null);
    vi.mocked(loadIdentitySecret).mockReturnValue(builder.secret);
    vi.mocked(loadIdentityPubkey).mockReturnValue(builder.pubkey);
    vi.mocked(requireBuilderDvmByHandle).mockReturnValue({
      handle: "my-dvm",
      canonical_dvm_id: identityFixture.canonicalDvmId,
      current_rotation_index: 0,
      self_hosted: true,
      updated_at: "2026-07-30T00:00:00.000Z",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("attests the durable receipt identity without a Cashu mnemonic", async () => {
    await builderServe("handler.ts", { dvm: "my-dvm" });

    expect(sdkServe).toHaveBeenCalledOnce();
    const env = envOf(vi.mocked(sdkServe).mock.calls[0][1]!);
    const payload = JSON.parse(env.DVMKIT_BUILDER_ATTESTATION);
    expect(payload.dvm_id).toBe(identityFixture.canonicalDvmId);
    expect(payload.slug).toBe("my-dvm");
    expect(env.DVMKIT_DVM_ID).toBe(identityFixture.canonicalDvmId);
    expect(env.DVMKIT_CANONICAL_DVM_ID).toBe(identityFixture.canonicalDvmId);
    expect(env.DVMKIT_BUILDER_PUBKEY).toBe(builder.pubkey);
    expect(verifyAttestation(payload, env.DVMKIT_BUILDER_SIGNATURE, builder.pubkey)).toBe(true);
    expect(receiptPubkeyFromSecret(env.DVMKIT_RECEIPT_KEY)).toBe(payload.receipt_pubkey);
    expect(env.DVMKIT_CASHU_LOCK_PUBKEY).toBeUndefined();
    expect(Object.values(env)).not.toContain(builder.secret);
  });

  it.each(["https://mint.example", " "])("refuses missing recovery words when mints are configured as %j", async (mints) => {
    vi.stubEnv("DVMKIT_CASHU_MINTS", mints);
    await expect(builderServe("handler.ts", { dvm: "my-dvm" })).rejects.toMatchObject({
      code: "no_builder_mnemonic",
      hint: expect.stringContaining("dvmctl lock create"),
    });
    expect(sdkServe).not.toHaveBeenCalled();
  });

  it("still derives the lock identity when recovery words exist", async () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    vi.mocked(readBuilderMnemonic).mockReturnValue(mnemonic);
    vi.stubEnv("DVMKIT_CASHU_MINTS", "https://mint.example");
    await builderServe("handler.ts", { dvm: "my-dvm" });
    const env = envOf(vi.mocked(sdkServe).mock.calls[0][1]!);
    expect(env.DVMKIT_CASHU_LOCK_PUBKEY).toBe(
      deriveBuilderLockKeypair(mnemonic, identityFixture.canonicalDvmId, 0).pubkey
    );
    expect(JSON.parse(env.DVMKIT_BUILDER_ATTESTATION).dvm_id).toBe(env.DVMKIT_DVM_ID);
  });

  it.each(["dvm_not_initialized", "ambiguous_dvm_handle"])("preserves the store's %s refusal without recovery words", async (code) => {
    const failure = new DvmError(code, "No unique durable DVM identity.");
    vi.mocked(requireBuilderDvmByHandle).mockImplementation(() => { throw failure; });
    await expect(builderServe("handler.ts", { dvm: "my-dvm" })).rejects.toBe(failure);
    expect(sdkServe).not.toHaveBeenCalled();
  });

  it.each(ATTESTATION_ENV_KEYS)("leaves the entire attestation overlay alone when %s is set", async (key) => {
    vi.stubEnv(key, "operator-supplied");
    await builderServe("handler.ts", { dvm: "my-dvm" });
    const env = envOf(vi.mocked(sdkServe).mock.calls[0][1]!);
    for (const field of ATTESTATION_ENV_KEYS) {
      expect(env[field]).toBe(field === key ? "operator-supplied" : undefined);
    }
  });

  it("does not suppress unexpected recovery-material read failures", async () => {
    const failure = new Error("cannot read recovery material");
    vi.mocked(readBuilderMnemonic).mockImplementation(() => { throw failure; });
    await expect(builderServe("handler.ts", { dvm: "my-dvm" })).rejects.toBe(failure);
    expect(sdkServe).not.toHaveBeenCalled();
  });
});

describe("buildServeOpts", () => {
  it("maps port, database, and mints while preserving the manual environment", () => {
    const env = {
      PORT: "9090",
      DATABASE_URL: "postgres://localhost/mydb",
      DVMKIT_CASHU_MINTS: "https://mint1.com, https://mint2.com",
      DVMKIT_CASHU_LOCK_PUBKEY: `03${"cd".repeat(32)}`,
      CUSTOM: "value",
    };
    const opts = buildServeOpts(env);
    expect(opts).toEqual({
      port: 9090,
      database: "postgres://localhost/mydb",
      mints: ["https://mint1.com", "https://mint2.com"],
      env,
    });
    expect(opts.env).toBe(env);
  });

  it("prefers --port flag over env", () => {
    const opts = buildServeOpts({ PORT: "9090" }, { port: "3000" });
    expect(opts.port).toBe(3000);
  });

  it("returns empty opts for empty env", () => {
    const opts = buildServeOpts({});
    expect(opts.port).toBeUndefined();
    expect(opts.database).toBeUndefined();
    expect(opts.mints).toBeUndefined();
  });
});

describe("production database requirement", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("gives an actionable structured error before asking the SDK to bind", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.mocked(loadDescriptor).mockResolvedValue({ name: "example" } as never);

    await expect(builderServe("handler.ts", {})).rejects.toMatchObject({
      code: "production_database_required",
      message: "Production serving requires a Postgres database.",
      hint: "Set DATABASE_URL to a Postgres connection string, or use `dvmctl dev` for local development.",
    });
    expect(loadDescriptor).toHaveBeenCalledOnce();
    expect(sdkServe).not.toHaveBeenCalled();
  });

  it("allows a configured database through to the production server", () => {
    expect(() => assertProductionDatabase({ database: "postgres://localhost/dvm" })).not.toThrow();
  });
});

/**
 * `--dvm <handle>` binds the serving process to the builder store's
 * lock identity. The three vars move together — a DVM whose `DVMKIT_DVM_ID`
 * differs from the `canonical_dvm_id` `melt-pending` signs with 401s on every
 * admin call, which is how owed refunds go unparked.
 */
describe("buildServeOpts with a builder lock identity", () => {
  const identity: BuilderLockIdentity = {
    handle: "my-dvm",
    canonicalDvmId: "11111111-2222-3333-4444-555555555555",
    rotationIndex: 0,
    lockPubkey: `02${"ab".repeat(32)}`,
  };

  it("injects the lock pubkey and both id vars from one derivation", () => {
    const opts = buildServeOpts({ PORT: "9877" }, {}, identity);
    expect(opts.env).toMatchObject({
      PORT: "9877",
      DVMKIT_CASHU_LOCK_PUBKEY: identity.lockPubkey,
      DVMKIT_DVM_ID: identity.canonicalDvmId,
      DVMKIT_CANONICAL_DVM_ID: identity.canonicalDvmId,
    });
  });

  it("accepts a matching env value regardless of hex case", () => {
    const env = { DVMKIT_CASHU_LOCK_PUBKEY: identity.lockPubkey.toUpperCase() };
    expect(buildServeOpts(env, {}, identity).env).toMatchObject({
      DVMKIT_CASHU_LOCK_PUBKEY: identity.lockPubkey,
    });
  });

  it("refuses a conflicting lock pubkey rather than overriding it", () => {
    expect(() =>
      buildServeOpts({ DVMKIT_CASHU_LOCK_PUBKEY: `03${"cd".repeat(32)}` }, {}, identity)
    ).toThrow(/lock_identity_conflict|DVMKIT_CASHU_LOCK_PUBKEY is set/);
  });

  it("refuses a conflicting DVM id — the admin challenge would never verify", () => {
    expect(() => buildServeOpts({ DVMKIT_DVM_ID: "some-other-id" }, {}, identity)).toThrow(
      /DVMKIT_DVM_ID is set/
    );
  });
});

/**
 * `--dvm <handle>` also boots the DVM *attested* — it signs receipts
 * under the key `dvmctl deploy` would derive for that slug, and serves the
 * attestation binding it. Without this, a locally-served DVM's receipts chain
 * to nothing and links 2–3 of the trust chain have no environment that
 * exercises them.
 */
describe("buildServeOpts with a builder attestation", () => {
  const builder = generateIdentity();
  const attestation = signDeployAttestation({
    builderSecret: builder.secret,
    builderPubkey: builder.pubkey,
    dvmId: "11111111-2222-3333-4444-555555555555",
    slug: "my-dvm",
    capabilities: ["count"],
    withReceiptKey: true,
  });

  it("overlays all four vars, so /v1/info#builder resolves and the key it attests is served", () => {
    const env = envOf(buildServeOpts({ PORT: "9877" }, {}, undefined, attestation));
    expect(env.PORT).toBe("9877");
    expect(env.DVMKIT_BUILDER_PUBKEY).toBe(builder.pubkey);
    expect(env.DVMKIT_BUILDER_SIGNATURE).toBe(attestation.signature);
    expect(env.DVMKIT_RECEIPT_KEY).toBe(
      deriveReceiptKeypair(builder.secret, "11111111-2222-3333-4444-555555555555").secret
    );

    const payload = JSON.parse(env.DVMKIT_BUILDER_ATTESTATION) as Parameters<
      typeof verifyAttestation
    >[0];
    expect(payload.dvm_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(payload.receipt_pubkey).toBe(
      deriveReceiptKeypair(builder.secret, "11111111-2222-3333-4444-555555555555").pubkey
    );
    expect(
      verifyAttestation(payload, env.DVMKIT_BUILDER_SIGNATURE, env.DVMKIT_BUILDER_PUBKEY)
    ).toBe(true);
  });

  it("composes with the lock identity — both overlays land", () => {
    const env = envOf(buildServeOpts({}, {}, identityFixture, attestation));
    expect(env.DVMKIT_CASHU_LOCK_PUBKEY).toBe(identityFixture.lockPubkey);
    expect(env.DVMKIT_BUILDER_PUBKEY).toBe(builder.pubkey);
  });

  /**
   * All-or-nothing: a partial overlay is the dangerous outcome. A derived
   * receipt key under somebody else's attestation signs receipts that verify as
   * `invalid`, which the caller's trust ladder filters out — so the visible
   * symptom is "credits never open", with nothing pointing at the cause.
   */
  it.each([
    "DVMKIT_BUILDER_PUBKEY",
    "DVMKIT_BUILDER_ATTESTATION",
    "DVMKIT_BUILDER_SIGNATURE",
    "DVMKIT_RECEIPT_KEY",
  ])("reports %s as an occupied attestation field", (key) => {
    expect(attestationEnvOccupied({ [key]: "already-set" })).toEqual([key]);
  });

  it("reports nothing occupied on a bare environment", () => {
    expect(attestationEnvOccupied({ PORT: "8080" })).toEqual([]);
  });
});

/** The overlaid env, narrowed — `buildServeOpts` always sets it. */
function envOf(opts: ReturnType<typeof buildServeOpts>): Record<string, string> {
  if (!opts.env) throw new Error("buildServeOpts returned no env");
  return opts.env;
}

const identityFixture: BuilderLockIdentity = {
  handle: "my-dvm",
  canonicalDvmId: "11111111-2222-3333-4444-555555555555",
  rotationIndex: 0,
  lockPubkey: `02${"ab".repeat(32)}`,
};

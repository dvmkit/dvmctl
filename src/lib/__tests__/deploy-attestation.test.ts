import {
  type AttestationPayload,
  deriveReceiptKeypair,
  generateIdentity,
  receiptPubkeyFromSecret,
  verifyAttestation,
} from "@dvmkit/sdk/internal";
import { describe, expect, it } from "vitest";

import { ATTESTATION_ENV_KEYS, attestationEnv, signDeployAttestation } from "../deploy-attestation";

const { secret: BUILDER_SECRET, pubkey: BUILDER_PUBKEY } = generateIdentity();

function sign(overrides: Partial<Parameters<typeof signDeployAttestation>[0]> = {}) {
  return signDeployAttestation({
    builderSecret: BUILDER_SECRET,
    builderPubkey: BUILDER_PUBKEY,
    dvmId: "dvm-my-dvm",
    slug: "my-dvm",
    capabilities: ["count"],
    ...overrides,
  });
}

describe("signDeployAttestation", () => {
  it("signs a payload that verifies under the builder pubkey", () => {
    const attestation = sign();
    expect(attestation.identityPubkey).toBe(BUILDER_PUBKEY);
    expect(attestation.payload.receipt_pubkey).toBeUndefined();
    expect(attestation.receiptSecret).toBeUndefined();
    expect(verifyAttestation(attestation.payload, attestation.signature, BUILDER_PUBKEY)).toBe(
      true
    );
  });

  it("binds exactly the pubkey deriveReceiptKeypair produces for that DVM ID", () => {
    const attestation = sign({ withReceiptKey: true });
    const expected = deriveReceiptKeypair(BUILDER_SECRET, "dvm-my-dvm");
    expect(attestation.payload.receipt_pubkey).toBe(expected.pubkey);
    expect(attestation.receiptSecret).toBe(expected.secret);
    expect(receiptPubkeyFromSecret(attestation.receiptSecret ?? "")).toBe(expected.pubkey);
  });

  it("derives a different receipt key per DVM ID, even for the same slug", () => {
    expect(sign({ dvmId: "dvm-a", withReceiptKey: true }).payload.receipt_pubkey).not.toBe(
      sign({ dvmId: "dvm-b", withReceiptKey: true }).payload.receipt_pubkey
    );
  });

  it("re-derives identically, so a restart never rotates the key", () => {
    expect(sign({ withReceiptKey: true }).receiptSecret).toBe(
      sign({ withReceiptKey: true }).receiptSecret
    );
  });
});

describe("attestationEnv", () => {
  it("round-trips the payload through the JSON string the SDK parses", () => {
    const attestation = sign({ withReceiptKey: true });
    const env = attestationEnv(attestation);
    expect(Object.keys(env).sort()).toEqual([...ATTESTATION_ENV_KEYS].sort());

    expect(env.DVMKIT_BUILDER_PUBKEY).toBe(BUILDER_PUBKEY);
    expect(env.DVMKIT_BUILDER_SIGNATURE).toBe(attestation.signature);
    expect(env.DVMKIT_DVM_ID).toBe("dvm-my-dvm");
    expect(env.DVMKIT_CANONICAL_DVM_ID).toBe("dvm-my-dvm");
    expect(env.DVMKIT_RECEIPT_KEY).toBe(attestation.receiptSecret);

    const parsed = JSON.parse(env.DVMKIT_BUILDER_ATTESTATION) as AttestationPayload;
    expect(parsed).toEqual(attestation.payload);
    // Verifying the *parsed* payload is the real assertion: a caller only ever
    // sees the round-tripped form off `/v1/info`.
    expect(verifyAttestation(parsed, env.DVMKIT_BUILDER_SIGNATURE, env.DVMKIT_BUILDER_PUBKEY)).toBe(
      true
    );
  });

  it("omits the secret when no receipt key was bound", () => {
    const env = attestationEnv(sign());
    expect(env.DVMKIT_RECEIPT_KEY).toBeUndefined();
    expect(Object.keys(env)).toHaveLength(5);
  });

});

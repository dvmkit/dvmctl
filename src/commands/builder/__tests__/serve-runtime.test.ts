import { configureDVM } from "@dvmkit/sdk";
import type * as SdkInternal from "@dvmkit/sdk/internal";
import { generateIdentity, verifyAttestation, verifyReceipt } from "@dvmkit/sdk/internal";
import type * as SdkServer from "@dvmkit/sdk/server";
import { serve as sdkServe } from "@dvmkit/sdk/server";
import { MemoryJobStore } from "@dvmkit/sdk/testing";
import { afterEach, expect, it, vi } from "vitest";

import { readBuilderMnemonic } from "../../../lib/builder-mnemonic";
import { ATTESTATION_ENV_KEYS } from "../../../lib/deploy-attestation";
import { loadDescriptor } from "../../../lib/load-handler";
import { loadIdentityPubkey, requireBuilderDvmByHandle } from "../../../shared/builder-store";
import { builderServe } from "../serve";

vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkInternal>()),
  loadIdentitySecret: vi.fn(),
}));
vi.mock("@dvmkit/sdk/server", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkServer>()),
  serve: vi.fn(),
}));
vi.mock("../../../lib/load-handler", () => ({ loadDescriptor: vi.fn() }));
vi.mock("../../../lib/keep-alive", () => ({ blockUntilShutdown: vi.fn() }));
vi.mock("../../../lib/builder-mnemonic", () => ({ readBuilderMnemonic: vi.fn() }));
vi.mock("../../../shared/builder-store", () => ({
  loadIdentityPubkey: vi.fn(),
  requireBuilderDvmByHandle: vi.fn(),
}));

afterEach(() => { vi.unstubAllEnvs(); });

it("serves a builder attestation and chaining job receipt without Cashu recovery words", async () => {
  const builder = generateIdentity();
  const dvmId = "11111111-2222-4333-8444-555555555555";
  const { loadIdentitySecret } = await import("@dvmkit/sdk/internal");
  vi.mocked(loadIdentitySecret).mockReturnValue(builder.secret);
  vi.mocked(loadIdentityPubkey).mockReturnValue(builder.pubkey);
  vi.mocked(readBuilderMnemonic).mockReturnValue(null);
  vi.mocked(requireBuilderDvmByHandle).mockReturnValue({
    handle: "my-dvm", canonical_dvm_id: dvmId, current_rotation_index: 0,
    self_hosted: true, updated_at: "2026-07-30T00:00:00.000Z",
  });
  vi.mocked(loadDescriptor).mockResolvedValue(configureDVM({
    name: "example", description: "Complete a free job", capability: "echo",
    async onJob(ctx) { ctx.complete("hello"); },
  }));
  for (const key of [...ATTESTATION_ENV_KEYS, "DVMKIT_CASHU_MINTS", "DVMKIT_CASHU_LOCK_PUBKEY"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("DATABASE_URL", "postgres://localhost/dvm");
  vi.spyOn(console, "log").mockImplementation(() => {});

  const actual = await vi.importActual<typeof SdkServer>("@dvmkit/sdk/server");
  let server: SdkServer.DVMServeResult | undefined;
  vi.mocked(sdkServe).mockImplementation(async (descriptor, opts) => {
    // Replace only persistence; the SDK consumes the CLI's attestation env and
    // issues the receipt through its real HTTP and terminal-job paths.
    server = await actual.serve(descriptor, { ...opts, port: 0, jobStore: new MemoryJobStore() });
    return server;
  });
  try {
    await builderServe("handler.ts", { dvm: "my-dvm" });
    expect(server).toBeDefined();
    const endpoint = server!.url;
    const infoResponse = await fetch(`${endpoint}/v1/info`);
    expect(infoResponse.status).toBe(200);
    const info = await infoResponse.json();
    expect(info.builder.pubkey).toBe(builder.pubkey);
    expect(info.builder.attestation.dvm_id).toBe(dvmId);
    expect(verifyAttestation(info.builder.attestation, info.builder.signature, builder.pubkey)).toBe(true);
    expect(info.receipts).toBe(true);

    const response = await fetch(`${endpoint}/v1/job`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ capability: "echo", data: "hello" }),
    });
    expect(response.status).toBe(200);
    const job = await response.json();
    expect(job.status).toBe("completed");
    expect(job.summary).toBe("hello");
    expect(verifyReceipt(job.receipt)).toBe(true);
    expect(job.receipt.receipt_pubkey).toBe(info.builder.attestation.receipt_pubkey);
    expect(job.receipt.dvm_id).toBe(dvmId);
  } finally {
    await server?.close();
  }
});

import { buildAdminChallenge, DvmError, verifyChallenge } from "@dvmkit/sdk/internal";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";

import { AdminApiError, AdminCashuClient } from "../admin-cashu-client";

const PRIVKEY = "11".repeat(32);
const PUBKEY = Buffer.from(schnorr.getPublicKey(hexToBytes(PRIVKEY))).toString("hex");

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AdminCashuClient", () => {
  it("signs GET /admin/cashu/pending-batches and parses the batches array", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(200, {
        batches: [
          {
            mint_url: "https://mint.example",
            lock_pubkey: PUBKEY,
            row_ids: ["r1"],
            proofs: [{ id: "k1", amount: 10, secret: "s", C: "c" }],
            total_sats: 10,
            t_expire: null,
          },
        ],
      })
    );

    const client = new AdminCashuClient({
      endpoint: "https://dvm.example/",
      dvmId: "dvm-fixture-1",
      privkeyHex: PRIVKEY,
      fetchImpl,
    });

    const res = await client.getPendingBatches();
    expect(res.batches).toHaveLength(1);
    expect(res.batches[0].row_ids).toEqual(["r1"]);

    // Inspect what we sent.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dvm.example/admin/cashu/pending-batches");
    expect(init.method).toBe("GET");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth.startsWith("P2PK ")).toBe(true);
    const [nonce, ts, sig] = auth.slice(5).split(".");
    const digest = buildAdminChallenge({
      method: "GET",
      path: "/admin/cashu/pending-batches",
      dvmId: "dvm-fixture-1",
      nonceHex: nonce,
      unixSeconds: ts,
    });
    expect(verifyChallenge(PUBKEY, digest, sig)).toBe(true);
  });

  it("signs POST /admin/cashu/mark-melted and sends a JSON body", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(200, { melted: 2 }));
    const client = new AdminCashuClient({
      endpoint: "https://dvm.example",
      dvmId: "dvm-fixture-1",
      privkeyHex: PRIVKEY,
      fetchImpl,
    });
    const res = await client.markMelted({
      row_ids: ["r1", "r2"],
      melt_quote_id: "q1",
      payment_preimage: "abc",
    });
    expect(res.melted).toBe(2);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dvm.example/admin/cashu/mark-melted");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      row_ids: ["r1", "r2"],
      melt_quote_id: "q1",
      payment_preimage: "abc",
    });
  });

  it("throws AdminApiError with isBadSignature on 401 bad_signature", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized", reason: "bad_signature" }));
    const client = new AdminCashuClient({
      endpoint: "https://dvm.example",
      dvmId: "dvm-fixture-1",
      privkeyHex: PRIVKEY,
      fetchImpl,
    });
    try {
      await client.getPendingBatches();
      expect.fail("expected AdminApiError");
    } catch (err) {
      expect(err).toBeInstanceOf(AdminApiError);
      const e = err as AdminApiError;
      expect(e.status).toBe(401);
      expect(e.body.reason).toBe("bad_signature");
      expect(e.isBadSignature).toBe(true);
    }
  });

  it("retains the DVM's structured operator copy on an admin refusal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(409, {
        error: "drain_conflict",
        message: "Tempo close refunded 0 for a drain requiring at least 20000",
        hint: "Write off the drain after making good the shortfall out of band.",
        display: "The close paid less than the ledger extinguished.",
      })
    );
    const client = new AdminCashuClient({
      endpoint: "https://dvm.example",
      dvmId: "dvm-fixture-1",
      privkeyHex: PRIVKEY,
      fetchImpl,
    });

    await expect(client.getPendingBatches()).rejects.toMatchObject({
      status: 409,
      body: {
        error: "drain_conflict",
        message: "Tempo close refunded 0 for a drain requiring at least 20000",
        hint: "Write off the drain after making good the shortfall out of band.",
        display: "The close paid less than the ledger extinguished.",
      },
    });
  });

  it("maps unavailable admin state to retry and database-health guidance", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(503, {
        error: "admin_state_unavailable",
        message: "server copy is not trusted as CLI guidance",
      })
    );
    const client = new AdminCashuClient({
      endpoint: "https://dvm.example",
      dvmId: "dvm-fixture-1",
      privkeyHex: PRIVKEY,
      fetchImpl,
    });

    try {
      await client.getPendingBatches();
      expect.fail("expected DvmError");
    } catch (err) {
      expect(err).toBeInstanceOf(DvmError);
      const dvmError = err as DvmError;
      expect(dvmError.code).toBe("admin_state_unavailable");
      expect(dvmError.message).toContain("requested DVM operation did not run");
      expect(dvmError.hint).toContain("Retry the same command");
      expect(dvmError.hint).toContain("database health");
      expect(dvmError.hint).toContain("restart the DVM");
      expect(dvmError.hint).toContain("Do not rotate or replace the lock key");
    }
  });

  it("surfaces non-JSON 5xx responses as admin_invalid_json", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("<html>500</html>", { status: 500 }));
    const client = new AdminCashuClient({
      endpoint: "https://dvm.example",
      dvmId: "d",
      privkeyHex: PRIVKEY,
      fetchImpl,
    });
    await expect(client.getPendingBatches()).rejects.toMatchObject({
      code: "admin_invalid_json",
      proseSources: { message: "provider" },
    });
  });

  it("classifies an older SDK's plain-text missing refund route without hiding typed missing draws", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("404 Not Found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(404, { error: "draw_not_found" }));
    const client = new AdminCashuClient({ endpoint: "https://dvm.example", dvmId: "dvm-fixture-1", privkeyHex: PRIVKEY, fetchImpl });
    await expect(client.refundDraw({ jobId: "job-example", refundId: "refund-example" })).rejects.toMatchObject({ status: 404, body: { error: "not_found" } });
    await expect(client.refundDraw({ jobId: "job-example", refundId: "refund-example" })).rejects.toMatchObject({ status: 404, body: { error: "draw_not_found" } });
  });

  it("wraps fetch failures as admin_unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const client = new AdminCashuClient({
      endpoint: "https://dvm.example",
      dvmId: "d",
      privkeyHex: PRIVKEY,
      fetchImpl,
    });
    await expect(client.getPendingBatches()).rejects.toThrow(/Failed to reach DVM admin endpoint/);
  });
});

describe("content-hold signed client", () => {
  it("signs the encoded job/hold paths and sends no client-supplied actor", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse(200, {}));
    const client = new AdminCashuClient({ endpoint: "https://service.example", dvmId: "service-id", privkeyHex: PRIVKEY, fetchImpl });
    await client.getContentHolds("job/one");
    await client.placeContentHold("job/one", { purpose: "support", reason: "Review", review_due_at: 1893456000000 });
    await client.renewContentHold("job/one", "hold/one", { reason: "Continue", review_due_at: 1893456000000 });
    await client.clearContentHold("job/one", "hold/one", { reason: "Done" });
    const paths = ["/admin/jobs/job%2Fone/content-holds", "/admin/jobs/job%2Fone/content-holds", "/admin/jobs/job%2Fone/content-holds/hold%2Fone/renew", "/admin/jobs/job%2Fone/content-holds/hold%2Fone/clear"];
    const nonces = new Set<string>();
    for (let i = 0; i < paths.length; i++) {
      const [url, init] = fetchImpl.mock.calls[i] as [string, RequestInit];
      expect(url).toBe(`https://service.example${paths[i]}`);
      const [nonce, ts, sig] = (init.headers as Record<string, string>).Authorization.slice(5).split(".");
      nonces.add(nonce);
      expect(verifyChallenge(PUBKEY, buildAdminChallenge({ method: i === 0 ? "GET" : "POST", path: paths[i], dvmId: "service-id", nonceHex: nonce, unixSeconds: ts }), sig)).toBe(true);
    }
    expect(nonces.size).toBe(4);
    expect(JSON.parse(fetchImpl.mock.calls[1][1]!.body as string)).toEqual({ purpose: "support", reason: "Review", review_due_at: 1893456000000 });
    expect(JSON.parse(fetchImpl.mock.calls[2][1]!.body as string)).toEqual({ reason: "Continue", review_due_at: 1893456000000 });
    expect(JSON.parse(fetchImpl.mock.calls[3][1]!.body as string)).toEqual({ reason: "Done" });
  });

  it.each([jsonResponse(404, { error: "not_found" }), new Response("404 Not Found", { status: 404 }), jsonResponse(503, { error: "content_holds_unavailable" })])("gives an upgrade action for an unsupported service", async (response) => {
    const client = new AdminCashuClient({ endpoint: "https://service.example", dvmId: "service-id", privkeyHex: PRIVKEY, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
    await expect(client.getContentHolds("job-1")).rejects.toMatchObject({ code: "content_holds_unavailable", hint: expect.stringContaining("@dvmkit/sdk 0.8.0") });
  });

  it("preserves typed missing-job errors instead of suggesting an upgrade", async () => {
    const client = new AdminCashuClient({ endpoint: "https://service.example", dvmId: "service-id", privkeyHex: PRIVKEY, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(404, { error: "job_not_found" })) });
    await expect(client.getContentHolds("missing")).rejects.toMatchObject({ status: 404, body: { error: "job_not_found" } });
  });
});

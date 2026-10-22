import { readFileSync } from "node:fs";

import { buildAdminChallenge, verifyChallenge } from "@dvmkit/sdk/internal";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../lib/cashu/builder-lock-identity", () => ({
  resolveBuilderLockKeyringByHandle: vi.fn(), resolveBuilderLockKeyring: vi.fn(),
}));
vi.mock("../resolve-dvm", () => ({ resolveDvm: vi.fn() }));
vi.mock("../../../lib/platform-client", () => ({ getDvm: vi.fn() }));
vi.mock("../../../shared/output", () => ({ json: vi.fn(), info: vi.fn(), raw: vi.fn() }));

import { resolveBuilderLockKeyring, resolveBuilderLockKeyringByHandle } from "../../../lib/cashu/builder-lock-identity";
import { getDvm } from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { resolveDvm } from "../resolve-dvm";
import { tempoBook, tempoRelease, tempoWedged } from "../tempo-drains";

const wire = JSON.parse(readFileSync(new URL("../../../../test/fixtures/tempo-drain-decisions.json", import.meta.url), "utf8"));
const privkey = "11".repeat(32);
const pubkey = Buffer.from(schnorr.getPublicKey(Buffer.from(privkey, "hex"))).toString("hex");
const keyring = { canonicalDvmId: "service-test", currentKeypair: { privkey } };
const endpoint = "https://service.example";
const fetchImpl = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchImpl);
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue(keyring as never);
  vi.mocked(resolveBuilderLockKeyring).mockReturnValue(keyring as never);
  vi.mocked(resolveDvm).mockResolvedValue({ dvmId: "service-test", dvmkitUrl: null, token: "token", platformUrl: "https://platform.example" });
  vi.mocked(getDvm).mockResolvedValue({ dvm: { url: endpoint } } as never);
});
afterEach(() => vi.unstubAllGlobals());

function respond(status: number, body: unknown) {
  fetchImpl.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

for (const [name, command] of [["book", tempoBook], ["release", tempoRelease]] as const) {
  const fixture = wire[name];

  it(`${name} requires confirmation before discovery, lock lookup, or HTTP`, async () => {
    await expect(command("service", "credit", "drain", { reason: "Reviewed", org: "chosen-org" })).rejects.toMatchObject({
      code: "confirmation_required", data: { action: name === "book" ? "book_refunded" : "release" },
      hint: expect.stringContaining("No HTTP request"),
    });
    expect(resolveDvm).not.toHaveBeenCalled();
    expect(resolveBuilderLockKeyringByHandle).not.toHaveBeenCalled();
    expect(resolveBuilderLockKeyring).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it(`${name} submits the exact portable body once on the signed fixed route`, async () => {
    respond(200, fixture.response);
    await command("service", fixture.request.credit_id, fixture.request.drain_id, {
      endpoint, confirm: true, reason: `  ${fixture.request.reason}  `, evidence: ` ${fixture.request.evidence} `,
      ...{ amount: 1, source: "chain", action: "other" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${endpoint}${fixture.path}`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(fixture.request);
    const auth = (init?.headers as Record<string, string>).Authorization;
    const [nonce, ts, sig] = auth.slice(5).split(".");
    expect(verifyChallenge(pubkey, buildAdminChallenge({ method: "POST", path: fixture.path, dvmId: "service-test", nonceHex: nonce, unixSeconds: ts }), sig)).toBe(true);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ ...fixture.response, op: `credit_tempo_${name}` }));
    expect(vi.mocked(json).mock.calls[0][0]).not.toHaveProperty("transaction");
  });

  it(`${name} preserves unusual IDs and omits absent evidence`, async () => {
    respond(200, fixture.response);
    await command("service", " credit/日本語?& ", "drain:with spaces\n", { endpoint, confirm: true, reason: "Reviewed" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({
      credit_id: " credit/日本語?& ", drain_id: "drain:with spaces\n", reason: "Reviewed",
    });
  });

  it.each([
    { reason: undefined }, { reason: "  " }, { reason: "x".repeat(2001) },
    { reason: "OK", evidence: " " }, { reason: "OK", evidence: "x".repeat(4001) },
  ])(`${name} rejects invalid reason/evidence locally: %j`, async (opts) => {
    await expect(command("service", "credit", "drain", { ...opts, endpoint, confirm: true })).rejects.toMatchObject({
      code: opts.reason === "OK" ? "invalid_evidence" : "invalid_reason",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolveBuilderLockKeyringByHandle).not.toHaveBeenCalled();
  });

  it(`${name} accepts the maximum trimmed lengths`, async () => {
    respond(200, fixture.response);
    await command("service", "credit", "drain", { endpoint, confirm: true, reason: ` ${"r".repeat(2000)} `, evidence: ` ${"e".repeat(4000)} ` });
    expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toEqual({ credit_id: "credit", drain_id: "drain", reason: "r".repeat(2000), evidence: "e".repeat(4000) });
  });

  it.each([["", "drain"], ["credit", "  "]])(`${name} refuses empty ID pair %j`, async (credit, drain) => {
    await expect(command("service", credit, drain, { endpoint, confirm: true, reason: "Reviewed" })).rejects.toMatchObject({ code: "invalid_id" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it(`${name} passes organization selection through the existing admin connection`, async () => {
    respond(200, fixture.response);
    await command("service", "credit", "drain", { org: "chosen-org", confirm: true, reason: "Reviewed" });
    expect(resolveDvm).toHaveBeenCalledWith("service", expect.objectContaining({ org: "chosen-org" }));
    expect(getDvm).toHaveBeenCalledWith("https://platform.example", "token", "service-test");
    expect(resolveBuilderLockKeyring).toHaveBeenCalledWith("service-test");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(`${name} renders immutable replay separately from current balances, human=%s`, async (human) => {
    respond(200, { ...fixture.response, amount_native: null, replayed: true, balance_micro: 975, spendable_micro: 0 });
    await command("service", fixture.request.credit_id, fixture.request.drain_id, { endpoint, confirm: true, reason: fixture.request.reason, evidence: fixture.request.evidence, human });
    const result = vi.mocked(json).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const text = human ? vi.mocked(info).mock.calls.flat().join(" ") : `${result?.display} ${result?.hint}`;
    expect(text).toMatch(/original immutable decision/);
    expect(text).toMatch(/Nothing moved again/);
    expect(text).toMatch(/balance=975, spendable=0/);
    expect(text).toMatch(/unspendable/);
    expect(text).toMatch(name === "book" ? /whole held refund/ : /no refund was paid/);
    if (human) expect(text).toContain(String(fixture.response.decision.decidedAt));
    else expect(result).toMatchObject({ decision: fixture.response.decision, balance_micro: 975, spendable_micro: 0, amount_native: null, replayed: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, "drain_decision_conflict", /original decision/],
    [409, "tempo_drain_close_pending", /final close or timed-exit outcome/],
    [409, "tempo_drain_refund_paid", /remaining amount.*tempo-book/],
    [409, "tempo_drain_refund_unknown", /original refund evidence/],
    [422, "drain_not_repairable", /supported held Tempo/],
    [503, "tempo_drain_decision_unavailable", /transactional drain reporting/],
    [404, "credit_not_found", /exact credit ID/], [404, "drain_not_found", /ID pair/],
    [404, "not_found", /Upgrade/], [400, "invalid_body", /reason/], [401, "unauthorized", /lock identity/],
  ] as const)(`${name} maps %s %s without replacement or retry`, async (status, code, hint) => {
    respond(status, { error: code, message: "Service refusal", hint: "Try the opposite action" });
    await expect(command("service", "credit", "drain", { endpoint, confirm: true, reason: "Reviewed" })).rejects.toMatchObject({
      code, message: "Service refusal", data: { http_status: status }, hint: expect.stringMatching(hint),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it(`${name} distinguishes plain-text missing routes from typed missing drains`, async () => {
    fetchImpl.mockImplementation(async () => new Response("404 Not Found", { status: 404 }));
    await expect(command("service", "credit", "drain", { endpoint, confirm: true, reason: "Reviewed" })).rejects.toMatchObject({ code: "not_found", hint: expect.stringContaining("Upgrade") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it(`${name} preserves fatal bad-signature translation`, async () => {
    respond(401, { error: "unauthorized", reason: "bad_signature" });
    await expect(command("service", "credit", "drain", { endpoint, confirm: true, reason: "Reviewed" })).rejects.toMatchObject({ code: "admin_bad_signature" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
}


it("preserves opaque listing cursors and evidence controls on the signed GET route", async () => {
  respond(200, { drains: [], next_after: "next /?&日本語" });
  await tempoWedged("service", { endpoint, after: "prior /?&日本語", limit: 50, minAgeMs: 0, includeResolved: true, evidence: false });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [target, init] = fetchImpl.mock.calls[0];
  const url = new URL(String(target));
  expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "50", after: "prior /?&日本語", min_age_ms: "0", include_resolved: "true", evidence: "false" });
  expect(init?.method).toBe("GET");
  expect(init?.body).toBeUndefined();
  const [nonce, ts, sig] = (init?.headers as Record<string, string>).Authorization.slice(5).split(".");
  expect(verifyChallenge(pubkey, buildAdminChallenge({ method: "GET", path: "/admin/credit/tempo-drains", dvmId: "service-test", nonceHex: nonce, unixSeconds: ts }), sig)).toBe(true);
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ next_after: "next /?&日本語" }));
});

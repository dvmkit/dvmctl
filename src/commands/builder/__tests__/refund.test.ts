import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { buildAdminChallenge, verifyChallenge } from "@dvmkit/sdk/internal";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../../lib/cashu/builder-lock-identity", () => ({
  resolveBuilderLockKeyringByHandle: vi.fn(), resolveBuilderLockKeyring: vi.fn(),
}));
vi.mock("../../../lib/platform", () => ({ requireAuth: vi.fn(), resolveOrgScope: vi.fn((opts) => opts.org) }));
vi.mock("../../../lib/platform-client", () => ({ listDvms: vi.fn(), getDvm: vi.fn(), scopeLabel: vi.fn() }));
vi.mock("../../../shared/output", () => ({ json: vi.fn(), info: vi.fn() }));

import { resolveBuilderLockKeyring, resolveBuilderLockKeyringByHandle } from "../../../lib/cashu/builder-lock-identity";
import { requireAuth } from "../../../lib/platform";
import { getDvm, listDvms } from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { refund } from "../refund";

const wire = JSON.parse(readFileSync(new URL("../../../../test/fixtures/credit-draw-refund.json", import.meta.url), "utf8"));
const privateKey = "11".repeat(32);
const publicKey = Buffer.from(schnorr.getPublicKey(Buffer.from(privateKey, "hex"))).toString("hex");
const keyring = { canonicalDvmId: "dvm-refund-example", currentKeypair: { privkey: privateKey } };
let server: Server;
let endpoint: string;
let requests: { path: string; method: string; body: Record<string, unknown>; authValid: boolean }[];
let response: unknown;
let status: number;

beforeEach(async () => {
  vi.clearAllMocks();
  response = wire.response;
  status = 200;
  requests = [];
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue(keyring as never);
  vi.mocked(resolveBuilderLockKeyring).mockReturnValue(keyring as never);
  vi.mocked(requireAuth).mockReturnValue({ token: "fixture-token", platformUrl: "https://platform.example" });
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const [nonce, ts, signature] = (req.headers.authorization ?? "").slice(5).split(".");
    const authValid = !!signature && verifyChallenge(publicKey, buildAdminChallenge({
      method: req.method!, path: req.url!, dvmId: "dvm-refund-example", nonceHex: nonce, unixSeconds: ts,
    }), signature);
    requests.push({ path: req.url!, method: req.method!, body: body ? JSON.parse(body) : {}, authValid });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.mocked(listDvms).mockResolvedValue({ dvms: [{ id: keyring.canonicalDvmId, slug: "scrape" }], org: {} } as never);
  vi.mocked(getDvm).mockResolvedValue({ dvm: { url: endpoint } } as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

it.each([undefined, "00.003000"])("refuses the local %s intent before discovery, auth, or admin HTTP", async (amount) => {
  await expect(refund("job-example", { dvm: "scrape", endpoint, amount })).rejects.toMatchObject({
    code: "confirmation_required", data: { handle: "scrape", job_id: "job-example", amount_micro: amount ? 3000 : null },
    display: expect.stringContaining(amount ? "0.003 in this job's credit currency" : "remaining unrefunded charge"),
    hint: expect.stringContaining("no HTTP request"),
  });
  expect(requests).toEqual([]);
  expect(requireAuth).not.toHaveBeenCalled();
  expect(listDvms).not.toHaveBeenCalled();
  expect(getDvm).not.toHaveBeenCalled();
  expect(resolveBuilderLockKeyringByHandle).not.toHaveBeenCalled();
});

it("sends the portable SDK fixture with authenticated camelCase wire arguments", async () => {
  await refund(wire.request.jobId, { dvm: "scrape", endpoint, confirm: true, amount: "0.000400", reason: wire.request.reason, refundId: wire.request.refundId });
  expect(requests).toEqual([{ method: "POST", path: "/admin/credit/refund-draw", body: wire.request, authValid: true }]);
  expect(json).toHaveBeenCalledWith(expect.objectContaining({ ...wire.response,
    display: expect.stringContaining("0.0004 USD"), hint: expect.stringContaining("dvm credit drain scrape"),
  }));
});

it("resolves the selected organization and signs for the immutable service ID", async () => {
  await refund("job-example", { dvm: "scrape", org: "chosen-org", confirm: true });
  expect(listDvms).toHaveBeenCalledWith("https://platform.example", "fixture-token", { org: "chosen-org" });
  expect(getDvm).toHaveBeenCalledWith("https://platform.example", "fixture-token", "dvm-refund-example");
  expect(resolveBuilderLockKeyring).toHaveBeenCalledWith("dvm-refund-example");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ authValid: true });
});

it.each([
  ["0.000001", 1], ["1234567890.123456", 1234567890123456], ["9007199254.740991", 9007199254740991],
] as const)("converts %s exactly to %s credit micro-units", async (amount, expected) => {
  await refund("job-example", { dvm: "scrape", endpoint, confirm: true, amount });
  expect(requests[0].body.amountMicro).toBe(expected);
});

it.each(["0", "0.000000", "-1", "NaN", "Infinity", "1e-6", "0.0000001", "9007199254.740992", ".003", "3.", " 0.003", "1,000"])("rejects invalid decimal %s before HTTP", async (amount) => {
  await expect(refund("job-example", { dvm: "scrape", endpoint, confirm: true, amount })).rejects.toMatchObject({ code: "invalid_amount" });
  expect(requests).toEqual([]);
  expect(requireAuth).not.toHaveBeenCalled();
  expect(resolveBuilderLockKeyringByHandle).not.toHaveBeenCalled();
});

it("normalizes lexical amounts and keeps explicit partial intents distinct from remainders", async () => {
  for (const amount of ["0.003", "00.003000", "0.004", undefined]) {
    await refund("job-example", { dvm: "scrape", endpoint, amount, confirm: true });
  }
  const ids = requests.map((request) => request.body.refundId);
  expect(ids[0]).toBe(ids[1]);
  expect(new Set(ids).size).toBe(3);
  expect(requests[3].body).not.toHaveProperty("amountMicro");
  expect(ids[0]).toMatch(/^refund-[0-9a-f]{64}$/);
  expect(ids[0]).toBe("refund-3bce82834172a42d4000e6a53d737b577a842fab066e9fd3330e417970b96aba");
});

it("binds the default intent ID to canonical DVM and job identity but not mutable names or reason", async () => {
  await refund("job-example", { dvm: "scrape", endpoint, confirm: true, amount: "0.003", reason: "First reason" });
  await refund("job-example", { dvm: "renamed", endpoint, confirm: true, amount: "0.003", reason: "Changed reason" });
  await refund("different-job", { dvm: "scrape", endpoint, confirm: true, amount: "0.003" });
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue({ ...keyring, canonicalDvmId: "different-service" } as never);
  await refund("job-example", { dvm: "scrape", endpoint, confirm: true, amount: "0.003" });
  expect(requests[0].body.refundId).toBe(requests[1].body.refundId);
  expect(requests[0].body.refundId).not.toBe(requests[2].body.refundId);
  expect(requests[0].body.refundId).not.toBe(requests[3].body.refundId);
});

it.each([false, true])("keeps the remainder intent and renders original replay fields with human=%s", async (human) => {
  response = { ...wire.response, amount_micro: 3000, currency: "eur", balance_after_micro: 7311 };
  await refund("job-example", { dvm: "scrape", endpoint, confirm: true, human });
  response = { ...response as object, replayed: true };
  await refund("job-example", { dvm: "scrape", endpoint, confirm: true, human });
  expect(requests[1].body).toEqual(requests[0].body);
  expect(requests[0].body).not.toHaveProperty("amountMicro");
  if (human) {
    expect(info).toHaveBeenCalledWith(expect.stringContaining("Refunded 0.003 EUR"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("already returned 0.003 EUR"));
    expect(info).toHaveBeenCalledWith(expect.stringContaining("not the current balance"));
  } else {
    expect(vi.mocked(json).mock.calls[1][0]).toMatchObject({ amount_micro: 3000, currency: "eur", balance_after_micro: 7311, replayed: true,
      display: expect.stringContaining("not the current balance") });
  }
});

it("allows a deliberate second partial refund without changing its amount or reason", async () => {
  await refund("job-example", { dvm: "scrape", endpoint, amount: "0.003", confirm: true });
  await refund("job-example", { dvm: "scrape", endpoint, amount: "0.003", reason: "More compensation", refundId: "support-second", confirm: true });
  expect(requests[1].body).toEqual({ jobId: "job-example", refundId: "support-second", amountMicro: 3000, reason: "More compensation" });
  expect(requests[0].body.refundId).not.toBe("support-second");
});

it.each([
  [404, "draw_not_found", /independent ownership evidence/],
  [422, "draw_not_completed", /failure path/],
  [422, "refund_exceeds_draw", /smaller amount/],
  [422, "credit_not_open", /cannot be refunded through dvmctl/],
  [422, "credit_refund_channel_unsupported", /cannot be refunded through dvmctl/],
  [422, "credit_refund_basis_unavailable", /independent original-payment evidence/],
  [422, "credit_refund_state_unavailable", /independent funding and drain evidence/],
  [409, "refund_conflict", /original arguments.*new --refund-id/],
  [503, "credit_refund_unavailable", /persistent credit store.*original refund ID.*did not queue/],
] as const)("maps HTTP %s %s to actionable local guidance", async (httpStatus, code, hint) => {
  status = httpStatus;
  response = { error: code, hint: "Retry with an unsafe bypass." };
  await expect(refund("job-example", { dvm: "scrape", endpoint, confirm: true })).rejects.toMatchObject({
    code, data: { http_status: httpStatus }, hint: expect.stringMatching(hint), proseSources: { message: "provider" },
  });
  expect(requests).toHaveLength(1);
  expect(json).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

it("keeps invalid signatures terminal rather than suggesting refund repair", async () => {
  status = 401;
  response = { error: "unauthorized", reason: "bad_signature" };
  await expect(refund("job-example", { dvm: "scrape", endpoint, confirm: true })).rejects.toMatchObject({ code: "admin_bad_signature" });
});

it.each([
  { reason: "x".repeat(281), code: "invalid_reason" }, { refundId: " ", code: "invalid_refund_id" }, { dvm: " ", code: "invalid_dvm" },
])("rejects invalid $code input before connection", async ({ code, ...opts }) => {
  await expect(refund("job-example", { dvm: "scrape", endpoint, confirm: true, ...opts })).rejects.toMatchObject({ code });
  expect(requests).toEqual([]);
  expect(resolveBuilderLockKeyringByHandle).not.toHaveBeenCalled();
});

it("gives an upgrade step for a missing refund route", async () => {
  status = 404;
  response = { error: "not_found" };
  await expect(refund("job-example", { dvm: "scrape", endpoint, confirm: true })).rejects.toMatchObject({ code: "not_found", hint: expect.stringContaining("@dvmkit/sdk 0.11.0-rc.1") });
});

it("preserves an unknown refusal without interpreting an object prototype property as guidance", async () => {
  status = 422;
  response = { error: "toString", hint: "Inspect service configuration." };
  await expect(refund("job-example", { dvm: "scrape", endpoint, confirm: true })).rejects.toMatchObject({
    code: "toString", hint: "Inspect service configuration.", proseSources: { hint: "provider" },
  });
});

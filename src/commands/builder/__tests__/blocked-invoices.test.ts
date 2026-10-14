/**
 * The `dvmctl credit` verbs. The route contract is asserted in
 * `@dvmkit/sdk/server`; what only this suite covers
 * is the CLI's own half — that the target credit is required rather than
 * guessed, that a bad signature is translated before it reaches the generic
 * admin-error surface, and that the JSON an agent reads carries the
 * fields it acts on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as adminCashuClientModule from "../../../lib/admin-cashu-client";

vi.mock("../../../lib/cashu/builder-lock-identity", () => ({
  resolveBuilderLockKeyring: vi.fn(),
  resolveBuilderLockKeyringByHandle: vi.fn(),
}));
vi.mock("../../../shared/output", () => ({
  json: vi.fn(),
  info: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("../../../lib/platform", () => ({ requireAuth: vi.fn() }));
vi.mock("../../../lib/platform-client", () => ({ getDvm: vi.fn() }));

vi.mock("../resolve-dvm", () => ({
  resolveDvm: vi.fn(async () => ({
    dvmId: "dvm-fixture-1498",
    token: "t",
    platformUrl: "https://api.example",
  })),
}));

vi.mock("../../../lib/admin-cashu-client", async (importOriginal) => {
  const actual = await importOriginal<typeof adminCashuClientModule>();
  // Class shell whose constructor delegates to the spy, so a test can hand the
  // command a fake client without the real one ever reaching the network.
  class AdminCashuClient {
    constructor(opts: unknown) {
      return clientCtorSpy(opts) as AdminCashuClient;
    }
  }
  return { ...actual, AdminCashuClient };
});

const clientCtorSpy = vi.fn();
const getBlockedInvoices = vi.fn();
const reconcile = vi.fn();
const writeOff = vi.fn();

import { AdminApiError, type AdminBlockedInvoice } from "../../../lib/admin-cashu-client";
import {
  resolveBuilderLockKeyring,
  resolveBuilderLockKeyringByHandle,
} from "../../../lib/cashu/builder-lock-identity";
import * as output from "../../../shared/output";
import { blockedInvoices, reconcileInvoice, writeOffInvoice } from "../blocked-invoices";

const ENDPOINT = "https://dvm.example.com";

function blockedRow(overrides: Partial<AdminBlockedInvoice> = {}): AdminBlockedInvoice {
  return {
    payment_hash: "9a".repeat(32),
    credit_id: "fnd:abc:f1",
    fund_id: "f1",
    caller_pubkey: "ab".repeat(32),
    currency: "usd",
    amount_micro: 500_000,
    amount_msats: 500_000,
    status: "blocked",
    blocked_reason: "funding_replayed_on_cashu",
    created_at: 1,
    settled_at: null,
    reconciled_credit_id: null,
    resolved_at: null,
    write_off_note: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const keyring = {
    canonicalDvmId: "dvm-fixture-1498",
    currentKeypair: { privkey: "11".repeat(32), pubkey: "02" + "aa".repeat(32) },
    keypairsByPubkey: new Map(),
  } as never;
  vi.mocked(resolveBuilderLockKeyring).mockReturnValue(keyring);
  vi.mocked(resolveBuilderLockKeyringByHandle).mockResolvedValue(keyring);
  clientCtorSpy.mockReturnValue({
    getBlockedInvoices,
    reconcileInvoice: reconcile,
    writeOffInvoice: writeOff,
  });
  getBlockedInvoices.mockResolvedValue({ invoices: [blockedRow()] });
  reconcile.mockResolvedValue({
    status: "reconciled",
    payment_hash: "9a".repeat(32),
    credit_id: "c-target",
    fund_id: "9a".repeat(32),
    amount_micro: 500_000,
    currency: "usd",
    replayed: false,
    credit: {
      credit_id: "c-target",
      currency: "usd",
      balance_micro: 500_000,
      remaining_micro: 500_000,
      expiry_ms: 2,
    },
  });
  writeOff.mockResolvedValue({
    status: "written_off",
    payment_hash: "9a".repeat(32),
    amount_micro: 500_000,
    currency: "usd",
    note: "already made whole",
    replayed: false,
  });
});

describe("dvmctl credit blocked", () => {
  it("emits the queue plus the count awaiting a decision", async () => {
    await blockedInvoices("cast", { endpoint: ENDPOINT });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_blocked",
      handle: "cast",
      dvmId: "dvm-fixture-1498",
      slug: "cast",
      blocked_count: 1,
    });
    expect(body.invoices).toHaveLength(1);
    expect(String(body.hint)).toContain("dvmctl credit reconcile");
    // The privkey is derived locally and handed to the client, never fetched.
    expect(clientCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: ENDPOINT, dvmId: "dvm-fixture-1498" })
    );
  });

  it("carries the cursor through so the tail of the queue is reachable", async () => {
    getBlockedInvoices.mockResolvedValue({ invoices: [blockedRow()], next_after: "cursor-2" });
    await blockedInvoices("cast", { endpoint: ENDPOINT, limit: 1, after: "cursor-1" });
    expect(getBlockedInvoices).toHaveBeenCalledWith({ limit: 1, after: "cursor-1" });
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({ next_after: "cursor-2" });
  });

  it("says plainly when nothing needs an operator", async () => {
    getBlockedInvoices.mockResolvedValue({ invoices: [] });
    await blockedInvoices("cast", { endpoint: ENDPOINT });
    expect(vi.mocked(output.json).mock.calls[0][0]).toMatchObject({
      blocked_count: 0,
      display: "No Lightning payments are waiting on an operator decision.",
    });
  });

  it("refuses an out-of-range page rather than asking the DVM for it", async () => {
    await expect(
      blockedInvoices("cast", { endpoint: ENDPOINT, limit: 9999 })
    ).rejects.toMatchObject({ code: "invalid_limit" });
    expect(getBlockedInvoices).not.toHaveBeenCalled();
  });

  it("translates a bad signature rather than surfacing it as a per-call refusal", async () => {
    getBlockedInvoices.mockRejectedValue(
      new AdminApiError(401, { error: "unauthorized", reason: "bad_signature", raw: {} })
    );
    await expect(blockedInvoices("cast", { endpoint: ENDPOINT })).rejects.toMatchObject({
      code: "admin_bad_signature",
    });
  });
});

describe("dvmctl credit reconcile", () => {
  it("preserves a non-Tempo refusal from the DVM", async () => {
    reconcile.mockRejectedValue(
      new AdminApiError(422, {
        error: "invoice_not_blocked",
        message: "Invoice abc is settled; only a blocked invoice can be reconciled.",
        hint: "Choose another invoice from `dvmctl credit blocked`.",
        raw: {},
      })
    );

    await expect(
      reconcileInvoice("cast", "9a".repeat(32), { endpoint: ENDPOINT, creditId: "c-target" })
    ).rejects.toMatchObject({
      code: "invoice_not_blocked",
      message: "Invoice abc is settled; only a blocked invoice can be reconciled.",
      hint: "Choose another invoice from `dvmctl credit blocked`.",
      data: { http_status: 422 },
    });
  });

  it("credits the named target and reports where the balance landed", async () => {
    await reconcileInvoice("cast", "9a".repeat(32), { endpoint: ENDPOINT, creditId: "c-target" });
    expect(reconcile).toHaveBeenCalledWith({
      payment_hash: "9a".repeat(32),
      credit_id: "c-target",
    });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_reconcile",
      dvmId: "dvm-fixture-1498",
      slug: "cast",
      credit_id: "c-target",
      amount_micro: 500_000,
      replayed: false,
    });
    expect(String(body.display)).toContain("c-target");
  });

  it("refuses without a target credit — the one thing that is not derivable", async () => {
    await expect(
      reconcileInvoice("cast", "9a".repeat(32), { endpoint: ENDPOINT })
    ).rejects.toMatchObject({ code: "missing_credit_id" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("says nothing moved on a replay", async () => {
    reconcile.mockResolvedValue({
      status: "reconciled",
      payment_hash: "9a".repeat(32),
      credit_id: "c-target",
      fund_id: "9a".repeat(32),
      amount_micro: 500_000,
      currency: "usd",
      replayed: true,
    });
    await reconcileInvoice("cast", "9a".repeat(32), { endpoint: ENDPOINT, creditId: "c-target" });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ replayed: true });
    expect(String(body.display)).toContain("Nothing moved");
  });
});

describe("dvmctl credit write-off", () => {
  it("records the note and says the money stayed put", async () => {
    await writeOffInvoice("cast", "9a".repeat(32), {
      endpoint: ENDPOINT,
      note: "already made whole",
    });
    expect(writeOff).toHaveBeenCalledWith({
      payment_hash: "9a".repeat(32),
      note: "already made whole",
    });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      op: "credit_write_off",
      dvmId: "dvm-fixture-1498",
      slug: "cast",
      note: "already made whole",
    });
    expect(String(body.display)).toContain("stays in your wallet");
    expect(String(body.hint)).toContain("Reversible");
  });

  it("says nothing changed on a repeat, and whose note is on file", async () => {
    writeOff.mockResolvedValue({
      status: "written_off",
      payment_hash: "9a".repeat(32),
      amount_micro: 500_000,
      currency: "usd",
      note: "closed by someone else last week",
      replayed: true,
    });
    await writeOffInvoice("cast", "9a".repeat(32), { endpoint: ENDPOINT, note: "mine" });
    const body = vi.mocked(output.json).mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ replayed: true, note: "closed by someone else last week" });
    expect(String(body.display)).toContain("already written off");
  });

  it("omits the note entirely when none was given", async () => {
    writeOff.mockResolvedValue({
      status: "written_off",
      payment_hash: "9a".repeat(32),
      amount_micro: 500_000,
      currency: "usd",
      note: null,
      replayed: false,
    });
    await writeOffInvoice("cast", "9a".repeat(32), { endpoint: ENDPOINT });
    expect(writeOff).toHaveBeenCalledWith({ payment_hash: "9a".repeat(32) });
  });
});

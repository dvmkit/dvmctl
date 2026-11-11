import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import { DvmError } from "@dvmkit/sdk/internal";

import { AdminApiError } from "../../../lib/admin-cashu-client";
import { handleError } from "../../../lib/error-handler";
import { resetFeedbackNotices } from "../../../lib/feedback-notice";
import { info, json } from "../../../shared/output";
import { adminCall, connectAdmin } from "../admin-connection";
import { destroy } from "../destroy";
import { meltPending } from "../melt-pending";
import { rotate } from "../rotate";

describe("admin mount prefix validation", () => {
  const malformed = ["", "/", "feed", "/feed/", "//feed", "/feed//nested", "/feed?query", "/feed#fragment", "/feed/../other", "/feed/%2e%2e/other", "/feed\\other", "/feed with space", "/feed/%zz", "https://dvm.example/feed"];
  it.each([
    ["shared connection", connectAdmin],
    ["melt-pending", meltPending],
    ["rotate", rotate],
    ["destroy", destroy],
  ] as const)("%s refuses malformed prefixes before any request", async (_name, command) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      for (const mountPrefix of malformed) {
        await expect(command("feed", { mountPrefix })).rejects.toMatchObject({ code: "invalid_mount_prefix" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("adminCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeedbackNotices();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("preserves a Tempo refusal for the default JSON error boundary", async () => {
    const message = "Tempo close refunded 0 for a drain requiring at least 20000";
    const translated = await translate(
      new AdminApiError(409, {
        error: "drain_conflict",
        reason: "refund_below_floor",
        message,
        hint: "Write off the drain after making good the shortfall out of band.",
        display: "The close paid less than the ledger extinguished.",
        raw: {},
      })
    );
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    expect(() => handleError(translated)).toThrow("exit");
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "drain_conflict",
        message: { _source: "provider", text: message },
        display: {
          _source: "provider",
          text: "The close paid less than the ledger extinguished.",
        },
        hint: {
          _source: "provider",
          text: "Write off the drain after making good the shortfall out of band.",
        },
        http_status: 409,
        reason: "refund_below_floor",
      },
    });
  });

  it("preserves a non-Tempo refusal and its operator copy in human mode", async () => {
    const translated = await translate(
      new AdminApiError(422, {
        error: "invoice_not_blocked",
        message: "Invoice abc is settled; only a blocked invoice can be reconciled.",
        hint: "Choose another invoice from `dvmctl credit blocked`.",
        display: "That Lightning payment does not need repair.",
        raw: {},
      })
    );
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });

    expect(() => handleError(translated, true)).toThrow("exit");
    expect(info).toHaveBeenCalledWith(
      "Error: Invoice abc is settled; only a blocked invoice can be reconciled.\n" +
        "That Lightning payment does not need repair.\n" +
        "Choose another invoice from `dvmctl credit blocked`."
    );
  });

  it("falls back to the bounded admin error message when the body has no message", async () => {
    const translated = await translate(
      new AdminApiError(422, {
        error: "settlement_not_wedged",
        reason: "already_settled",
        raw: {},
      })
    );

    expect(translated).toMatchObject({
      code: "settlement_not_wedged",
      message: "Admin endpoint returned HTTP 422: settlement_not_wedged (already_settled)",
      data: { http_status: 422, reason: "already_settled" },
      proseSources: { message: "provider" },
    });
  });

  it("keeps bad_signature on its dedicated terminal", async () => {
    const translated = await translate(
      new AdminApiError(401, {
        error: "unauthorized",
        reason: "bad_signature",
        message: "untrusted route copy",
        raw: {},
      })
    );

    expect(translated).toMatchObject({ code: "admin_bad_signature" });
    expect(translated.message).not.toContain("untrusted route copy");
  });
});

async function translate(error: AdminApiError): Promise<DvmError> {
  let caught: unknown;
  try {
    await adminCall(async () => {
      throw error;
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DvmError);
  return caught as DvmError;
}

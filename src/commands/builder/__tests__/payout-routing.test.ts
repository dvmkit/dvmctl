import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org ?? "saved-org"),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(), json: vi.fn(), setOutputTraceId: vi.fn(),
}));

import { handleError } from "../../../lib/error-handler";
import { requireAuth } from "../../../lib/platform";
import { info, json } from "../../../shared/output";
import { payoutRouting } from "../payout-routing";

const DVM_ID = "550e8400-e29b-41d4-a716-446655440000";
const result = { accept_cashu: false, accept_tempo: null, accept_base: true, applies_on: "next_deploy" };

function selectDvm(id = DVM_ID) {
  return Response.json({
    dvms: [{ id, slug: "my-dvm", dvmkitUrl: null }],
    org: { id: "org-1", handle: "saved-org", role: "admin", personal: false },
  });
}

function routingRequest() {
  const [url, init] = vi.mocked(fetch).mock.calls[1];
  expect(url).toBe(`https://platform.example/api/v1/builder/dvms/${DVM_ID}/payout-routing`);
  expect(init?.headers).toMatchObject({ Authorization: "Bearer tok" });
  return init!;
}

describe("payout routing", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads stored preferences with GET and defaults to JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(selectDvm()).mockResolvedValueOnce(Response.json(result));
    await payoutRouting("my-dvm", {});
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://platform.example/api/v1/builder/dvms?org=saved-org");
    expect(routingRequest()).toMatchObject({ method: "GET" });
    expect(routingRequest().body).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenCalledWith(result);
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    [{ cashu: "false" }, { accept_cashu: false }],
    [{ tempo: "null" }, { accept_tempo: null }],
    [{ base: "true" }, { accept_base: true }],
    [{ cashu: "null", tempo: "true", base: "false" }, { accept_cashu: null, accept_tempo: true, accept_base: false }],
  ])("updates only the specified preferences: %j", async (opts, expected) => {
    vi.mocked(fetch).mockResolvedValueOnce(selectDvm()).mockResolvedValueOnce(Response.json(result));
    await payoutRouting("my-dvm", opts);
    const request = routingRequest();
    expect(request.method).toBe("PUT");
    expect(request.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(request.body as string)).toEqual(expected);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenCalledWith(result);
  });

  it.each(["cashu", "tempo", "base"] as const)("rejects invalid %s before any request", async (rail) => {
    for (const value of ["TRUE", "False", "", "0", "1", "undefined", " null "]) {
      await expect(payoutRouting("my-dvm", { cashu: "false", [rail]: value })).rejects.toMatchObject({
        code: "bad_request", hint: expect.stringContaining(`--${rail}`),
      });
    }
    expect(requireAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the immutable ID from the explicitly selected organization", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(selectDvm("other-id")).mockResolvedValueOnce(Response.json(result));
    await payoutRouting("my-dvm", { org: "other-org", base: "false" });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe("https://platform.example/api/v1/builder/dvms?org=other-org");
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://platform.example/api/v1/builder/dvms/other-id/payout-routing");
  });

  it("does not write when the slug is absent in the selected org", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      dvms: [], org: { id: "org-1", handle: "saved-org", role: "admin", personal: false },
    }));
    await expect(payoutRouting("missing", { cashu: "false" })).rejects.toMatchObject({ code: "not_found" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { base: "false" }])("retains service authorization errors: %j", async (opts) => {
    vi.mocked(fetch).mockResolvedValueOnce(selectDvm()).mockResolvedValueOnce(Response.json({
      error: { code: "forbidden", message: "Admin role required" },
    }, { status: 403 }));
    const error = await payoutRouting("my-dvm", opts).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: "forbidden", message: "Admin role required", hint: expect.stringMatching(/admin.*owner.*org/),
    });
    expect(json).not.toHaveBeenCalled();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    try {
      expect(() => handleError(error)).toThrow("exit");
      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: "forbidden", hint: expect.stringMatching(/admin.*owner.*org/) }),
      }));
    } finally { exit.mockRestore(); }
  });

  it("preserves organization authorization failures without calling the resource", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      error: { code: "not_found", message: "No such org", hint: "Check org membership" },
    }, { status: 404 }));
    await expect(payoutRouting("my-dvm", { org: "other-org", base: "false" })).rejects.toMatchObject({
      code: "not_found", message: "No such org", hint: "Check org membership",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves remote guidance and validation failures", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(selectDvm()).mockResolvedValueOnce(Response.json({
      error: { code: "bad_request", message: "Cannot save", hint: "Refresh the preferences" },
    }, { status: 400 }));
    await expect(payoutRouting("my-dvm", { tempo: "true" })).rejects.toMatchObject({
      code: "bad_request", message: "Cannot save", hint: "Refresh the preferences",
    });
    expect(json).not.toHaveBeenCalled();
  });

  it.each([[{}, 3], [{ cashu: "false" }, 1]] as const)("reports transport failures without replaying writes: %j", async (opts, attempts) => {
    vi.mocked(fetch).mockResolvedValueOnce(selectDvm()).mockRejectedValue(new TypeError("fetch failed"));
    const error = await payoutRouting("my-dvm", opts).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: "platform_unreachable", hint: expect.stringMatching(/network.*retry/), data: expect.objectContaining({ attempts }),
    });
    expect(fetch).toHaveBeenCalledTimes(1 + attempts);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    try {
      expect(() => handleError(error)).toThrow("exit");
      expect(json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: "platform_unreachable", attempts, hint: expect.stringMatching(/network.*retry/) }),
      }));
    } finally { exit.mockRestore(); }
  });

  it.each([{}, { cashu: "false" }])("supports opt-in human output for reads and writes: %j", async (opts) => {
    vi.mocked(fetch).mockResolvedValueOnce(selectDvm()).mockResolvedValueOnce(Response.json(result));
    await payoutRouting("my-dvm", { ...opts, human: true });
    expect(info).toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org ?? "saved-org"),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
  setOutputTraceId: vi.fn(),
}));

import { requireAuth } from "../../../lib/platform";
import { info, json } from "../../../shared/output";
import { visibility } from "../visibility";

const DVM_ID = "550e8400-e29b-41d4-a716-446655440000";

function selectDvm() {
  return Response.json({
    dvms: [{ id: DVM_ID, slug: "my-dvm", dvmkitUrl: null }],
    org: { id: "org-1", handle: "saved-org", role: "admin", personal: false },
  });
}

describe("visibility", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([{}, { hidden: true, listed: true }])(
    "rejects invalid flags before authentication or any request: %j",
    async (opts) => {
      await expect(visibility("my-dvm", opts)).rejects.toMatchObject({ code: "bad_request" });
      expect(requireAuth).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ hidden: true }, true],
    [{ listed: true }, false],
  ] as const)("sends the selected visibility to the resolved ID: %j", async (opts, hidden) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(selectDvm())
      .mockResolvedValueOnce(Response.json({ slug: "my-dvm", hidden }));

    await visibility("my-dvm", opts);

    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      "https://platform.example/api/v1/builder/dvms?org=saved-org"
    );
    expect(fetch).toHaveBeenNthCalledWith(2,
      `https://platform.example/api/v1/builder/dvms/${DVM_ID}/visibility`,
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ hidden }),
      })
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(json).toHaveBeenCalledWith({ slug: "my-dvm", hidden });
    expect(info).not.toHaveBeenCalled();
  });

  it("uses an explicit org when selecting the DVM", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(selectDvm())
      .mockResolvedValueOnce(Response.json({ slug: "my-dvm", hidden: true }));

    await visibility("my-dvm", { hidden: true, org: "other-org" });

    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      "https://platform.example/api/v1/builder/dvms?org=other-org"
    );
  });

  it("does not mutate when the slug is absent from the selected scope", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      dvms: [],
      org: { id: "org-1", handle: "saved-org", role: "admin", personal: false },
    }));

    await expect(visibility("my-dvm", { hidden: true })).rejects.toMatchObject({ code: "not_found" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    [400, "bad_request"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("preserves a %i platform error and supplies role guidance for 403", async (status, code) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(selectDvm())
      .mockResolvedValueOnce(Response.json({ error: { code, message: "Request refused" } }, { status }));

    const error = await visibility("my-dvm", { hidden: true }).catch((err: unknown) => err);

    expect(error).toMatchObject({ code, message: "Request refused" });
    if (status === 403) expect(error).toMatchObject({ hint: expect.stringMatching(/admin.*org/i) });
    expect(json).not.toHaveBeenCalled();
  });

  it("preserves platform guidance when supplied", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(selectDvm())
      .mockResolvedValueOnce(Response.json({
        error: { code: "forbidden", hint: "Ask an owner of this org to grant an admin role." },
      }, { status: 403 }));

    await expect(visibility("my-dvm", { hidden: true })).rejects.toMatchObject({
      code: "forbidden", hint: "Ask an owner of this org to grant an admin role.",
    });
  });

  it.each([
    [{ hidden: true }, true, /Hidden.*my-dvm.*still callable by URL/],
    [{ listed: true }, false, /Listed.*my-dvm.*discovery/],
  ] as const)("renders human confirmation for %j", async (opts, hidden, confirmation) => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(selectDvm())
      .mockResolvedValueOnce(Response.json({ slug: "my-dvm", hidden }));

    await visibility("my-dvm", { ...opts, human: true });

    expect(info).toHaveBeenCalledWith(expect.stringMatching(confirmation));
    expect(json).not.toHaveBeenCalled();
  });
});

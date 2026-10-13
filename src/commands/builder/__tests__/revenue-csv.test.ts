import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PlatformClientModule from "../../../lib/platform-client";

vi.mock("../../../lib/platform-client", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformClientModule>();
  return { ...actual, getRevenueCsv: vi.fn() };
});
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import * as platformClient from "../../../lib/platform-client";
import { info } from "../../../shared/output";
import { revenueCsv } from "../revenue-csv";

describe("dvmctl revenue csv", () => {
  let written = "";

  beforeEach(() => {
    written = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    });
    vi.mocked(info).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // The CSV body can't carry the `org` echo the JSON reads do, so
  // the scope rides the `X-Org` header and lands on stderr — an empty export
  // still says which org it was empty for.
  it("sends --org and names the scope on stderr, keeping stdout pure CSV", async () => {
    vi.mocked(platformClient.getRevenueCsv).mockResolvedValue({
      csv: "date,amount\r\n",
      org: "dvmkit",
    });

    await revenueCsv({ from: "2026-01-01", to: "2026-01-31", org: "dvmkit" });

    expect(vi.mocked(platformClient.getRevenueCsv).mock.calls[0][2]).toMatchObject({
      org: "dvmkit",
    });
    expect(vi.mocked(info).mock.calls.map((c) => c[0])).toEqual(["  Org: dvmkit"]);
    expect(written).toBe("date,amount\r\n");
  });

  it("names the personal scope when no org is in play", async () => {
    vi.mocked(platformClient.getRevenueCsv).mockResolvedValue({ csv: "", org: "personal" });

    await revenueCsv({ from: "2026-01-01", to: "2026-01-31" });

    expect(vi.mocked(platformClient.getRevenueCsv).mock.calls[0][2]).toMatchObject({
      org: undefined,
    });
    expect(vi.mocked(info).mock.calls.map((c) => c[0])).toEqual(["  Org: personal"]);
  });
});

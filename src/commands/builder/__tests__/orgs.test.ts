import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform-client");
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  loadActiveOrg: vi.fn(() => "my-org"),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import * as platform from "../../../lib/platform";
import * as platformClient from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { orgs } from "../orgs";

const MEMBERSHIPS = [
  {
    handle: "my-org",
    displayName: "My Org",
    avatarUrl: null,
    role: "admin" as const,
    isPersonal: false,
  },
  {
    handle: "alice",
    displayName: "Alice",
    avatarUrl: null,
    role: "owner" as const,
    isPersonal: true,
  },
];

describe("dvmctl orgs", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
    vi.mocked(platform.loadActiveOrg).mockReturnValue("my-org");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists every membership and marks the active shared org in JSON", async () => {
    vi.mocked(platformClient.listBuilderOrgs).mockResolvedValue(MEMBERSHIPS);

    await orgs({});

    expect(platformClient.listBuilderOrgs).toHaveBeenCalledWith("https://platform.example", "tok");
    expect(json).toHaveBeenCalledWith({
      activeOrg: "my-org",
      memberships: [
        {
          handle: "my-org",
          displayName: "My Org",
          role: "admin",
          personal: false,
          active: true,
        },
        { displayName: "Alice", role: "owner", personal: true, active: false },
      ],
      display: "1 shared org membership. Active context: my-org.",
      hint: "Run `dvmctl switch <handle>` to choose a shared org, or `dvmctl switch --personal` for your personal context.",
    });
  });

  it("marks personal context without exposing a personal-org handle", async () => {
    vi.mocked(platform.loadActiveOrg).mockReturnValue(null);
    vi.mocked(platformClient.listBuilderOrgs).mockResolvedValue([MEMBERSHIPS[1]]);

    await orgs({});

    expect(json).toHaveBeenCalledWith({
      activeOrg: null,
      memberships: [{ displayName: "Alice", role: "owner", personal: true, active: true }],
      display: "No shared org memberships. Active context: personal.",
      hint: "Create or join a shared org in the dashboard. After you join, run `dvmctl switch <handle>`.",
    });
  });

  it("prints a table and identifies personal context without a handle", async () => {
    vi.mocked(platform.loadActiveOrg).mockReturnValue(null);
    vi.mocked(platformClient.listBuilderOrgs).mockResolvedValue([MEMBERSHIPS[1]]);

    await orgs({ human: true });

    const output = vi
      .mocked(info)
      .mock.calls.map(([line]) => line)
      .join("\n");
    expect(output).toContain("Active context: personal");
    expect(output).toContain("No shared org memberships.");
    expect(output).toContain("HANDLE");
    expect(output).toContain("Alice (personal)");
    expect(output).toContain("—");
    expect(output).not.toContain("alice  Alice");
    expect(json).not.toHaveBeenCalled();
  });
});

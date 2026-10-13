import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/builder-store", () => ({
  loadIdentityPubkey: vi.fn(),
}));
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
import * as builderStore from "../../../shared/builder-store";
import { info, json } from "../../../shared/output";
import { whoami } from "../whoami";

const BUILDER = {
  id: "builder-1",
  email: "builder@example.com",
  handle: "builder",
  authId: "auth-1",
  displayName: "Builder",
  bio: null,
  avatarUrl: null,
  website: null,
  links: {},
  isOperator: false,
  createdAt: 1,
  updatedAt: 2,
};

const MEMBERSHIPS = [
  {
    handle: "my-org",
    displayName: "My Org",
    avatarUrl: null,
    role: "admin" as const,
    isPersonal: false,
  },
  {
    handle: "builder",
    displayName: "Builder",
    avatarUrl: null,
    role: "owner" as const,
    isPersonal: true,
  },
];

describe("dvmctl whoami", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
    vi.mocked(platform.loadActiveOrg).mockReturnValue("my-org");
    vi.mocked(builderStore.loadIdentityPubkey).mockReturnValue("a".repeat(64));
    vi.mocked(platformClient.getAuthenticatedBuilderProfile).mockResolvedValue(BUILDER);
    vi.mocked(platformClient.listBuilderOrgs).mockResolvedValue(MEMBERSHIPS);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("combines local identity, builder profile, memberships, and active context", async () => {
    await whoami({});

    expect(platformClient.getAuthenticatedBuilderProfile).toHaveBeenCalledWith(
      "https://platform.example",
      "tok"
    );
    expect(platformClient.listBuilderOrgs).toHaveBeenCalledWith("https://platform.example", "tok");
    expect(json).toHaveBeenCalledWith({
      identity_pubkey: "a".repeat(64),
      identity_status: "available",
      builder: BUILDER,
      activeOrg: "my-org",
      memberships: [
        {
          handle: "my-org",
          displayName: "My Org",
          role: "admin",
          personal: false,
          deployable: true,
          active: true,
        },
        {
          displayName: "Builder",
          role: "owner",
          personal: true,
          deployable: true,
          active: false,
        },
      ],
      display: "Builder builder@example.com. Active context: my-org.",
      hint: "Every listed membership can deploy a new DVM. The role shows its existing access level.",
    });
  });

  it("reports a missing local identity without blocking the platform lookup", async () => {
    vi.mocked(builderStore.loadIdentityPubkey).mockReturnValue(null);
    vi.mocked(platform.loadActiveOrg).mockReturnValue(null);
    vi.mocked(platformClient.listBuilderOrgs).mockResolvedValue([MEMBERSHIPS[1]]);

    await whoami({});

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_pubkey: null,
        identity_status: "missing",
        activeOrg: null,
        memberships: [
          {
            displayName: "Builder",
            role: "owner",
            personal: true,
            deployable: true,
            active: true,
          },
        ],
        hint: "Run `dvmctl identity create` before a cloud or Connect deploy.",
      })
    );
  });

  it("reports an unreadable local config without hiding account access", async () => {
    vi.mocked(builderStore.loadIdentityPubkey).mockImplementation(() => {
      throw new Error("builder.json is not valid JSON");
    });

    await whoami({});

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_pubkey: null,
        identity_status: "unreadable",
        identity_detail: "builder.json is not valid JSON",
        builder: BUILDER,
        hint: "Repair the local builder configuration before a cloud or Connect deploy.",
      })
    );
  });

  it("reports a malformed local identity pubkey without claiming it is usable", async () => {
    vi.mocked(builderStore.loadIdentityPubkey).mockReturnValue("not-a-pubkey");

    await whoami({});

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_pubkey: null,
        identity_status: "unreadable",
        identity_detail: "Local builder identity pubkey is not a 64-character hexadecimal key.",
      })
    );
  });

  it("reports an uppercase identity pubkey as unreadable", async () => {
    vi.mocked(builderStore.loadIdentityPubkey).mockReturnValue("A".repeat(64));

    await whoami({});

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        identity_pubkey: null,
        identity_status: "unreadable",
        identity_detail: "Local builder identity pubkey is not a 64-character hexadecimal key.",
      })
    );
  });

  it("prints a human-readable identity and membership table", async () => {
    await whoami({ human: true });

    const output = vi
      .mocked(info)
      .mock.calls.map(([line]) => line)
      .join("\n");
    expect(output).toContain(
      "identity pubkey: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (available)"
    );
    expect(output).toContain("DEPLOY");
    expect(output).toContain("my-org");
    expect(output).toContain("Builder (personal)");
    expect(output).toContain("yes");
    expect(json).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform-client");
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import * as platformClient from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { apiKeysCreate } from "../api-keys-create";
import { apiKeysList } from "../api-keys-list";
import { apiKeysRevoke } from "../api-keys-revoke";

describe("dvmctl api-keys list", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits JSON with keys array", async () => {
    const result = {
      keys: [
        {
          id: "ak_abc",
          label: "ci",
          key_prefix: "dvmk_f6c",
          created_at: 1716000000000,
          last_used_at: null,
        },
      ],
      count: 1,
      limit: 10,
    };
    vi.mocked(platformClient.listApiKeys).mockResolvedValue(result);

    await apiKeysList({});

    expect(json).toHaveBeenCalledWith(result);
  });

  it("renders human table", async () => {
    vi.mocked(platformClient.listApiKeys).mockResolvedValue({
      keys: [
        {
          id: "ak_abc",
          label: "ci",
          key_prefix: "dvmk_f6c",
          created_at: 1716000000000,
          last_used_at: null,
        },
      ],
      count: 1,
      limit: 10,
    });

    await apiKeysList({ human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("1/10 keys used"))).toBe(true);
    expect(calls.some((c) => c.includes("ak_abc"))).toBe(true);
    expect(calls.some((c) => c.includes("never"))).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });

  it("shows empty-state in human mode", async () => {
    vi.mocked(platformClient.listApiKeys).mockResolvedValue({
      keys: [],
      count: 0,
      limit: 10,
    });

    await apiKeysList({ human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["  No API keys."]);
  });
});

describe("dvmctl api-keys create", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits JSON with the raw key", async () => {
    const result = {
      id: "ak_new",
      key: "dvmk_secret123",
      label: "my-key",
      created_at: 1716000000000,
    };
    vi.mocked(platformClient.createApiKey).mockResolvedValue(result);

    await apiKeysCreate({ label: "my-key" });

    expect(platformClient.createApiKey).toHaveBeenCalledWith("https://platform.example", "tok", {
      label: "my-key",
    });
    expect(json).toHaveBeenCalledWith(result);
  });

  it("displays the raw key and save warning in human mode", async () => {
    vi.mocked(platformClient.createApiKey).mockResolvedValue({
      id: "ak_new",
      key: "dvmk_secret123",
      label: "my-key",
      created_at: 1716000000000,
    });

    await apiKeysCreate({ label: "my-key", human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes("dvmk_secret123"))).toBe(true);
    expect(calls.some((c) => c.includes("will not be shown again"))).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });
});

describe("dvmctl api-keys revoke", () => {
  beforeEach(() => {
    vi.mocked(info).mockClear();
    vi.mocked(json).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits JSON confirmation", async () => {
    vi.mocked(platformClient.deleteApiKey).mockResolvedValue(undefined);

    await apiKeysRevoke("ak_abc", {});

    expect(platformClient.deleteApiKey).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      "ak_abc"
    );
    expect(json).toHaveBeenCalledWith({ deleted: true, id: "ak_abc" });
  });

  it("prints confirmation in human mode", async () => {
    vi.mocked(platformClient.deleteApiKey).mockResolvedValue(undefined);

    await apiKeysRevoke("ak_abc", { human: true });

    const calls = vi.mocked(info).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["  API key ak_abc revoked."]);
    expect(json).not.toHaveBeenCalled();
  });
});

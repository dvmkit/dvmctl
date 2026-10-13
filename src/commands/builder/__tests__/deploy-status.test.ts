import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

vi.mock("../../../lib/platform-client", () => ({
  getDeployStatus: vi.fn(),
}));

import { getDeployStatus } from "../../../lib/platform-client";
import { info, json } from "../../../shared/output";
import { deployStatus } from "../deploy-status";

const baseResponse = {
  deploy: {
    id: "dep-abc",
    dvmId: "dvm-xyz",
    status: "deployed" as const,
    error: null,
    logs: null,
    startedAt: 1_747_500_000_000,
    endedAt: 1_747_500_090_000,
    trigger: "cli" as const,
    commitSha: null,
    commitRef: null,
    commitMessage: null,
    commitAuthorName: null,
    checkRunId: null,
    machineId: null,
    lastHeartbeatAt: null,
    flyCheckAt: null,
    releaseAcceptedAt: null,
    recoveryStatus: null,
    recoveryError: null,
    imageRef: null,
    actorId: null,
    builderIdentityPubkey: null,
    builderAttestationPayload: null,
    builderAttestationSignature: null,
  },
  dvm: {
    id: "dvm-xyz",
    slug: "scrape",
    url: "https://dvmkit-scrape.fly.dev",
    dvmkitUrl: "https://builder--scrape.example.com",
  },
};

describe("deployStatus", () => {
  beforeEach(() => {
    vi.mocked(info).mockReset();
    vi.mocked(json).mockReset();
    vi.mocked(getDeployStatus).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a single JSON object on stdout in default (agent) mode", async () => {
    vi.mocked(getDeployStatus).mockResolvedValue(baseResponse);

    await deployStatus("dep-abc", {});

    expect(getDeployStatus).toHaveBeenCalledWith("https://platform.example", "tok", "dep-abc");
    expect(vi.mocked(json)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(json).mock.calls[0][0]).toEqual({
      status: "deployed",
      url: "https://dvmkit-scrape.fly.dev",
      dvmkitUrl: "https://builder--scrape.example.com",
      slug: "scrape",
      dvmId: "dvm-xyz",
      deployId: "dep-abc",
      startedAt: 1_747_500_000_000,
      endedAt: 1_747_500_090_000,
      error: null,
    });
    expect(vi.mocked(info)).not.toHaveBeenCalled();
  });

  it("emits human-readable lines on stderr in --human mode", async () => {
    vi.mocked(getDeployStatus).mockResolvedValue(baseResponse);

    await deployStatus("dep-abc", { human: true });

    const lines = vi.mocked(info).mock.calls.map(([msg]) => msg);
    expect(lines.join("\n")).toContain("Deploy:");
    expect(lines.join("\n")).toContain("dep-abc");
    expect(lines.join("\n")).toContain("Status:");
    expect(lines.join("\n")).toContain("deployed");
    expect(lines.join("\n")).toContain("Public:   https://builder--scrape.example.com");
    expect(lines.join("\n")).toContain("Upstream: https://dvmkit-scrape.fly.dev");
    expect(vi.mocked(json)).not.toHaveBeenCalled();
  });

  it("prints a cloud DVM's router address once in --human mode", async () => {
    vi.mocked(getDeployStatus).mockResolvedValue({
      ...baseResponse,
      dvm: { ...baseResponse.dvm, url: "https://builder--scrape.example.com" },
    });

    await deployStatus("dep-abc", { human: true });

    const text = vi
      .mocked(info)
      .mock.calls.map(([msg]) => msg)
      .join("\n");
    expect(text.split("https://builder--scrape.example.com")).toHaveLength(2);
    expect(text).not.toContain("Upstream:");
  });

  it("surfaces deploy.error in --human mode when status is failed", async () => {
    vi.mocked(getDeployStatus).mockResolvedValue({
      ...baseResponse,
      deploy: { ...baseResponse.deploy, status: "failed", error: "image push timed out" },
    });

    await deployStatus("dep-abc", { human: true });

    const lines = vi.mocked(info).mock.calls.map(([msg]) => msg);
    expect(lines.join("\n")).toContain("Error:");
    expect(lines.join("\n")).toContain("image push timed out");
  });

  it("reports an accepted unhealthy release and its automatic recovery in agent JSON", async () => {
    vi.mocked(getDeployStatus).mockResolvedValue({
      ...baseResponse,
      deploy: {
        ...baseResponse.deploy,
        status: "failed",
        error: "candidate failed health",
        releaseAcceptedAt: 1_747_500_060_000,
        recoveryStatus: "succeeded",
      },
      recovery: {
        deployId: "dep-recovery",
        status: "succeeded",
        targetDeployId: "dep-healthy",
        error: null,
      },
    });

    await deployStatus("dep-abc", {});

    expect(vi.mocked(json).mock.calls[0][0]).toMatchObject({
      status: "failed",
      error: "candidate failed health",
      releaseAccepted: true,
      recovery: {
        deployId: "dep-recovery",
        status: "succeeded",
        targetDeployId: "dep-healthy",
        error: null,
      },
    });
  });
});

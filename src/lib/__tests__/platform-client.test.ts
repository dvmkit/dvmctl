import { DvmError } from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeployPhase, DeployStatusResponse } from "../platform-client";
import {
  buildSshWsUrl,
  execCommand,
  getAuthenticatedBuilderProfile,
  getBuilderTrace,
  getDvm,
  getEvents,
  getMachineStatus,
  getMetrics,
  getRevenueCsv,
  getRevenueEvents,
  listBuilderOrgs,
  openSshSession,
  scaleDvm,
  startDeploy,
  streamDeployLogs,
  submitFeedback,
  sendBuilderFeedback,
  updateDvmSettings,
} from "../platform-client";

function makeOkResponse(body: unknown, traceparent?: string): Response {
  const headers = new Headers();
  if (traceparent) headers.set("traceparent", traceparent);
  return {
    ok: true,
    status: 200,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: unknown, traceparent?: string): Response {
  const headers = new Headers();
  if (traceparent) headers.set("traceparent", traceparent);
  return {
    ok: false,
    status,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const BASE_OPTS = {
  slug: "my-dvm",
  name: "My DVM",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startDeploy response validation", () => {
  it("returns parsed body on a valid response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeOkResponse({ deployId: "dep-1", dvmId: "dvm-fixture-1", slug: "my-dvm" })
    );

    const result = await startDeploy("https://platform.example", "tok", BASE_OPTS);
    expect(result).toEqual({ deployId: "dep-1", dvmId: "dvm-fixture-1", slug: "my-dvm" });
  });

  it("throws platform_response_invalid when dvmId is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse({ deployId: "dep-1", slug: "my-dvm" }));

    await expect(startDeploy("https://platform.example", "tok", BASE_OPTS)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "platform_response_invalid" &&
        (err.hint ?? "").includes("fly.platform.toml")
    );
  });

  it("throws platform_response_invalid when deployId is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse({ dvmId: "dvm-fixture-1", slug: "my-dvm" }));

    await expect(startDeploy("https://platform.example", "tok", BASE_OPTS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DvmError && err.code === "platform_response_invalid"
    );
  });

  it("throws platform_response_invalid when slug is missing", async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse({ deployId: "dep-1", dvmId: "dvm-fixture-1" }));

    await expect(startDeploy("https://platform.example", "tok", BASE_OPTS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DvmError && err.code === "platform_response_invalid"
    );
  });

  it("throws deploy_failed on non-ok HTTP response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(500, { error: { code: "deploy_failed", message: "Internal error" } })
    );

    await expect(startDeploy("https://platform.example", "tok", BASE_OPTS)).rejects.toSatisfy(
      (err: unknown) => err instanceof DvmError && err.code === "deploy_failed"
    );
  });

  it("does not retry a transport failure for the deploy POST", async () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    vi.mocked(fetch).mockRejectedValue(new TypeError("fetch failed", { cause }));

    await expect(startDeploy("https://platform.example", "tok", BASE_OPTS)).rejects.toMatchObject({
      code: "platform_unreachable",
      data: { attempts: 1, method: "POST", transport_code: "ECONNRESET" },
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("platform read transport retry", () => {
  it("retries idempotent reads and succeeds without exposing a transient fetch failure", async () => {
    const cause = Object.assign(new Error("dns lookup failed"), { code: "ENOTFOUND" });
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause }))
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause }))
      .mockResolvedValueOnce(makeOkResponse({ dvm: {}, deploys: [], domains: [] }));

    await expect(
      getDvm("https://platform.example", "tok", "550e8400-e29b-41d4-a716-446655440000")
    ).resolves.toMatchObject({ deploys: [], domains: [] });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });
});

describe("listBuilderOrgs", () => {
  it("returns shared and personal memberships from the existing builder orgs route", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeOkResponse({
        orgs: [
          {
            handle: "my-org",
            displayName: "My Org",
            avatarUrl: null,
            role: "admin",
            isPersonal: false,
          },
          {
            handle: "alice",
            displayName: "Alice",
            avatarUrl: null,
            role: "owner",
            isPersonal: true,
          },
        ],
      })
    );

    await expect(listBuilderOrgs("https://platform.example", "tok")).resolves.toEqual([
      {
        handle: "my-org",
        displayName: "My Org",
        avatarUrl: null,
        role: "admin",
        isPersonal: false,
      },
      {
        handle: "alice",
        displayName: "Alice",
        avatarUrl: null,
        role: "owner",
        isPersonal: true,
      },
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://platform.example/api/v1/builder/orgs",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      })
    );
  });

  it("maps a platform error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(403, { error: { code: "forbidden", message: "Forbidden" } })
    );

    await expect(listBuilderOrgs("https://platform.example", "tok")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("getAuthenticatedBuilderProfile", () => {
  it("returns the existing profile from the builder profile route", async () => {
    const builder = {
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
    vi.mocked(fetch).mockResolvedValue(makeOkResponse({ builder }));

    await expect(
      getAuthenticatedBuilderProfile("https://platform.example", "tok")
    ).resolves.toEqual(builder);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://platform.example/api/v1/builder/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      })
    );
  });

  it("maps a profile route error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(401, { error: { code: "auth_failed", message: "Invalid API key" } })
    );

    await expect(
      getAuthenticatedBuilderProfile("https://platform.example", "tok")
    ).rejects.toMatchObject({ code: "auth_failed" });
  });
});

/** Build a `Response` whose body emits the given SSE chunks then closes. */
function makeSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body: stream } as unknown as Response;
}

/**
 * Build a fetch mock that routes status-poll requests (the `:id` path, no
 * `/logs` suffix) to a separate queue from the SSE log stream. Lets a single
 * test exercise the SSE consumer and the poller in parallel.
 */
function routedFetch(opts: { sse: Response[]; status: DeployStatusResponse[] }): typeof fetch {
  const sseQueue = [...opts.sse];
  const statusQueue = [...opts.status];
  return ((url: string) => {
    if (url.endsWith("/logs")) {
      const next = sseQueue.shift();
      if (!next) throw new Error(`Unexpected SSE fetch for ${url}`);
      return Promise.resolve(next);
    }
    const next = statusQueue.shift();
    if (!next) throw new Error(`Unexpected status fetch for ${url}`);
    return Promise.resolve(makeOkResponse(next));
  }) as unknown as typeof fetch;
}

const HIGH_POLL_INTERVAL = 1_000_000;

const NOOP_HANDLERS = { onLog: (): void => {} };

describe("streamDeployLogs retry on unexpected close", () => {
  it("retries once when the stream closes without a terminal event and surfaces the persisted error", async () => {
    // First request drops mid-stream (machine restarted); second request hits
    // the terminal-state branch of the server's SSE handler with the
    // persisted `deploys.error` reason from the SIGTERM drain. High
    // pollIntervalMs keeps the poller out of the way so this exercises the
    // SSE-only path.
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeSseResponse(["event: log\ndata: building...\n\n"]))
      .mockResolvedValueOnce(
        makeSseResponse([
          'event: error\ndata: {"message":"Platform machine is restarting — deploy aborted before completion. Retry the deploy."}\n\n',
        ])
      );

    const logs: string[] = [];
    await expect(
      streamDeployLogs("https://platform.example", "tok", "dep-1", {
        onLog: (line) => logs.push(line),
        pollIntervalMs: HIGH_POLL_INTERVAL,
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "deploy_failed" &&
        err.message.includes("restarting")
    );
    expect(logs).toEqual(["building..."]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("returns the parsed result on first pass without retrying", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeSseResponse([
        'event: complete\ndata: {"url":"https://x.fly.dev","status":"deployed"}\n\n',
      ])
    );

    const result = await streamDeployLogs("https://platform.example", "tok", "dep-3", {
      ...NOOP_HANDLERS,
      pollIntervalMs: HIGH_POLL_INTERVAL,
    });
    expect(result).toEqual({ url: "https://x.fly.dev", status: "deployed" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "first stream", reconnect: false },
    { label: "reconnected stream", reconnect: true },
  ])("preserves accepted-release context for an error on the $label", async ({ reconnect }) => {
    const accepted =
      'event: accepted\ndata: {"deployId":"dep-4","url":"https://x.fly.dev","commitSha":"abc123"}\n\n';
    const terminalError = 'event: error\ndata: {"message":"metadata persistence failed"}\n\n';
    if (reconnect) {
      vi.mocked(fetch)
        .mockResolvedValueOnce(makeSseResponse([accepted]))
        .mockResolvedValueOnce(makeSseResponse([terminalError]));
    } else {
      vi.mocked(fetch).mockResolvedValueOnce(makeSseResponse([accepted, terminalError]));
    }

    await expect(
      streamDeployLogs("https://platform.example", "tok", "dep-4", {
        ...NOOP_HANDLERS,
        pollIntervalMs: HIGH_POLL_INTERVAL,
        streamRetryDelayMs: 0,
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "deploy_release_accepted_epilogue_failed" &&
        err.message.includes("metadata persistence failed") &&
        err.data?.outcome === "partial_success" &&
        err.data?.deploy_id === "dep-4" &&
        err.data?.terminal_error_code === "deploy_failed" &&
        JSON.stringify(err.data?.terminal_error) ===
          JSON.stringify({ _source: "provider", text: "metadata persistence failed" }) &&
        err.proseSources?.message === "provider" &&
        err.hint?.includes("/healthz") === true &&
        err.hint.includes("abc123")
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(reconnect ? 2 : 1);
  });
});

describe("streamDeployLogs status poller", () => {
  function statusResponse(
    status: "pending" | "building" | "deployed" | "failed",
    extras?: { error?: string; url?: string; dvmkitUrl?: string }
  ): DeployStatusResponse & { deploy: DeployStatusResponse["deploy"] & Record<string, unknown> } {
    return {
      deploy: {
        id: "dep-1",
        dvmId: "dvm-fixture-1",
        status,
        error: extras?.error ?? null,
        logs: null,
        startedAt: 0,
        endedAt: status === "deployed" || status === "failed" ? 1 : null,
        trigger: "cli",
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
        id: "dvm-fixture-1",
        slug: "my-dvm",
        url: extras?.url ?? "https://my-dvm.fly.dev",
        dvmkitUrl: extras?.dvmkitUrl ?? null,
      },
    };
  }

  it("emits phase ticks on each poll while the SSE stays silent", async () => {
    // SSE never delivers anything (closes immediately). Poller drives the show.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routedFetch({
          sse: [makeSseResponse([])],
          status: [
            statusResponse("building"),
            statusResponse("deployed", { dvmkitUrl: "https://builder--my-dvm.example.com" }),
          ],
        })
      )
    );

    const phases: DeployPhase[] = [];
    const result = await streamDeployLogs("https://platform.example", "tok", "dep-1", {
      onLog: () => {},
      onPhase: (p) => phases.push(p),
      pollIntervalMs: 10,
    });

    expect(result).toEqual({
      url: "https://my-dvm.fly.dev",
      status: "deployed",
      dvmkitUrl: "https://builder--my-dvm.example.com",
    });
    expect(phases.map((p) => p.status)).toEqual(["building", "deployed"]);
    expect(phases.every((p) => typeof p.elapsedMs === "number")).toBe(true);
  });

  it("short-circuits to deploy_failed when the poller sees status=failed", async () => {
    // SSE stays silent forever; the platform's heartbeat-lapse recovery has
    // flipped the row to failed with a reason. Poller surfaces it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routedFetch({
          sse: [makeSseResponse([])],
          status: [statusResponse("failed", { error: "Image push timed out" })],
        })
      )
    );

    await expect(
      streamDeployLogs("https://platform.example", "tok", "dep-1", {
        ...NOOP_HANDLERS,
        pollIntervalMs: 10,
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "deploy_failed" &&
        err.message.includes("Image push timed out")
    );
  });

  it("does not throw deploy_dropped when both SSE attempts drop — poller takes over and wins on deployed", async () => {
    // Both SSE attempts close without a terminal event. The poller is the
    // safety net (issue case c) — it eventually observes status=deployed and
    // resolves cleanly. Previously this threw `deploy_dropped`.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routedFetch({
          sse: [
            makeSseResponse(["event: log\ndata: x\n\n"]),
            makeSseResponse(["event: log\ndata: y\n\n"]),
          ],
          status: [statusResponse("deployed")],
        })
      )
    );

    const result = await streamDeployLogs("https://platform.example", "tok", "dep-1", {
      ...NOOP_HANDLERS,
      pollIntervalMs: 10,
    });
    expect(result.status).toBe("deployed");
  });

  it("keeps a poller-recovered accepted release distinct when the terminal stream was lost", async () => {
    const accepted =
      'event: accepted\ndata: {"deployId":"dep-1","url":"https://my-dvm.fly.dev","commitSha":"abc123"}\n\n';
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routedFetch({
          sse: [makeSseResponse([accepted]), makeSseResponse([])],
          status: [statusResponse("deployed")],
        })
      )
    );

    const result = await streamDeployLogs("https://platform.example", "tok", "dep-1", {
      ...NOOP_HANDLERS,
      pollIntervalMs: 10,
      streamRetryDelayMs: 0,
      recoveryTimeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: "deployed_unverified",
      url: "https://my-dvm.fly.dev",
    });
  });

  it("swallows transient poll errors and keeps trying", async () => {
    // First status poll errors; second succeeds with deployed. Should resolve
    // cleanly — a single 500 from the platform shouldn't kill the deploy.
    let statusCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/logs")) return Promise.resolve(makeSseResponse([]));
        statusCalls += 1;
        if (statusCalls === 1) {
          return Promise.resolve(makeErrorResponse(500, { error: { code: "x", message: "y" } }));
        }
        return Promise.resolve(makeOkResponse(statusResponse("deployed")));
      })
    );

    const result = await streamDeployLogs("https://platform.example", "tok", "dep-1", {
      ...NOOP_HANDLERS,
      pollIntervalMs: 10,
    });
    expect(result.status).toBe("deployed");
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it("reports a typed partial success when Fly accepted the release but status recovery stays offline", async () => {
    const accepted =
      'event: accepted\ndata: {"deployId":"dep-1","url":"https://my-dvm.fly.dev","commitSha":"abc123"}\n\n';
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    let logRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.endsWith("/logs")) {
          logRequests += 1;
          if (logRequests === 1) return Promise.resolve(makeSseResponse([accepted]));
          return Promise.reject(new TypeError("fetch failed", { cause }));
        }
        return Promise.reject(new TypeError("fetch failed", { cause }));
      })
    );

    await expect(
      streamDeployLogs("https://platform.example", "tok", "dep-1", {
        ...NOOP_HANDLERS,
        pollIntervalMs: HIGH_POLL_INTERVAL,
        streamRetryDelayMs: 0,
        recoveryTimeoutMs: 5,
      })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "deploy_release_accepted_status_unknown" &&
        err.data?.outcome === "partial_success" &&
        err.data?.deploy_id === "dep-1" &&
        err.data?.transport_code === "ECONNRESET" &&
        err.hint?.includes("/healthz") === true &&
        err.hint.includes("abc123")
    );
    expect(logRequests).toBe(4); // first stream + three idempotent reconnect attempts
  });
});

describe("execCommand", () => {
  it("posts the command and returns the parsed result", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeOkResponse({ stdout: "ok\n", stderr: "", exit_code: 0, machine_id: "m1" })
    );

    const result = await execCommand("https://platform.example", "tok", "my-dvm", "echo ok", {
      machine: "m1",
    });
    expect(result).toEqual({ stdout: "ok\n", stderr: "", exit_code: 0, machine_id: "m1" });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://platform.example/api/v1/builder/dvms/my-dvm/exec");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ command: "echo ok", machine: "m1" });
  });

  it("throws a DvmError carrying the error envelope on non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(409, { error: { code: "no_running_machine", message: "none" } })
    );

    await expect(
      execCommand("https://platform.example", "tok", "my-dvm", "echo ok")
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError && err.code === "no_running_machine" && err.message === "none"
    );
  });
});

describe("getMachineStatus", () => {
  it("GETs the status route and returns the parsed result", async () => {
    const payload = {
      slug: "my-dvm",
      machines: [
        {
          id: "m1",
          state: "started",
          region: "iad",
          instance_id: "i1",
          created: "2026-05-19T10:00:00Z",
          started: "2026-05-19T10:00:05Z",
          image: { version: "deployment-1", sha: "sha256:abc" },
          checks: [{ name: "health", status: "passing", output: "ok", endpoint: ":8080/health" }],
        },
      ],
      scale: { count: 1, vm_size: { cpus: 1, cpu_kind: "shared", memory_mb: 256 } },
    };
    vi.mocked(fetch).mockResolvedValue(makeOkResponse(payload));

    const result = await getMachineStatus(
      "https://platform.example",
      "tok",
      "550e8400-e29b-41d4-a716-446655440000"
    );
    expect(result).toEqual(payload);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://platform.example/api/v1/builder/dvms/550e8400-e29b-41d4-a716-446655440000/status"
    );
    expect(init.method).toBeUndefined();
  });

  it("throws a DvmError carrying the error envelope on non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(404, { error: { code: "not_found", message: "DVM not found" } })
    );

    await expect(
      getMachineStatus("https://platform.example", "tok", "550e8400-e29b-41d4-a716-446655440000")
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError && err.code === "not_found" && err.message === "DVM not found"
    );
  });
});

describe("ID-first DVM reads", () => {
  it("uses an immutable DVM ID for detail, metrics, and events routes", async () => {
    const dvmId = "550e8400-e29b-41d4-a716-446655440000";
    vi.mocked(fetch)
      .mockResolvedValueOnce(makeOkResponse({ dvm: {}, deploys: [], domains: [] }))
      .mockResolvedValueOnce(makeOkResponse({ metrics: [] }))
      .mockResolvedValueOnce(makeOkResponse({ slug: "my-dvm", since: "24h", events: [] }));

    await getDvm("https://platform.example", "tok", dvmId);
    await getMetrics("https://platform.example", "tok", dvmId, 24);
    await getEvents("https://platform.example", "tok", dvmId, { since: "24h" });

    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      `https://platform.example/api/v1/builder/dvms/${dvmId}`,
      `https://platform.example/api/v1/builder/dvms/${dvmId}/metrics?hours=24`,
      `https://platform.example/api/v1/builder/dvms/${dvmId}/events?since=24h`,
    ]);
  });
});

describe("scaleDvm", () => {
  it("posts count and size and returns the before/after result", async () => {
    const after = {
      memoryMb: 512,
      cpuCount: 2,
      cpuKind: "shared",
      minMachinesRunning: 0,
      maxMachines: 2,
    };
    const before = { ...after, memoryMb: 256, cpuCount: 1, maxMachines: 1 };
    vi.mocked(fetch).mockResolvedValue(makeOkResponse({ slug: "my-dvm", before, after }));

    const result = await scaleDvm("https://platform.example", "tok", "my-dvm", {
      count: 2,
      size: "shared-cpu-2x",
    });
    expect(result).toEqual({ slug: "my-dvm", before, after });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://platform.example/api/v1/builder/dvms/my-dvm/scale");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ count: 2, size: "shared-cpu-2x" });
  });

  it("omits unset fields from the request body", async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse({ slug: "my-dvm", before: {}, after: {} }));
    await scaleDvm("https://platform.example", "tok", "my-dvm", { count: 3 });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ count: 3 });
  });

  it("throws a DvmError carrying the upgrade data on plan-limit 402", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(402, {
        error: {
          code: "plan_limit_exceeded",
          message: "Upgrade to run more machines.",
          data: { upgradeUrl: "https://dvmkit.com/dashboard/billing", cap: 1 },
        },
      })
    );

    await expect(
      scaleDvm("https://platform.example", "tok", "my-dvm", { count: 4 })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "plan_limit_exceeded" &&
        err.data?.upgradeUrl === "https://dvmkit.com/dashboard/billing"
    );
  });
});

describe("buildSshWsUrl", () => {
  it("maps https to wss", () => {
    expect(buildSshWsUrl("https://api.dvmkit.dev", "cast")).toBe(
      "wss://api.dvmkit.dev/api/v1/builder/dvms/cast/ssh"
    );
  });

  it("maps http to ws and appends the machine selector", () => {
    expect(buildSshWsUrl("http://localhost:8080", "my-dvm", "148e2deef03e89")).toBe(
      "ws://localhost:8080/api/v1/builder/dvms/my-dvm/ssh?machine=148e2deef03e89"
    );
  });

  it("trims a trailing slash on the platform url", () => {
    expect(buildSshWsUrl("https://api.dvmkit.dev/", "cast")).toBe(
      "wss://api.dvmkit.dev/api/v1/builder/dvms/cast/ssh"
    );
  });
});

describe("openSshSession", () => {
  it("rejects with not_a_tty when stdin is not a terminal", async () => {
    // vitest runs without an attached TTY, so the guard fires before any socket
    // is opened.
    await expect(openSshSession("https://platform.example", "tok", "my-dvm")).rejects.toSatisfy(
      (err: unknown) => err instanceof DvmError && err.code === "not_a_tty"
    );
  });
});

describe("org-scoped read errors", () => {
  it("explains a membership 404 in terms of the org that was asked for", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(404, { error: { code: "not_found", message: "Org not found" } })
    );

    await expect(
      getBuilderTrace("https://platform.example", "tok", "abc", { org: "dvmkit" })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "not_found" &&
        (err.hint ?? "").includes('No org "dvmkit" you can see')
    );
  });

  // The bug this guards: a genuinely-missing trace 404s too, and retelling it
  // as "you're not in that org" is a wrong sentence an agent relays verbatim.
  it("leaves a route's own 404 alone rather than blaming membership", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(404, {
        error: {
          code: "trace_not_found",
          message: 'No spans found for trace abc in org "dvmkit"',
          display:
            'No trace abc in org "dvmkit". Check the ID, or pass `--org` if it belongs to another org.',
        },
      })
    );

    await expect(
      getBuilderTrace("https://platform.example", "tok", "abc", { org: "dvmkit" })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "trace_not_found" &&
        (err.display ?? "").startsWith("No trace abc") &&
        !(err.hint ?? "").includes("ask an admin to invite you")
    );
  });

  // The platform means different things by the two fields — `display` is prose
  // the agent relays to its human verbatim, `hint` is the agent's own next
  // step. `orgScopedError` used to collapse `display` into `hint`, dropping
  // whichever the platform actually sent.
  it("carries the platform's display and hint through under their own names", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(400, {
        error: {
          code: "invalid_trace_id",
          message: "traceId must be a 32-hex-char trace ID.",
          display: "That trace ID doesn't look right.",
          hint: "Copy the trace_id from a job receipt's `traceparent`.",
        },
      })
    );

    await expect(
      getBuilderTrace("https://platform.example", "tok", "abc", { org: "dvmkit" })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "invalid_trace_id" &&
        err.display === "That trace ID doesn't look right." &&
        err.hint === "Copy the trace_id from a job receipt's `traceparent`." &&
        err.proseSources?.message === "provider" &&
        err.proseSources.display === "provider" &&
        err.proseSources.hint === "provider"
    );
  });

  it("names the role gate on a 403", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(403, { error: { code: "forbidden", message: "Admin role required" } })
    );

    await expect(
      getRevenueEvents("https://platform.example", "tok", { org: "dvmkit" })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError && (err.hint ?? "").includes('Your role in org "dvmkit" is too low')
    );
  });

  it("reads the CSV export's scope off the X-Org header", async () => {
    const headers = new Headers({ "X-Org": "dvmkit" });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers,
      text: () => Promise.resolve("date,amount\r\n"),
    } as unknown as Response);

    const result = await getRevenueCsv("https://platform.example", "tok", {
      from: "2026-01-01",
      to: "2026-01-31",
      org: "dvmkit",
    });
    expect(result).toEqual({ csv: "date,amount\r\n", org: "dvmkit" });
  });

  it("falls back to `personal` when the export carries no scope header", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.resolve(""),
    } as unknown as Response);

    const result = await getRevenueCsv("https://platform.example", "tok", {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(result.org).toBe("personal");
  });
});

describe("submitFeedback error mapping", () => {
  // The platform means different things by the two fields — `display` is prose
  // the agent relays to its human verbatim, `hint` is the agent's own next
  // step. Collapsing them onto one slot dropped whichever the platform sent.
  it("carries the platform's display and hint through under their own names", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(400, {
        error: {
          code: "invalid_dvm_id",
          message: "dvm_id must be a DVM's immutable UUID — got 'narrate'.",
          display: "This feedback was addressed with the wrong kind of DVM identifier.",
          hint: "Read dvm_id from a `dvm search` result row.",
        },
      })
    );

    await expect(submitFeedback("https://platform.example", { body: "hi" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "invalid_dvm_id" &&
        err.display === "This feedback was addressed with the wrong kind of DVM identifier." &&
        err.hint === "Read dvm_id from a `dvm search` result row."
    );
  });

  it("leaves hint unset when the platform sent display alone", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(429, {
        error: {
          code: "rate_limited",
          message: "Rate limit exceeded.",
          display: "You've submitted 20 feedback messages in the last 24h.",
        },
      })
    );

    await expect(submitFeedback("https://platform.example", { body: "hi" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.display === "You've submitted 20 feedback messages in the last 24h." &&
        err.hint === undefined
    );
  });
});

describe("updateDvmSettings error mapping", () => {
  it("carries the platform's display and hint through under their own names", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(400, {
        error: {
          code: "invalid_settings",
          message: "feedback_enabled must be a boolean.",
          display: "That setting value isn't valid.",
          hint: "Pass `--feedback-enabled` as true or false.",
        },
      })
    );

    await expect(
      updateDvmSettings("https://platform.example", "tok", "dvm-fixture-1", { feedback_enabled: true })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.code === "invalid_settings" &&
        err.display === "That setting value isn't valid." &&
        err.hint === "Pass `--feedback-enabled` as true or false."
    );
  });

  it("leaves hint unset when the platform sent display alone", async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeErrorResponse(403, {
        error: {
          code: "forbidden",
          message: "Admin role required.",
          display: "Only an org admin can change this DVM's settings.",
        },
      })
    );

    await expect(
      updateDvmSettings("https://platform.example", "tok", "dvm-fixture-1", { feedback_enabled: true })
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof DvmError &&
        err.display === "Only an org admin can change this DVM's settings." &&
        err.hint === undefined
    );
  });
});


describe("sendBuilderFeedback wire contract", () => {
  it("posts builder auth, selected org, and only the specified submission", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers(),
      json: async () => ({ id: "fb-1", created_at: "2026-09-29T12:00:00Z", display: "Sent to the dvmkit team." }),
    } as Response);
    const submission = { body: "Deploy was slow", trace_id: "trace-1", context: { command: "deploy", trigger: "failure" as const } };
    const result = await sendBuilderFeedback("https://platform.example", "tok", submission, "team");
    expect(result.id).toBe("fb-1");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://platform.example/api/v1/builder/feedback?org=team");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: JSON.stringify(submission) });
  });
  it("preserves a platform house error", async () => {
    vi.mocked(fetch).mockResolvedValue(makeErrorResponse(429, { error: { code: "rate_limited", message: "Too many feedback submissions" } }));
    await expect(sendBuilderFeedback("https://platform.example", "tok", { body: "Hello" })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

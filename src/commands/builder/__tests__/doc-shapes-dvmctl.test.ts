/**
 * Compare real handler output with documented JSON shapes and timestamp units.
 * Typed dependency fixtures also make API field renames fail compilation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compareShape, extractJsonFences, resolveFence } from "../../../../scripts/cli-doc-shapes";
import { gitRunner } from "../../../test-support/git-sandbox";
import { SPAWN_HEAVY_TIMEOUT } from "../../../test-support/spawn-budget";

vi.mock("../../../lib/platform-client");
vi.mock("../../../shared/builder-store", () => ({
  loadIdentityPubkey: vi.fn(() => "a".repeat(64)),
}));
vi.mock("../../../lib/platform", () => ({
  requireAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  resolveAuth: vi.fn(() => ({ token: "tok", platformUrl: "https://platform.example" })),
  loadActiveOrg: vi.fn(() => "my-org"),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org ?? "my-org"),
  saveActiveOrg: vi.fn(),
  clearActiveOrg: vi.fn(),
}));
vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
  progress: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("../../../lib/db-tunnel-client", () => ({
  openDbTunnel: vi.fn(),
}));
vi.mock("../../../lib/keep-alive", () => ({
  blockUntilShutdown: vi.fn(() => Promise.resolve()),
}));

import type { TraceResult } from "../../../lib/platform-api-types";
import type { DbTunnel } from "../../../lib/db-tunnel-client";
import { openDbTunnel } from "../../../lib/db-tunnel-client";
import type {
  ApiKeyCreateResult,
  ApiKeysListResult,
  BuilderDvmView,
  BuilderOrgMembership,
  DeployResult,
  DeployStatusResponse,
  EventsResult,
  ExecResult,
  ListBuilderFeedbackResult,
  OrgMembershipInfo,
  PauseResult,
  ReadScopeInfo,
  RestartResult,
  RevenueEventsResult,
  RevenueSeriesResult,
  RollbackResult,
  ScaleResult,
  SecretInfo,
  StatusResult,
  TransferResult,
} from "../../../lib/platform-client";
import * as platformClient from "../../../lib/platform-client";
import type {
  Builder,
  BuilderDeploy,
  BuilderDvmWithRevenue,
  Domain,
  RequestMetric,
} from "../../../builder-platform/types";
import { json } from "../../../shared/output";
import { apiKeysCreate } from "../api-keys-create";
import { apiKeysList } from "../api-keys-list";
import { apiKeysRevoke } from "../api-keys-revoke";
import { dbProxy } from "../db-proxy";
import { deployStatus } from "../deploy-status";
import { destroy } from "../destroy";
import { domains } from "../domains";
import { env } from "../env";
import { events } from "../events";
import { feedbackDisable, feedbackEnable, feedbackList } from "../feedback";
import { handle, handleCheck } from "../handle";
import { dvmInfo } from "../info";
import { list } from "../list";
import { metrics } from "../metrics";
import { orgs } from "../orgs";
import { pause } from "../pause";
import { restart } from "../restart";
import { resume } from "../resume";
import { revenueEvents } from "../revenue-events";
import { revenueSummary } from "../revenue-summary";
import { rollback } from "../rollback";
import { scale } from "../scale";
import { secretsList } from "../secrets-list";
import { ssh } from "../ssh";
import { status } from "../status";
import { switchCmd } from "../switch";
import { traceGet } from "../trace-get";
import { transfer } from "../transfer";
import { whoami } from "../whoami";

const FENCES = extractJsonFences(
  readFileSync(resolve(import.meta.dirname, "../../../../fixtures/cli-dvmctl.mdx"), "utf8")
);

/** The object the handler passed to `json()` (single call per case; mocks reset between cases). */
function captured(): unknown {
  expect(vi.mocked(json)).toHaveBeenCalledTimes(1);
  return vi.mocked(json).mock.calls[0][0];
}

/** Assert the `## section` fence matching `scenario` is exactly what the handler printed. */
function expectMatchesDoc(section: string, scenario = "default"): void {
  expect(compareShape(resolveFence(FENCES, section, scenario), captured())).toEqual([]);
}

/** The org scope every read route echoes — here, the `dvmctl switch` context. */
const READ_SCOPE: ReadScopeInfo = {
  id: "acffd753-105a-4958-9f37-243ac032f332",
  handle: "my-org",
  role: "admin",
  personal: false,
};

/** The builder projection every DVM-returning endpoint answers with (`builderDvmWithRevenue`). */
const DVM_ROW: BuilderDvmWithRevenue = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  orgId: "acffd753-105a-4958-9f37-243ac032f332",
  slug: "my-dvm",
  name: "My DVM",
  url: "https://dvmkit-my-dvm.fly.dev",
  dvmkitUrl: "https://alice--my-dvm.dvmkit.ai",
  status: "deployed",
  runtime: "container",
  dvmMeta: { name: "My DVM", description: "Does something useful", tags: ["text"], price: "$0.01" },
  hidden: false,
  region: "iad",
  suspensionReason: null,
  pausedAt: null,
  githubRepoFullName: null,
  gitBranch: null,
  rootDir: null,
  entrypoint: null,
  endpointUrl: null,
  lastJobAt: 1_745_000_000_000,
  feedbackEnabled: true,
  createdAt: 1_744_000_000_000,
  updatedAt: 1_745_000_000_000,
  lifetimeRevenueFiatMinor: 14_237,
};

const DOMAIN_ROW: Domain & Record<string, unknown> = {
  id: "7c2ab918-3ef4-4a21-8d6c-0b5e1f9a2d84",
  orgId: "acffd753-105a-4958-9f37-243ac032f332",
  dvmId: "550e8400-e29b-41d4-a716-446655440000",
  domain: "api.example.com",
  status: "verified",
  verificationAttemptedAt: 1_746_489_600_000,
  createdAt: 1_746_489_600_000,
  updatedAt: 1_746_489_600_000,
};

const BUILDER_PROFILE: Builder & Record<string, unknown> = {
  id: "bld_123",
  email: "builder@example.com",
  handle: "builder",
  authId: "auth_123",
  displayName: "Builder",
  bio: null,
  avatarUrl: null,
  website: null,
  links: {},
  isOperator: false,
  createdAt: 1_744_000_000_000,
  updatedAt: 1_745_000_000_000,
};

describe("cli-dvmctl.mdx output shapes", () => {
  beforeEach(() => {
    vi.mocked(json).mockReset();
    vi.mocked(platformClient.listDvms).mockResolvedValue({
      dvms: [DVM_ROW, { ...DVM_ROW, slug: "cast" }],
      org: READ_SCOPE,
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Deploy lifecycle ────────────────────────────────────────────────

  it("deploy-status — a deploy still building (epoch-ms startedAt, null endedAt/error)", async () => {
    const response: DeployStatusResponse & { deploy: DeployStatusResponse["deploy"] & Record<string, unknown> } = {
      deploy: {
        id: "3dcc9623-8db4-4c03-9929-a0cd5841c1d2",
        dvmId: "550e8400-e29b-41d4-a716-446655440000",
        status: "building",
        error: null,
        logs: null,
        startedAt: 1_747_785_600_000,
        endedAt: null,
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
      // `url` is the Fly origin; the dvmkit.ai host only ever appears in
      // `dvmkitUrl`, and only once the owning org has a handle.
      dvm: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        slug: "my-dvm",
        url: "https://dvmkit-my-dvm.fly.dev",
        dvmkitUrl: "https://alice--my-dvm.dvmkit.ai",
      },
    };
    vi.mocked(platformClient.getDeployStatus).mockResolvedValue(response);

    await deployStatus("3dcc9623-8db4-4c03-9929-a0cd5841c1d2", {});

    expectMatchesDoc("deploy-status");
  });

  it("rollback — the new deploy's result, plus the deploy it reverted to", async () => {
    const queued: RollbackResult = {
      deployId: "9f1c4e07-2b55-4a3e-9f0d-71a2c8b4d611",
      slug: "my-dvm",
      rolledBackTo: "3dcc9623-8db4-4c03-9929-a0cd5841c1d2",
    };
    const deployed: DeployResult = {
      status: "deployed",
      url: "https://dvmkit-my-dvm.fly.dev",
      dvmkitUrl: "https://alice--my-dvm.dvmkit.ai",
    };
    vi.mocked(platformClient.rollbackDvm).mockResolvedValue(queued);
    vi.mocked(platformClient.streamDeployLogs).mockResolvedValue(deployed);

    await rollback("my-dvm", {});

    expectMatchesDoc("rollback");
  });

  it("destroy — slug plus whether the database survived", async () => {
    vi.mocked(platformClient.destroyDvm).mockResolvedValue({
      status: "destroyed",
      dvmId: "550e8400-e29b-41d4-a716-446655440000",
      slug: "my-dvm",
      keptDb: false,
    });

    await destroy("my-dvm", { confirm: true });

    expectMatchesDoc("destroy");
  });

  // ── Inventory ───────────────────────────────────────────────────────

  it("list — the full builder projection per row, incl. lifetime revenue", async () => {
    vi.mocked(platformClient.listDvms).mockResolvedValue({ dvms: [DVM_ROW], org: READ_SCOPE });

    await list({});

    expectMatchesDoc("list");
  });

  it("info — DVM projection + orgHandle, deploy projections, domain rows", async () => {
    const dvm: BuilderDvmView = { ...DVM_ROW, orgHandle: null };
    const deploys: BuilderDeploy[] = [
      {
        id: "3dcc9623-8db4-4c03-9929-a0cd5841c1d2",
        dvmId: "550e8400-e29b-41d4-a716-446655440000",
        status: "deployed",
        error: null,
        logs: null,
        startedAt: 1_744_999_000_000,
        endedAt: 1_745_000_000_000,
        trigger: "cli",
        commitSha: null,
        commitRef: null,
        commitMessage: null,
        commitAuthorName: null,
      },
    ];
    vi.mocked(platformClient.getDvm).mockResolvedValue({
      dvm,
      deploys,
      domains: [{ ...DOMAIN_ROW, domain: "my-dvm.example.com" }],
    });

    await dvmInfo("my-dvm", {});

    expectMatchesDoc("info");
  });

  it("status — live machine state (ISO timestamps, nested image + checks array)", async () => {
    const result: StatusResult = {
      slug: "my-dvm",
      status: "deployed",
      paused: false,
      suspensionReason: null,
      withdrawal: null,
      reclaimsOpen: true,
      machines: [
        {
          id: "148e2deef03e89",
          state: "started",
          region: "iad",
          instance_id: "01J9Z000000000000000000000",
          created: "2026-05-19T10:00:00Z",
          started: "2026-05-19T10:00:05Z",
          image: { version: "deployment-01J9Z", sha: "sha256:abc123" },
          checks: [
            { name: "health", status: "passing", output: "200 OK", endpoint: ":8080/health" },
          ],
        },
      ],
      scale: { count: 1, vm_size: { cpus: 1, cpu_kind: "shared", memory_mb: 256 } },
    };
    vi.mocked(platformClient.getMachineStatus).mockResolvedValue(result);

    await status("my-dvm", {});

    expectMatchesDoc("status");
  });

  // ── Runtime control ─────────────────────────────────────────────────

  it("pause — machines stopping, DVM suspended with the builder_pause reason", async () => {
    const result: PauseResult = {
      slug: "my-dvm",
      status: "suspended",
      paused: true,
      machines: [{ id: "148e2deef03e89", state: "stopping" }],
      stopped: 1,
    };
    vi.mocked(platformClient.pauseDvm).mockResolvedValue(result);

    await pause("my-dvm", {});

    expectMatchesDoc("pause");
  });

  it("resume — machines started, DVM back to deployed", async () => {
    const result: PauseResult = {
      slug: "my-dvm",
      status: "deployed",
      paused: false,
      machines: [{ id: "148e2deef03e89", state: "started" }],
      started: 1,
    };
    vi.mocked(platformClient.resumeDvm).mockResolvedValue(result);

    await resume("my-dvm", {});

    expectMatchesDoc("resume");
  });

  it("restart — post-restart machine states + how many were restarted", async () => {
    const result: RestartResult = {
      machines: [{ id: "148e2deef03e89", state: "started" }],
      restarted: 1,
    };
    vi.mocked(platformClient.restartMachines).mockResolvedValue(result);

    await restart("my-dvm", {});

    expectMatchesDoc("restart");
  });

  it("scale — resolved VM config before and after", async () => {
    const result: ScaleResult = {
      slug: "my-dvm",
      before: {
        memoryMb: 256,
        cpuCount: 1,
        cpuKind: "shared",
        minMachinesRunning: 0,
        maxMachines: 1,
      },
      after: {
        memoryMb: 512,
        cpuCount: 2,
        cpuKind: "shared",
        minMachinesRunning: 0,
        maxMachines: 2,
      },
    };
    vi.mocked(platformClient.scaleDvm).mockResolvedValue(result);

    await scale("my-dvm", { count: "2", size: "shared-cpu-2x" });

    expectMatchesDoc("scale");
  });

  it("ssh --command — one-shot exec result (stdout/stderr/exit code/machine)", async () => {
    const result: ExecResult = {
      stdout: "running\n",
      stderr: "",
      exit_code: 0,
      machine_id: "148e2deef03e89",
    };
    vi.mocked(platformClient.execCommand).mockResolvedValue(result);
    // `ssh` propagates the remote exit code by calling process.exit directly.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await ssh("my-dvm", { command: "echo running" });

    expectMatchesDoc("ssh", "one-shot");
    exit.mockRestore();
  });

  it("ssh --command marks a failed remote exit before JSON is emitted", async () => {
    vi.mocked(platformClient.execCommand).mockResolvedValue({ stdout: "", stderr: "failed", exit_code: 9, machine_id: "machine-1" });
    let exitCodeAtOutput: number | string | undefined;
    vi.mocked(json).mockImplementationOnce(() => { exitCodeAtOutput = process.exitCode ?? undefined; });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await ssh("my-dvm", { command: "false" });
      expect(exitCodeAtOutput).toBe(9);
      expect(exit).toHaveBeenCalledWith(9);
    } finally {
      process.exitCode = undefined;
      exit.mockRestore();
    }
  });

  // ── Observability ───────────────────────────────────────────────────

  it("metrics — slug + window + hourly buckets", async () => {
    const buckets: RequestMetric[] = [
      {
        dvmId: "550e8400-e29b-41d4-a716-446655440000",
        hour: 1_746_489_600_000,
        status2xx: 40,
        status4xx: 1,
        status5xx: 1,
        totalRequests: 42,
        totalLatencyMs: 84_000,
        egressBytes: 1_048_576,
      },
    ];
    vi.mocked(platformClient.getMetrics).mockResolvedValue(buckets);

    await metrics("my-dvm", {});

    expect(platformClient.getMetrics).toHaveBeenCalledWith(
      "https://platform.example",
      "tok",
      DVM_ROW.id,
      24
    );
    expectMatchesDoc("metrics");
  });

  it("events — merged deploy/audit/machine feed with source-specific details", async () => {
    const result: EventsResult = {
      slug: "my-dvm",
      since: "7d",
      events: [
        {
          type: "deploy",
          timestamp: 1_715_000_000_000,
          actor: "alice",
          source: "deploy",
          details: {
            id: "3dcc9623-8db4-4c03-9929-a0cd5841c1d2",
            status: "deployed",
            trigger: "cli",
            durationMs: 64_000,
            commitSha: "a1b2c3d",
            commitRef: "main",
            commitMessage: "Tighten retry backoff",
            error: null,
          },
        },
      ],
    };
    vi.mocked(platformClient.getEvents).mockResolvedValue(result);

    await events("my-dvm", {});

    expectMatchesDoc("events");
  });

  // ── Config ──────────────────────────────────────────────────────────

  it("env (list) — slug + the names only, never the values", async () => {
    vi.mocked(platformClient.getEnv).mockResolvedValue(["API_KEY", "MODEL"]);

    await env("my-dvm", {});

    expectMatchesDoc("env", "list");
  });

  it("env (write) — what was set and what was removed", async () => {
    vi.mocked(platformClient.setEnv).mockResolvedValue(undefined);

    await env("my-dvm", { set: ["API_KEY=abc", "MODEL=sonnet"], unset: ["OLD_KEY"] });

    expectMatchesDoc("env", "after set/unset");
  });

  it("secrets list — slug + secrets array (ISO last_applied_at)", async () => {
    const secrets: SecretInfo[] = [
      {
        name: "SPOTIFY_CLIENT_ID",
        last_applied_at: "2026-05-10T09:12:00Z",
        digest_hash: "sha256:deadbeef",
      },
    ];
    vi.mocked(platformClient.listSecrets).mockResolvedValue(secrets);

    await secretsList("cast", {});

    expectMatchesDoc("secrets list");
  });

  // ── Identity & routing ──────────────────────────────────────────────

  it("handle set — the claimed handle, the prerequisite for any dvmkit.ai URL", async () => {
    vi.mocked(platformClient.setHandle).mockResolvedValue(undefined);

    await handle("alice", {});

    expectMatchesDoc("handle set");
  });

  it("handle check — availability without claiming", async () => {
    vi.mocked(platformClient.checkHandle).mockResolvedValue({ available: true });

    await handleCheck("alice", {});

    expectMatchesDoc("handle check");
  });

  it("domains list — the raw domain rows (status enum, not a verified boolean)", async () => {
    vi.mocked(platformClient.listDomains).mockResolvedValue([DOMAIN_ROW]);

    await domains("list", "my-dvm", {});

    expectMatchesDoc("domains list");
  });

  it("domains add — the acknowledged domain", async () => {
    vi.mocked(platformClient.addDomain).mockResolvedValue({ hint: "Point DNS at the router." });

    await domains("add", "my-dvm", { domain: "api.example.com" });

    expectMatchesDoc("domains add");
  });

  it("domains remove — the removed domain", async () => {
    vi.mocked(platformClient.removeDomain).mockResolvedValue(undefined);

    await domains("remove", "my-dvm", { domain: "api.example.com" });

    expectMatchesDoc("domains remove");
  });

  it("domains verify — the verified domain", async () => {
    vi.mocked(platformClient.verifyDomain).mockResolvedValue(undefined);

    await domains("verify", "my-dvm", { domain: "api.example.com" });

    expectMatchesDoc("domains verify");
  });

  // ── Org context ─────────────────────────────────────────────────────

  it("switch (no args) — the persisted active org", async () => {
    await switchCmd(undefined, {});

    expectMatchesDoc("switch", "show current");
  });

  it("switch <org> — the org switched into, plus the caller's role in it", async () => {
    const membership: OrgMembershipInfo = {
      handle: "my-org",
      displayName: "My Org",
      role: "owner",
    };
    vi.mocked(platformClient.getOrgMembership).mockResolvedValue(membership);

    await switchCmd("my-org", {});

    expectMatchesDoc("switch", "after switch");
  });

  it("switch --personal — context cleared", async () => {
    await switchCmd(undefined, { personal: true });

    expectMatchesDoc("switch", "after --personal");
  });

  it("orgs — memberships with active context and no personal-org handle", async () => {
    const memberships: BuilderOrgMembership[] = [
      {
        handle: "my-org",
        displayName: "My Org",
        avatarUrl: null,
        role: "owner",
        isPersonal: false,
      },
      {
        handle: "alice",
        displayName: "Alice",
        avatarUrl: null,
        role: "owner",
        isPersonal: true,
      },
    ];
    vi.mocked(platformClient.listBuilderOrgs).mockResolvedValue(memberships);

    await orgs({});

    expectMatchesDoc("orgs");
  });

  it("whoami — identity, builder profile, memberships, and active context", async () => {
    const memberships: BuilderOrgMembership[] = [
      {
        handle: "my-org",
        displayName: "My Org",
        avatarUrl: null,
        role: "owner",
        isPersonal: false,
      },
      {
        handle: "builder",
        displayName: "Builder",
        avatarUrl: null,
        role: "owner",
        isPersonal: true,
      },
    ];
    vi.mocked(platformClient.getAuthenticatedBuilderProfile).mockResolvedValue(BUILDER_PROFILE);
    vi.mocked(platformClient.listBuilderOrgs).mockResolvedValue(memberships);

    await whoami({});

    expectMatchesDoc("whoami");
  });

  it("transfer — the new owner, plus whether a treasury re-key is pending", async () => {
    const result: TransferResult = {
      status: "transferred",
      slug: "my-dvm",
      to: "acme",
      org: { id: "acffd753-105a-4958-9f37-243ac032f332", handle: "acme" },
      treasuryRekeyPending: true,
    };
    vi.mocked(platformClient.transferDvm).mockResolvedValue(result);

    await transfer("my-dvm", "acme", { createOrg: true });

    expectMatchesDoc("transfer");
  });

  // ── Feedback ────────────────────────────────────────────────────────

  it("feedback list — rows + the cursor to walk older pages", async () => {
    const result: ListBuilderFeedbackResult = {
      feedback: [
        {
          id: "b41e7a52-9d38-4f6b-a0c7-2e58d3f1c964",
          dvm_id: "dvm-my-dvm",
          slug: "my-dvm",
          owner_handle: "my-org",
          job_id: null,
          trace_id: null,
          caller_pubkey: "02abcdef",
          body: "Search ranks recency too low",
          created_at: "2026-05-27T12:00:00.000Z",
        },
      ],
      next_cursor: null,
      org: READ_SCOPE,
    };
    vi.mocked(platformClient.listBuilderFeedback).mockResolvedValue(result);

    await feedbackList("my-dvm", {});

    expectMatchesDoc("feedback list");
  });

  it("feedback enable — the settings block echoed back", async () => {
    vi.mocked(platformClient.updateDvmSettings).mockResolvedValue({
      dvm_id: "dvm-my-dvm",
      slug: "my-dvm",
      settings: { feedback_enabled: true },
    });

    await feedbackEnable("my-dvm", {});

    expectMatchesDoc("feedback enable");
  });

  it("feedback disable — the settings block echoed back", async () => {
    vi.mocked(platformClient.updateDvmSettings).mockResolvedValue({
      dvm_id: "dvm-my-dvm",
      slug: "my-dvm",
      settings: { feedback_enabled: false },
    });

    await feedbackDisable("my-dvm", {});

    expectMatchesDoc("feedback disable");
  });

  // ── Database ────────────────────────────────────────────────────────

  it("db proxy — the bound port and the connection string a client should use", async () => {
    const tunnel: DbTunnel = {
      ready: { user: "postgres", password: "pw", database: "my_dvm" },
      attach: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    vi.mocked(openDbTunnel).mockResolvedValue(tunnel);

    await dbProxy("my-dvm", {});

    expectMatchesDoc("db proxy");
  });

  it("trace get — the trace envelope + its spans (its own trace_id, not the injected one)", async () => {
    const result: TraceResult = {
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      status: "ok",
      duration_ms: 842,
      started_at_ms: 1_747_785_600_000,
      ended_at_ms: 1_747_785_600_842,
      dimensions: { dvm_id: "4bf92f3577b34da6a3ce929d0e0e4736", dvm_slug: "my-dvm" },
      span_count: 1,
      truncated: false,
      spans: [
        {
          span_id: "00f067aa0ba902b7",
          trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
          parent_span_id: null,
          name: "POST /v1/job",
          dataset: "isolate",
          level: "info",
          status: "ok",
          started_at_ms: 1_747_785_600_000,
          ended_at_ms: 1_747_785_600_842,
          duration_ms: 842,
          service: "dvmkit-platform",
          service_version: "0.1.0",
          host: "dvmkit-my-dvm",
          dimensions: { dvm_id: "4bf92f3577b34da6a3ce929d0e0e4736", dvm_slug: "my-dvm" },
          attributes: { "http.status_code": 200 },
          error_message: null,
          error_stack: null,
        },
      ],
    };
    vi.mocked(platformClient.getBuilderTrace).mockResolvedValue(result);

    await traceGet("4bf92f3577b34da6a3ce929d0e0e4736", {});

    expectMatchesDoc("trace get");
  });

  // ── Revenue & keys ──────────────────────────────────────────────────

  it("revenue summary — totals, per-rail breakdown, series, FX warnings", async () => {
    const result: RevenueSeriesResult = {
      summary: {
        fiat_currency: "usd",
        period: { from: "2026-05-01", to: "2026-05-27" },
        by_source_type_rail: [
          { source_type: "job", rail: "cashu", gross_fiat_minor: 8_010, count: 240 },
        ],
        total_gross_fiat_minor: 14_237,
        total_count: 372,
      },
      series: { monthly_by_rail: [], monthly_by_source_type: [], cumulative_net_by_date: [] },
      stale_fx_warnings: [],
      org: READ_SCOPE,
    };
    vi.mocked(platformClient.getRevenueSeries).mockResolvedValue(result);

    await revenueSummary({ from: "2026-05-01", to: "2026-05-27" });

    expectMatchesDoc("revenue summary");
  });

  it("revenue events — the individual lines + the unpaged total", async () => {
    const result: RevenueEventsResult = {
      events: [
        {
          date: "2026-05-15",
          source_type: "job",
          rail: "cashu",
          dvm_slug: "my-dvm",
          line_description: "Job completion",
          fiat_amount_minor: 100,
          fiat_currency: "usd",
          net_fiat_minor: 100,
        },
      ],
      total: 50,
      org: READ_SCOPE,
    };
    vi.mocked(platformClient.getRevenueEvents).mockResolvedValue(result);

    await revenueEvents({});

    expectMatchesDoc("revenue events");
  });

  it("api-keys list — keys array (epoch-ms created_at + last_used_at)", async () => {
    const result: ApiKeysListResult = {
      keys: [
        {
          id: "ak_0e4220d396ef48c8",
          label: "ci-runner",
          key_prefix: "dvmk_9f8",
          created_at: 1_746_057_600_000,
          last_used_at: 1_748_347_200_000,
        },
      ],
      count: 1,
      limit: 10,
    };
    vi.mocked(platformClient.listApiKeys).mockResolvedValue(result);

    await apiKeysList({});

    expectMatchesDoc("api-keys list");
  });

  it("api-keys create — the one and only time the raw key is returned", async () => {
    const result: ApiKeyCreateResult = {
      id: "ak_0e4220d396ef48c8",
      key: "dvmk_9f86d081884c7d659a2feaa0c55ad015",
      label: "ci-runner",
      created_at: 1_748_347_200_000,
    };
    vi.mocked(platformClient.createApiKey).mockResolvedValue(result);

    await apiKeysCreate({ label: "ci-runner" });

    expectMatchesDoc("api-keys create");
  });

  it("api-keys revoke — the deleted key's id", async () => {
    vi.mocked(platformClient.deleteApiKey).mockResolvedValue(undefined);

    await apiKeysRevoke("ak_0e4220d396ef48c8", {});

    expectMatchesDoc("api-keys revoke");
  });
});

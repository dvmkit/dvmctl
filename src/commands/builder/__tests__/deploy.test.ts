import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as SdkInternal from "@dvmkit/sdk/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/platform", () => ({
  resolveAuth: vi.fn(() => null),
  resolveOrgScope: vi.fn((opts: { org?: string }) => opts.org),
}));

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
  progress: vi.fn(),
}));

// Deploy now requires a builder identity on disk. The self-host
// path calls `requireBuilderIdentity()` + `buildDeployAttestation()` before
// emitting the Dockerfile; mock both so tests don't need to seed
// `~/.dvmkit/builder.key`. Cloud-path tests that fail before the identity
// check (auth, slug validation) are unaffected.
vi.mock("@dvmkit/sdk/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof SdkInternal>()),
  loadIdentitySecret: vi.fn(() => "b".repeat(64)),
  buildAttestation: vi.fn(() => ({
    dvm_id: "dvm-selfhost-test",
    slug: "stub",
    capabilities_hash: "c".repeat(64),
    builder_pubkey: "a".repeat(64),
    deployed_at: 1747512345,
  })),
  signAttestation: vi.fn(() => "d".repeat(128)),
}));

vi.mock("../../../lib/builder-mnemonic", () => ({
  readBuilderMnemonic: vi.fn(() => null),
}));

vi.mock("../identity", () => ({
  identityCreate: vi.fn(),
}));

vi.mock("../../../shared/builder-store", () => ({
  getBuilderDvm: vi.fn(() => undefined),
  getSelfHostedBuilderDvm: vi.fn(() => ({ canonical_dvm_id: "dvm-selfhost-test" })),
  upsertBuilderDvm: vi.fn(),
  loadIdentityPubkey: vi.fn(() => "a".repeat(64)),
}));

vi.mock("../../../lib/platform-client", () => ({
  deployLocal: vi.fn(),
  finalizeDvmDeployIdentity: vi.fn(),
  startDeploy: vi.fn(),
  validateAuth: vi.fn(),
  streamDeployLogs: vi.fn(),
}));

import { loadIdentitySecret } from "@dvmkit/sdk/internal";

import { deriveSlug, slugify } from "../../../lib/deploy-attestation";
import { resolveAuth } from "../../../lib/platform";
import * as platformClient from "../../../lib/platform-client";
import { shortSha, splitDirtySha } from "../../../shared/git-sha";
import { info, json, progress } from "../../../shared/output";
import { gitRunner } from "../../../test-support/git-sandbox";
import { SPAWN_HEAVY_TIMEOUT } from "../../../test-support/spawn-budget";
import {
  createTarball,
  deploy,
  findContextRoot,
  isPackagedTreeDirty,
  probeLocalDvm,
  readGitHead,
  readVmConfig,
  withDeployBuildContext,
} from "../deploy";
import { identityCreate } from "../identity";

describe("dvmctl deploy --target self-host", () => {
  let originalCwd: string;
  let dir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "dvmctl-deploy-"));
    process.chdir(dir);
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates a Dockerfile", async () => {
    await deploy({ target: "self-host" });

    expect(existsSync(join(dir, "Dockerfile"))).toBe(true);
    const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf-8");
    expect(dockerfile.match(/FROM node:22-slim/g)).toHaveLength(2);
    expect(dockerfile).toContain("dist/serve.js");
    expect(dockerfile).toContain("EXPOSE 8080");
  });

  it("throws when no handler file exists", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dvmctl-deploy-empty-"));
    process.chdir(emptyDir);

    await expect(deploy({ target: "self-host" })).rejects.toThrow(
      "No handler.ts or handler.js found"
    );

    rmSync(emptyDir, { recursive: true, force: true });
  });

  it("fails with `identity_required` when no builder identity is on disk", async () => {
    vi.mocked(loadIdentitySecret).mockReturnValueOnce(null);
    await expect(deploy({ target: "self-host" })).rejects.toMatchObject({
      code: "identity_required",
    });
  });

  it("creates a missing identity only when --create-identity is explicit", async () => {
    vi.mocked(loadIdentitySecret).mockReturnValueOnce(null);

    await deploy({ target: "self-host", createIdentity: true });

    expect(identityCreate).toHaveBeenCalledWith({ human: undefined, quiet: true });
  });

  it("emits DVMKIT_BUILDER_* env vars on the self-host JSON line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await deploy({ target: "self-host" });
      const lines = logSpy.mock.calls.map((c) => String(c[0]));
      const json = lines.find((l) => l.startsWith("{"));
      expect(json).toBeDefined();
      const parsed = JSON.parse(json ?? "{}") as {
        attestation_env?: Record<string, string>;
      };
      expect(parsed.attestation_env).toMatchObject({
        DVMKIT_BUILDER_PUBKEY: expect.any(String) as unknown as string,
        DVMKIT_BUILDER_ATTESTATION: expect.any(String) as unknown as string,
        DVMKIT_BUILDER_SIGNATURE: expect.any(String) as unknown as string,
        DVMKIT_DVM_ID: "dvm-selfhost-test",
        DVMKIT_CANONICAL_DVM_ID: "dvm-selfhost-test",
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("dvmctl deploy --dry-run", () => {
  let originalCwd: string;
  let dir: string;
  const jsonMock = vi.mocked(json);

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "dvmctl-dryrun-"));
    process.chdir(dir);
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "my-dvm", dvmkit: { memory_mb: 256 } }),
      "utf-8"
    );
    jsonMock.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("validates an isolate-runtime project (no Dockerfile) without contacting the platform", async () => {
    await deploy({ dryRun: true, runtime: "isolate" });

    expect(jsonMock).toHaveBeenCalledTimes(1);
    const out = JSON.stringify(jsonMock.mock.calls[0]?.[0]);
    expect(out).toContain('"status":"dry-run-ok"');
    expect(out).toContain('"slug":"my-dvm"');
    expect(out).toContain('"runtime":"isolate"');
    expect(out).toContain('"docker_built":false');
  });

  it("accepts a 20-machine declaration during offline dry-run", async () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "my-dvm", dvmkit: { max_machines: 20 } }),
      "utf-8"
    );
    await deploy({ dryRun: true, runtime: "isolate" });
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "dry-run-ok", vm_config: { maxMachines: 20 } })
    );
  });

  it("rejects a slug shorter than 3 characters", async () => {
    await expect(deploy({ dryRun: true, name: "ab", runtime: "isolate" })).rejects.toThrow(
      /too short/
    );
  });

  it("rejects container runtime when no Dockerfile exists", async () => {
    await expect(deploy({ dryRun: true, runtime: "container" })).rejects.toThrow(
      /No Dockerfile found/
    );
  });

  it("defaults to the container runtime rather than falling back to isolate without a Dockerfile", async () => {
    await expect(deploy({ dryRun: true })).rejects.toMatchObject({ code: "missing_dockerfile" });
    expect(jsonMock).not.toHaveBeenCalled();
  });

});

describe("slugify", () => {
  it("normalizes scoped mixed-case names and collapses and trims hyphens", () => {
    expect(slugify("--@Scope/My---DVM Project--")).toBe("scope-my-dvm-project");
  });

});

describe("deriveSlug", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads slug from package.json name", () => {
    dir = mkdtempSync(join(tmpdir(), "slug-test-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "Podcast DVM" }), "utf-8");
    expect(deriveSlug(dir)).toBe("podcast-dvm");
  });

  it("falls back to directory name", () => {
    dir = mkdtempSync(join(tmpdir(), "my-cool-dvm-"));
    // No package.json — should use the dirname
    const slug = deriveSlug(dir);
    expect(slug).toMatch(/^my-cool-dvm/);
  });
});

describe("createTarball", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("excludes .env, .env.*, and .vercel anywhere in the tree", () => {
    dir = mkdtempSync(join(tmpdir(), "tar-excl-"));
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", ".env.local"), "SECRET=leaked", "utf-8");
    writeFileSync(join(dir, "web", ".env.production"), "PROD=leaked", "utf-8");
    writeFileSync(join(dir, ".env"), "ROOT=leaked", "utf-8");
    mkdirSync(join(dir, "web", ".vercel"), { recursive: true });
    writeFileSync(
      join(dir, "web", ".vercel", "project.json"),
      JSON.stringify({ projectId: "x" }),
      "utf-8"
    );

    const buf = createTarball(dir);
    expect(buf).toBeInstanceOf(Buffer);
    expect([...buf.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const tarball = join(dir, "out.tar.gz");
    writeFileSync(tarball, buf);
    const listing = execFileSync("tar", ["-tzf", tarball]).toString("utf-8");
    expect(listing).toContain("./handler.ts");
    expect(listing).not.toMatch(/(^|\/)\.env(\b|\.)/m);
    expect(listing).not.toContain(".vercel");
  });

  it("excludes build artifact dirs at any depth", () => {
    dir = mkdtempSync(join(tmpdir(), "tar-artifacts-"));
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    mkdirSync(join(dir, "web", ".next", "server"), { recursive: true });
    writeFileSync(join(dir, "web", ".next", "server", "page.js"), "x", "utf-8");
    mkdirSync(join(dir, ".turbo"), { recursive: true });
    writeFileSync(join(dir, ".turbo", "trace.json"), "{}", "utf-8");
    mkdirSync(join(dir, "coverage"), { recursive: true });
    writeFileSync(join(dir, "coverage", "lcov.info"), "", "utf-8");
    writeFileSync(join(dir, "tsconfig.tsbuildinfo"), "{}", "utf-8");
    mkdirSync(join(dir, ".cache"), { recursive: true });
    writeFileSync(join(dir, ".cache", "some-cache"), "", "utf-8");

    const buf = createTarball(dir);
    const tarball = join(dir, "out.tar.gz");
    writeFileSync(tarball, buf);
    const listing = execFileSync("tar", ["-tzf", tarball]).toString("utf-8");
    expect(listing).toContain("./handler.ts");
    expect(listing).not.toContain(".next");
    expect(listing).not.toContain(".turbo");
    expect(listing).not.toContain("coverage");
    expect(listing).not.toContain(".tsbuildinfo");
    expect(listing).not.toContain(".cache");
  });

  it("excludes Playwright snapshot baseline dirs at any depth", () => {
    dir = mkdtempSync(join(tmpdir(), "tar-snapshots-"));
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    const specSnaps = join(dir, "web", "tests", "catalog.spec.ts-snapshots");
    const testSnaps = join(dir, "e2e", "flow.test.js-snapshots");
    mkdirSync(specSnaps, { recursive: true });
    mkdirSync(testSnaps, { recursive: true });
    writeFileSync(join(specSnaps, "button-chromium-linux.png"), "png", "utf-8");
    writeFileSync(join(testSnaps, "flow-webkit-linux.png"), "png", "utf-8");
    mkdirSync(join(dir, "db-snapshots"), { recursive: true });
    writeFileSync(join(dir, "db-snapshots", "seed.sql"), "select 1;", "utf-8");

    const buf = createTarball(dir);
    const tarball = join(dir, "out.tar.gz");
    writeFileSync(tarball, buf);
    const listing = execFileSync("tar", ["-tzf", tarball]).toString("utf-8");
    expect(listing).toContain("./handler.ts");
    expect(listing).toContain("./db-snapshots/seed.sql");
    expect(listing).not.toContain("-linux.png");
  });

  it("excludes populated Codex worktrees at any depth", () => {
    dir = mkdtempSync(join(tmpdir(), "tar-codex-worktree-"));
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    const worktree = join(dir, "nested", ".codex", "worktrees", "active-dvm");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "handler.ts"), "export default { stale: true };", "utf-8");
    writeFileSync(join(worktree, "session.json"), JSON.stringify({ state: "active" }), "utf-8");

    const buf = createTarball(dir);
    const tarball = join(dir, "out.tar.gz");
    writeFileSync(tarball, buf);
    const listing = execFileSync("tar", ["-tzf", tarball]).toString("utf-8");
    expect(listing).toContain("./handler.ts");
    expect(listing).not.toContain(".codex");
    expect(listing).not.toContain("active-dvm");
  });

  it("materializes the exact cloud archive for a monorepo Docker context", () => {
    dir = mkdtempSync(join(tmpdir(), "tar-docker-context-"));
    const dvmDir = join(dir, "apps", "weather");
    mkdirSync(dvmDir, { recursive: true });
    writeFileSync(join(dir, "package-lock.json"), "{}", "utf-8");
    writeFileSync(join(dir, "package.json"), "{}", "utf-8");
    writeFileSync(join(dir, ".dockerignore"), "ignored-by-docker.txt\n", "utf-8");
    writeFileSync(join(dvmDir, "Dockerfile"), "FROM scratch\n", "utf-8");
    writeFileSync(join(dvmDir, "Dockerfile.dockerignore"), "also-ignored-by-docker.txt\n", "utf-8");
    writeFileSync(join(dvmDir, "handler.ts"), "export default {};", "utf-8");
    writeFileSync(join(dir, "included.txt"), "cloud-and-docker", "utf-8");
    writeFileSync(join(dir, "input.tar.gz"), "source archive payload", "utf-8");
    writeFileSync(join(dir, "ignored-by-docker.txt"), "docker ignores this later", "utf-8");
    writeFileSync(
      join(dvmDir, "also-ignored-by-docker.txt"),
      "Dockerfile rule ignores this",
      "utf-8"
    );
    for (const path of [
      "node_modules/package/index.js",
      "dist/serve.js",
      ".verify-logs/verify.log",
      "web/tests/page.spec.ts-snapshots/page.png",
    ]) {
      const target = join(dir, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, "excluded artifact", "utf-8");
    }

    const uploaded = createTarball(dir);
    const cloudWorkspace = mkdtempSync(join(tmpdir(), "tar-cloud-context-"));
    const cloudContext = join(cloudWorkspace, "context");
    try {
      mkdirSync(cloudContext);
      const archivePath = join(cloudWorkspace, "uploaded.tar.gz");
      writeFileSync(archivePath, uploaded);
      execFileSync("tar", ["xzf", archivePath, "-C", cloudContext]);
      rmSync(archivePath);

      withDeployBuildContext(dir, (dockerContext) => {
        const cloud = contextManifest(cloudContext);
        const docker = contextManifest(dockerContext);
        expect(docker).toEqual(cloud);
        expect(sumContextBytes(dockerContext)).toBe(sumContextBytes(cloudContext));
        expect(docker).toEqual([
          ".dockerignore",
          "apps/weather/Dockerfile",
          "apps/weather/Dockerfile.dockerignore",
          "apps/weather/also-ignored-by-docker.txt",
          "apps/weather/handler.ts",
          "ignored-by-docker.txt",
          "included.txt",
          "input.tar.gz",
          "package-lock.json",
          "package.json",
        ]);
        expect(sumContextBytes(dockerContext)).toBe(175);
      });
    } finally {
      rmSync(cloudWorkspace, { recursive: true, force: true });
    }
  });

  it("removes the materialized context after a successful or failed build", () => {
    dir = mkdtempSync(join(tmpdir(), "tar-cleanup-"));
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    writeFileSync(join(dir, "input.tar.gz"), "source archive payload", "utf-8");
    let successfulContext = "";
    withDeployBuildContext(dir, (context) => {
      successfulContext = context;
      expect(existsSync(join(context, "handler.ts"))).toBe(true);
      expect(readFileSync(join(context, "input.tar.gz"), "utf-8")).toBe("source archive payload");
    });
    expect(existsSync(successfulContext)).toBe(false);

    let failedContext = "";
    expect(() =>
      withDeployBuildContext(dir, (context) => {
        failedContext = context;
        throw new Error("build failed");
      })
    ).toThrow("build failed");
    expect(existsSync(failedContext)).toBe(false);
  });
});

function contextManifest(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? join(prefix, entry.name) : entry.name;
    return entry.isDirectory() ? contextManifest(root, path) : [path];
  });
}

function sumContextBytes(root: string, prefix = ""): number {
  return readdirSync(join(root, prefix), { withFileTypes: true }).reduce((total, entry) => {
    const path = prefix ? join(prefix, entry.name) : entry.name;
    return (
      total + (entry.isDirectory() ? sumContextBytes(root, path) : statSync(join(root, path)).size)
    );
  }, 0);
}

describe("findContextRoot", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("returns the parent dir that holds package-lock.json", () => {
    root = mkdtempSync(join(tmpdir(), "ctx-root-"));
    writeFileSync(join(root, "package-lock.json"), "{}", "utf-8");
    const sub = join(root, "src", "dvms", "cast");
    mkdirSync(sub, { recursive: true });

    expect(findContextRoot(sub)).toBe(root);
  });

  it("falls back to cwd when no parent has package-lock.json", () => {
    root = mkdtempSync(join(tmpdir(), "ctx-root-none-"));
    expect(findContextRoot(root)).toBe(root);
  });

  it("returns cwd itself when it contains package-lock.json (single-DVM repo)", () => {
    root = mkdtempSync(join(tmpdir(), "ctx-root-single-"));
    writeFileSync(join(root, "package-lock.json"), "{}", "utf-8");
    expect(findContextRoot(root)).toBe(root);
  });
});

describe("readVmConfig", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when package.json has no dvmkit field", () => {
    dir = mkdtempSync(join(tmpdir(), "vm-test-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-dvm" }), "utf-8");
    expect(readVmConfig(dir)).toBeNull();
  });

  it("returns null when package.json is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "vm-test-"));
    expect(readVmConfig(dir)).toBeNull();
  });

  it("parses snake_case keys into camelCase VmConfig", () => {
    dir = mkdtempSync(join(tmpdir(), "vm-test-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "my-dvm",
        dvmkit: {
          memory_mb: 1024,
          cpu_count: 2,
          cpu_kind: "shared",
          min_machines_running: 0,
          max_machines: 2,
        },
      }),
      "utf-8"
    );
    expect(readVmConfig(dir)).toEqual({
      memoryMb: 1024,
      cpuCount: 2,
      cpuKind: "shared",
      minMachinesRunning: 0,
      maxMachines: 2,
    });
  });

  it("accepts a partial dvmkit field", () => {
    dir = mkdtempSync(join(tmpdir(), "vm-test-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dvmkit: { memory_mb: 1024 } }),
      "utf-8"
    );
    expect(readVmConfig(dir)).toEqual({ memoryMb: 1024 });
  });

  it("rejects non-object dvmkit field", () => {
    dir = mkdtempSync(join(tmpdir(), "vm-test-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dvmkit: "nope" }), "utf-8");
    expect(() => readVmConfig(dir)).toThrow(/must be an object/);
  });

  it("rejects out-of-range memory_mb", () => {
    dir = mkdtempSync(join(tmpdir(), "vm-test-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dvmkit: { memory_mb: -1 } }),
      "utf-8"
    );
    expect(() => readVmConfig(dir)).toThrow(/memory_mb/);
  });

  it("rejects invalid cpu_kind", () => {
    dir = mkdtempSync(join(tmpdir(), "vm-test-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dvmkit: { cpu_kind: "gpu" } }),
      "utf-8"
    );
    expect(() => readVmConfig(dir)).toThrow(/cpu_kind/);
  });
});

describe("dvmctl deploy --local", () => {
  let originalCwd: string;
  let dir: string;
  const infoMock = vi.mocked(info);
  const jsonMock = vi.mocked(json);
  const deployLocalMock = vi.mocked(platformClient.deployLocal);

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "dvmctl-local-"));
    process.chdir(dir);
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "word-counter" }), "utf-8");
    infoMock.mockClear();
    jsonMock.mockClear();
    deployLocalMock.mockReset();
    deployLocalMock.mockResolvedValue({
      dvmId: "dvm-fixture-1",
      slug: "word-counter",
      url: "http://localhost:9090",
      status: "deployed",
      paused: false,
      suspensionReason: null,
      dvmkitUrl: "http://smoketest--word-counter.localhost:8081",
    });
    vi.mocked(resolveAuth).mockReturnValue({ token: "dvmk_test", account: "api-key" });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.mocked(resolveAuth).mockReturnValue(null);
  });

  it("registers the DVM locally without touching the cloud deploy path", async () => {
    await deploy({ local: true, url: "http://localhost:9090" });

    expect(deployLocalMock).toHaveBeenCalledTimes(1);
    expect(platformClient.startDeploy).not.toHaveBeenCalled();
    const [, , opts] = deployLocalMock.mock.calls[0] ?? [];
    expect(opts).toMatchObject({
      slug: "word-counter",
      name: "word-counter",
      url: "http://localhost:9090",
    });

    expect(jsonMock).toHaveBeenCalledTimes(1);
    const out = JSON.stringify(jsonMock.mock.calls[0]?.[0]);
    expect(out).toContain('"status":"deployed"');
    expect(out).toContain('"dvmId":"dvm-fixture-1"');
  });

  it("defaults the platform URL to the local stack", async () => {
    delete process.env.DVMKIT_PLATFORM_URL;
    await deploy({ target: "local", url: "http://localhost:9090" });
    const [platformUrl] = deployLocalMock.mock.calls[0] ?? [];
    expect(platformUrl).toBe("http://localhost:8080");
  });

  it("reports a preserved builder pause instead of claiming deployment", async () => {
    deployLocalMock.mockResolvedValue({
      dvmId: "dvm-fixture-1",
      slug: "word-counter",
      url: "http://localhost:9090",
      status: "suspended",
      paused: true,
      suspensionReason: "builder_pause",
      dvmkitUrl: "http://smoketest--word-counter.localhost:8081",
    });

    await deploy({ local: true, url: "http://localhost:9090" });

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "suspended",
        paused: true,
        suspensionReason: "builder_pause",
      })
    );
  });

  it("reports a platform suspension instead of a retained pause latch", async () => {
    deployLocalMock.mockResolvedValue({
      dvmId: "dvm-fixture-1",
      slug: "word-counter",
      url: "http://localhost:9090",
      status: "suspended",
      paused: true,
      suspensionReason: "behaviour",
      dvmkitUrl: "http://smoketest--word-counter.localhost:8081",
    });

    await deploy({ local: true, url: "http://localhost:9090", human: true });

    const output = infoMock.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("remains suspended by the platform (behaviour)");
    expect(output).toContain("`dvmctl resume` won't lift it");
    expect(output).toContain("returns to paused once the suspension is lifted");
    expect(output).not.toContain("remains paused");
  });

  it("derives the URL from .env PORT when --url is omitted", async () => {
    writeFileSync(join(dir, ".env"), "PORT=9090\n", "utf-8");
    await deploy({ local: true });
    const [, , opts] = deployLocalMock.mock.calls[0] ?? [];
    expect(opts.url).toBe("http://localhost:9090");
  });

  it("falls back to port 3000 when no --url and no .env PORT", async () => {
    await deploy({ local: true });
    const [, , opts] = deployLocalMock.mock.calls[0] ?? [];
    expect(opts.url).toBe("http://localhost:3000");
  });

  it("surfaces a project .env read failure before registration", async () => {
    mkdirSync(join(dir, ".env"));

    await expect(deploy({ local: true })).rejects.toMatchObject({
      code: "project_env_unreadable",
      data: { path: join(process.cwd(), ".env"), error_code: "EISDIR" },
    });
    expect(deployLocalMock).not.toHaveBeenCalled();
  });

  it("fails with auth_required when not authenticated", async () => {
    vi.mocked(resolveAuth).mockReturnValue(null);
    await expect(deploy({ local: true })).rejects.toMatchObject({ code: "auth_required" });
    expect(deployLocalMock).not.toHaveBeenCalled();
  });
});

describe("dvmctl deploy (non-TTY default)", () => {
  let originalCwd: string;
  let dir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "dvmctl-deploy-nontty-"));
    process.chdir(dir);
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to cloud when stdin is not a TTY", async () => {
    // resolveAuth is mocked to return null, so the cloud path fails fast with
    // "Not authenticated." — no Dockerfile is written (self-host's only artifact).
    await expect(deploy({})).rejects.toThrow("Not authenticated.");
    expect(existsSync(join(dir, "Dockerfile"))).toBe(false);
  });
});

describe("dvmctl deploy cloud dirty-tree guard", { timeout: SPAWN_HEAVY_TIMEOUT }, () => {
  let originalCwd: string;
  let dir: string;
  const git = gitRunner(() => dir);
  const startDeployMock = vi.mocked(platformClient.startDeploy);
  const streamDeployLogsMock = vi.mocked(platformClient.streamDeployLogs);

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "dvmctl-cloud-dirty-"));
    process.chdir(dir);
    dir = process.cwd();
    git("init", "--initial-branch=master");
    writeFileSync(join(dir, "package-lock.json"), "{}", "utf-8");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "word-counter" }), "utf-8");
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n", "utf-8");
    git("add", ".");
    git("commit", "--message", "seed");

    vi.mocked(resolveAuth).mockReturnValue({ token: "dvmk_test", account: "api-key" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 }))
    );
    startDeployMock.mockReset();
    startDeployMock.mockResolvedValue({
      deployId: "deploy-1",
      dvmId: "dvm-fixture-1",
      slug: "word-counter",
    });
    vi.mocked(platformClient.finalizeDvmDeployIdentity).mockResolvedValue(undefined);
    vi.mocked(platformClient.deployLocal).mockReset();
    vi.mocked(platformClient.deployLocal).mockResolvedValue({
      dvmId: "dvm-local-1",
      slug: "word-counter",
      url: "http://localhost:9090",
      status: "deployed",
      paused: false,
      suspensionReason: null,
      dvmkitUrl: "http://builder--word-counter.localhost:8081",
    });
    vi.mocked(platformClient.streamDeployLogs).mockResolvedValue({
      url: "https://word-counter.example",
      status: "deployed",
      dvmkitUrl: null,
    });
    vi.mocked(json).mockClear();
    vi.mocked(progress).mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    vi.mocked(resolveAuth).mockReturnValue(null);
    vi.unstubAllGlobals();
  });

  it("refuses before queuing a build and names every packaged path", async () => {
    writeFileSync(join(dir, "handler.ts"), "export default { changed: true };", "utf-8");
    writeFileSync(join(dir, "extra.ts"), "export const extra = true;", "utf-8");

    await expect(deploy({ target: "cloud" })).rejects.toMatchObject({
      code: "dirty_worktree",
      hint: expect.stringContaining("--allow-dirty"),
      data: {
        paths: ["extra.ts", "handler.ts"],
        packaged_root: dir,
      },
    });
    expect(startDeployMock).not.toHaveBeenCalled();
  });

  it("does not treat --yes as permission to ship uncommitted code", async () => {
    writeFileSync(join(dir, "handler.ts"), "export default { changed: true };", "utf-8");

    await expect(deploy({ target: "cloud", yes: true })).rejects.toMatchObject({
      code: "dirty_worktree",
    });
    expect(startDeployMock).not.toHaveBeenCalled();
  });

  it("allows an explicit override and retains the -dirty commit label", async () => {
    writeFileSync(join(dir, "handler.ts"), "export default { changed: true };", "utf-8");

    await deploy({ target: "cloud", allowDirty: true });

    expect(startDeployMock).toHaveBeenCalledTimes(1);
    const [, , opts] = startDeployMock.mock.calls[0] ?? [];
    expect(opts.commit?.sha).toMatch(/^[0-9a-f]{40}-dirty$/);
  });

  it("reports Fly acceptance as structured progress and keeps the deploy id in the result", async () => {
    streamDeployLogsMock.mockImplementationOnce(async (_url, _token, deployId, handlers) => {
      handlers.onAccepted?.({
        deployId,
        url: "https://word-counter.example",
        commitSha: "a".repeat(40),
      });
      return {
        url: "https://word-counter.example",
        status: "deployed",
        dvmkitUrl: null,
      };
    });

    await deploy({ target: "cloud" });

    expect(progress).toHaveBeenCalledWith({
      event: "release_accepted",
      deploy_id: "deploy-1",
      url: "https://word-counter.example",
      commit_sha: "a".repeat(40),
    });
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deployed", deploy_id: "deploy-1" })
    );
  });

  it("packages a populated workspace without treating local evidence as deploy input", async () => {
    const worktree = join(dir, ".codex", "worktrees", "active-dvm");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "handler.ts"), "export default { stale: true };", "utf-8");
    writeFileSync(join(worktree, "session.json"), JSON.stringify({ state: "active" }), "utf-8");
    const verifyLogs = join(dir, ".verify-logs");
    mkdirSync(verifyLogs, { recursive: true });
    // Incompressible logs exceed the archive limit unless local evidence is excluded.
    writeFileSync(join(verifyLogs, "production-acceptance.log"), randomBytes(50 * 1024 * 1024 + 1));

    await deploy({ target: "cloud", allowDirty: true });

    expect(startDeployMock).toHaveBeenCalledTimes(1);
    const [, , options] = startDeployMock.mock.calls[0] ?? [];
    expect(options.tarball).toBeInstanceOf(Buffer);
    expect(options.tarball?.length).toBeGreaterThan(0);
    const tarball = join(dir, "uploaded.tar.gz");
    writeFileSync(tarball, options.tarball ?? Buffer.alloc(0));
    const listing = execFileSync("tar", ["-tzf", tarball]).toString("utf-8");
    expect(listing).not.toContain(".codex");
    expect(listing).not.toContain("active-dvm");
    expect(listing).not.toContain(".verify-logs");
    expect(listing).not.toContain("production-acceptance.log");
  });

  it("reports exhausted metadata verification as a typed partial success with the healthz check", async () => {
    streamDeployLogsMock.mockResolvedValueOnce({
      url: "https://word-counter.example",
      status: "deployed_unverified",
      dvmkitUrl: null,
    });

    await deploy({ target: "cloud" });

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "deployed_unverified",
        outcome: "partial_success",
        deploy_id: "deploy-1",
        verification_url: "https://word-counter.example/healthz",
        expected_git_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        hint: expect.stringContaining("/healthz"),
      })
    );
  });

  it("refuses a project without a Dockerfile instead of selecting the isolate runtime", async () => {
    git("rm", "--quiet", "Dockerfile");
    git("commit", "--quiet", "--message", "drop Dockerfile");

    await expect(deploy({ target: "cloud" })).rejects.toMatchObject({
      code: "missing_dockerfile",
      message: expect.stringContaining("containers only"),
      hint: expect.stringContaining("dvmctl create"),
    });
    expect(startDeployMock).not.toHaveBeenCalled();
  });

  it("passes an explicit --runtime isolate through for the platform to authorize", async () => {
    git("rm", "--quiet", "Dockerfile");
    git("commit", "--quiet", "--message", "drop Dockerfile");

    await deploy({ target: "cloud", runtime: "isolate" });

    expect(startDeployMock).toHaveBeenCalledTimes(1);
    const [, , opts] = startDeployMock.mock.calls[0] ?? [];
    expect(opts.runtime).toBe("isolate");
  });

  it("leaves self-host deploys unaffected", async () => {
    writeFileSync(join(dir, "handler.ts"), "export default { changed: true };", "utf-8");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(deploy({ target: "self-host" })).resolves.toBeUndefined();
    } finally {
      logSpy.mockRestore();
    }
    expect(startDeployMock).not.toHaveBeenCalled();
  });

  it("leaves local deploys unaffected", async () => {
    writeFileSync(join(dir, "handler.ts"), "export default { changed: true };", "utf-8");

    await expect(
      deploy({ target: "local", url: "http://localhost:9090" })
    ).resolves.toBeUndefined();
    expect(platformClient.deployLocal).toHaveBeenCalledTimes(1);
    expect(startDeployMock).not.toHaveBeenCalled();
  });
});

/**
 * The image's sha label comes from `git rev-parse HEAD`, but its
 * content is a `tar` of the working tree. These pin the marker that keeps the
 * two honest when they disagree, and — just as importantly — pin that it stays
 * quiet when they don't, since a marker that fires on every deploy carries no
 * information.
 */
// The only spawn-heavy block in this file: each test seeds a real repo and reads it back, at
// 7-14 `git` spawns a test. Worst test measures 693ms idle; times the 4.7-7.5x load factor
// that projects 3.3-5.2s, straddling the 5s default. The other 40 tests in the file stay on it.
// See `spawn-budget.ts`.
describe("dirty-tree sha marking", { timeout: SPAWN_HEAVY_TIMEOUT }, () => {
  let dir: string;

  // Isolated from the checkout running the suite and from the developer's config,
  // with the committer identity coming from the environment rather than a `git
  // config` write — see `git-sandbox.ts`. This was the suite that failed
  // once a sibling worktree's `GIT_DIR` leaked in and `git init` marked the shared
  // repository bare.
  const git = gitRunner(() => dir);

  /** A committed repo with a package-lock.json, so it is its own context root. */
  const seedRepo = (): void => {
    dir = mkdtempSync(join(tmpdir(), "dirty-sha-"));
    git("init", "--initial-branch=master");
    writeFileSync(join(dir, "package-lock.json"), "{}", "utf-8");
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");
    git("add", ".");
    git("commit", "--message", "seed");
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports a bare sha from a clean tree", () => {
    seedRepo();

    expect(isPackagedTreeDirty(dir)).toBe(false);
    expect(readGitHead(dir, dir)?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("marks a tracked file modified but not committed", () => {
    seedRepo();
    writeFileSync(join(dir, "handler.ts"), "export default { changed: true };", "utf-8");

    expect(isPackagedTreeDirty(dir)).toBe(true);
    expect(readGitHead(dir, dir)?.sha).toMatch(/^[0-9a-f]{40}-dirty$/);
  });

  it("marks an untracked file that would ship", () => {
    seedRepo();
    writeFileSync(join(dir, "extra.ts"), "export const extra = 1;", "utf-8");

    expect(isPackagedTreeDirty(dir)).toBe(true);
  });

  it("marks a staged-but-uncommitted change", () => {
    seedRepo();
    writeFileSync(join(dir, "handler.ts"), "export default { staged: true };", "utf-8");
    git("add", "handler.ts");

    expect(isPackagedTreeDirty(dir)).toBe(true);
  });

  it("ignores excluded noise, so the marker keeps its meaning", () => {
    // These are the paths that would otherwise mark every real deploy dirty.
    seedRepo();
    mkdirSync(join(dir, "web"), { recursive: true });
    writeFileSync(join(dir, "web", "index.ts"), "export default {};", "utf-8");
    git("add", ".");
    git("commit", "--message", "add web");

    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "bundle.js"), "x", "utf-8");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x", "utf-8");
    mkdirSync(join(dir, "web", ".next"), { recursive: true });
    writeFileSync(join(dir, "web", ".next", "page.js"), "x", "utf-8");
    mkdirSync(join(dir, "coverage"), { recursive: true });
    writeFileSync(join(dir, "coverage", "lcov.info"), "x", "utf-8");
    writeFileSync(join(dir, "tsconfig.tsbuildinfo"), "x", "utf-8");
    writeFileSync(join(dir, ".env"), "SECRET=x", "utf-8");
    writeFileSync(join(dir, ".env.local"), "SECRET=x", "utf-8");

    expect(isPackagedTreeDirty(dir)).toBe(false);
    expect(readGitHead(dir, dir)?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("ignores an untracked directory containing only excluded files", () => {
    seedRepo();
    mkdirSync(join(dir, "web", ".next"), { recursive: true });
    writeFileSync(join(dir, "web", ".next", "page.js"), "x", "utf-8");

    expect(isPackagedTreeDirty(dir)).toBe(false);
  });

  it("ignores a tracked .claude edit, which git sees but the tarball never ships", () => {
    // The live false-positive: .claude/ is tracked in dvmkit but excluded from
    // the tarball, so an uncommitted settings edit provably cannot reach the
    // image. Marking it dirty would be a lie in the other direction.
    seedRepo();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}", "utf-8");
    git("add", ".claude/settings.json");
    git("commit", "--message", "track .claude settings");
    writeFileSync(join(dir, ".claude", "settings.json"), '{"edited":true}', "utf-8");

    expect(git("status", "--porcelain")).toContain(".claude/settings.json");
    expect(isPackagedTreeDirty(dir)).toBe(false);
  });

  it("ignores a tracked .codex edit, which git sees but the tarball never ships", () => {
    seedRepo();
    const worktree = join(dir, ".codex", "worktrees", "active-dvm");
    mkdirSync(worktree, { recursive: true });
    const session = join(worktree, "session.json");
    writeFileSync(session, JSON.stringify({ state: "clean" }), "utf-8");
    git("add", ".codex/worktrees/active-dvm/session.json");
    git("commit", "--message", "track Codex worktree state");
    writeFileSync(session, JSON.stringify({ state: "edited" }), "utf-8");

    expect(git("status", "--porcelain")).toContain(".codex/worktrees/active-dvm/session.json");
    expect(isPackagedTreeDirty(dir)).toBe(false);
  });

  it("scopes dirtiness to the context root, not the whole repo", () => {
    // A sibling subtree isn't in the tarball, so it can't make the image differ.
    seedRepo();
    mkdirSync(join(dir, "packages", "dvm"), { recursive: true });
    writeFileSync(join(dir, "packages", "dvm", "package-lock.json"), "{}", "utf-8");
    writeFileSync(join(dir, "packages", "dvm", "handler.ts"), "export default {};", "utf-8");
    git("add", ".");
    git("commit", "--message", "add nested dvm");
    writeFileSync(join(dir, "handler.ts"), "export default { sibling: true };", "utf-8");

    const nested = join(dir, "packages", "dvm");
    expect(findContextRoot(nested)).toBe(nested);
    expect(isPackagedTreeDirty(nested)).toBe(false);
    expect(isPackagedTreeDirty(dir)).toBe(true);
  });

  it("treats a non-git directory as clean and reports no sha at all", () => {
    // Third-party builders deploy plain directories; they must be unaffected.
    dir = mkdtempSync(join(tmpdir(), "no-git-"));
    writeFileSync(join(dir, "handler.ts"), "export default {};", "utf-8");

    expect(isPackagedTreeDirty(dir)).toBe(false);
    expect(readGitHead(dir, dir)).toBeNull();
  });

  it("leaves the sha bare when no packaged root is given (connect tier)", () => {
    seedRepo();
    writeFileSync(join(dir, "handler.ts"), "export default { changed: true };", "utf-8");

    // No tarball is built for connect, so there is no artifact to misdescribe.
    expect(readGitHead(dir)?.sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("splitDirtySha / shortSha", () => {
  const sha = "7abbf367a5ea83531664c082369c48fa0fb41d3c";

  it("round-trips a bare sha untouched", () => {
    expect(splitDirtySha(sha)).toEqual({ base: sha, dirty: false });
    expect(shortSha(sha)).toBe("7abbf36");
  });

  it("splits and abbreviates a marked sha without losing the marker", () => {
    // The whole point: `.slice(0, 7)` alone would silently drop the marker and
    // render a dirty image indistinguishable from a clean one.
    expect(splitDirtySha(`${sha}-dirty`)).toEqual({ base: sha, dirty: true });
    expect(shortSha(`${sha}-dirty`)).toBe("7abbf36-dirty");
  });

  it("passes through the unknown sentinel", () => {
    expect(splitDirtySha("unknown")).toEqual({ base: "unknown", dirty: false });
  });
});

/**
 * `--local` registers an already-running process, so it can't put a
 * receipt key in front of it — the probe reports whether the DVM established
 * one itself, and the JSON `hint` hangs off that. The `undefined` vs `false`
 * distinction is the whole contract: a DVM that issues no receipts has no
 * attestation gap to report, and a hint on it would send an agent chasing a
 * key it doesn't want.
 */
describe("probeLocalDvm — attested receipt key", () => {
  const originalFetch = global.fetch;

  /** Answer the next `/v1/info` with this body. */
  function stubInfo(body: Record<string, unknown>): void {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve(body),
      })
    ) as unknown as typeof fetch;
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reports undefined when the DVM issues no receipts at all", async () => {
    stubInfo({ name: "word-counter" });
    expect(await probeLocalDvm("http://localhost:8080")).toEqual({
      ok: true,
      attestedReceiptKey: undefined,
    });
  });

  it("reports false when it signs receipts under a key nothing attests", async () => {
    // A dev boot's ephemeral key, or a hand-set DVMKIT_RECEIPT_KEY: receipts
    // verify, but only as `verified_unattested`.
    stubInfo({ name: "word-counter", receipts: true });
    expect(await probeLocalDvm("http://localhost:8080")).toMatchObject({
      ok: true,
      attestedReceiptKey: false,
    });
  });

  it("reports false when a builder block carries no attestation", async () => {
    stubInfo({ name: "word-counter", receipts: true, builder: { pubkey: "a".repeat(64) } });
    expect(await probeLocalDvm("http://localhost:8080")).toMatchObject({
      attestedReceiptKey: false,
    });
  });

  it("reports false when the attestation binds no receipt key", async () => {
    // What `deploy --target self-host` without `withReceiptKey` produces, and
    // what a cloud attestation looked like before receipt signing was enabled.
    stubInfo({
      name: "word-counter",
      receipts: true,
      builder: { pubkey: "a".repeat(64), attestation: { slug: "word-counter" } },
    });
    expect(await probeLocalDvm("http://localhost:8080")).toMatchObject({
      attestedReceiptKey: false,
    });
  });

  it("reports true on an attested boot", async () => {
    stubInfo({
      name: "word-counter",
      receipts: true,
      builder: {
        pubkey: "a".repeat(64),
        attestation: { slug: "word-counter", receipt_pubkey: "b".repeat(64) },
      },
    });
    expect(await probeLocalDvm("http://localhost:8080")).toMatchObject({
      ok: true,
      attestedReceiptKey: true,
    });
  });
});

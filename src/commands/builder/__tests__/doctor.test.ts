import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/defaults", () => ({
  BUILDER_CONFIG_DIR: "/mock/.dvmkit",
  BUILDER_MNEMONIC_FILE: "/mock/.dvmkit/builder.mnemonic",
  LEGACY_BUILDER_MNEMONIC_FILE: "/mock/.dvmkit/recovery.mnemonic",
  RECOVERY_MNEMONIC_FILE: "/mock/.dvm/recovery.mnemonic",
}));
vi.mock("../../../lib/mnemonic-backups", () => ({ describeMnemonicBackups: vi.fn(() => null) }));
vi.mock("../../../shared/output", () => ({ info: vi.fn(), json: vi.fn() }));

import { describeMnemonicBackups } from "../../../lib/mnemonic-backups";
import { info, json } from "../../../shared/output";
import { builderDoctor, type BuilderDoctorDeps, type BuilderDoctorReport } from "../doctor";

const deps: BuilderDoctorDeps = {
  dockerVersion: vi.fn(async () => "28.0.0"),
  probeMint: vi.fn(async () => undefined),
};
function report(): BuilderDoctorReport {
  return vi.mocked(json).mock.calls.at(-1)?.[0] as BuilderDoctorReport;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(describeMnemonicBackups).mockReturnValue(null);
  vi.mocked(deps.dockerVersion).mockResolvedValue("28.0.0");
  vi.mocked(deps.probeMint).mockResolvedValue(undefined);
  process.env.DVM_CONFIG_DIR = join(tmpdir(), "isolated-caller");
  delete process.env.DVMKIT_CASHU_MINTS;
  process.exitCode = undefined;
});

afterEach(() => {
  delete process.env.DVM_CONFIG_DIR;
  delete process.env.DVMKIT_CASHU_MINTS;
  process.exitCode = undefined;
});

describe("dvmctl doctor", () => {
  it("reports supported Node, isolated caller state, and optional Docker", async () => {
    await builderDoctor({}, deps);
    expect(report()).toMatchObject({
      checks: [
        { name: "node", status: "ok" },
        { name: "caller_config", status: "ok" },
        { name: "docker", status: "ok" },
      ],
      summary: { ok: 3, warn: 0, fail: 0 },
      configDir: "/mock/.dvmkit",
    });
  });

  it("warns that Docker is optional for paid dev", async () => {
    vi.mocked(deps.dockerVersion).mockRejectedValue(new Error("ENOENT"));
    await builderDoctor({}, deps);
    expect(report().checks).toContainEqual(
      expect.objectContaining({
        name: "docker",
        status: "warn",
        display: expect.stringContaining("Docker-free paid dev"),
      })
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("probes each configured mint independently with bounded dependency calls", async () => {
    process.env.DVMKIT_CASHU_MINTS = "https://mint-a.example,https://mint-b.example";
    vi.mocked(deps.probeMint).mockImplementation(async (url) => {
      if (url.includes("mint-b")) throw new Error("HTTP 503");
    });
    let exitCodeAtOutput: number | string | undefined;
    vi.mocked(json).mockImplementationOnce(() => { exitCodeAtOutput = process.exitCode ?? undefined; });
    await builderDoctor({}, deps);
    expect(exitCodeAtOutput).toBe(1);
    expect(deps.probeMint).toHaveBeenCalledTimes(2);
    expect(report().checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cashu_mint:https://mint-a.example", status: "ok" }),
        expect.objectContaining({
          name: "cashu_mint:https://mint-b.example",
          status: "fail",
          details: { error: "HTTP 503", mint: "https://mint-b.example" },
        }),
      ])
    );
    expect(process.exitCode).toBe(1);
  });

  it("uses project .env values when diagnosing configured mints", async () => {
    const originalCwd = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), "dvmctl-doctor-env-"));
    try {
      process.chdir(cwd);
      writeFileSync(join(cwd, ".env"), "DVMKIT_CASHU_MINTS=https://project-mint.example\n", "utf8");
      await builderDoctor({}, deps);
      expect(deps.probeMint).toHaveBeenCalledWith("https://project-mint.example");
    } finally {
      process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("warns when caller state is not explicitly isolated", async () => {
    delete process.env.DVM_CONFIG_DIR;
    await builderDoctor({}, deps);
    expect(report().checks).toContainEqual(
      expect.objectContaining({ name: "caller_config", status: "warn" })
    );
  });

  it("does not call the normal ~/.dvm wallet isolated", async () => {
    process.env.DVM_CONFIG_DIR = resolve(tmpdir(), "..", ".dvm");
    await builderDoctor({}, deps);
    expect(report().checks).toContainEqual(
      expect.objectContaining({
        name: "caller_config",
        status: "warn",
        display: expect.stringContaining("not a checked scratch directory"),
      })
    );
  });

  it("relays mnemonic backup guidance in human mode", async () => {
    vi.mocked(describeMnemonicBackups).mockReturnValue({
      display: "1 plaintext backup: /mock/.dvmkit/builder.mnemonic.old.bak (10 days old).",
      hint: "Deleting it is safe once offline backups are refreshed.",
      details: { count: 1, paths: [], backups: [] },
    });
    await builderDoctor({ human: true }, deps);
    const prose = vi
      .mocked(info)
      .mock.calls.map(([line]) => line)
      .join("\n");
    expect(prose).toContain("builder.mnemonic.old.bak");
    expect(prose).toContain("Deleting it is safe");
  });

  it("fails when the config directory cannot be scanned", async () => {
    vi.mocked(describeMnemonicBackups).mockImplementation(() => {
      throw new Error("EACCES");
    });
    await builderDoctor({}, deps);
    expect(report().checks).toContainEqual(
      expect.objectContaining({
        name: "mnemonic_backups",
        status: "fail",
        details: { error: "EACCES" },
      })
    );
    expect(process.exitCode).toBe(1);
  });
});

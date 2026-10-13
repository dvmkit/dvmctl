import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/output", () => ({ info: vi.fn(), json: vi.fn() }));

import { json } from "../../shared/output";
import { loadProjectEnvironment, parseProjectEnvironment } from "../dev-environment";
import { handleError } from "../error-handler";

describe("project environment", () => {
  let cwd: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    cwd = undefined;
  });

  it("preserves the supported .env grammar", () => {
    expect(
      parseProjectEnvironment(
        [
          "PLAIN=value",
          'DOUBLE="quoted value"',
          "SINGLE='single value'",
          "HASH=value#literal",
          "# comment",
          "",
          "=missing-key",
          "   =also-missing",
          "missing-equals",
        ].join("\n")
      )
    ).toEqual({
      PLAIN: "value",
      DOUBLE: "quoted value",
      SINGLE: "single value",
      HASH: "value#literal",
    });
  });

  it("treats an absent .env as optional", () => {
    cwd = mkdtempSync(join(tmpdir(), "dvmctl-project-env-"));
    expect(loadProjectEnvironment(cwd)).toEqual({});
  });

  it("reports an unreadable .env actionably through the CLI error boundary", () => {
    cwd = mkdtempSync(join(tmpdir(), "dvmctl-project-env-"));
    const envPath = join(cwd, ".env");
    mkdirSync(envPath);
    const error: unknown = captureError(() => loadProjectEnvironment(cwd));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("test process exit");
    });

    expect(() => handleError(error)).toThrow("test process exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "project_env_unreadable",
        message: "Could not read the project .env file.",
        hint: `Check that ${envPath} is a readable file and its parent directory is accessible.`,
        path: envPath,
        error_code: "EISDIR",
      },
    });
  });

  it("loads the project file through the shared parser", () => {
    cwd = mkdtempSync(join(tmpdir(), "dvmctl-project-env-"));
    writeFileSync(join(cwd, ".env"), "PORT=4321\n", "utf8");
    expect(loadProjectEnvironment(cwd)).toEqual({ PORT: "4321" });
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected function to throw");
}

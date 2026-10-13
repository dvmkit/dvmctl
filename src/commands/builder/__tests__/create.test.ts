import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleError } from "../../../lib/error-handler";
import * as output from "../../../shared/output";
import { create, ScaffoldCollisionError } from "../create";
import { agentsTemplate } from "../create/templates/shared";
import packageManifest from "../../../../package.json";

describe("dvmctl create", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dvmctl-create-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds a complete project", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, { price: "$0.05", description: "Test DVM" });

    expect(existsSync(join(projectDir, "handler.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "handler.test.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "serve.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "Dockerfile"))).toBe(true);
    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
    expect(existsSync(join(projectDir, "README.md"))).toBe(true);
    expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
  });

  it("keeps test files out of the production build (tsconfig)", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, {});

    const tsconfig = JSON.parse(readFileSync(join(projectDir, "tsconfig.json"), "utf-8")) as {
      exclude?: string[];
    };
    expect(tsconfig.exclude).toContain("*.test.ts");
  });

  it("documents the multi-capability shape in the README", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, {});

    const readme = readFileSync(join(projectDir, "README.md"), "utf-8");
    expect(readme).toContain("## Multiple capabilities");
    expect(readme).toContain("capabilities: {");
  });

  it("generates handler with correct name and price", async () => {
    const projectDir = join(dir, "cool-service");
    await create(projectDir, { price: "$1.00", name: "Cool Service" });

    const handler = readFileSync(join(projectDir, "handler.ts"), "utf-8");
    expect(handler).toContain('"Cool Service"');
    expect(handler).toContain('"$1.00"');
    expect(handler).toContain('import { configureDVM, z } from "@dvmkit/sdk"');
    expect(handler).toContain("const input = z.object");
    expect(handler).toContain("  input,");
    expect(handler).toContain("ctx.artifact");
  });

  it("derives name from directory when --name not provided", async () => {
    const projectDir = join(dir, "web-scraper");
    await create(projectDir, {});

    const handler = readFileSync(join(projectDir, "handler.ts"), "utf-8");
    expect(handler).toContain('"Web Scraper"');
  });

  it("uses default price when --price not provided", async () => {
    const projectDir = join(dir, "test-dvm");
    await create(projectDir, {});

    const handler = readFileSync(join(projectDir, "handler.ts"), "utf-8");
    expect(handler).toContain('"$0.01"');
  });

  it("generates valid package.json", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, {});

    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(pkg.name).toBe("my-dvm");
    expect(pkg.type).toBe("module");
    expect((pkg.dependencies as Record<string, string>)["@dvmkit/sdk"]).toBe(packageManifest.dependencies["@dvmkit/sdk"]);
    expect((pkg.devDependencies as Record<string, string>).vitest).toBe("^5.0.2");
    expect((pkg.engines as Record<string, string>).node).toBe("^22.12.0 || ^24.0.0 || >=26.0.0");
  });

  it("generates test that imports from dvmkit/testing", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, {});

    const test = readFileSync(join(projectDir, "handler.test.ts"), "utf-8");
    expect(test).toContain('from "@dvmkit/sdk/testing"');
    expect(test).toContain('dvm.capabilities["my-dvm"].onJob(ctx)');
    expect(test).toContain("ctx.completed");
    expect(test).toContain('input: { text: "hello world" }');
  });

  it("generates Dockerfile that tolerates a missing package-lock.json", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, {});

    const dockerfile = readFileSync(join(projectDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("COPY package*.json ./");
    expect(dockerfile).toContain("if [ -f package-lock.json ]; then npm ci; else npm install; fi");
  });

  it("prunes build-only dependencies before copying node_modules into the runtime image", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, {});

    const dockerfile = readFileSync(join(projectDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("RUN npm prune --omit=dev");
    expect(dockerfile).toMatch(
      /RUN npm prune --omit=dev\n\nFROM node:22-slim[\s\S]*COPY --from=build \/app\/node_modules/
    );
  });

  it("generates a Dockerfile that installs the SDK from the public registry with no credential", async () => {
    const projectDir = join(dir, "my-dvm");
    await create(projectDir, {});

    const dockerfile = readFileSync(join(projectDir, "Dockerfile"), "utf-8");
    expect(dockerfile.split("\n")[0]).toBe("# syntax=docker/dockerfile:1");
    // No registry credential reaches the build by any route — not a BuildKit
    // secret, not an .npmrc the build writes, not a build-arg.
    expect(dockerfile).not.toContain("npmtoken");
    expect(dockerfile).not.toContain("npm.pkg.github.com");
    expect(dockerfile).not.toContain(".npmrc");
    expect(dockerfile).not.toContain("ARG NPM_TOKEN");
    expect(dockerfile).not.toContain("$NPM_TOKEN");
  });

  it("does not overwrite any conflicting scaffold file", async () => {
    const projectDir = join(dir, "existing");
    mkdirSync(projectDir);
    const packageJson = join(projectDir, "package.json");
    const original = '{"private":"keep this exact content"}\n';
    writeFileSync(packageJson, original);

    await expect(create(projectDir, {})).rejects.toThrow(ScaffoldCollisionError);
    await expect(create(projectDir, {})).rejects.toMatchObject({
      code: "scaffold_destination_exists",
      destination: packageJson,
    });
    expect(readFileSync(packageJson, "utf-8")).toBe(original);
  });

  it("reports an actionable collision through the CLI JSON error boundary", async () => {
    const projectDir = join(dir, "collision-envelope");
    mkdirSync(projectDir);
    const destination = join(projectDir, "handler.ts");
    writeFileSync(destination, "preserve these bytes\n");
    const error: unknown = await create(projectDir, {}).catch((error: unknown) => error);
    const json = vi.spyOn(output, "json").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("test process exit");
    });

    expect(() => handleError(error)).toThrow("test process exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: "scaffold_destination_exists",
        message: `${destination} already exists. Choose a different directory.`,
        hint: "Choose a new project directory; dvmctl never overwrites scaffold files.",
        destination,
      },
    });
    expect(readFileSync(destination, "utf-8")).toBe("preserve these bytes\n");
  });

  it("refuses a dangling symlink at a planned destination", async () => {
    const projectDir = join(dir, "dangling-link");
    mkdirSync(projectDir);
    const destination = join(projectDir, "handler.ts");
    symlinkSync(join(projectDir, "missing-target"), destination);

    await expect(create(projectDir, {})).rejects.toMatchObject({
      code: "scaffold_destination_exists",
      destination,
    });
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  });

  it("refuses a directory at a planned destination", async () => {
    const projectDir = join(dir, "directory-collision");
    const destination = join(projectDir, "handler.ts");
    mkdirSync(destination, { recursive: true });

    await expect(create(projectDir, {})).rejects.toMatchObject({
      code: "scaffold_destination_exists",
      destination,
    });
    expect(lstatSync(destination).isDirectory()).toBe(true);
  });

  it("preserves a file created after preflight detects no conflict", async () => {
    const projectDir = join(dir, "racing-create");
    const destination = join(projectDir, "handler.ts");
    const original = "concurrent writer bytes\n";
    let injected = false;
    const fs = {
      lstatSync,
      mkdirSync,
      writeFileSync: ((...args: Parameters<typeof writeFileSync>) => {
        const path = args[0];
        if (!injected && path === destination) {
          injected = true;
          writeFileSync(destination, original);
        }
        return writeFileSync(...args);
      }) as typeof writeFileSync,
    };

    await expect(create(projectDir, {}, fs)).rejects.toMatchObject({
      code: "scaffold_destination_exists",
      destination,
    });
    expect(readFileSync(destination, "utf-8")).toBe(original);
  });

  it.each(["a builder dvm", "builder's dvm", "a builder's dvm"])(
    "prints a directory command the shell can use for %s",
    async (name) => {
      const projectDir = join(dir, name);
      const output: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
        output.push(String(line ?? ""));
      });

      try {
        await create(projectDir, {});
      } finally {
        log.mockRestore();
      }

      const command = output.find((line) => line.startsWith("    cd "))?.trim();
      expect(command).toBeDefined();
      const result = spawnSync("/bin/sh", ["-c", `${command} && pwd -P`], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trimEnd()).toBe(realpathSync(projectDir));
    }
  );

  it("points coding agents at the installed dvmctl skill", async () => {
    const projectDir = join(dir, "agent-guidance");
    await create(projectDir, {});

    const agents = readFileSync(join(projectDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("require.resolve('@dvmkit/dvmctl/skill')");
    const packageVersion = JSON.parse(readFileSync(join(__dirname, "../../../../package.json"), "utf-8")).version as string;
    expect(agents).toContain(`@dvmkit/dvmctl@${packageVersion}`);
    expect(agents).toContain('cp -R "$(dirname "$skill_path")" .agents/skills/');
    expect(readFileSync(join(projectDir, "CLAUDE.md"), "utf-8")).toContain(
      "Read [AGENTS.md](./AGENTS.md)"
    );
  });

  it("pins the skill installer to the generating CLI version", () => {
    const agents = agentsTemplate({ cliVersion: "0.1.0-rc.99" });

    expect(agents).toContain("@dvmkit/dvmctl@0.1.0-rc.99");
    expect(agents).not.toContain("@dvmkit/dvmctl@0.1.0-rc.2");
  });
});

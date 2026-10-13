import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("standalone dvmctl exposes public commands and scaffolds a project", (context) => {
  const root = mkdtempSync(join(tmpdir(), "dvmctl-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(process.cwd(), "dist/dvmctl.js");
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /create/);
  assert.match(help, /validate/);
  assert.match(help, /deploy/);
  assert.doesNotMatch(help, new RegExp(["fleet", "status"].join("-")));
  const project = join(root, "example");
  execFileSync(process.execPath, [cli, "create", project, "--description", "Example"], { encoding: "utf8" });
  const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  assert.ok(pkg.dependencies["@dvmkit/sdk"]);
  assert.equal(pkg.devDependencies.vitest, "^5.0.2");
  symlinkSync(join(process.cwd(), "node_modules"), join(project, "node_modules"), "dir");
  execFileSync(process.execPath, [cli, "validate"], { cwd: project, encoding: "utf8" });
});

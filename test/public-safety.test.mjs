import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scanner = fileURLToPath(new URL("../scripts/public-safety.mjs", import.meta.url));

function scanTrackedText(text) {
  const directory = mkdtempSync(join(tmpdir(), "public-safety-"));
  try {
    // A throwaway index exercises the production tracked-file boundary without commits.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    execFileSync("git", ["init", "--quiet", directory], { env });
    writeFileSync(join(directory, "source.ts"), text);
    execFileSync("git", ["add", "source.ts"], { cwd: directory, env });
    return spawnSync(process.execPath, [scanner], { cwd: directory, env, encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const prefix of ["regression", "REGRESSION", "Regression"]) {
  test(`rejects numbered private provenance with ${prefix} casing`, () => {
    const result = scanTrackedText(`// ${prefix}-${123456}: preserve the invariant\n`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private numbered provenance in source\.ts/);
  });
}

test("allows ordinary regression descriptions without tracker provenance", () => {
  const result = scanTrackedText("// Regression coverage preserves the payment invariant.\n");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /public safety checked 1 tracked files/);
});

for (const text of [
  `// ${"(tracked"} change): preserve the invariant\n`,
  `export const hint = "Ready ${"(tracked"} change)";\n`,
]) {
  test(`rejects redaction residue in ${text.startsWith("//") ? "source comments" : "runtime strings"}`, () => {
    const result = scanTrackedText(text);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /redaction residue in source\.ts/);
  });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";

const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
const guard = new URL("../scripts/check-bundled-notices.mjs", import.meta.url);
const license = "MIT License\nCopyright Example Contributors\nPermission is hereby granted.\n";

function fixture(context, notice) {
  const root = mkdtempSync(join(tmpdir(), "bundled-notice-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "node_modules/example"), { recursive: true });
  copyFileSync(guard, join(root, "scripts/check-bundled-notices.mjs"));
  writeFileSync(join(root, "NOTICE"), notice);
  writeFileSync(
    join(root, "node_modules/example/package.json"),
    JSON.stringify({ name: "example", version: "1.0.0" })
  );
  writeFileSync(join(root, "node_modules/example/LICENSE"), license);
  writeFileSync(join(root, "node_modules/example/index.js"), "export const value = 1;\n");
  writeFileSync(
    join(root, "dist/metafile-esm.json"),
    JSON.stringify({
      outputs: {
        "dist/dvmctl.js": { inputs: { "node_modules/example/index.js": { bytesInOutput: 12 } } },
      },
    })
  );
  return root;
}

function check(root) {
  return spawnSync(process.execPath, [join(root, "scripts/check-bundled-notices.mjs")], {
    encoding: "utf8",
  });
}

test("license check accepts complete notices and removes build metadata", (context) => {
  const root = fixture(context, `example@1.0.0\n${license}`);
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "dist/metafile-esm.json")), false);
});

test("license check rejects a missing exact dependency version", (context) => {
  const root = fixture(context, `example@0.9.0\n${license}`);
  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing bundled dependency example@1\.0\.0/);
});

test("license check rejects truncated license text", (context) => {
  const root = fixture(context, "example@1.0.0\nMIT License\n");
  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not contain the complete LICENSE/);
});

test("license check refuses a dependency without reviewable license text", (context) => {
  const root = fixture(context, `example@1.0.0\n${license}`);
  rmSync(join(root, "node_modules/example/LICENSE"));
  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No license file found for example@1\.0\.0/);
});

function setInput(root, input) {
  writeFileSync(
    join(root, "dist/metafile-esm.json"),
    JSON.stringify({
      outputs: { "dist/dvmctl.js": { inputs: { [input.split(sep).join("/")]: { bytesInOutput: 12 } } } },
    })
  );
}

function externalPackage(context) {
  const cache = mkdtempSync(join(tmpdir(), "bundled-notice-cache-"));
  context.after(() => rmSync(cache, { recursive: true, force: true }));
  mkdirSync(join(cache, "node_modules/example"), { recursive: true });
  writeFileSync(
    join(cache, "node_modules/example/package.json"),
    JSON.stringify({ name: "example", version: "1.0.0" })
  );
  writeFileSync(join(cache, "node_modules/example/LICENSE"), license);
  writeFileSync(join(cache, "node_modules/example/index.js"), "export const value = 1;\n");
  return cache;
}

test("license check accepts sibling-relative inputs from linked node_modules", (context) => {
  const root = fixture(context, `example@1.0.0\n${license}`);
  const cache = externalPackage(context);
  rmSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(cache, "node_modules"), join(root, "node_modules"), directoryLinkType);
  setInput(root, relative(root, join(cache, "node_modules/example/index.js")));
  const result = check(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, "dist/metafile-esm.json")), false);
});

test("license check rejects inputs from an undeclared external dependency cache", (context) => {
  const root = fixture(context, `example@1.0.0\n${license}`);
  const cache = externalPackage(context);
  setInput(root, relative(root, join(cache, "node_modules/example/index.js")));
  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot identify a bundled dependency's license owner/);
  assert.equal(existsSync(join(root, "dist/metafile-esm.json")), true);
});

test("license check rejects package symlinks escaping the declared dependency directory", (context) => {
  const root = fixture(context, `example@1.0.0\n${license}`);
  const cache = externalPackage(context);
  rmSync(join(root, "node_modules/example"), { recursive: true });
  symlinkSync(join(cache, "node_modules/example"), join(root, "node_modules/example"), directoryLinkType);
  const result = check(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot identify a bundled dependency's license owner/);
  assert.equal(existsSync(join(root, "dist/metafile-esm.json")), true);
});

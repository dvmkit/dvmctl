import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

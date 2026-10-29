import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

/** @param {string} source */
function assertExternalSdk(source) {
  const ast = ts.createSourceFile("dvmctl.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isVariableDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name && ts.isIdentifier(node.name)) {
      assert.doesNotMatch(node.name.text, /^createDVMHost(?:\d+|[_$]\w*)?$/u);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(imports.some((specifier) => specifier === "@dvmkit/sdk" || specifier.startsWith("@dvmkit/sdk/")));
  assert.doesNotMatch(source, /PostgresStore/);
}

test("bundle retains SDK imports instead of embedding SDK implementation", () => {
  assertExternalSdk(readFileSync(join(process.cwd(), "dist/dvmctl.js"), "utf8"));
});

test("SDK boundary permits public host calls and rejects embedded implementations", () => {
  const external = 'import { createDVMHost as sdkHost } from "@dvmkit/sdk/server";';
  assert.doesNotThrow(() => assertExternalSdk(`${external} sdkHost({ devMode: true });`));
  for (const implementation of [
    "function createDVMHost() {}",
    "const createDVMHost2 = () => ({});",
    "const createDVMHost_bundled = () => ({});",
    "const factory = function createDVMHost() {};",
    "const factory = class createDVMHost {};",
    "class PostgresStore {}",
  ]) {
    assert.throws(() => assertExternalSdk(`${external} ${implementation}`), assert.AssertionError);
  }
  assert.throws(() => assertExternalSdk("const sdkWasBundled = true;"), assert.AssertionError);
});

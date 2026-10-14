import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

test("bundle retains SDK imports instead of embedding SDK implementation", () => {
  const source = readFileSync(join(process.cwd(), "dist/dvmctl.js"), "utf8");
  const ast = ts.createSourceFile("dvmctl.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(imports.some((specifier) => specifier === "@dvmkit/sdk" || specifier.startsWith("@dvmkit/sdk/")));
  assert.doesNotMatch(source, /createDVMHost/);
  assert.doesNotMatch(source, /PostgresStore/);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { checkSourceBoundary } from "../scripts/check-source-boundary.mjs";
import { checkBundledSkillLinks, readBundledSkills } from "../scripts/check-bundled-skills.mjs";

const root = resolve(import.meta.dirname, "..");

test("authoritative source has no private implementation dependency", () => {
  assert.deepEqual(checkSourceBoundary(root), []);
});

function sourceFixture(source, module = "commands/admin/operator-only.ts", packageName) {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-source-boundary-"));
  mkdirSync(join(directory, "src/cli"), { recursive: true });
  mkdirSync(join(directory, "src", module, ".."), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: packageName ? { [packageName]: "1.0.0" } : {} }));
  writeFileSync(join(directory, "src", module), "export interface Secret { value: string }; export const secret = 'fixture';\n");
  const entry = join(directory, "src/cli/dvmctl.ts");
  writeFileSync(entry, source);
  return { directory, entry, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

for (const [syntax, source] of [
  ["value import", 'import { secret } from "../commands/admin/operator-only"; void secret;'],
  ["value export", 'export { secret } from "../commands/admin/operator-only";'],
  ["type-only import", 'import type { Secret } from "../commands/admin/operator-only"; export type Public = Secret;'],
  ["type-only export", 'export type { Secret } from "../commands/admin/operator-only";'],
  ["CommonJS require", 'const secret = require("../commands/admin/operator-only");'],
  ["import type", 'export type Public = import("../commands/admin/operator-only").Secret;'],
  ["import-equals require", 'import secret = require("../commands/admin/operator-only");'],
  ["dynamic import", 'void import("../commands/admin/operator-only");'],
]) {
  test(`source boundary rejects private ${syntax} even when its target exists`, () => {
    const fixture = sourceFixture(source);
    try {
      if (syntax === "type-only import") {
        const program = ts.createProgram([fixture.entry], { noEmit: true, strict: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext });
        assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
      }
      assert.ok(checkSourceBoundary(fixture.directory).some((problem) => problem === "src/cli/dvmctl.ts: private operator root: ../commands/admin/operator-only"));
    } finally { fixture.remove(); }
  });
}

for (const module of ["admin/operator-only.ts", "router/operator-only.ts", "isolate/operator-only.ts", "platform/operator-only.ts", "cli/operator-only.ts", "platform/nested/types.ts"]) {
  test(`source boundary rejects private root ${module}`, () => {
    const fixture = sourceFixture(`export * from "../${module}";`, module);
    try { assert.ok(checkSourceBoundary(fixture.directory).some((problem) => problem === `src/cli/dvmctl.ts: private operator root: ../${module}`)); }
    finally { fixture.remove(); }
  });
}

for (const module of ["cli/operator-only.ts", "cli/nested/dvmctl.ts", "other/cli/dvmctl.ts", "cli/dvmctl.js"]) {
  test(`source boundary rejects unimported CLI module ${module}`, () => {
    const fixture = sourceFixture("export {};", module);
    try { assert.ok(checkSourceBoundary(fixture.directory).includes(`src/${module}: private operator root`)); }
    finally { fixture.remove(); }
  });
}

for (const specifier of ["./dvmctl.ts", "./dvmctl", ".\\dvmctl.ts", ".\\dvmctl"]) {
  test(`source boundary permits its declared CLI entry ${specifier}`, () => {
    const fixture = sourceFixture(`export * from ${JSON.stringify(specifier)};`, "builder-platform/types.ts");
    try { assert.deepEqual(checkSourceBoundary(fixture.directory), []); }
    finally { fixture.remove(); }
  });
}

test("source boundary rejects private CLI imports with Windows separators", () => {
  const specifier = "..\\cli\\operator-only";
  const fixture = sourceFixture(`export * from ${JSON.stringify(specifier)};`, "cli/operator-only.ts");
  try { assert.ok(checkSourceBoundary(fixture.directory).includes(`src/cli/dvmctl.ts: private operator root: ${specifier}`)); }
  finally { fixture.remove(); }
});

test("source boundary accepts local builder helpers and declared SDK subpaths", () => {
  const fixture = sourceFixture('export * from "../builder-platform/types.ts"; import type { Public } from "@dvmkit/sdk/internal";', "builder-platform/types.ts", "@dvmkit/sdk");
  try { assert.deepEqual(checkSourceBoundary(fixture.directory), []); }
  finally { fixture.remove(); }
});

for (const module of ["capability-manifest.ts", "fly-naming.ts", "inherit-secrets.ts", "operated-dvms.ts", "types.ts", "vm-config.ts"]) {
  test(`source boundary permits the shared platform module ${module} only at its declared location`, () => {
    const fixture = sourceFixture(`export * from "../platform/${module}";`, `platform/${module}`);
    try { assert.deepEqual(checkSourceBoundary(fixture.directory), []); }
    finally { fixture.remove(); }
  });
}

test("source boundary rejects a declared operator package", () => {
  const fixture = sourceFixture('import Stripe from "stripe/resources";', "builder-platform/types.ts", "stripe");
  try { assert.ok(checkSourceBoundary(fixture.directory).some((problem) => problem.includes("private operator package"))); }
  finally { fixture.remove(); }
});

test("source boundary rejects a relative dependency outside its source tree", () => {
  const fixture = sourceFixture('import { secret } from "../../operator-only.ts";', "builder-platform/types.ts");
  try { writeFileSync(join(fixture.directory, "operator-only.ts"), "export const secret = 1;"); assert.ok(checkSourceBoundary(fixture.directory).some((problem) => problem.includes("outside authoritative source"))); }
  finally { fixture.remove(); }
});

test("all bundled skill links resolve inside their shipped skill", () => {
  assert.deepEqual(checkBundledSkillLinks(readBundledSkills(root)), []);
});

function skills(source) {
  return new Map([
    ["skills/build-dvm/SKILL.md", source],
    ["skills/build-dvm/references/guide.md", "# Service guide\n## Ready & waiting\n## Ready & waiting\n"],
    ["README.md", "# Outside the skill\n"],
  ]);
}

test("bundled skill links accept relative files, fragments, reference links and public URLs", () => {
  assert.deepEqual(checkBundledSkillLinks(skills('[Guide](references/guide.md#ready--waiting)\n[Again][guide]\n[guide]: references/guide.md#ready--waiting-1\n[Public](https://example.com/docs)\n')), []);
});

test("bundled skill shortcut references resolve declared labels without treating plain bracketed text as links", () => {
  assert.deepEqual(checkBundledSkillLinks(skills('[Guide]\n[guide][]\n[Again][guide]\n[Ordinary text]\n`[Guide]`\n\n[Guide]: references/guide.md#ready--waiting\n')), []);
});

test("bundled skill references normalize label whitespace and case for valid destinations", () => {
  assert.deepEqual(checkBundledSkillLinks(skills('[GUIDE   link]\n[Guide\tlink][]\n[Again][guide   LINK]\n\n[Guide link]: references/guide.md#ready--waiting\n')), []);
});

test("bundled skill references retain a valid first definition when a later duplicate escapes", () => {
  assert.deepEqual(checkBundledSkillLinks(skills('[Guide]\n\n[Guide]: references/guide.md\n[guide]: ../../README.md\n')), []);
});

for (const [name, source] of [
  ["normalized shortcut label", '[Guide   link]\n\n[Guide link]: ../../README.md\n'],
  ["first shortcut definition", '[Guide]\n\n[Guide]: ../../README.md\n[Guide]: references/guide.md\n'],
]) {
  test(`bundled skill references reject escapes through ${name}`, () => {
    assert.ok(checkBundledSkillLinks(skills(source)).some((problem) => problem.endsWith("link escapes bundled skill")));
  });
}

for (const [name, target, expected] of [
  ["path escape", "../../README.md", "link escapes bundled skill"],
  ["missing fragment", "references/guide.md#not-there", "missing linked fragment"],
  ["missing file", "references/missing.md", "missing linked file"],
]) {
  test(`bundled skill shortcut references reject ${name}`, () => {
    assert.ok(checkBundledSkillLinks(skills(`[Guide]\n\n[Guide]: ${target}\n`)).some((problem) => problem.endsWith(expected)));
  });
}

for (const [name, source, expected] of [
  ["path escape", "[Outside](../../README.md)", "link escapes bundled skill"],
  ["encoded path escape", "[Outside](%2e%2e/%2e%2e/README.md)", "link escapes bundled skill"],
  ["filesystem URL escape", "[Outside](file:///private/guide.md)", "link escapes bundled skill"],
  ["empty label", "[ ](references/guide.md)", "empty link label"],
  ["missing file", "[Missing](references/missing.md)", "missing linked file"],
  ["missing fragment", "[Missing](references/guide.md#not-there)", "missing linked fragment"],
  ["missing reference", "[Missing][undefined]", "missing link destination"],
  ["private dated note", "[Note](notes/2026-05/2026-05-17-decision.md)", "private dated-note reference"],
  ["private dated note in example", "```md\n[Note](notes/2026-05/2026-05-17-decision.md)\n```", "private dated-note reference"],
  ["private tracker URL", `[Issue](https://${"linear"}.app/team/issue/fixture)`, "private tracker reference"],
  ["private tracker key", `[${"DVM"}-1234](https://example.com)`, "private tracker reference"],
]) {
  test(`bundled skill link validation rejects ${name}`, () => {
    assert.ok(checkBundledSkillLinks(skills(source)).some((problem) => problem.endsWith(expected)));
  });
}

const wireUnions = JSON.parse(readFileSync(join(root, "test/fixtures/builder-wire-unions.json"), "utf8"));
function declaredUnion(source, name) {
  const ast = ts.createSourceFile("types.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  assert.ok(declaration && ts.isTypeAliasDeclaration(declaration), `missing union ${name}`);
  const types = ts.isUnionTypeNode(declaration.type) ? declaration.type.types : [declaration.type];
  return types.map((node) => {
    assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal), `${name} must remain a string wire union`);
    return node.literal.text;
  }).sort();
}
const typeSource = readFileSync(join(root, "src/builder-platform/types.ts"), "utf8");
for (const [name, members] of Object.entries(wireUnions)) {
  test(`${name} matches the exhaustive public service wire contract`, () => {
    assert.deepEqual(declaredUnion(typeSource, name), members);
    const omission = typeSource.replace(new RegExp(`(export type ${name} = )([^;]+)`), (_, prefix, literals) => prefix + literals.replace(new RegExp(`"${members[0]}"\\s*\\|\\s*|\\s*\\|\\s*"${members[0]}"`), ""));
    assert.notDeepEqual(declaredUnion(omission, name), members, "a missing member must break the contract");
    const addition = typeSource.replace(new RegExp(`(export type ${name} = [^;]+)`), '$1 | "unsupported_wire_value"');
    assert.notDeepEqual(declaredUnion(addition, name), members, "an extra member must break the contract");
  });
}

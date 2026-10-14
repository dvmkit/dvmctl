// @ts-check
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { builtinModules } from "node:module";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
const sharedPlatformFiles = new Set(["capability-manifest.ts", "fly-naming.ts", "inherit-secrets.ts", "operated-dvms.ts", "types.ts", "vm-config.ts"]);
/** @param {string} path @param {boolean} [sourcePath] */
function privateRoot(path, sourcePath = false) {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|\/)(?:commands\/admin|admin|router|isolate)(?:\/|$)/u.test(normalized)) return true;
  const cli = normalized.match(/(?:^|\/)cli\/(.+)$/u);
  if (cli && (sourcePath ? normalized !== "src/cli/dvmctl.ts" && normalized !== "src/cli/dvmctl" : cli[1] !== "dvmctl.ts" && cli[1] !== "dvmctl")) return true;
  const platform = normalized.match(/(?:^|\/)platform\/(.+)$/u);
  return Boolean(platform && !sharedPlatformFiles.has(/\.[cm]?[jt]s$/u.test(platform[1]) ? platform[1] : `${platform[1]}.ts`));
}

/** @param {string} source @param {string} file @returns {string[]} */
export function sourceSpecifiers(source, file) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  /** @type {string[]} */ const specifiers = [];
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) specifiers.push(node.argument.literal.text);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) specifiers.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return specifiers;
}

/** @param {string} root @returns {string[]} */
export function checkSourceBoundary(root) {
  const sourceRoot = resolve(root, "src");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const packages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies }));
  /** @type {string[]} */ const problems = [];
  /** @param {string} directory */
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "__tests__") continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
      if (privateRoot(relative(root, file), true)) problems.push(`${relative(root, file)}: private operator root`);
      for (const specifier of sourceSpecifiers(readFileSync(file, "utf8"), file)) {
        let reason;
        if (privateRoot(specifier)) reason = "private operator root";
        else if (specifier.startsWith(".") || isAbsolute(specifier)) {
          const localSpecifier = specifier.replaceAll("\\", "/");
          const destination = resolve(directory, localSpecifier);
          if (!destination.startsWith(`${sourceRoot}${sep}`)) reason = "outside authoritative source";
          else if (privateRoot(relative(root, destination), true)) reason = "private operator root";
          else {
            const resolved = ts.resolveModuleName(localSpecifier, file, { moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true }, ts.sys).resolvedModule;
            if (resolved && !realpathSync(resolved.resolvedFileName).startsWith(`${realpathSync(sourceRoot)}${sep}`)) reason = "outside authoritative source";
          }
        } else if (!specifier.startsWith("node:")) {
          const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
          if (packageName === "stripe") reason = "private operator package";
          else if (!builtins.has(specifier) && !packages.has(packageName)) reason = "undeclared package";
        }
        if (reason) problems.push(`${relative(root, file)}: ${reason}: ${specifier}`);
      }
    }
  }
  walk(sourceRoot);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkSourceBoundary(resolve(import.meta.dirname, ".."));
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else process.stdout.write("source boundary checked\n");
}

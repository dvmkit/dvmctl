import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { DvmError } from "@dvmkit/sdk/internal";

import { CLI_VERSION } from "../../lib/version.ts";
import {
  agentsTemplate,
  claudeTemplate,
  dockerfileTemplate,
  envExampleTemplate,
  gitignoreTemplate,
  packageJsonTemplate,
  readmeTemplate,
  serveTemplate,
  tsconfigTemplate,
} from "./create/templates/shared.ts";
import { handlerTemplate, testTemplate } from "./create/templates/simple.ts";

export interface CreateOptions {
  price?: string;
  name?: string;
  description?: string;
}

interface CreateFileSystem {
  lstatSync: typeof lstatSync;
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
}

export class ScaffoldCollisionError extends DvmError {
  constructor(readonly destination: string) {
    super(
      "scaffold_destination_exists",
      `${destination} already exists. Choose a different directory.`,
      "Choose a new project directory; dvmctl never overwrites scaffold files.",
      { destination }
    );
    this.name = "ScaffoldCollisionError";
  }
}

/** Scaffold a new DVM project. */
export async function create(
  dir: string,
  opts: CreateOptions,
  fs: CreateFileSystem = { lstatSync, mkdirSync, writeFileSync }
): Promise<void> {
  const absDir = resolve(process.cwd(), dir);
  const dirName = basename(absDir);
  const name = opts.name ?? toTitleCase(dirName);
  const price = opts.price ?? "$0.01";
  const tag = toKebabCase(dirName);

  let description = opts.description;
  if (!description && process.stdin.isTTY) {
    description = await promptLine(`Description for ${name}: `);
  }
  description = description ?? "A DVM built with dvmkit";

  const files: { name: string; content: string }[] = [
    { name: "handler.ts", content: handlerTemplate({ name, description, price, tag }) },
    { name: "handler.test.ts", content: testTemplate({ name, tag }) },
    { name: "serve.ts", content: serveTemplate() },
    { name: "Dockerfile", content: dockerfileTemplate() },
    { name: "package.json", content: packageJsonTemplate({ dirName }) },
    { name: "tsconfig.json", content: tsconfigTemplate() },
    { name: ".env.example", content: envExampleTemplate() },
    { name: ".gitignore", content: gitignoreTemplate() },
    { name: "README.md", content: readmeTemplate({ name, dirName }) },
    { name: "AGENTS.md", content: agentsTemplate({ cliVersion: CLI_VERSION }) },
    { name: "CLAUDE.md", content: claudeTemplate() },
  ];

  // Check every output before creating anything. A second process can still
  // race this check, so writes below use exclusive creation as well.
  for (const file of files) {
    const destination = join(absDir, file.name);
    assertDestinationAbsent(destination, fs);
  }

  fs.mkdirSync(absDir, { recursive: true });

  for (const file of files) {
    const destination = join(absDir, file.name);
    try {
      fs.writeFileSync(destination, file.content, { encoding: "utf-8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ScaffoldCollisionError(destination);
      }
      throw error;
    }
  }

  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

  console.log("");
  console.log(`  ${green("+")} ${bold(dirName + "/")}`);
  console.log("");
  for (const file of files) {
    const label =
      file.name === "handler.ts"
        ? dim("  your DVM logic")
        : file.name === "handler.test.ts"
          ? dim("  passing tests included")
          : file.name === "serve.ts"
            ? dim("  production entry point")
            : file.name === "Dockerfile"
              ? dim("  add system deps here")
              : "";
    console.log(`    ${dim("├")} ${file.name}${label}`);
  }
  console.log("");
  console.log(`  ${bold("Get started:")}`);
  console.log("");
  console.log(`    cd ${shellQuote(dir)}`);
  console.log(`    npm install`);
  console.log(`    npm test              ${dim("# verify everything works")}`);
  console.log(`    npm run dev           ${dim("# " + cyan("http://localhost:3000/_dev"))}`);
  console.log("");
  console.log(`  ${bold("Build with AI:")} send this to your coding agent:`);
  console.log("");
  console.log(
    `    ${cyan(`Read the README.md, then implement a DVM that ${description.toLowerCase()}`)}`
  );
  console.log("");
}

function toTitleCase(kebab: string): string {
  return kebab
    .split(/[-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

/** Quote a value for copy-paste into a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertDestinationAbsent(destination: string, fs: CreateFileSystem): void {
  try {
    fs.lstatSync(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new ScaffoldCollisionError(destination);
}

function promptLine(query: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

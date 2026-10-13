// @ts-check
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const prohibited = [
  { expression: /\(tracked change\)/u, reason: "redaction residue" },
  { expression: /\bregression-\d+\b/iu, reason: "private numbered provenance" },
  { expression: /\bDVM-\d+\b/u, reason: "private tracker key" },
  { expression: /linear\.app\//u, reason: "private tracker URL" },
  { expression: /\/Users\//u, reason: "local filesystem path" },
  { expression: /github\.com-anon/u, reason: "private Git transport detail" },
  { expression: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u, reason: "private key material" },
  { expression: /\bnpm_[A-Za-z0-9]{20,}\b/u, reason: "npm credential" },
];
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean);
for (const file of files) {
  if (file === "scripts/public-safety.mjs") continue;
  const text = readFileSync(file, "utf8");
  for (const rule of prohibited) if (rule.expression.test(text)) throw new Error(`public safety: ${rule.reason} in ${file}`);
}
process.stdout.write(`public safety checked ${files.length} tracked files\n`);

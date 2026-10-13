// @ts-check
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {string} text */
function headings(text) {
  const used = new Map();
  const ids = new Set();
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = used.get(base) ?? 0;
    used.set(base, count + 1); ids.add(count ? `${base}-${count}` : base);
  }
  for (const match of text.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

/** @param {string} label */
function referenceLabel(label) {
  return label.trim().replace(/\s+/gu, " ").toLowerCase();
}

/** @param {Map<string, string>} files @returns {string[]} */
export function checkBundledSkillLinks(files) {
  /** @type {string[]} */ const problems = [];
  for (const [file, source] of files) {
    if (!file.startsWith("skills/") || !file.endsWith(".md")) continue;
    // Code examples can contain Markdown syntax without declaring navigable links.
    const text = source.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, "");
    const definitionPattern = /^ {0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm;
    const inlinePattern = /!?\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+["'][^\n]*?["'])?\s*\)/g;
    const referencePattern = /!?\[([^\]]*)\]\[([^\]]*)\]/g;
    /** @type {Map<string, string>} */ const definitions = new Map();
    for (const match of text.matchAll(definitionPattern)) {
      const label = referenceLabel(match[1]);
      if (!definitions.has(label)) definitions.set(label, match[2]);
    }
    /** @type {{label: string, target: string | undefined}[]} */ const links = [];
    for (const match of text.matchAll(inlinePattern)) links.push({ label: match[1], target: match[2] });
    for (const match of text.matchAll(referencePattern)) links.push({ label: match[1], target: definitions.get(referenceLabel(match[2] || match[1])) });
    const shortcutText = text.replace(definitionPattern, " ").replace(inlinePattern, " ").replace(referencePattern, " ").replace(/`+[^`]*`+/g, " ");
    for (const match of shortcutText.matchAll(/!?\[([^\]]+)\]/g)) {
      const target = definitions.get(referenceLabel(match[1]));
      if (target !== undefined) links.push({ label: match[1], target });
    }
    if (/linear\.app\/|\bDVM-\d+\b/u.test(source)) problems.push(`${file}: private tracker reference`);
    if (/\bnotes\/\d{4}-\d{2}(?:\/|-)/u.test(source)) problems.push(`${file}: private dated-note reference`);
    for (const { label, target } of links) {
      const fail = (/** @type {string} */ reason) => problems.push(`${file}: ${reason}`);
      if (!label.trim()) { fail("empty link label"); continue; }
      if (!target) { fail("missing link destination"); continue; }
      if (/^(?:https?|mailto):/iu.test(target)) continue;
      if (/^[a-z][a-z\d+.-]*:/iu.test(target)) { fail("link escapes bundled skill"); continue; }
      let decoded;
      try { decoded = decodeURIComponent(target); } catch { fail("invalid link encoding"); continue; }
      const [path, fragment] = decoded.split("#", 2);
      const destination = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
      const skillRoot = file.split("/").slice(0, 2).join("/");
      if (path.startsWith("/") || path.includes("\\") || !destination.startsWith(`${skillRoot}/`)) { fail("link escapes bundled skill"); continue; }
      const contents = files.get(destination);
      if (contents === undefined) { fail("missing linked file"); continue; }
      if (fragment !== undefined && (!fragment || !headings(contents).has(fragment))) fail("missing linked fragment");
    }
  }
  return problems;
}

/** @param {string} root */
export function readBundledSkills(root) {
  /** @type {Map<string, string>} */ const files = new Map();
  /** @param {string} directory */
  function walk(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(path, readFileSync(join(root, path), "utf8"));
    }
  }
  walk("skills"); return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkBundledSkillLinks(readBundledSkills(resolve(dirname(fileURLToPath(import.meta.url)), "..")));
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
  else process.stdout.write("bundled skill links checked\n");
}

/**
 * Shape-drift utilities for the CLI reference docs.
 *
 * `check:cli-docs` gates command + per-flag coverage but not the
 * accuracy of the JSON output sketches in the docs. These helpers let a vitest
 * harness capture the object a handler actually passes to `json()` and diff it
 * against the documented fence: field names, JS types, timestamp magnitude
 * (epoch-ms vs unix-seconds), and the `ProviderText` provenance wrapper.
 *
 * Pure and side-effect-free so both `scripts/check-cli-docs.ts` and the
 * `doc-shapes-*` tests can import it (the check script runs on import).
 */

/** A documented JSON output block, keyed within its `## <command>` section by the scenario label (`**JSON output — <scenario>:**`). `raw` is the un-parsed fence body; parse lazily via `resolveFence` so non-strict fences in *uncovered* sections never break the covered set. */
export interface DocFence {
  scenario: string;
  raw: string;
}

/** A single field-level discrepancy between a documented fence and a handler's runtime output. */
export interface Mismatch {
  path: string;
  reason: string;
}

/** Options for `compareShape`. `ignoreKeys` drops the named keys from the bidirectional key check at every object level (used for conditionally-present fields a single fence can't represent). */
export interface CompareOpts {
  ignoreKeys?: string[];
}

/** Keys `json()` injects or that are envelope-level and conditionally present, ignored everywhere by default. */
const DEFAULT_IGNORE_KEYS = ["trace_id"];

/** Parse a Markdown/MDX file into a map from `## heading` text → section body (body runs until the next `^## ` line or EOF). Shared with `check-cli-docs.ts`. */
export function parseDocSections(md: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = md.split("\n");
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (current) sections.set(current.heading, current.body.join("\n"));
      current = { heading: match[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.set(current.heading, current.body.join("\n"));
  return sections;
}

/**
 * Extract every labeled JSON output fence from a CLI reference doc, keyed by
 * `## <command>` heading. A fence is a ` ```json ` block immediately following
 * a `**JSON output … :**` label; the scenario is the label text after
 * "JSON output" (an unlabeled `**JSON output:**` → scenario `"default"`).
 * Inline labels with no following fence (e.g. "same shape as `budget set`") are
 * skipped. Fence bodies are stored raw and parsed on demand by `resolveFence`.
 */
export function extractJsonFences(md: string): Map<string, DocFence[]> {
  const out = new Map<string, DocFence[]>();
  for (const [heading, body] of parseDocSections(md)) {
    const lines = body.split("\n");
    const fences: DocFence[] = [];
    for (let i = 0; i < lines.length; i++) {
      const label = /^\*\*JSON output\b(.*?)\*\*/.exec(lines[i]);
      if (!label) continue;
      const scenario = normalizeScenario(label[1]);
      // Look for a ```json fence before the next label / heading-like break.
      let j = i + 1;
      while (j < lines.length && !/^```json\b/.test(lines[j])) {
        if (/^\*\*JSON output\b/.test(lines[j])) break; // next label, no fence for this one
        j++;
      }
      if (j >= lines.length || !/^```json\b/.test(lines[j])) continue;
      const buf: string[] = [];
      let k = j + 1;
      for (; k < lines.length && !/^```\s*$/.test(lines[k]); k++) buf.push(lines[k]);
      fences.push({ scenario, raw: buf.join("\n") });
      i = k;
    }
    if (fences.length > 0) out.set(heading, fences);
  }
  return out;
}

/**
 * Find the fence for `section` whose scenario matches `scenarioQuery`
 * (normalized substring match — unique hit required) and `JSON.parse` it.
 * Throws a descriptive error when the section/fence is missing, ambiguous, or
 * the fence body is not valid JSON — surfacing doc drift the comparator can't.
 */
export function resolveFence(
  fences: Map<string, DocFence[]>,
  section: string,
  scenarioQuery: string
): unknown {
  const inSection = fences.get(section);
  if (!inSection || inSection.length === 0) {
    throw new Error(`No JSON output fence found for "## ${section}"`);
  }
  // An unlabeled `**JSON output:**` fence has scenario "default", so the
  // "default" query matches it like any other token (substring, either way).
  const q = normalizeScenario(scenarioQuery);
  const hits = inSection.filter((f) => f.scenario.includes(q) || q.includes(f.scenario));
  if (hits.length === 0) {
    const have = inSection.map((f) => `"${f.scenario}"`).join(", ");
    throw new Error(
      `No fence in "## ${section}" matches scenario "${scenarioQuery}". Available: ${have}`
    );
  }
  if (hits.length > 1) {
    const have = hits.map((f) => `"${f.scenario}"`).join(", ");
    throw new Error(
      `Scenario "${scenarioQuery}" is ambiguous in "## ${section}" — matched: ${have}`
    );
  }
  try {
    return JSON.parse(hits[0].raw);
  } catch (err) {
    throw new Error(
      `Fence "${hits[0].scenario}" in "## ${section}" is not valid JSON: ${(err as Error).message}`,
      { cause: err }
    );
  }
}

/**
 * Structurally diff a documented fence value against a handler's runtime
 * output, returning every discrepancy. Compares field names (bidirectionally —
 * a fence shows the same scenario we capture), JS types, timestamp magnitude
 * for time-named numeric fields, and the `ProviderText` wrapper. An empty array
 * means the doc accurately describes the output.
 */
export function compareShape(
  docValue: unknown,
  runtimeValue: unknown,
  opts: CompareOpts = {}
): Mismatch[] {
  const ignore = new Set([...DEFAULT_IGNORE_KEYS, ...(opts.ignoreKeys ?? [])]);
  const out: Mismatch[] = [];
  compare(docValue, runtimeValue, "$", "", ignore, out);
  return out;
}

function compare(
  doc: unknown,
  rt: unknown,
  path: string,
  key: string,
  ignore: Set<string>,
  out: Mismatch[]
): void {
  // Provenance wrapper: { _source: "provider", text } must appear on both sides.
  const docPT = isProviderText(doc);
  const rtPT = isProviderText(rt);
  if (docPT || rtPT) {
    if (docPT && rtPT) return;
    out.push({
      path,
      reason: docPT
        ? "doc expects a ProviderText wrapper ({ _source: 'provider', text }); handler output is not wrapped"
        : "handler wraps this in ProviderText; doc does not",
    });
    return;
  }

  if (doc === null || rt === null) {
    if (doc !== rt) {
      out.push({ path, reason: `doc=${jsType(doc)} runtime=${jsType(rt)}` });
    }
    return;
  }

  if (Array.isArray(doc) || Array.isArray(rt)) {
    if (!Array.isArray(doc) || !Array.isArray(rt)) {
      out.push({ path, reason: `doc=${jsType(doc)} runtime=${jsType(rt)}` });
      return;
    }
    // Every row the fence spells out, not just the first: a documented array is
    // a claim about each entry it shows, and a page that sketches two rails or
    // two pending fundings would otherwise leave every row after the first
    // shape-unchecked. Runtime rows past the fence's own length stay
    // undescribed, the same way a fence may document a subset of an object.
    for (let i = 0; i < Math.min(doc.length, rt.length); i++) {
      compare(doc[i], rt[i], `${path}[${String(i)}]`, key, ignore, out);
    }
    return;
  }

  if (typeof doc === "object" || typeof rt === "object") {
    if (typeof doc !== "object" || typeof rt !== "object") {
      out.push({ path, reason: `doc=${jsType(doc)} runtime=${jsType(rt)}` });
      return;
    }
    const docObj = doc as Record<string, unknown>;
    const rtObj = rt as Record<string, unknown>;
    for (const k of Object.keys(docObj)) {
      if (ignore.has(k)) continue;
      if (!(k in rtObj)) {
        out.push({ path: `${path}.${k}`, reason: "documented field missing from handler output" });
        continue;
      }
      compare(docObj[k], rtObj[k], `${path}.${k}`, k, ignore, out);
    }
    for (const k of Object.keys(rtObj)) {
      if (ignore.has(k) || k in docObj) continue;
      out.push({ path: `${path}.${k}`, reason: "handler emits field not documented" });
    }
    return;
  }

  // Primitives.
  if (typeof doc !== typeof rt) {
    out.push({ path, reason: `type: doc=${typeof doc} runtime=${typeof rt}` });
    return;
  }
  if (typeof doc === "number" && typeof rt === "number" && isTimeKey(key)) {
    const dB = magnitudeBucket(doc);
    const rB = magnitudeBucket(rt);
    if (dB !== rB) {
      out.push({ path, reason: `timestamp magnitude: doc=${dB} runtime=${rB}` });
    }
  }
}

function isProviderText(v: unknown): v is { _source: "provider"; text: unknown } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as Record<string, unknown>)._source === "provider"
  );
}

/** Whether a field name denotes a timestamp, so a number→number diff also checks magnitude. Covers the doc conventions: `*At`, `*_at`, `timestamp`, `expires`, `resets`. */
function isTimeKey(key: string): boolean {
  return /(at$|timestamp|expires|resets)/i.test(key);
}

/** Bucket a numeric timestamp: unix-seconds (<1e11, ~1.7e9 today) vs epoch-millis (>=1e11, ~1.7e12 today). */
function magnitudeBucket(n: number): "seconds" | "millis" {
  return n < 1e11 ? "seconds" : "millis";
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Normalize a scenario label (or query) to lowercased alphanumeric tokens joined by single spaces; an empty label → "default". */
function normalizeScenario(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return slug.length === 0 ? "default" : slug;
}

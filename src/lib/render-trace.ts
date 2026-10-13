import type { TraceResult, TraceSpan } from "./platform-api-types.ts";

export interface RenderTraceOptions {
  color: boolean;
}

export function renderTrace(trace: TraceResult, opts: RenderTraceOptions): string {
  const lines: string[] = [];
  const c = opts.color ? ansi : noColor;

  const statusLabel = trace.status === "error" ? c.red("ERROR") : c.green("OK");
  const dimParts: string[] = [];
  for (const key of ["builder_id", "dvm_id", "dvm_slug", "rail"] as const) {
    const val = trace.dimensions[key];
    if (val != null) dimParts.push(`${key.replace("_id", "")} ${stringify(val)}`);
  }

  lines.push(
    `trace ${trace.trace_id}  duration ${fmtMs(trace.duration_ms)}  status ${statusLabel}` +
      (dimParts.length > 0 ? `  ${dimParts.join("  ")}` : "")
  );
  lines.push("");

  if (trace.truncated) {
    lines.push(
      c.yellow(
        "WARNING: trace contains more than 10000 spans; showing first 10000 ordered by start time."
      )
    );
    lines.push(c.yellow("This usually means a runaway span emitter (e.g. a tight loop logging)."));
    lines.push("");
  }

  const childrenOf = new Map<string | null, TraceSpan[]>();
  for (const span of trace.spans) {
    const key = span.parent_span_id;
    let list = childrenOf.get(key);
    if (!list) {
      list = [];
      childrenOf.set(key, list);
    }
    list.push(span);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.started_at_ms - b.started_at_ms);
  }

  interface FlatEntry {
    span: TraceSpan;
    prefix: string;
  }

  const flat: FlatEntry[] = [];

  function walk(parentId: string | null, prefixStack: string[]): void {
    const children = childrenOf.get(parentId);
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const span = children[i];
      const isLast = i === children.length - 1;
      const hasChildren = childrenOf.has(span.span_id);

      let glyph: string;
      if (prefixStack.length === 0) {
        glyph = hasChildren ? "─┬─ " : "─── ";
      } else {
        const connector = isLast ? "└" : "├";
        const branch = hasChildren ? "─┬─ " : "── ";
        glyph = connector + branch;
      }

      const prefix = prefixStack.join("") + glyph;
      flat.push({ span, prefix });

      const continuation = prefixStack.length === 0 ? "" : isLast ? "  " : "│ ";
      walk(span.span_id, [...prefixStack, continuation]);
    }
  }

  walk(null, []);

  // Handle orphan spans (parent_span_id points to a span not in the result set)
  const rendered = new Set(flat.map((e) => e.span.span_id));
  for (const span of trace.spans) {
    if (!rendered.has(span.span_id)) {
      flat.push({ span, prefix: "─── " });
    }
  }

  const traceStart = trace.started_at_ms;

  for (const { span, prefix } of flat) {
    const offset = span.started_at_ms - traceStart;
    const offsetStr = c.dim(`${String(offset).padStart(5)}ms `);
    const isLog = span.duration_ms === 0;

    let line: string;
    if (isLog) {
      const icon = levelIcon(span.level, c);
      const attrs = inlineKV(span.dimensions, span.attributes);
      line = `${offsetStr}${c.dim(prefix)}${icon} ${span.name}${attrs}`;
    } else {
      const dur = `[${fmtMs(span.duration_ms).padStart(7)}]`;
      const statusWord =
        span.status === "error" ? c.red("error") : span.status === "ok" ? c.green("ok") : "";
      const attrs = inlineKV(span.dimensions, span.attributes);
      line = `${offsetStr}${c.dim(prefix)}${span.name}${attrs} ${dur} ${statusWord}`;
    }

    lines.push(line);
  }

  if (Object.keys(trace.dimensions).length > 0) {
    lines.push("");
    lines.push("attributes:");
    const maxKeyLen = Math.max(...Object.keys(trace.dimensions).map((k) => k.length));
    for (const [k, v] of Object.entries(trace.dimensions)) {
      lines.push(`  ${k.padEnd(maxKeyLen + 2)}${String(v)}`);
    }
  }

  return lines.join("\n");
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function levelIcon(level: string, c: ColorFns): string {
  switch (level) {
    case "error":
      return c.red("\u2716");
    case "warn":
      return c.yellow("\u26A0");
    default:
      return c.blue("\u2139");
  }
}

/**
 * Merge span-level dimensions and attributes into a single inline `{k: v}` block.
 * Dimensions that also appear in trace-level header keys (builder_id, dvm_id, dvm_slug, rail)
 * are omitted to reduce noise — they're already in the header line.
 */
function inlineKV(dims: Record<string, unknown>, attrs: Record<string, unknown>): string {
  const headerKeys = new Set(["builder_id", "dvm_id", "dvm_slug", "rail"]);
  const merged: [string, unknown][] = [];
  for (const [k, v] of Object.entries(dims)) {
    if (!headerKeys.has(k)) merged.push([k, v]);
  }
  for (const [k, v] of Object.entries(attrs)) {
    merged.push([k, v]);
  }
  if (merged.length === 0) return "";
  const parts = merged.map(([k, v]) => {
    const s = stringify(v);
    return `${k}: ${s.length > 60 ? s.slice(0, 57) + "..." : s}`;
  });
  return ` {${parts.join(", ")}}`;
}

function stringify(val: unknown): string {
  if (typeof val === "object" && val !== null) return JSON.stringify(val);
  return String(val as string | number | boolean);
}

interface ColorFns {
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  dim(s: string): string;
}

const ansi: ColorFns = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const noColor: ColorFns = {
  red: (s) => s,
  green: (s) => s,
  yellow: (s) => s,
  blue: (s) => s,
  dim: (s) => s,
};

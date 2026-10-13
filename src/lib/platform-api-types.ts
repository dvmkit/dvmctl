/** A single span returned by the platform trace API. */
export interface TraceSpan {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  dataset: string;
  level: string;
  status: string;
  started_at_ms: number;
  ended_at_ms: number;
  duration_ms: number;
  service: string;
  service_version: string;
  host: string | null;
  dimensions: Record<string, unknown>;
  /** Current owner-qualified display name for the span's DVM when search resolves it. */
  dvm_qualified?: string | null;
  attributes: Record<string, unknown>;
  error_message: string | null;
  error_stack: string | null;
}

/** Full trace envelope returned by the platform trace API. */
export interface TraceResult {
  trace_id: string;
  status: "ok" | "error";
  duration_ms: number;
  started_at_ms: number;
  ended_at_ms: number;
  dimensions: Record<string, unknown>;
  span_count: number;
  truncated: boolean;
  truncation_hint?: string;
  spans: TraceSpan[];
}

/** Caller feedback returned by the builder feedback API. */
export interface FeedbackRow {
  verdict?: "up" | "down" | null;
  tier?: "claimed" | "receipt_verified" | null;
  receipt?: unknown;
  external_endpoint?: string | null;
  id: string;
  dvm_id: string | null;
  slug: string | null;
  owner_handle: string | null;
  job_id: string | null;
  trace_id: string | null;
  /** Ordinary feedback clears this at 90 days; retained verified proof follows identity rights. */
  caller_pubkey: string | null;
  body: string;
  created_at: string;
}

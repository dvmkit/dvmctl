/**
 * Resolve a `--since` value to a Unix-ms cutoff. Accepts a relative window
 * ("30s", "5m", "24h", "7d") or an absolute ISO 8601 timestamp. Used by
 * feedback-list commands so both CLIs accept
 * the same input format.
 */
export function parseSince(since: string): number {
  const trimmed = since.trim();
  const relMatch = /^(\d+)\s*(s|m|h|d)$/.exec(trimmed);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return Date.now() - n * multipliers[unit];
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid --since value "${since}". Use a relative window (e.g. "24h", "7d") or an ISO 8601 timestamp.`
    );
  }
  return parsed;
}

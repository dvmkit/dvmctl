export interface FeatureRequirement {
  /** Env vars that must all be present for the feature to serve. */
  requires?: string[];
  /** Env vars of which at least one must be present (provider choice). */
  requiresAny?: string[];
}

/**
 * Parsed `package.json#dvmkit.features` — advertised optional feature name to
 * the provider key(s) it needs. The deploy pipeline reconciles this against the
 * keys a deploy will actually make available and warns on any gap, so an
 * advertised-but-unservable capability is visible to an operator before a caller
 * hits it.
 */
export type FeatureManifest = Record<string, FeatureRequirement>;

/**
 * Structured error thrown by {@link parseFeatures} when `package.json#dvmkit.features`
 * is malformed. The deploy API route maps this to a 400 with the same shape as
 * the vmConfig / inheritSecrets validation errors.
 */
export class FeatureManifestError extends Error {
  constructor(
    public code: "invalid_features",
    message: string
  ) {
    super(message);
    this.name = "FeatureManifestError";
  }
}

/**
 * Parse `package.json#dvmkit.features` into a validated {@link FeatureManifest}.
 * Accepts `undefined`/`null` (no features). Throws {@link FeatureManifestError}
 * on any malformed shape. Pure — no I/O, no env reads.
 */
export function parseFeatures(raw: unknown): FeatureManifest {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FeatureManifestError(
      "invalid_features",
      "`features` must be an object mapping feature names to their required env keys."
    );
  }
  const out: FeatureManifest = {};
  for (const [feature, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new FeatureManifestError(
        "invalid_features",
        `\`features.${feature}\` must be an object with \`requires\` and/or \`requiresAny\`.`
      );
    }
    const entry = value as Record<string, unknown>;
    const requires = parseKeyList(feature, "requires", entry.requires);
    const requiresAny = parseKeyList(feature, "requiresAny", entry.requiresAny);
    if (requires.length === 0 && requiresAny.length === 0) {
      throw new FeatureManifestError(
        "invalid_features",
        `\`features.${feature}\` must declare at least one key in \`requires\` or \`requiresAny\`.`
      );
    }
    const parsed: FeatureRequirement = {};
    if (requires.length > 0) parsed.requires = requires;
    if (requiresAny.length > 0) parsed.requiresAny = requiresAny;
    out[feature] = parsed;
  }
  return out;
}

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

function parseKeyList(feature: string, field: string, raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new FeatureManifestError(
      "invalid_features",
      `\`features.${feature}.${field}\` must be an array of env-var names.`
    );
  }
  for (const entry of raw) {
    if (typeof entry !== "string" || !KEY_RE.test(entry)) {
      throw new FeatureManifestError(
        "invalid_features",
        `\`features.${feature}.${field}\` entries must be uppercase env-var names (e.g. "ANTHROPIC_API_KEY"); got ${JSON.stringify(entry)}.`
      );
    }
  }
  return raw as string[];
}

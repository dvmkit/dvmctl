/** Error raised when a builder manifest declares an invalid inherited-secret pattern. */
export class InheritSecretsError extends Error {
  constructor(
    public code: "invalid_inherit_secrets",
    message: string
  ) {
    super(message);
    this.name = "InheritSecretsError";
  }
}

/** A validated exact env-var name or trailing-star prefix. */
export type InheritSecretPattern = string;

export const PLATFORM_INTERNAL_PREFIXES = [
  "FLY_",
  "STRIPE_",
  "PLATFORM_",
  "GITHUB_APP_",
  "RESEND_",
  "AVATAR_",
  "FEE_GATE_",
] as const;

export const PLATFORM_INTERNAL_EXACT: readonly string[] = [
  "APP_URL",
  "DATABASE_URL",
  "DVMKIT_BUILDER_ID",
  "DVMKIT_BUILDER_PUBKEY",
  "DVMKIT_BUILDER_ATTESTATION",
  "DVMKIT_BUILDER_SIGNATURE",
  "DVMKIT_CASHU_LOCK_PUBKEY",
  "DVMKIT_CASHU_MINTS",
  "DVMKIT_DVM_ID",
  "DVMKIT_FX_SOURCE",
  "DVMKIT_ISOLATE_SECRET",
  "DVMKIT_PLATFORM_CALLBACK",
  "DVMKIT_PLATFORM_TOKEN",
  "DVMKIT_PLATFORM_URL",
  "EXTERNAL_REGISTRY_AUTH_REQUIRED",
  "NPM_TOKEN",
] as const;

const PATTERN_RE = /^[A-Z][A-Z0-9_]*(\*)?$/;

/** Parse and validate package.json#dvmkit.inheritSecrets without platform implementation imports. */
export function parseInheritSecrets(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new InheritSecretsError(
      "invalid_inherit_secrets",
      "`inheritSecrets` must be an array of strings."
    );
  }
  return raw.map((entry) => {
    if (typeof entry !== "string") {
      throw new InheritSecretsError(
        "invalid_inherit_secrets",
        "`inheritSecrets` entries must be strings."
      );
    }
    validatePattern(entry);
    return entry;
  });
}

/** Whether a key belongs to a platform-reserved environment namespace. */
export function isPlatformInternalKey(key: string): boolean {
  return (
    PLATFORM_INTERNAL_EXACT.includes(key) ||
    PLATFORM_INTERNAL_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function validatePattern(pattern: string): void {
  if (pattern === "") {
    throw new InheritSecretsError(
      "invalid_inherit_secrets",
      "`inheritSecrets` entries must not be empty."
    );
  }
  if (pattern === "*") {
    throw new InheritSecretsError(
      "invalid_inherit_secrets",
      "`inheritSecrets` does not allow a bare `*` (would forward every platform secret)."
    );
  }
  if (!PATTERN_RE.test(pattern)) {
    throw new InheritSecretsError(
      "invalid_inherit_secrets",
      `\`inheritSecrets\` pattern ${JSON.stringify(pattern)} must be uppercase letters, digits, or underscores, optionally ending in '*'.`
    );
  }
  if (pattern.endsWith("*") && pattern.length - 1 < 3) {
    throw new InheritSecretsError(
      "invalid_inherit_secrets",
      `\`inheritSecrets\` glob ${JSON.stringify(pattern)} needs a literal prefix of at least 3 characters.`
    );
  }
  rejectPlatformInternal(pattern);
}

function rejectPlatformInternal(pattern: string): void {
  if (!pattern.endsWith("*")) {
    if (
      PLATFORM_INTERNAL_EXACT.includes(pattern) ||
      PLATFORM_INTERNAL_PREFIXES.some((prefix) => pattern.startsWith(prefix))
    ) {
      throw new InheritSecretsError(
        "invalid_inherit_secrets",
        `\`inheritSecrets\` pattern ${JSON.stringify(pattern)} targets a platform-internal env var; DVMs cannot inherit it.`
      );
    }
    return;
  }
  const literal = pattern.slice(0, -1);
  for (const denied of PLATFORM_INTERNAL_PREFIXES) {
    if (literal.startsWith(denied) || denied.startsWith(literal)) {
      throw new InheritSecretsError(
        "invalid_inherit_secrets",
        `\`inheritSecrets\` glob ${JSON.stringify(pattern)} would match the platform-internal namespace ${JSON.stringify(denied)}; DVMs cannot inherit it.`
      );
    }
  }
  for (const exact of PLATFORM_INTERNAL_EXACT) {
    if (exact.startsWith(literal)) {
      throw new InheritSecretsError(
        "invalid_inherit_secrets",
        `\`inheritSecrets\` glob ${JSON.stringify(pattern)} would match the platform-internal env var ${JSON.stringify(exact)}; DVMs cannot inherit it.`
      );
    }
  }
}

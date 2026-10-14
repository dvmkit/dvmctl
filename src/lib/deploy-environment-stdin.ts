import { DvmError } from "@dvmkit/sdk/internal";

const MAX_INPUT_BYTES = 64 * 1024;
const INPUT_DEADLINE_MS = 5_000;

/** Bound the secret-bearing input without reflecting its contents in errors. */
export async function readDeployEnvironmentStdin(): Promise<Record<string, string>> {
  const input = process.stdin;
  const hint = "Pipe a JSON object of string environment values to dvmctl deploy --env-stdin. Input must finish within 5 seconds and fit in 64 KiB.";
  const invalid = (message: string) => new DvmError("invalid_env_stdin", message, hint);
  if (input.isTTY) throw invalid("--env-stdin requires piped input.");
  if (input.readableEnded || input.destroyed) throw invalid("--env-stdin received no input.");

  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: DvmError) => {
      clearTimeout(deadline);
      input.pause();
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, size));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) finish(invalid("--env-stdin exceeds the 64 KiB input limit."));
      else chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = () => finish(invalid("Could not read --env-stdin input."));
    const onClose = () => finish(invalid("--env-stdin closed before input completed."));
    const deadline = setTimeout(() => finish(invalid("--env-stdin input did not finish within 5 seconds.")), INPUT_DEADLINE_MS);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
  });

  if (bytes.toString("utf8").trim() === "") throw invalid("--env-stdin received no input.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    // JSON parser diagnostics may contain secret values.
    throw invalid("--env-stdin must contain valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("--env-stdin must contain a JSON object of string values.");
  }
  const entries = Object.entries(parsed);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw invalid("--env-stdin environment values must all be strings.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Retain deployment diagnostics while removing known stdin values reflected by a provider. */
export function redactDeployEnvironmentError(error: unknown, environment: Readonly<Record<string, string>>): unknown {
  const secrets = [...new Set(Object.values(environment).filter((value) => value !== ""))]
    .sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return error;
  const text = (value: string) => {
    for (const secret of secrets) value = value.split(secret).join("[redacted]");
    return value;
  };
  const fields = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(fields);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [text(key), fields(entry)]));
    }
    return value;
  };
  if (error instanceof DvmError) {
    return new DvmError(
      text(error.code),
      text(error.message),
      error.hint === undefined ? undefined : text(error.hint),
      error.data === undefined ? undefined : fields(error.data) as Record<string, unknown>,
      error.display === undefined ? undefined : text(error.display),
      error.proseSources
    );
  }
  // The generic CLI boundary already suppresses unknown messages, but a safe
  // diagnostic code could itself contain a value reflected from stdin.
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const descriptors = Object.getOwnPropertyDescriptors(error);
    descriptors.code = { value: text(error.code), enumerable: true, configurable: true };
    return Object.create(Object.getPrototypeOf(error), descriptors) as Error;
  }
  return error;
}

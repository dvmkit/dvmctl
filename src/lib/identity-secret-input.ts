import { readFileSync } from "node:fs";

import { DvmError } from "@dvmkit/sdk/internal";

const MAX_INPUT_BYTES = 1024;
const INPUT_DEADLINE_MS = 5_000;
const SECRET_HEX = /^[0-9a-f]{64}$/;

const HINT =
  "Pipe the 32-byte secret key as 64 hex characters on stdin, or pass --from-file <path>. The secret is never accepted as a command argument.";

const invalid = (message: string) => new DvmError("invalid_identity_secret", message, HINT);

/** Normalise raw input to a lowercase 64-hex secret; errors never echo the input. */
export function parseIdentitySecret(raw: string): string {
  const candidate = raw.trim().toLowerCase();
  if (!SECRET_HEX.test(candidate)) {
    throw invalid("Identity secret must be a 32-byte key written as 64 hexadecimal characters.");
  }
  return candidate;
}

/** Read the identity secret from a file or piped stdin. */
export async function readIdentitySecret(opts: { fromFile?: string }): Promise<string> {
  if (opts.fromFile !== undefined) {
    let content: string;
    try {
      content = readFileSync(opts.fromFile, "utf-8");
    } catch {
      throw invalid("Could not read the identity secret file.");
    }
    if (Buffer.byteLength(content) > MAX_INPUT_BYTES) throw invalid("Identity secret file is too large.");
    return parseIdentitySecret(content);
  }
  return parseIdentitySecret(await readBoundedStdin());
}

async function readBoundedStdin(): Promise<string> {
  const input = process.stdin;
  if (input.isTTY) throw invalid("No secret provided: stdin is a terminal.");
  if (input.readableEnded || input.destroyed) throw invalid("No secret provided on stdin.");
  return new Promise<string>((resolve, reject) => {
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
      else resolve(Buffer.concat(chunks, size).toString("utf-8"));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_INPUT_BYTES) finish(invalid("Identity secret input is too large."));
      else chunks.push(bytes);
    };
    const onEnd = () => finish();
    const onError = () => finish(invalid("Could not read the identity secret from stdin."));
    const onClose = () => finish(invalid("stdin closed before the identity secret completed."));
    const deadline = setTimeout(
      () => finish(invalid("Identity secret input did not finish within 5 seconds.")),
      INPUT_DEADLINE_MS
    );
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.once("close", onClose);
    input.resume();
  });
}

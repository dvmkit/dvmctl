import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../shared/output", () => ({
  info: vi.fn(),
  json: vi.fn(),
}));

import { BUILDER_CONFIG_DIR, BUILDER_FILE, BUILDER_KEY_FILE } from "../../../shared/defaults";
import { readIdentitySecret } from "../../../lib/identity-secret-input";
import * as output from "../../../shared/output";
import { identityImport } from "../identity";

// BIP-340 test vectors (secret -> x-only pubkey), independent of the SDK.
const SECRET_A = "0000000000000000000000000000000000000000000000000000000000000003";
const PUBKEY_A = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const SECRET_B = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";
const PUBKEY_B = "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659";

const scratch = join(tmpdir(), `dvmctl-identity-import-${process.pid}`);

/** Remove only identity files (and their backups): the config dir is shared by the whole test run. */
function clearBuilderState(): void {
  if (!existsSync(BUILDER_CONFIG_DIR)) return;
  for (const name of readdirSync(BUILDER_CONFIG_DIR)) {
    if (name.startsWith("builder.key") || name.startsWith("builder.json")) {
      rmSync(join(BUILDER_CONFIG_DIR, name), { force: true });
    }
  }
}

function builderState(): { key: string | null; pubkey: string | null } {
  return {
    key: existsSync(BUILDER_KEY_FILE) ? readFileSync(BUILDER_KEY_FILE, "utf-8") : null,
    pubkey: existsSync(BUILDER_FILE)
      ? ((JSON.parse(readFileSync(BUILDER_FILE, "utf-8")) as { identity_pubkey?: string }).identity_pubkey ?? null)
      : null,
  };
}

function secretFile(name: string, content: string): string {
  mkdirSync(scratch, { recursive: true });
  const path = join(scratch, name);
  writeFileSync(path, content);
  return path;
}

async function withStdin<T>(content: string, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "stdin");
  const stream = new PassThrough();
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  try {
    const pending = run();
    stream.end(content);
    return await pending;
  } finally {
    if (original) Object.defineProperty(process, "stdin", original);
  }
}

describe("dvmctl identity import", () => {
  beforeEach(() => {
    clearBuilderState();
    vi.mocked(output.json).mockClear();
  });

  afterEach(() => {
    clearBuilderState();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("writes builder.key (0600) and builder.json from a secret file", async () => {
    await identityImport({ fromFile: secretFile("a.hex", `${SECRET_A}\n`) });

    expect(builderState()).toEqual({ key: `${SECRET_A}\n`, pubkey: PUBKEY_A });
    if (process.platform !== "win32") expect(statSync(BUILDER_KEY_FILE).mode & 0o777).toBe(0o600);
    expect(output.json).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "imported", identity_pubkey: PUBKEY_A })
    );
  });

  it("reads the secret from stdin and never prints it", async () => {
    await withStdin(`${SECRET_A.toUpperCase()}\n`, () => identityImport({}));

    expect(builderState()).toEqual({ key: `${SECRET_A}\n`, pubkey: PUBKEY_A });
    expect(JSON.stringify(vi.mocked(output.json).mock.calls)).not.toContain(SECRET_A);
  });

  it("refuses a different existing identity without --force and changes nothing", async () => {
    await identityImport({ fromFile: secretFile("a.hex", SECRET_A) });
    const before = builderState();

    await expect(identityImport({ fromFile: secretFile("b.hex", SECRET_B) })).rejects.toMatchObject({
      code: "identity_exists",
    });

    expect(builderState()).toEqual(before);
  });

  it("replaces a different identity with --force and backs up the old key", async () => {
    await identityImport({ fromFile: secretFile("a.hex", SECRET_A) });
    vi.mocked(output.json).mockClear();

    await identityImport({ fromFile: secretFile("b.hex", SECRET_B), force: true });

    expect(builderState()).toEqual({ key: `${SECRET_B}\n`, pubkey: PUBKEY_B });
    const report = vi.mocked(output.json).mock.calls[0][0] as { status: string; backup_file?: string };
    expect(report.status).toBe("imported");
    expect(readFileSync(report.backup_file as string, "utf-8")).toBe(`${SECRET_A}\n`);
  });

  it("is a no-op when the same identity is already installed", async () => {
    await identityImport({ fromFile: secretFile("a.hex", SECRET_A) });
    vi.mocked(output.json).mockClear();

    await identityImport({ fromFile: secretFile("a.hex", SECRET_A) });

    expect(output.json).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "unchanged" }));
    expect(output.json).not.toHaveBeenCalledWith(expect.objectContaining({ backup_file: expect.anything() }));
  });

  it("restores a lost key file for the identity recorded in builder.json", async () => {
    await identityImport({ fromFile: secretFile("a.hex", SECRET_A) });
    rmSync(BUILDER_KEY_FILE);

    await identityImport({ fromFile: secretFile("a.hex", SECRET_A) });

    expect(builderState()).toEqual({ key: `${SECRET_A}\n`, pubkey: PUBKEY_A });
  });

  it("rejects malformed secrets without echoing them or writing files", async () => {
    const bad = "not-a-key-" + "z".repeat(20);
    const error = await identityImport({ fromFile: secretFile("bad.hex", bad) }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "invalid_identity_secret" });
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(bad);
    expect(builderState()).toEqual({ key: null, pubkey: null });
  });
});

describe("identity secret input", () => {
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("rejects an interactive terminal instead of waiting for typed input", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, configurable: true });
    try {
      await expect(readIdentitySecret({})).rejects.toMatchObject({ code: "invalid_identity_secret" });
    } finally {
      if (original) Object.defineProperty(process, "stdin", original);
    }
  });

  it("rejects oversized input", async () => {
    await expect(withStdin("a".repeat(5000), () => readIdentitySecret({}))).rejects.toMatchObject({
      code: "invalid_identity_secret",
    });
  });

  it("reports an unreadable file without leaking its path contents", async () => {
    await expect(readIdentitySecret({ fromFile: join(scratch, "missing.hex") })).rejects.toMatchObject({
      code: "invalid_identity_secret",
    });
  });
});

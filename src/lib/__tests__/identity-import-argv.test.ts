import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/output", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/output")>()),
  info: vi.fn(),
  json: vi.fn(),
}));

import { buildProgram } from "../../cli/dvmctl";
import { BUILDER_FILE, BUILDER_KEY_FILE } from "../../shared/defaults";
import * as output from "../../shared/output";

// A real key written as the argument a user might mistakenly type.
const SECRET = "0000000000000000000000000000000000000000000000000000000000000003";

class ExitSignal extends Error {}

describe("dvmctl identity import <secret>", () => {
  beforeEach(() => {
    vi.mocked(output.json).mockClear();
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new ExitSignal();
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a secret passed as an argument, points at stdin, and never echoes or stores it", () => {
    const keyExisted = existsSync(BUILDER_KEY_FILE);
    const pubkeyExisted = existsSync(BUILDER_FILE);

    expect(() => buildProgram().parse(["node", "dvmctl", "identity", "import", SECRET])).toThrow(ExitSignal);

    const printed = JSON.stringify(vi.mocked(output.json).mock.calls);
    expect(printed).toContain("secret_in_argv");
    expect(printed).toContain("stdin");
    expect(printed).not.toContain(SECRET);
    expect(existsSync(BUILDER_KEY_FILE)).toBe(keyExisted);
    expect(existsSync(BUILDER_FILE)).toBe(pubkeyExisted);
  });
});

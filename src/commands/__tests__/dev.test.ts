import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDVM, z } from "@dvmkit/sdk";
import type { DVMServeResult, PaidJobCompletion } from "@dvmkit/sdk/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevPaymentTracker, printStartup, resolveDevEnvironment } from "../dev";
import { SDK_VERSION } from "../../lib/version.ts";

const noRails = {
  mount: "/",
  verification: "skipped",
  storage: "disposable",
  rails: {
    cashu: { status: "absent", testFunds: null },
    x402: { status: "absent", testFunds: null },
    tempo: { status: "absent", testFunds: null },
    lightning: { status: "absent", testFunds: null },
  },
} as DVMServeResult["paymentModes"][number];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dvmctl dev output", () => {
  it("explains skipped payments and prints a runnable structured first call", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const descriptor = configureDVM({
      name: "Echo",
      capability: "echo",
      tags: ["text"],
      input: z.object({ text: z.string() }),
      example: { text: "hello" },
      price: "$0.01",
      onJob() {},
    });
    printStartup(descriptor, 3210, [noRails]);
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain(`Serving SDK: @dvmkit/sdk ${SDK_VERSION}`);
    expect(output).toContain("Payments: skipped; no payment rail is configured");
    expect(output).toContain("DVMKIT_CASHU_MINTS");
    expect(output).toContain(
      `dvm request --endpoint http://localhost:3210 --data '{"text":"hello"}' </dev/null`
    );
    expect(output).not.toContain("curl");
  });

  it("reports effective real verification without calling mainnet funds test money", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const descriptor = configureDVM({
      name: "Echo",
      capability: "echo",
      tags: ["text"],
      input: z.object({ text: z.string() }),
      example: { text: "hello" },
      price: "$0.01",
      onJob() {},
    });
    const mode = structuredClone(noRails);
    mode.verification = "required";
    mode.storage = "durable";
    mode.rails.tempo = { status: "verifying", testFunds: false };
    printStartup(descriptor, 3210, [mode]);
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Payments: real verification");
    expect(output).toContain("cashu: absent (not configured)");
    expect(output).toContain("tempo: verifying (live funds)");
    expect(output).toContain("--rail tempo --budget '$0.01'");
  });

  it("reports a required unavailable verifier without printing a free-looking call", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const descriptor = configureDVM({
      name: "Echo",
      capability: "echo",
      tags: ["text"],
      input: z.object({ text: z.string() }),
      example: { text: "hello" },
      price: "$0.01",
      onJob() {},
    });
    const mode = structuredClone(noRails);
    mode.verification = "required";
    mode.rails.cashu = { status: "unavailable", testFunds: true };
    printStartup(descriptor, 3210, [mode]);
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Payments: required but unavailable; paid CLI calls fail closed");
    expect(output).toContain(
      "No paid caller command is available until a configured payment verifier recovers."
    );
    expect(output).not.toContain("--endpoint http://localhost:3210 --data");
  });

  it("does not print an endpoint command that is ambiguous for multiple capabilities", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const descriptor = configureDVM({
      name: "Tools",
      tags: ["text"],
      capabilities: {
        echo: {
          input: z.object({ text: z.string() }),
          example: { text: "hello" },
          onJob() {},
        },
        count: {
          input: z.object({ text: z.string() }),
          example: { text: "hello" },
          onJob() {},
        },
      },
    });
    printStartup(descriptor, 3210, [noRails]);
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output).toContain("Local endpoint calls cannot select among echo, count.");
    expect(output).toContain("dvm request -d <handle>--<slug>/echo --data <json>");
    expect(output).not.toContain("--endpoint http://localhost:3210 --data");
  });
});

describe("DevPaymentTracker", () => {
  it("deduplicates replayed observer events and retains totals across currencies", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const tracker = new DevPaymentTracker();
    const usd: PaidJobCompletion = {
      jobId: "job-1",
      rail: "cashu",
      amountMicro: 10_000,
      currency: "usd",
      testFunds: true,
    };
    tracker.observe(usd);
    tracker.observe(usd);
    tracker.printSummary();
    expect(log).toHaveBeenLastCalledWith("  Session total (1 paid job): $0.01 USD test funds");
    tracker.observe({
      jobId: "job-2",
      rail: "tempo",
      amountMicro: 2_500_000,
      currency: "eur",
      testFunds: false,
    });
    const output = log.mock.calls.map(([line]) => String(line)).join("\n");
    expect(output.match(/Paid job job-1/g)).toHaveLength(1);
    expect(output).toContain("$0.01 USD via cashu test funds");
    expect(output).toContain("2.5 EUR via tempo");
    expect(output).toContain("Session total (2 jobs): $0.01 USD test funds + 2.5 EUR live funds");
    tracker.printSummary();
    expect(log).toHaveBeenLastCalledWith(
      "  Session total (2 paid jobs): $0.01 USD test funds + 2.5 EUR live funds"
    );
  });

});

describe("dvmctl dev environment", () => {
  it("gives project .env values precedence over the parent process", () => {
    const cwd = mkdtempSync(join(tmpdir(), "dvmctl-dev-env-"));
    try {
      writeFileSync(join(cwd, ".env"), "DVMKIT_CASHU_MINTS=https://project.example\n");
      expect(
        resolveDevEnvironment(cwd, {
          DVMKIT_CASHU_MINTS: "https://process.example",
        }).DVMKIT_CASHU_MINTS
      ).toBe("https://project.example");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

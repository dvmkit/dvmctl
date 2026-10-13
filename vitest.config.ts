import { defineConfig } from "vitest/config";

import { cliStateSandboxEnv } from "./test-support/cli-state-sandbox.ts";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    maxWorkers: 2,
    env: cliStateSandboxEnv(),
    globalSetup: [
      "test-support/global-cli-state-sandbox.ts",
      "test-support/global-git-config-sentinel.ts",
    ],
    setupFiles: [
      "test-support/setup-process-guard.ts",
      "test-support/setup-git-env-guard.ts",
      "test-support/setup-network-guard.ts",
    ],
    restoreMocks: true,
    clearMocks: true,
    server: { deps: { inline: ["@dvmkit/sdk"] } },
  },
});

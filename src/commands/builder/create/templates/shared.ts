import { SDK_VERSION } from "../../../../lib/version.ts";

export function packageJsonTemplate(opts: { dirName: string }): string {
  const pkg = {
    name: opts.dirName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: {
      node: "^22.12.0 || ^24.0.0 || >=26.0.0",
    },
    scripts: {
      test: "vitest run",
      typecheck: "tsc --noEmit",
      dev: "dvmctl dev handler.ts",
      deploy: "dvmctl deploy",
    },
    dependencies: {
      "@dvmkit/sdk": SDK_VERSION,
      pg: "^8",
    },
    devDependencies: {
      "@types/node": "^22",
      // Allow 5.x updates: npm 10 crashes when an exact pin trails Vitest's optional peers.
      vitest: "^5.0.2",
      typescript: "^5",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

export function tsconfigTemplate(): string {
  const config = {
    compilerOptions: {
      target: "ES2024",
      module: "ES2022",
      moduleResolution: "bundler",
      isolatedModules: true,
      strict: true,
      skipLibCheck: true,
      outDir: "dist",
    },
    include: ["*.ts"],
    // Tests run with vitest, not the production build — keep them out of dist/.
    exclude: ["*.test.ts"],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

export function envExampleTemplate(): string {
  return `# Local settings for \`dvmctl dev\`. Copy this file to \`.env\`.
# On deploy, set production secrets on the platform — they are not read from this file.
# OPENAI_API_KEY=sk-...

# Cashu: local development can use a Nutshell mint started with FakeWallet.
# It settles its own test invoices and carries no real money.
# DVMKIT_CASHU_MINTS=http://localhost:3338
# A platform-hosted DVM refuses test mints unless this is explicitly true.
# DVMKIT_ALLOW_TEST_MINTS=true

# x402: set a recipient to offer USDC x402 payments. The SDK defaults to Base mainnet.
# DVMKIT_X402_PAY_TO=0xYourRecipientAddress
# DVMKIT_X402_NETWORK=eip155:8453
# DVMKIT_X402_ASSET=USDC
# DVMKIT_X402_FACILITATOR=https://x402.org/facilitator

# Tempo: configure a recipient and secret to offer Tempo payments.
# DVMKIT_TEMPO_RECIPIENT=0xYourTempoRecipientAddress
# DVMKIT_TEMPO_SECRET_KEY=replace-with-a-random-secret
# DVMKIT_TEMPO_RPC_URL=https://your-tempo-rpc.example
# For fake-money local testing on Moderato (chain 42431):
# DVMKIT_TEMPO_TESTNET=true
`;
}

export function agentsTemplate(opts: { cliVersion: string }): string {
  return `# Agent instructions

Before changing this DVM, read the installed \`build-dvm\` skill from
\`@dvmkit/dvmctl/skill\`. It documents the supported SDK surface and payment rails.

Install the skill for Codex if it is not already available:

\`\`\`bash
npm install --ignore-scripts --prefix "$HOME/.dvmkit" @dvmkit/dvmctl@${opts.cliVersion}
skill_path="$(NODE_PATH="$HOME/.dvmkit/node_modules" node -p "require.resolve('@dvmkit/dvmctl/skill')")"
mkdir -p .agents/skills
cp -R "$(dirname "$skill_path")" .agents/skills/
\`\`\`
`;
}

export function claudeTemplate(): string {
  return `# Agent instructions

Read [AGENTS.md](./AGENTS.md) before changing this DVM. It directs coding agents to the installed
\`build-dvm\` skill from \`@dvmkit/dvmctl/skill\` and gives the installation command.

Claude Code loads project skills from \`.claude/skills\`. To use that harness, run the same command
from \`AGENTS.md\`, replacing \`.agents/skills\` with \`.claude/skills\`.
`;
}

export function gitignoreTemplate(): string {
  return `node_modules/
dist/
.env
`;
}

export function serveTemplate(): string {
  return `import handler from "./handler.js";
import { serve } from "@dvmkit/sdk/server";

serve(handler, {
  database: process.env.DATABASE_URL,
  mints: process.env.DVMKIT_CASHU_MINTS?.split(",").filter(Boolean),
});
`;
}

export function dockerfileTemplate(): string {
  return `# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
# \`@dvmkit/sdk\` is a public npm package, so this is a plain unauthenticated
# install: no registry credential reaches the build, and nothing can leak into
# build logs or image layers. \`npm install\` (not \`ci\`) with no lockfile yet.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npx tsc
# Keep only the dependency graph needed to serve the compiled DVM. The build
# still installs TypeScript and Vitest above, while npm retains production and
# optional/native dependencies declared by the generated package manifest.
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app

ARG GIT_SHA=unknown
ENV GIT_SHA=\${GIT_SHA}
ARG BUILD_TIME=unknown
ENV BUILD_TIME=\${BUILD_TIME}

# System dependencies — uncomment or add your own:
# RUN apt-get update && apt-get install -y ffmpeg python3 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8080
CMD ["node", "dist/serve.js"]
`;
}

export function readmeTemplate(opts: { name: string; dirName: string }): string {
  return `# ${opts.name}

A DVM built with [dvmkit](https://dvmkit.com).

## Commands

    npm install                       # install dependencies
    cp .env.example .env              # add local secrets (optional)
    npm test                          # run tests
    npm run typecheck                 # check TypeScript
    npm run dev                       # run locally (http://localhost:3000/_dev)
    npm run deploy                    # deploy to production

## Project structure

| File | Purpose |
|------|---------|
| \`handler.ts\` | Your DVM logic — this is the main file you edit |
| \`handler.test.ts\` | Tests for your handler (runs with vitest) |
| \`serve.ts\` | Production entry point — imports your handler and starts the server |
| \`Dockerfile\` | Container config — add system dependencies here (ffmpeg, python, etc.) |
| \`.env.example\` | Template for local secrets — copy to \`.env\` (gitignored) and fill in |
| \`AGENTS.md\` / \`CLAUDE.md\` | Instructions for coding agents, including the bundled builder skill |

## How handlers work

Your handler receives a \`ctx\` object for each job:

\`\`\`typescript
async onJob(ctx) {
  const input = ctx.input;          // the job input from the requester

  ctx.text("Working on it...");     // send a progress message
  const result = await doWork(input);
  ctx.complete(result);             // finish the job
}
\`\`\`

### Key ctx methods

| Method | What it does |
|--------|-------------|
| \`ctx.input\` | The job input (string, or typed object if you define an input schema) |
| \`ctx.text(msg)\` | Send a progress update to the requester |
| \`ctx.complete(summary)\` | Finish the job with a human-readable summary |
| \`ctx.fail(error)\` | Fail the job with an error message |
| \`ctx.step(id, fn)\` | Cache an expensive operation — survives restarts |
| \`ctx.prompt(id, question)\` | Ask the requester a question, wait for their answer |
| \`ctx.requestPayment(amount, reason)\` | Request payment, wait for it to arrive |
| \`ctx.artifact({ data, mime_type })\` | Attach a rich output (JSON, images, files) |
| \`ctx.store\` | Persistent key-value storage shared across jobs |
| \`ctx.env\` | Environment variables (from \`.env\` or platform secrets) |
| \`ctx.log\` | Structured logging |

### Lifecycle hooks

\`\`\`typescript
export default configureDVM({
  async onBoot(env) {
    // Runs once when the server starts — validate API keys, open connections
    if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  },

  async onJob(ctx) { /* ... */ },

  async onShutdown() {
    // Runs when the server stops — close connections, flush buffers
  },
});
\`\`\`

## Multiple capabilities

This starter exposes a single capability — the flat shape above, with \`capability\`
and \`onJob\` at the top level. To expose several operations from one DVM, drop those
top-level fields and use a \`capabilities\` map instead:

\`\`\`typescript
export default configureDVM({
  name: "${opts.name}",
  tags: ["transform"],

  capabilities: {
    uppercase: {
      description: "Uppercase the input",
      async onJob(ctx) {
        ctx.complete(ctx.input.toUpperCase());
      },
    },
    reverse: {
      description: "Reverse the input",
      async onJob(ctx) {
        ctx.complete([...ctx.input].reverse().join(""));
      },
    },
  },
});
\`\`\`

Each capability gets its own \`onJob\` (and optional \`input\` schema, \`price\`, and
\`onQuote\`). The flat and \`capabilities\` shapes are mutually exclusive — don't set a
top-level \`capability\`/\`onJob\`/\`price\` alongside \`capabilities\`. Callers select one by
setting \`capability\` on their request, and you list them under \`dvmkit.capabilities\`
in \`package.json\` so the platform attests to them at deploy:

\`\`\`json
{
  "dvmkit": {
    "capabilities": ["uppercase", "reverse"]
  }
}
\`\`\`

## System dependencies

If your DVM needs tools like ffmpeg, yt-dlp, or python, edit the \`Dockerfile\`:

\`\`\`dockerfile
# In the runtime stage, add:
RUN apt-get update && apt-get install -y ffmpeg python3 && rm -rf /var/lib/apt/lists/*
\`\`\`

These will be available when your handler runs \`child_process.exec()\` or similar.

## Resource configuration

Set VM resources (memory, CPU, scaling) via the \`dvmkit\` field in \`package.json\`:

\`\`\`json
{
  "dvmkit": {
    "memory_mb": 1024
  }
}
\`\`\`

See the [resource configuration guide](https://dvmkit.com/docs/resources) for decision trees, plan limits, and cost ballparks.
`;
}

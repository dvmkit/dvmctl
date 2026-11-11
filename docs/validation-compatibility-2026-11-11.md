# x402-only validation compatibility: 2026-11-11

The built dvmctl 0.20.0 CLI validates an x402-only capability configured with
SDK 0.34.0. A valid capability passes; omitting its capability-level example
produces `missing_input_example`, even when an x402 listing example is present.

This observation applies to source commit
[`4164310f9d1014aff3e31f52187217f0d2cb0884`](https://github.com/dvmkit/dvmctl/commit/4164310f9d1014aff3e31f52187217f0d2cb0884),
with Node 22.23.2, npm 10.9.8, and the CLI's SDK dependency pinned to 0.28.0.
The handler used a separate installation of SDK 0.34.0.

## Reproduction

Build the CLI with `npm ci` and `npm run build`. In a separate project directory,
run `npm init --yes` and `npm install --ignore-scripts @dvmkit/sdk@0.34.0`, then
save this handler as `handler.mjs`:

```js
import { configureDVM, z } from "@dvmkit/sdk";

export default configureDVM({
  name: "X402 validation reproduction",
  capabilities: {
    echo: {
      input: z.object({ text: z.string() }),
      example: { text: "hello" },
      price: "$0.01",
      maxRuntimeSeconds: 30,
      channels: {
        job: false,
        x402: {
          listing: {
            description: "Echo the supplied text as a synchronous response.",
            example: { text: "hello" },
          },
        },
      },
      onJob(ctx) { ctx.complete(ctx.input.text); },
    },
  },
});
```

From that project, run:

```sh
node <cli-checkout>/dist/dvmctl.js validate --handler handler.mjs
```

SDK 0.34.0 accepts the handler and returns an empty `capabilities` map and an
`x402Capabilities` map containing `echo`. The CLI outcomes are:

| Handler | Exit code | JSON output excerpt |
| --- | --- | --- |
| As written | 0 | `{"status":"ok","capabilities":["echo"]}` |
| Capability-level `example` removed; listing example retained | 1 | `{"error":{"code":"missing_input_example","message":"Capability \"echo\" has no example input."}}` |
| As written, configured with SDK 0.28.0 instead | 0 | `{"status":"ok","capabilities":["echo"]}` |

Excerpts omit unrelated output fields. SDK 0.28.0 has no `x402Capabilities` map;
the last case checks compatibility with that older descriptor shape.

## Why validation sees the capability

The [handler loader](../src/lib/load-handler.ts) normalizes descriptors from a
different SDK module instance through the CLI's own `configureDVM`. SDK 0.28.0
places every configured capability in `capabilities`, without partitioning by
channel. The [validator](../src/commands/builder/validate.ts) therefore sees
`echo` and checks its schema and capability-level example.

No validator change was needed for these cases. This result depends on the
CLI's pinned SDK and normalization behavior; it does not establish compatibility
with a future SDK pin or every channel configuration.

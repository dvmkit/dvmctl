---
name: build-dvm
description: Build and operate a Digital Vending Machine with dvmkit. Use when asked to turn an idea into a paid service, implement a capability, test payments or Lightning-funded credit, deploy or update a DVM, inspect earnings or health, recover a failed operation, or retire a service.
compatibility: Node.js 22+, npm, the matching @dvmkit/dvmctl release and its exact @dvmkit/sdk dependency (see the installed package.json), and @dvmkit/dvm-cli@0.7.0 or later. Docker is needed for container builds or an owned local Cashu test mint.
allowed-tools: Bash Read Write Edit Glob Grep
---

# Build and operate a DVM

Use `dvmctl` to manage the service and `@dvmkit/sdk` to implement its capabilities. Use the caller CLI, `dvm`, when testing the service as a customer. Keep its test wallet separate from the builder's keys and normal caller state.

## Choose the procedure

Identify the user's task and the service's current state. Read the matching file before acting. Load another only when the task crosses into its scope; an existing service does not need onboarding again.

| Task | Read |
| --- | --- |
| Turn an idea into a working local capability | [new-builder](new-builder.md) |
| Validate behavior or prove a paid call | [testing](testing.md), then only the chosen payment recipe |
| Prepare or perform a deployment | [deploying](deploying.md) |
| Inspect health or earnings, collect payouts, update, or transfer a service | [operating](operating.md) |
| Diagnose a failure or reconcile an uncertain payment or deploy | [recovery](recovery.md) |
| Retain job content for support or a dispute | [content holds](references/content-holds.md) |
| Export minimized financial evidence before database deletion | [financial export](references/financial-export.md) |
| Stop offering a service and close its outstanding obligations | [retirement](retirement.md) |

## Establish the context

Reuse the brief, decisions, and authorization already provided. Ask only for missing choices that affect the result, cost, access, or recoverability. An instruction to test locally does not authorize a production deployment or spending production funds.

Inspect the installed CLI version and the project's SDK dependency before selecting examples. Use the exact release and matching skill specified by the builder's setup. Do not upgrade an existing project merely to match an example. If versions disagree, establish the intended target before changing dependencies.

Before a remote change, confirm the service, organization, and environment from tool output. Names alone can identify the wrong service when an account belongs to several organizations.

## Rules that apply to every procedure

- Keep private keys, recovery words, payment credentials, and secret values out of chat, source, and logs. Use the documented secret-input mechanism. Never infer that a human has backed up recovery material.
- Keep the service's price separate from the authorized test-spend cap. Verify the network and payment destination before moving value. A development server can still accept real funds.
- When an outcome is uncertain, inspect the existing operation before retrying. A lost response does not prove that a payment or deployment failed. Continue through [recovery](recovery.md) when the tool cannot establish the result.
- Preserve recovery records until the relevant obligation is resolved. Unknown refund state is not a zero balance, and deleting a service does not settle its debts. Use [retirement](retirement.md) before destructive cleanup.
- Check user authorization before actions that spend funds, change payment destinations, transfer control, or destroy data. Existing authorization counts; do not ask for it again. Ask when the actual scope or consequence exceeds it.

The dvmkit team welcomes feedback at any time through `dvmctl feedback send`, especially about what was confusing, slow, or broken.

## Use the result

Read structured output and follow its recovery guidance. Relay `display` and `hint` when they answer the user's question. Check each command's contract: logs and exports need not be JSON.

Close a task with the observed result and the evidence relevant to it: a local artifact, a verified paid job, a live deployment, or a confirmed payout. Distinguish completed work from pending or unknown state. Never report a payout from a revenue total alone.

For exact syntax and output, read the [dvmctl reference](https://dvmkit.com/docs/cli-dvmctl.md). For handler interfaces, read the [SDK reference](https://dvmkit.com/docs/sdk.md). Use the [docs index](https://dvmkit.com/llms.txt) to retrieve other topics selectively.

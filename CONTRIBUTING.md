# Contributing

Issues and discussions are welcome. All unsolicited pull requests, including typo and documentation pull requests, are closed automatically.

Agents may research, implement, and perform the first review of a reported problem. A maintainer reviews and merges the fix after reproducing it, so a minimal reproduction is preferred to a patch.

An accepted issue is not a delivery promise or roadmap authority.

There is no contributor license agreement, and DCO sign-off is not required because unsolicited pull requests are not accepted. This project uses the Apache-2.0 license, whose patent terms apply to accepted contributions as described in that license.

Report a bug with the exact command, operating system, Node.js version, CLI version, minimal reproduction, and expected versus actual behavior. Use a discussion for ideas and design questions.

Do not include credentials, wallet material, real payment data, or customer data. Suspected vulnerabilities must use the private route in [SECURITY.md](SECURITY.md).

## Maintainer development

This repository owns the builder CLI implementation, its behavioral tests, and its package releases. Edit `src/` directly; no private checkout or source export is needed. Shared runtime dependencies are declared in `package.json`, and platform compatibility is checked through the installed CLI and service contract.

Use Node.js 22.23.2 for development, matching the hosted build, install with `npm ci`, and run `npm run verify` after the last edit. Source behavior tests use Vitest beside the implementation. Run a focused group with `npm run test:source -- src/commands/builder/__tests__/create.test.ts`. Artifact and release safeguards use `node:test`; run `npm run build` followed by `npm run test:package` when iterating on those boundaries. Keep external dependency mocks and each distinct money, recovery, lifecycle, and security regression.

The hosted verification workflow also checks public safety, release tooling, deterministic archives, and installed consumers across the supported Node.js and operating system matrix. Local verification does not publish a package.

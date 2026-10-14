# Changelog

## [0.8.0](https://github.com/dvmkit/dvmctl/compare/v0.8.0...v0.8.0) (2026-10-14)


### Miscellaneous Chores

* configure the first stable release ([fb66494](https://github.com/dvmkit/dvmctl/commit/fb664945c946aa125b6f9f57fb89515346f6dc87))

## 0.8.0 (2026-10-14)

This is the first release on npm's `latest` channel from this new repository. dvmctl remains a pre-1.0 alpha.

The CLI uses the exact registry dependency `@dvmkit/sdk` `0.8.0`, and newly created projects declare the same SDK version. Existing projects keep their declared SDK dependency until you update it.

Upgrade the globally installed CLI with `npm update --global @dvmkit/dvmctl`, then copy the complete bundled `build-dvm` skill directory again using the [README instructions](https://github.com/dvmkit/dvmctl#for-agents).


### Bug Fixes

* **release:** retain the prepared pull request identity ([3b5f3d4](https://github.com/dvmkit/dvmctl/commit/3b5f3d43a243e0ed33ca18e0bddd8e01adb1eac3))
* verify notices with linked dependencies ([a638f2b](https://github.com/dvmkit/dvmctl/commit/a638f2bfd2bab9c7ea974e0dac8b99fbb6899089))


### Miscellaneous Chores

* configure the first stable release ([#1](https://github.com/dvmkit/dvmctl/issues/1)) ([d9787d2](https://github.com/dvmkit/dvmctl/commit/d9787d26cba495b2be57771d696b0f6e9c49db0c))


### Tests

* verify dev subprocesses against fresh CLI builds ([#6](https://github.com/dvmkit/dvmctl/issues/6)) ([d1fd26d](https://github.com/dvmkit/dvmctl/commit/d1fd26d19c0af26da49524e27010a5def42b6b57))
* wait for a recorded worker before asserting cleanup ([a0e7b8b](https://github.com/dvmkit/dvmctl/commit/a0e7b8babe8d1998c0d114fe0070c662aeb0f2fa))


### Build System

* **deps:** admit sdk 0.8.0 ([130e99b](https://github.com/dvmkit/dvmctl/commit/130e99b74b28df0317584eaa743051426bf97f04))

## 0.5.0-rc.5 (2026-10-10)


### Bug Fixes

* **deps:** scaffold builder projects on SDK 0.7.0-rc.7

## 0.5.0-rc.4 (2026-10-04)


### Bug Fixes

* **deps:** align builder recipes with testnet withdrawal SDK

## 0.5.0-rc.3 (2026-10-03)


### Features

* adopt trimmed shared SDK runtime

## 0.5.0-rc.2 (2026-10-02)

This candidate also removes unused internal credit-notice state; supported command output and feedback behavior are unchanged.


### Features

* manage scoped job content holds and financial export guidance

## 0.4.0-rc.2 (2026-09-29)

- Add `dvmctl feedback send` for builder notes and `dvmctl feedback posture` to control local feedback invitations.
- Include the installed SDK version from generated projects in feedback, and retain known first-deploy context when the trace and project match.
- Recover `dvmctl dev` edits made while a native file watcher is registering, so a save just after startup still reloads the handler.

## 0.4.0-rc.1 (2026-09-29)


### Features

* add builder feedback and recover missed dev edits


### Bug Fixes

* **cashu:** defer pending melt quotes

## 0.3.5-rc.1 (2026-09-28)

### Builder guidance

- Cover building, testing, deployment, operation, recovery, and retirement through selectively loaded skill modules.
- Document Lightning-funded credit acceptance and separate receiving, refund, and payout credentials.
- Use published references for SDK and command contracts; keep executable payment recipes in the package.
- Isolate test caller installations and preserve recovery state when a paid test fails.


## 0.3.4-rc.1 (2026-09-27)


### Compatibility

* Cloud deployment and deploy dry runs now default to containers. Existing projects without a Dockerfile must add the Dockerfile from a current `dvmctl create` scaffold before deploying. `--runtime isolate` is restricted to operators.
* The CLI and new scaffolds use `@dvmkit/sdk` `0.2.1-rc.9`. Liability warnings retain each currency separately; older endpoints without denominations report the affected amounts as unknown.


### Bug Fixes

* **auth:** explain closed beta access during sign-in


### Code Refactoring

* own builder source and behavioral verification

## 0.3.3-rc.1 (2026-09-26)


### Bug Fixes

* retain local paid test results
* **scaffold:** allow compatible Vitest updates

## 0.3.2-rc.1 (2026-09-22)


### Bug Fixes

* reload dev when a local handler dependency changes

## 0.3.1-rc.1 (2026-09-22)


### Bug Fixes

* **release-tag:** pass effective signing identity into the probe clone
* share project environment loading

## 0.3.0-rc.1 (2026-09-22)

- Local builder workflows now validate the actual handler, diagnose prerequisites, report configured payment-rail verification and paid-job totals, and require explicit identity creation with backup guidance.
- The bundled builder skill includes isolated Cashu, Tempo, and x402 test recipes using caller CLI `0.3.0`; generated DVMs include a valid input example for immediate validation.

### Features

* complete the local builder journey

## 0.2.1-rc.2 (2026-09-22)

Generated DVMs and the builder runtime now use SDK `0.1.5-rc.9`, so Tempo USD charges preserve the exact advertised six-decimal price.


### Bug Fixes

* preserve exact advertised Tempo prices

## 0.2.1-rc.1 (2026-09-22)

Generated DVMs pin SDK `0.1.5-rc.8` and document the Moderato testnet switch for local test payments. Cashu drain preparation uses the current locked-output API and rejects mixed-keyset output metadata before persisting a refund batch.


### Features

* enable verified local test payments

## 0.2.0-rc.2 (2026-09-21)


### Features

* refresh the builder scaffold and bundled skill


### Bug Fixes

* align the local paid test with caller output
* complete the local Cashu test guide
* **create:** pin the scaffold's vitest to 5.0.1 so npm 10 can install it
* **release:** retry registry propagation
* send structured data in the unpaid probe

## 0.1.0-rc.2 (2026-09-08)


### Bug Fixes

* run pinned npm shim in commonjs scope

## 0.1.0-rc.1 (2026-09-08)


### Features

* introduce standalone builder CLI


### Bug Fixes

* repair base-owned release policy shell syntax


### Continuous Integration

* establish verification and guarded release candidates

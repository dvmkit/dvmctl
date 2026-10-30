# Changelog

## Upgrade details

- Add `dvmctl refund <job-id>` for full or partial completed-job refunds onto the caller's credit. Confirmation is required before any HTTP request. Stable refund IDs make retries return the original result; `--refund-id` permits a deliberate additional partial refund.
- Pin the CLI runtime and new project scaffolds to exact `@dvmkit/sdk` `0.11.0-rc.1`. Separately installed project dependencies stay unchanged until explicitly upgraded. `dvmctl serve` and `dvmctl dev` run the CLI's pinned SDK, so upgrading or downgrading dvmctl changes their SDK on the next restart. Pause monetary writes and coordinate upgrades or rollbacks across these processes under the rules below, even when the project's own SDK dependency is unchanged. Custom credit stores must implement the SDK's transactional `refundDraw` accounting and report enqueueing.
- Before activating refunds, pause monetary writes and upgrade every process sharing the credit database and report queue, including funding writers and retry workers. Mixed-version monetary history after new metadata is written needs a state compatibility assessment, as does rollback after refund state exists. Older readers cannot interpret refund reports or known-zero Bitcoin lots. Additive schema initialization alone does not make a rolling upgrade or rollback safe. See [refund guidance](docs/refund-command.md) and the [SDK upgrade details](https://github.com/dvmkit/sdk/blob/v0.11.0-rc.1/CHANGELOG.md).

## [0.13.6](https://github.com/dvmkit/dvmctl/compare/v0.13.5...v0.13.6) (2026-10-30)


### Bug Fixes

* **cashu:** isolate unusable proofs during pending melts ([a40015b](https://github.com/dvmkit/dvmctl/commit/a40015beb1dec39dc4fccb45309793e9ac88237f))
* isolate builder recovery state in explicit directories ([0daf25c](https://github.com/dvmkit/dvmctl/commit/0daf25cfb741497e861035ba2b536221dc382dee))
* **melt:** match quote costs and close confirmed empty quarantines ([55f28f6](https://github.com/dvmkit/dvmctl/commit/55f28f6af25dfe79c1f51dabe5374a3af5ad7fa9))

## [0.13.5](https://github.com/dvmkit/dvmctl/compare/v0.13.4...v0.13.5) (2026-10-30)


### Bug Fixes

* normalize foreign SDK multi-capability descriptors ([fe74690](https://github.com/dvmkit/dvmctl/commit/fe74690a2be0fddc3efc13b7a326126430bd0f57))

## [0.13.4](https://github.com/dvmkit/dvmctl/compare/v0.13.3...v0.13.4) (2026-10-29)


### Bug Fixes

* **runtime:** show the serving SDK and flag project mismatches ([0d72bab](https://github.com/dvmkit/dvmctl/commit/0d72babff31cd50353b2c405366f96095f8836eb))

## [0.13.3](https://github.com/dvmkit/dvmctl/compare/v0.13.2...v0.13.3) (2026-10-29)


### Bug Fixes

* **deploy:** upload only the DVM folder unless buildContext widens it ([677753a](https://github.com/dvmkit/dvmctl/commit/677753aee683c665f107626f9458b327f14e42ce))
* **melt:** acknowledge paid melts whose change cannot be reconciled ([#34](https://github.com/dvmkit/dvmctl/issues/34)) ([ab16e0c](https://github.com/dvmkit/dvmctl/commit/ab16e0cc44f9d68353e2764279b6505c9ef278d0))
* **scaffold:** update SDK and check generated projects ([4f3ba2f](https://github.com/dvmkit/dvmctl/commit/4f3ba2f142bb9770b346809cc4608e93e0c45727))

## [0.13.2](https://github.com/dvmkit/dvmctl/compare/v0.13.1...v0.13.2) (2026-10-28)


### Bug Fixes

* **billing:** allow one-dollar hosting top-ups ([c8ef3f1](https://github.com/dvmkit/dvmctl/commit/c8ef3f170281008860d43dd94ddb306ab029cab3))
* **deploy:** package only git-visible files and name an oversized context ([#29](https://github.com/dvmkit/dvmctl/issues/29)) ([8f2a6e4](https://github.com/dvmkit/dvmctl/commit/8f2a6e46d0d58f48105882c6c32cfa6e0418fc18))
* **melt:** keep custody of melt change across crashes ([#31](https://github.com/dvmkit/dvmctl/issues/31)) ([2ba755b](https://github.com/dvmkit/dvmctl/commit/2ba755b9996f7e8f422e508f753a7c70c7c6d9cf))

## [0.13.1](https://github.com/dvmkit/dvmctl/compare/v0.13.0...v0.13.1) (2026-10-26)


### Bug Fixes

* **melt:** keep reconciling melts whose outcome is uncertain ([#27](https://github.com/dvmkit/dvmctl/issues/27)) ([613ef73](https://github.com/dvmkit/dvmctl/commit/613ef731bc4c4dbf4a078d26e7bf96c0f84dabb4))

## [0.13.0](https://github.com/dvmkit/dvmctl/compare/v0.12.1...v0.13.0) (2026-10-22)


### Features

* **credit:** add held Tempo drain decisions ([c6eb732](https://github.com/dvmkit/dvmctl/commit/c6eb732c0030d00779d2b1259ed19d4ae1a8dcc7))


### Bug Fixes

* **billing:** render actionable payment and recovery prose ([0ed14c0](https://github.com/dvmkit/dvmctl/commit/0ed14c0f8b2ffde26284ebeca7ed0e6a2146f9ab))

## [0.12.1](https://github.com/dvmkit/dvmctl/compare/v0.12.0...v0.12.1) (2026-10-20)


### Bug Fixes

* **deps:** use the stable SDK release ([67898eb](https://github.com/dvmkit/dvmctl/commit/67898ebcef408daa68c5be34ee02d2bf1f08c085))

## [0.12.0](https://github.com/dvmkit/dvmctl/compare/v0.11.0...v0.12.0) (2026-10-20)


### Features

* refund completed credit jobs ([#20](https://github.com/dvmkit/dvmctl/issues/20)) ([f125614](https://github.com/dvmkit/dvmctl/commit/f125614efd4bb9115b5f6703fa9db2b9f8f9e716))

## [0.11.0](https://github.com/dvmkit/dvmctl/compare/v0.10.0...v0.11.0) (2026-10-19)


### Features

* add billing and trial recovery commands ([#18](https://github.com/dvmkit/dvmctl/issues/18)) ([c49ebd9](https://github.com/dvmkit/dvmctl/commit/c49ebd9cd193d3df34cbd353f52403ea0a12fb84))

## [0.10.0](https://github.com/dvmkit/dvmctl/compare/v0.9.0...v0.10.0) (2026-10-18)


### Features

* add Tempo close-report commands ([#15](https://github.com/dvmkit/dvmctl/issues/15)) ([5344d76](https://github.com/dvmkit/dvmctl/commit/5344d769cbe65a5477e41cf35a98aec6b1aabdec))

## [0.9.0](https://github.com/dvmkit/dvmctl/compare/v0.8.0...v0.9.0) (2026-10-17)


### Features

* let melt-pending acknowledge a stuck melt quote ([#14](https://github.com/dvmkit/dvmctl/issues/14)) ([af60e26](https://github.com/dvmkit/dvmctl/commit/af60e263c48dc2be8f25beda37445d02eed9594c))


### Bug Fixes

* adapt payout melts to mint proof limits ([12cfd34](https://github.com/dvmkit/dvmctl/commit/12cfd34aec51e249075a2184b86503e46ede49db))
* decouple serve receipt attestation from Cashu recovery ([1032e82](https://github.com/dvmkit/dvmctl/commit/1032e82f1678e2533904bfc296b599139af4374b))

## 0.8.0 (2026-10-14)

This is the first release on npm's `latest` channel from this new repository. dvmctl remains a pre-1.0 alpha.

The CLI uses the exact registry dependency `@dvmkit/sdk` `0.8.0`, and newly created projects declare the same SDK version. Existing projects keep their declared SDK dependency until you update it.

Upgrade the globally installed CLI with `npm update --global @dvmkit/dvmctl`, then copy the complete bundled `build-dvm` skill directory again using the [README instructions](https://github.com/dvmkit/dvmctl#for-agents).

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

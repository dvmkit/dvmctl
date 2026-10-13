# Releasing dvmctl

## Scope

Only the standalone dvmctl repository publishes `@dvmkit/dvmctl`. Stable releases publish to `latest`, and RC releases publish to `next`. Both require publicly verifiable provenance.

## Operator configuration evidence

Before enabling publication, record that npm trusted publishing is bound to the `dvmkit/dvmctl` repository, `release.yml` workflow, `npm-release` environment, and direct `npm publish` permission. The npm connection must be permitted to publish directly rather than stage-only. No npm token is used.

Record that the GitHub environment accepts stable `vX.Y.Z` and RC `vX.Y.Z-rc.N` tags. Record that the release App is repository-only, has only contents, issues, and pull-request write permissions, and cannot bypass rulesets. Record that only maintainers can create stable and RC tags and that no actor can update or delete them.

## Compatibility

The exact SDK selection is `dependencies["@dvmkit/sdk"]` in [package.json](package.json); `node scripts/sdk-version.mjs` prints it. Artifact checks, consumer installs, and scaffolds read it. Update it and the lockfile only after the selected registry version exists. It supports Node.js `>=22` and is built with Node.js `22.23.2`.

## Prepare a stable release or release candidate

Release-please creates a version and changelog pull request when the repository variable `RELEASE_PLEASE_ENABLED` is `true`. Package, lockfile, and release manifest must agree. For fresh history, use release-please manifest bootstrap and first-release controls. The package and release manifest start at `0.5.0-rc.5`, so the first fresh-history release needs a `Release-As: 0.8.0` commit footer to select the intended stable version. Ordinary merges never publish.

After that pull request is merged, use the stable tag form for a stable release:

```sh
node scripts/release-tag.mjs --tag vX.Y.Z --dry-run
node scripts/release-tag.mjs --tag vX.Y.Z
git push origin vX.Y.Z
```

For a release candidate, use the RC tag form:

```sh
node scripts/release-tag.mjs --tag vX.Y.Z-rc.N --dry-run
node scripts/release-tag.mjs --tag vX.Y.Z-rc.N
git push origin vX.Y.Z-rc.N
```

The helper requires a clean live default-branch tip, an absent tag, and a separate SSH signing probe. The release workflow accepts only an annotated, allowed-signer stable or RC tag. It resolves the tagged commit and its unique merged release PR once, builds the package twice, and publishes only the resulting same-run artifact to the version's dist-tag with `--provenance`.

## Recover a disrupted release

Never retag, unpublish, overwrite, or move a dist-tag to recover a release. The publisher accepts an existing version only when its tarball digest and channel dist-tag exactly match the reviewed artifact. Registry visibility is retried for a bounded interval. Recovery also requires cryptographically verified npm provenance bound to the exact archive, repository, release workflow, signed tag, and prepared commit. Missing attestations wait within the same bound; invalid signatures or source bindings fail.

Use manual dispatch with the existing tag only to verify that tag or to restore notes and labels after the exact registry artifact is visible. Manual dispatch never publishes.

## Migrations and rollback

Document user-visible command or scaffold migrations in the release pull request and changelog. To roll back, publish a later stable release for `latest`, or a later RC for `next`, that restores the required behavior; do not replace an immutable artifact. Stable tags use `vX.Y.Z`; RC tags use `vX.Y.Z-rc.N`. Stable publication requires `latest` to match the version; RC publication preserves the stable `latest` observed beforehand. Public provenance requires a public source repository at publication time. Recreating the repository requires rebinding the npm trusted-publisher identity to its new repository ID.

# Releasing dvmctl

## Scope

Only the standalone dvmctl repository publishes `@dvmkit/dvmctl`. Stable releases publish to `latest`, and RC releases publish to `next`. Both require publicly verifiable provenance.

## Operator configuration evidence

Before enabling publication, record that npm trusted publishing is bound to the `dvmkit/dvmctl` repository, `release.yml` workflow, `npm-release` environment, and direct `npm publish` permission. The npm connection must be permitted to publish directly rather than stage-only. No npm token is used.

Record that the GitHub environment accepts stable `vX.Y.Z` and RC `vX.Y.Z-rc.N` tags. Record that the release App is repository-only, has only contents, issues, and pull-request write permissions, and cannot bypass rulesets. Record that only maintainers can create stable and RC tags and that no actor can update or delete them.

## Compatibility

The exact SDK selection is `dependencies["@dvmkit/sdk"]` in [package.json](package.json); `node scripts/sdk-version.mjs` prints it. Artifact checks, consumer installs, and scaffolds read it. Update it and the lockfile only after the selected registry version exists. It supports Node.js `>=22` and is built with Node.js `22.23.2`.

## Full package acceptance without publishing

Use [consumer-smoke.mjs](scripts/consumer-smoke.mjs) to check an installed archive from an immutable reviewed source revision. This needs only public source and npm packages, Node.js **22.23.2**, npm **10.9.8**, Git, Bash, `tar`, and a running Docker engine. Allow outbound npm/image downloads, local listeners, and enough writable temporary space for several npm installs and Docker builds. Use a disposable host or Docker daemon with no platform credentials, publication credentials, or wallet funds.

| Mode | Evidence |
| --- | --- |
| Default (omit `--full`) | Scaffold install, generated tests/typecheck, validation, dev with reload and `--no-reload`, serving SDK banner/development page, matching and mismatched project SDKs, completed free local jobs with retained artifacts, and refusal to serve without a production database. |
| `--full` | All default checks plus production serving and completed local jobs with PostgreSQL, serving SDK/mismatch checks in production, Docker build-context exclusions, runtime SDK/`pg` dependencies and development-dependency pruning, and deployment request/archive contracts against local fixtures. |

The [Verify workflow](.github/workflows/verify.yml) packs twice and runs default mode against that installed archive across its runtime matrix. The [Release workflow](.github/workflows/release.yml) runs full mode before publication and against the exact published version afterward. Deployment responses in this fixture are simulated: full mode does not deploy a live platform service, exercise machine control/database tunnels, or prove paid calls or refunds. Those need separate platform/payment acceptance.

### Run the procedure

Run this block in Bash. Replace `REVIEWED_COMMIT` with the independently reviewed full 40-character source commit, never a branch or npm dist-tag. By default it builds a candidate twice from that revision using the existing [release artifact identity checks](scripts/release-artifact.mjs); retain the resulting archive and digest as the candidate under review. `v$version` and the channel here are identity fields only; no tag is created and nothing is published.

For an **already reviewed archive**, download and extract the artifact from the specific matching Verify or Release run, recording its run URL and checked-out source SHA (a PR run can use a merge commit). Set `reviewed_artifact_dir` below to that directory's absolute path. It must contain the original `release-digest.json` and exactly one `.tgz`. Do not regenerate a digest for an unverified download. Both paths verify against the independently expected source commit/version/channel before installation; no npm dist-tag selects the CLI or SDK.

The archive's exact SDK pin is installed explicitly, as in CI, and compared with the installed manifests. PostgreSQL 17 uses throwaway credentials and a loopback-only random host port. Its `pg_isready` health check must succeed before setting `DATABASE_URL`.

The subshell's exit trap attempts to remove the disposable database container/volume on success or failure. On success it also removes the consumer, source checkout, fixture scratch space, and isolated config; on failure it retains scratch space for diagnosis and manual cleanup. Evidence stays outside that scratch directory. Cleanup results are recorded separately from the procedure's exit status.

```sh
(
set -euo pipefail
reviewed_commit=REVIEWED_COMMIT
reviewed_artifact_dir= # Optional absolute path to an extracted reviewed artifact.
[[ "$reviewed_commit" =~ ^[0-9a-f]{40}$ ]]
test "$(node --version)" = v22.23.2
test "$(npm --version)" = 10.9.8
docker info >/dev/null
evidence=$(mktemp -d "${TMPDIR:-/tmp}/dvmctl-evidence.XXXXXX")
scratch=$(mktemp -d "${TMPDIR:-/tmp}/dvmctl-acceptance.XXXXXX")
postgres="dvmctl-${scratch##*/}"
postgres_created=false
cleanup() {
  result=$?
  trap - EXIT
  set +e
  printf 'procedure_exit=%s\n' "$result" > "$evidence/result.txt"
  if "$postgres_created"; then
    docker rm --force --volumes "$postgres" > "$evidence/cleanup.log" 2>&1
    printf 'database_remove_exit=%s\n' "$?" >> "$evidence/result.txt"
  fi
  docker image ls --filter 'reference=dvmctl-consumer-*' --format '{{.Repository}}:{{.Tag}} {{.ID}}' > "$evidence/runtime-images-after.txt"
  printf 'image_inventory_exit=%s\n' "$?" >> "$evidence/result.txt"
  if test "$result" -eq 0; then
    cd /
    rm -rf "$scratch" >> "$evidence/cleanup.log" 2>&1
    printf 'scratch_remove_exit=%s\n' "$?" >> "$evidence/result.txt"
  else
    printf 'scratch_retained_for_diagnosis=true\n' >> "$evidence/result.txt"
  fi
  printf 'Evidence retained in %s\n' "$evidence"
  exit "$result"
}
trap cleanup EXIT
printf 'Evidence directory: %s\n' "$evidence"
printf '%s\n' "$scratch" > "$evidence/scratch-directory.txt"
printf '%s\n' "$postgres" > "$evidence/postgres-name.txt"
mkdir -p "$scratch/tmp" "$scratch/config" "$scratch/consumer" "$scratch/first" "$scratch/second" "$evidence/artifact"
export TMPDIR="$scratch/tmp"
export DVMCTL_CONFIG_DIR="$scratch/config/dvmctl"
export DVMKIT_CONFIG_DIR="$scratch/config/dvmkit"
export DVM_CONFIG_DIR="$scratch/config/dvm"
export NPM_CONFIG_USERCONFIG="$scratch/npmrc"
export NPM_CONFIG_GLOBALCONFIG="$scratch/global-npmrc"
export NPM_CONFIG_CACHE="$scratch/npm-cache"
touch "$NPM_CONFIG_USERCONFIG" "$NPM_CONFIG_GLOBALCONFIG"
docker image ls --filter 'reference=dvmctl-consumer-*' --format '{{.Repository}}:{{.Tag}} {{.ID}}' > "$evidence/runtime-images-before.txt"
git clone --quiet https://github.com/dvmkit/dvmctl.git "$scratch/source"
cd "$scratch/source"
git checkout --detach "$reviewed_commit"
test "$(git rev-parse HEAD)" = "$reviewed_commit"
version=$(node -p 'require("./package.json").version')
channel=$(node scripts/release-channel.mjs "$version")
if test -n "$reviewed_artifact_dir"; then
  cp "$reviewed_artifact_dir/release-digest.json" "$reviewed_artifact_dir/"*.tgz "$evidence/artifact/"
else
  npm ci
  npm run build
  npm pack --ignore-scripts --json --pack-destination "$scratch/first" > "$scratch/first/pack.json"
  npm pack --ignore-scripts --json --pack-destination "$scratch/second" > "$scratch/second/pack.json"
  first="$scratch/first/$(node -p 'require(process.argv[1])[0].filename' "$scratch/first/pack.json")"
  second="$scratch/second/$(node -p 'require(process.argv[1])[0].filename' "$scratch/second/pack.json")"
  node scripts/release-artifact.mjs create --first "$first" --second "$second" --output "$evidence/artifact/release-digest.json" --tag "v$version" --version "$version" --dist-tag "$channel" --commit "$reviewed_commit"
  cp "$first" "$evidence/artifact/"
fi
archive=$(node scripts/release-artifact.mjs verify --directory "$evidence/artifact" --tag "v$version" --version "$version" --dist-tag "$channel" --commit "$reviewed_commit")
tar -xOf "$archive" package/package.json > "$evidence/archive-package.json"
sdk_pin=$(node -p 'require(process.argv[1]).dependencies["@dvmkit/sdk"]' "$evidence/archive-package.json")
test "$sdk_pin" = "$(node scripts/sdk-version.mjs)"
consumer="$scratch/consumer"
cd "$consumer"
npm init --yes >/dev/null
npm install --ignore-scripts --no-audit --no-fund "$archive" "@dvmkit/sdk@$sdk_pin"
cli="$consumer/node_modules/@dvmkit/dvmctl/dist/dvmctl.js"
node -e '
  const fs = require("node:fs");
  const root = process.argv[1];
  const cli = JSON.parse(fs.readFileSync(root + "/node_modules/@dvmkit/dvmctl/package.json", "utf8"));
  const sdk = JSON.parse(fs.readFileSync(root + "/node_modules/@dvmkit/sdk/package.json", "utf8"));
  if (cli.version !== process.argv[2] || cli.dependencies["@dvmkit/sdk"] !== process.argv[3] || sdk.version !== process.argv[3]) throw new Error("installed CLI/SDK differs from archive");
  console.log(JSON.stringify({ cli: cli.version, sdkPin: cli.dependencies["@dvmkit/sdk"], installedSdk: sdk.version }));
' "$consumer" "$version" "$sdk_pin" > "$evidence/installed-versions.json"
node "$cli" --version > "$evidence/cli-version.txt"
node --version > "$evidence/node-version.txt"
npm --version > "$evidence/npm-version.txt"
docker run --detach --name "$postgres" --publish 127.0.0.1::5432 \
  --env POSTGRES_DB=dvmctl_smoke --env POSTGRES_USER=dvmctl_smoke \
  --env POSTGRES_PASSWORD=dvmctl_smoke \
  --health-cmd 'pg_isready --username dvmctl_smoke --dbname dvmctl_smoke' \
  --health-interval 2s --health-timeout 5s --health-retries 30 \
  postgres:17-alpine > "$evidence/postgres-container.txt"
postgres_created=true
for attempt in {1..60}; do
  test "$(docker inspect --format '{{.State.Health.Status}}' "$postgres")" = healthy && break
  sleep 2
done
test "$(docker inspect --format '{{.State.Health.Status}}' "$postgres")" = healthy
port=$(docker port "$postgres" 5432/tcp)
export DATABASE_URL="postgresql://dvmctl_smoke:dvmctl_smoke@127.0.0.1:${port##*:}/dvmctl_smoke"
printf 'node scripts/consumer-smoke.mjs <absolute-installed-dist/dvmctl.js> --full\n' > "$evidence/command.txt"
node "$scratch/source/scripts/consumer-smoke.mjs" "$cli" --full > "$evidence/full.log" 2>&1
printf 'full_mode=passed\n' > "$evidence/full-result.txt"
cd /
)
```

A zero procedure exit and `full_mode=passed` mean every full-mode assertion completed. On failure, retain `full.log` if present and the primary error; an absent full-mode result is not a pass. Run from a clean environment without credentials: the fixture strips credential-like variables for CLI children and supplies fake credentials only to its local platform fixtures. Its child CLI config overrides are under its own temporary tree; `DVM_CONFIG_DIR` remains isolated by the outer environment.

### Cleanup and evidence checklist

The fixture attempts to stop serving process groups and close fixture HTTP servers, then removes its `dvmctl-consumer-*` temporary directory (including scaffolds, config, and job artifacts). A failed process stop can leave that directory for diagnosis. The runtime Docker container uses `--rm`, and the fixture attempts to remove its `dvmctl-consumer-*` runtime image. Image-removal failures are tolerated, and cleanup errors can be hidden by a primary test failure. The deploy dry run leaves an untagged image; downloaded base images and Docker build cache also remain.

After **every attempt**, inspect `result.txt`, `cleanup.log` if present, and the before/after runtime-image inventories. Confirm the named PostgreSQL container and its anonymous volume are gone and no fixture processes/containers remain. A failed attempt retains the scratch directory recorded in `scratch-directory.txt`; save diagnostics, stop any remaining processes, then remove that directory. If interrupted before the exit trap completes, explicitly run `docker rm --force --volumes <recorded-container-name>` using `postgres-name.txt` and perform the same scratch cleanup. Remove leftover runtime images by their exact recorded tag. Use a disposable Docker daemon to discard untagged images, base images, and build cache without pruning unrelated work. Delete the retained evidence directory only after saving the review record.

Record in the pull request:

- Full source commit, artifact origin/run URL when downloaded, CLI version, archive filename and SHA-256 from `release-digest.json`; retain that digest and the exact archive.
- Archive SDK pin and installed SDK version from `installed-versions.json`, plus Node/npm versions and host OS/Docker version.
- The full-mode command with its installed CLI path represented by a public-safe placeholder, result/exit status, and relevant assertion failure if any.
- Cleanup outcome separately: process/scratch removal, database/container/volume removal, runtime image leftovers, and intentionally retained evidence or Docker cache. A passing job alone does not prove cleanup.

Keep raw logs locally for reproduction. Before publishing evidence, remove local filesystem paths, host/account identifiers, credentials, and unrelated environment data. This procedure does not replace the repository's `npm run verify` gate or the hosted package/runtime checks.

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

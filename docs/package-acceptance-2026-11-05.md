# Full package acceptance: 2026-11-05

Maintainer-reported result for the [documented full package acceptance procedure](../RELEASING.md#full-package-acceptance-without-publishing): **passed**. This record applies to the exact source revision and archive below.

| Identity | Value |
| --- | --- |
| Source commit | [`d836cfe816e78bc649ca77274dd5cb6b3eb361d5`](https://github.com/dvmkit/dvmctl/commit/d836cfe816e78bc649ca77274dd5cb6b3eb361d5) |
| Archive | `dvmkit-dvmctl-0.16.0.tgz` |
| Archive SHA-256 | `f44e6d3a34dd20939b7019151c731c678d418d490d60f4bd49b8af05c7fa82a7` |
| Installed CLI | `0.16.0` |
| Archive SDK pin / installed SDK | `0.21.1` / `0.21.1` |
| Node / npm | `22.23.2` / `10.9.8` |
| Host | macOS `26.2`, arm64 |
| Docker CLI / engine / Buildx | `29.7.1` / `29.5.2` / `0.36.1` |
| Disposable PostgreSQL image | `postgres:17-alpine` |

The candidate was built and packed twice from that exact reviewed revision; artifact identity checks passed. No publication or tag creation occurred.

The installed CLI was checked with:

```sh
node scripts/consumer-smoke.mjs <absolute-installed-dist/dvmctl.js> --full
```

The installed CLI path is redacted to a placeholder. Procedure exit: `0`; full-mode result: `full_mode=passed`. No platform credentials, wallet funds, or live deployment were used.

An initial attempt exposed missing build-plugin discovery in the isolated Docker configuration. The host configuration was corrected and the failed attempt was cleaned up; the complete procedure then passed with the identical archive SHA-256 above.

Cleanup was checked separately from the passing procedure:

| Resource | Observed outcome |
| --- | --- |
| Fixture processes and runtime containers | None remained. |
| Temporary source, consumer, config, and fixture scratch | Removed. |
| PostgreSQL container and its recorded anonymous volume | Absent. |
| Runtime image inventory | Matched its baseline. |
| Exact archive, digest, and raw logs | Retained locally. |
| Untagged dry-run image, base images, and build cache | Intentionally retained; no global prune. |

[Hosted verification and the installed CLI matrix](https://github.com/dvmkit/dvmctl/actions/runs/41952212465) also passed. Those hosted checks are separate from this maintainer-run full acceptance result.

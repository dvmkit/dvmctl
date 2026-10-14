# Preserve financial evidence before database destruction

The builder owns the export file and its retention. Platform-retained financial history does not replace evidence in the service database. Complete and verify the export while the database and a service machine are still available, before either destruction variant. `--keep-db` retains database storage but still removes compute and its database tunnel. Later access requires redeploying the service and reattaching the retained database through the supported deployment flow before `db connect` or `db proxy` can work. Existing caller-liability and wind-down rules are unchanged.

Carry the selected organization through every database and destruction command. In the examples below, set `DVM_HANDLE` to the service handle and `DVM_ORG` to its selected organization; preserve the same quoted `--org "$DVM_ORG"` on each command. Omit `--org` only when deliberately using the active organization context, after confirming it owns this service. Same-named services in other organizations are different targets.

Use the recipe shipped in the service's own installed `@dvmkit/sdk` package, `recipes/postgres/financial-export-v1.sql`. It produces versioned JSON with signed receipts, amounts and currencies, financial linkage, and recovery outcomes. It excludes raw job input/output, bearer proofs, and operational credentials. Unsupported signed receipt extensions fail rather than producing unverifiable evidence. A full `pg_dump` is a database backup and does not provide this minimized export.

From the service project, locate the installed recipe without a private checkout or unsupported package import:

```sh
sdk_entry="$(node --input-type=module -e 'console.log(import.meta.resolve("@dvmkit/sdk"))')"
recipe="$(node --input-type=module -e 'import { fileURLToPath } from "node:url"; console.log(fileURLToPath(new URL("../recipes/postgres/financial-export-v1.sql", process.argv[1])))' "$sdk_entry")"
```

For an interactive connection, run `dvmctl db connect "$DVM_HANDLE" --org "$DVM_ORG"`. In `psql`, run `\i /absolute/path/to/financial-export-v1.sql`; use `\o /absolute/path/to/financial-evidence.json`, tuples-only (`\t`), and unaligned (`\a`) output to capture the JSON.

For an automated export, keep `dvmctl db proxy "$DVM_HANDLE" --org "$DVM_ORG"` running in another terminal. Its JSON output provides `database_url`. Treat that URL as a credential: do not publish it or include it in evidence logs. With that connection configured locally as `DATABASE_URL`, run:

```sh
umask 077
psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 -f "$recipe" > financial-evidence.json
```

Check the command exit status, parse the JSON, verify retained receipts with the service's receipt public key, and store the export and recipe securely under your retention policy. A failed export may leave a partial file; do not treat it as evidence. Resolve outstanding balances, drains, and recovery outcomes before retirement. Only after export and verification finish, request destruction with `dvmctl destroy "$DVM_HANDLE" --org "$DVM_ORG" --confirm`. Add `--keep-db` to that same scoped command when storage must remain for later reattachment; it does not keep the export tunnel available.

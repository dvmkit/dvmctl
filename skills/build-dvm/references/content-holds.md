# Job content holds

Holds retain service-local job content for support or disputes. They require `@dvmkit/sdk` 0.8.0 or later with a supported store. The commands sign requests using the local builder lock key; the service records the verified public key as actor. A platform token alone cannot read job content. These commands return retention metadata and hold history, not raw content.

```sh
dvmctl content-holds list <handle> <job-id>
dvmctl content-holds place <handle> <job-id> --purpose support --reason 'Investigating result' --review-due-at 2030-01-01T00:00:00Z
dvmctl content-holds renew <handle> <job-id> <hold-id> --reason 'Review continues' --review-due-at 2030-02-01T00:00:00Z
dvmctl content-holds clear <handle> <job-id> <hold-id> --reason 'Review complete'
```

Use `--endpoint <url>` for a self-hosted service recorded in local builder state, `--org <handle>` for a platform organization, and `--human` for readable output. The default JSON includes hold IDs, verified actors, effective and baseline expiry in epoch milliseconds or null, review deadlines, overdue status, and an action hint. Review dates may also be supplied as future epoch milliseconds.

Multiple holds can remain active together. A review deadline never clears a hold or deletes content. Renew moves the review date; clear explicitly ends that hold. Clearing the last active hold restores the baseline expiry, which may already have passed. Expired, unavailable content cannot be recovered by placing a hold. An unsupported service gives an upgrade action; a typed `job_not_found` remains a missing-job error.

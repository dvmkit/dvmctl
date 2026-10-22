# Hosted Tempo close reports

These records track the builder's payout report after a channel closes. They are separate from caller drains and require hosted settlement reports on the target DVM with SDK 0.10.0 or later. Use the [command reference](https://dvmkit.com/docs/cli-dvmctl.md) for the full HTTP and output contracts.

1. Inspect `dvmctl credit tempo-close-reports <handle> --human`. Each row shows the exact amount in native token units, its current state, and `retryable` and `write_off_allowed` flags. `--all` includes terminal `no_report` rows and retained write-off notes. Follow `next_after` with `--after`, preserving the same `--all` setting; the default page is 20, with a maximum `--limit` of 50.
2. Restore complete chain history before `dvmctl credit tempo-close-report-retry <handle> <obligation-id>`. Retry reopens the search so the builder's payout report can still be sent. It does not broadcast, change the caller's drain, or prove delivery. The amount lookup stops after five audit pages of 50 rows; retry still proceeds with an unavailable amount if the report was not found. Check service events afterward.
3. Only after authorization to abandon that payout report, run `dvmctl credit tempo-close-report-write-off <handle> <obligation-id> --note "Reason for abandoning the payout report"`. The note is required and must contain 1–2000 characters after trimming. The command has no interactive confirmation prompt, like existing credit write-offs. It prints `amount_forgone_native`, a decimal string in native token units.

Write-off permanently gives up that payout report if the missing close lands later. It never refunds the caller or discharges caller refund liabilities. An explicit retry can reopen a written-off report before a late close lands; a payout from a close that lands while written off will not be reported.

All three commands accept `--endpoint`, `--org`, and `--human`; JSON is the default. Action eligibility belongs to the server, and list flags can become stale. On HTTP 409 `tempo_close_report_conflict`, read the reason and inspect `tempo-close-reports --all` again. On HTTP 404 `tempo_close_report_not_found`, check the target DVM and obligation ID. A bare HTTP 404 `not_found` means the routes are missing; upgrade the DVM to SDK 0.10.0 or later. HTTP 503 `tempo_close_report_unavailable` means hosted settlement reports need configuration.

## Held caller drains

Inspect `dvmctl credit tempo-wedged <handle>` separately from the builder payout report queue. A landed close covering the debit can be finished with `credit tempo-reconcile`; automatic reconciliation remains available. A drain write-off only records an annotation: the debit and refund liability remain held. On current servers these rows remain visible by default but are excluded from action counts. `--include-resolved` adds terminal operator decisions; follow `next_after` with `--after` and preserve the listing flags. Older servers can omit the new audit fields or hide old write-offs; do not infer a decision from missing fields.

A short refund, including on `exit_required`, needs independent repayment of the remainder before whole-refund booking. These decisions require SDK 0.11.0-rc.1 or a compatible later release:

```sh
dvmctl credit tempo-book <handle> <credit-id> <drain-id> --reason "Full refund independently confirmed" --evidence "Independent payment reference" --confirm
dvmctl credit tempo-release <handle> <credit-id> <drain-id> --reason "No refund was paid" --confirm
```

Book attests that the **entire held amount**, including any off-path remainder, was returned. Release records **no refund was paid** and restores the original held debit. Neither command pays the caller, uploads proof, accepts a partial amount, nor creates a transaction hash. The required reason is 1–2000 characters after trimming; optional evidence is 1–4000 and is only an audit note/reference. Both commands accept `--endpoint`, `--org`, and `--human`, default to JSON, and send no HTTP without `--confirm`.

The original amount, currency, IDs, and immutable operator decision/time remain in the result. `balance_micro` and `spendable_micro` are current, including on replay. Expiry, backing loss, job holds, and channel restrictions still apply; restoring ledger balance cannot reopen a channel or reverse genuine backing loss. A replay needs the same action, trimmed reason, and evidence; it moves no money again. Changing them or switching action conflicts. After a lost response, repeat the original intent.

Listing audit fields include `held_reason`, `decision`, `proven_refund_native`, `refund_payment_proven`, and separate `close_reports` summaries. Exact native evidence is a decimal string, including above JavaScript's safe integer limit. Null means unknown; `"0"` means exact zero. Payer-exit calculations are lower bounds and never supply an exact amount. `refund_payment_proven: true` retains a positive-payment fact even when the exact amount is unknown or a later receipt reads zero. False means no retained positive fact, not proof of nonpayment. Never replace unknown evidence with zero.

- `tempo_drain_close_pending` (409): a close might already have broadcast. Resolve its final close/exit outcome first; elapsed time, an open channel, or a missing transaction hash is insufficient.
- `tempo_drain_refund_paid` (409): some refund is proven. Independently return the remainder, then book the whole refund; do not release it.
- `tempo_drain_refund_unknown` (409): recover original historical evidence before asserting nonpayment.
- `drain_decision_conflict` (409): inspect `tempo-wedged --include-resolved`; replay the original decision rather than replacing intent.
- `drain_not_repairable` (422): check the target and ID pair; only supported Tempo session drains can be decided.
- `tempo_drain_decision_unavailable` (503): configure a durable decision-capable ledger and Tempo store, plus transactional drain reporting on hosted services.
- A missing route (404) needs an SDK upgrade; typed missing credit/drain errors need the correct target/IDs. Authentication errors (401) require the correct builder lock identity; malformed requests (400) require corrected arguments.

Only a confirmed no-close result directs an `exit_required` caller to timed exit. Unchecked, failed, or unknown chain evidence requires chain lookups or original evidence before choosing an action. A close-report retry or write-off never recovers caller funds or settles a drain liability.

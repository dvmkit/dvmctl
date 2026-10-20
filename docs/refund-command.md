# Refund a completed job

`dvmctl refund <job-id>` restores all or part of a completed job's charge to the caller's original prepaid credit. The caller can spend it on another job or reclaim it with `dvm credit drain <dvm>`. Per-job payments, Tempo channel credits, and x402 batch-channel credits are unsupported.

Run it in the service's project directory, or select the service with `--dvm <slug>`. The default name comes from the project, as for `deploy`. `--org <handle>` selects the organization, including the context saved by `dvmctl switch`. `--endpoint <url>` uses the existing signed admin connection for a self-hosted or local service.

```sh
dvmctl refund job-example --dvm scrape
dvmctl refund job-example --dvm scrape --confirm
dvmctl refund job-another --dvm scrape --amount 0.003 --reason "Incomplete result" --confirm
```

Without `--confirm`, the command refuses with `confirmation_required` and describes a local intent. It sends no HTTP, including discovery or admin requests. The intent does not establish eligibility or a numeric remainder. An explicit amount is a decimal in the job's credit currency; this local intent does not guess that currency. Omit `--amount` to refund the remaining unrefunded charge. Explicit amounts must be positive, have at most six fractional digits, and fit a safe integer number of micro-units. Exponents and rounding are unsupported. Reasons are optional and at most 280 characters.

The default refund ID depends on the immutable DVM ID, job ID, and normalized amount intent. `0.003` and `00.003000` identify the same refund. A remainder intent stays the same after other balance activity. Repeat the original arguments after an interruption: the server returns the original refund without changing the balance again. Preserve the reason, too; changing it while reusing the ID causes `refund_conflict`.

To deliberately issue another partial refund of the same amount for the same job, choose and retain a new ID:

```sh
dvmctl refund job-another --dvm scrape --amount 0.003 --refund-id support-refund-second --confirm
```

JSON is the default. `display` and `hint` explain what the caller sees; `--human` relays the same semantics. Success retains `status`, `refund_id`, `credit_id`, `draw_id`, `job_id`, `amount_micro`, `currency`, `ledger_seq`, `refunded_at`, `balance_after_micro`, and `replayed`. On replay, the monetary values, timestamp, sequence, and balance snapshot describe the original refund. `balance_after_micro` is not a current balance after later activity.

The service checks eligibility and cumulative refunds atomically. Closed credits and channel-backed payments cannot be forced through this command. `credit_refund_basis_unavailable` requires an operator to inspect independent original-payment evidence; current exchange rates cannot replace it. `credit_refund_state_unavailable` requires independent funding and drain evidence. Retrying alone repairs neither. `credit_refund_unavailable` means the persistent credit store or platform refund reporter needs configuration; no refund was queued. Repair configuration, then repeat the original ID and arguments.

## Upgrade before activation

The CLI and new scaffolds use exact `@dvmkit/sdk` `0.11.0-rc.1`. Separately installed project dependencies stay unchanged until explicitly upgraded. `dvmctl serve` and `dvmctl dev` run the CLI's pinned SDK, so upgrading or downgrading dvmctl changes their SDK on the next restart. Pause monetary writes and coordinate upgrades or rollbacks across these processes under the rules below, even when the project's own SDK dependency is unchanged. The development memory ledger cannot serve this refund route; production refunds require persistent credit storage and a transactional platform refund reporter.

Before enabling refunds, pause monetary writes and upgrade every process sharing the credit database and report queue, including funding writers and retry workers. Older writers can invalidate funding-order evidence, and older readers cannot interpret refund reports or known-zero Bitcoin lots. Mixed-version monetary history after the new metadata starts being written requires a state compatibility assessment. Assess rollback compatibility after refund state exists. Additive schema initialization alone does not make a rolling upgrade or rollback safe. See the [SDK upgrade details](https://github.com/dvmkit/sdk/blob/v0.11.0-rc.1/CHANGELOG.md).

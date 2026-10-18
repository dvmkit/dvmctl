# Operate an existing service

Resolve the requested service and organization with `dvmctl list`, `dvmctl info <slug>`, and `dvmctl whoami`. Confirm them from output before a remote change. Read the [dvmctl reference](https://dvmkit.com/docs/cli-dvmctl.md) for exact flags and output; do not load every operation below.

## Inspect health

Use `status` for compute state, `metrics` for the relevant time window, and `events` or `logs` for the incident. Logs can be raw text. Correlate the job and deployment IDs before acting on an error from an older revision.

A running process does not prove the handler or payment path works. Verify an appropriate capability call after a repair. Route an uncertain job, deploy, or payment outcome to [recovery](recovery.md).

## Inspect earnings and collect payouts

Use `dvmctl revenue summary` for totals and `revenue events` or `revenue csv` for the requested period and organization. Report these as earnings, not a wallet balance.

For Cashu, confirm the intended Lightning payout destination with the service configuration. Set or change it only within authorization using `dvmctl set-payout`. Run `dvmctl melt-pending <slug>` for a pass or its documented watch mode for continued service, then inspect `dvmctl melt-status` and the destination's receipt evidence.

Keep the refund and payout roles separate. The worker can use `DVMKIT_REFUND_NWC_URL` to buy ecash for caller refunds and `DVMKIT_MELT_PAYOUT_NWC_URL` to receive builder payouts. Supply these through its secret environment. The DVM's `DVMKIT_NWC_RECEIVE_URI` only receives Lightning credit payments. Never reuse a send-capable connection as that receiving credential.

If caller refunds remain or drain state cannot be read, preserve the payout hold and use [recovery](recovery.md). Do not treat an unavailable liability query as a zero balance.

For stablecoins, verify the configured network and recipient, then inspect the transfer or channel settlement evidence. Keep required close observers running. For opted-in one-payment credit refunds, inspect `dvmctl credit drains-owed`, perform only the authorized transfer, and record the real transaction with `credit drain-settle`. Never record a payment merely to clear the queue. For hosted Tempo builder payout reports, inspect `dvmctl credit tempo-close-reports`; follow the [close-report reference](references/tempo-close-reports.md) for retry or write-off.

## Change the service

Choose the command matching the requested change. Use [deploying](deploying.md) for a new revision. Use restart, scale, environment, domain, or database commands only after checking their target and consequences in the reference. A machine restart does not repair a missing payment record.

Before a transfer, inspect the current owner, intended destination organization, and custody consequences. After transfer, verify the resulting owner and any pending treasury re-key. Follow the required redeployment before reporting payouts ready.

For temporary suspension, use the documented pause/resume path and verify availability afterward. For permanent removal or data deletion, read [retirement](retirement.md) first.

Close with the observed state, change made, and remaining action. Report a payout only when transfer evidence supports it; keep earnings, pending settlement, and funds delivered distinct.

## Builder feedback nudges

`dvmctl` may include `feedback_nudge` and `feedback_hint` after a failed command, a first deploy, or a periodic check-in. Under `ask`, describe the proposed feedback and get the builder's agreement before `dvmctl feedback send`. Under `auto`, send your own short, specific note without asking. Under `off`, do not act on a nudge; explicit feedback from the builder can still be sent. Never include credentials, source files, or environment values in feedback.

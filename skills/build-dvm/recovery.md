# Recover an uncertain or failed operation

Start from the operation that failed, not from onboarding. Preserve its service, organization, endpoint, job/deployment/funding IDs, time window, caller journal, and receipt. Keep secrets out of the report.

## Determine whether it happened

Read the command's structured error and recovery hint. Distinguish a refusal before submission from a pending operation or lost response. Stop dependent money movement while the result is unknown.

| Operation | First evidence |
| --- | --- |
| Deployment | Existing deployment status, active service revision, and events |
| Job or paid submit | Original caller profile, request ID, job state, messages, and receipt |
| Lightning credit funding | Original fund ID, invoice settlement evidence, and a credit balance read |
| Cashu payout or refund | Melt status, pending drains, retained proofs, and wallet or mint evidence |
| Stablecoin settlement | Correct network's transaction receipt and channel state |

Do not create a new funding, request, or deployment merely because the prior response was lost. Use the original operation's supported resume/reconcile path. A fresh request ID changes the operation; it is not a retry.

For Lightning funding, `dvm credit balance <endpoint>` can prompt recognition of the paid invoice. Keep the receiving wallet reachable. If confirmation is blocked, use the builder's blocked-invoice inspection below; do not pay another invoice to compensate for an unknown one.

## Choose a supported repair

Read only the relevant [dvmctl command contract](https://dvmkit.com/docs/cli-dvmctl.md) before invoking a repair:

- `credit blocked` inspects Lightning invoice problems; `credit reconcile` checks the existing payment evidence.
- `credit x402-wedged` and `credit x402-reconcile` inspect and reconcile x402 settlement.
- `credit tempo-wedged` and `credit tempo-reconcile` inspect and reconcile Tempo drains.
- `credit drains-owed` identifies manual stablecoin refunds. `credit drain-settle` records a transfer that actually happened; it does not send the funds.
- `melt-pending` services ecash refunds before builder payout. Restore missing worker credentials or connectivity without removing the refund hold.

A write-off accepts loss or abandons recovery. Explain the exact obligation and consequence and require authorization for that loss before using a write-off command. Do not substitute write-off for a reconciliation that has not established the outcome.

For runtime failure, inspect current logs, configuration names, dependencies, and persistence before restarting or rolling back. A rollback does not undo external transfers or necessarily restore an earlier database schema. Never rotate or delete recovery keys as a general repair. If a rotation reached the DVM but its platform update is pending, follow the CLI's synchronization hint; rotating again would create another key change.

## Verify and retain evidence

Re-read the original operation and its liability or balance after the repair. Verify the actual job result or funds movement as relevant. A repair command exiting successfully is not sufficient if the underlying state is still pending.

Retain records until all dependent obligations resolve. If evidence is unavailable, report the precise unknown state and the dependency needed to resolve it. Do not claim zero liability or destroy the service to make an unresolved queue disappear. Permanent shutdown belongs in [retirement](retirement.md).

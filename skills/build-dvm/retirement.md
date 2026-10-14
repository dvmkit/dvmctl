# Retire a service

Use this only when the user intends to stop offering the service or remove its infrastructure. For an incident or uncertain payment, use [recovery](recovery.md).

## Establish the shutdown scope

Confirm the service, organization, and endpoint from current output. Distinguish a temporary pause from permanent removal, including whether the database should remain. Existing authorization counts, but an instruction to stop compute does not imply permission to delete financial records.

Read the [destroy and pause contracts](https://dvmkit.com/docs/cli-dvmctl.md) before changing availability. Pause stops routing and compute while preserving service resources. It also makes the service unavailable to callers, so it is not a way to keep serving refunds.

## Account for obligations

Inspect active jobs, open caller credit, pending drains, unsettled channels, pending ecash, and payout state. Use the operational and credit inspection commands for the configured methods. Reconcile unavailable or inconsistent evidence before treating anything as empty.

Preserve the database, signing identity, Cashu recovery material, and caller-refund records needed to complete outstanding work. Keep the receiving wallet and settlement/refund workers available for obligations that still depend on them. Lightning payments already received can still back unused caller credit.

Resolve refunds and settlements through their normal paths and verify delivery. Do not send an unrelated manual transfer for a channel-backed refund or record a transfer that has not occurred. Route stuck states to [recovery](recovery.md).

## Remove only the authorized resources

Use the platform's wind-down behavior when destruction reports outstanding credit. Inspect the returned state and continue serving the outstanding obligations; a `winding_down` response is not completed removal.

When permanent destruction is authorized and its consequences are understood, finish and verify [financial export](references/financial-export.md), then invoke `dvmctl destroy "$DVM_HANDLE" --org "$DVM_ORG" --confirm` with the same selected service and organization used for DB access, adding `--keep-db` when retaining the database is part of the shutdown plan. The default can remove the paired database. Never choose the default while that database is still needed for recovery.

For self-hosted services, remove infrastructure through the host's tools only after the same obligation check. Cloud commands do not destroy the separately managed host.

## Confirm the final state

Verify service availability, platform state, remaining infrastructure, and unresolved balances. Preserve necessary financial evidence before revoking the credentials required to inspect it. Revoke obsolete platform and wallet access deliberately; destroying compute does not revoke external connections.

Report what stopped, what was removed, what remains retained or payable, and who must act next. Call retirement complete only when the agreed resources and obligations are accounted for.

Complete and verify the export before either destruction variant removes compute. The builder owns the export file; platform-retained financial history does not replace it. `--keep-db` preserves storage but removes the running machine and database tunnel. Later DB access requires redeploying and reattaching that retained database through the supported deployment flow. Keep the selected `--org` on DB connect/proxy and destruction commands, or deliberately confirm the active organization context before omitting it.

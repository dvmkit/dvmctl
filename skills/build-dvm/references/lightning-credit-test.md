# Lightning-funded credit acceptance

Use this only with an authorized Lightning funding amount and a durable service. Lightning funds prepaid credit; it is not a per-job payment rail. Ordinary `dvmctl dev` has disposable state and does not provide this test boundary. There is no public FakeWallet NWC recipe to substitute here.

## Establish the service and wallets

Verify the service has descriptor-level auth, enabled credit, durable Postgres storage, and a receive-only `DVMKIT_NWC_RECEIVE_URI`. Confirm Lightning appears in its credit funding menu. Read the advertised minimum before choosing the deposit; a per-job cap does not authorize raising the deposit to meet that minimum.

Use a separately approved caller wallet and funding amount. Supply its NWC connection through a secret store into stdin for `dvm wallet connect`, never as an argument or chat message. The caller's connection pays invoices; the service's receiving connection must not.

Create an isolated `DVM_CONFIG_DIR`, initialize `dvm`, and connect only that test wallet. Read the [caller wallet reference](https://dvmkit.com/docs/dvm-cli.md) for connection and policy options. A declared CLI budget does not impose a wallet-side per-payment routing-fee cap. Keep the caller state until all credit and payment outcomes are resolved.

## Fund once, then spend credit

Set the endpoint, deposit, input, and job cap from the existing authorization. Record the caller's wallet balance and transaction-history checkpoint without logging credentials.

```bash
dvm credit fund "$DVM_ENDPOINT" --amount "$DVM_CREDIT_DEPOSIT" --rail lightning
```

Retain the returned credit and funding IDs. Confirm the exact invoice payment in the caller wallet's own history and the builder wallet's paid-invoice lookup. Match these with the DVM's signed funding record and confirmed credit balance. Reconcile principal, fees, and the observed wallet debit. CLI success alone is not independent settlement evidence.

If the response is pending or lost, keep the original journal and use `dvm credit balance "$DVM_ENDPOINT"` to check recognition. Never create another funding to bypass uncertainty. A later balance read, poll, or job submit causes the service to recognize settlement; there is no background invoice watcher.

Select the returned credit with `dvm credit balance "$DVM_ENDPOINT" --credit-id "$DVM_CREDIT_ID"`. After that balance is confirmed, make one draw from it with a stable request ID:

```bash
dvm request --endpoint "$DVM_ENDPOINT" --data "$DVM_INPUT"   --budget "$DVM_JOB_CAP" --credit-only "$DVM_CREDIT_ID"   --request-id "$DVM_REQUEST_ID" </dev/null
```

`--credit-only` forbids fallback to a fresh payment. Retain the request ID for recovery. Retrieve the job's messages and artifacts, verify the expected result, and run `dvm receipts verify <job-id>`. Compare the before/after credit balance with the settled draw and check that no second Lightning payment occurred.

## Close the test's obligations

Unused credit is still owed to the caller. Follow the caller's documented drain procedure within authorization and operate the builder refund worker. Lightning-funded credit returns as ecash. The worker may need separately authorized spending access to mint that ecash; it does not send a reverse Lightning refund.

Report the funded amount, job charge, fees, remaining credit, and refund status separately. Retain unresolved journals and recovery state. Do not delete the isolated caller profile merely because the job completed.

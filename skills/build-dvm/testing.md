# Test a capability and its payment path

Select the evidence the change needs. Handler tests establish behavior; live provider checks establish an external request contract; a paid call establishes the selected payment path. Do not substitute one for another.

## Before moving value

1. Read the approved price, test rail, and spend cap. A per-call cap does not authorize an arbitrary wallet deposit. Establish any funding amount and provider spend separately if not already approved.
2. Verify the endpoint, advertised capability, network or mint, and payment destination. Read the dev banner. Local execution does not imply fake funds.
3. Isolate the test caller with a fresh `DVM_CONFIG_DIR`. Keep it separate from the builder's recovery material and normal caller wallet. Use the admitted caller CLI version.
4. Run `dvmctl validate`, `dvmctl doctor`, and the project's checks. For a paid upstream API, verify the request shape against the live provider within the authorized spend before selling the capability.

## Select one payment recipe

Load only the recipe needed for the approved test:

| Payment path | Procedure | Boundary |
| --- | --- | --- |
| Cashu per-job | [Cashu test](references/local-cashu-test.md) | Owned or approved hosted FakeWallet mint |
| x402 per-job | [x402 test](references/local-x402-test.md) | Base Sepolia test USDC |
| Tempo per-job | [Tempo test](references/local-tempo-test.md) | Moderato test currency |
| Lightning-funded credit | [Lightning acceptance](references/lightning-credit-test.md) | Durable service and separately approved wallet-backed funds |

The three local per-job recipes use disposable dev state without Postgres. Lightning funds prepaid credit and needs durable storage; do not invent a per-job Lightning test or substitute a production wallet into a fake-money recipe.

Apply the actual approved input and caps to the recipe before running it. Read its prerequisites and cleanup behavior first. Do not automatically increase a cap or change a network to make a refusal disappear.

## Assess the result

Require a terminal job, the expected content, all advertised artifacts, and a verified stored receipt. Verify the rail and amount against the unpaid quote or the selected credit draw. Require independent wallet or chain evidence for the original payment. Receipt verification alone does not establish where value arrived.

A successful test establishes only that endpoint, revision, rail, and network. State those limits in the result. Keep nonsecret evidence needed to reproduce the finding.

On a pending or lost response, keep the caller profile and operation identifiers and continue through [recovery](recovery.md). Cleanup is allowed only after outcomes are known and remaining value is recovered or explicitly disposable. A pending payment journal is recovery material, not a temporary file to delete.

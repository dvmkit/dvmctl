# Deploy or update a DVM

Use this for first deployment and later revisions. Reuse existing authorization; ask only when the target, costs, funds, or destructive effects exceed it.

## Establish the target

Inspect the project's SDK version, handler, build inputs, and deployment configuration. Read the [hosting explanation](https://dvmkit.com/docs/deploying.md) and the [deploy command contract](https://dvmkit.com/docs/cli-dvmctl.md#deploy) for the chosen target.

For Cloud, run `dvmctl auth --status`, `dvmctl orgs`, and `dvmctl whoami`. Select the intended organization with `dvmctl switch` only when needed. If login is missing, follow [authentication](https://dvmkit.com/docs/cli-auth.md); the human completes browser consent. Never create or switch an account merely to get past an access refusal.

For an update, record the existing deployment and inspect outstanding jobs and payment obligations. Preserve their database and keys across the update. Establish the effective resources and costs from the current plan; do not promise an unverified spending cap.

## Prepare keys and payment operations

Builder signing keys, Cashu recovery words, and records live in `~/.dvmkit` (`builder.key`, `builder.mnemonic`, and `builder.json`). Set `DVMKIT_CONFIG_DIR` before inspecting or creating them to select a separate builder tree. Authentication uses `~/.dvmctl` and `DVMCTL_CONFIG_DIR`; caller wallet state uses `~/.dvm` and `DVM_CONFIG_DIR`. Changing the authentication directory does not move builder secrets.

An explicit `DVMKIT_CONFIG_DIR` disables automatic legacy mnemonic migration. If `lock create` or `deploy` names an untouched legacy file, have the human use `dvmctl lock create --import <words>` in a private terminal to reuse those words. To create independent words instead, use `dvmctl lock create --force --human`; the legacy file stays in place. Keep recovery words out of agent output.

A real deployment needs a builder signing identity. Inspect it with `dvmctl identity show`; create one only if absent and authorized. `dvmctl deploy --create-identity` can create the missing identity noninteractively. Never replace an existing identity to bypass an error.

If accepting Cashu, establish the lock identity and recovery backup. When creation is needed, have the human run `dvmctl lock create --human` in a private terminal and save the recovery words. Do not capture the words in agent output. Require explicit confirmation that the backup is complete before accepting production funds.

Read [payments and payouts](https://dvmkit.com/docs/builder-payments.md) and the SDK's [payment environment](https://dvmkit.com/docs/sdk.md#payment-rail-environment-variables) only for the chosen methods. Verify the production network or mints, recipient, and required worker:

- Cashu needs the recovery keys, payout destination, and refund/payout worker.
- Lightning credit needs durable credit storage and a receive-only `DVMKIT_NWC_RECEIVE_URI`. Prepare the separate refund worker; the DVM's receiving connection must not spend.
- Stablecoin channels need settlement and close handling. Self-hosted Tempo sessions need the documented close observer.
- One-payment stablecoin credit needs the explicit opt-in and manual refund process before it is offered.

## Preview and submit

Run project checks, `dvmctl validate`, and `dvmctl doctor`. Preview with `dvmctl deploy --dry-run`; a container preview requires Docker. Resolve failures before a real submission. Do not bypass a dirty-source refusal without an explicit reason and authorization for the exact source being deployed.

A Cloud deployment uploads the DVM folder and nothing above it. When the Dockerfile needs a containing folder, such as a workspace root that holds the lockfile, name that folder in `package.json` as `dvmkit.buildContext` (relative to the DVM folder, for example `"../.."`) or pass `--context`; the folder must contain the DVM folder and stay inside the repository. A DVM without its own lockfile under a repository folder that has one is refused until the context is named. Credential stores such as `.ssh` and `.dvmkit` are never uploaded. Both deploy and dry-run JSON report the uploaded folder as `context_root` and the Dockerfile as `dockerfile`.

For Cloud, supply secret values through a secret manager into `dvmctl deploy --env-stdin` as the documented JSON string map. This option is Cloud-only and is not accepted by dry-run. Do not put secrets in command arguments, source, or logs. Inspect `.env` as an input boundary without printing its values: Cloud deployment reads it too.

Submit the authorized deployment once and retain its deployment ID. For an ambiguous response, inspect `dvmctl deploy-status <id>` and the service before retrying; use [recovery](recovery.md) when the result remains unknown.

For self-hosting, initialize the durable service ID with `dvmctl init <slug> --self-hosted`, then run `dvmctl deploy --target self-host`. Protect any generated attestation and receipt-key values as secrets. Deploy the generated container with the target's tools, configure its durable database and secrets, and operate the required payment workers yourself. Generating these files is not a completed deployment.

## Verify the deployed service

Inspect the actual endpoint, active revision, and health. Read `/v1/info` or `dvm describe` to confirm capability, price, any declared rate card, signing identity, and intended payment configuration. Test the agreed example and retrieve its output.

For a production paid acceptance, follow [testing](testing.md) with the already approved funds and cap. If that scope is absent, report the deployment evidence and the specific paid check still unperformed. Never claim receipt or payout from a successful build alone.

Record the endpoint, deployed revision, validation result, and any pending payment operation. Continue to [operating](operating.md) for earnings and payout work.

# Build a first capability

Use this for a new service or a new capability. For an existing service, inspect its handler, dependencies, and conventions before changing it. Do not scaffold over a populated directory.

## Establish one example

Reuse the supplied brief. Ask only for missing decisions that affect the result: capability name, typed input, expected output, one input-to-result example, and price. Establish external provider costs if the handler will call a paid API. Keep the paid-test cap separate from the service price.

Start with one capability unless the brief needs more. Record the agreed example in the project so validation and the final report use the same expectation. Defer production payment and hosting choices until they are needed by the authorized task.

## Implement the handler

For a new scaffold:

```bash
dvmctl create my-dvm
cd my-dvm
npm install
```

Use the scaffold's pinned SDK. For a handwritten project, pin the SDK version admitted by the installed CLI and skill. Read only the relevant parts of the [SDK reference](https://dvmkit.com/docs/sdk.md): [descriptor](https://dvmkit.com/docs/sdk.md#configuredvm), [input](https://dvmkit.com/docs/sdk.md#input-validation-with-zod), and [job context](https://dvmkit.com/docs/sdk.md#the-job-context).

Implement the agreed input and result. Validate input with the SDK's exported Zod instance. Use the SDK's completion and artifact APIs so callers can retrieve and verify the result. For dynamic pricing, storage, or external side effects, load the corresponding SDK section before selecting an interface. When the price is quoted or tiered, declare a [rate card](https://dvmkit.com/docs/sdk.md#rate-cards) so the storefront and callers' agents see the per-unit rates before quoting.

Keep provider credentials outside committed source. Test the handler's behavior with `createTestContext` before spending on a provider. Mock the external dependency for handler tests, then use a separately authorized live check to prove the provider accepts the actual request shape. A mocked response does not establish that contract.

## Prove the local result

Run the project's tests and typecheck, then:

```bash
dvmctl validate
dvmctl doctor
dvmctl dev handler.ts
```

Read the dev banner before calling it. Payment verification is skipped only when no rail is configured; a configured rail can move real value. Use the printed `/_dev` interface or caller command to run the agreed example. Use `/_dev` when the caller CLI is not installed; the paid-test recipes install their own isolated caller. For an object input, the HTTP request uses `data`; the caller CLI uses `--data`.

Retrieve the terminal result and any advertised artifacts. Compare their contents with the agreed example, not only the command's exit status. If the handler fails, fix it before adding payment complexity.

Report the implemented capability, observed result, and artifact location. Continue to [testing](testing.md) for paid evidence or to [deploying](deploying.md) when those tasks are already authorized.

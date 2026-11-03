# Build a long or work-shaped job

For a capability that asks the caller questions, charges during the job, or runs for a long time. Behavior here is the SDK version this `dvmctl` pins (see the installed `package.json`); a newer SDK may add per-question controls, so check its reference before relying on a limit stated here.

## Ask and charge inside the job

- `ctx.prompt(id, text, { options?, schema? })` pauses until the caller answers and resolves with the response.
- `ctx.requestPayment(amount, reason)` pauses until the ask is covered by the caller's prepaid pool or a payment. A bare number is millisatoshis; `{ amount, currency }` uses major units (`{ amount: 0.25, currency: "usd" }`). For metered work, ask for each increment after the work that earns it.
- Both calls can return only after the job is resumed. The handler body is replayed from the top on resume, so any work above a prompt or payment ask that is not inside `ctx.step` runs again.

Wrap every costly or side-effecting call that comes before a prompt or payment ask:

```ts
const draft = await ctx.step("draft", () => provider.generate(ctx.input));
const answer = await ctx.prompt("approve", "Use this draft?", { options: ["yes", "no"] });
```

A step is cached by id (unique within the job) and runs at least once, not exactly once. For an irreversible action pass `${ctx.jobId}:${stepId}` as the provider's idempotency key. Declare `ctx.cost` only after the step that incurred it. In-memory development stores do not survive a restart, so test replay against Postgres.

## Waiting and timeouts

`idleTimeout` on `configureDVM` is the window, in whole seconds (1 to 604800, default 3600), in which the caller must answer a prompt or pay. It does not limit processing time, which a separate watchdog governs. Raise it for human-in-the-loop work and state the window in the prompt text. Expiry is attributed to the caller. Use `ctx.working()` or `ctx.progress()` during slow phases and honor `ctx.signal`.

## More than one capability

Use `capabilities: { name: { description, input, price, onJob } }` instead of the flat `capability`/`price`/`onJob` fields; the two shapes are mutually exclusive. Names are lowercase letters, digits, and hyphens. List them in `package.json` under `dvmkit.capabilities`. Callers choose with `capability`. Tests should take the capability from `dvm.capabilities` rather than assume a name.

## Price and credit limits

- A static `price` is a USD literal such as `"$0.05"`; omit it for a free capability. A dynamic `onQuote` handler may return an upfront of `0` when the job charges later with `ctx.requestPayment`.
- A new caller's prepaid credit is capped by the caller's trust ladder: $0.50 with no completed receipts, $2 after three, then up to your `credit.max`. Keep the upfront price and `credit.min` (default $0.10) at or below $0.50 for a service first-time callers should reach, and charge the rest mid-job.
- `credit.min` and `credit.max` must be USD literals, with `min` not above `max`.

Verify with the handler tests in [testing](../testing.md); test a prompt or payment path by replaying the job, not by calling `onJob` once.

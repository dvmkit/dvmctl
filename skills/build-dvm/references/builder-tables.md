# Keep builder-owned Postgres tables

For a DVM that stores its own data next to the SDK's tables. Ensure the project has `pg` and the development dependency `@types/pg` before importing `Pool` types.

## Where the pool comes from

The SDK host owns one Postgres pool. `host.pool` exists on the host returned by `createDVMHost()` from `@dvmkit/sdk/server`, and is `undefined` until `host.serve()` has opened the database. `onBoot` is declared on `configureDVM` and receives only the environment, not the pool. It runs after the pool opens and before the listener starts, and an error in it stops boot.

So the handler cannot import a pool. Make it a factory that takes a getter, and wire the host in `serve.ts`:

```ts
// handler.ts
import { configureDVM } from "@dvmkit/sdk";
import { withSdkInitLock } from "@dvmkit/sdk/server";
import type { Pool } from "pg";

export function createHandler(getPool: () => Pool | undefined) {
  return configureDVM({
    name: "My DVM",
    capability: "my-dvm",
    // input, price, onJob ...
    async onBoot() {
      const pool = getPool();
      if (!pool) return;
      await withSdkInitLock(pool, () => pool.query("CREATE TABLE IF NOT EXISTS notes (job_id text PRIMARY KEY, body text NOT NULL)"));
    },
  });
}

// serve.ts
const host = createDVMHost({ database: process.env.DATABASE_URL });
host.mount(createHandler(() => host.pool));
await host.serve();
```

Take `getPool()` inside `onBoot` and `onJob`, never at module load.

## Rules

- Create tables at boot with idempotent DDL under `withSdkInitLock`, which serializes with the SDK's own migrations through one advisory lock. It needs a pool with `max` of at least 2 and fails fast otherwise; the host default is 10. Do not create tables per job.
- Use a table-name prefix that cannot collide with SDK tables, and keep schema changes additive. A redeploy runs `onBoot` again against existing data.
- Parameterize every query. Never build SQL from job input.
- Key rows by `ctx.jobId` so a replayed handler writes the same row; see [work-shaped jobs](work-shaped-jobs.md).
- Do not drop or rewrite SDK tables or end the host's pool.
- Without `DATABASE_URL`, `getPool()` is `undefined`: handle that explicitly. `dvmctl dev` runs the exported descriptor on its own host, whose pool your module cannot see, so test table logic with the handler tests against a disposable database or by serving through your own `serve.ts` with a throwaway `DATABASE_URL`.
- Before deploy, confirm the service has a durable database configured; see [deploying](../deploying.md).

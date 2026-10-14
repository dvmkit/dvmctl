export interface ClosableServer {
  close: () => void | Promise<void>;
}

/**
 * Block until SIGINT/SIGTERM, then gracefully close the server and exit 0.
 *
 * Returns a promise that never resolves on its own, so a long-running command
 * awaiting it never triggers `catchErrors`' resolve-on-promise →
 * `process.exit(0)` teardown (which exists for short-lived wallet commands —
 * see `error-handler.ts`). A throw during server *setup*, before the await,
 * still propagates to `handleError`.
 *
 * `getServer` is a getter rather than a fixed handle so callers that swap the
 * server out (e.g. `dvmctl dev`'s hot reload) always close the live instance.
 */
export function blockUntilShutdown(getServer: () => ClosableServer): Promise<never> {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.resolve(getServer().close()).finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return new Promise<never>(() => {});
}

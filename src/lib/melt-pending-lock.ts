import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DvmError } from "@dvmkit/sdk/internal";
import lockfile from "proper-lockfile";

import { BUILDER_CONFIG_DIR } from "../shared/defaults.ts";

/**
 * Exclude other processes before reading recovery state, through submission and
 * acknowledgement. The canonical DVM id also excludes aliases of the same DVM.
 * proper-lockfile releases on normal exit and signals; after SIGKILL/crash its
 * 5s heartbeat stops and the next invocation reclaims the lock after 30s. Never
 * delete a live lock manually: that could allow a second spend attempt.
 */
export async function withMeltPendingLock<T>(
  dvmId: string,
  fn: () => Promise<T> | T
): Promise<T> {
  mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(dvmId).digest("hex");
  const target = join(BUILDER_CONFIG_DIR, `melt-pending-${key}`);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, { realpath: false, stale: 30_000, update: 5_000 });
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ELOCKED") throw err;
    throw new DvmError(
      "melt_pending_locked",
      "Another process is servicing this DVM's pending melts.",
      "Retry after it finishes. After a crash, allow 30 seconds for the local lock to expire."
    );
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

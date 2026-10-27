import { createHash, randomUUID } from "node:crypto";
import { fchmodSync, closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { DvmError } from "@dvmkit/sdk/internal";

import { privateDirectory } from "./melt-change-custody.ts";

import { BUILDER_CONFIG_DIR } from "../shared/defaults.ts";

/**
 * Exclude other processes before reading recovery state, through submission and
 * acknowledgement. The canonical DVM id also excludes aliases of the same DVM.
 * Only ESRCH on the same host proves death: heartbeat age cannot distinguish
 * a crash from sleep or SIGSTOP. A reused PID deliberately blocks reclamation.
 * Unknown/remote owners and interrupted lock creation require manual clearance.
 * Hostname identifies the machine, so a config directory shared between hosts
 * that report the same hostname is unsupported.
 */
export async function withMeltPendingLock<T>(
  dvmId: string,
  fn: () => Promise<T> | T
): Promise<T> {
  privateDirectory(BUILDER_CONFIG_DIR);
  const key = createHash("sha256").update(dvmId).digest("hex");
  const path = join(BUILDER_CONFIG_DIR, `melt-pending-${key}.lock`);
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() });
  acquire(path, owner);
  try {
    return await fn();
  } finally {
    if (readLock(path) === owner) unlinkSync(path);
  }
}

function locked(path: string, claim?: string): DvmError {
  return new DvmError(
    "melt_pending_locked",
    `Pending melts are locked at ${path}; the owner has not been proven dead.`,
    `Retry after the other run finishes. If this persists, confirm no melt-pending run is active on any host using this directory, then remove ${path}${claim ? ` and ${claim}` : ""} and retry. Never clear a live owner's lock.`
  );
}

function readLock(path: string): string | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) return undefined;
      fchmodSync(fd, 0o600);
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  } catch { return undefined; }
}

function deadLocalOwner(raw: string | undefined): { token: string } | undefined {
  if (!raw) return;
  try {
    const owner = JSON.parse(raw);
    if (!owner || owner.host !== hostname() || !owner.host ||
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2_147_483_647 ||
      typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/.test(owner.token)) return;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (hasCode(error, "ESRCH")) return owner;
    }
  } catch { /* Malformed metadata is not proof of death. */ }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function acquire(path: string, owner: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, owner); fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(BUILDER_CONFIG_DIR, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    const previous = readLock(path);
    const dead = deadLocalOwner(previous);
    if (!dead) throw locked(path);

    // Serialize removal of this exact incarnation. Otherwise two reclaimers
    // could both observe death and the slower one could unlink the new owner.
    // A crash during reclamation leaves this claim for manual clearance.
    const claim = `${path}.reclaim-${dead.token}`;
    let fd: number;
    try {
      fd = openSync(claim, "wx", 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw locked(path, claim);
      throw error;
    }
    try {
      if (readLock(path) !== previous) continue;
      if (!deadLocalOwner(previous)) throw locked(path);
      unlinkSync(path);
    } finally {
      closeSync(fd);
      unlinkSync(claim);
    }
  }
  throw locked(path);
}

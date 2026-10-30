import { homedir } from "os";
import { join } from "path";

/**
 * Root for the consumer CLI's state — wallet mnemonic, proofs, budget, jobs.
 *
 * Defaults to `~/.dvm`. The `DVM_CONFIG_DIR` env override lets an operator
 * run a parallel state tree (e.g. `DVM_CONFIG_DIR=~/.dvm-test`) without
 * touching their real wallet. Resolved once at import time;
 * setting the env after the process boots has no effect.
 */
export const CONFIG_DIR = process.env.DVM_CONFIG_DIR ?? join(homedir(), ".dvm");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/**
 * The single rollback generation retained before a caller-config mutation,
 * mode 0600 like the config itself.
 *
 * Exactly one, never a timestamped series: the file holds the same plaintext
 * `x402.privateKey`, `tempo.apiKey` and `nwcUri` as the live config, so an
 * accumulating set of them would quietly multiply the credential's footprint on
 * disk. A mutation that deliberately removes a credential writes this copy with
 * that field already stripped, so a rollback cannot resurrect a secret the
 * caller just asked to be rid of.
 */
export const CONFIG_BACKUP_FILE = join(CONFIG_DIR, "config.json.bak");
/**
 * Append-only record of which caller-config fields changed, when, and under
 * which command. Mode 0600, JSONL, and deliberately value-free —
 * field *paths* and metadata only, so the trail can never become a second copy
 * of the credentials the config holds.
 */
export const CONFIG_AUDIT_FILE = join(CONFIG_DIR, "config-audit.jsonl");
/**
 * The pinned snapshot slot: a second, *non-rolling* copy taken
 * before a deliberate whole-config replacement — `dvm init` over a configured
 * machine, and later an explicit config reset.
 *
 * It exists because {@link CONFIG_BACKUP_FILE} rolls: the very next ordinary
 * field change overwrites it, so a rollback generation taken by a replacement
 * would be gone within seconds of the script that ran the replacement carrying
 * on. Nothing but an explicit pin or an explicit retirement ever touches this
 * file, and a pin refuses to overwrite an existing one — the older snapshot is
 * the one worth keeping when a destructive command runs twice. Mode 0600.
 */
export const CONFIG_PINNED_FILE = join(CONFIG_DIR, "config.json.pinned");
export const JOBS_FILE = join(CONFIG_DIR, "jobs.json");
/** Owner-only caller request intents used by `dvm request-result`. */
export const REQUEST_INTENTS_DIR = join(CONFIG_DIR, "request-intents");
export const FAVORITES_FILE = join(CONFIG_DIR, "favorites.json");
export const MESSAGES_DIR = join(CONFIG_DIR, "messages");
/**
 * Append-only collection of the DVM-signed job receipts this caller has
 * verified. JSONL rather than JSON because it is the long-lived,
 * exportable record — `jobs.json` is a rewrite-in-place working set that
 * carries the same receipt only for as long as the job record lives here.
 */
export const RECEIPTS_FILE = join(CONFIG_DIR, "receipts.jsonl");
/**
 * Per-DVM prepaid-credit working record: the caller's expected
 * balance, ledger sequence, refill target, and pending-drain bookkeeping for
 * every credit it holds. Mutable JSON keyed by endpoint origin + caller
 * pubkey — the `budget.json` shape, not the receipts collection; the signed
 * evidence lives in `receipts.jsonl`.
 */
export const CREDITS_FILE = join(CONFIG_DIR, "credits.json");
/**
 * Durable caller-side x402 batch-channel state and in-flight signed vouchers.
 * The file is mode 0600 because a persisted voucher is spend authority until
 * the DVM has acknowledged it.
 */
export const X402_CHANNELS_FILE = join(CONFIG_DIR, "x402-channels.json");
/** Durable caller-side TIP-1034 channels and their prepaid-credit bindings. */
export const TEMPO_CHANNELS_FILE = join(CONFIG_DIR, "tempo-channels.json");
/**
 * Cooldown state for caller-side feedback nudges: per-DVM stamps
 * for the last nudge, the last recorded send, and the once-ever first-success
 * nudge, plus the first-run intro stamp. Mode 0600 like the credit store —
 * the caller's own behavioural record, not shared state.
 */
export const FEEDBACK_NUDGES_FILE = join(CONFIG_DIR, "feedback-nudges.json");
/**
 * Legacy pre-split builder mnemonic path under the caller state tree.
 * The builder mnemonic reader migrates it into {@link BUILDER_MNEMONIC_FILE}.
 */
export const RECOVERY_MNEMONIC_FILE = join(CONFIG_DIR, "recovery.mnemonic");
export const WALLET_FILE = join(CONFIG_DIR, "wallet.json");
/**
 * Sibling file holding the agent wallet's BIP-39 mnemonic (mode 0600). The
 * mnemonic stays out of `wallet.json` per §4.6 of the cashu-from-first-
 * principles design note; only its `mnemonic_fingerprint` lives on the
 * wallet record. Mirrors the builder pattern at {@link BUILDER_MNEMONIC_FILE}.
 */
export const AGENT_MNEMONIC_FILE = join(CONFIG_DIR, "wallet.mnemonic");
/**
 * Caller signing identities for descriptor-auth DVMs (tracked change, mode 0600).
 * Stores one or more named secp256k1 keypairs the CLI uses to auto-sign
 * `/v1/job` / `/v1/quote` envelopes for DVMs that advertise
 * `auth: ["secp256k1-schnorr-v2"]` on `/v1/info`.
 */
export const IDENTITIES_FILE = join(CONFIG_DIR, "identities.json");
/** Short-lived encrypted remote-wallet pairing state (mode 0700 directory). */
export const PAIRINGS_DIR = join(CONFIG_DIR, "pairings");
export const BUDGET_FILE = join(CONFIG_DIR, "budget.json");
/**
 * Disk cache for the BTC/USD spot rate. Used by `fetchBtcUsdRate` to amortise
 * the upstream API call across CLI invocations within the 5-minute TTL, and
 * by `dvm doctor` to surface cache freshness.
 */
export const BTC_RATE_FILE = join(CONFIG_DIR, "btc-rate.json");
export const ADMIN_DIR = join(CONFIG_DIR, "admin");
export const PROXY_STATE_FILE = join(ADMIN_DIR, "proxy.json");

// ── Builder CLI (`dvmctl`) ─────────────────────────────────────────────
// `dvm` is the consumer CLI (state under ~/.dvm/); `dvmctl` is the builder
// CLI (state under ~/.dvmkit/). Keeping the two trees separate avoids one
// CLI's state leaking into the other's flows.

/**
 * Root for the builder CLI's state — builder record, builder mnemonic,
 * identity key, pending-melt log.
 *
 * Defaults to `~/.dvmkit`. The `DVMKIT_CONFIG_DIR` env override is the
 * builder-side twin of {@link CONFIG_DIR}'s `DVM_CONFIG_DIR` and
 * of `DVMCTL_CONFIG_DIR` in `src/lib/platform.ts`, so all three state trees
 * can be redirected the same way — which is how the test harness keeps a
 * `vitest` run out of the developer's real `$HOME`. Resolved once
 * at import time; setting the env after the process boots has no effect.
 */
export const BUILDER_CONFIG_DIR = process.env.DVMKIT_CONFIG_DIR ?? join(homedir(), ".dvmkit");
/** An explicit tree must never acquire legacy recovery words through a read. */
export const BUILDER_CONFIG_DIR_EXPLICIT = process.env.DVMKIT_CONFIG_DIR !== undefined;
export const BUILDER_FILE = join(BUILDER_CONFIG_DIR, "builder.json");
/** Current builder Cashu lock-key derivation root (mode 0600). */
export const BUILDER_MNEMONIC_FILE = join(BUILDER_CONFIG_DIR, "builder.mnemonic");
/** Pre-rename builder mnemonic path, retained only as an automatic migration source. */
export const LEGACY_BUILDER_MNEMONIC_FILE = join(BUILDER_CONFIG_DIR, "recovery.mnemonic");
/**
 * Builder identity secp256k1 secret key (32 bytes hex, mode 0600). Sibling to
 * {@link BUILDER_FILE}, whose top-level `identity_pubkey` advertises the
 * matching x-only pubkey. Generated by `dvmctl identity create`; read by
 * `dvmctl deploy` to sign the deploy-time attestation.
 */
export const BUILDER_KEY_FILE = join(BUILDER_CONFIG_DIR, "builder.key");
export const MELT_PENDING_LOG_FILE = join(BUILDER_CONFIG_DIR, "melt-pending.log");
export const DRAIN_PARK_LOG_FILE = join(BUILDER_CONFIG_DIR, "drain-park.log");
/**
 * Per-DVM record of how long `dvmctl melt-pending` has been unable to read a
 * DVM's pending credit drains. One-shot runs keep no memory of each other, so
 * the ceiling on an indefinite melt hold has to survive between them.
 */
export const DRAIN_HOLD_STATE_FILE = join(BUILDER_CONFIG_DIR, "drain-hold.json");
/**
 * Per-DVM record of when `dvmctl melt-pending` last completed a run cleanly.
 * The command is often scheduled — a cron, a launchd job, or the
 * `--watch` daemon `docs/sdk.md` recommends — and a scheduler that stops firing
 * leaves no trace at all: no exit code, no growing log, nothing to notice. This
 * is that trace, so a builder on any host can answer "when did my melt last
 * work?" and alarm on the answer with no platform in the loop.
 */
export const MELT_SUCCESS_FILE = join(BUILDER_CONFIG_DIR, "melt-success.json");

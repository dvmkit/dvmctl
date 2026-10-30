import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { deriveBuilderLockKeypair, DvmError, loadIdentitySecret } from "@dvmkit/sdk/internal";

import { getBuilderMnemonicMigrationHint, readBuilderMnemonic } from "../../lib/builder-mnemonic.ts";
import { feedbackHumanHint } from "../../lib/builder-feedback-nudges.ts";
import {
  attestationEnv,
  buildDeployAttestation,
  deriveSlug,
  readPackageJson,
  requireBuilderIdentity,
} from "../../lib/deploy-attestation.ts";
import { loadProjectEnvironment } from "../../lib/dev-environment.ts";
import { readDeployEnvironmentStdin, redactDeployEnvironmentError } from "../../lib/deploy-environment-stdin.ts";
import { InheritSecretsError, parseInheritSecrets } from "../../lib/inherit-secret-parser.ts";
import { resolveAuth, resolveOrgScope } from "../../lib/platform.ts";
import * as platformClient from "../../lib/platform-client.ts";
import {
  type FeatureManifest,
  FeatureManifestError,
  parseFeatures,
} from "../../builder-platform/capability-manifest.ts";
import type { DvmRuntime, VmConfig } from "../../builder-platform/types.ts";
import { parseVmConfig, VmConfigError } from "../../builder-platform/vm-config.ts";
import {
  getBuilderDvm,
  getSelfHostedBuilderDvm,
  loadIdentityPubkey,
  upsertBuilderDvm,
} from "../../shared/builder-store.ts";
import { DIRTY_SUFFIX, shortSha, splitDirtySha } from "../../shared/git-sha.ts";
import { info, json, progress } from "../../shared/output.ts";
import { dockerfileTemplate } from "./create/templates/shared.ts";
import { createTarball, packagedTreeDirtyPaths, resolveBuildContext } from "./deploy-context.ts";
import { identityCreate } from "./identity.ts";
import { validateManifest } from "./validate.ts";

export { createTarball, resolveBuildContext, TARBALL_EXCLUDES } from "./deploy-context.ts";

export interface DeployOptions {
  target?: "cloud" | "self-host" | "local";
  name?: string;
  human?: boolean;
  runtime?: "container" | "isolate";
  /** Connect-tier upstream URL — required when the builder's plan has
   *  `features.hosts_compute = false`. The platform validates and proxies
   *  `<handle>--<slug>.dvmkit.ai` traffic to this URL. */
  endpointUrl?: string;
  /** Register a locally-running DVM into the local platform (no Fly), pointing
   *  at its localhost URL. Shorthand for `--target local`. */
  local?: boolean;
  /** Localhost URL the local DVM is running at, for `--local` (default
   *  `http://localhost:<PORT from .env, else 3000>`). */
  url?: string;
  /** Validate locally (slug, package.json, vmConfig, Dockerfile build) without contacting the platform. */
  dryRun?: boolean;
  /** Skip the interactive SDK-staleness confirmation prompt and proceed automatically. */
  yes?: boolean;
  /** Create the builder signing identity when absent. */
  createIdentity?: boolean;
  /** Allow a cloud image to be built from packaged files that differ from HEAD. */
  allowDirty?: boolean;
  /** Build context folder relative to the DVM folder, which it must contain. Overrides `package.json#dvmkit.buildContext`. */
  context?: string;
  /** Read a bounded JSON string map from stdin before any deploy work. */
  envStdin?: boolean;
  /** Extra env vars merged on top of .env. */
  extraEnv?: Record<string, string>;
  /** Safe public fields appended to the terminal result by a wrapping command. */
  resultFields?: Record<string, unknown>;
  /** Safe human-readable lines appended to the terminal result by a wrapping command. */
  resultLines?: string[];
  /** Org handle to deploy under, overriding the `dvmctl switch` context. */
  org?: string;
}

/**
 * Deploy a DVM project.
 * @param opts  Deploy options.
 * @param cwd   Project directory. Defaults to `process.cwd()`. Pass an
 *              explicit path when deploying a first-party DVM from outside
 *              its directory.
 */
export async function deploy(opts: DeployOptions, cwd?: string): Promise<void> {
  if (opts.envStdin) {
    const unsupportedMode = opts.dryRun
      ? "dry-run"
      : opts.local || opts.target === "local"
        ? "local"
        : opts.endpointUrl
          ? "connect-tier"
          : opts.target && opts.target !== "cloud"
            ? "self-host"
            : undefined;
    if (unsupportedMode) {
      throw new DvmError(
        "env_stdin_unsupported_target",
        `--env-stdin is not supported for ${unsupportedMode} deployment.`,
        "Use --env-stdin with a cloud compute deployment: dvmctl deploy --target cloud --env-stdin. Remove --env-stdin for this deployment mode."
      );
    }
    // Piped input selects cloud through pickTarget's existing default. The
    // reader rejects terminal input before an interactive target prompt can
    // consume secret-bearing input.
    const stdinEnv = await readDeployEnvironmentStdin();
    const extraEnv = { ...opts.extraEnv, ...stdinEnv };
    const target = opts.target ?? (await pickTarget());
    try {
      return await deploy({ ...opts, envStdin: false, target, extraEnv }, cwd);
    } catch (error) {
      throw redactDeployEnvironmentError(error, stdinEnv);
    }
  }
  cwd ??= process.cwd();

  // Connect-tier deploys (`--endpoint-url`) skip the handler.ts check entirely
  // — the builder hosts their own runtime, so the cwd doesn't need handler
  // source files. They still need a slug (from --name or the dirname).
  if (!opts.endpointUrl) {
    if (!existsSync(resolve(cwd, "handler.ts")) && !existsSync(resolve(cwd, "handler.js"))) {
      throw new Error("No handler.ts or handler.js found. Run this from a DVM project directory.");
    }
  }

  // Pre-flight: lint `package.json#dvmkit` before any platform contact or
  // interactive target prompt. Surfaces the platform-side error
  // verbatim and gates every deploy target — cloud, connect-tier, self-host,
  // dry-run — so a malformed manifest can't slip through any path. Skipped
  // when no package.json exists (self-host deploys without one are valid;
  // the downstream readVmConfig / readInheritSecrets calls tolerate it).
  if (existsSync(resolve(cwd, "package.json"))) {
    validateManifest(cwd);
  }

  if (opts.dryRun) {
    deployDryRun(cwd, opts);
    return;
  }

  if (opts.local || opts.target === "local") {
    await deployLocal(cwd, opts);
    return;
  }

  const target = opts.target ?? (await pickTarget());

  await ensureBuilderIdentity(opts);

  if (target === "cloud") {
    await deployCloud(cwd, opts);
    return;
  }

  deploySelfHost(cwd, opts);
}

async function ensureBuilderIdentity(opts: DeployOptions): Promise<void> {
  if (loadIdentitySecret() !== null) return;
  let create = opts.createIdentity === true;
  if (!create && process.stdin.isTTY) {
    create = await new Promise<boolean>((resolveAnswer) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question("  No builder signing identity exists. Create it now? [y/N] ", (answer) => {
        rl.close();
        resolveAnswer(answer.trim().toLowerCase() === "y");
      });
    });
  }
  if (!create) {
    throw new DvmError(
      "identity_required",
      "No builder identity found.",
      "Run `dvmctl deploy --create-identity` (or `dvmctl identity create`) and re-run the deploy."
    );
  }
  identityCreate({ human: opts.human, quiet: true });
  if (opts.human) info("Builder signing identity created.");
}

// ── Local deploy ─────────────────────────────────────────────

/**
 * Register a locally-running DVM into the local platform as `deployed`,
 * pointing at its localhost URL — no Fly, no plan gating. Closes the
 * deploy→discover→use→dashboard loop locally. Builder identity is optional
 * here (unlike cloud/connect): if an identity exists on disk we sign + send an
 * attestation, otherwise we register without one (mirrors the e2e harness).
 */
async function deployLocal(cwd: string, opts: DeployOptions): Promise<void> {
  const creds = resolveAuth();
  if (!creds) {
    throw new DvmError(
      "auth_required",
      "Not authenticated.",
      "Set DVMKIT_API_KEY (e.g. the seeded `dvmk_aaaa…` key) or run `dvmctl auth`."
    );
  }

  // Local deploys target the local platform by default; DVMKIT_PLATFORM_URL
  // still overrides for non-standard ports.
  const platformUrl = process.env.DVMKIT_PLATFORM_URL ?? "http://localhost:8080";

  const slug = opts.name ?? deriveSlug(cwd);
  if (slug.length < 3) {
    throw new DvmError("invalid_slug", `Slug "${slug}" is too short (min 3 characters).`);
  }
  const name = readDvmName(cwd) ?? slug;

  // Resolve the running DVM's URL: --url / --endpoint-url, else derive from the
  // project's PORT (`dvmctl dev`/`serve` default) or 3000.
  const port = (loadProjectEnvironment(cwd).PORT as string | undefined) ?? "3000";
  const url = opts.url ?? opts.endpointUrl ?? `http://localhost:${port}`;

  // Builder identity is optional on the local path. Sign an attestation only
  // when an identity exists on disk; the platform verifies + persists it.
  //
  // No receipt key here: `--local` registers a process that's
  // *already running*, so there's nothing to provision it into — and this
  // attestation never reaches `/v1/info` either, since the process serves the
  // one it booted with, not the one we send the platform. Establishing an
  // attested receipt key locally is `dvmctl serve --dvm <handle>`'s job;
  // the probe below reports whether the running process did.
  const localDvmId = getSelfHostedBuilderDvm(slug)?.canonical_dvm_id;
  const attestation =
    loadIdentitySecret() !== null && localDvmId != null
      ? buildDeployAttestation(cwd, slug, localDvmId)
      : undefined;

  // Unlike the cloud path, the local path never auto-detects the runtime from
  // the presence of a Dockerfile: a `--local` DVM is just a URL that's already
  // serving, and every SDK-served project (which has no Dockerfile) would
  // otherwise silently flip onto the isolate tier. Container unless asked.
  const runtime = opts.runtime === "isolate" ? "isolate" : "container";

  // Probe the resolved URL up front. The platform's meta-fetch is best-effort
  // and non-fatal, so a wrong/unreachable upstream (e.g. the default :3000
  // hitting the web app when `dev:stack` is up) would otherwise register
  // silently with empty `dvm_meta`. We don't hard-fail — register-before-serve
  // is legitimate — but we make a non-DVM upstream loud.
  const probe = await probeLocalDvm(url, runtime);

  if (opts.human) {
    info(`Registering ${name} as ${slug} [local, ${runtime}]...`);
    info(`  url ${url}`);
    info(`  platform ${platformUrl}`);
    if (!probe.ok) {
      info(`\n  Warning: ${url} does not look like a running DVM (${probe.reason}).`);
      info("  Registering anyway — if this isn't intentional (register-before-serve),");
      info("  pass --url http://localhost:<your-dvm-port>. The default is :3000, which");
      info("  is the web app when `npm run dev:stack` is up, not your DVM.");
    } else if (probe.attestedReceiptKey === false) {
      info("\n  Note: this DVM's receipts are signed but unattested — a caller can check");
      info("  the signature, but nothing vouches for the signing key. To fix, restart it");
      info(`  with: dvmctl serve <handler> --dvm ${slug}`);
    }
  }

  const result = await platformClient.deployLocal(platformUrl, creds.token, {
    slug,
    name,
    url,
    runtime,
    identityPubkey: attestation?.identityPubkey,
    attestationPayload: attestation?.payload,
    attestationSignature: attestation?.signature,
    capabilities: attestation?.capabilities,
    orgHandle: resolveOrgScope(opts) ?? undefined,
  });

  if (opts.human) {
    if (result.status === "suspended") {
      if (result.suspensionReason === "builder_pause") {
        info(
          `\n  Registered, but it remains paused. Run \`dvmctl resume ${slug}\` to bring it back online.`
        );
      } else if (result.suspensionReason === "free_tier_idle") {
        info(
          "\n  Registered, but it remains idle. The next request wakes it automatically; nothing to fix."
        );
      } else {
        const reason = result.suspensionReason ?? "operator";
        const pause = result.paused
          ? ` Your pause is still on record — "${slug}" returns to paused once the suspension is lifted.`
          : "";
        info(
          `\n  Registered, but it remains suspended by the platform (${reason}); \`dvmctl resume\` won't lift it.${pause}`
        );
      }
    } else {
      info(`\n  Registered. Router proxies to ${result.url}`);
    }
    if (result.dvmkitUrl) info(`  Local URL: ${result.dvmkitUrl}`);
    const feedbackHint = feedbackHumanHint({ data: { status: result.status, dvmId: result.dvmId } });
    if (feedbackHint) info(feedbackHint);
    info("");
  } else {
    json({
      status: result.status,
      paused: result.paused,
      suspensionReason: result.suspensionReason,
      url: result.url,
      dvmkitUrl: result.dvmkitUrl,
      slug: result.slug,
      dvmId: result.dvmId,
      runtime,
      // Surfaced so an agent can relay it: the upstream didn't answer its info
      // endpoint like a DVM, so this registration may point at the wrong process.
      warning: probe.ok
        ? undefined
        : `${url} does not look like a running DVM (${probe.reason}). If unintended, re-run with --url http://localhost:<your-dvm-port>.`,
      // tracked change: a caller can only walk a receipt back to this builder's
      // identity when the running process holds a key its own attestation
      // binds. Name the one command that establishes that, since `--local`
      // itself can't — it registers a process that's already booted.
      hint:
        probe.ok && probe.attestedReceiptKey === false
          ? `This DVM's receipts are signed but unattested. Run 'dvmctl init ${slug} --self-hosted', then restart it with 'dvmctl serve <handler> --dvm ${slug}' so its receipts chain to a durable DVM ID.`
          : undefined,
    });
  }
}

/**
 * Probe a `--local` upstream's info endpoint to confirm it's a live DVM before
 * registering it. Mirrors the {@link local upstream probe} probe shape: short
 * timeout, all failures swallowed into a reason string. A real DVM answers with
 * JSON carrying a string `name`; the web app (the default :3000 footgun)
 * returns HTML or a 404 instead. Container DVMs serve `/v1/info`, isolate DVMs
 * `/_isolate/info` — probing the wrong one 404s on a healthy DVM.
 *
 * When the DVM issues receipts, the probe also reports whether the key signing
 * them is attested — that is the difference between a caller who can
 * check a signature and one who can chain it to a builder identity.
 */
export async function probeLocalDvm(
  url: string,
  runtime: DvmRuntime = "container"
): Promise<{ ok: boolean; reason?: string; attestedReceiptKey?: boolean }> {
  const path = runtime === "isolate" ? "/_isolate/info" : "/v1/info";
  try {
    const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, reason: `GET ${url}${path} returned HTTP ${res.status}` };
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return { ok: false, reason: `${path} is not JSON (content-type: ${contentType || "none"})` };
    }
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.name !== "string") {
      return { ok: false, reason: `${path} has no DVM \`name\` field` };
    }
    // Undefined, not `false`, on a DVM that issues no receipts at all — there
    // is no attestation gap to report where there is nothing to attest.
    return { ok: true, attestedReceiptKey: readAttestedReceiptKey(data) };
  } catch (err) {
    return {
      ok: false,
      reason: `${path} unreachable (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Does a probed `/v1/info` describe a DVM whose receipt key is attested?
 * `undefined` when it issues no receipts; `false` when it issues them under a
 * key no `builder.attestation.receipt_pubkey` binds (a dev boot's ephemeral
 * key, or a hand-set `DVMKIT_RECEIPT_KEY`).
 */
function readAttestedReceiptKey(info: Record<string, unknown>): boolean | undefined {
  if (info.receipts !== true) return undefined;
  const builder = info.builder;
  if (!builder || typeof builder !== "object") return false;
  const attestation = (builder as { attestation?: unknown }).attestation;
  if (!attestation || typeof attestation !== "object") return false;
  return typeof (attestation as { receipt_pubkey?: unknown }).receipt_pubkey === "string";
}

// ── Cloud deploy ───────────────────────────────────────────────────────

async function deployCloud(cwd: string, opts: DeployOptions): Promise<void> {
  const creds = resolveAuth();
  if (!creds) {
    throw new DvmError(
      "auth_required",
      "Not authenticated.",
      "Set DVMKIT_API_KEY or run `dvmctl auth`."
    );
  }

  // Builder identity is required for every cloud + connect-tier deploy.
  // Fail fast before tarball construction so a missing identity
  // surfaces as `identity_required` rather than a confusing 401 deep in the
  // upload step. Self-host's own preflight lives inside `deploySelfHost`.
  requireBuilderIdentity();

  const platformUrl = process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev";
  // Same resolution as every read: `--org` first, then the `dvmctl switch`
  // context. A flag that applied to reads but not to deploys would be the
  // tracked change split all over again, one level down.
  const activeOrg = resolveOrgScope(opts) ?? null;

  if (opts.human) info("Verifying credentials...");
  await platformClient.validateAuth(platformUrl, creds.token);

  // Connect-tier: straight to connect flow
  if (opts.endpointUrl) {
    await deployConnect(cwd, opts, platformUrl, creds.token, activeOrg);
    return;
  }

  // Container unless asked. A missing Dockerfile used to select the isolate
  // runtime, which the builder beta doesn't offer; `--runtime isolate` stays
  // for operator accounts, and the platform refuses it for everyone else.
  const hasDockerfile = existsSync(resolve(cwd, "Dockerfile"));
  const runtime = opts.runtime ?? "container";

  if (runtime === "container" && !hasDockerfile) throw missingDockerfileError();

  const slug = opts.name ?? deriveSlug(cwd);
  if (slug.length < 3) {
    throw new DvmError("invalid_slug", `Slug "${slug}" is too short (min 3 characters).`);
  }
  const name = readDvmName(cwd) ?? slug;
  const env = { ...loadProjectEnvironment(cwd), ...(opts.extraEnv ?? {}) };
  const { contextRoot, dockerfilePath } = resolveBuildContext(cwd, opts.context);
  const dirtyPaths = packagedTreeDirtyPaths(contextRoot);
  if (dirtyPaths.length > 0 && !opts.allowDirty) {
    throw new DvmError(
      "dirty_worktree",
      `Cloud deploy refused: the packaged tree at ${contextRoot} has uncommitted changes:\n${dirtyPaths.map((path) => `  ${path}`).join("\n")}`,
      "Commit or discard these paths, or re-run with --allow-dirty only if shipping uncommitted code is intentional. --yes does not bypass this check.",
      { paths: dirtyPaths, packaged_root: contextRoot }
    );
  }
  const tarball = createTarball(contextRoot);
  // Dirtiness is measured against contextRoot, not cwd: the tarball is rooted
  // there, so that's the tree the baked sha is actually claiming.
  const commit = readGitHead(cwd, contextRoot);
  const vmConfig = readVmConfig(cwd);
  const inheritSecrets = readInheritSecrets(cwd);
  const features = readFeatures(cwd);

  if (opts.human) {
    const tier = runtime === "isolate" ? "isolate (handler-only)" : "container";
    info(`Deploying ${name} as ${slug} [${tier}]...`);
    if (activeOrg) {
      info(`  org ${activeOrg}`);
    }
    if (commit) {
      info(`  commit ${shortSha(commit.sha)} (${commit.ref})`);
      if (splitDirtySha(commit.sha).dirty) {
        // Not a prompt: deploying uncommitted work is the normal builder
        // iteration loop. The point is that the image says so too, rather
        // than claiming a commit it doesn't match.
        info(`  Note: uncommitted changes in ${contextRoot} — image will report a -dirty sha`);
      }
    }
    info(`  build context ${contextRoot}${runtime === "container" ? ` (Dockerfile: ${dockerfilePath})` : ""}`);
    if (vmConfig) {
      const mem = vmConfig.memoryMb != null ? `${vmConfig.memoryMb} MB` : "(default)";
      const cpus = vmConfig.cpuCount ?? 1;
      info(`  resources ${mem} / ${cpus} cpu`);
    }
    if (inheritSecrets.length > 0) {
      info(`  inheritSecrets ${inheritSecrets.length} pattern(s)`);
    }
  }

  // Per-DVM lock pubkey. When the builder has a mnemonic on disk
  // (set up via `dvmctl lock create`), derive the per-DVM lock pubkey at
  // `m/1789'/0'/hashed(canonical_dvm_id)'/<rotation_index>'`. On redeploys
  // the canonical_id is already in builder.json, so we pre-compute the
  // pubkey and send it inline with the deploy. The local record is keyed by
  // the selected DVM ID, not its slug, so same-slug DVMs in different orgs
  // retain independent lock identities. On first deploys (no builder.json
  // entry yet) we register it via a follow-up PUT once the platform has
  // handed us the dvmId.
  const mnemonic = readBuilderMnemonic();
  const mnemonicHint = mnemonic ? null : getBuilderMnemonicMigrationHint();
  if (mnemonicHint) {
    if (opts.human) info(`  ${mnemonicHint}`);
    else progress({ event: "warning", code: "legacy_builder_mnemonic", hint: mnemonicHint });
  }
  const scopedDvms = mnemonic
    ? await platformClient.listDvms(platformUrl, creds.token, {
        ...(activeOrg ? { org: activeOrg } : {}),
      })
    : undefined;
  const existingDvm = scopedDvms?.dvms.find((candidate) => candidate.slug === slug);
  const existingBuilderEntry = existingDvm ? getBuilderDvm(existingDvm.id) : undefined;

  // Refuse self_hosted entries: their canonical_dvm_id is a locally-generated
  // UUID that won't match the platform's dvms.id, which would silently
  // persist a mismatched lock_pubkey and break P2PK refund derivation.
  if (existingBuilderEntry?.self_hosted) {
    throw new DvmError(
      "self_hosted_entry_blocks_cloud_deploy",
      `builder.json marks "${slug}" as self_hosted with canonical_dvm_id=${existingBuilderEntry.canonical_dvm_id}, but \`dvmctl deploy\` targets the cloud.`,
      "Delete the entry from ~/.dvmkit/builder.json before cloud-deploying this slug. The cloud deploy will re-derive a fresh lock pubkey from the platform-assigned dvms.id (this retires any proofs locked to the self-hosted pubkey)."
    );
  }

  let preComputedLockPubkey: string | undefined;
  if (mnemonic && existingBuilderEntry) {
    preComputedLockPubkey = deriveBuilderLockKeypair(
      mnemonic,
      existingBuilderEntry.canonical_dvm_id,
      existingBuilderEntry.current_rotation_index
    ).pubkey;
  }

  // The platform has to mint the immutable DVM ID before we can derive the
  // receipt key or sign the attestation. Send only the bound builder pubkey
  // now; the pipeline waits for the ID-bound material below before provisioning.
  const identityPubkey = loadIdentityPubkey();
  if (!identityPubkey) throw new DvmError("identity_required", "Builder identity is missing.");

  const { deployId, dvmId } = await platformClient.startDeploy(platformUrl, creds.token, {
    slug,
    name,
    tarball,
    env,
    runtime,
    commit: commit ?? undefined,
    vmConfig: vmConfig ?? undefined,
    inheritSecrets: inheritSecrets.length > 0 ? inheritSecrets : undefined,
    features: Object.keys(features).length > 0 ? features : undefined,
    dockerfilePath: dockerfilePath === "Dockerfile" ? undefined : dockerfilePath,
    orgHandle: activeOrg ?? undefined,
    lockPubkey: preComputedLockPubkey,
    // First deploy with a mnemonic: no `dvms` row yet, so we can't precompute
    // the per-DVM pubkey inline — we PUT it below once the platform hands us
    // the dvmId. Signal that intent so the deploy pipeline awaits the PUT
    // before injecting.
    expectLockPubkey: Boolean(mnemonic && !existingBuilderEntry),
    expectIdentityFinalization: true,
    identityPubkey,
  });

  // Recovery handle for SSE drops. With this printed up front, the
  // operator (and the next agent invocation) can run
  // `dvmctl deploy-status <id>` to recover state if the CLI is killed.
  if (opts.human) info(`  Deploy queued: ${deployId}`);
  else progress({ event: "queued", deploy_id: deployId });

  const attestation = buildDeployAttestation(cwd, slug, dvmId, { withReceiptKey: true });
  if (!attestation.receiptSecret) {
    throw new DvmError(
      "receipt_identity_missing",
      "Receipt identity finalization produced no receipt secret."
    );
  }
  await platformClient.finalizeDvmDeployIdentity(platformUrl, creds.token, dvmId, {
    deployId,
    identityPubkey: attestation.identityPubkey,
    attestationPayload: attestation.payload,
    attestationSignature: attestation.signature,
    capabilities: attestation.capabilities,
    receiptSecret: attestation.receiptSecret,
  });

  // Belt-and-braces invariant check: on the redeploy path we already shipped
  // a pubkey derived from the cached canonical_dvm_id. If the platform came
  // back with a different dvmId (e.g. builder.json was hand-edited, or the
  // DVM was deleted and re-created server-side), the inline pubkey is wrong.
  // Re-derive against the authoritative dvmId, PUT it, and realign the
  // local cache.
  if (mnemonic && existingBuilderEntry && existingBuilderEntry.canonical_dvm_id !== dvmId) {
    const { pubkey } = deriveBuilderLockKeypair(
      mnemonic,
      dvmId,
      existingBuilderEntry.current_rotation_index
    );
    await platformClient.setDvmLockPubkey(platformUrl, creds.token, dvmId, pubkey);
    upsertBuilderDvm(dvmId, {
      handle: slug,
      canonical_dvm_id: dvmId,
      current_rotation_index: existingBuilderEntry.current_rotation_index,
    });
    preComputedLockPubkey = pubkey;
    if (opts.human) {
      info(
        `  Realigned lock pubkey: platform canonical_dvm_id (${dvmId}) differed from cached value (${existingBuilderEntry.canonical_dvm_id}).`
      );
    }
  }

  // First-deploy path: register the per-DVM pubkey now that we know the
  // dvmId. `runDeployPipeline` runs concurrently and reads `dvms.lock_pubkey`
  // to inject `DVMKIT_CASHU_LOCK_PUBKEY`; the `expectLockPubkey` flag sent
  // above makes that read await this PUT, so the first deploy advertises
  // Cashu without a redeploy.
  if (mnemonic && !existingBuilderEntry) {
    const { pubkey } = deriveBuilderLockKeypair(mnemonic, dvmId, 0);
    await platformClient.setDvmLockPubkey(platformUrl, creds.token, dvmId, pubkey);
    upsertBuilderDvm(dvmId, {
      handle: slug,
      canonical_dvm_id: dvmId,
      current_rotation_index: 0,
    });
    if (opts.human) info(`  Per-DVM lock pubkey registered: ${pubkey}`);
  } else if (mnemonic && opts.human && preComputedLockPubkey) {
    info(`  Per-DVM lock pubkey: ${preComputedLockPubkey}`);
  } else if (!mnemonic && opts.human) {
    info(
      "  Note: no recovery mnemonic on disk — DVM will deploy without a per-DVM lock pubkey. Run `dvmctl lock create` and redeploy to enable cashu accumulator mode."
    );
  }

  const result = await platformClient.streamDeployLogs(platformUrl, creds.token, deployId, {
    onLog: (line) => {
      if (opts.human) info(`  ${line}`);
      else progress({ event: "log", line });
    },
    onPhase: ({ status, elapsedMs }) => {
      if (opts.human) info(`  ${status}... (${fmtElapsed(elapsedMs)})`);
      else progress({ event: "phase", phase: status, elapsed_ms: elapsedMs });
    },
    onAccepted: (release) => {
      if (opts.human) {
        info(`  Fly accepted deploy ${release.deployId}; verifying the running DVM...`);
      } else {
        progress({
          event: "release_accepted",
          deploy_id: release.deployId,
          url: release.url,
          ...(release.commitSha ? { commit_sha: release.commitSha } : {}),
        });
      }
    },
  });
  const verificationUrl = `${result.url.replace(/\/$/, "")}/healthz`;
  const verificationHint =
    result.status === "deployed_unverified"
      ? `Run \`curl -s ${verificationUrl}\` and ${commit ? `confirm \`gitSha\` is \`${commit.sha}\`` : "read the served `gitSha`"}.`
      : undefined;

  if (opts.human) {
    info(
      result.status === "deployed_unverified"
        ? `\n  Fly accepted deploy ${deployId}, but metadata verification did not complete.`
        : `\n  Deployed to ${result.url}`
    );
    if (verificationHint) info(`  Check: ${verificationHint}`);
    if (result.dvmkitUrl) {
      info(`  Public URL: ${result.dvmkitUrl}`);
    }
    for (const line of opts.resultLines ?? []) info(`  ${line}`);
    const feedbackHint = feedbackHumanHint({ data: { status: result.status, dvmId } });
    if (feedbackHint) info(feedbackHint);
    info("");
  } else {
    json({
      status: result.status,
      deploy_id: deployId,
      url: result.url,
      dvmkitUrl: result.dvmkitUrl,
      slug,
      dvmId,
      context_root: contextRoot,
      ...(mnemonicHint ? { mnemonic_hint: mnemonicHint } : {}),
      dockerfile: runtime === "container" ? dockerfilePath : undefined,
      ...(verificationHint
        ? {
            outcome: "partial_success",
            display: `Fly accepted deploy ${deployId}; only post-deploy metadata verification failed.`,
            hint: verificationHint,
            verification_url: verificationUrl,
            ...(commit ? { expected_git_sha: commit.sha } : {}),
          }
        : {}),
      ...opts.resultFields,
    });
  }
}

/**
 * Connect-tier deploy. The platform doesn't run the build, so we skip the
 * tarball + dockerfile + runtime detection entirely and just register the
 * builder-supplied endpoint URL. Slug still derives from `--name` or cwd
 * dirname so the marketplace handle stays meaningful.
 */
async function deployConnect(
  cwd: string,
  opts: DeployOptions,
  platformUrl: string,
  token: string,
  activeOrg: string | null
): Promise<void> {
  const slug = opts.name ?? deriveSlug(cwd);
  if (slug.length < 3) {
    throw new DvmError("invalid_slug", `Slug "${slug}" is too short (min 3 characters).`);
  }
  const name = readDvmName(cwd) ?? slug;
  const commit = readGitHead(cwd);

  if (opts.human) {
    info(`Registering ${name} as ${slug} [connect]...`);
    info(`  endpoint ${opts.endpointUrl}`);
    if (activeOrg) {
      info(`  org ${activeOrg}`);
    }
    if (commit) {
      info(`  commit ${shortSha(commit.sha)} (${commit.ref})`);
    }
  }

  const identityPubkey = loadIdentityPubkey();
  if (!identityPubkey) throw new DvmError("identity_required", "Builder identity is missing.");

  const { deployId, dvmId } = await platformClient.startDeploy(platformUrl, token, {
    slug,
    name,
    commit: commit ?? undefined,
    endpointUrl: opts.endpointUrl,
    orgHandle: activeOrg ?? undefined,
    expectIdentityFinalization: true,
    identityPubkey,
  });

  if (opts.human) info(`  Deploy queued: ${deployId}`);
  else progress({ event: "queued", deploy_id: deployId });

  const attestation = buildDeployAttestation(cwd, slug, dvmId, { withReceiptKey: true });
  if (!attestation.receiptSecret) {
    throw new DvmError(
      "receipt_identity_missing",
      "Receipt identity finalization produced no receipt secret."
    );
  }
  await platformClient.finalizeDvmDeployIdentity(platformUrl, token, dvmId, {
    deployId,
    identityPubkey: attestation.identityPubkey,
    attestationPayload: attestation.payload,
    attestationSignature: attestation.signature,
    capabilities: attestation.capabilities,
    receiptSecret: attestation.receiptSecret,
  });

  const result = await platformClient.streamDeployLogs(platformUrl, token, deployId, {
    onLog: (line) => {
      if (opts.human) info(`  ${line}`);
      else progress({ event: "log", line });
    },
    onPhase: ({ status, elapsedMs }) => {
      if (opts.human) info(`  ${status}... (${fmtElapsed(elapsedMs)})`);
      else progress({ event: "phase", phase: status, elapsed_ms: elapsedMs });
    },
  });

  if (opts.human) {
    info(`\n  Registered. Proxying to ${result.url}`);
    if (result.dvmkitUrl) {
      info(`  Public URL: ${result.dvmkitUrl}`);
    }
    if (attestation.receiptSecret) {
      info("");
      info("  Signed receipts — set this secret on your endpoint and restart:");
      for (const [key, value] of Object.entries(attestationEnv(attestation))) {
        info(`    ${key}=${value}`);
      }
      info("  Until it's set, jobs complete normally but carry no receipt.");
    }
    const feedbackHint = feedbackHumanHint({ data: { status: "deployed", dvmId } });
    if (feedbackHint) info(feedbackHint);
    info("");
  } else {
    json({ status: "deployed", url: result.url, dvmkitUrl: result.dvmkitUrl, slug, dvmId });
  }
}

// ── Dry-run validation ─────────────────────────────────────────────────

/**
 * Validate the project locally — slug, package.json, vmConfig, inheritSecrets,
 * and Dockerfile build — without contacting the platform. Used to gate cloud
 * deploys behind a fast local check (and as a CI smoke test for DVMs).
 *
 * Connect-tier (`--endpointUrl`) deploys skip the Dockerfile build and only
 * validate the slug and package.json metadata.
 */
function deployDryRun(cwd: string, opts: DeployOptions): void {
  const slug = opts.name ?? deriveSlug(cwd);
  if (slug.length < 3) {
    throw new DvmError("invalid_slug", `Slug "${slug}" is too short (min 3 characters).`);
  }
  const name = readDvmName(cwd) ?? slug;
  const vmConfig = readVmConfig(cwd);
  const inheritSecrets = readInheritSecrets(cwd);

  const isConnect = Boolean(opts.endpointUrl);
  const hasDockerfile = existsSync(resolve(cwd, "Dockerfile"));
  const runtime = opts.runtime ?? "container";

  let dockerBuilt = false;
  let dockerfilePath: string | undefined;
  let contextRoot: string | undefined;
  if (!isConnect) {
    if (runtime === "container" && !hasDockerfile) throw missingDockerfileError();
    // Every non-connect deploy uploads the context, so the isolate runtime reports it too.
    const context = resolveBuildContext(cwd, opts.context);
    contextRoot = context.contextRoot;
    if (runtime === "container") dockerfilePath = context.dockerfilePath;
  }
  if (contextRoot && dockerfilePath) {
    const buildDockerfilePath = dockerfilePath;
    const buildRoot = contextRoot;
    try {
      withDeployBuildContext(buildRoot, (buildContext) => {
        execFileSync(
          "docker",
          ["build", "-q", "-f", resolve(buildContext, buildDockerfilePath), buildContext],
          {
            // The scaffold Dockerfile carries a `# syntax` directive, which only
            // parses under BuildKit. Force it on for engines still defaulting to
            // the legacy builder.
            env: { ...process.env, DOCKER_BUILDKIT: "1" },
            stdio: opts.human ? "inherit" : ["ignore", "ignore", "ignore"],
          }
        );
      });
      dockerBuilt = true;
    } catch (err) {
      throw new DvmError(
        "docker_build_failed",
        `docker build failed: ${err instanceof Error ? err.message : String(err)}`,
        "Ensure Docker is running and the Dockerfile builds locally."
      );
    }
  }

  if (opts.human) {
    info(`Dry-run for ${name} (${slug}) [${isConnect ? "connect" : runtime}]: ok`);
    if (vmConfig) {
      const mem = vmConfig.memoryMb != null ? `${vmConfig.memoryMb} MB` : "(default)";
      info(`  resources ${mem} / ${vmConfig.cpuCount ?? 1} cpu`);
    }
    if (inheritSecrets.length > 0) {
      info(`  inheritSecrets ${inheritSecrets.length} pattern(s)`);
    }
    if (contextRoot) info(`  build context ${contextRoot}`);
    if (dockerBuilt) info(`  docker build ok (${dockerfilePath ?? "Dockerfile"})`);
  } else {
    json({
      status: "dry-run-ok",
      slug,
      name,
      runtime: isConnect ? "connect" : runtime,
      docker_built: dockerBuilt,
      dockerfile: dockerfilePath,
      context_root: contextRoot,
      vm_config: vmConfig,
      inherit_secrets: inheritSecrets.length > 0 ? inheritSecrets : undefined,
    });
  }
}

// ── Self-host deploy ───────────────────────────────────────────────────

function deploySelfHost(cwd: string, opts: DeployOptions): void {
  if (!existsSync(resolve(cwd, "Dockerfile"))) {
    writeFileSync(resolve(cwd, "Dockerfile"), dockerfileTemplate(), "utf-8");
  }

  // Self-host attestation. No platform binding, but the operator
  // still gets a cryptographic "this DVM was deployed by the holder of this
  // private key" surface on /v1/info. The SDK server reads the three env
  // vars uniformly across host modes, so we print them here for the operator
  // to wire into their `docker run -e …` or compose file.
  requireBuilderIdentity();
  const slug = opts.name ?? deriveSlug(cwd);
  const dvmId = getSelfHostedBuilderDvm(slug)?.canonical_dvm_id;
  if (!dvmId) {
    throw new DvmError(
      "durable_dvm_identity_required",
      `No durable DVM ID is recorded for "${slug}".`,
      `For a DVM you host yourself and have never initialized here, \`dvmctl init ${slug} --self-hosted\` records one. If this handle was deployed to the platform, that command refuses by design and the durable ID is already on the machine that deployed it — generate the receipt material there rather than minting a second identity here.`
    );
  }
  const attestation = buildDeployAttestation(cwd, slug, dvmId, { withReceiptKey: true });
  const envVars = attestationEnv(attestation);

  if (opts.human) {
    console.log("\n  Dockerfile ready.\n");
    console.log("  Builder identity attestation — set these on your container:");
    for (const [key, value] of Object.entries(envVars)) {
      console.log(`    ${key}=${value}`);
    }
    console.log("");
    if (attestation.receiptSecret) {
      console.log(
        "  DVMKIT_RECEIPT_KEY signs job receipts — treat it as a secret (a container\n" +
          "  secret / secrets manager, not a committed compose file). It re-derives from\n" +
          "  your builder identity, so you never need to back it up separately.\n"
      );
    }
    console.log("  Build and run:");
    console.log("    docker build -t my-dvm .");
    console.log(
      `    docker run -p 8080:8080 \\\n      -e DVMKIT_BUILDER_PUBKEY=... \\\n      -e DVMKIT_BUILDER_ATTESTATION='...' \\\n      -e DVMKIT_BUILDER_SIGNATURE=... \\\n      -e DVMKIT_RECEIPT_KEY=... \\\n      my-dvm\n`
    );
  } else {
    console.log(
      JSON.stringify({
        status: "ready",
        file: "Dockerfile",
        target: "self-host",
        attestation_env: envVars,
      })
    );
  }
}

// ── Helpers (exported for testing) ─────────────────────────────────────

/**
 * Read the `dvmkit` field from package.json and parse it into a VmConfig.
 * Returns null when the field is absent. Delegates parsing to the platform's
 * parseVmConfig (single source of truth for bounds and schema), translating
 * VmConfigError to DvmError so the CLI error surface is consistent.
 */
export function readVmConfig(cwd: string): VmConfig | null {
  const pkg = readPackageJson(cwd);
  if (pkg?.dvmkit == null) return null;
  try {
    return parseVmConfig(pkg.dvmkit);
  } catch (err) {
    if (err instanceof VmConfigError) {
      throw new DvmError(
        "invalid_dvmkit_config",
        `Invalid \`dvmkit\` field in package.json: ${err.message}`,
        "Check your package.json and try again."
      );
    }
    throw err;
  }
}

/**
 * Read `dvmkit.inheritSecrets` from package.json. Returns an empty array when
 * the field is absent. Validates locally so a malformed manifest fails fast
 * before tarball upload; the platform re-validates on the server side.
 */
export function readInheritSecrets(cwd: string): string[] {
  const pkg = readPackageJson(cwd);
  const dvmkit = pkg?.dvmkit;
  if (dvmkit == null || typeof dvmkit !== "object") return [];
  const raw = (dvmkit as { inheritSecrets?: unknown }).inheritSecrets;
  try {
    return parseInheritSecrets(raw);
  } catch (err) {
    if (err instanceof InheritSecretsError) {
      throw new DvmError(
        "invalid_dvmkit_config",
        `Invalid \`dvmkit.inheritSecrets\` in package.json: ${err.message}`,
        "Check your package.json and try again."
      );
    }
    throw err;
  }
}

/**
 * Read `dvmkit.features` from package.json — the optional-feature manifest.
 * Returns an empty manifest when the field is absent. Validates
 * locally so a malformed manifest fails fast before tarball upload; the
 * platform re-validates and reconciles it against the deploy's forwarded
 * secrets at deploy time.
 */
export function readFeatures(cwd: string): FeatureManifest {
  const pkg = readPackageJson(cwd);
  const dvmkit = pkg?.dvmkit;
  if (dvmkit == null || typeof dvmkit !== "object") return {};
  const raw = (dvmkit as { features?: unknown }).features;
  try {
    return parseFeatures(raw);
  } catch (err) {
    if (err instanceof FeatureManifestError) {
      throw new DvmError(
        "invalid_dvmkit_config",
        `Invalid \`dvmkit.features\` in package.json: ${err.message}`,
        "Check your package.json and try again."
      );
    }
    throw err;
  }
}

function missingDockerfileError(): DvmError {
  return new DvmError(
    "missing_dockerfile",
    "No Dockerfile found. The dvmkit builder beta hosts DVMs as containers only, so a cloud deploy needs a Dockerfile at the project root.",
    "`dvmctl create` scaffolds a container project with a Dockerfile and the server entry it builds. Scaffold one, move your handler into it, commit, and deploy from there."
  );
}

function readDvmName(cwd: string): string | null {
  return readPackageJson(cwd)?.name ?? null;
}

/**
 * Materialize precisely the archive uploaded by a cloud deploy for a local
 * Docker build. Docker then applies the archived project's `.dockerignore`
 * (including Dockerfile-specific ignore files) in its normal way.
 *
 * The callback form makes the temporary context impossible to retain after a
 * successful or failed dry-run build.
 */
export function withDeployBuildContext<T>(cwd: string, build: (contextDir: string) => T): T {
  const workspaceDir = mkdtempSync(join(tmpdir(), "dvmkit-deploy-context-"));
  const contextDir = join(workspaceDir, "context");
  const archivePath = join(workspaceDir, "input.tar.gz");
  try {
    mkdirSync(contextDir);
    writeFileSync(archivePath, createTarball(cwd));
    execFileSync("tar", ["xzf", archivePath, "-C", contextDir], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    rmSync(archivePath, { force: true });
    return build(contextDir);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

/** Commit metadata captured from the local git HEAD at deploy time. */
export interface LocalGitCommit {
  /** HEAD sha, suffixed with {@link DIRTY_SUFFIX} when the packaged tree differed from it. */
  sha: string;
  ref: string;
  message: string;
  /** Display name from `git log %an` — not a GitHub login. */
  authorName: string | null;
}

/** True when packaged working-tree files differ from HEAD. */
export function isPackagedTreeDirty(packagedRoot: string): boolean {
  return packagedTreeDirtyPaths(packagedRoot).length > 0;
}

/**
 * Read HEAD metadata from a git working directory.
 * Returns null if `cwd` is not a git repo or `git` is not on PATH.
 * On a detached HEAD, the `ref` field falls back to `"HEAD"`.
 *
 * Pass `packagedRoot` (the tarball's context root) to have the returned sha
 * marked when that tree doesn't match HEAD. Omit it where no tarball is built
 * — the connect tier registers a builder-hosted URL, so there is no artifact
 * for the sha to misdescribe.
 */
export function readGitHead(cwd: string, packagedRoot?: string): LocalGitCommit | null {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] })
        .toString("utf8")
        .trim();
    } catch {
      return null;
    }
  };

  const sha = run(["rev-parse", "HEAD"]);
  if (!sha) return null;

  const message = run(["log", "-1", "--pretty=format:%s", "HEAD"]);
  if (!message) return null;

  const ref = run(["symbolic-ref", "--short", "-q", "HEAD"]) ?? "HEAD";
  const authorName = run(["log", "-1", "--pretty=format:%an", "HEAD"]);
  const dirty = packagedRoot != null && isPackagedTreeDirty(packagedRoot);

  return {
    sha: dirty ? `${sha}${DIRTY_SUFFIX}` : sha,
    ref,
    message,
    authorName: authorName && authorName.length > 0 ? authorName : null,
  };
}

/** Format milliseconds as `m:ss` for human-mode phase ticks. */
export function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function pickTarget(): Promise<"cloud" | "self-host"> {
  if (!process.stdin.isTTY) {
    return "cloud";
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => {
    console.log("\n  Where do you want to deploy?\n");
    console.log("    1. dvmkit Cloud (recommended)");
    console.log("    2. Self-host (generates Dockerfile)\n");
    rl.question("  Choice [1]: ", (a) => {
      rl.close();
      res(a.trim());
    });
  });

  return answer === "2" ? "self-host" : "cloud";
}

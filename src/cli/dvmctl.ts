import { registerBillingCommands } from "../commands/builder/billing.ts";

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { randomTraceId } from "@dvmkit/sdk/internal";
import { Command } from "commander";

import type { ApiKeysCreateOptions } from "../commands/builder/api-keys-create.ts";
import { apiKeysCreate } from "../commands/builder/api-keys-create.ts";
import type { ApiKeysListOptions } from "../commands/builder/api-keys-list.ts";
import { apiKeysList } from "../commands/builder/api-keys-list.ts";
import type { ApiKeysRevokeOptions } from "../commands/builder/api-keys-revoke.ts";
import { apiKeysRevoke } from "../commands/builder/api-keys-revoke.ts";
import type { AuthOptions } from "../commands/builder/auth.ts";
import { auth } from "../commands/builder/auth.ts";
import type {
  BlockedInvoicesOptions,
  ReconcileInvoiceOptions,
  WriteOffInvoiceOptions,
} from "../commands/builder/blocked-invoices.ts";
import {
  blockedInvoices,
  reconcileInvoice,
  writeOffInvoice,
} from "../commands/builder/blocked-invoices.ts";
import { contentHolds, type ContentHoldOptions } from "../commands/builder/content-holds.ts";
import type { CreateOptions } from "../commands/builder/create.ts";
import { create } from "../commands/builder/create.ts";
import { creditLiability, type CreditLiabilityOptions } from "../commands/builder/credit-liability.ts";
import { refund, type RefundOptions } from "../commands/builder/refund.ts";
import type { DbConnectOptions } from "../commands/builder/db-connect.ts";
import { dbConnect } from "../commands/builder/db-connect.ts";
import type { DbProxyOptions } from "../commands/builder/db-proxy.ts";
import { dbProxy } from "../commands/builder/db-proxy.ts";
import type { DeployOptions } from "../commands/builder/deploy.ts";
import { deploy } from "../commands/builder/deploy.ts";
import type { DeployStatusOptions } from "../commands/builder/deploy-status.ts";
import { deployStatus } from "../commands/builder/deploy-status.ts";
import type { DestroyOptions } from "../commands/builder/destroy.ts";
import { destroy } from "../commands/builder/destroy.ts";
import type { BuilderDoctorOptions } from "../commands/builder/doctor.ts";
import { builderDoctor } from "../commands/builder/doctor.ts";
import { domains } from "../commands/builder/domains.ts";
import type { EnvOptions } from "../commands/builder/env.ts";
import { env } from "../commands/builder/env.ts";
import type { EventsOptions } from "../commands/builder/events.ts";
import { events } from "../commands/builder/events.ts";
import type {
  FeedbackDisableOptions,
  FeedbackEnableOptions,
  FeedbackListOptions,
} from "../commands/builder/feedback.ts";
import { feedbackDisable, feedbackEnable, feedbackList } from "../commands/builder/feedback.ts";
import { feedbackPostureCommand, feedbackSend, type FeedbackSendOptions, type FeedbackPostureOptions } from "../commands/builder/feedback-send.ts";
import { handle, handleCheck } from "../commands/builder/handle.ts";
import type { IdentityCreateOptions, IdentityShowOptions } from "../commands/builder/identity.ts";
import { identityCreate, identityShow } from "../commands/builder/identity.ts";
import type { InfoOptions } from "../commands/builder/info.ts";
import { dvmInfo } from "../commands/builder/info.ts";
import type { InitOptions } from "../commands/builder/init.ts";
import { init } from "../commands/builder/init.ts";
import type { ListOptions } from "../commands/builder/list.ts";
import { list } from "../commands/builder/list.ts";
import type { LockCreateOptions } from "../commands/builder/lock.ts";
import { lockCreate } from "../commands/builder/lock.ts";
import type { LogsOptions } from "../commands/builder/logs.ts";
import { logs } from "../commands/builder/logs.ts";
import type { DrainSettleOptions, DrainsOwedOptions } from "../commands/builder/manual-drains.ts";
import { drainSettle, drainsOwed } from "../commands/builder/manual-drains.ts";
import type { MeltPendingOptions } from "../commands/builder/melt-pending.ts";
import { meltPending } from "../commands/builder/melt-pending.ts";
import type { MeltStatusOptions } from "../commands/builder/melt-status.ts";
import { meltStatus } from "../commands/builder/melt-status.ts";
import type { MetricsOptions } from "../commands/builder/metrics.ts";
import { metrics } from "../commands/builder/metrics.ts";
import type { OrgsOptions } from "../commands/builder/orgs.ts";
import { orgs } from "../commands/builder/orgs.ts";
import type { PauseOptions } from "../commands/builder/pause.ts";
import { pause } from "../commands/builder/pause.ts";
import type { RestartOptions } from "../commands/builder/restart.ts";
import { restart } from "../commands/builder/restart.ts";
import type { ResumeOptions } from "../commands/builder/resume.ts";
import { resume } from "../commands/builder/resume.ts";
import type { RevenueCsvOptions } from "../commands/builder/revenue-csv.ts";
import { revenueCsv } from "../commands/builder/revenue-csv.ts";
import type { RevenueEventsOptions } from "../commands/builder/revenue-events.ts";
import { revenueEvents } from "../commands/builder/revenue-events.ts";
import type { RevenueSummaryOptions } from "../commands/builder/revenue-summary.ts";
import { revenueSummary } from "../commands/builder/revenue-summary.ts";
import type { RollbackOptions } from "../commands/builder/rollback.ts";
import { rollback } from "../commands/builder/rollback.ts";
import type { RotateOptions } from "../commands/builder/rotate.ts";
import { rotate } from "../commands/builder/rotate.ts";
import type { ScaleOptions } from "../commands/builder/scale.ts";
import { scale } from "../commands/builder/scale.ts";
import type { SecretsListOptions } from "../commands/builder/secrets-list.ts";
import { secretsList } from "../commands/builder/secrets-list.ts";
import type { BuilderServeOptions } from "../commands/builder/serve.ts";
import type { SetPayoutOptions } from "../commands/builder/set-payout.ts";
import { setPayout } from "../commands/builder/set-payout.ts";
import type { SshOptions } from "../commands/builder/ssh.ts";
import { ssh } from "../commands/builder/ssh.ts";
import type { StatusOptions } from "../commands/builder/status.ts";
import { status } from "../commands/builder/status.ts";
import type { SwitchOptions } from "../commands/builder/switch.ts";
import { switchCmd } from "../commands/builder/switch.ts";
import type {
  TempoLossesOptions,
  TempoReconcileOptions,
  TempoWedgedOptions,
  TempoWriteOffOptions,
} from "../commands/builder/tempo-drains.ts";
import {
  tempoLosses,
  tempoReconcile,
  tempoWedged,
  tempoWriteOff,
} from "../commands/builder/tempo-drains.ts";
import {
  tempoCloseReports,
  tempoCloseReportRetry,
  tempoCloseReportWriteOff,
  type TempoCloseReportsOptions,
  type TempoCloseReportActionOptions,
} from "../commands/builder/tempo-close-reports.ts";
import type { TraceGetOptions } from "../commands/builder/trace-get.ts";
import { traceGet } from "../commands/builder/trace-get.ts";
import type { TransferOptions } from "../commands/builder/transfer.ts";
import { transfer } from "../commands/builder/transfer.ts";
import type { ValidateOptions } from "../commands/builder/validate.ts";
import { validate } from "../commands/builder/validate.ts";
import type { WhoamiOptions } from "../commands/builder/whoami.ts";
import { whoami } from "../commands/builder/whoami.ts";
import type {
  X402ExactReconcileOptions,
  X402ExactWedgedOptions,
} from "../commands/builder/x402-exact-settlements.ts";
import { x402ExactReconcile, x402ExactWedged } from "../commands/builder/x402-exact-settlements.ts";
import type {
  X402ReconcileOptions,
  X402WedgedOptions,
  X402WriteOffOptions,
} from "../commands/builder/x402-settlements.ts";
import { x402Reconcile, x402Wedged, x402WriteOff } from "../commands/builder/x402-settlements.ts";
import type { DevOptions } from "../commands/dev.ts";
import { catchErrors } from "../lib/error-handler.ts";
import { setFeedbackCommand } from "../lib/builder-feedback-nudges.ts";
import { installGlobalAcceptEncoding } from "../lib/http.ts";
import { CLI_VERSION } from "../lib/version.ts";
import { setOutputTraceId } from "../shared/output.ts";

/** Build the fully-configured `dvmctl` commander program without parsing argv. Importing this module has no side effects; the CLI parse and trace-ID seeding happen only when the file is executed directly (see entrypoint guard at the bottom). */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("dvmctl")
    .description("Builder CLI for creating and deploying DVMs")
    .version(CLI_VERSION);
  program.hook("preAction", (_root, action) => {
    const parent = action.parent?.name();
    setFeedbackCommand(parent === "feedback" ? `feedback ${action.name()}` : action.name(), Boolean(action.opts().human));
  });

  program
    .command("create <name>")
    .description("Scaffold a new DVM project")
    .option("--price <price>", "Static price (default: $0.01)")
    .option("--name <name>", "DVM display name (default: derived from directory)")
    .option("--description <text>", "DVM description")
    .action((dir: string, opts: CreateOptions) => {
      catchErrors(() => create(dir, opts));
    });

  program
    .command("init <handle>")
    .description(
      "Bootstrap a self-hosted DVM: generate a canonical_dvm_id and persist it to ~/.dvmkit/builder.json"
    )
    .option(
      "--self-hosted",
      "Mark the DVM as self-hosted (required — platform-hosted DVMs get their canonical_dvm_id at deploy time)"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((handle: string, opts: InitOptions) => {
      catchErrors(() => {
        init(handle, opts);
      }, opts.human);
    });

  program
    .command("dev <handler>")
    .description("Start a local development server for a DVM handler")
    .option("--port <port>", "HTTP port (default: PORT from .env or 3000)")
    .option("--no-reload", "Disable hot reload on file changes")
    .option("--human", "Human-readable errors instead of JSON")
    .action((handler: string, opts: DevOptions) => {
      // Lazy: `dev` drags in the dev bundler (esbuild/tsx) and SDK server runtime; keep it
      // out of the entrypoint's import graph until the command actually runs.
      catchErrors(async () => {
        const { dev } = await import("../commands/dev.ts");
        await dev(handler, opts);
      }, opts.human);
    });

  program
    .command("deploy")
    .description("Deploy a DVM project")
    .option("--target <target>", "Deploy target: cloud, self-host, or local")
    .option("--name <slug>", "DVM slug for cloud deploy (default: from package.json)")
    .option(
      "--runtime <runtime>",
      "Runtime tier: container (default) or isolate (operator accounts only)"
    )
    .option(
      "--endpoint-url <url>",
      "Connect-tier upstream URL (required on plans where the platform doesn't host compute)"
    )
    .option(
      "--local",
      "Register a locally-running DVM into the local platform (no Fly), pointing at its localhost URL"
    )
    .option(
      "--url <url>",
      "Localhost URL the DVM is running at, for --local (default http://localhost:<PORT or 3000>)"
    )
    .option(
      "--dry-run",
      "Validate the project (slug, package.json, vmConfig) and build the Dockerfile locally without contacting the platform"
    )
    .option("--yes", "Skip the SDK-staleness confirmation prompt and proceed automatically")
    .option(
      "--create-identity",
      "Create the builder signing identity when it is missing (required for noninteractive first deploys)"
    )
    .option("--allow-dirty", "Allow a cloud image to include uncommitted packaged files")
    .option("--env-stdin", "Read cloud environment overrides as JSON from stdin (64 KiB maximum; overrides project .env)")
    .option("--org <handle>", "Deploy under this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: DeployOptions) => {
      catchErrors(() => deploy(opts), opts.human);
    });

  program
    .command("deploy-status <deployId>")
    .description("Show the current status of a deploy by ID (recovery handle for `dvmctl deploy`)")
    .option("--human", "Human-readable output instead of JSON")
    .action((deployId: string, opts: DeployStatusOptions) => {
      catchErrors(() => deployStatus(deployId, opts), opts.human);
    });

  program
    .command("validate")
    .description(
      "Validate the handler and `package.json#dvmkit` locally without contacting the platform"
    )
    .option("--handler <path>", "Handler module (default: handler.ts or handler.js)")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: ValidateOptions) => {
      catchErrors(() => validate(opts), opts.human);
    });

  program
    .command("doctor")
    .description("Diagnose builder-side local state")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: BuilderDoctorOptions) => {
      catchErrors(() => builderDoctor(opts), opts.human);
    });

  program
    .command("serve <handler>")
    .description("Start a production DVM server")
    .option("--port <port>", "HTTP port (default: PORT env var or 8080)")
    .option(
      "--dvm <handle>",
      "Serve under the builder-store lock identity for <handle> — advertises the lock pubkey derived from your recovery mnemonic, so `dvmctl melt-pending <handle>` and `dvmctl rotate <handle>` can sign for this DVM (self-hosted deploys)"
    )
    .action((handler: string, opts: BuilderServeOptions) => {
      // Lazy: `builderServe` drags in the SDK server runtime (hono, undici, mppx, pg); keep it
      // out of the entrypoint's import graph until the command actually runs.
      catchErrors(async () => {
        const { builderServe } = await import("../commands/builder/serve.ts");
        await builderServe(handler, opts);
      });
    });

  program
    .command("list")
    .description("List the deployed DVMs in your current org context")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: ListOptions) => {
      catchErrors(() => list(opts), opts.human);
    });


  program
    .command("info <slug>")
    .description("Show details for a deployed DVM")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: InfoOptions) => {
      catchErrors(() => dvmInfo(slug, opts), opts.human);
    });

  program
    .command("status <slug>")
    .description("Show a deployed DVM's live Fly runtime state (machines, region, image, health)")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: StatusOptions) => {
      catchErrors(() => status(slug, opts), opts.human);
    });

  program
    .command("destroy <slug>")
    .description("Destroy a deployed DVM and its paired Postgres cluster")
    .option("--confirm", "Skip confirmation prompt (required in non-interactive mode)")
    .option("--keep-db", "Preserve the Postgres cluster for re-attachment on redeploy")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: DestroyOptions) => {
      catchErrors(() => destroy(slug, opts), opts.human);
    });

  program
    .command("metrics <slug>")
    .description("Show request metrics for a deployed DVM")
    .option("--hours <hours>", "Number of hours to look back (default: 24)")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: MetricsOptions) => {
      catchErrors(() => metrics(slug, opts), opts.human);
    });

  program
    .command("events <slug>")
    .description(
      "Show recent events for a deployed DVM (deploys, restarts, scale, env, machine state)"
    )
    .option("--since <duration>", "Look-back window (e.g. 30s, 5m, 2h, 7d; default: 7d)")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: EventsOptions) => {
      catchErrors(() => events(slug, opts), opts.human);
    });

  const feedbackCmd = program
    .command("feedback")
    .description("View feedback and toggle free-text notes per DVM");

  feedbackCmd
    .command("send [text]")
    .description("Send feedback to the dvmkit team")
    .option("--body <text|@path|@->", "Feedback text, file contents, or stdin")
    .option("--trace <id>", "Related platform trace ID")
    .option("--org <handle>", "Send in this org context")
    .option("--human", "Human-readable output instead of JSON")
    .action((text: string | undefined, opts: FeedbackSendOptions) => {
      catchErrors(() => feedbackSend(text, opts), opts.human);
    });

  feedbackCmd
    .command("posture [value]")
    .description("Show or set feedback nudges: ask, auto, or off")
    .option("--human", "Human-readable output instead of JSON")
    .action((value: string | undefined, opts: FeedbackPostureOptions) => {
      catchErrors(() => feedbackPostureCommand(value, opts), opts.human);
    });

  feedbackCmd
    .command("list <slug>")
    .description("List caller-submitted feedback for one of your DVMs (newest-first)")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--verdict <up|down>", "Filter by job verdict")
    .option("--since <duration>", "Look-back window (e.g. 24h, 7d, ISO 8601)")
    .option("--cursor <c>", "Opaque cursor from a prior page's next_cursor")
    .option("--limit <n>", "Max rows per page (1-100, default 50)")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: FeedbackListOptions) => {
      catchErrors(() => feedbackList(slug, opts), opts.human);
    });

  feedbackCmd
    .command("enable <slug>")
    .description("Enable free-text feedback notes for one of your DVMs")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: FeedbackEnableOptions) => {
      catchErrors(() => feedbackEnable(slug, opts), opts.human);
    });

  feedbackCmd
    .command("disable <slug>")
    .description("Disable feedback notes (job verdicts remain enabled)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: FeedbackDisableOptions) => {
      catchErrors(() => feedbackDisable(slug, opts), opts.human);
    });

  const traceCmd = program.command("trace").description("Inspect request traces for your DVMs");

  traceCmd
    .command("get <traceId>")
    .description("Fetch a trace by ID (isolate-dataset spans only)")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable trace waterfall instead of JSON")
    .option("--no-color", "Disable ANSI colors in human output")
    .action((traceId: string, opts: TraceGetOptions) => {
      catchErrors(() => traceGet(traceId, opts), opts.human);
    });

  program
    .command("env <slug>")
    .description("View or update environment variables for a deployed DVM")
    .option("--set <KEY=value...>", "Set environment variables (repeatable)")
    .option("--unset <KEY...>", "Unset environment variables (repeatable)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: EnvOptions) => {
      catchErrors(() => env(slug, opts), opts.human);
    });

  program
    .command("logs <slug>")
    .description("View or stream logs for a deployed DVM")
    .option("--tail", "Stream live logs until interrupted (Ctrl-C)")
    .option("--since <duration>", "Only show logs newer than this (e.g. 30s, 5m, 2h, 1d)")
    .option("--lines <count>", "Max recent lines to show in non-tail mode (default: 100)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .action((slug: string, opts: LogsOptions) => {
      catchErrors(() => logs(slug, opts));
    });

  program
    .command("ssh <slug>")
    .description(
      "Open an interactive shell (or run a one-shot --command) on a deployed DVM's Fly machine"
    )
    .option("--command <cmd>", "Run a one-shot command instead of opening an interactive shell")
    .option("--machine <id>", "Target a specific machine (default: first running machine)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON (one-shot --command only)")
    .action((slug: string, opts: SshOptions) => {
      catchErrors(() => ssh(slug, opts), opts.human);
    });

  program
    .command("restart <slug>")
    .description("Restart a deployed DVM's Fly machines without a redeploy")
    .option("--machine <id>", "Restart a single machine (default: all running machines)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: RestartOptions) => {
      catchErrors(() => restart(slug, opts), opts.human);
    });

  program
    .command("pause <slug>")
    .description("Take a DVM offline — stops its machines, keeps its slug, data and database")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: PauseOptions) => {
      catchErrors(() => pause(slug, opts), opts.human);
    });

  program
    .command("resume <slug>")
    .description("Bring a paused or idle DVM back online on the same image (no redeploy)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: ResumeOptions) => {
      catchErrors(() => resume(slug, opts), opts.human);
    });

  const dbCmd = program.command("db").description("Connect to a DVM's per-DVM database");

  dbCmd
    .command("connect <slug>")
    .description(
      "Open an interactive psql session against the DVM's database (requires local psql)"
    )
    .option("--machine <id>", "Broker through a specific machine (default: first running machine)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Print connection status to stderr")
    .action((slug: string, opts: DbConnectOptions) => {
      catchErrors(() => dbConnect(slug, opts), opts.human);
    });

  dbCmd
    .command("proxy <slug>")
    .description(
      "Bind a local port to the DVM's database so any Postgres client can connect (pg_dump, drizzle-kit, GUI clients)"
    )
    .option("--port <n>", "Local port to bind (default: an OS-assigned free port)")
    .option("--machine <id>", "Broker through a specific machine (default: first running machine)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: DbProxyOptions) => {
      catchErrors(() => dbProxy(slug, opts), opts.human);
    });

  program
    .command("rollback <slug>")
    .description("Revert a deployed DVM to a previous successful deploy's image")
    .option("--to <deploy-id>", "Roll back to a specific deploy_id (default: previous deploy)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: RollbackOptions) => {
      catchErrors(() => rollback(slug, opts), opts.human);
    });

  program
    .command("scale <slug>")
    .description("Change a deployed DVM's machine count and/or VM size (no redeploy)")
    .option("--count <n>", "Number of machines to run (1-8)")
    .option("--size <vm-size>", "Fly VM size, e.g. shared-cpu-1x, shared-cpu-2x, performance-1x")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: ScaleOptions) => {
      catchErrors(() => scale(slug, opts), opts.human);
    });

  program
    .command("switch [handle]")
    .description(
      "Set the active org context for reads and deploys. Omit handle to show current; --personal to clear."
    )
    .option("--personal", "Clear org context (read and deploy as personal builder)")
    .option("--human", "Human-readable output instead of JSON")
    .action((handle: string | undefined, opts: SwitchOptions) => {
      catchErrors(() => switchCmd(handle, opts), opts.human);
    });

  program
    .command("orgs")
    .description("List your personal and shared org memberships")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: OrgsOptions) => {
      catchErrors(() => orgs(opts), opts.human);
    });

  program
    .command("whoami")
    .description("Show your local identity, builder profile, and org access")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: WhoamiOptions) => {
      catchErrors(() => whoami(opts), opts.human);
    });

  program
    .command("transfer <slug> <to>")
    .description("Transfer a DVM to an org (by handle) or back to personal")
    .option("--create-org", "Create the target org if it doesn't exist (to = desired handle)")
    .option("--display-name <name>", "Display name for the new org (with --create-org)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, to: string, opts: TransferOptions) => {
      catchErrors(() => transfer(slug, to, opts), opts.human);
    });

  program
    .command("auth")
    .description("Authenticate with the dvmkit platform")
    .option("--status", "Show current auth status")
    .option("--logout", "Remove stored credentials")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: AuthOptions) => {
      catchErrors(() => auth(opts), opts.human);
    });

  const handleCmd = program
    .command("handle")
    .description("Manage your builder handle for *.dvmkit.ai subdomains");

  handleCmd
    .command("set")
    .argument("<handle>", "Handle to claim (2-20 chars, lowercase, no '--')")
    .option("--human", "Human-readable output instead of JSON")
    .action((h: string, opts: { human?: boolean }) => {
      catchErrors(() => handle(h, opts), opts.human);
    });

  handleCmd
    .command("check")
    .argument("<handle>", "Handle to check availability for")
    .option("--human", "Human-readable output instead of JSON")
    .action((h: string, opts: { human?: boolean }) => {
      catchErrors(() => handleCheck(h, opts), opts.human);
    });

  const identityCmd = program
    .command("identity")
    .description("Manage your builder signing identity (deploy attestations, /v1/info#builder)");

  identityCmd
    .command("create")
    .description(
      "Generate a per-workstation secp256k1 identity keypair. Persists pubkey to ~/.dvmkit/builder.json and secret to ~/.dvmkit/builder.key (0600)."
    )
    .option(
      "--force",
      "Overwrite an existing identity. Any DVMs deployed under the old key will need re-deploy to refresh their /v1/info attestation."
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: IdentityCreateOptions) => {
      catchErrors(() => {
        identityCreate(opts);
      }, opts.human);
    });

  identityCmd
    .command("show")
    .description("Print the builder identity pubkey from ~/.dvmkit/builder.json")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: IdentityShowOptions) => {
      catchErrors(() => {
        identityShow(opts);
      }, opts.human);
    });

  const lockCmd = program
    .command("lock")
    .description("Manage your builder Cashu P2PK lock keypair (BIP-39 mnemonic)");

  lockCmd
    .command("create")
    .description("Generate a BIP-39 mnemonic for builder Cashu lock keypairs")
    .option("--import <mnemonic>", "Import an existing 12-word BIP-39 mnemonic")
    .option(
      "--force",
      "Replace an existing mnemonic with a freshly generated one. The old words are copied to a timestamped .bak sibling; proofs locked to lock pubkeys derived from them stop being spendable."
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: LockCreateOptions) => {
      catchErrors(() => {
        lockCreate(opts);
      }, opts.human);
    });

  const domainsCmd = program
    .command("domains")
    .description("Manage custom domains for deployed DVMs");

  domainsCmd
    .command("add")
    .argument("<slug>", "DVM slug")
    .argument("<domain>", "Custom domain (e.g. api.example.com)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, domain: string, opts: { human?: boolean; org?: string }) => {
      catchErrors(
        () => domains("add", slug, { domain, human: opts.human, org: opts.org }),
        opts.human
      );
    });

  domainsCmd
    .command("remove")
    .argument("<slug>", "DVM slug")
    .argument("<domain>", "Custom domain to remove")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, domain: string, opts: { human?: boolean; org?: string }) => {
      catchErrors(
        () => domains("remove", slug, { domain, human: opts.human, org: opts.org }),
        opts.human
      );
    });

  domainsCmd
    .command("verify")
    .argument("<slug>", "DVM slug")
    .argument("<domain>", "Custom domain to verify")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, domain: string, opts: { human?: boolean; org?: string }) => {
      catchErrors(
        () => domains("verify", slug, { domain, human: opts.human, org: opts.org }),
        opts.human
      );
    });

  domainsCmd
    .command("list")
    .argument("<slug>", "DVM slug")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: { human?: boolean; org?: string }) => {
      catchErrors(() => domains("list", slug, { human: opts.human, org: opts.org }), opts.human);
    });

  const secretsCmd = program.command("secrets").description("Inspect and set secrets for a DVM");


  secretsCmd
    .command("list")
    .argument("<slug>", "DVM slug")
    .description(
      "List secret names + last-applied timestamps for a DVM. Never returns values; platform-injected keys are excluded."
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((slug: string, opts: SecretsListOptions) => {
      catchErrors(() => secretsList(slug, opts), opts.human);
    });

  const revenueCmd = program.command("revenue").description("View revenue data across your DVMs");

  revenueCmd
    .command("summary")
    .description("Show revenue summary with totals and by-rail breakdown")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .requiredOption("--from <date>", "Start date (YYYY-MM-DD)")
    .requiredOption("--to <date>", "End date (YYYY-MM-DD)")
    .option("--currency <c>", "Reporting currency (gbp, eur, usd, chf)")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: RevenueSummaryOptions) => {
      catchErrors(() => revenueSummary(opts), opts.human);
    });

  revenueCmd
    .command("events")
    .description("List individual revenue events (requires admin role in a shared org)")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .option("--from <date>", "Start date (YYYY-MM-DD)")
    .option("--to <date>", "End date (YYYY-MM-DD)")
    .option("--rail <r>", "Filter by payment rail (cashu, lightning, tempo, x402)")
    .option("--limit <n>", "Max events to return (default: 50)")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: RevenueEventsOptions) => {
      catchErrors(() => revenueEvents(opts), opts.human);
    });

  revenueCmd
    .command("csv")
    .description("Export revenue data as CSV (requires admin role in a shared org)")
    .option("--org <handle>", "Read as this org, overriding the `dvmctl switch` context")
    .requiredOption("--from <date>", "Start date (YYYY-MM-DD)")
    .requiredOption("--to <date>", "End date (YYYY-MM-DD)")
    .option("--currency <c>", "Reporting currency (gbp, eur, usd, chf)")
    .option("--rail <r>", "Filter by payment rail")
    .option("--out <path>", "Write CSV to file instead of stdout")
    .action((opts: RevenueCsvOptions) => {
      catchErrors(() => revenueCsv(opts));
    });

  const apiKeysCmd = program.command("api-keys").description("Manage builder API keys");

  apiKeysCmd
    .command("list")
    .description("List your API keys")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: ApiKeysListOptions) => {
      catchErrors(() => apiKeysList(opts), opts.human);
    });

  apiKeysCmd
    .command("create")
    .description("Create a new API key")
    .option("--label <text>", "Label for the key")
    .option("--human", "Human-readable output instead of JSON")
    .action((opts: ApiKeysCreateOptions) => {
      catchErrors(() => apiKeysCreate(opts), opts.human);
    });

  apiKeysCmd
    .command("revoke <id>")
    .description("Revoke (delete) an API key")
    .option("--human", "Human-readable output instead of JSON")
    .action((id: string, opts: ApiKeysRevokeOptions) => {
      catchErrors(() => apiKeysRevoke(id, opts), opts.human);
    });

  program
    .command("rotate <handle>")
    .description(
      "Rotate the per-DVM Cashu lock pubkey — derives the next BIP-32 child, publishes it to the DVM, demotes the prior pubkey to retired"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; required for self-hosted DVMs)"
    )
    .option("--sync-platform", "Finish a pending platform lock-pubkey sync without rotating again")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handle: string, opts: RotateOptions) => {
      catchErrors(() => rotate(handle, opts), opts.human);
    });

  program
    .command("melt-pending <handle>")
    .description(
      "Drain a DVM's pending Cashu accumulator batches — derives the per-DVM lock privkey locally, melts at the mint, posts mark-melted to the DVM admin endpoint"
    )
    .option(
      "--payout <ln-address>",
      "Lightning address to melt to (overrides any default set via `dvmctl set-payout`)"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--watch", "Run as a long-lived daemon polling every --interval seconds")
    .option(
      "--interval <seconds>",
      "Poll cadence under --watch (default: 60, range 10–3600)",
      (v) => Number(v)
    )
    .option(
      "--drains-only",
      "Service the credit refunds you owe callers and stop — never sweep accumulator batches to the payout address. No --payout needed. Use when settling refunds out of band from the scheduled melt"
    )
    .option(
      "--hold-alarm-after <duration>",
      "How long this DVM's drain surface may stay unreadable before a one-shot sweep exits non-zero instead of holding the melt again (default: 24h). Nothing melts and no refund parks while it is held, so this is the ceiling on a silent stall"
    )
    .option(
      "--refund-nwc <uri>",
      "Send-capable NWC connection used to buy a caller's refund when no accumulator batch covers it — the notes are minted just in time and paid for from this wallet (env: DVMKIT_REFUND_NWC_URL). It only ever pays invoices this command obtained from your own accepted mints"
    )
    .option(
      "--payout-nwc <uri>",
      "Mint the payout invoice from this NWC wallet instead of resolving --payout over LNURL (env: DVMKIT_MELT_PAYOUT_NWC_URL). Use when the melt destination is a node with no Lightning address of its own"
    )
    .option(
      "--acknowledge-stuck <quote-id>",
      "Record that this in-flight melt quote is stuck at the mint, then exit without melting. Only a quote past the 24h in-flight alarm qualifies. Its rows stay held and later sweeps keep checking the quote, but it no longer fails the run. Requires --reason"
    )
    .option(
      "--reason <text>",
      "Why the quote passed to --acknowledge-stuck is stuck (e.g. a mint support ticket); kept in the melt journal and logged on every sweep"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((handle: string, opts: MeltPendingOptions) => {
      catchErrors(() => meltPending(handle, opts), opts.human);
    });

  program
    .command("melt-status [handle]")
    .description(
      "Report when `dvmctl melt-pending` last completed cleanly for each DVM on this machine — the liveness signal a scheduled melt leaves behind, readable with no platform involved"
    )
    .option(
      "--max-age <duration>",
      "Exit non-zero when a DVM has not swept successfully within this window (e.g. `30h`, `2d`). Cron this and the exit code alarms on a melt job that stopped running at all. Every DVM is watched, and one that has never swept counts as stale"
    )
    .option(
      "--except <handle>",
      "Do not alarm on this DVM under --max-age (repeatable). For a DVM with no Cashu rail, which never melts and would otherwise hold the alarm red forever",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[]
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((handle: string | undefined, opts: MeltStatusOptions) => {
      catchErrors(() => {
        meltStatus(handle, opts);
      }, opts.human);
    });

  const holdsCmd = program.command("content-holds")
    .description("Manage signed, service-local job content holds; review dates never auto-clear holds");
  for (const action of ["list", "place", "renew", "clear"] as const) {
    const command = holdsCmd.command(`${action} <handle> <job-id>${action === "renew" || action === "clear" ? " <hold-id>" : ""}`)
      .description(`${action} job-scoped content holds`)
      .option("--endpoint <url>", "Service endpoint override for a locally known DVM")
      .option("--org <handle>", "Target this org")
      .option("--human", "Human-readable output instead of JSON");
    if (action !== "list") command.option("--reason <text>", "Required reason, recorded in the hold history");
    if (action === "place") command.option("--purpose <purpose>", "Required: support or dispute");
    if (action === "place" || action === "renew") command.option("--review-due-at <date>", "Required future epoch milliseconds or ISO 8601 timestamp with timezone");
    if (action === "renew" || action === "clear") {
      command.action((handle: string, jobId: string, holdId: string, opts: ContentHoldOptions) => {
        catchErrors(() => contentHolds(action, handle, jobId, holdId, opts), opts.human);
      });
    } else {
      command.action((handle: string, jobId: string, opts: ContentHoldOptions) => {
        catchErrors(() => contentHolds(action, handle, jobId, undefined, opts), opts.human);
      });
    }
  }

  program
    .command("refund <job-id>")
    .description("Refund a completed job's charge onto the caller's prepaid credit")
    .option("--dvm <handle>", "DVM slug (default: current project's name, as for deploy)")
    .option("--amount <decimal>", "Amount in the job's credit currency; omit for the remaining unrefunded charge")
    .option("--reason <text>", "Optional refund reason, at most 280 characters")
    .option("--refund-id <id>", "Override the deterministic refund ID for a deliberate additional partial refund")
    .option("--confirm", "Submit the refund; without this flag, refuse with a local intent and send no HTTP")
    .option("--endpoint <url>", "DVM admin endpoint URL for self-hosted DVMs or local development")
    .option("--org <handle>", "Target this org, overriding the dvmctl switch context")
    .option("--human", "Human-readable output instead of JSON")
    .action((jobId: string, opts: RefundOptions) => {
      catchErrors(() => refund(jobId, opts), opts.human);
    });

  const creditCmd = program
    .command("credit")
    .description("Reconcile prepaid-credit money your DVM could not apply on its own");

  creditCmd
    .command("blocked <handle>")
    .description(
      "List Lightning top-ups your DVM received but could never credit — the queue behind every `lightning_settlement_blocked` log line"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--limit <n>", "Page size (default: 50, max 200)", (v) => Number(v))
    .option("--after <cursor>", "Continue from a previous run's `next_after` value")
    .option(
      "--include-resolved",
      "Also list rows you already reconciled or wrote off — the audit view"
    )
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, opts: BlockedInvoicesOptions) => {
      catchErrors(() => blockedInvoices(handleArg, opts), opts.human);
    });

  creditCmd
    .command("reconcile <handle> <payment-hash>")
    .description(
      "Credit a blocked Lightning payment onto a credit the caller holds. The amount, currency and caller all come off the invoice your DVM recorded; you name only the credit. Idempotent"
    )
    .option("--credit-id <id>", "Credit the payment should land on (required)")
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, paymentHash: string, opts: ReconcileInvoiceOptions) => {
      catchErrors(() => reconcileInvoice(handleArg, paymentHash, opts), opts.human);
    });

  creditCmd
    .command("write-off <handle> <payment-hash>")
    .description(
      "Record that you reviewed a blocked Lightning payment and are not crediting it. Moves no money and is reversible — the row just leaves the queue"
    )
    .option("--note <text>", "Why you are not crediting it. Recorded on the invoice row")
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, paymentHash: string, opts: WriteOffInvoiceOptions) => {
      catchErrors(() => writeOffInvoice(handleArg, paymentHash, opts), opts.human);
    });

  creditCmd
    .command("drains-owed <handle>")
    .description(
      "List the stablecoin refunds your DVM owes callers that nothing will ever pay on its own — one-payment x402 and Tempo reclaims, the queue behind every `drain_manual_settlement_required` log line"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, opts: DrainsOwedOptions) => {
      catchErrors(() => drainsOwed(handleArg, opts), opts.human);
    });

  creditCmd
    .command("liability <handles...>")
    .description(
      "Show the satoshis your DVMs owe callers — undrawn Bitcoin deposits plus reclaims in flight — and how much of your hub balance is earnings you can sweep. Name every DVM the hub backs"
    )
    .option(
      "--hub-sats <sats>",
      "Your hub's spendable balance, in sats. Supply it to get the sweepable figure directly"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArgs: string[], opts: CreditLiabilityOptions) => {
      catchErrors(() => creditLiability(handleArgs, opts), opts.human);
    });

  creditCmd
    .command("drain-settle <handle> <credit-id> <drain-id>")
    .description(
      "Record that you settled an owed stablecoin refund on chain. Moves no money — the ledger catches up with a payout you already made, the caller's poll sees it settled, and the reclaim stops counting against your liability. Idempotent"
    )
    .option("--tx <hash>", "On-chain transaction that paid the refund (required)")
    .option("--note <text>", "Recorded alongside the transaction, e.g. which wallet sent it")
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, creditId: string, drainId: string, opts: DrainSettleOptions) => {
      catchErrors(() => drainSettle(handleArg, creditId, drainId, opts), opts.human);
    });

  creditCmd
    .command("x402-wedged <handle>")
    .description(
      "List x402 cooperative refunds that settled on chain but never cleared the caller's balance, with what the chain says about each"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--limit <n>", "Page size (default: 20, max 50)", (v) => Number(v))
    .option("--after <cursor>", "Continue from a previous run's `next_after` value")
    .option("--include-resolved", "Also list settlements you already wrote off — the audit view")
    .option(
      "--min-age-ms <ms>",
      "How long a settlement must have sat before it counts as stuck (default: 300000)",
      (v) => Number(v)
    )
    .option("--no-evidence", "Skip the per-row chain lookups — a fast read of the queue itself")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, opts: X402WedgedOptions) => {
      catchErrors(() => x402Wedged(handleArg, opts), opts.human);
    });

  creditCmd
    .command("x402-reconcile <handle> <settlement-id>")
    .description(
      "Finish the ledger leg of an x402 refund the chain already paid. The amount is re-derived from chain evidence, never sent from here; a chain/ledger disagreement refuses. Idempotent"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, settlementId: string, opts: X402ReconcileOptions) => {
      catchErrors(() => x402Reconcile(handleArg, settlementId, opts), opts.human);
    });

  creditCmd
    .command("x402-write-off <handle> <settlement-id>")
    .description(
      "Record that you reviewed a wedged x402 settlement and are not booking it. Books nothing and is reversible — the row just leaves the queue"
    )
    .option("--note <text>", "Why you are not booking it. Recorded on the settlement row")
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, settlementId: string, opts: X402WriteOffOptions) => {
      catchErrors(() => x402WriteOff(handleArg, settlementId, opts), opts.human);
    });

  creditCmd
    .command("x402-exact-wedged <handle>")
    .description(
      "List exact x402 authorizations whose chain settlement has not finished its original local credit or job effect"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--limit <n>", "Rows to return (default: 20, max 50)", (v) => Number(v))
    .option("--include-resolved", "Also list completed and rejected intents")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, opts: X402ExactWedgedOptions) => {
      catchErrors(() => x402ExactWedged(handleArg, opts), opts.human);
    });

  creditCmd
    .command("x402-exact-reconcile <handle> <settlement-intent-id>")
    .description(
      "Finish the original local effect of a chain-evidenced exact x402 payment. The transaction and amount come from the DVM, never this command"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, settlementIntentId: string, opts: X402ExactReconcileOptions) => {
      catchErrors(() => x402ExactReconcile(handleArg, settlementIntentId, opts), opts.human);
    });

  creditCmd
    .command("tempo-losses <handle>")
    .description(
      "List Tempo-backed credits terminalized after their channel finalized before the DVM collected accepted value"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--limit <n>", "Rows to return (default: 20, max 50)", (v) => Number(v))
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, opts: TempoLossesOptions) => {
      catchErrors(() => tempoLosses(handleArg, opts), opts.human);
    });

  creditCmd
    .command("tempo-wedged <handle>")
    .description(
      "List Tempo cooperative closes that landed on chain but never booked the caller's drain, with what the close receipt says about each"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--limit <n>", "Page size (default: 20, max 50)", (v) => Number(v))
    .option("--after <cursor>", "Continue from a previous run's `next_after` value")
    .option("--include-resolved", "Also list drains you already wrote off — the audit view")
    .option(
      "--min-age-ms <ms>",
      "How long a drain must have sat before it counts as stuck (default: 300000)",
      (v) => Number(v)
    )
    .option("--no-evidence", "Skip the per-row chain lookups — a fast read of the queue itself")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, opts: TempoWedgedOptions) => {
      catchErrors(() => tempoWedged(handleArg, opts), opts.human);
    });

  creditCmd
    .command("tempo-close-reports <handle>")
    .description("List hosted Tempo close reports and the builder payout at stake; retry searches again, while write-off gives up the payout report")
    .option("--endpoint <url>", "DVM admin endpoint URL (skips the platform getDvm lookup)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--limit <n>", "Page size (default: 20, max 50)", (v) => Number(v))
    .option("--after <cursor>", "Continue from next_after using the same --all setting")
    .option("--all", "Include terminal no_report rows and rows without available actions")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, opts: TempoCloseReportsOptions) => {
      catchErrors(() => tempoCloseReports(handleArg, opts), opts.human);
    });

  creditCmd
    .command("tempo-close-report-retry <handle> <obligation-id>")
    .description("Reopen the search for a Tempo close so the builder's payout report can still be sent")
    .option("--endpoint <url>", "DVM admin endpoint URL (skips the platform getDvm lookup)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, obligationId: string, opts: TempoCloseReportActionOptions) => {
      catchErrors(() => tempoCloseReportRetry(handleArg, obligationId, opts), opts.human);
    });

  creditCmd
    .command("tempo-close-report-write-off <handle> <obligation-id>")
    .description("Permanently give up the builder's payout report for a missing Tempo close; does not refund the caller")
    .requiredOption("--note <text>", "Reason for giving up this payout report (1 to 2000 characters after trimming)")
    .option("--endpoint <url>", "DVM admin endpoint URL (skips the platform getDvm lookup)")
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, obligationId: string, opts: TempoCloseReportActionOptions) => {
      catchErrors(() => tempoCloseReportWriteOff(handleArg, obligationId, opts), opts.human);
    });

  creditCmd
    .command("tempo-reconcile <handle> <credit-id> <drain-id>")
    .description(
      "Book a Tempo drain whose channel close already paid. The amount is re-read from the close receipt, never sent from here; a refund short of the debit refuses. Idempotent"
    )
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, creditId: string, drainId: string, opts: TempoReconcileOptions) => {
      catchErrors(() => tempoReconcile(handleArg, creditId, drainId, opts), opts.human);
    });

  creditCmd
    .command("tempo-write-off <handle> <credit-id> <drain-id>")
    .description(
      "Record that you reviewed a wedged Tempo close and are not booking it. Books nothing and is reversible — the row just leaves the queue"
    )
    .option("--note <text>", "Why you are not booking it. Recorded on the drain row")
    .option(
      "--endpoint <url>",
      "DVM admin endpoint URL (skips the platform getDvm lookup; use for self-hosted DVMs or local dev)"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handleArg: string, creditId: string, drainId: string, opts: TempoWriteOffOptions) => {
      catchErrors(() => tempoWriteOff(handleArg, creditId, drainId, opts), opts.human);
    });

  program
    .command("set-payout <handle> <ln-address>")
    .description(
      "Persist the default Lightning payout address for `dvmctl melt-pending <handle>` (pre-flights the LNURL-pay endpoint)"
    )
    .option(
      "--skip-preflight",
      "Skip the LNURL pre-flight check (use when the provider is temporarily down)"
    )
    .option(
      "--self-hosted",
      "Resolve this handle from local builder.json state instead of asking the platform which DVM it is. Named for the self-hosted case it was built for, but it reaches any entry recorded on this machine — including one a `dvmctl deploy` wrote, whose payout address it will rewrite"
    )
    .option("--org <handle>", "Target this org, overriding the `dvmctl switch` context")
    .option("--human", "Human-readable output instead of JSON")
    .action((handle: string, lnAddress: string, opts: SetPayoutOptions) => {
      catchErrors(() => setPayout(handle, lnAddress, opts), opts.human);
    });

  registerBillingCommands(program);
  return program;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installGlobalAcceptEncoding();
  setOutputTraceId(randomTraceId());
  buildProgram().parse();
}

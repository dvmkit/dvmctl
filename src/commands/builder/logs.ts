import { parseDurationMs } from "../../lib/duration.ts";
import * as platformClient from "../../lib/platform-client.ts";
import { raw } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface LogsOptions {
  lines?: string;
  tail?: boolean;
  since?: string;
  org?: string;
}

/**
 * View or stream logs for a deployed DVM. Output is raw log lines on stdout
 * (no JSON envelope) so it stays pipeable and vim-pasteable.
 *
 * Default prints the recent buffer and exits; `--tail` streams live until
 * Ctrl-C. `--since` filters to a recent window (subject to Fly's short buffer).
 */
export async function logs(slug: string, opts: LogsOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  // Validate --since up front so a bad value fails before any request.
  if (opts.since) parseDurationMs(opts.since);

  if (opts.tail) {
    const handle = await platformClient.streamLogs(
      platformUrl,
      token,
      dvmId,
      { since: opts.since },
      (line) => {
        raw(line);
      }
    );

    process.on("SIGINT", () => {
      handle.stop();
      process.exit(0);
    });

    // Keep alive until SIGINT or stream ends.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await new Promise(() => {});
    return;
  }

  const lineCount = opts.lines ? Number(opts.lines) : 100;
  const logLines = await platformClient.getLogs(platformUrl, token, dvmId, {
    lines: lineCount,
    since: opts.since,
  });
  for (const line of logLines) {
    raw(line);
  }
}

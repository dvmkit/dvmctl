import * as platformClient from "../../lib/platform-client.ts";
import { info, json, raw } from "../../shared/output.ts";
import { resolveDvm } from "./resolve-dvm.ts";

export interface SshOptions {
  command?: string;
  machine?: string;
  human?: boolean;
  org?: string;
}

/**
 * SSH into a running Fly machine of a deployed DVM, mediated by the platform
 * (no flyctl required builder-side). With `--command`, runs a one-shot command
 * and exits with its exit code (`ssh host "cmd"` semantics). Without it, opens
 * an interactive PTY shell over a websocket and exits with the remote shell's
 * exit code.
 */
export async function ssh(slug: string, opts: SshOptions): Promise<void> {
  const { token, platformUrl, dvmId } = await resolveDvm(slug, opts);

  if (!opts.command) {
    const code = await platformClient.openSshSession(platformUrl, token, dvmId, {
      machine: opts.machine,
    });
    process.exit(code);
  }

  const result = await platformClient.execCommand(platformUrl, token, dvmId, opts.command, {
    machine: opts.machine,
  });

  if (opts.human) {
    if (result.stdout) raw(result.stdout.replace(/\n$/, ""));
    if (result.stderr) info(result.stderr.replace(/\n$/, ""));
    if (result.exit_code !== 0) info(`(exit code ${result.exit_code})`);
  } else {
    process.exitCode = result.exit_code;
    json({ ...result, dvmId, slug });
  }

  // Propagate the remote exit code. catchErrors() would otherwise force exit 0
  // once the action promise resolves; calling process.exit here pre-empts it.
  process.exit(result.exit_code);
}

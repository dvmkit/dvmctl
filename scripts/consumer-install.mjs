// @ts-check
import { INSTALL_COMMAND_TIMEOUT_MS } from "./consumer-process.mjs";

/**
 * Hosted Windows runners take about three minutes for this install versus about
 * 15 seconds elsewhere, so the shared five-minute bound leaves them no headroom.
 */
export const WINDOWS_SCAFFOLD_INSTALL_TIMEOUT_MS = 600_000;

/**
 * Windows cannot spawn npm.cmd directly without a command interpreter. Keep the
 * command text fixed; project paths belong in spawn's cwd, never in shell text.
 * @param {NodeJS.Platform} [platform]
 */
export function scaffoldInstallCommand(platform = process.platform) {
  return platform === "win32"
    ? { executable: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd install --@dvmkit:registry=https://registry.npmjs.org/"], timeout: WINDOWS_SCAFFOLD_INSTALL_TIMEOUT_MS }
    : { executable: "npm", args: ["install", "--@dvmkit:registry=https://registry.npmjs.org/"], timeout: INSTALL_COMMAND_TIMEOUT_MS };
}

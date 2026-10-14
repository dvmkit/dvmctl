declare module "*scripts/consumer-process.mjs" {
  export function observeProcess(child: import("node:child_process").ChildProcess): void;
  export function stopProcess(child: import("node:child_process").ChildProcess): Promise<boolean>;
  export function waitForProcessClose(child: import("node:child_process").ChildProcess, timeout: number): Promise<boolean>;
}

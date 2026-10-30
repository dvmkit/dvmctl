import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function startFakeWalletMint(): Promise<{ url: string; stop: () => Promise<void> }> {
  const { stdout } = await exec("docker", [
    "run", "--rm", "-d", "-p", "127.0.0.1::3338",
    "-e", "MINT_LISTEN_HOST=0.0.0.0", "-e", "MINT_LISTEN_PORT=3338",
    "-e", "MINT_BACKEND_BOLT11_SAT=FakeWallet",
    "-e", "MINT_PRIVATE_KEY=test-key-do-not-use-in-production",
    "-e", "FAKEWALLET_DELAY_INCOMING_PAYMENT=0", "-e", "FAKEWALLET_DELAY_OUTGOING_PAYMENT=0",
    "cashubtc/nutshell:0.19.2", "poetry", "run", "mint",
  ], { timeout: 90_000 });
  const id = stdout.trim();
  const stop = async () => { await exec("docker", ["rm", "-f", id], { timeout: 10_000 }); };
  try {
    const { stdout: port } = await exec("docker", ["port", id, "3338/tcp"], { timeout: 10_000 });
    const url = `http://${port.trim()}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(`${url}/v1/info`, { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return { url, stop };
      } catch { /* The mint may still be starting. */ }
      await setTimeout(1000);
    }
    throw new Error("FakeWallet mint did not become ready");
  } catch (error) {
    await stop();
    throw error;
  }
}

import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

import {
  CLI_AUTH_FINGERPRINT_LEN,
  CLI_AUTH_MAX_POLL_ATTEMPTS,
  CLI_AUTH_POLL_INTERVAL_MS,
  CLI_AUTH_POLL_JITTER_MS,
} from "../../lib/cli-auth.ts";
import { clearAuthToken, loadAuthToken, resolveAuth, saveAuthToken } from "../../lib/platform.ts";
import { progress } from "../../shared/output.ts";

export interface AuthOptions {
  human?: boolean;
  logout?: boolean;
  status?: boolean;
}

const PLATFORM_URL = process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev";
const BETA_HINT =
  "dvmkit is in a closed beta: sign in with an invited account. No invite yet? Join the waitlist at https://dvmkit.com/waitlist";
const TIMEOUT_MESSAGE =
  "Authentication timed out. Try again, or join the waitlist at https://dvmkit.com/waitlist if you don't have an invite yet. DVMKIT_API_KEY skips the browser.";
const WEB_URL = process.env.DVMKIT_WEB_URL ?? "https://dvmkit.com";

export async function auth(opts: AuthOptions): Promise<void> {
  if (opts.status) {
    showStatus(opts.human);
    return;
  }

  if (opts.logout) {
    logout(opts.human);
    return;
  }

  await login(opts.human);
}

function showStatus(human?: boolean): void {
  const creds = resolveAuth();
  if (!creds) {
    if (human) {
      console.log("Not authenticated. Run `dvmctl auth` to log in.");
    } else {
      console.log(JSON.stringify({ authenticated: false }));
    }
    return;
  }
  if (human) {
    console.log(`Authenticated as ${creds.account}`);
  } else {
    console.log(JSON.stringify({ authenticated: true, account: creds.account }));
  }
}

function logout(human?: boolean): void {
  clearAuthToken();
  if (human) {
    console.log("Logged out.");
  } else {
    console.log(JSON.stringify({ status: "logged_out" }));
  }
}

async function login(human?: boolean): Promise<void> {
  const existing = loadAuthToken();
  if (existing) {
    if (human) {
      console.log(`Already authenticated as ${existing.account}. Use --logout to sign out first.`);
    } else {
      console.log(JSON.stringify({ authenticated: true, account: existing.account }));
    }
    return;
  }

  const sessionId = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("hex");
  const verifierHash = createHash("sha256").update(verifier).digest("hex");
  const host = hostname();
  const authUrl = `${WEB_URL}/cli-auth?session=${sessionId}&hash=${verifierHash}&host=${encodeURIComponent(host)}`;
  const fingerprint = sessionId.slice(0, CLI_AUTH_FINGERPRINT_LEN);

  if (human) {
    console.log("\nOpening browser to authenticate...");
    console.log(BETA_HINT);
    console.log(`\n  ${authUrl}\n`);
    console.log(`Session code: ${fingerprint}…  (must match the code shown in your browser)\n`);
  } else {
    progress({
      status: "opening_browser",
      url: authUrl,
      fingerprint,
      display: "Opening browser to authenticate...",
      hint: BETA_HINT,
    });
  }

  // Try to open browser
  try {
    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin"
        ? `open "${authUrl}"`
        : process.platform === "win32"
          ? `start "${authUrl}"`
          : `xdg-open "${authUrl}"`;
    exec(cmd);
  } catch {
    if (human) {
      console.log("Could not open browser automatically. Please open the URL above.");
    } else {
      progress({ display: "Could not open browser automatically. Please open the URL above." });
    }
  }

  if (human) console.log("Waiting for authentication...");

  // Poll for token. The verifier is sent as a bearer token so anyone who
  // sees only the URL (which contains the hash, not the verifier) cannot
  // race the legitimate CLI for the deposited token.
  const pollUrl = `${PLATFORM_URL}/api/v1/cli-auth/${sessionId}`;
  for (let i = 0; i < CLI_AUTH_MAX_POLL_ATTEMPTS; i++) {
    // Small jitter avoids thundering-herd if multiple CLIs auth at once.
    const jitter = Math.floor(Math.random() * CLI_AUTH_POLL_JITTER_MS);
    await sleep(CLI_AUTH_POLL_INTERVAL_MS + jitter);
    let res: Response;
    try {
      res = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${verifier}` },
      });
    } catch {
      // Platform not reachable — keep polling. Network blips are expected.
      continue;
    }
    if (res.status === 404) continue; // not yet approved or denied
    if (!res.ok) continue; // server hiccup, try again

    const data = (await res.json().catch(() => null)) as {
      token?: string;
      account?: string;
      cancelled?: boolean;
    } | null;
    if (!data) continue;

    if (data.cancelled) {
      if (human) {
        console.log("\nSign-in cancelled.");
        console.log(BETA_HINT);
      } else {
        console.log(
          JSON.stringify({
            authenticated: false,
            cancelled: true,
            display: "Sign-in cancelled.",
            hint: BETA_HINT,
          })
        );
      }
      process.exit(1);
    }

    if (data.token && data.account) {
      saveAuthToken({ token: data.token, account: data.account });
      if (human) {
        console.log(`\nAuthenticated as ${data.account}`);
      } else {
        console.log(JSON.stringify({ authenticated: true, account: data.account }));
      }
      return;
    }
  }

  if (human) {
    console.error(`\n${TIMEOUT_MESSAGE}`);
  } else {
    console.log(
      JSON.stringify({
        authenticated: false,
        timed_out: true,
        display: TIMEOUT_MESSAGE,
        hint: TIMEOUT_MESSAGE,
      })
    );
  }
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

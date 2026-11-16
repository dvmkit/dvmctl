import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { CLI_AUTH_DOCS_URL } from "../../lib/auth-hint.ts";
import {
  CLI_AUTH_TTL_MS,
  CLI_AUTH_FINGERPRINT_LEN,
  CLI_AUTH_MAX_POLL_ATTEMPTS,
  CLI_AUTH_POLL_INTERVAL_MS,
  CLI_AUTH_POLL_JITTER_MS,
} from "../../lib/cli-auth.ts";
import { clearAuthToken, loadAuthToken, resolveAuth, saveAuthToken } from "../../lib/platform.ts";
import { deleteApiKey, listApiKeys } from "../../lib/platform-client.ts";
import { progress } from "../../shared/output.ts";

export interface AuthOptions {
  human?: boolean;
  logout?: boolean;
  status?: boolean;
  browser?: boolean;
}

const PLATFORM_URL = process.env.DVMKIT_PLATFORM_URL ?? "https://api.dvmkit.dev";
const SIGN_IN_HINT = "Complete sign-in in your browser, then return here.";
const NO_BROWSER_MESSAGE = "Could not open a browser on this machine. The link must be relayed to a human.";
const CANCELLED_HINT = "Run `dvmctl auth` to try again.";
const TIMEOUT_MESSAGE =
  "Authentication timed out. Try again. DVMKIT_API_KEY skips the browser.";
const LOGOUT_REVOCATION_TIMEOUT_MS = 5000;
const WEB_URL = process.env.DVMKIT_WEB_URL ?? "https://dvmkit.com";

export async function auth(opts: AuthOptions): Promise<void> {
  if (opts.status) {
    showStatus(opts.human);
    return;
  }

  if (opts.logout) {
    await logout(opts.human);
    return;
  }

  await login(opts.human, opts.browser);
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

async function logout(human?: boolean): Promise<void> {
  const stored = loadAuthToken();
  let revoked = false;
  // Share one deadline across both requests, including response-body reads.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOGOUT_REVOCATION_TIMEOUT_MS);
  try {
    if (stored) {
      const { keys } = await listApiKeys(PLATFORM_URL, stored.token, controller.signal);
      controller.signal.throwIfAborted();
      const matches = keys.filter((key) => key.key_prefix && stored.token.startsWith(key.key_prefix));
      // A prefix is not a unique identity: never revoke an ambiguous match.
      if (matches.length === 1) {
        await deleteApiKey(PLATFORM_URL, stored.token, matches[0]!.id, controller.signal);
        controller.signal.throwIfAborted();
        revoked = true;
      }
    }
  } catch {
    // Offline or already-revoked keys must not prevent local sign-out.
  } finally {
    clearTimeout(timeout);
    clearAuthToken();
  }
  const hint = revoked ? undefined :
    "Server revocation could not be confirmed. Revoke the key in the dashboard or use `dvmctl api-keys revoke <id>`.";
  if (human) {
    console.log(revoked ? "Logged out. API key revoked." : `Logged out locally. ${hint}`);
  } else {
    console.log(JSON.stringify({ status: "logged_out", revoked, ...(hint ? { hint } : {}) }));
  }
}

async function login(human?: boolean, browser = true): Promise<void> {
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
  const sessionCodeDisplay = `Session code: ${fingerprint}…  (must match the code shown in your browser)`;

  const skipBrowser = !browser || (!process.env.BROWSER?.trim() && isHeadless());
  const expiresAt = new Date(Date.now() + CLI_AUTH_TTL_MS).toISOString();
  const instruction = relayInstruction(authUrl, fingerprint);

  if (human) {
    console.log(skipBrowser ? `\n${NO_BROWSER_MESSAGE}` : "\nOpening browser to authenticate...");
    console.log(SIGN_IN_HINT);
    console.log(`\n  ${authUrl}\n`);
    console.log(`${sessionCodeDisplay}\n`);
  }

  const browserOpened = !skipBrowser && await openBrowser(authUrl);
  if (human) {
    if (!skipBrowser && !browserOpened) console.log(NO_BROWSER_MESSAGE);
    console.log(`${instruction}\n`);
    console.log("Waiting for authentication...");
  } else {
    // An agent cannot see the browser, so always provide the link to relay.
    progress({
      status: "awaiting_human",
      url: authUrl,
      fingerprint,
      expires_at: expiresAt,
      browser_opened: browserOpened,
      instruction,
      display: `${browserOpened ? "Browser launched to authenticate." : NO_BROWSER_MESSAGE} ${sessionCodeDisplay}`,
      hint: SIGN_IN_HINT,
    });
  }

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
        console.log(CANCELLED_HINT);
      } else {
        console.log(
          JSON.stringify({
            authenticated: false,
            cancelled: true,
            display: "Sign-in cancelled.",
            hint: CANCELLED_HINT,
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

/** Skip the default graphical opener on Linux without a display server. */
function isHeadless(): boolean {
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

function relayInstruction(url: string, fingerprint: string): string {
  return (
    `A human must finish sign-in. Send them this link and the session code ${fingerprint}: ${url} ` +
    `They can open it on any device within ${CLI_AUTH_TTL_MS / 60_000} minutes, and it creates their account if they have none. ` +
    "Keep this command running until it reports authenticated. " +
    `If you cannot wait, ask them to create an API key in the dashboard and set DVMKIT_API_KEY (${CLI_AUTH_DOCS_URL}).`
  );
}

// Tokenize before inserting the URL so its ampersands and spaces cannot become syntax.
// Quotes and escaped whitespace are supported; shell expansion is deliberately absent.
function browserArguments(value: string): string[] {
  const args: string[] = [];
  let token = "";
  let quote = "";
  let inToken = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && quote !== "'" && /[\s\\"']/.test(value[i + 1] ?? "")) {
      token += value[++i];
      inToken = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
    } else if (/\s/.test(char)) {
      if (inToken) args.push(token);
      token = "";
      inToken = false;
    } else {
      token += char;
      inToken = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in BROWSER");
  if (inToken) args.push(token);
  return args;
}

async function openBrowser(authUrl: string): Promise<boolean> {
  try {
    const configured = process.env.BROWSER?.trim();
    const command = configured ? browserArguments(configured) :
      process.platform === "darwin" ? ["open"] :
        process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler"] : ["xdg-open"];
    const executable = command.shift();
    if (!executable) return false;
    const hasPlaceholder = command.some((arg) => arg.includes("%s"));
    const args = command.map((arg) => arg.replaceAll("%s", () => authUrl));
    if (!hasPlaceholder) args.push(authUrl);

    return await new Promise<boolean>((resolve) => {
      const child = spawn(executable, args, { stdio: "ignore", detached: true, shell: false });
      let started = false;
      let settled = false;
      const onSpawn = () => { started = true; };
      const onExit = (code: number | null) => finish(started && code === 0);
      const finish = (opened: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("spawn", onSpawn);
        child.removeListener("exit", onExit);
        child.unref();
        resolve(opened);
      };
      // Browsers and some openers stay alive. Leave them running independently.
      const timer = setTimeout(() => finish(started), 3000);
      child.once("spawn", onSpawn);
      child.once("exit", onExit);
      // Keep the error handler after the deadline to absorb a late launch failure.
      child.once("error", () => finish(false));
    });
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

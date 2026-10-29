// @ts-check
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertTempoDrainDecisions } from "./consumer-tempo-decisions.mjs";
import { isHealthyResponse } from "./consumer-health.mjs";
import { scaffoldInstallCommand } from "./consumer-install.mjs";
import { cleanupAll, INSTALL_COMMAND_TIMEOUT_MS, observeProcess, preservePrimaryFailure, processCommand, removeTemporaryDirectory, stopProcess, waitForProcessClose } from "./consumer-process.mjs";

const RELOAD_TIMEOUT_MS = 30_000;

const [cliPath, ...flags] = process.argv.slice(2);
if (!cliPath) fail("pass the installed package's dist/dvmctl.js path");
if (flags.some((flag) => flag !== "--full")) fail("only --full is supported");
const full = flags.includes("--full");
const root = mkdtempSync(join(tmpdir(), "dvmctl-consumer-"));
const config = join(root, "config");
const servers = new Set();
/** @type {Awaited<ReturnType<typeof suspendedPlatform>> | undefined} */
let platformServer;
await preservePrimaryFailure(async () => {
  await command(cliPath, ["--version"]);
  assertInstalledPackage(cliPath);
  await assertTempoDrainDecisions(cliPath);
  const project = join(root, "first-project");
  await scaffold(cliPath, project);
  await install(project);
  // The matrix also tests the CLI's Node 22.0 minimum; scaffold tools require 22.12+.
  if (process.versions.node !== "22.0.0") await checkProject(project);
  await assertScaffold(cliPath, project);
  await command(cliPath, ["validate"], { cwd: project });
  await assertProjectEnvironment(cliPath, project);
  await live(cliPath, project, "dev", false);
  await live(cliPath, project, "dev", false, true);
  await assertDevReload(cliPath, project);
  await expectMissingDatabase(cliPath, project);
  if (full) {
    if (!process.env.DATABASE_URL) fail("--full requires DATABASE_URL for disposable PostgreSQL");
    await live(cliPath, project, "serve", true);
    const second = join(root, "second-project");
    await scaffold(cliPath, second);
    const excluded = ["node_modules", "dist", ".verify-logs", "sample.test.ts-snapshots"];
    for (const directory of excluded) {
      mkdirSync(join(second, directory), { recursive: true });
      writeFileSync(join(second, directory, "sentinel"), "excluded");
    }
    writeFileSync(join(second, "included.txt"), "included in both contexts");
    writeFileSync(join(second, "Dockerfile"), `FROM node:22-slim
WORKDIR /app
COPY . .
RUN test -f included.txt && test ! -e node_modules/sentinel && test ! -e dist/sentinel && test ! -e .verify-logs/sentinel && test ! -e sample.test.ts-snapshots/sentinel
CMD ["node", "-e", "process.exit(0)"]
`);
    const deployment = await command(cliPath, ["deploy", "--dry-run"], { cwd: second, capture: true });
    const result = lastJson(deployment.stdout);
    if (result.status !== "dry-run-ok" || result.docker_built !== true) fail("deploy dry run did not report a Docker build and dry-run-ok");
    await assertCloudArchive(cliPath, second, excluded);
    platformServer = await suspendedPlatform();
    const suspended = await processCommand(process.execPath, [resolve(cliPath), "deploy", "--local", "--name", "suspended-smoke", "--url", "http://127.0.0.1:1"], { cwd: second, capture: true, env: { ...environment(false), DVMKIT_API_KEY: "consumer-token", DVMKIT_PLATFORM_URL: platformServer.url } });
    const suspendedResult = lastJson(suspended.stdout);
    if (suspendedResult.status !== "suspended" || suspendedResult.suspensionReason !== "operator_hold") fail("local registration did not preserve the platform suspension state");
    const runtime = join(root, "runtime-project");
    await scaffold(cliPath, runtime);
    await install(runtime);
    await assertRuntimeImage(runtime);
  }
  await assertSdkMismatch(cliPath, project);
}, async () => {
  await cleanupAll([...servers].map((child) => async () => { if (!await stopProcess(child)) fail("a server process did not stop, so its temporary directory was retained"); }));
  if (platformServer) await closeServer(platformServer.server);
  await removeTemporaryDirectory(root);
});

/** @param {string} cli @param {string} project */ async function scaffold(cli, project) { await command(cli, ["create", project, "--name", "Smoke DVM", "--description", "Smoke"]); }
/** @param {string} cli @param {string} project */
async function assertScaffold(cli, project) {
  const handler = readFileSync(join(project, "handler.ts"), "utf8");
  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  if (!agents.includes("@dvmkit/dvmctl/skill")) fail("scaffold did not include bundled-skill instructions");
  const before = readFileSync(join(project, "handler.ts"));
  const collision = await processCommand(process.execPath, [resolve(cli), "create", project], { env: environment(false), capture: true, allowFailure: true });
  const body = lastJson(collision.stdout);
  if (collision.code === 0 || body.error?.code !== "scaffold_destination_exists") fail("scaffold collision was not rejected with its machine-readable error");
  if (!readFileSync(join(project, "handler.ts")).equals(before)) fail("scaffold collision overwrote an existing file");
  writeFileSync(join(project, "handler.ts"), handler.replace(/\n {2}price: [^\n]+,/, ""));
}
/** @param {string} project */ async function install(project) { const command = scaffoldInstallCommand(); await processCommand(command.executable, command.args, { cwd: project, env: environment(false), timeout: command.timeout }); }
/** @param {string} project */
async function checkProject(project) {
  if (process.platform === "win32") {
    await processCommand("cmd.exe", ["/d", "/s", "/c", "npm.cmd run typecheck && npm.cmd test"], { cwd: project, env: environment(false) });
  } else {
    await processCommand("npm", ["run", "typecheck"], { cwd: project, env: environment(false) });
    await processCommand("npm", ["test"], { cwd: project, env: environment(false) });
  }
}
/** @param {string} cli @param {string} project */
async function assertProjectEnvironment(cli, project) {
  const envPath = join(project, ".env");
  const port = await availablePort();
  writeFileSync(envPath, `# Project values override inherited values.\nPORT=${port}\n`);
  const child = spawn(process.execPath, [resolve(cli), "dev", "handler.ts", "--no-reload"], { cwd: project, detached: process.platform !== "win32", env: { ...environment(false), PORT: "not-a-port" }, stdio: "ignore" });
  observeProcess(child); servers.add(child); child.once("close", () => { servers.delete(child); });
  await preservePrimaryFailure(async () => {
    await waitFor(child, port, "/health", true);
    const platform = await capturedLocalPlatform();
    try {
      await processCommand(process.execPath, [resolve(cli), "deploy", "--local", "--name", "environment-smoke"], { cwd: project, capture: true, env: { ...environment(false), PORT: "65535", DVMKIT_API_KEY: "consumer-token", DVMKIT_PLATFORM_URL: platform.url } });
      const captureError = platform.captureError();
      if (captureError) throw captureError;
      if (platform.requests.length !== 1 || platform.requests[0].url !== `http://localhost:${port}`) fail("local deploy did not use the project PORT from .env");
    } finally { await closeServer(platform.server); }
  }, async () => { await stop(child); });

  rmSync(envPath);
  mkdirSync(envPath);
  const privateValue = "consumer-private-value";
  writeFileSync(join(envPath, "sentinel"), privateValue);
  try {
    const doctor = await processCommand(process.execPath, [resolve(cli), "doctor"], { cwd: project, capture: true, allowFailure: true, env: environment(false) });
    const result = lastJson(doctor.stdout);
    if (doctor.code === 0 || result.error?.code !== "project_env_unreadable" || result.error?.error_code !== "EISDIR") fail("doctor did not expose an unreadable project .env as a structured error");
    if (`${doctor.stdout}\n${doctor.stderr}`.includes(privateValue)) fail("unreadable project .env error exposed file content");
  } finally { rmSync(envPath, { recursive: true, force: true }); }
}
/** @param {string} cli @param {string} project @param {"dev" | "serve"} mode @param {boolean} database @param {boolean} [noReload] */
async function live(cli, project, mode, database, noReload = false) {
  const port = await availablePort();
  const args = [mode, "handler.ts", "--port", String(port), ...(noReload ? ["--no-reload"] : [])];
  const child = start(cli, args, { cwd: project, database });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const cliManifest = JSON.parse(readFileSync(resolve(cli, "../../package.json"), "utf8"));
  const servingVersion = cliManifest.dependencies["@dvmkit/sdk"];
  const projectVersion = JSON.parse(readFileSync(join(project, "node_modules/@dvmkit/sdk/package.json"), "utf8")).version;
  await preservePrimaryFailure(async () => {
    await waitFor(child, port, "/health", true);
    await until(() => stdout.includes(`Serving SDK: @dvmkit/sdk ${servingVersion}`), { child, output: () => stdout + stderr }, () => "serving banner did not name the CLI SDK");
    if (mode === "dev") {
      await waitFor(child, port, "/_dev", false);
      const page = await getResponse(port, "/_dev");
      if (!page?.body.includes(`Serving @dvmkit/sdk ${servingVersion}`)) fail("development page did not name the serving SDK");
    } else {
      const response = await getResponse(port, "/_dev");
      if (response?.statusCode !== 404) fail("production serve did not return 404 for the development page");
    }
    await assertTypedJob(port);
    if (projectVersion !== servingVersion) {
      await until(() => stderr.includes(`dvmctl serves with @dvmkit/sdk ${servingVersion}`) && stderr.includes(`project has @dvmkit/sdk ${projectVersion} installed`), { child, output: () => stdout + stderr }, () => "SDK mismatch warning did not name both versions");
    } else if (stderr.includes("Warning: dvmctl serves with @dvmkit/sdk")) fail("matching SDK versions produced a mismatch warning");
  }, async () => { await stop(child); });
}
/** @param {string} cli @param {string} project */
async function assertSdkMismatch(cli, project) {
  const manifestPath = join(project, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies["@dvmkit/sdk"] = "0.16.1";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await install(project);
  await live(cli, project, "dev", false);
  await live(cli, project, "dev", false, true);
  if (full) await live(cli, project, "serve", true);
}
/** @param {string} cli @param {string} project */
async function assertDevReload(cli, project) {
  const handlerPath = join(project, "handler.ts");
  const helperPath = join(project, "helper.ts");
  const original = readFileSync(handlerPath, "utf8");
  // Outside the project, so recording a serving process never looks like a source edit.
  const servingLog = join(root, "dev-serving-pids");
  const handler = original
    .replace('import { configureDVM, z } from "@dvmkit/sdk";', `import { appendFileSync } from "node:fs";\nimport { configureDVM, z } from "@dvmkit/sdk";\nimport { label } from "./helper";\n\nappendFileSync(${JSON.stringify(servingLog)}, process.pid + "\\n");`)
    .replace("ctx.complete(ctx.input.text);", "ctx.complete(label(ctx.input.text));");
  if (!handler.includes('from "./helper"') || !handler.includes("label(ctx.input.text)")) fail("scaffold handler no longer accepts the local helper fixture");
  /** @param {string} source */
  const writeHelper = (source) => { writeFileSync(helperPath, `export function label(text: string): string { return ${source}; }\n`); };
  writeFileSync(handlerPath, handler);
  writeHelper('"v1:" + text');
  const port = await availablePort();
  const child = spawn(process.execPath, [resolve(cli), "dev", "handler.ts", "--port", String(port)], { cwd: project, detached: process.platform !== "win32", env: environment(false), stdio: ["ignore", "pipe", "pipe"] });
  observeProcess(child); servers.add(child); child.once("close", () => { servers.delete(child); });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) { stream?.setEncoding("utf8"); stream?.on("data", (chunk) => { output += chunk; }); }
  const dev = { child, output: () => output };
  await preservePrimaryFailure(async () => {
    await until(() => get(port, "/health", true), dev, () => "dev did not become healthy");
    if (await jobSummary(port) !== "v1:reload smoke") fail("dev did not serve the handler's local helper");

    writeHelper('"v2:" + text');
    await awaitSummary(dev, port, "v2:reload smoke", "saving only a local helper did not reload dev");

    const beforeError = output.length;
    writeHelper('"broken:" + ;');
    await until(() => /helper\.ts:1:\d+/u.test(output.slice(beforeError)), dev, () => `a helper syntax error did not print its file and line: ${output.slice(beforeError)}`);
    if (await jobSummary(port) !== "v2:reload smoke") fail("the previous version stopped answering after a failed reload");
    writeHelper('"v3:" + text');
    await awaitSummary(dev, port, "v3:reload smoke", "fixing the helper did not recover dev");

    if (!child.pid) fail("dev process has no id");
    // A terminal delivers Ctrl-C to the whole foreground process group. Windows
    // cannot signal another process that way; Node terminates dev outright
    // there, and every serving process must still exit with it.
    if (process.platform === "win32") child.kill("SIGINT"); else process.kill(-child.pid, "SIGINT");
    await until(() => child.exitCode !== null || child.signalCode !== null, undefined, () => "dev did not exit after SIGINT");
    if (process.platform !== "win32" && child.exitCode !== 0) fail(`dev did not shut down cleanly after SIGINT (${child.exitCode ?? child.signalCode}): ${output}`);
    const serving = servingPids();
    if (serving.length === 0) fail("dev did not record a serving process");
    await until(() => serving.every((pid) => !running(pid)), undefined, () => "a dev serving process outlived SIGINT");
    if (!await portClosed(port)) fail("dev left its port listening after SIGINT");
    console.log(`consumer smoke: dev reloaded an edited helper, kept serving through a syntax error, and released ${serving.length} serving processes and its port on SIGINT`);
  }, async () => {
    try {
      await stop(child);
    } finally {
      // Elsewhere stop() signals dev's whole process group, serving processes included. On Windows
      // it cannot reach them once dev has exited, so one that outlived dev would outlive the smoke too.
      if (process.platform === "win32") for (const pid of servingPids()) if (running(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* It exited after the check. */ } }
      writeFileSync(handlerPath, original);
      rmSync(helperPath, { force: true });
    }
  });
  function servingPids() { return existsSync(servingLog) ? readFileSync(servingLog, "utf8").split("\n").filter(Boolean).map(Number) : []; }
}
/** @param {number} port @returns {Promise<string | null>} */
async function jobSummary(port) {
  try {
    const submitted = await postJson(port, "/v1/job", { capability: "first-project", input: JSON.stringify({ text: "reload smoke" }) });
    return submitted.statusCode === 200 && submitted.body.status === "completed" && typeof submitted.body.summary === "string" ? submitted.body.summary : null;
  } catch {
    // The port is briefly closed while one serving process replaces another.
    return null;
  }
}
/** @typedef {{ child: import("node:child_process").ChildProcess, output: () => string }} DevProcess */
/** @param {DevProcess} dev @param {number} port @param {string} expected @param {string} message */
async function awaitSummary(dev, port, expected, message) {
  /** @type {string | null} */
  let last = null;
  await until(async () => { last = await jobSummary(port); return last === expected; }, dev, () => `${message} (last summary: ${JSON.stringify(last)})`);
}
/** @param {() => boolean | Promise<boolean>} check @param {DevProcess | undefined} dev @param {() => string} message */
async function until(check, dev, message) {
  const deadline = Date.now() + RELOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (dev && (dev.child.exitCode !== null || dev.child.signalCode !== null)) {
      // Output can trail the exit event, and a native abort prints its reason last.
      await waitForProcessClose(dev.child, 5_000);
      fail(`dev exited unexpectedly (${dev.child.exitCode ?? dev.child.signalCode}); its output:\n${dev.output()}`);
    }
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  fail(message());
}
/** @param {number} pid */
function running(pid) { try { process.kill(pid, 0); return true; } catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); } }
/** The SDK listens on every interface, so a refused loopback connection means nothing holds the port. @param {number} port @returns {Promise<boolean>} */
function portClosed(port) { return new Promise((done) => { const socket = connect({ host: "127.0.0.1", port }); socket.once("connect", () => { socket.destroy(); done(false); }); socket.once("error", (error) => { done("code" in error && error.code === "ECONNREFUSED"); }); }); }
/** @param {string} cli @param {string} project */
async function expectMissingDatabase(cli, project) { const result = await processCommand(process.execPath, [resolve(cli), "serve", "handler.ts", "--port", String(await availablePort())], { cwd: project, env: environment(false), capture: true, allowFailure: true, timeout: 20_000 }); const body = lastJson(result.stdout); if (result.code === 0 || body.error?.code !== "production_database_required" || !body.error?.hint?.includes("DATABASE_URL")) fail("serve did not fail with the actionable PostgreSQL configuration error"); }
/** @param {string} cli @param {string[]} args @param {{cwd?: string, capture?: boolean}} [options] */ function command(cli, args, options = {}) { return processCommand(process.execPath, [resolve(cli), ...args], { ...options, env: environment(false) }); }
/** @param {string} cli @param {string[]} args @param {{cwd: string, database: boolean}} options */ function start(cli, args, options) { const child = spawn(process.execPath, [resolve(cli), ...args], { cwd: options.cwd, detached: process.platform !== "win32", env: environment(options.database), stdio: ["ignore", "pipe", "pipe"] }); observeProcess(child); servers.add(child); child.once("close", () => { servers.delete(child); }); return child; }
/** @param {import("node:child_process").ChildProcess} child @param {number} port @param {string} path @param {boolean} health */ async function waitFor(child, port, path, health) { for (let attempt = 0; attempt < 100; attempt += 1) { if (child.exitCode !== null) throw new Error(`server exited before ${path} became ready (${child.exitCode})`); if (await get(port, path, health)) return; await new Promise((done) => setTimeout(done, 100)); } throw new Error(`server did not make ${path} ready`); }
/** @param {number} port @param {string} path @param {boolean} health */ async function get(port, path, health) { const response = await getResponse(port, path); return response !== null && (health ? isHealthyResponse(response.statusCode, response.body) : response.statusCode === 200); }
/** @param {number} port @param {string} path @returns {Promise<{ statusCode: number | undefined, body: string } | null>} */ function getResponse(port, path) { return new Promise((done) => { const probe = request({ host: "127.0.0.1", port, path, timeout: 500 }, (response) => { let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { body += chunk; }); response.on("end", () => { done({ statusCode: response.statusCode, body }); }); }); probe.once("error", () => done(null)); probe.once("timeout", () => { probe.destroy(); done(null); }); probe.end(); }); }
/** @param {import("node:child_process").ChildProcess} child */ async function stop(child) { if (!await stopProcess(child)) fail("server process did not stop"); }
function availablePort() { return new Promise((done, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") reject(new Error("could not allocate a local port")); else server.close((error) => error ? reject(error) : done(address.port)); }); }); }
/** @param {number} port */
async function assertTypedJob(port) {
  const submitted = await postJson(port, "/v1/job", { capability: "first-project", input: JSON.stringify({ text: "typed smoke" }) });
  if (submitted.statusCode !== 200 || submitted.body.status !== "completed" || submitted.body.summary !== "typed smoke" || typeof submitted.body.job_id !== "string") fail("typed free job did not complete");
  const messages = await getJson(port, `/v1/job/${submitted.body.job_id}/messages`, submitted.body.job_token);
  if (messages.statusCode !== 200 || !Array.isArray(messages.body.messages) || !messages.body.messages.some((/** @type {{type?: string, content?: {name?: string, mime_type?: string}}} */ message) => message?.type === "artifact" && message?.content?.name === "result.json" && message?.content?.mime_type === "application/json")) fail("typed completed job did not retain its artifact");
}
/** @param {number} port @param {string} path @param {unknown} body */
function postJson(port, path, body) { return jsonRequest(port, path, "POST", body); }
/** @param {number} port @param {string} path @param {string | undefined} token */
function getJson(port, path, token) { return jsonRequest(port, path, "GET", undefined, token); }
/** @param {number} port @param {string} path @param {string} method @param {unknown} [body] @param {string} [token] @returns {Promise<{statusCode: number | undefined, body: any}>} */
function jsonRequest(port, path, method, body, token) { return new Promise((resolve, reject) => { const encoded = body === undefined ? undefined : JSON.stringify(body); const req = request({ host: "127.0.0.1", port, path, method, timeout: 10_000, headers: { ...(encoded ? { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } : {}), ...(token ? { "x-job-token": token } : {}) } }, (res) => { let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { try { resolve({ statusCode: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } }); }); req.once("error", reject); req.once("timeout", () => req.destroy(new Error("job request timed out"))); if (encoded) req.write(encoded); req.end(); }); }
/** @param {string} project */
async function assertRuntimeImage(project) {
  const tag = `dvmctl-consumer-${process.pid}-${Date.now()}`;
  try {
    await processCommand("docker", ["build", "--tag", tag, project], { timeout: INSTALL_COMMAND_TIMEOUT_MS });
    const result = await processCommand("docker", ["run", "--rm", "--entrypoint", "node", tag, "--input-type=module", "-e", "await import('@dvmkit/sdk'); await import('pg'); const names=['@dvmkit/sdk','pg','vitest','typescript']; console.log(JSON.stringify(Object.fromEntries(names.map((name) => { try { return [name, import.meta.resolve(name)]; } catch { return [name, null]; } }))));"], { capture: true });
    const modules = lastJson(result.stdout);
    if (!modules["@dvmkit/sdk"] || !modules.pg || modules.vitest) fail(`runtime image did not retain SDK and pg while pruning Vitest: ${JSON.stringify(modules)}`);
    if (!modules.typescript) fail("runtime image did not retain TypeScript through the SDK production optional-peer graph");
  } finally {
    await processCommand("docker", ["image", "rm", "--force", tag], { allowFailure: true });
  }
}
async function capturedLocalPlatform() {
  /** @type {Array<Record<string, unknown>>} */
  const requests = [];
  /** @type {unknown} */
  let observedError;
  const server = createHttpServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/api/v1/builder/deploy/local") { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("local deploy request was not an object");
      requests.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dvmId: "consumer-dvm", slug: "environment-smoke", url: body.url, status: "deployed", paused: false, suspensionReason: null, dvmkitUrl: null }));
    })().catch((error) => { observedError = error; res.writeHead(500).end(); });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("consumer smoke: could not bind platform fixture");
  return { server, url: `http://127.0.0.1:${address.port}`, requests, captureError: () => observedError };
}
async function suspendedPlatform() {
  const server = createHttpServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/builder/deploy/local") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ dvmId: "consumer-dvm", slug: "suspended-smoke", url: "http://127.0.0.1:1", status: "suspended", paused: false, suspensionReason: "operator_hold", dvmkitUrl: null }));
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("consumer smoke: could not bind platform fixture");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
/** @param {import("node:http").Server} server @returns {Promise<void>} */
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
/** @param {import("node:http").Server} server @returns {Promise<void>} */
function closeServer(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
/** @param {string} cli @param {string} project @param {string[]} excluded */
async function assertCloudArchive(cli, project, excluded) {
  /** @type {Buffer | undefined} */
  let archive;
  /** @type {unknown} */
  let captureError;
  const server = createHttpServer((req, res) => {
    void (async () => {
      if (req.method === "GET" && req.url === "/api/v1/builder/auth/me") { res.writeHead(200).end("{}"); return; }
      if (req.method !== "POST" || req.url !== "/api/v1/builder/deploy") { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      const tarball = form.get("tarball");
      if (!(tarball instanceof Blob)) throw new Error("cloud upload omitted tarball");
      archive = Buffer.from(await tarball.arrayBuffer());
      res.writeHead(422, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "consumer_capture_complete", message: "Archive captured; no deployment created." } }));
    })().catch((error) => { captureError = error; res.writeHead(500).end(); });
  });
  await listen(server);
  try {
    const address = server.address();
    if (!address || typeof address === "string") fail("could not bind cloud archive fixture");
    await command(cli, ["identity", "create"]);
    const result = await processCommand(process.execPath, [resolve(cli), "deploy", "--name", "cloud-smoke", "--allow-dirty"], { cwd: project, capture: true, allowFailure: true, env: { ...environment(false), DVMKIT_API_KEY: "consumer-token", DVMKIT_PLATFORM_URL: `http://127.0.0.1:${address.port}` } });
    if (captureError) throw captureError;
    if (!archive || result.code === 0 || lastJson(result.stdout).error?.code !== "consumer_capture_complete") fail("cloud deploy did not reach the archive capture fixture");
    const archivePath = join(root, "cloud-upload.tar.gz");
    writeFileSync(archivePath, archive);
    const files = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).split("\n").map((file) => file.replace(/^\.\//u, ""));
    if (!files.includes("included.txt") || !files.includes("Dockerfile")) fail("cloud archive omitted required build inputs");
    if (excluded.some((directory) => files.some((file) => file.startsWith(`${directory}/`)))) fail("cloud archive included excluded build inputs");
    console.log("consumer smoke: dry-run Docker and captured cloud archive both exclude dependency, build, log, and snapshot sentinels");
  } finally { await closeServer(server); }
}
/** @param {string} cli */
function assertInstalledPackage(cli) {
  const packageRoot = resolve(cli, "..", "..");
  for (const path of ["skills/build-dvm/SKILL.md", "skills/build-dvm/deploying.md", "skills/build-dvm/new-builder.md", "skills/build-dvm/operating.md", "skills/build-dvm/recovery.md", "skills/build-dvm/references/content-holds.md", "skills/build-dvm/references/financial-export.md", "skills/build-dvm/references/lightning-credit-test.md", "skills/build-dvm/references/local-cashu-test.md", "skills/build-dvm/references/local-tempo-test.md", "skills/build-dvm/references/local-x402-test.md", "skills/build-dvm/references/tempo-close-reports.md", "skills/build-dvm/retirement.md", "skills/build-dvm/testing.md"]) if (!existsSync(join(packageRoot, path))) fail(`installed package omitted ${path}`);
}
/** @param {boolean} database */ function environment(database) { const env = { ...process.env }; for (const key of Object.keys(env)) if (/(TOKEN|SECRET|PRIVATE|API[_-]?KEY|NWC|WALLET|PLATFORM)/iu.test(key)) delete env[key]; delete env.DATABASE_URL; if (database) env.DATABASE_URL = process.env.DATABASE_URL; env.DVMCTL_CONFIG_DIR = join(config, "dvmctl"); env.DVMKIT_CONFIG_DIR = join(config, "dvmkit"); return env; }
/** @param {string} text */ function lastJson(text) { try { const value = JSON.parse(text.trim()); if (value && typeof value === "object") return value; } catch { /* CLI may emit a pretty JSON object after preceding output; parse lines below. */ } for (const line of text.trim().split("\n").reverse()) { try { const value = JSON.parse(line); if (value && typeof value === "object") return value; } catch { /* Non-JSON output lines are not the deployment result. */ } } fail("deploy did not return a JSON result"); }
/** @param {string} message @returns {never} */ function fail(message) { throw new Error(`consumer smoke: ${message}`); }

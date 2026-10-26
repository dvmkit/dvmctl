// @ts-check
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readLatest, assertPostPublishLatest, inspectPublishedRelease, PROPAGATION_ATTEMPTS, PROPAGATION_RETRY_DELAY_MS, PROPAGATION_TIMEOUT_MS, publishArchive, publishRelease as productionPublishRelease, verifyPublishedRelease as productionVerifyPublishedRelease } from "../scripts/publish-release.mjs";
import { probeSigning } from "../scripts/release-tag.mjs";
import { isHealthyResponse } from "../scripts/consumer-health.mjs";
import { scaffoldInstallCommand } from "../scripts/consumer-install.mjs";
import { installPublishedRelease, isDvmctlPropagationFailure } from "../scripts/install-published-release.mjs";
import { cleanupAll, INSTALL_COMMAND_TIMEOUT_MS, PROCESS_STOP_TIMEOUT_MS, observeProcess, preservePrimaryFailure, processCommand, processTreeTerminationCommand, stopProcess, waitForProcessClose } from "../scripts/consumer-process.mjs";

const root = resolve(import.meta.dirname, "..");
const commit = "a".repeat(40);
import { archiveIdentity } from "../scripts/publish-release.mjs";

const selectedSdkVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@dvmkit/sdk"];

test("consumer scaffold install uses a fixed Windows command and direct Unix npm", () => {
  assert.deepEqual(scaffoldInstallCommand("win32"), { executable: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd install --@dvmkit:registry=https://registry.npmjs.org/"], timeout: 600_000 });
  for (const platform of /** @type {const} */ (["darwin", "linux"])) {
    assert.deepEqual(scaffoldInstallCommand(platform), { executable: "npm", args: ["install", "--@dvmkit:registry=https://registry.npmjs.org/"], timeout: 300_000 });
  }
  const consumer = readFileSync(join(root, "scripts/consumer-smoke.mjs"), "utf8");
  const installUsesPlatformTimeout = /const command = scaffoldInstallCommand\(\); await processCommand\(command\.executable, command\.args, \{[^}]*timeout: command\.timeout \}\)/;
  assert.match(consumer, installUsesPlatformTimeout);
  assert.doesNotMatch("const command = scaffoldInstallCommand(); await processCommand(command.executable, command.args, { cwd: project, timeout: INSTALL_COMMAND_TIMEOUT_MS })", installUsesPlatformTimeout);
  assert.match(consumer, /removeTemporaryDirectory\(root\)/);
});

test("release automation leaves README installs independent of the package version", () => {
  const config = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8"));
  const assertNoReadmeRewrite = (extraFiles) => assert.ok(!extraFiles.includes("README.md"), "README must not be version-rewritten");
  assertNoReadmeRewrite(config.packages["."]["extra-files"] ?? []);
  assert.throws(() => assertNoReadmeRewrite(["README.md"]), /README must not be version-rewritten/);
});

test("consumer timeout termination kills the full process tree before cleanup", () => {
  assert.deepEqual(processTreeTerminationCommand(123, "win32"), { executable: "taskkill.exe", args: ["/pid", "123", "/t", "/f"] });
  assert.deepEqual(processTreeTerminationCommand(123, "linux"), { executable: "kill", args: ["-TERM", "-123"] });
  assert.equal(INSTALL_COMMAND_TIMEOUT_MS, 300_000);
  assert.equal(PROCESS_STOP_TIMEOUT_MS, 10_000);
  assert.throws(() => processTreeTerminationCommand(0, "win32"), /process id/);
});

test("consumer command timeout reaps its child process before returning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-consumer-process-test-"));
  const script = join(directory, "parent.mjs");
  const childPid = join(directory, "child.pid");
  const childExit = join(directory, "child-exit");
  writeFileSync(script, 'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, ["-e", `process.once("SIGTERM", () => { require("node:fs").writeFileSync(process.argv[1], "terminated"); process.exit(0); }); setInterval(() => {}, 1_000);`, process.argv[3]], { stdio: "ignore" });\nwriteFileSync(process.argv[2], String(child.pid));\nprocess.once("SIGTERM", () => child.once("close", () => process.exit(0)));\nsetInterval(() => {}, 1_000);\n');
  /** @type {number | undefined} */ let descendantPid;
  /** @type {unknown | undefined} */ let failure;
  /** @type {unknown | undefined} */ let cleanupError;
  try {
    await assert.rejects(processCommand(process.execPath, [script, childPid, childExit], { timeout: 500 }), /^Error: node(?:\.exe)? \S*parent\.mjs \S+ \S+ timed out after 500ms$/);
    descendantPid = Number(readFileSync(childPid, "utf8"));
    if (process.platform === "win32") assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
    else assert.equal(readFileSync(childExit, "utf8"), "terminated");
  } catch (error) { failure = error;
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) cleanupError = error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
});

test("consumer cleanup preserves the primary failure after every cleanup attempt", async () => {
  const primary = new Error("primary failure");
  const cleanupFailures = [new Error("first cleanup failure"), new Error("second cleanup failure")];
  const attempted = [];
  await assert.rejects(preservePrimaryFailure(async () => { throw primary; }, async () => {
    await cleanupAll(cleanupFailures.map((failure) => async () => { attempted.push(failure); throw failure; }));
  }), (error) => error === primary);
  assert.deepEqual(attempted, cleanupFailures);
  await assert.rejects(preservePrimaryFailure(async () => undefined, async () => {
    await cleanupAll(cleanupFailures.map((failure) => async () => { throw failure; }));
  }), (error) => error instanceof AggregateError && error.errors.length === 2);
});

test("consumer process cleanup waits for close even after exit", async () => {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: 0 });
  let settled = false;
  const closed = waitForProcessClose(/** @type {import("node:child_process").ChildProcess} */ (child), 100).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("close", 0);
  assert.equal(await closed, true);
});

/** @param {number} pid */
function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}

test("consumer process cleanup kills a leaked grandchild after the leader already exited", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-consumer-process-test-"));
  const script = join(directory, "leader.mjs");
  const grandchildPidFile = join(directory, "grandchild.pid");
  const grandchildReadyFile = join(directory, "grandchild.ready");
  // Wait for the SIGTERM handler before stopping; otherwise startup timing bypasses SIGKILL escalation.
  writeFileSync(script, 'import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst grandchild = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1_000);`, process.argv[3]], { stdio: "ignore" });\ngrandchild.unref();\nwriteFileSync(process.argv[2], String(grandchild.pid));\n');
  const child = spawn(process.execPath, [script, grandchildPidFile, grandchildReadyFile], { detached: true, stdio: "ignore" });
  observeProcess(child);
  /** @type {number | undefined} */ let grandchildPid;
  /** @type {unknown | undefined} */ let failure;
  /** @type {unknown | undefined} */ let cleanupError;
  try {
    assert.equal(await waitForProcessClose(child, PROCESS_STOP_TIMEOUT_MS), true);
    grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
    assert.ok(running(grandchildPid));
    const readyDeadline = Date.now() + PROCESS_STOP_TIMEOUT_MS;
    while (!existsSync(grandchildReadyFile)) {
      assert.ok(Date.now() < readyDeadline, "grandchild never installed its SIGTERM handler");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await stopProcess(child), true);
    const deadline = Date.now() + 2_000;
    while (running(grandchildPid)) {
      assert.ok(Date.now() < deadline, "grandchild outlived stopProcess");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) { failure = error;
  } finally {
    if (grandchildPid && running(grandchildPid)) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) cleanupError = error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
});

test("consumer health accepts the published SDK response and rejects unhealthy replies", () => {
  assert.equal(isHealthyResponse(200, '{"status":"ok"}'), true);
  for (const body of ['{"status":"unhealthy"}', '{"ok":true}', "null", "garbage"]) {
    assert.equal(isHealthyResponse(200, body), false);
  }
  assert.equal(isHealthyResponse(503, '{"status":"ok"}'), false);
  const consumer = readFileSync(join(root, "scripts/consumer-smoke.mjs"), "utf8");
  assert.match(consumer, /isHealthyResponse\(response.statusCode, response.body\)/);
  assert.match(consumer, /response\?\.statusCode !== 404/);
});

test("unsolicited pull requests close only when opened without running their code", () => {
  const workflow = readFileSync(join(root, ".github/workflows/close-external-prs.yml"), "utf8");
  assert.match(workflow, /types:\s*\[opened\]/);
  assert.match(workflow, /head\.repo\.full_name != github\.repository/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.match(workflow, /gh pr close/);
});

test("artifact control rejects stable versions sent to the RC channel", () => {
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    const result = run("scripts/release-artifact.mjs", ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", "v1.2.3", "--version", "1.2.3", "--dist-tag", "next", "--commit", commit]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dist-tag must match/i);
  } finally { fixture.remove(); }
});

test("artifact control accepts stable latest and rejects RC latest and malformed versions", () => {
  for (const [version, channel, valid] of [["1.2.3", "latest", true], ["1.2.3-rc.4", "latest", false], ["1.2.3-beta.1", "next", false]]) {
    const fixture = makeArchive(version);
    try { withLegalFixtures((script) => {
      const result = run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", `v${version}`, "--version", version, "--dist-tag", channel, "--commit", commit]);
      assert.equal(result.status === 0, valid, result.stderr);
    }); } finally { fixture.remove(); }
  }
});

test("stable publishing uses latest and recovers exact bytes without a second publication", async () => {
  const fixture = makeArchive("1.2.3");
  try {
    let published = 0;
    const fetchFn = async (url) => String(url).includes(".tgz") ? response(readFileSync(fixture.archive)) : jsonResponse({ versions: published ? { "1.2.3": { name: "@dvmkit/dvmctl", version: "1.2.3", dist: { tarball: "https://registry.npmjs.org/dvmctl.tgz" } } } : {}, "dist-tags": { latest: published ? "1.2.3" : "1.2.2" } });
    const publishFn = (archive, channel) => { assert.equal(channel, "latest"); assert.equal(archive, fixture.archive); published += 1; return 0; };
    assert.equal(await publishRelease({ archive: fixture.archive, distTag: "latest", fetchFn, publishFn }), "published");
    assert.equal(await publishRelease({ archive: fixture.archive, distTag: "latest", fetchFn, publishFn }), "already-published");
    assert.equal(published, 1);
    await assert.rejects(publishRelease({ archive: fixture.archive, distTag: "next", fetchFn, publishFn }), /release channel/);
  } finally { fixture.remove(); }
});

test("RC publication preserves an existing stable latest and fails if publication moves it", async () => {
  for (const moved of [false, true]) {
    const fixture = makeArchive("1.2.3-rc.4");
    try {
      let published = false;
      const fetchFn = async (url) => String(url).includes(".tgz") ? response(readFileSync(fixture.archive)) : jsonResponse({ versions: published ? { "1.2.3-rc.4": { name: "@dvmkit/dvmctl", version: "1.2.3-rc.4", dist: { tarball: "https://registry.npmjs.org/dvmctl.tgz" } } } : {}, "dist-tags": { latest: moved && published ? "1.2.1" : "1.2.0", next: "1.2.3-rc.4" } });
      const operation = publishRelease({ archive: fixture.archive, distTag: "next", fetchFn, publishFn: () => { published = true; return 0; } });
      if (moved) await assert.rejects(operation, /latest does not match/);
      else assert.equal(await operation, "published");
    } finally { fixture.remove(); }
  }
});

test("artifact control records and re-verifies a deterministic package larger than the default exec buffer", () => {
  const fixture = makeArchive("1.2.3-rc.4", {}, 1_200_000);
  try {
    withLegalFixtures((script) => { const output = join(fixture.directory, "output"); mkdirSync(output);
      assert.equal(run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(output, "release-digest.json"), "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]).status, 0);
      const archiveCopy = join(output, "dvmctl.tgz"); writeFileSync(archiveCopy, readFileSync(fixture.archive));
      assert.equal(run(script, ["verify", "--directory", output, "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]).status, 0); });
  } finally { fixture.remove(); }
});

test("artifact control rejects numbered provenance in generated bundle bytes", () => {
  for (const prefix of ["regression", "REGRESSION", "Regression"]) {
    const fixture = makeArchive("1.2.3-rc.4");
    try {
      writeFileSync(join(fixture.directory, "package/dist/dvmctl.js"), `#!/usr/bin/env node\n// ${prefix}-${123456}: private provenance\n`);
      execFileSync("tar", ["-czf", fixture.archive, "package"], { cwd: fixture.directory });
      withLegalFixtures((script) => {
        const result = run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /archive contains non-public material in dist\/dvmctl\.js/);
        assert.equal(existsSync(join(fixture.directory, "digest.json")), false);
      });
    } finally { fixture.remove(); }
  }
});

test("artifact control rejects packed lifecycle hooks and manifest changes", () => {
  const fixture = makeArchive("1.2.3-rc.4", { scripts: { postinstall: "node steal.mjs" } });
  try {
    withLegalFixtures((script) => { const result = run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /forbidden postinstall lifecycle hook/); });
  } finally { fixture.remove(); }
  for (const extra of [{ bin: { other: "dist/dvmctl.js" } }, { dependencies: { "@dvmkit/sdk": "0.6.0-rc.1", "proper-lockfile": "4.1.2" } }, { dependencies: { "@dvmkit/sdk": selectedSdkVersion, "proper-lockfile": "4.1.2", other: "1.0.0" } }, { dependencies: { "@dvmkit/sdk": selectedSdkVersion } }, { dependencies: { "@dvmkit/sdk": selectedSdkVersion, "proper-lockfile": "4.1.1" } }, { exports: {} }, { peerDependencies: { other: "1" } }, { optionalDependencies: { other: "1" } }, { optionalDependencies: { pg: "8.20.0" } }, { optionalDependencies: { pg: "8.19.0", tsx: "^4" } }, { engines: { node: ">=23" } }, { license: "MIT" }, { publishConfig: { provenance: false } }, { repository: { url: "https://example.invalid/repo.git" } }, { scripts: { prepare: "node build.mjs" } }]) {
    const fixture = makeArchive("1.2.3-rc.4", extra);
    try { withLegalFixtures((script) => { const result = run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]); assert.notEqual(result.status, 0); }); } finally { fixture.remove(); }
  }
});

test("artifact control rejects a wrong package name independently of version and shape", () => {
  const fixture = makeArchive("1.2.3-rc.4", { name: "@example/wrong-package" });
  try {
    withLegalFixtures((script) => {
      const result = run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /archive package metadata does not match the release/);
      assert.equal(existsSync(join(fixture.directory, "digest.json")), false);
    });
  } finally { fixture.remove(); }
});

for (const omitted of ["retirement.md", "references/content-holds.md", "references/financial-export.md"]) test(`artifact control rejects omitted ${omitted} even without an inbound link`, () => {
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    rmSync(join(fixture.directory, "package/skills/build-dvm", omitted));
    execFileSync("tar", ["-czf", fixture.archive, "package"], { cwd: fixture.directory });
    withLegalFixtures((script) => {
      const result = run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /archive file list is not the standalone package shape/);
      assert.equal(existsSync(join(fixture.directory, "digest.json")), false);
    });
  } finally { fixture.remove(); }
});

test("artifact control rejects a repacked skill link despite identical archives", () => {
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    writeFileSync(join(fixture.directory, "package/skills/build-dvm/SKILL.md"), "[Outside](../../README.md)\n");
    execFileSync("tar", ["-czf", fixture.archive, "package"], { cwd: fixture.directory });
    withLegalFixtures((script) => {
      const result = run(script, ["create", "--first", fixture.archive, "--second", fixture.archive, "--output", join(fixture.directory, "digest.json"), "--tag", "v1.2.3-rc.4", "--version", "1.2.3-rc.4", "--dist-tag", "next", "--commit", commit]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid bundled skill links: .*link escapes bundled skill/);
    });
  } finally { fixture.remove(); }
});

test("publish recovery accepts an exact already-visible next artifact without publishing", async () => {
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    let published = 0;
    const fetchFn = async (url) => String(url).includes(".tgz") ? response(readFileSync(fixture.archive)) : jsonResponse({ versions: { "1.2.3-rc.4": { name: "@dvmkit/dvmctl", version: "1.2.3-rc.4", dist: { tarball: "https://registry.npmjs.org/dvmctl.tgz" } } }, "dist-tags": { next: "1.2.3-rc.4", latest: "0.0.0" } });
    assert.equal(await publishRelease({ archive: fixture.archive, distTag: "next", fetchFn, publishFn: () => { published += 1; return 0; } }), "already-published");
    assert.equal(published, 0);
  } finally { fixture.remove(); }
});

test("publisher waits for metadata and tarball propagation after its one publish", async () => {
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    let published = 0; let metadataReads = 0; const waits = [];
    const fetchFn = async (url) => {
      if (String(url).includes(".tgz")) return metadataReads < 5 ? new Response("missing", { status: 404 }) : response(readFileSync(fixture.archive));
      metadataReads += 1;
      if (metadataReads === 1) return jsonResponse({ "dist-tags": { latest: "0.0.0" } });
      if (metadataReads === 2 || metadataReads === 3) return new Response("missing", { status: 404 });
      return releaseMetadata("1.2.3-rc.4");
    };
    assert.equal(await publishRelease({ archive: fixture.archive, distTag: "next", fetchFn, publishFn: () => { published += 1; return 0; }, attempts: 4, waitFn: async (ms) => { waits.push(ms); } }), "published");
    assert.equal(published, 1); assert.deepEqual(waits, [PROPAGATION_RETRY_DELAY_MS, PROPAGATION_RETRY_DELAY_MS]);
  } finally { fixture.remove(); }
});

test("visible release with a pending tarball is recovered without a second publish", async () => {
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    let published = 0; let metadataReads = 0; const waits = [];
    const fetchFn = async (url) => {
      if (String(url).includes(".tgz")) return metadataReads < 5 ? new Response("missing", { status: 404 }) : response(readFileSync(fixture.archive));
      metadataReads += 1;
      if (metadataReads === 1) return jsonResponse({ "dist-tags": { latest: "0.0.0" } });
      if (metadataReads === 3) return new Response("missing", { status: 404 });
      return releaseMetadata("1.2.3-rc.4");
    };
    assert.equal(await publishRelease({ archive: fixture.archive, distTag: "next", fetchFn, publishFn: () => { published += 1; return 0; }, attempts: 4, waitFn: async (ms) => { waits.push(ms); } }), "already-published");
    assert.equal(published, 0); assert.deepEqual(waits, [PROPAGATION_RETRY_DELAY_MS, PROPAGATION_RETRY_DELAY_MS]);
  } finally { fixture.remove(); }
});

test("registry propagation keeps non-404 failures fatal and bounds default waits to three minutes", async () => {
  assert.equal(PROPAGATION_TIMEOUT_MS, 180_000); assert.equal(PROPAGATION_ATTEMPTS, 37);
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    const fetchFn = async (url) => String(url).includes(".tgz") ? new Response("unavailable", { status: 503 }) : releaseMetadata("1.2.3-rc.4");
    await assert.rejects(verifyPublishedRelease({ archive: fixture.archive, distTag: "next", fetchFn, attempts: 2, waitFn: async () => { throw new Error("must not wait"); } }), /tarball request failed \(503\)/);
  } finally { fixture.remove(); }
});

test("post-publish latest check retries only metadata 404s", async () => {
  let reads = 0; const waits = [];
  await assertPostPublishLatest("0.0.0", async () => {
    reads += 1; return reads === 1 ? new Response("missing", { status: 404 }) : jsonResponse({ "dist-tags": { latest: "0.0.0" } });
  }, 2, async (ms) => { waits.push(ms); });
  assert.deepEqual(waits, [PROPAGATION_RETRY_DELAY_MS]);
  await assert.rejects(assertPostPublishLatest("0.0.0", async () => jsonResponse({ "dist-tags": { latest: "1.2.3-rc.4" } }), 2, async () => { throw new Error("must not wait"); }), /latest (?:does not match|must be a stable)/);
  await assert.rejects(readLatest(async () => jsonResponse({ "dist-tags": { latest: "1.2.3-rc.4" } })), /latest (?:does not match|must be a stable)/);
  await assert.rejects(assertPostPublishLatest("0.0.0", async () => new Response("unavailable", { status: 503 }), 2, async () => { throw new Error("must not wait"); }), /channel metadata request failed \(503\)/);
  await assert.rejects(readLatest(async () => new Response("missing", { status: 404 })), /channel metadata request failed \(404\)/);
});

test("verify CLI cannot invoke npm publish while registry metadata is missing", () => {
  const fixture = makeArchive("1.2.3-rc.4"); const directory = mkdtempSync(join(tmpdir(), "dvmctl-verify-cli-test-"));
  try {
    const bin = join(directory, "bin"); const published = join(directory, "published"); const preload = join(directory, "preload.mjs"); mkdirSync(bin);
    writeFileSync(join(bin, "npm"), `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(published)}, "called");\n`); chmodSync(join(bin, "npm"), 0o755);
    writeFileSync(preload, 'globalThis.fetch = async () => new Response("missing", { status: 404 }); globalThis.setTimeout = (done) => { queueMicrotask(done); return 0; }; globalThis.clearTimeout = () => {};\n');
    const result = spawnSync(process.execPath, ["--import", preload, join(root, "scripts/verify-published-release.mjs"), "--archive", fixture.archive, "--dist-tag", "next", "--repository", "dvmkit/dvmctl", "--tag", "v1.2.3-rc.4", "--commit", commit], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /exact release did not appear/); assert.equal(existsSync(published), false);
  } finally { fixture.remove(); rmSync(directory, { recursive: true, force: true }); }
});

test("registry install retries only an exact dvmctl propagation error", async () => {
  const calls = []; const waits = [];
  await installPublishedRelease({ version: "1.2.3-rc.4", sdkVersion: "0.1.0-rc.7", prefix: root, attempts: 2, waitFn: async (ms) => { waits.push(ms); }, runNpm: (args) => {
    calls.push(args); return calls.length === 1 ? { status: 1, stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/dvmctl@1.2.3-rc.4." } : { status: 0 };
  } });
  assert.equal(calls.length, 2); assert.deepEqual(waits, [PROPAGATION_RETRY_DELAY_MS]);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvmctl/-/dvmctl-1.2.3-rc.4.tgz - Not found" }, "1.2.3-rc.4"), true);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit%2fdvmctl/-/sdk-1.2.3-rc.4.tgz - Not found" }, "1.2.3-rc.4"), false);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code E404\nnpm error 404 Not Found - GET https://example.invalid/@dvmkit%2fdvmctl/-/dvmctl-1.2.3-rc.4.tgz - Not found" }, "1.2.3-rc.4"), false);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/sdk@0.1.0-rc.7." }, "1.2.3-rc.4"), false);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/dvmctl@1.2.3-rc.40." }, "1.2.3-rc.4"), false);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/dvmctl@1.2.3-rc.4.1." }, "1.2.3-rc.4"), false);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/dvmctl@1.2.3-rc.4." }, "1.2.3-rc.4"), true);
  assert.equal(isDvmctlPropagationFailure({ stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/dvmctl@1.2.3-rc.4.\nnpm error code E401\nnpm error Unable to authenticate" }, "1.2.3-rc.4"), false);
});

test("registry install does not retry unrelated or persistent npm errors", async () => {
  let calls = 0;
  await assert.rejects(installPublishedRelease({ version: "1.2.3-rc.4", sdkVersion: "0.1.0-rc.7", prefix: root, attempts: 2, waitFn: async () => { throw new Error("must not wait"); }, runNpm: () => { calls += 1; return { status: 1, stderr: "npm error code E401\nnpm error Unable to authenticate" }; } }), /npm install failed/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(installPublishedRelease({ version: "1.2.3-rc.4", sdkVersion: "0.1.0-rc.7", prefix: root, attempts: 2, waitFn: async () => undefined, runNpm: () => { calls += 1; return { status: 1, stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/dvmctl@1.2.3-rc.4." }; } }), /did not propagate/);
  assert.equal(calls, 2);
});

test("publish recovery fails hard on a conflicting registry artifact", async () => {
  const fixture = makeArchive("1.2.3-rc.4");
  try {
    const fetchFn = async () => jsonResponse({ versions: { "1.2.3-rc.4": { name: "@dvmkit/dvmctl", version: "1.2.3-rc.4", dist: { tarball: "https://registry.npmjs.org/dvmctl.tgz" } } }, "dist-tags": { next: "1.2.3-rc.3", latest: "0.0.0" } });
    await assert.rejects(publishRelease({ archive: fixture.archive, distTag: "next", fetchFn, publishFn: () => { throw new Error("must not publish"); } }), /existing npm release does not match/);
  } finally { fixture.remove(); }
});

test("registry recovery rejects an off-origin tarball before reading its bytes", async () => {
  const result = await inspectPublishedRelease({ expected: { name: "@dvmkit/dvmctl", version: "1.2.3-rc.4", sha256: "a".repeat(64), distTag: "next" }, fetchFn: async () => jsonResponse({ versions: { "1.2.3-rc.4": { name: "@dvmkit/dvmctl", version: "1.2.3-rc.4", dist: { tarball: "https://example.invalid/dvmctl.tgz" } } }, "dist-tags": { next: "1.2.3-rc.4" } }) });
  assert.equal(result, "mismatch");
});

test("base-owned policy requires a signed human maintainer head for every control path", () => {
  const policy = readFileSync(join(root, ".github/workflows/release-policy-base-owned.yml"), "utf8");
  const pattern = policy.match(/protected='([^']+)'/)?.[1];
  assert.ok(pattern, "policy must define a protected-path predicate");
  const protectedPath = new RegExp(pattern);
  for (const path of [".github/workflows/new.yml", ".github/actions/x/action.yml", ".github/release-signers", "release-please-config.json", "scripts/release-artifact.mjs", "scripts/release-channel.mjs", "scripts/release-provenance.mjs", "scripts/sdk-version.mjs", "scripts/install-published-release.mjs", "scripts/check-commit-identity.mjs", "scripts/publish-release.mjs", "scripts/pinned-publish-npm.mjs", "scripts/release-tag.mjs", "scripts/public-safety.mjs", "scripts/check-source-boundary.mjs", "scripts/check-bundled-skills.mjs"]) assert.match(path, protectedPath);
  for (const path of [".release-please-manifest.json", "package.json", "package-lock.json", "CHANGELOG.md"]) assert.doesNotMatch(path, protectedPath);
  assert.doesNotMatch(policy, /actions\/checkout/);
  assert.doesNotMatch(policy, /pull_request_review/);
  assert.match(policy, /HEAD_REPOSITORY/);
  assert.match(policy, /AUTHOR_TYPE.*User/);
  assert.match(policy, /HEAD_SHA/);
  assert.match(policy, /git -C "\$policy_repo" .*verify-commit "\$HEAD_SHA"/);
  assert.match(policy, /265668992\+aioli3@users\.noreply\.github\.com namespaces="git" ssh-ed25519/);
  assert.match(policy, /http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic \$fetch_header/);
  assert.match(policy, /GIT_TERMINAL_PROMPT=0/);
  assert.match(policy, /unset fetch_header/);
});

test("base-owned policy inline shell remains valid after YAML block de-indentation", () => {
  const workflow = readFileSync(join(root, ".github/workflows/release-policy-base-owned.yml"), "utf8");
  const runStart = workflow.indexOf("        run: |\n");
  assert.notEqual(runStart, -1, "policy step must have an inline shell block");
  const blockStart = runStart + "        run: |\n".length;
  const lines = workflow.slice(blockStart).split("\n");
  const firstContentLine = lines.find((line) => line.trim().length > 0);
  assert.ok(firstContentLine, "inline shell block must not be empty");
  const blockIndent = firstContentLine.match(/^ */)?.[0].length ?? 0;
  const shell = lines.map((line) => line.slice(0, blockIndent) === " ".repeat(blockIndent) ? line.slice(blockIndent) : line).join("\n");
  const result = spawnSync("bash", ["-n"], { input: shell, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});


/** @param {string} workflow */
function policyShell(workflow) {
  const marker = "        run: |\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);
  return workflow.slice(start + marker.length).split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

/** @param {{body?: string, apiStatus?: number, timeoutStatus?: number, authorType?: string, author?: string, authorId?: string, headRepository?: string, signatureStatus?: number, files?: string, shell?: string}} options */
function runPolicy(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-policy-test-"));
  try {
    const calls = join(directory, "git-calls");
    const ghCalls = join(directory, "gh-calls");
    const binaries = {
      gh: `#!/bin/bash
printf '%s\n' "$*" >> "$GH_CALLS"
case "$*" in *'/files'*) printf '%s\n' "$FILES";; *) printf '%s\n' "$API_BODY"; exit "$API_STATUS";; esac
`,
      git: `#!/bin/bash
printf '%s\n' "$*" >> "$GIT_CALLS"
case "$*" in *verify-commit*) exit "$SIGNATURE_STATUS";; esac
`,
      timeout: `#!/bin/bash
if [ "$TIMEOUT_STATUS" != 0 ]; then exit "$TIMEOUT_STATUS"; fi
shift
exec "$@"
`,
    };
    for (const [name, source] of Object.entries(binaries)) {
      writeFileSync(join(directory, name), source); chmodSync(join(directory, name), 0o755);
    }
    const result = spawnSync("bash", ["-c", options.shell ?? policyShell(readFileSync(join(root, ".github/workflows/release-policy-base-owned.yml"), "utf8"))], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory, GH_TOKEN: "test-token", REPOSITORY: "example/project", NUMBER: "1", HEAD_REPOSITORY: options.headRepository ?? "example/project", AUTHOR: options.author ?? "maintainer", AUTHOR_ID: options.authorId ?? "123", AUTHOR_TYPE: options.authorType ?? "User", AUTHOR_ASSOCIATION: "CONTRIBUTOR", HEAD_SHA: commit,
        API_BODY: options.body ?? JSON.stringify({ permission: "admin", user: { id: 123, type: "User" } }), API_STATUS: String(options.apiStatus ?? 0), TIMEOUT_STATUS: String(options.timeoutStatus ?? 0), SIGNATURE_STATUS: String(options.signatureStatus ?? 0), FILES: options.files ?? "release-please-config.json", GIT_CALLS: calls, GH_CALLS: ghCalls },
    });
    return { ...result, gitCalls: existsSync(calls) ? readFileSync(calls, "utf8") : "", ghCalls: existsSync(ghCalls) ? readFileSync(ghCalls, "utf8") : "" };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("current repository access admits a signed human contributor with admin or write permission", () => {
  for (const permission of ["admin", "write"]) {
    const result = runPolicy({ body: JSON.stringify({ permission, role_name: "maintain", user: { id: 123, type: "User" } }) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.ghCalls, /--method GET repos\/example\/project\/collaborators\/maintainer\/permission/);
    assert.match(result.gitCalls, /fetch --quiet --no-tags origin/);
    assert.match(result.gitCalls, /verify-commit/);
  }
});

test("unauthorized or unavailable author permission fails before any signature fetch", () => {
  const cases = [
    { authorType: "Bot" }, { authorType: "Unknown" }, { headRepository: "outside/project" },
    { author: "maintainer/other" }, { authorId: "unknown" },
    { apiStatus: 1, body: "HTTP 404" }, { apiStatus: 1, body: "HTTP 403" }, { timeoutStatus: 124 },
    { body: "not-json" }, { body: "null" }, { body: "{}" }, { body: "" },
    { body: '{}\n{"permission":"admin","user":{"id":123,"type":"User"}}' },
    ...["read", "none", "unknown", "maintain"].map((permission) => ({ body: JSON.stringify({ permission, role_name: "custom-admin", user: { id: 123, type: "User" } }) })),
    { body: JSON.stringify({ permission: "admin", user: { id: 124, type: "User" } }) },
    { body: JSON.stringify({ permission: "admin", user: { id: "123", type: "User" } }) },
    { body: JSON.stringify({ permission: "admin", user: { id: 123, type: "Bot" } }) },
  ];
  for (const options of cases) {
    const result = runPolicy(options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.equal(result.gitCalls, "", JSON.stringify(options));
  }
});

test("valid maintainer permission does not excuse an invalid SSH signature", () => {
  const result = runPolicy({ signatureStatus: 1 });
  assert.notEqual(result.status, 0);
  assert.match(result.gitCalls, /verify-commit/);
});

test("ordinary release version files do not request protected-control authorization", () => {
  const result = runPolicy({ files: "package.json\npackage-lock.json\nCHANGELOG.md", apiStatus: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.ghCalls, /collaborators/);
  assert.equal(result.gitCalls, "");
});

test("pinned npm wrapper works from the repository ESM scope", () => {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-pinned-npm-esm-test-"));
  const tooling = mkdtempSync(join(root, ".pinned-npm-test-"));
  try {
    const output = join(directory, "version.txt"); const probe = join(directory, "probe.mjs");
    writeFileSync(probe, 'import { execFileSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], execFileSync("npm", ["--version"], { encoding: "utf8" }));\n');
    const result = spawnSync(process.execPath, [join(root, "scripts/pinned-publish-npm.mjs"), process.execPath, probe, output], { encoding: "utf8", env: { ...process.env, DVMCTL_RELEASE_TOOLING: tooling }, cwd: root });
    assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(output, "utf8").trim(), "11.16.0");
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(tooling, { recursive: true, force: true }); }
});

test("publisher invokes npm with provenance and the selected channel", () => {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-publish-command-test-")); const originalPath = process.env.PATH;
  try {
    const bin = join(directory, "bin"); mkdirSync(bin); const output = join(directory, "args.json"); const fakeNpm = join(bin, "npm");
    writeFileSync(fakeNpm, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));\n`); chmodSync(fakeNpm, 0o755);
    process.env.PATH = `${bin}:${originalPath}`;
    assert.equal(publishArchive("reviewed.tgz", "next"), 0);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), ["publish", "reviewed.tgz", "--tag", "next", "--provenance", "--ignore-scripts"]);
  } finally { process.env.PATH = originalPath; rmSync(directory, { recursive: true, force: true }); }
});

test("signing probe honors repository-local signing identity that a clone does not inherit", () => withIsolatedGitHome(() => {
  const fixture = makeSigningFixture();
  try { assert.doesNotThrow(() => probeSigning(fixture.directory)); } finally { fixture.remove(); }
}));

test("signing probe fails closed when no signing key is configured", () => withIsolatedGitHome(() => {
  const fixture = makeSigningFixture({ signingKey: false });
  try { assert.throws(() => probeSigning(fixture.directory), /effective user\.signingkey is not configured/); } finally { fixture.remove(); }
}));

test("signing probe fails closed when the signing key is not an allowed signer", () => withIsolatedGitHome(() => {
  const fixture = makeSigningFixture({ trusted: false });
  try { assert.throws(() => probeSigning(fixture.directory), /verify-tag/); } finally { fixture.remove(); }
}));

/** @param {string} version @param {Record<string, unknown>} [extraManifest] @param {number} [bundleBytes] */
function makeArchive(version, extraManifest = {}, bundleBytes = 0) {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-release-test-")); const packageRoot = join(directory, "package"); mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@dvmkit/dvmctl", version, bin: { dvmctl: "dist/dvmctl.js" }, dependencies: { "@dvmkit/sdk": selectedSdkVersion, "proper-lockfile": "4.1.2" }, exports: { "./skill": "./skills/build-dvm/SKILL.md" }, optionalDependencies: { pg: "8.20.0", tsx: "^4" }, engines: { node: ">=22" }, license: "Apache-2.0", publishConfig: { provenance: true }, repository: { url: "git+https://github.com/dvmkit/dvmctl.git" }, ...extraManifest }));
  writeFileSync(join(packageRoot, "LICENSE"), readFileSync(join(root, "test/fixtures/apache-license.txt"))); writeFileSync(join(packageRoot, "NOTICE"), readFileSync(join(root, "test/fixtures/apache-notice.txt"))); writeFileSync(join(packageRoot, "README.md"), "fixture\n");
  writeFileSync(join(packageRoot, "dist", "dvmctl.js"), "#!/usr/bin/env node\n" + "x".repeat(bundleBytes));
  for (const path of ["SKILL.md", "deploying.md", "new-builder.md", "operating.md", "recovery.md", "references/content-holds.md", "references/financial-export.md", "references/lightning-credit-test.md", "references/local-cashu-test.md", "references/local-tempo-test.md", "references/local-x402-test.md", "references/tempo-close-reports.md", "retirement.md", "testing.md"]) {
    const file = join(packageRoot, "skills", "build-dvm", path); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "fixture\n");
  }
  const archive = join(directory, "dvmctl.tgz"); execFileSync("tar", ["-czf", archive, "package"], { cwd: directory });
  return { directory, archive, remove: () => rmSync(directory, { recursive: true, force: true }) };
}
/** @param {string} script @param {string[]} args */
function run(script, args) { return spawnSync(process.execPath, [resolve(script), ...args], { encoding: "utf8" }); }
/** @param {string} version */
function releaseMetadata(version) { return jsonResponse({ versions: { [version]: { name: "@dvmkit/dvmctl", version, dist: { tarball: "https://registry.npmjs.org/dvmctl.tgz" } } }, "dist-tags": { next: version, latest: "0.0.0" } }); }
/** @param {(script: string) => void} run */ function withLegalFixtures(run) { const fixtureRoot = mkdtempSync(join(tmpdir(), "dvmctl-release-legal-root-")); const script = join(fixtureRoot, "scripts", "release-artifact.mjs"); try { mkdirSync(join(fixtureRoot, "scripts")); writeFileSync(script, readFileSync(join(root, "scripts/release-artifact.mjs"))); writeFileSync(join(fixtureRoot, "package.json"), readFileSync(join(root, "package.json"))); for (const helper of ["sdk-version.mjs", "release-channel.mjs"]) writeFileSync(join(fixtureRoot, "scripts", helper), readFileSync(join(root, "scripts", helper))); writeFileSync(join(fixtureRoot, "scripts/check-bundled-skills.mjs"), readFileSync(join(root, "scripts/check-bundled-skills.mjs"))); writeFileSync(join(fixtureRoot, "LICENSE"), readFileSync(join(root, "test/fixtures/apache-license.txt"))); writeFileSync(join(fixtureRoot, "NOTICE"), readFileSync(join(root, "test/fixtures/apache-notice.txt"))); run(script); } finally { rmSync(fixtureRoot, { recursive: true, force: true }); } }
/** @param {unknown} body */ function jsonResponse(body) { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }
/** @param {Buffer} body */ function response(body) { return new Response(body, { status: 200 }); }
/** @param {{signingKey?: boolean, trusted?: boolean}} [options] */
function makeSigningFixture({ signingKey = true, trusted = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dvmctl-signing-fixture-"));
  const runGit = (/** @type {string[]} */ args) => { const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
  runGit(["init", "--quiet"]); runGit(["config", "user.name", "Fixture Signer"]); runGit(["config", "user.email", "signer@example.invalid"]);
  writeFileSync(join(directory, "file.txt"), "fixture\n"); runGit(["add", "file.txt"]); runGit(["commit", "--quiet", "-m", "init"]);
  mkdirSync(join(directory, ".github"));
  let allowedSigners = "";
  if (signingKey) {
    const publicKey = generateSshKeypair(join(directory, "signing-key"), "fixture");
    runGit(["config", "user.signingkey", join(directory, "signing-key")]);
    const authorizedPublicKey = trusted ? publicKey : generateSshKeypair(join(directory, "decoy-key"), "decoy");
    allowedSigners = `signer@example.invalid namespaces="git" ${authorizedPublicKey}\n`;
  }
  writeFileSync(join(directory, ".github/release-signers"), allowedSigners);
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) };
}
/** @param {string} keyPath @param {string} comment @returns {string} */
function generateSshKeypair(keyPath, comment) {
  const keygen = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath], { encoding: "utf8" });
  assert.equal(keygen.status, 0, keygen.stderr);
  chmodSync(keyPath, 0o600);
  return readFileSync(`${keyPath}.pub`, "utf8").trim();
}
/** @param {() => void} fn */
function withIsolatedGitHome(fn) {
  const homeDirectory = mkdtempSync(join(tmpdir(), "dvmctl-signing-home-"));
  const originalHome = process.env.HOME; const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.HOME = homeDirectory; process.env.XDG_CONFIG_HOME = join(homeDirectory, ".config");
  try { fn(); } finally {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    rmSync(homeDirectory, { recursive: true, force: true });
  }
}

// Existing registry lifecycle cases receive valid external provenance, while still
// exercising the real publisher, byte checks, provenance binder, and retry loop.
function withProvenance(options) {
  const identity = archiveIdentity(options.archive);
  const repository = "dvmkit/dvmctl";
  const tag = `v${identity.version}`;
  const payload = { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1", subject: [{ name: `pkg:npm/%40dvmkit/dvmctl@${identity.version}`, digest: { sha512: identity.sha512 } }], predicate: { buildDefinition: { buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1", externalParameters: { workflow: { repository: "https://github.com/dvmkit/dvmctl", ref: `refs/tags/${tag}`, path: ".github/workflows/release.yml" } }, resolvedDependencies: [{ uri: `git+https://github.com/dvmkit/dvmctl@refs/tags/${tag}`, digest: { gitCommit: commit } }] }, runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } } } };
  const fetchFn = async (url, init) => {
    if (String(url) === "https://registry.npmjs.org/attestations/fixture") return jsonResponse({ attestations: [{ predicateType: payload.predicateType, bundle: { dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(payload)).toString("base64") } } }] });
    const response = await options.fetchFn(url, init);
    if (!response.ok || String(url).includes(".tgz")) return response;
    const metadata = await response.json();
    for (const version of Object.values(metadata.versions ?? {})) version.dist.attestations = { url: "https://registry.npmjs.org/attestations/fixture" };
    return jsonResponse(metadata);
  };
  return { ...options, repository, tag, commit, fetchFn, verifyBundleFn: async () => undefined };
}
const publishRelease = (options) => productionPublishRelease(withProvenance(options));
const verifyPublishedRelease = (options) => productionVerifyPublishedRelease(withProvenance(options));

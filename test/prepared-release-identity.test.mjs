// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
const commit = "a".repeat(40);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const availability = process.platform === "win32" ? "requires Unix executable stubs for the Ubuntu release shell" :
  ["bash", "jq"].find((command) => spawnSync(command, ["--version"], { timeout: 5000 }).status !== 0);
const shellOptions = { skip: availability ? `release shell unavailable: ${availability}` : false };

/** @param {string} section */
function shell(section) {
  const body = section.split("        run: |\n")[1];
  assert.ok(body, "workflow shell block is missing");
  return body.split("\n").filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");
}
const prepare = workflow.split("      - id: release\n")[1].split("\n  build:")[0];
const final = workflow.split("      - env:\n          GH_TOKEN:")[1];

/** @param {unknown} number @param {Record<string, unknown>} [overrides] */
function releasePr(number, overrides = {}) {
  return { number, merged_at: "2026-01-01T00:00:00Z", base: { ref: "master" }, merge_commit_sha: commit, labels: [{ name: "autorelease: pending" }], ...overrides };
}

/** @param {unknown[]} prs @param {(run: (stage: "prepare" | "final", identity?: string) => { status: number | null, stderr: string }, output: () => string, calls: () => string[][]) => void} check */
function withWorkflow(prs, check) {
  const directory = mkdtempSync(join(tmpdir(), "prepared-release-test-"));
  try {
    const outputPath = join(directory, "output");
    const callsPath = join(directory, "calls");
    writeFileSync(join(directory, "prs.json"), JSON.stringify(prs));
    const binaries = {
      git: `#!${process.execPath}
if (process.argv[2] === "rev-parse") console.log(${JSON.stringify(commit)});
else if (!["show-ref", "config", "verify-tag", "checkout", "merge-base"].includes(process.argv[2])) process.exit(90);
`,
      gh: `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "api" && args[1].startsWith("repos/example/project/commits/") && args[1].endsWith("/pulls") && args[2] === "--jq") {
  const result = spawnSync("jq", ["-er", args[3], process.env.PRS], { encoding: "utf8", timeout: 3000 });
  process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); process.exit(result.status ?? 91);
}
if (args[0] === "release" && args[1] === "view") process.exit(1);
else if (args[0] === "release" && args[1] === "create") process.exit(0);
else if (args[0] === "api" && ["POST", "DELETE"].includes(args[2]) && args[3].startsWith("repos/example/project/issues/")) process.exit(0);
else process.exit(92);
`,
    };
    for (const [name, body] of Object.entries(binaries)) {
      writeFileSync(join(directory, name), body);
      chmodSync(join(directory, name), 0o755);
    }
    /** @param {"prepare" | "final"} stage @param {string} [identity] */
    function run(stage, identity) {
      const env = { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, EVENT_NAME: "push", REF_NAME: `v${version}`, TAG: `v${version}`, REPOSITORY: "example/project", GITHUB_WORKSPACE: root, GITHUB_OUTPUT: outputPath, PRS: join(directory, "prs.json"), CALLS: callsPath };
      Reflect.deleteProperty(env, "PR_NUMBER");
      // Follow the workflow output wiring, so broken job/step mappings lose the identity.
      const jobOutput = workflow.match(/^ {6}pr-number: \$\{\{ steps.release.outputs.([^ }]+) \}\}$/m)?.[1];
      if (identity !== undefined && jobOutput === "pr-number" && final.includes("PR_NUMBER: ${{ needs.prepare.outputs.pr-number }}")) {
        Object.assign(env, { PR_NUMBER: identity });
      }
      return spawnSync("bash", ["-c", shell(stage === "prepare" ? prepare : final)], { cwd: root, encoding: "utf8", timeout: 10_000, env });
    }
    check(run, () => existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "", () => existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("labels use the exact prepared PR despite an unrelated merged release PR", shellOptions, () => {
  withWorkflow([releasePr(4), releasePr(9, { base: { ref: "maintenance" }, merge_commit_sha: "b".repeat(40) })], (run, output, calls) => {
    const prepared = run("prepare");
    assert.equal(prepared.status, 0, prepared.stderr);
    const identity = output().match(/^pr-number=(.*)$/m)?.[1];
    const completed = run("final", identity);
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(calls().filter((args) => args.includes("--method")), [
      ["api", "--method", "POST", "repos/example/project/issues/4/labels", "--raw-field", "labels[]=autorelease: tagged", "--silent"],
      ["api", "--method", "DELETE", "repos/example/project/issues/4/labels/autorelease%3A%20pending", "--silent"],
    ]);
    assert.equal(calls().filter((args) => args[1]?.endsWith("/pulls")).length, 1);
  });
});

test("prepare rejects zero or multiple exact merged master release PRs", shellOptions, () => {
  for (const prs of [[], [releasePr(9, { base: { ref: "maintenance" } })], [releasePr(9, { merge_commit_sha: "b".repeat(40) })], [releasePr(9, { merged_at: null })], [releasePr(9, { labels: [] })], [releasePr(4), releasePr(5)]]) {
    withWorkflow(prs, (run, output, calls) => {
      const result = run("prepare");
      assert.notEqual(result.status, 0, JSON.stringify(prs));
      assert.match(result.stderr, /expected one merged release PR/);
      assert.equal(output(), "");
      assert.equal(calls().filter((args) => args.includes("--method")).length, 0);
    });
  }
});

test("invalid prepared PR identity fails before notes or label writes", shellOptions, () => {
  for (const identity of [undefined, "", "0", "-1", "1.5", "04", "null", "4\n5", "4/labels", "1e2", " 4"]) {
    withWorkflow([releasePr(4)], (run, _output, calls) => {
      const result = run("final", identity);
      assert.notEqual(result.status, 0, String(identity));
      assert.match(result.stderr, /invalid prepared release PR number/);
      assert.deepEqual(calls(), []);
    });
  }
});

test("prepare does not export an invalid PR number from a unique exact match", shellOptions, () => {
  for (const identity of [null, 0, -1, 1.5, "bad", "04"]) {
    withWorkflow([releasePr(identity)], (run, output) => {
      const result = run("prepare");
      assert.notEqual(result.status, 0, String(identity));
      assert.equal(output(), "");
    });
  }
});

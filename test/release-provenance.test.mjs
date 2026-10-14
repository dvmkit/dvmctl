import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { publishRelease, verifyPublishedRelease } from "../scripts/publish-release.mjs";

const root = resolve(import.meta.dirname, "..");
const commit = "a".repeat(40);
const repository = "dvmkit/dvmctl";
const attestationsUrl = "https://registry.npmjs.org/attestations/release";

function fixture(version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "release-provenance-"));
  mkdirSync(join(directory, "package"));
  writeFileSync(join(directory, "package/package.json"), JSON.stringify({ name: "@dvmkit/dvmctl", version }));
  const archive = join(directory, "release.tgz");
  execFileSync("tar", ["-czf", archive, "package"], { cwd: directory });
  const bytes = readFileSync(archive);
  const tag = `v${version}`;
  const ref = `refs/tags/${tag}`;
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: `pkg:npm/%40dvmkit/dvmctl@${version}`, digest: { sha512: createHash("sha512").update(bytes).digest("hex") } }],
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { repository: "https://github.com/dvmkit/dvmctl", ref, path: ".github/workflows/release.yml" } },
        resolvedDependencies: [{ uri: `git+https://github.com/dvmkit/dvmctl@${ref}`, digest: { gitCommit: commit } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  const metadata = { versions: { [version]: { name: "@dvmkit/dvmctl", version, dist: { tarball: "https://registry.npmjs.org/release.tgz", attestations: { url: attestationsUrl } } } }, "dist-tags": { latest: version.includes("-rc.") ? "1.2.2" : version, next: version } };
  let reads = 0;
  let published = 0;
  const bundle = () => ({ dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(statement)).toString("base64") } });
  const options = {
    archive, distTag: version.includes("-rc.") ? "next" : "latest", repository, tag, commit,
    attempts: 2, waitFn: async () => undefined,
    fetchFn: async (url) => {
      if (String(url).endsWith(".tgz")) return new Response(bytes);
      if (String(url) === attestationsUrl) { reads += 1; return json({ attestations: [{ predicateType: statement.predicateType, bundle: bundle() }] }); }
      return json(metadata);
    },
    publishFn: () => { published += 1; return 0; },
    // Signature verification is the external boundary; source and subject binding remain real.
    verifyBundleFn: async (_bundle, policy) => {
      assert.equal(policy.certificateIssuer, "https://token.actions.githubusercontent.com");
      const pattern = new RegExp(policy.certificateIdentityURI);
      const identity = `https://github.com/dvmkit/dvmctl/.github/workflows/release.yml@${ref}`;
      assert.match(identity, pattern);
      for (const spoof of [`${identity}/other`, `https://evil.example/${identity}`, identity.replace("github.com", "githubXcom"), identity.replace("release.yml", "releaseXyml")]) assert.doesNotMatch(spoof, pattern);
    },
  };
  return { options, metadata, statement, bytes, bundle, reads: () => reads, published: () => published, remove: () => rmSync(directory, { recursive: true, force: true }) };
}
function json(value) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }

for (const version of ["1.2.3", "1.2.3-rc.4"]) test(`recovery verifies provenance without republishing ${version}`, async () => {
  const f = fixture(version);
  try {
    assert.equal(await publishRelease(f.options), "already-published");
    await verifyPublishedRelease(f.options);
    assert.equal(f.published(), 0);
    assert.equal(f.reads(), 2);
  } finally { f.remove(); }
});

for (const [label, mutate, error] of [
  ["wrong package", (s) => { s.subject[0].name = "pkg:npm/%40example/other@1.2.3"; }, /subject/],
  ["wrong archive digest", (s) => { s.subject[0].digest.sha512 = "b".repeat(128); }, /subject/],
  ["multiple subjects", (s) => { s.subject.push(s.subject[0]); }, /subject/],
  ["wrong repository", (s) => { s.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/example/other"; }, /source/],
  ["wrong workflow", (s) => { s.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; }, /source/],
  ["wrong tag", (s) => { s.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/master"; }, /source/],
  ["wrong commit", (s) => { s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); }, /source/],
  ["wrong source URI", (s) => { s.predicate.buildDefinition.resolvedDependencies[0].uri = "git+https://github.com/example/other@refs/tags/v1.2.3"; }, /source/],
  ["wrong build type", (s) => { s.predicate.buildDefinition.buildType = "unknown"; }, /source/],
  ["self-hosted builder", (s) => { s.predicate.runDetails.builder.id = "https://github.com/actions/runner/self-hosted"; }, /source/],
]) test(`both recovery paths reject ${label} despite exact registry bytes`, async () => {
  const f = fixture();
  try {
    mutate(f.statement);
    await assert.rejects(publishRelease(f.options), error);
    await assert.rejects(verifyPublishedRelease(f.options), error);
    assert.equal(f.published(), 0);
  } finally { f.remove(); }
});

test("missing attestations exhaust bounded propagation without republishing", async () => {
  const f = fixture();
  try {
    delete f.metadata.versions["1.2.3"].dist.attestations;
    let waits = 0;
    f.options.waitFn = async () => { waits += 1; };
    await assert.rejects(publishRelease(f.options), /did not appear/);
    await assert.rejects(verifyPublishedRelease(f.options), /did not appear/);
    assert.equal(waits, 2);
    assert.equal(f.published(), 0);
  } finally { f.remove(); }
});

test("attestation 404 propagation recovers within the existing bounded wait", async () => {
  const f = fixture();
  try {
    const fetchFn = f.options.fetchFn;
    let reads = 0;
    f.options.fetchFn = async (url) => String(url) === attestationsUrl && ++reads < 3 ? new Response("missing", { status: 404 }) : fetchFn(url);
    assert.equal(await publishRelease(f.options), "already-published");
    assert.equal(reads, 3);
    assert.equal(f.published(), 0);
  } finally { f.remove(); }
});

test("cryptographic rejection is fatal in both recovery paths", async () => {
  const f = fixture();
  try {
    f.options.verifyBundleFn = async () => { throw new Error("invalid signature or untrusted certificate"); };
    f.options.waitFn = async () => { throw new Error("must not retry invalid signatures"); };
    await assert.rejects(publishRelease(f.options), /invalid signature/);
    await assert.rejects(verifyPublishedRelease(f.options), /invalid signature/);
    assert.equal(f.published(), 0);
  } finally { f.remove(); }
});

test("an off-registry attestation URL is rejected before fetching it", async () => {
  const f = fixture();
  try {
    f.metadata.versions["1.2.3"].dist.attestations.url = "https://evil.example/attestations";
    const fetchFn = f.options.fetchFn;
    f.options.fetchFn = async (url) => { assert.notEqual(String(url), "https://evil.example/attestations"); return fetchFn(url); };
    await assert.rejects(publishRelease(f.options), /attestation URL/);
    assert.equal(f.published(), 0);
  } finally { f.remove(); }
});

test("SDK selection helper prints through a symlink and has no import output", () => {
  const directory = mkdtempSync(join(tmpdir(), "sdk-version-alias-"));
  try {
    const script = join(root, "scripts/sdk-version.mjs");
    const alias = join(directory, "selected-sdk.mjs");
    symlinkSync(script, alias);
    const result = spawnSync(process.execPath, [alias], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@dvmkit/sdk"]);
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../scripts/sdk-version.mjs", import.meta.url).href)})`], { encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

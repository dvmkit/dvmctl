// @ts-check
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const predicateType = "https://slsa.dev/provenance/v1";
const workflowPath = ".github/workflows/release.yml";
const registry = "https://registry.npmjs.org";

/** @typedef {{name: string, version: string, sha512: string, repository: string, tag: string, commit: string}} ProvenanceIdentity */
/** @typedef {(bundle: any, policy: {certificateIssuer: string, certificateIdentityURI: string}) => Promise<void>} BundleVerifier */

/** @param {ProvenanceIdentity} expected */
export function assertProvenanceIdentity(expected) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(expected.repository) || expected.tag !== `v${expected.version}` || !/^[a-f0-9]{40}$/u.test(expected.commit)) throw new Error("provenance requires the prepared repository, tag, and immutable commit");
}

/** @param {{expected: ProvenanceIdentity, attestations: any, fetchFn?: typeof fetch, verifyBundleFn?: BundleVerifier}} options */
export async function inspectProvenance({ expected, attestations, fetchFn = fetch, verifyBundleFn = verifyBundle }) {
  assertProvenanceIdentity(expected);
  if (!attestations) return "pending";
  if (typeof attestations.url !== "string" || new URL(attestations.url).origin !== registry) throw new Error("provenance attestation URL must use the npm registry");
  const response = await fetchFn(attestations.url, { cache: "no-store", redirect: "error" });
  if (response.status === 404) return "pending";
  if (!response.ok) throw new Error(`npm registry attestation request failed (${response.status})`);
  const metadata = await response.json();
  if (!Array.isArray(metadata?.attestations)) throw new Error("invalid npm attestation response");
  const provenance = metadata.attestations.filter((/** @type {any} */ attestation) => attestation.predicateType === predicateType);
  if (provenance.length === 0) return "pending";
  if (provenance.length !== 1) throw new Error("expected one npm provenance attestation");
  const bundle = provenance[0].bundle;
  const repository = `https://github.com/${expected.repository}`;
  const ref = `refs/tags/${expected.tag}`;
  const certificateIdentityURI = `^${`${repository}/${workflowPath}@${ref}`.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
  await verifyBundleFn(bundle, { certificateIssuer: "https://token.actions.githubusercontent.com", certificateIdentityURI });
  if (bundle?.dsseEnvelope?.payloadType !== "application/vnd.in-toto+json" || typeof bundle.dsseEnvelope.payload !== "string") throw new Error("invalid provenance envelope");
  const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  const subject = statement.subject;
  const definition = statement.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const dependencies = definition?.resolvedDependencies;
  const purl = `pkg:npm/${expected.name.replace("@", "%40")}@${expected.version}`;
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== predicateType || !Array.isArray(subject) || subject.length !== 1 || subject[0]?.name !== purl || subject[0]?.digest?.sha512 !== expected.sha512) throw new Error("provenance subject does not match the exact release archive");
  if (definition.buildType !== "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" || workflow?.repository !== repository || workflow?.path !== workflowPath || workflow?.ref !== ref || !Array.isArray(dependencies) || dependencies.length !== 1 || dependencies[0]?.uri !== `git+${repository}@${ref}` || dependencies[0]?.digest?.gitCommit !== expected.commit || statement.predicate?.runDetails?.builder?.id !== "https://github.com/actions/runner/github-hosted") throw new Error("provenance source does not match the prepared release");
  return "match";
}

/** @type {BundleVerifier} */
export async function verifyBundle(bundle, policy) {
  const npmRoot = process.env.DVMCTL_RELEASE_NPM_ROOT;
  if (!npmRoot || JSON.parse(readFileSync(join(npmRoot, "package.json"), "utf8")).version !== "11.16.0") throw new Error("provenance verification requires the pinned npm wrapper");
  const require = createRequire(join(npmRoot, "package.json"));
  // npm's Sigstore verifier checks the signature, certificate trust, and transparency log.
  await require("sigstore").verify(bundle, policy);
}

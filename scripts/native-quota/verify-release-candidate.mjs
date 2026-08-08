#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const EXPECTED = Object.freeze({
  repository: "ghcr.io/mainlistactivity/surrealdb-native-quota",
  forkId: "mainlistactivity/surrealdb-native-quota",
  release: "3.3.0-native-quota.1",
  manifestRevision: "native-quota-v1.0",
  sdk: "2.0.8",
  capability: "native-quota-v1",
  backend: "rocksdb",
  contractRevision: "native-quota-contract-v1",
});

function fail(message) {
  throw new Error(`native quota candidate rejected: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`invalid argument sequence near ${key ?? "<end>"}`);
    }
    values[key.slice(2)] = value;
  }
  for (const key of [
    "candidate",
    "compatibility",
    "assets-dir",
    "expected-sha",
    "expected-digest",
    "signature-policy",
    "output",
  ]) {
    requireValue(values[key], `--${key} is required`);
  }
  requireValue(
    values["signature-policy"] === "verify_keyless" ||
      values["signature-policy"] === "waived_no_certificate",
    "signature policy must be verify_keyless or waived_no_certificate",
  );
  return values;
}

async function json(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(
      `cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    `${path} is not an object`,
  );
  return value;
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function verifyBoundFile(assetsDirectory, descriptor, label) {
  requireValue(
    descriptor && typeof descriptor === "object",
    `${label} descriptor is missing`,
  );
  const filename = descriptor.document ?? descriptor.verification_document;
  requireValue(
    typeof filename === "string" && basename(filename) === filename,
    `${label} filename is invalid`,
  );
  requireValue(
    /^[0-9a-f]{64}$/.test(descriptor.sha256),
    `${label} hash is invalid`,
  );
  const actual = await sha256(join(assetsDirectory, filename));
  requireValue(actual === descriptor.sha256, `${label} hash differs`);
}

const args = parseArguments(process.argv.slice(2));
const candidatePath = resolve(args.candidate);
const compatibilityPath = resolve(args.compatibility);
const assetsDirectory = resolve(args["assets-dir"]);
const candidate = await json(candidatePath);
const compatibility = await json(compatibilityPath);
const sha = args["expected-sha"];
const digest = args["expected-digest"];

requireValue(
  /^[0-9a-f]{40}$/.test(sha),
  "expected SHA must be 40 lowercase hex characters",
);
requireValue(
  /^sha256:[0-9a-f]{64}$/.test(digest),
  "expected digest is invalid",
);
requireValue(
  candidate.format_version === 1 && candidate.channel === "candidate",
  "candidate identity is invalid",
);
requireValue(candidate.source?.git_sha === sha, "source SHA differs");
requireValue(candidate.fork?.id === EXPECTED.forkId, "fork id differs");
requireValue(
  candidate.fork?.release === EXPECTED.release,
  "fork release differs",
);
requireValue(
  candidate.fork?.manifest_revision === EXPECTED.manifestRevision,
  "manifest revision differs",
);
requireValue(
  candidate.image?.repository === EXPECTED.repository,
  "image repository differs",
);
requireValue(candidate.image?.digest === digest, "image digest differs");
requireValue(
  candidate.image?.reference === `${EXPECTED.repository}@${digest}`,
  "image reference is not digest-pinned",
);
const platformDigests = candidate.image?.platform_digests;
requireValue(
  platformDigests &&
    typeof platformDigests === "object" &&
    !Array.isArray(platformDigests) &&
    Object.keys(platformDigests).sort().join(",") === "amd64,arm64" &&
    Object.values(platformDigests).every((value) =>
      /^sha256:[0-9a-f]{64}$/.test(value),
    ),
  "image platform digests are incomplete",
);
requireValue(
  candidate.image?.labels?.["org.opencontainers.image.revision"] === sha,
  "OCI revision differs",
);
requireValue(
  candidate.image?.labels?.["org.opencontainers.image.version"] ===
    EXPECTED.release,
  "OCI release differs",
);
requireValue(
  candidate.cli?.release === EXPECTED.release && candidate.cli?.git_sha === sha,
  "CLI identity differs",
);
requireValue(
  candidate.capability?.release === EXPECTED.release,
  "capability release differs",
);
requireValue(candidate.capability?.git_sha === sha, "capability SHA differs");
requireValue(
  candidate.capability?.manifest_revision === EXPECTED.manifestRevision,
  "capability manifest revision differs",
);
requireValue(
  candidate.promotion?.digest === digest,
  "promotion digest differs",
);
requireValue(
  candidate.promotion?.production_reference === "digest-only",
  "production reference is not digest-only",
);
requireValue(
  JSON.stringify(candidate.promotion?.ordered_environments) ===
    JSON.stringify(["canary", "staging", "production"]),
  "promotion order differs",
);
requireValue(
  candidate.promotion?.stable_requires_downstream_acceptance === true,
  "downstream gate is missing",
);
requireValue(
  candidate.promotion?.downstream_repository === "MainListActivity/surreal_ck",
  "downstream repository differs",
);
requireValue(
  candidate.promotion?.downstream_acceptance_workflow ===
    ".github/workflows/native-quota-release-acceptance.yml",
  "downstream workflow differs",
);

requireValue(
  compatibility.fork_id === EXPECTED.forkId,
  "compatibility fork differs",
);
requireValue(
  compatibility.fork_release === EXPECTED.release,
  "compatibility release differs",
);
requireValue(
  compatibility.manifest_revision === EXPECTED.manifestRevision,
  "compatibility revision differs",
);
requireValue(
  compatibility.release_supply_chain?.image_repository === EXPECTED.repository,
  "compatibility image repository differs",
);
requireValue(
  JSON.stringify(compatibility.sdk?.surrealdb_js) ===
    JSON.stringify([EXPECTED.sdk]),
  "surrealdb-js version is not exact",
);
requireValue(
  JSON.stringify(compatibility.sdk?.protocols) ===
    JSON.stringify(["http", "ws"]),
  "SDK protocol contract differs",
);
requireValue(
  compatibility.cli?.release === EXPECTED.release,
  "CLI release contract differs",
);
requireValue(
  compatibility.cli?.requires_exact_release_for_destructive_operations === true,
  "CLI exact-release gate is disabled",
);
const productionBackend = compatibility.backends?.find(
  (backend) => backend.name === EXPECTED.backend,
);
requireValue(
  productionBackend?.production === true,
  "RocksDB is not marked production",
);
requireValue(
  productionBackend?.hard_quota_certified === true,
  "RocksDB hard quota is uncertified",
);
requireValue(
  productionBackend?.persistent_restart_certified === true,
  "RocksDB restart is uncertified",
);
requireValue(
  productionBackend?.certification_revision === EXPECTED.contractRevision,
  "RocksDB certification revision differs",
);
requireValue(
  candidate.compatibility?.sha256 === (await sha256(compatibilityPath)),
  "candidate does not bind the downloaded compatibility document",
);

const capabilityPath = join(assetsDirectory, candidate.capability.document);
requireValue(
  candidate.capability.sha256 === (await sha256(capabilityPath)),
  "capability hash differs",
);
const capability = await json(capabilityPath);
requireValue(
  capability.fork?.id === EXPECTED.forkId,
  "live capability fork differs",
);
requireValue(
  capability.fork?.release === EXPECTED.release,
  "live capability release differs",
);
requireValue(capability.build?.git_sha === sha, "live capability SHA differs");
requireValue(
  capability.quota?.name === EXPECTED.capability,
  "native quota capability is missing",
);
requireValue(
  capability.backend?.name === EXPECTED.backend,
  "candidate capability is not RocksDB",
);
requireValue(
  capability.backend?.production === true,
  "candidate capability backend is not production",
);
requireValue(
  capability.backend?.hard_quota_certified === true,
  "candidate capability backend is uncertified",
);

for (const [label, descriptor] of [
  ["image signature evidence", candidate.evidence?.image_signature],
  ["SBOM", candidate.evidence?.sbom],
  ["provenance", candidate.evidence?.provenance],
  ["image index", candidate.evidence?.image_index],
  ["vulnerability report", candidate.evidence?.vulnerability_report],
]) {
  await verifyBoundFile(assetsDirectory, descriptor, label);
}

const imageIndex = await json(
  join(assetsDirectory, candidate.evidence.image_index.document),
);
const indexPlatformDigests = Object.fromEntries(
  (imageIndex.manifests ?? [])
    .filter((manifest) => manifest?.platform?.os === "linux")
    .filter((manifest) =>
      ["amd64", "arm64"].includes(manifest?.platform?.architecture),
    )
    .map((manifest) => [manifest.platform.architecture, manifest.digest]),
);
requireValue(
  Object.keys(platformDigests).every(
    (architecture) =>
      indexPlatformDigests[architecture] === platformDigests[architecture],
  ),
  "image index platform digests differ from candidate identity",
);

const architectures = new Set();
for (const artifact of candidate.cli?.artifacts ?? []) {
  requireValue(
    ["amd64", "arm64"].includes(artifact.architecture),
    "unknown CLI architecture",
  );
  requireValue(
    typeof artifact.name === "string" &&
      basename(artifact.name) === artifact.name,
    "invalid CLI filename",
  );
  requireValue(/^[0-9a-f]{64}$/.test(artifact.sha256), "invalid CLI hash");
  requireValue(
    (await sha256(join(assetsDirectory, artifact.name))) === artifact.sha256,
    `${artifact.name} hash differs`,
  );
  architectures.add(artifact.architecture);
}
requireValue(
  architectures.size === 2 &&
    architectures.has("amd64") &&
    architectures.has("arm64"),
  "matching amd64 and arm64 CLI artifacts are required",
);

const sbom = await json(
  join(assetsDirectory, candidate.evidence.sbom.document),
);
requireValue(
  typeof sbom.spdxVersion === "string" && sbom.spdxVersion.startsWith("SPDX-"),
  "SBOM is not SPDX",
);
const vulnerabilityReport = await json(
  join(assetsDirectory, candidate.evidence.vulnerability_report.document),
);
const blockingVulnerabilities = (vulnerabilityReport.Results ?? [])
  .flatMap((result) => result.Vulnerabilities ?? [])
  .filter(
    (finding) => finding.Severity === "HIGH" || finding.Severity === "CRITICAL",
  );
requireValue(
  blockingVulnerabilities.length === 0,
  "HIGH/CRITICAL vulnerability evidence is not clean",
);
const provenance = await readFile(
  join(assetsDirectory, candidate.evidence.provenance.document),
  "utf8",
);
const provenanceEnvelopes = provenance
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(
        `provenance line ${index + 1} is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
const expectedPlatformDigests = new Set(
  Object.values(platformDigests).map((platformDigest) =>
    platformDigest.slice("sha256:".length),
  ),
);
const matchedPlatformDigests = new Set();
for (const envelope of provenanceEnvelopes) {
  let statement = envelope;
  if (typeof envelope?.payload === "string") {
    try {
      statement = JSON.parse(
        Buffer.from(envelope.payload, "base64").toString("utf8"),
      );
    } catch {
      continue;
    }
  }
  if (
    typeof statement?.predicateType !== "string" ||
    !statement.predicateType.includes("slsa.dev/provenance") ||
    !Array.isArray(statement.subject)
  ) {
    continue;
  }
  for (const subject of statement.subject) {
    const subjectDigest = subject?.digest?.sha256;
    if (expectedPlatformDigests.has(subjectDigest))
      matchedPlatformDigests.add(subjectDigest);
  }
}
requireValue(
  matchedPlatformDigests.size === expectedPlatformDigests.size,
  "provenance does not contain SLSA subjects bound to both image platform digests",
);

const identity = {
  format_version: 1,
  candidate_tag: args["candidate-tag"] ?? null,
  release: EXPECTED.release,
  git_sha: sha,
  digest,
  image_reference: `${EXPECTED.repository}@${digest}`,
  sdk: { package: "surrealdb", version: EXPECTED.sdk },
  backend: EXPECTED.backend,
  signature_policy: args["signature-policy"],
  cryptographic_evidence: {
    candidate_manifest_signature:
      args["signature-policy"] === "verify_keyless"
        ? "verified"
        : "waived_no_certificate",
    image_signature:
      args["signature-policy"] === "verify_keyless"
        ? "verified"
        : "waived_no_certificate",
    hashes: "verified",
    sbom: "verified",
    provenance:
      args["signature-policy"] === "verify_keyless"
        ? "verified"
        : "content_bound",
    vulnerabilities: "passed",
  },
};
await writeFile(
  resolve(args.output),
  `${JSON.stringify(identity, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(identity));

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readJson, repoRoot, result } = require("./core.cjs");

const MANIFEST_SCHEMA = "sde-data-provenance/v1";
const ATTESTATION_SCHEMA = "sde-data-release-attestation/v1";

function hashBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validSha(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function validIso(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function datasetRecordCount(bytes) {
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return Object.keys(parsed.departures || {}).length + Object.keys(parsed.arrivals || {}).length;
  } catch {
    return null;
  }
}

function comparisonEligibility(manifest, attestation = null) {
  const source = manifest?.source || {};
  const datasets = manifest?.datasets || {};
  const missing = [];
  if (!manifest?.generationId) missing.push("generationId");
  if (!source.observedAt) missing.push("source.observedAt");
  if (!source.rawStationSha256) missing.push("source.rawStationSha256");
  if (!datasets.idag?.sha256) missing.push("datasets.idag.sha256");
  if (!datasets.imorgen?.sha256) missing.push("datasets.imorgen.sha256");
  if (!datasets.idag?.operationalDate) missing.push("datasets.idag.operationalDate");
  if (!datasets.imorgen?.operationalDate) missing.push("datasets.imorgen.operationalDate");
  if (attestation && attestation.generationId !== manifest?.generationId) {
    return { eligible: false, reason: "CONFLICTING_GENERATION_IDS", missingProvenance: missing };
  }
  if (missing.length) return { eligible: false, reason: "INSUFFICIENT_SNAPSHOT_PROVENANCE", missingProvenance: missing };
  if (source.snapshotStable !== true) return { eligible: false, reason: "SOURCE_CHANGED_DURING_GENERATION", missingProvenance: [] };
  return {
    eligible: true,
    reason: "SAME_GENERATION_SNAPSHOT_PROVEN",
    generationId: manifest.generationId,
    sourceObservedAt: source.observedAt,
    sourceHash: source.rawStationSha256,
    datasetHashes: { idag: datasets.idag.sha256, imorgen: datasets.imorgen.sha256 },
    operationalDates: { idag: datasets.idag.operationalDate, imorgen: datasets.imorgen.operationalDate },
    missingProvenance: []
  };
}

function validateProvenance({
  manifest = null,
  manifestBytes = null,
  datasetBytes = {},
  publishedDatasetBytes = {},
  attestation = null
} = {}) {
  if (!manifest) return {
    classification: "BLOCKED",
    structural: "BLOCKED",
    integrity: "BLOCKED",
    source: "BLOCKED",
    schedule: "BLOCKED",
    gitDeploy: "BLOCKED",
    generationId: null,
    chain: [],
    publicationIntegrity: "BLOCKED",
    customDomainObservability: "NOT_EVALUATED",
    comparisonEligibility: { eligible: false, reason: "LEGACY_DATASET_WITHOUT_MANIFEST", missingProvenance: ["manifest"] },
    findings: ["Legacy dataset has no generation manifest; no product defect inferred."]
  };
  const findings = [];
  let structural = "GREEN";
  if (
    manifest.schema !== MANIFEST_SCHEMA ||
    !manifest.generationId ||
    manifest.timeZone !== "Europe/Oslo" ||
    !validIso(manifest.startedAt) ||
    !validIso(manifest.completedAt) ||
    !manifest.datasets ||
    !manifest.source ||
    !manifest.workflow ||
    !manifest.intendedCycle
  ) {
    structural = "RED";
    findings.push("Manifest schema or required structure is invalid.");
  }

  let integrity = structural === "RED" ? "RED" : "GREEN";
  for (const mode of ["idag", "imorgen"]) {
    const expected = manifest.datasets?.[mode]?.sha256;
    const bytes = datasetBytes[mode];
    const model = manifest.datasets?.[mode] || {};
    if (!validSha(expected) || !Buffer.isBuffer(bytes)) {
      if (integrity !== "RED") integrity = "BLOCKED";
      findings.push(`${mode} dataset bytes or manifest hash is missing.`);
    } else if (
      hashBytes(bytes) !== expected ||
      bytes.length !== model.bytes ||
      datasetRecordCount(bytes) !== model.recordCount
    ) {
      integrity = "RED";
      findings.push(`${mode} exact-byte dataset hash/length/record-count mismatch.`);
    } else {
      try {
        const parsed = JSON.parse(bytes.toString("utf8"));
        if (!validDate(model.operationalDate) || parsed.date !== model.operationalDate) {
          integrity = "RED";
          findings.push(`${mode} operational date differs from the exact dataset.`);
        }
      } catch {
        integrity = "RED";
        findings.push(`${mode} is not valid UTF-8 JSON.`);
      }
    }
    const published = publishedDatasetBytes[mode];
    if (Buffer.isBuffer(published) && Buffer.isBuffer(bytes) && !published.equals(bytes)) {
      integrity = "RED";
      findings.push(`${mode} Pages payload differs from the local exact bytes.`);
    }
  }

  let source = "GREEN";
  const before = manifest.source?.rawStationBeforeSha256;
  const after = manifest.source?.rawStationAfterSha256;
  if (
    !validIso(manifest.source?.observedAt) ||
    !validSha(before) ||
    !validSha(after) ||
    !validSha(manifest.source?.rawStationSha256) ||
    !validSha(manifest.source?.vehicleSha256)
  ) {
    source = "BLOCKED";
    findings.push("Source hash evidence is incomplete.");
  } else if (manifest.source.snapshotStable === true && before !== after) {
    source = "RED";
    findings.push("Manifest claims a stable snapshot while before/after hashes differ.");
  } else if (manifest.source.rawStationSha256 !== after) {
    source = "RED";
    findings.push("Manifest station hash does not identify the attested after-capture.");
  } else if (manifest.source.snapshotStable !== true || before !== after) {
    source = "BLOCKED";
    findings.push("Balise station response changed during generation.");
  }

  let schedule = "GREEN";
  if (manifest.workflow?.generatorExecuted === false) {
    schedule = "BLOCKED";
    findings.push("The intended workflow cycle is known, but the generator was skipped.");
  } else if (
    !manifest.intendedCycle?.id ||
    !validDate(manifest.intendedCycle?.date) ||
    !/^\d{2}$/.test(String(manifest.intendedCycle?.hour || "")) ||
    !validIso(manifest.workflow?.actualWorkflowStart) ||
    !validIso(manifest.workflow?.actualGeneratorStart)
  ) {
    schedule = "BLOCKED";
    findings.push("Intended cycle or actual generator start is missing.");
  }

  let gitDeploy = "GREEN";
  if (!attestation) {
    gitDeploy = "BLOCKED";
    findings.push("Release/deploy attestation is missing; live publication remains pending.");
  } else if (attestation.schema !== ATTESTATION_SCHEMA || attestation.generationId !== manifest.generationId) {
    gitDeploy = "RED";
    findings.push("Release attestation schema or generation identity conflicts.");
  } else if (
    manifestBytes &&
    attestation.generationManifest?.sha256 &&
    hashBytes(manifestBytes) !== attestation.generationManifest.sha256
  ) {
    gitDeploy = "RED";
    findings.push("Release attestation identifies a different generation manifest.");
  } else if (["idag", "imorgen"].some((mode) =>
    attestation.datasets?.[mode]?.sha256 !== manifest.datasets?.[mode]?.sha256
  )) {
    gitDeploy = "RED";
    findings.push("Release attestation dataset hashes conflict with the manifest.");
  } else if (!attestation.git?.commit || !attestation.git?.tree) {
    gitDeploy = "BLOCKED";
    findings.push("Release attestation lacks commit or tree identity.");
  } else if (attestation.publication?.deployedCommit && attestation.publication.deployedCommit !== attestation.git?.commit) {
    gitDeploy = "RED";
    findings.push("Pages deployment commit differs from the attested data commit.");
  } else if (!attestation.publication?.deployedCommit || !attestation.publication?.pagesDeploymentId) {
    gitDeploy = "BLOCKED";
    findings.push("Data commit is attested but Pages deployment evidence is pending.");
  }

  const statuses = [structural, integrity, source, schedule, gitDeploy];
  const classification = statuses.includes("RED") ? "RED" : statuses.includes("BLOCKED") ? "BLOCKED" : "GREEN";
  const chain = [
    { step: "Balise snapshot", status: source, identity: manifest.source?.rawStationSha256 || null },
    { step: "Generator run", status: schedule, identity: manifest.generationId || null },
    { step: "Dataset hashes", status: integrity, identity: manifest.datasets?.idag?.sha256 || null },
    { step: "Git commit", status: attestation?.git?.commit ? (gitDeploy === "RED" ? "RED" : "GREEN") : "NOT AVAILABLE", identity: attestation?.git?.commit || null },
    { step: "Pages deployment", status: attestation?.publication?.pagesDeploymentId ? gitDeploy : "NOT AVAILABLE", identity: attestation?.publication?.pagesDeploymentId || null },
    { step: "Published bytes", status: Object.values(publishedDatasetBytes).some(Buffer.isBuffer) ? integrity : "NOT AVAILABLE", identity: null }
  ];
  return {
    classification, structural, integrity, source, schedule, gitDeploy,
    comparisonEligibility: comparisonEligibility(manifest, attestation),
    publicationIntegrity: gitDeploy,
    customDomainObservability: attestation?.publication?.customDomainObservability || manifest.publication?.customDomainObservability || "NOT_EVALUATED",
    generationId: manifest.generationId,
    chain,
    findings
  };
}

function loadCurrentProvenance() {
  const root = repoRoot();
  const manifestPath = path.join(root, "data/sde-data-provenance.json");
  const attestationPath = process.env.SDE_QE_RELEASE_ATTESTATION || "";
  const manifestBytes = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath) : null;
  return {
    manifest: manifestBytes ? JSON.parse(manifestBytes.toString("utf8")) : null,
    manifestBytes,
    datasetBytes: {
      idag: fs.readFileSync(path.join(root, "data/api_idag.json")),
      imorgen: fs.readFileSync(path.join(root, "data/api_imorgen.json"))
    },
    attestation: attestationPath && fs.existsSync(attestationPath) ? readJson(attestationPath) : null
  };
}

function provenanceChecks(options = {}) {
  const observed = validateProvenance(options.manifest !== undefined ? options : loadCurrentProvenance());
  const definitions = [
    ["PROV-001", "Manifest structure", "structural"],
    ["PROV-002", "Exact dataset integrity", "integrity"],
    ["PROV-003", "Same-snapshot source evidence", "source"],
    ["PROV-004", "Intended cycle and actual execution", "schedule"],
    ["PROV-005", "Git and deployment attestation", "gitDeploy"]
  ];
  return definitions.map(([id, name, key]) => result({
    id,
    area: "data-provenance",
    name,
    status: observed[key],
    critical: true,
    summary: observed[key] === "GREEN" ? `${name} is machine-verifiable.` : observed.findings.join(" "),
    evidence: ["data/sde-data-provenance.json", "sde-data-release-attestation artifact"],
    details: { provenance: observed, comparisonEligibility: observed.comparisonEligibility }
  }));
}

module.exports = {
  ATTESTATION_SCHEMA,
  MANIFEST_SCHEMA,
  comparisonEligibility,
  datasetRecordCount,
  hashBytes,
  loadCurrentProvenance,
  provenanceChecks,
  validateProvenance
};

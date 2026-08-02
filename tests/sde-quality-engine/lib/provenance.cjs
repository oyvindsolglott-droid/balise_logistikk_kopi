"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readJson, repoRoot, result } = require("./core.cjs");

const MANIFEST_SCHEMA = "sde-data-provenance/v1";
const LEGACY_ATTESTATION_SCHEMA = "sde-data-release-attestation/v1";
const ATTESTATION_SCHEMA = "sde-data-release-attestation/v2";

function hashBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function validSha(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function validGitSha(value) {
  return /^[a-f0-9]{40,64}$/.test(String(value || ""));
}

function validDigest(value) {
  return /^(sha256:)?[a-f0-9]{64}$/.test(String(value || ""));
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

function worstStatus(statuses) {
  if (statuses.includes("RED")) return "RED";
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  return "GREEN";
}

function identityDomain(name, role, status, expectedRelations, actualRelations, findings = []) {
  return { name, role, status, expectedRelations, actualRelations, findings };
}

function attestationSchema(attestation) {
  return attestation?.schemaVersion || attestation?.schema || null;
}

function evaluateIdentityDomains({
  manifest,
  manifestBytes,
  datasetBytes,
  publishedDatasetBytes,
  publishedManifestBytes,
  attestation
}) {
  const domains = {
    generationIdentity: identityDomain(
      "Generation identity",
      "Binds generator execution and source snapshot; it is not a deployment identity.",
      "BLOCKED",
      ["generationId/source hashes/intended cycle match the generation manifest"],
      {},
      []
    ),
    contentIdentity: identityDomain(
      "Content identity",
      "Binds the exact data commit/tree, manifest, datasets and Pages artifact bytes.",
      "BLOCKED",
      ["artifactSourceCommit = dataCommit", "manifest/dataset hashes match", "artifact ID and digest are explicit"],
      {},
      []
    ),
    deploymentIdentity: identityDomain(
      "Deployment identity",
      "Identifies a Pages execution and its deployed artifact; its context SHA need not equal dataCommit.",
      "BLOCKED",
      ["deployed artifact ID/digest = content artifact ID/digest"],
      {},
      []
    ),
    publicationIntegrity: identityDomain(
      "Publication integrity",
      "Binds published bytes and response evidence to the attested content.",
      "BLOCKED",
      ["published manifest/dataset hashes = content hashes"],
      {},
      []
    )
  };
  const add = (domain, status, message) => {
    if (status === "RED" || domains[domain].status !== "RED") domains[domain].status = status;
    domains[domain].findings.push(message);
  };
  const schema = attestationSchema(attestation);

  if (!attestation) {
    for (const domain of Object.values(domains)) {
      domain.findings.push("Release/deploy attestation evidence is missing.");
    }
    return domains;
  }

  for (const domain of Object.values(domains)) domain.status = "GREEN";

  const publicationMismatch = ["idag", "imorgen"].some((mode) => {
    const local = datasetBytes[mode];
    const published = publishedDatasetBytes[mode];
    return Buffer.isBuffer(local) && Buffer.isBuffer(published) && !local.equals(published);
  });

  if (schema === LEGACY_ATTESTATION_SCHEMA) {
    const generation = domains.generationIdentity;
    generation.actualRelations = {
      generationId: attestation.generationId || null,
      schema
    };
    if (!attestation.generationId) {
      add("generationIdentity", "BLOCKED", "Legacy v1 attestation lacks generation identity.");
    } else if (attestation.generationId !== manifest.generationId) {
      add("generationIdentity", "RED", "Release attestation generation identity conflicts with the manifest.");
    }

    const content = domains.contentIdentity;
    content.actualRelations = {
      dataCommit: attestation.git?.commit || null,
      dataTree: attestation.git?.tree || null,
      artifactSourceCommit: attestation.publication?.artifactSourceCommit || null,
      manifestSha256: attestation.generationManifest?.sha256 || null,
      datasetHashes: {
        idag: attestation.datasets?.idag?.sha256 || null,
        imorgen: attestation.datasets?.imorgen?.sha256 || null
      }
    };
    if (!validGitSha(attestation.git?.commit) || !validGitSha(attestation.git?.tree)) {
      add("contentIdentity", "BLOCKED", "Legacy v1 attestation lacks valid commit or tree identity.");
    }
    if (!attestation.generationManifest?.sha256 || !manifestBytes) {
      add("contentIdentity", "BLOCKED", "Legacy v1 manifest byte identity is incomplete.");
    } else if (hashBytes(manifestBytes) !== attestation.generationManifest.sha256) {
      add("contentIdentity", "RED", "Release attestation identifies a different generation manifest.");
    }
    for (const mode of ["idag", "imorgen"]) {
      if (!attestation.datasets?.[mode]?.sha256) {
        add("contentIdentity", "BLOCKED", `Legacy v1 ${mode} content hash is missing.`);
      } else if (attestation.datasets[mode].sha256 !== manifest.datasets?.[mode]?.sha256) {
        add("contentIdentity", "RED", `Legacy v1 ${mode} content hash conflicts with the manifest.`);
      }
    }

    const deployment = domains.deploymentIdentity;
    const deployedCommit = attestation.publication?.deployedCommit || null;
    const deploymentId = attestation.publication?.pagesDeploymentId || null;
    const documentedSource = attestation.publication?.artifactSourceCommit || null;
    deployment.actualRelations = {
      pagesDeploymentId: deploymentId,
      legacyDeployedCommit: deployedCommit,
      artifactSourceCommit: documentedSource
    };
    if (!deployedCommit || !deploymentId) {
      add("deploymentIdentity", "BLOCKED", "Legacy v1 Pages deployment evidence is pending.");
    } else if (documentedSource && documentedSource !== attestation.git?.commit) {
      add("deploymentIdentity", "RED", "Legacy v1 documents an artifact source commit that differs from the data commit.");
    } else if (!documentedSource && deployedCommit !== attestation.git?.commit) {
      add("deploymentIdentity", "BLOCKED", "Legacy v1 deployedCommit is ambiguous: it may be deployment context rather than artifact source.");
    }

    const publication = domains.publicationIntegrity;
    publication.actualRelations = {
      publishedIdagObserved: Buffer.isBuffer(publishedDatasetBytes.idag),
      publishedImorgenObserved: Buffer.isBuffer(publishedDatasetBytes.imorgen),
      customDomainObservability: attestation.publication?.customDomainObservability || "NOT_EVALUATED"
    };
    if (publicationMismatch) {
      add("publicationIntegrity", "RED", "Published Pages dataset bytes differ from the attested local bytes.");
    } else if (!["idag", "imorgen"].every((mode) => Buffer.isBuffer(publishedDatasetBytes[mode]))) {
      add("publicationIntegrity", "BLOCKED", "Legacy v1 published byte evidence is incomplete.");
    }
    return domains;
  }

  if (schema !== ATTESTATION_SCHEMA) {
    for (const key of Object.keys(domains)) {
      add(key, "RED", `Unsupported release attestation schema: ${schema || "missing"}.`);
    }
    return domains;
  }

  const generation = attestation.generation || {};
  domains.generationIdentity.actualRelations = {
    generationId: attestation.generationId || null,
    generatorWorkflowRunId: generation.generatorWorkflowRunId || null,
    generatorWorkflowContextSha: generation.generatorWorkflowContextSha || null,
    sourceObservedAt: generation.sourceObservedAt || null,
    sourceStationSha256: generation.sourceStationSha256 || null,
    sourceVehicleSha256: generation.sourceVehicleSha256 || null,
    intendedCycleId: generation.intendedCycleId || null
  };
  const generationRelations = [
    ["generationId", attestation.generationId, manifest.generationId],
    ["generatorWorkflowRunId", generation.generatorWorkflowRunId, manifest.workflow?.runId],
    ["sourceObservedAt", generation.sourceObservedAt, manifest.source?.observedAt],
    ["sourceStationSha256", generation.sourceStationSha256, manifest.source?.rawStationSha256],
    ["sourceVehicleSha256", generation.sourceVehicleSha256, manifest.source?.vehicleSha256],
    ["intendedCycleId", generation.intendedCycleId, manifest.intendedCycle?.id],
    ["intendedCycleDate", generation.intendedCycleDate, manifest.intendedCycle?.date],
    ["intendedCycleHour", String(generation.intendedCycleHour || ""), String(manifest.intendedCycle?.hour || "")]
  ];
  for (const [name, actual, expected] of generationRelations) {
    if (!actual || !expected) add("generationIdentity", "BLOCKED", `Generation relation ${name} is incomplete.`);
    else if (actual !== expected) add("generationIdentity", "RED", `Generation relation ${name} conflicts with the manifest.`);
  }
  if (!validGitSha(generation.generatorWorkflowContextSha)) {
    add("generationIdentity", "BLOCKED", "Generator workflow context SHA is missing or invalid.");
  }

  const content = attestation.content || {};
  const contentManifest = content.manifest || {};
  domains.contentIdentity.actualRelations = {
    dataCommit: content.dataCommit || null,
    dataTree: content.dataTree || null,
    artifactSourceCommit: content.artifactSourceCommit || null,
    pagesArtifactId: content.pagesArtifactId || null,
    pagesArtifactDigest: content.pagesArtifactDigest || null,
    manifestSha256: contentManifest.sha256 || null,
    datasetHashes: {
      idag: content.datasets?.idag?.sha256 || null,
      imorgen: content.datasets?.imorgen?.sha256 || null
    }
  };
  if (!validGitSha(content.dataCommit) || !validGitSha(content.dataTree)) {
    add("contentIdentity", "BLOCKED", "V2 content lacks a valid data commit or tree.");
  }
  if (!manifestBytes || !contentManifest.sha256) {
    add("contentIdentity", "BLOCKED", "V2 manifest byte identity is incomplete.");
  } else if (hashBytes(manifestBytes) !== contentManifest.sha256) {
    add("contentIdentity", "RED", "V2 content identifies a different generation manifest.");
  }
  for (const mode of ["idag", "imorgen"]) {
    const actual = content.datasets?.[mode]?.sha256;
    const expected = manifest.datasets?.[mode]?.sha256;
    if (!actual || !expected) add("contentIdentity", "BLOCKED", `V2 ${mode} content hash is missing.`);
    else if (actual !== expected) add("contentIdentity", "RED", `V2 ${mode} content hash conflicts with the manifest.`);
  }
  if (!content.artifactSourceCommit || !content.pagesArtifactId || !content.pagesArtifactDigest) {
    add("contentIdentity", "BLOCKED", "Pages artifact source, ID or digest is pending.");
  } else {
    if (content.artifactSourceCommit !== content.dataCommit) {
      add("contentIdentity", "RED", "Pages artifact source commit differs from the attested data commit.");
    }
    if (!validDigest(content.pagesArtifactDigest)) {
      add("contentIdentity", "RED", "Pages artifact digest has an invalid identity format.");
    }
  }

  const deployment = attestation.deployment || {};
  domains.deploymentIdentity.actualRelations = {
    pagesWorkflowRunId: deployment.pagesWorkflowRunId || null,
    pagesWorkflowContextSha: deployment.pagesWorkflowContextSha || null,
    pagesBuildVersion: deployment.pagesBuildVersion || null,
    deploymentId: deployment.deploymentId || null,
    deploymentApiSha: deployment.deploymentApiSha || null,
    publishedAt: deployment.publishedAt || null,
    deployedArtifactId: deployment.deployedArtifactId || null,
    deployedArtifactDigest: deployment.deployedArtifactDigest || null
  };
  const deploymentRequired = [
    ["pagesWorkflowRunId", deployment.pagesWorkflowRunId],
    ["pagesBuildVersion", deployment.pagesBuildVersion],
    ["deploymentId", deployment.deploymentId],
    ["deployedArtifactId", deployment.deployedArtifactId],
    ["deployedArtifactDigest", deployment.deployedArtifactDigest]
  ];
  for (const [name, value] of deploymentRequired) {
    if (!value) add("deploymentIdentity", "BLOCKED", `Deployment field ${name} is pending.`);
  }
  if (!validGitSha(deployment.pagesWorkflowContextSha)) {
    add("deploymentIdentity", "BLOCKED", "Pages workflow context SHA is missing or invalid.");
  }
  if (!validGitSha(deployment.deploymentApiSha)) {
    add("deploymentIdentity", "BLOCKED", "Deployment API SHA is missing or invalid.");
  }
  if (!validIso(deployment.publishedAt)) {
    add("deploymentIdentity", "BLOCKED", "Pages publication time is missing or invalid.");
  }
  if (content.pagesArtifactId && deployment.deployedArtifactId && content.pagesArtifactId !== deployment.deployedArtifactId) {
    add("deploymentIdentity", "RED", "Pages deployment is bound to a different artifact ID.");
  }
  if (content.pagesArtifactDigest && deployment.deployedArtifactDigest && content.pagesArtifactDigest !== deployment.deployedArtifactDigest) {
    add("deploymentIdentity", "RED", "Pages deployment is bound to a different artifact digest.");
  }

  const publication = attestation.publication || {};
  domains.publicationIntegrity.actualRelations = {
    observedAt: publication.observedAt || null,
    manifestSha256: publication.manifestSha256 || null,
    datasetHashes: {
      idag: publication.datasets?.idag?.sha256 || null,
      imorgen: publication.datasets?.imorgen?.sha256 || null
    },
    responseHeaders: publication.responseHeaders || {},
    customDomainObservability: publication.customDomainObservability || "NOT_EVALUATED"
  };
  if (!validIso(publication.observedAt)) {
    add("publicationIntegrity", "BLOCKED", "Publication observation time is pending.");
  }
  if (!publication.manifestSha256) {
    add("publicationIntegrity", "BLOCKED", "Published manifest hash is pending.");
  } else if (publication.manifestSha256 !== contentManifest.sha256) {
    add("publicationIntegrity", "RED", "Published manifest hash differs from the content identity.");
  }
  for (const mode of ["idag", "imorgen"]) {
    const actual = publication.datasets?.[mode]?.sha256;
    const expected = content.datasets?.[mode]?.sha256;
    if (!actual) add("publicationIntegrity", "BLOCKED", `Published ${mode} hash is pending.`);
    else if (actual !== expected) add("publicationIntegrity", "RED", `Published ${mode} hash differs from the content identity.`);
  }
  if (!publication.responseHeaders || !Object.keys(publication.responseHeaders).length) {
    add("publicationIntegrity", "BLOCKED", "Publication response headers are pending.");
  }
  if (Buffer.isBuffer(publishedManifestBytes) && publication.manifestSha256 && hashBytes(publishedManifestBytes) !== publication.manifestSha256) {
    add("publicationIntegrity", "RED", "Observed published manifest bytes differ from the publication hash.");
  }
  if (publicationMismatch) {
    add("publicationIntegrity", "RED", "Observed published dataset bytes differ from the attested local bytes.");
  }
  for (const mode of ["idag", "imorgen"]) {
    if (Buffer.isBuffer(publishedDatasetBytes[mode]) && publication.datasets?.[mode]?.sha256 && hashBytes(publishedDatasetBytes[mode]) !== publication.datasets[mode].sha256) {
      add("publicationIntegrity", "RED", `Observed published ${mode} bytes differ from the publication hash.`);
    }
  }
  return domains;
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
  publishedManifestBytes = null,
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
    generationIdentity: "BLOCKED",
    contentIdentity: "BLOCKED",
    deploymentIdentity: "BLOCKED",
    publicationIntegrity: "BLOCKED",
    identityDomains: {
      generationIdentity: identityDomain("Generation identity", "Generation evidence", "BLOCKED", [], {}, ["Generation manifest is missing."]),
      contentIdentity: identityDomain("Content identity", "Content evidence", "BLOCKED", [], {}, ["Generation manifest is missing."]),
      deploymentIdentity: identityDomain("Deployment identity", "Deployment evidence", "BLOCKED", [], {}, ["Generation manifest is missing."]),
      publicationIntegrity: identityDomain("Publication integrity", "Publication evidence", "BLOCKED", [], {}, ["Generation manifest is missing."])
    },
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

  const identityDomains = evaluateIdentityDomains({
    manifest,
    manifestBytes,
    datasetBytes,
    publishedDatasetBytes,
    publishedManifestBytes,
    attestation
  });
  const generationIdentity = identityDomains.generationIdentity.status;
  const contentIdentity = identityDomains.contentIdentity.status;
  const deploymentIdentity = identityDomains.deploymentIdentity.status;
  const publicationIntegrity = identityDomains.publicationIntegrity.status;
  const gitDeploy = worstStatus([contentIdentity, deploymentIdentity, publicationIntegrity]);
  for (const domain of Object.values(identityDomains)) findings.push(...domain.findings);

  const statuses = [structural, integrity, source, schedule, generationIdentity, contentIdentity, deploymentIdentity, publicationIntegrity];
  const classification = worstStatus(statuses);
  const dataCommit = attestation?.content?.dataCommit || attestation?.git?.commit || null;
  const deploymentId = attestation?.deployment?.deploymentId || attestation?.publication?.pagesDeploymentId || null;
  const chain = [
    { step: "Balise snapshot", status: source, identity: manifest.source?.rawStationSha256 || null },
    { step: "Generator run", status: schedule, identity: manifest.generationId || null },
    { step: "Dataset hashes", status: integrity, identity: manifest.datasets?.idag?.sha256 || null },
    { step: "Content commit", status: dataCommit ? contentIdentity : "NOT AVAILABLE", identity: dataCommit },
    { step: "Pages artifact", status: attestation?.content?.pagesArtifactId ? contentIdentity : "NOT AVAILABLE", identity: attestation?.content?.pagesArtifactId || null },
    { step: "Pages deployment", status: deploymentId ? deploymentIdentity : "NOT AVAILABLE", identity: deploymentId },
    { step: "Published bytes", status: Object.values(publishedDatasetBytes).some(Buffer.isBuffer) || attestation?.publication?.observedAt ? publicationIntegrity : "NOT AVAILABLE", identity: attestation?.publication?.observedAt || null }
  ];
  return {
    classification, structural, integrity, source, schedule, gitDeploy,
    comparisonEligibility: comparisonEligibility(manifest, attestation),
    generationIdentity,
    contentIdentity,
    deploymentIdentity,
    publicationIntegrity,
    identityDomains,
    identityResults: Object.values(identityDomains),
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
  LEGACY_ATTESTATION_SCHEMA,
  MANIFEST_SCHEMA,
  attestationSchema,
  comparisonEligibility,
  datasetRecordCount,
  hashBytes,
  loadCurrentProvenance,
  provenanceChecks,
  validateProvenance
};

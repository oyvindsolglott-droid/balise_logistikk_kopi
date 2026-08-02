"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { validateProvenance } = require("../lib/provenance.cjs");

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function dataset(date, train) {
  return Buffer.from(JSON.stringify({
    date,
    updatedAt: "01.08.2026 15:00:00",
    departures: { "1": { train } },
    arrivals: { "2": { train } }
  }, null, 2), "utf8");
}

function completeV2() {
  const idag = dataset("2026-08-01", "80810");
  const imorgen = dataset("2026-08-02", "80812");
  const sourceHash = sha(Buffer.from("attestation-identity-source"));
  const vehicleHash = sha(Buffer.from("attestation-identity-vehicles"));
  const manifest = {
    schema: "sde-data-provenance/v1",
    generationId: "attestation-identity-generation",
    timeZone: "Europe/Oslo",
    startedAt: "2026-08-01T15:22:05+02:00",
    completedAt: "2026-08-01T15:23:05+02:00",
    intendedCycle: {
      id: "2026-08-01T15:00@Europe/Oslo",
      date: "2026-08-01",
      hour: "15"
    },
    workflow: {
      event: "schedule",
      runId: "generator-run-1156",
      actualWorkflowStart: "2026-08-01T15:21:55+02:00",
      actualGeneratorStart: "2026-08-01T15:22:05+02:00",
      generatorExecuted: true
    },
    source: {
      observedAt: "2026-08-01T15:22:30+02:00",
      rawStationSha256: sourceHash,
      rawStationBeforeSha256: sourceHash,
      rawStationAfterSha256: sourceHash,
      vehicleSha256: vehicleHash,
      snapshotStable: true
    },
    datasets: {
      idag: { operationalDate: "2026-08-01", sha256: sha(idag), bytes: idag.length, recordCount: 2 },
      imorgen: { operationalDate: "2026-08-02", sha256: sha(imorgen), bytes: imorgen.length, recordCount: 2 }
    },
    publication: { customDomainObservability: "GREEN_AUTHENTICATED_GET" }
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const dataCommit = "b".repeat(40);
  const artifactId = "pages-artifact-1156";
  const artifactDigest = `sha256:${"6".repeat(64)}`;
  const attestation = {
    schemaVersion: "sde-data-release-attestation/v2",
    generationId: manifest.generationId,
    generation: {
      generatorWorkflowRunId: manifest.workflow.runId,
      generatorWorkflowContextSha: "a".repeat(40),
      sourceObservedAt: manifest.source.observedAt,
      sourceStationSha256: sourceHash,
      sourceVehicleSha256: vehicleHash,
      intendedCycleId: manifest.intendedCycle.id,
      intendedCycleDate: manifest.intendedCycle.date,
      intendedCycleHour: manifest.intendedCycle.hour
    },
    content: {
      repository: "owner/repo",
      dataCommit,
      dataTree: "c".repeat(40),
      manifest: { path: "data/sde-data-provenance.json", sha256: sha(manifestBytes) },
      datasets: {
        idag: { path: "data/api_idag.json", sha256: sha(idag), bytes: idag.length },
        imorgen: { path: "data/api_imorgen.json", sha256: sha(imorgen), bytes: imorgen.length }
      },
      artifactSourceCommit: dataCommit,
      pagesArtifactId: artifactId,
      pagesArtifactDigest: artifactDigest
    },
    deployment: {
      pagesWorkflowRunId: "pages-run-1207",
      pagesWorkflowContextSha: "d".repeat(40),
      pagesBuildVersion: "pages-build-1207",
      deploymentId: "deployment-9001",
      deploymentApiSha: "e".repeat(40),
      publishedAt: "2026-08-01T15:31:00+02:00",
      deployedArtifactId: artifactId,
      deployedArtifactDigest: artifactDigest
    },
    publication: {
      observedAt: "2026-08-01T15:32:00+02:00",
      manifestSha256: sha(manifestBytes),
      datasets: {
        idag: { sha256: sha(idag) },
        imorgen: { sha256: sha(imorgen) }
      },
      responseHeaders: { etag: "fixture-etag", "content-type": "application/json" },
      customDomainObservability: "GREEN_AUTHENTICATED_GET"
    }
  };
  return {
    manifest,
    manifestBytes,
    datasetBytes: { idag, imorgen },
    publishedDatasetBytes: { idag: Buffer.from(idag), imorgen: Buffer.from(imorgen) },
    publishedManifestBytes: Buffer.from(manifestBytes),
    attestation
  };
}

function observe(mutate = () => {}) {
  const model = completeV2();
  mutate(model);
  return validateProvenance(model);
}

test("valid chain with different workflow, content and deployment SHAs is GREEN", () => {
  const observed = observe();
  assert.equal(observed.classification, "GREEN");
  assert.equal(observed.generationIdentity, "GREEN");
  assert.equal(observed.contentIdentity, "GREEN");
  assert.equal(observed.deploymentIdentity, "GREEN");
  assert.equal(observed.publicationIntegrity, "GREEN");
  assert.notEqual(observed.identityDomains.generationIdentity.actualRelations.generatorWorkflowContextSha, observed.identityDomains.contentIdentity.actualRelations.dataCommit);
  assert.notEqual(observed.identityDomains.deploymentIdentity.actualRelations.deploymentApiSha, observed.identityDomains.contentIdentity.actualRelations.dataCommit);
});

test("artifact source mismatch is RED", () => {
  const observed = observe((model) => { model.attestation.content.artifactSourceCommit = "f".repeat(40); });
  assert.equal(observed.contentIdentity, "RED");
  assert.equal(observed.classification, "RED");
});

test("artifact digest mismatch is RED", () => {
  const observed = observe((model) => { model.attestation.deployment.deployedArtifactDigest = `sha256:${"7".repeat(64)}`; });
  assert.equal(observed.deploymentIdentity, "RED");
});

test("published dataset mismatch is RED", () => {
  const observed = observe((model) => { model.publishedDatasetBytes.idag = Buffer.from("different"); });
  assert.equal(observed.publicationIntegrity, "RED");
});

test("generation ID mismatch is RED", () => {
  const observed = observe((model) => { model.attestation.generationId = "different-generation"; });
  assert.equal(observed.generationIdentity, "RED");
});

test("deployment bound to wrong artifact ID is RED", () => {
  const observed = observe((model) => { model.attestation.deployment.deployedArtifactId = "other-artifact"; });
  assert.equal(observed.deploymentIdentity, "RED");
});

test("v1 with pending deployment evidence is BLOCKED rather than RED", () => {
  const model = completeV2();
  model.attestation = {
    schema: "sde-data-release-attestation/v1",
    generationId: model.manifest.generationId,
    generationManifest: { sha256: sha(model.manifestBytes) },
    datasets: {
      idag: { sha256: model.manifest.datasets.idag.sha256 },
      imorgen: { sha256: model.manifest.datasets.imorgen.sha256 }
    },
    git: { commit: "b".repeat(40), tree: "c".repeat(40) },
    publication: { pagesDeploymentId: null, deployedCommit: null }
  };
  const observed = validateProvenance(model);
  assert.equal(observed.deploymentIdentity, "BLOCKED");
  assert.notEqual(observed.classification, "RED");
});

test("v1 with ambiguous deployedCommit is BLOCKED rather than mismatch RED", () => {
  const model = completeV2();
  model.attestation = {
    schema: "sde-data-release-attestation/v1",
    generationId: model.manifest.generationId,
    generationManifest: { sha256: sha(model.manifestBytes) },
    datasets: {
      idag: { sha256: model.manifest.datasets.idag.sha256 },
      imorgen: { sha256: model.manifest.datasets.imorgen.sha256 }
    },
    git: { commit: "b".repeat(40), tree: "c".repeat(40) },
    publication: { pagesDeploymentId: "legacy-deployment", deployedCommit: "e".repeat(40) }
  };
  const observed = validateProvenance(model);
  assert.equal(observed.deploymentIdentity, "BLOCKED");
  assert.notEqual(observed.classification, "RED");
  assert.match(observed.findings.join(" "), /legacy-ambiguous|ambiguous/i);
});

test("all identity SHAs being equal remains valid", () => {
  const observed = observe((model) => {
    const same = model.attestation.content.dataCommit;
    model.attestation.generation.generatorWorkflowContextSha = same;
    model.attestation.deployment.pagesWorkflowContextSha = same;
    model.attestation.deployment.deploymentApiSha = same;
  });
  assert.equal(observed.classification, "GREEN");
});

test("different workflow context SHA is valid when content binding is intact", () => {
  const observed = observe((model) => { model.attestation.generation.generatorWorkflowContextSha = "1".repeat(40); });
  assert.equal(observed.generationIdentity, "GREEN");
  assert.equal(observed.classification, "GREEN");
});

test("different Pages build context SHA is valid when deployed artifact binding is intact", () => {
  const observed = observe((model) => { model.attestation.deployment.pagesWorkflowContextSha = "2".repeat(40); });
  assert.equal(observed.deploymentIdentity, "GREEN");
  assert.equal(observed.classification, "GREEN");
});

test("different Deployment API SHA is valid when deployed artifact binding is intact", () => {
  const observed = observe((model) => { model.attestation.deployment.deploymentApiSha = "3".repeat(40); });
  assert.equal(observed.deploymentIdentity, "GREEN");
  assert.equal(observed.classification, "GREEN");
});

test("v2 missing artifact evidence fails closed as BLOCKED", () => {
  const observed = observe((model) => {
    model.attestation.content.artifactSourceCommit = null;
    model.attestation.content.pagesArtifactId = null;
    model.attestation.content.pagesArtifactDigest = null;
  });
  assert.equal(observed.contentIdentity, "BLOCKED");
  assert.equal(observed.classification, "BLOCKED");
});

test("historical run 1156 identity shape is content/deployment/publication GREEN without semantic replay", () => {
  const observed = observe();
  assert.equal(observed.contentIdentity, "GREEN");
  assert.equal(observed.deploymentIdentity, "GREEN");
  assert.equal(observed.publicationIntegrity, "GREEN");
  assert.equal(Object.hasOwn(observed, "rawSource"), false);
});

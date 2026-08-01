"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  comparisonEligibility,
  validateProvenance
} = require("../lib/provenance.cjs");

const FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../fixtures/provenance-scenarios.json"),
  "utf8"
));

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function dataset(date, train) {
  return Buffer.from(JSON.stringify({
    date,
    updatedAt: "01.08.2026 15:00:00",
    departures: { "1": { train } },
    arrivals: { "2": { train } },
    vehicles: { "74-10": train }
  }, null, 2), "utf8");
}

function completeModel() {
  const idag = dataset("2026-08-01", "80810");
  const imorgen = dataset("2026-08-02", "80812");
  const sourceHash = sha(Buffer.from("synthetic-station-snapshot"));
  const manifest = {
    schema: "sde-data-provenance/v1",
    generationId: "fixture-generation-0001",
    timeZone: "Europe/Oslo",
    startedAt: "2026-08-01T15:22:05+02:00",
    completedAt: "2026-08-01T15:23:05+02:00",
    intendedCycle: {
      id: "2026-08-01T15:00@Europe/Oslo",
      date: "2026-08-01",
      hour: "15",
      derivation: "synthetic_fixture"
    },
    workflow: {
      event: "schedule",
      runId: "fixture-run-1",
      runAttempt: "1",
      actualWorkflowStart: "2026-08-01T15:21:55+02:00",
      actualGeneratorStart: "2026-08-01T15:22:05+02:00",
      generatorExecuted: true
    },
    source: {
      observedAt: "2026-08-01T15:22:30+02:00",
      rawStationSha256: sourceHash,
      rawStationBeforeSha256: sourceHash,
      rawStationAfterSha256: sourceHash,
      vehicleSha256: sha(Buffer.from("synthetic-vehicle-set")),
      snapshotStable: true
    },
    datasets: {
      idag: { operationalDate: "2026-08-01", sha256: sha(idag), bytes: idag.length, recordCount: 2 },
      imorgen: { operationalDate: "2026-08-02", sha256: sha(imorgen), bytes: imorgen.length, recordCount: 2 }
    },
    git: { commit: null, tree: null },
    publication: { customDomainObservability: "BLOCKED_AUTHENTICATED_IDENTITY_UNAVAILABLE" }
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
  const attestation = {
    schema: "sde-data-release-attestation/v1",
    generationId: manifest.generationId,
    generationManifest: { sha256: sha(manifestBytes) },
    datasets: {
      idag: { sha256: manifest.datasets.idag.sha256 },
      imorgen: { sha256: manifest.datasets.imorgen.sha256 }
    },
    git: { commit: "a".repeat(40), tree: "b".repeat(40) },
    publication: {
      pagesDeploymentId: "fixture-deploy-1",
      deployedCommit: "a".repeat(40),
      customDomainObservability: "BLOCKED_AUTHENTICATED_IDENTITY_UNAVAILABLE"
    }
  };
  return {
    manifest,
    manifestBytes,
    datasetBytes: { idag, imorgen },
    publishedDatasetBytes: { idag: Buffer.from(idag), imorgen: Buffer.from(imorgen) },
    attestation
  };
}

function mutate(model, mutation) {
  if (mutation === "none" || mutation === "published-identical") return model;
  if (mutation === "missing-source-hash") delete model.manifest.source.rawStationSha256;
  if (mutation === "source-changed") {
    model.manifest.source.snapshotStable = false;
    model.manifest.source.rawStationAfterSha256 = sha(Buffer.from("changed-source"));
    model.manifest.source.rawStationSha256 = model.manifest.source.rawStationAfterSha256;
  }
  if (mutation === "dataset-hash-mismatch") model.manifest.datasets.idag.sha256 = "f".repeat(64);
  if (mutation === "published-mismatch") model.publishedDatasetBytes.idag = Buffer.from("different");
  if (mutation === "missing-attestation") model.attestation = null;
  if (mutation === "delayed-known-cycle") model.manifest.workflow.actualGeneratorStart = "2026-08-01T17:05:00+02:00";
  if (mutation === "generator-skipped") model.manifest.workflow.generatorExecuted = false;
  if (mutation === "missing-manifest") {
    model.manifest = null;
    model.manifestBytes = null;
  }
  if (mutation === "conflicting-generation-id") model.attestation.generationId = "fixture-generation-conflict";
  if (mutation === "unknown-schema") model.manifest.schema = "sde-data-provenance/v999";
  return model;
}

test("fixture catalog permanently covers the twelve required provenance boundaries", () => {
  assert.equal(FIXTURES.schemaVersion, "sde-qe-provenance-fixtures/v1");
  assert.equal(FIXTURES.scenarios.length, 12);
  assert.equal(new Set(FIXTURES.scenarios.map((item) => item.id)).size, 12);
  assert.match(FIXTURES.sourcePolicy, /never refreshed from live/i);
});

for (const scenario of FIXTURES.scenarios) {
  test(`provenance fixture: ${scenario.id}`, () => {
    const observed = validateProvenance(mutate(completeModel(), scenario.mutation));
    assert.equal(observed.classification, scenario.expected);
  });
}

test("same-snapshot eligibility is explicit and generation-bound", () => {
  const model = completeModel();
  assert.deepEqual(comparisonEligibility(model.manifest, model.attestation).eligible, true);
  model.attestation.generationId = "not-the-same-generation";
  assert.deepEqual(comparisonEligibility(model.manifest, model.attestation), {
    eligible: false,
    reason: "CONFLICTING_GENERATION_IDS",
    missingProvenance: []
  });
});

test("hash evidence never claims that source content can be reconstructed", () => {
  const observed = validateProvenance(completeModel());
  assert.equal(observed.classification, "GREEN");
  assert.equal(Object.hasOwn(observed, "rawSource"), false);
  assert.equal(observed.customDomainObservability, "BLOCKED_AUTHENTICATED_IDENTITY_UNAVAILABLE");
});

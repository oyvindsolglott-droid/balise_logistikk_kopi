"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { result, summarize } = require("../lib/core.cjs");
const { mapFunctionStatuses } = require("../lib/checks.cjs");
const {
  recommendationsFor,
  renderGithubSummary,
  renderHtml,
  renderJUnit,
  renderMarkdown,
  provenanceIdentityDomains,
  writeReports
} = require("../lib/reporters.cjs");

function sampleReport() {
  const results = [
    result({
      id: "QE-CORE-001",
      area: "quality-engine",
      name: "Probe",
      status: "GREEN",
      critical: true,
      summary: "Probe er grønn."
    })
  ];
  return {
    runId: "unit-report",
    generatedAt: "2026-07-31T00:00:00Z",
    suite: "unit",
    git: {
      commit: "abc",
      branch: "detached",
      baseline: "abc",
      clean: false,
      changedFiles: ["tests/sde-quality-engine/run.cjs"]
    },
    results,
    summary: summarize(results),
    functionMatrix: [],
    commands: [],
    productionSafety: {
      allowedMethods: ["GET", "HEAD"],
      ledger: [],
      guardVerified: true
    },
    recommendations: []
  };
}

test("alle fem rapportformatene rendres fra samme modell", () => {
  const report = sampleReport();
  assert.match(renderMarkdown(report), /## 12\. Begrensninger/);
  assert.match(renderJUnit(report), /<testsuite/);
  assert.match(renderHtml(report), /SDE Quality Engine/);
  assert.match(renderGithubSummary(report), /SDE Quality Engine/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-report-"));
  try {
    const written = writeReports(report, directory);
    assert.deepEqual(Object.keys(written.files).sort(), ["githubSummary", "html", "json", "junit", "markdown"]);
    for (const bytes of Object.values(written.bytes)) assert.ok(bytes > 100);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy provenance without a chain remains reportable as external HOLD evidence", () => {
  const report = sampleReport();
  report.results.push(result({
    id: "PROV-001",
    area: "data-provenance",
    name: "Manifest structure",
    status: "BLOCKED",
    critical: true,
    summary: "Legacy dataset has no generation manifest; no product defect inferred.",
    details: {
      provenance: {
        generationId: null,
        publicationIntegrity: "BLOCKED",
        customDomainObservability: "NOT_EVALUATED",
        comparisonEligibility: {
          eligible: false,
          reason: "LEGACY_DATASET_WITHOUT_MANIFEST"
        },
        findings: ["Legacy dataset has no generation manifest; no product defect inferred."]
      }
    }
  }));
  const markdown = renderMarkdown(report);
  assert.match(markdown, /LEGACY_DATASET_WITHOUT_MANIFEST/);
  assert.match(markdown, /no product defect inferred/);
});

test("all report surfaces expose the four independent attestation identity domains", () => {
  const report = sampleReport();
  const identityDomains = {
    generationIdentity: { name: "Generation identity", status: "GREEN", role: "Generator execution", expectedRelations: ["generationId matches"], actualRelations: { generationId: "g-1" }, findings: [] },
    contentIdentity: { name: "Content identity", status: "GREEN", role: "Exact bytes", expectedRelations: ["artifactSourceCommit = dataCommit"], actualRelations: { dataCommit: "b".repeat(40) }, findings: [] },
    deploymentIdentity: { name: "Deployment identity", status: "GREEN", role: "Pages execution", expectedRelations: ["artifact ID matches"], actualRelations: { deploymentId: "deploy-1" }, findings: [] },
    publicationIntegrity: { name: "Publication integrity", status: "GREEN", role: "Published bytes", expectedRelations: ["hashes match"], actualRelations: { etag: "fixture" }, findings: [] }
  };
  report.results.push(result({
    id: "PROV-001",
    area: "data-provenance",
    name: "Manifest structure",
    status: "GREEN",
    critical: true,
    summary: "Identity domains are green.",
    details: {
      provenance: {
        generationId: "g-1",
        comparisonEligibility: { eligible: true, reason: "SAME_GENERATION_SNAPSHOT_PROVEN" },
        publicationIntegrity: "GREEN",
        customDomainObservability: "GREEN_AUTHENTICATED_GET",
        identityDomains,
        identityResults: Object.values(identityDomains),
        chain: [],
        findings: []
      }
    }
  }));
  assert.equal(provenanceIdentityDomains(report.results[1].details.provenance).length, 4);
  for (const rendered of [renderMarkdown(report), renderHtml(report), renderGithubSummary(report), renderJUnit(report)]) {
    assert.match(rendered, /Generation identity/);
    assert.match(rendered, /Content identity/);
    assert.match(rendered, /Deployment identity/);
    assert.match(rendered, /Publication integrity/);
  }
});

test("anbefalinger er undersøkelsesforslag med risiko og eksplisitt fullmaktskrav", () => {
  const report = sampleReport();
  report.results = [result({
    id: "BALISE-010-LIVE",
    area: "tursatt-balise",
    name: "Live",
    status: "AMBER",
    critical: true,
    summary: "Må undersøkes.",
    recommendation: "Sammenlign snapshotproveniens."
  })];
  const [recommendation] = recommendationsFor(report);
  assert.equal(recommendation.recommendationId, "REC-BALISE-010-LIVE");
  assert.equal(recommendation.investigation, "Sammenlign snapshotproveniens.");
  assert.match(recommendation.requiredAuthority, /uttrykkelig systemeiergodkjenning/);
  assert.ok(recommendation.risks.prematureChange);
  assert.ok(recommendation.risks.noAction);
});

test("funksjon forblir UNKNOWN når én av flere kontrakter mangler", () => {
  const matrix = {
    functions: [{
      id: "F-1",
      module: "M",
      name: "N",
      source: "S",
      expected: "E",
      testTypes: ["unit"],
      contracts: ["A", "B"]
    }]
  };
  const observed = mapFunctionStatuses(matrix, [
    result({
      id: "A",
      area: "test",
      name: "A",
      status: "GREEN",
      summary: "A"
    })
  ]);
  assert.equal(observed[0].status, "UNKNOWN");
  assert.deepEqual(observed[0].missingContracts, ["B"]);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { result, summarize } = require("../lib/core.cjs");
const { mapFunctionStatuses } = require("../lib/checks.cjs");
const {
  renderHtml,
  renderJUnit,
  renderMarkdown,
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

test("alle fire rapportformatene rendres fra samme modell", () => {
  const report = sampleReport();
  assert.match(renderMarkdown(report), /## 12\. Begrensninger/);
  assert.match(renderJUnit(report), /<testsuite/);
  assert.match(renderHtml(report), /SDE Quality Engine/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-report-"));
  try {
    const written = writeReports(report, directory);
    assert.deepEqual(Object.keys(written.files).sort(), ["html", "json", "junit", "markdown"]);
    for (const bytes of Object.values(written.bytes)) assert.ok(bytes > 100);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

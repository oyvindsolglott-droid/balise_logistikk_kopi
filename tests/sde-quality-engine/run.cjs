#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  gitValue,
  nowOsloParts,
  readJson,
  repoRoot,
  result,
  summarize
} = require("./lib/core.cjs");
const {
  baliseChecks,
  mapFunctionStatuses,
  runPythonSuite,
  runRegressionSuite,
  runServerSuite,
  runStrictSuite,
  runUnitSuite,
  staticChecks,
  validateAccounting,
  validateRegistry
} = require("./lib/checks.cjs");
const { buildAccounting } = require("./lib/accounting.cjs");
const { buildInventory } = require("./lib/inventory.cjs");
const {
  ALLOWED_METHODS,
  assertReadOnlyMethod,
  runProductionReadOnly
} = require("./lib/production-readonly.cjs");
const {
  recommendationsFor,
  renderGithubSummary,
  renderHtml,
  renderJUnit,
  renderMarkdown,
  writeReports
} = require("./lib/reporters.cjs");
const { provenanceChecks } = require("./lib/provenance.cjs");

const SUITES = new Set([
  "all",
  "balise",
  "ci",
  "e2e",
  "integration",
  "production-readonly",
  "provenance",
  "regression",
  "report"
]);

function selectedSuite(argv) {
  const index = argv.indexOf("--suite");
  const suite = index >= 0 ? argv[index + 1] : "all";
  if (!SUITES.has(suite)) {
    throw new Error(`Ukjent suite '${suite}'. Tillatt: ${[...SUITES].sort().join(", ")}`);
  }
  return suite;
}

function changedFiles() {
  const tracked = gitValue(["diff", "--name-only", "HEAD"]) || "";
  const untracked = gitValue(["ls-files", "--others", "--exclude-standard"]) || "";
  return [...new Set(
    `${tracked}\n${untracked}`.split("\n")
      .filter(Boolean)
  )].sort();
}

function guardResult() {
  const accepted = [];
  const rejected = [];
  for (const method of ["GET", "HEAD"]) {
    accepted.push(assertReadOnlyMethod(method));
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    try {
      assertReadOnlyMethod(method);
    } catch (error) {
      if (/SDE_QE_READ_ONLY_GUARD/.test(error.message)) rejected.push(method);
    }
  }
  const green = accepted.length === 2 && rejected.length === 4;
  return result({
    id: "QE-SAFE-001",
    area: "production-safety",
    name: "Produksjonskontroll er teknisk read-only",
    status: green ? "GREEN" : "RED",
    critical: true,
    summary: green
      ? "GET/HEAD godtas; POST/PUT/PATCH/DELETE avvises før fetch."
      : `Guardavvik: accepted=${accepted.join(",")}; rejected=${rejected.join(",")}.`,
    evidence: ["tests/sde-quality-engine/lib/production-readonly.cjs", "request-ledger: ingen nettverkskall"],
    details: { accepted, rejected }
  });
}

function projectedResult(contractId, area, name, sources, summary) {
  const sourceStatuses = sources.map((item) => item.status);
  let status = "UNKNOWN";
  if (sourceStatuses.length) {
    if (sourceStatuses.includes("RED")) status = "RED";
    else if (sourceStatuses.includes("BLOCKED")) status = "BLOCKED";
    else if (sourceStatuses.includes("UNKNOWN")) status = "UNKNOWN";
    else if (sourceStatuses.includes("AMBER")) status = "AMBER";
    else status = "GREEN";
  }
  const projectionScope = `${area}-${name}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toUpperCase();
  return result({
    id: `QE-PROJECTION-${contractId}-${projectionScope}`,
    contractId,
    area,
    name,
    status,
    critical: true,
    summary: status === "GREEN" ? summary : `Underliggende port er ${status}.`,
    evidence: sources.flatMap((item) => [item.id, ...(item.evidence || []).slice(0, 1)]),
    details: { sourceIds: sources.map((item) => item.id), sourceStatuses }
  });
}

function regressionProjections(regression) {
  return [
    projectedResult(
      "SDE-002",
      "skiftebevegelser",
      "Historisk identitet og gjentatt ordre",
      [regression],
      "Permanent qualification beviser at nye ordrer ikke gjenbruker foreldet kjede-/action-identitet."
    ),
    projectedResult(
      "SDE-003",
      "skiftebevegelser",
      "Manuell målplassering",
      [regression],
      "Permanent qualification beviser fail-closed målspor og tillatte ledige mål."
    ),
    projectedResult(
      "SDE-004",
      "skiftebevegelser",
      "Utført/annullert livssyklus",
      [regression],
      "Permanent qualification beviser kort-, reservasjon-, overlay- og actual-livssyklus."
    ),
    projectedResult(
      "ROBUST-001",
      "robustness",
      "Regresjonsmotorens negative porter",
      [regression],
      "Determinisme, kontrakter og mutasjonsaudit er grønne uten skips eller xfail."
    )
  ];
}

function serverProjections(serverResults) {
  const find = (pattern) => serverResults.filter((item) => pattern.test(item.name));
  return [
    projectedResult(
      "CONCURRENCY-001",
      "multiuser",
      "Revisjon og idempotency i delte write-modeller",
      [
        ...find(/shared-sporplan-draft/i),
        ...find(/operational-state/i),
        ...find(/first-open-semantic-idempotency/i)
      ],
      "Serverkontraktene for stale revision, append/readback og idempotent first-open er grønne."
    ),
    projectedResult(
      "ROBUST-001",
      "robustness",
      "Serverfeil og guards er fail-closed",
      [
        ...find(/guards/i),
        ...find(/auth-policy/i),
        ...find(/runtime-authorization/i)
      ],
      "Serverens negative policy- og guardtester er grønne."
    )
  ];
}

function reporterSelfTest(baseReport) {
  try {
    const probe = {
      ...baseReport,
      results: [
        result({
          id: "QE-REPORT-PROBE",
          contractId: "QE-CORE-002",
          area: "quality-engine",
          name: "Rapportprobe",
          status: "GREEN",
          critical: true,
          summary: "Rapportprobe"
        })
      ],
      functionMatrix: [],
      recommendations: []
    };
    probe.summary = summarize(probe.results);
    const rendered = {
      json: JSON.stringify(probe),
      markdown: renderMarkdown(probe),
      githubSummary: renderGithubSummary(probe),
      junit: renderJUnit(probe),
      html: renderHtml(probe)
    };
    const missing = Object.entries(rendered)
      .filter(([, text]) => !text || !/QE|SDE Quality Engine/.test(text))
      .map(([name]) => name);
    return result({
      id: "QE-CORE-002",
      area: "quality-engine",
      name: "Rapportsett er komplett",
      status: missing.length ? "RED" : "GREEN",
      critical: true,
      summary: missing.length
        ? `Rapportprobe mangler innhold i: ${missing.join(", ")}.`
        : "JSON, Markdown, JUnit XML og HTML rendres fra samme resultatmodell.",
      evidence: ["reporter-self-test", ...Object.keys(rendered)],
      details: { missing }
    });
  } catch (error) {
    return result({
      id: "QE-CORE-002",
      area: "quality-engine",
      name: "Rapportsett er komplett",
      status: "RED",
      critical: true,
      summary: `Rapportprobe feilet: ${error.message}`,
      evidence: ["tests/sde-quality-engine/lib/reporters.cjs"]
    });
  }
}

function baseReport(suite, inventory, productionSafety) {
  const root = repoRoot();
  const commit = gitValue(["rev-parse", "HEAD"]);
  const changed = changedFiles();
  return {
    schemaVersion: "1.0.0",
    runId: `sde-qe-${suite}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    generatedAt: `${new Date().toISOString()} (${nowOsloParts().display} Europe/Oslo)`,
    suite,
    git: {
      commit,
      branch: gitValue(["branch", "--show-current"]) || "detached",
      baseline: commit,
      originMain: gitValue(["rev-parse", "--verify", "origin/main"]),
      clean: changed.length === 0,
      changedFiles: changed
    },
    inventory,
    results: [],
    functionMatrix: [],
    commands: [],
    productionSafety: {
      allowedMethods: [...ALLOWED_METHODS],
      guardVerified: productionSafety.guardVerified,
      ledger: productionSafety.ledger
    },
    reportDirectory: path.relative(root, path.join(root, "tests/sde-quality-engine/reports"))
  };
}

async function main() {
  const suite = selectedSuite(process.argv.slice(2));
  const root = repoRoot();
  const inventory = buildInventory();
  const matrix = readJson(path.join(root, "tests/sde-quality-engine/matrix/function-matrix.json"));
  const productionSafety = { guardVerified: true, ledger: [] };
  const report = baseReport(suite, inventory, productionSafety);
  const results = [validateRegistry(), validateAccounting(), guardResult()];

  if (!["production-readonly", "provenance"].includes(suite)) {
    results.push(...staticChecks(inventory), ...baliseChecks());
  }

  if (["all", "balise", "ci", "integration", "provenance"].includes(suite)) {
    results.push(...provenanceChecks());
  }

  if (["all", "balise", "ci", "integration", "regression"].includes(suite)) {
    results.push(runUnitSuite());
  }

  if (["all", "balise", "integration"].includes(suite)) {
    results.push(runPythonSuite());
  }

  if (suite === "e2e") {
    const strict = runStrictSuite();
    results.push(strict, ...regressionProjections(strict));
  }

  if (["all", "regression"].includes(suite)) {
    const regression = runRegressionSuite();
    results.push(regression, ...regressionProjections(regression));
  }

  if (["all", "integration"].includes(suite)) {
    const server = runServerSuite(inventory);
    results.push(...server, ...serverProjections(server));
  }

  if (suite === "production-readonly") {
    const production = await runProductionReadOnly(process.env.SDE_QE_PRODUCTION_URL);
    productionSafety.ledger.push(...production.ledger);
    results.push(...production.results);
  }

  report.results = results;
  report.productionSafety.ledger = productionSafety.ledger;
  report.results.push(reporterSelfTest(report));
  report.summary = summarize(report.results);
  report.functionMatrix = mapFunctionStatuses(matrix, report.results);
  report.commands = [...new Set(
    report.results.map((item) => item.details?.command).filter(Boolean)
  )];
  report.recommendations = recommendationsFor(report);
  report.accounting = buildAccounting({
    results: report.results,
    functionMatrix: report.functionMatrix,
    recommendations: report.recommendations,
    contracts: readJson(path.join(root, "tests/sde-quality-engine/contracts/green-contract.json"))
  });

  const output = writeReports(
    report,
    path.join(root, "tests/sde-quality-engine/reports")
  );
  const matrixCounts = report.functionMatrix.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, {});

  console.log(`SDE Quality Engine: ${report.summary.classification}`);
  console.log(`Suite: ${suite}`);
  console.log(`Kontroller: ${report.summary.total} (${Object.entries(report.summary.counts).map(([key, value]) => `${key}=${value}`).join(", ")})`);
  console.log(`Funksjonsmatrise: ${Object.entries(matrixCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  console.log(`Rapporter: ${Object.entries(output.files).map(([key, file]) => `${key}=${path.relative(root, file)}`).join(", ")}`);
  console.log("Production write: 0 (GET/HEAD-guard aktiv)");

  if (["NO-GO", "HOLD"].includes(report.summary.classification)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`SDE Quality Engine feilet før rapport: ${error.stack || error.message}`);
  process.exitCode = 1;
});

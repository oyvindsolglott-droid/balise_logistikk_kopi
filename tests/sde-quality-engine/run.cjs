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
const { liveDataContinuityGate } = require("./lib/live-data-continuity.cjs");

const SUITES = new Set([
  "all",
  "balise",
  "ci",
  "e2e",
  "integration",
  "multiuser",
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

function multiuserOptions(argv) {
  const values = (name) => argv.flatMap((value, index) => value === name ? [argv[index + 1]] : []).filter((value) => value && !value.startsWith("--"));
  return {
    multiuserEvidencePaths: values("--multiuser-evidence"),
    multiuserApprovedSha: values("--multiuser-approved-sha").at(-1) || null,
    multiuserApprovedTree: values("--multiuser-approved-tree").at(-1) || null,
    multiuserSubjectRepository: values("--multiuser-subject-repository").at(-1) || null,
    multiuserSubjectMode: values("--multiuser-subject-mode").at(-1) || "LOCAL_GIT_REPOSITORY"
  };
}

function liveDataOptions(argv) {
  const values = (name) => argv.flatMap((value, index) =>
    value === name ? [argv[index + 1]] : []
  ).filter((value) => value && !value.startsWith("--"));
  const explicitEvidence = values("--live-data-evidence");
  return {
    inputPaths: explicitEvidence.length
      ? explicitEvidence
      : process.env.SDE_QE_LIVE_DATA_EVIDENCE
        ? [process.env.SDE_QE_LIVE_DATA_EVIDENCE]
        : [],
    subjectRepository: values("--live-data-runtime-repository").at(-1) ||
      process.env.SDE_QE_LIVE_DATA_RUNTIME_REPOSITORY || null,
    approvedSha: values("--live-data-approved-sha").at(-1) ||
      process.env.SDE_QE_LIVE_DATA_APPROVED_SHA || null,
    approvedTree: values("--live-data-approved-tree").at(-1) ||
      process.env.SDE_QE_LIVE_DATA_APPROVED_TREE || null,
    approvedMainRef: values("--live-data-approved-main-ref").at(-1) ||
      process.env.SDE_QE_LIVE_DATA_APPROVED_MAIN_REF || "refs/remotes/origin/main"
  };
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

function baseReport(suite, inventory, productionSafety, multiuser = {}) {
  const root = repoRoot();
  const commit = gitValue(["rev-parse", "HEAD"]);
  const tree = gitValue(["rev-parse", "HEAD^{tree}"]);
  const parent = gitValue(["rev-parse", "HEAD^"]);
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
    identityBindings: {
      evaluator: {
        candidateSha: commit,
        candidateTree: tree,
        parentSha: parent,
        repository: root,
        worktreeStatus: changed.length === 0 ? "CLEAN" : "DIRTY"
      },
      evidenceProducer: null,
      subject: {
        mode: multiuser.multiuserSubjectMode || "LOCAL_GIT_REPOSITORY",
        repository: multiuser.multiuserSubjectRepository || null,
        approvedSha: multiuser.multiuserApprovedSha || null,
        approvedTree: multiuser.multiuserApprovedTree || null,
        runtimeSha: null,
        runtimeTree: null,
        ancestryVerified: false,
        dataOnlyScopeVerified: false
      },
      contractQualification: "NOT_EVALUATED",
      productionMultiuserLiveStatus: "NOT_EVALUATED"
    },
    reportDirectory: path.relative(root, path.join(root, "tests/sde-quality-engine/reports"))
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const suite = selectedSuite(argv);
  const multiuser = multiuserOptions(argv);
  const liveData = liveDataOptions(argv);
  const root = repoRoot();
  const inventory = buildInventory();
  const matrix = readJson(path.join(root, "tests/sde-quality-engine/matrix/function-matrix.json"));
  const productionSafety = { guardVerified: true, ledger: [] };
  const report = baseReport(suite, inventory, productionSafety, multiuser);
  const results = [validateRegistry(), validateAccounting(), guardResult()];

  if (!["production-readonly", "provenance"].includes(suite)) {
    results.push(...staticChecks(inventory, multiuser));
    if (suite !== "multiuser") results.push(...baliseChecks());
  }

  if (["all", "balise", "ci", "integration", "provenance"].includes(suite)) {
    results.push(...provenanceChecks());
  }

  if (["all", "balise", "ci", "integration", "report"].includes(suite)) {
    results.push(liveDataContinuityGate(liveData));
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
  const multiuserGate = report.results.find((item) => item.id === "MULTIUSER-LIVE-001");
  if (multiuserGate) {
    report.identityBindings.evidenceProducer = multiuserGate.details?.producerIdentity || null;
    const subject = multiuserGate.details?.subjectIdentity;
    if (subject) {
      report.identityBindings.subject = {
        mode: multiuser.multiuserSubjectMode,
        repository: subject.subjectRepository,
        approvedSha: subject.approvedSha,
        approvedTree: subject.approvedTree,
        runtimeSha: subject.runtimeSha,
        runtimeTree: subject.runtimeTree,
        ancestryVerified: subject.ancestryVerified,
        dataOnlyScopeVerified: subject.dataOnlyScopeVerified
      };
    }
    report.identityBindings.contractQualification = multiuserGate.status;
  }
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

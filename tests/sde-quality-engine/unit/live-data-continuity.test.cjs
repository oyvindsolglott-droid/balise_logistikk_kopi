"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  bindLiveDataEvidence,
  evaluateLiveDataContinuity,
  expectedLiveDataDates
} = require("../lib/live-data-continuity.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const FIXTURES = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../fixtures/live-data-continuity-scenarios.json"),
  "utf8"
));
const DATA_PATHS = [
  "data/api_idag.json",
  "data/api_imorgen.json",
  "data/sde-data-provenance.json"
];

function git(repository, ...args) {
  const child = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
  assert.equal(child.status, 0, `${args.join(" ")}\n${child.stdout}\n${child.stderr}`);
  return child.stdout.trim();
}

function sha(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeDatasets(repository, dates, generationId) {
  fs.mkdirSync(path.join(repository, "data"), { recursive: true });
  const datasetBytes = {};
  for (const mode of ["idag", "imorgen"]) {
    const date = dates[mode];
    const payload = {
      date,
      updatedAt: `${date.split("-").reverse().join(".")} 15:00:00`,
      fixtureGeneration: generationId,
      arrivals: {},
      departures: {},
      vehicles: {}
    };
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
    datasetBytes[mode] = bytes;
    fs.writeFileSync(path.join(repository, `data/api_${mode}.json`), bytes);
  }
  const provenance = {
    schema: "sde-data-provenance/v1",
    generationId,
    timeZone: "Europe/Oslo",
    source: {
      observedAt: "2026-08-01T15:00:00+02:00",
      rawStationSha256: sha(Buffer.from("synthetic-station")),
      vehicleSha256: sha(Buffer.from("synthetic-vehicles")),
      snapshotStable: true
    },
    datasets: {
      idag: {
        operationalDate: dates.idag,
        sha256: sha(datasetBytes.idag),
        bytes: datasetBytes.idag.length
      },
      imorgen: {
        operationalDate: dates.imorgen,
        sha256: sha(datasetBytes.imorgen),
        bytes: datasetBytes.imorgen.length
      }
    },
    git: { commit: null, tree: null }
  };
  fs.writeFileSync(
    path.join(repository, "data/sde-data-provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`
  );
}

function commit(repository, subject) {
  git(repository, "add", ".");
  git(repository, "commit", "-m", subject);
  return {
    sha: git(repository, "rev-parse", "HEAD"),
    tree: git(repository, "rev-parse", "HEAD^{tree}")
  };
}

function createRepository({ now = new Date("2026-08-01T13:00:00Z"), descendant = true, stale = false } = {}) {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-live-data-"));
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "sde-qe@example.invalid");
  git(repository, "config", "user.name", "SDE QE fixture");
  const expected = expectedLiveDataDates(now);
  const initialDates = stale
    ? { idag: "2026-07-31", imorgen: "2026-08-01" }
    : expected;
  writeDatasets(repository, initialDates, "generation-approved");
  fs.writeFileSync(path.join(repository, "README.md"), "synthetic SDE subject\n");
  const approved = commit(repository, "approved code");
  if (descendant) {
    writeDatasets(repository, initialDates, "generation-runtime");
    commit(repository, "data refresh");
  }
  return { repository, approved, now };
}

function gitDataset(repository, mode) {
  const bytes = Buffer.from(git(repository, "show", `HEAD:data/api_${mode}.json`));
  const normalized = Buffer.concat([bytes, Buffer.from("\n")]);
  const parsed = JSON.parse(normalized);
  return {
    date: parsed.date,
    bytes: normalized.length,
    sha256: sha(normalized)
  };
}

function makeEvidence(fixture, overrides = {}) {
  const runtimeHead = git(fixture.repository, "rev-parse", "HEAD");
  const runtimeTree = git(fixture.repository, "rev-parse", "HEAD^{tree}");
  const datasets = {
    idag: gitDataset(fixture.repository, "idag"),
    imorgen: gitDataset(fixture.repository, "imorgen")
  };
  const evidence = {
    schemaVersion: "sde-live-data-continuity/v1",
    observedAt: fixture.now.toISOString(),
    deployedAt: new Date(fixture.now.getTime() - 60_000).toISOString(),
    timeZone: "Europe/Oslo",
    evidenceClass: "FRESH_OBSERVED",
    source: {
      available: true,
      httpStatus: 200,
      contentType: "application/json",
      observedAt: fixture.now.toISOString(),
      rawStationSha256: sha(Buffer.from("synthetic-station")),
      vehicleSha256: sha(Buffer.from("synthetic-vehicles")),
      snapshotStable: true
    },
    scheduler: {
      checkedAt: fixture.now.toISOString(),
      processHealthy: true,
      intervalObserved: true,
      attemptedAfterDeploy: true,
      exitCode: 0,
      blocker: null
    },
    applyReadiness: {
      branchGuardPassed: true,
      historyCompared: true,
      dataOnlyCandidateEvaluated: true
    },
    actualSync: {
      state: runtimeHead === fixture.approved.sha ? "up_to_date" : "synced",
      previousHead: fixture.approved.sha,
      detectedHead: runtimeHead,
      headMoved: runtimeHead !== fixture.approved.sha,
      commitsClassified: runtimeHead !== fixture.approved.sha,
      servedBytesMatch: true,
      codeAssetsIdentical: true,
      changedFiles: runtimeHead === fixture.approved.sha ? [] : DATA_PATHS
    },
    privateReadback: {
      available: true,
      observedAt: fixture.now.toISOString(),
      httpStatus: 200,
      contentType: "application/json; charset=utf-8",
      bodyKind: "json",
      datasets
    },
    publicReadback: {
      available: true,
      observedAt: fixture.now.toISOString(),
      authenticated: true,
      httpStatus: 200,
      contentType: "application/json; charset=utf-8",
      bodyKind: "json",
      datasets
    },
    ui: {
      available: true,
      observedAt: fixture.now.toISOString(),
      displayedDates: { idag: datasets.idag.date, imorgen: datasets.imorgen.date },
      warnings: []
    },
    publicationAttestation: {
      available: true,
      dataCommit: runtimeHead,
      dataTree: runtimeTree,
      datasets
    },
    historicalReport: {
      status: "GREEN",
      observedAt: "2026-07-01T00:00:00Z"
    },
    manualAttestation: null,
    actionsAttempted: []
  };
  return structuredClone(Object.assign(evidence, overrides));
}

function evaluate(fixture, evidence = makeEvidence(fixture)) {
  return evaluateLiveDataContinuity({
    evidence: bindLiveDataEvidence(evidence),
    now: fixture.now,
    subjectRepository: fixture.repository,
    approvedSha: fixture.approved.sha,
    approvedTree: fixture.approved.tree,
    approvedMainRef: "refs/heads/main"
  });
}

function subgate(gate, id) {
  const observed = gate.details.subgates.find((item) => item.id === id);
  assert.ok(observed, `missing subgate ${id}`);
  return observed;
}

test("fixture catalog permanently covers all eighteen required P0 scenarios", () => {
  assert.equal(FIXTURES.schemaVersion, "sde-qe-live-data-continuity-fixtures/v1");
  assert.equal(FIXTURES.scenarios.length, 18);
  assert.equal(new Set(FIXTURES.scenarios.map((item) => item.id)).size, 18);
  assert.match(FIXTURES.sourcePolicy, /never refreshed from live/i);
});

test("server health GREEN never hides stale api_idag", (t) => {
  const fixture = createRepository({ stale: true });
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const gate = evaluate(fixture);
  assert.equal(subgate(gate, "LIVE-DATA-OPERATIVE-DATES").status, "RED");
  assert.notEqual(gate.status, "GREEN");
});

test("up_to_date may prove scheduler/readiness but never actual sync", (t) => {
  const fixture = createRepository({ descendant: false });
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const gate = evaluate(fixture);
  assert.equal(subgate(gate, "SCHEDULER_HEALTH").status, "GREEN");
  assert.equal(subgate(gate, "DATA_APPLY_READINESS").status, "GREEN");
  assert.equal(subgate(gate, "ACTUAL_SYNC_APPLIED").status, "BLOCKED");
  assert.equal(gate.status, "BLOCKED");
});

test("a real data-only synced fast-forward with matching readback is GREEN", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const gate = evaluate(fixture);
  assert.equal(
    subgate(gate, "ACTUAL_SYNC_APPLIED").status,
    "GREEN",
    JSON.stringify(gate.details.subgates, null, 2)
  );
  assert.equal(gate.status, "GREEN", JSON.stringify(gate.details.subgates, null, 2));
});

test("detached runtime HEAD cannot be GREEN", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  git(fixture.repository, "checkout", "--detach");
  const gate = evaluate(fixture);
  assert.notEqual(subgate(gate, "LIVE-DATA-CODE-IDENTITY").status, "GREEN");
  assert.notEqual(gate.status, "GREEN");
});

test("exact APPROVED_CODE_SHA can make code identity GREEN", (t) => {
  const fixture = createRepository({ descendant: false });
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const gate = evaluate(fixture);
  assert.equal(subgate(gate, "LIVE-DATA-CODE-IDENTITY").status, "GREEN");
});

test("verified three-file data-only descendant can make code identity GREEN", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const gate = evaluate(fixture);
  assert.equal(subgate(gate, "LIVE-DATA-CODE-IDENTITY").status, "GREEN");
  assert.equal(gate.details.dataOnlyDescendantStatus, "GREEN");
});

test("code, test, config or asset change in descendant interval blocks P0", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.repository, "config.json"), "{}\n");
  commit(fixture.repository, "unauthorized config");
  const gate = evaluate(fixture, makeEvidence(fixture));
  assert.notEqual(subgate(gate, "LIVE-DATA-CODE-IDENTITY").status, "GREEN");
  assert.notEqual(gate.status, "GREEN");
});

test("wrong api_idag/api_imorgen at every transition sample is RED", (t) => {
  const instants = [
    "2026-01-15T05:59:59Z", "2026-01-15T06:00:00Z", "2026-01-15T06:00:01Z",
    "2026-01-15T13:59:59Z", "2026-01-15T14:00:00Z", "2026-01-15T14:00:01Z"
  ];
  for (const instant of instants) {
    const fixture = createRepository({ now: new Date(instant), stale: true });
    t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
    const evidence = makeEvidence(fixture);
    evidence.privateReadback.datasets.idag.date = "1900-01-01";
    evidence.privateReadback.datasets.imorgen.date = "1900-01-01";
    const gate = evaluate(fixture, evidence);
    assert.equal(subgate(gate, "LIVE-DATA-OPERATIVE-DATES").status, "RED", instant);
  }
});

test("fresh private readback plus public login HTML cannot be GREEN", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const evidence = makeEvidence(fixture);
  evidence.publicReadback = {
    available: true,
    authenticated: false,
    observedAt: fixture.now.toISOString(),
    httpStatus: 200,
    contentType: "text/html",
    bodyKind: "login_html",
    datasets: null
  };
  const gate = evaluate(fixture, evidence);
  assert.notEqual(subgate(gate, "PUBLIC_AUTHENTICATED_READBACK").status, "GREEN");
  assert.notEqual(gate.status, "GREEN");
});

test("fresh Git/private bytes plus stale DOM date or warning cannot be GREEN", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const evidence = makeEvidence(fixture);
  evidence.ui.displayedDates.idag = "2026-07-31";
  evidence.ui.warnings = ["Dataene er foreldet"];
  const gate = evaluate(fixture, evidence);
  assert.equal(subgate(gate, "ACTUAL_UI_FRESHNESS").status, "RED");
  assert.notEqual(gate.status, "GREEN");
});

test("fresh stale readback overrides historical GREEN", (t) => {
  const fixture = createRepository({ stale: true });
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const gate = evaluate(fixture);
  assert.equal(gate.details.evidencePriority.winner, "FRESH_OBSERVED");
  assert.equal(gate.details.evidencePriority.historicalGreenOverridden, true);
  assert.notEqual(gate.status, "GREEN");
});

test("missing critical evidence fails closed to HOLD", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const evidence = makeEvidence(fixture);
  delete evidence.publicReadback;
  const gate = evaluate(fixture, evidence);
  assert.equal(gate.status, "BLOCKED");
});

test("unavailable external source is TOOL BLOCKER rather than product RED", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const evidence = makeEvidence(fixture);
  evidence.source = {
    available: false,
    httpStatus: null,
    contentType: null,
    observedAt: fixture.now.toISOString(),
    rawStationSha256: null,
    vehicleSha256: null,
    snapshotStable: false
  };
  const gate = evaluate(fixture, evidence);
  const source = subgate(gate, "LIVE-DATA-SOURCE");
  assert.equal(source.status, "BLOCKED");
  assert.match(source.reasonCode, /TOOL_BLOCKER/);
  assert.equal(gate.status, "BLOCKED");
});

test("null generation commit/tree is a known limitation, never full attestation", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const evidence = makeEvidence(fixture);
  evidence.publicationAttestation = { available: false };
  const gate = evaluate(fixture, evidence);
  assert.equal(subgate(gate, "LIVE-DATA-PROVENANCE").status, "BLOCKED");
  assert.notEqual(gate.status, "GREEN");
});

test("stale or non-fresh evidence classes cannot close P0", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const reused = makeEvidence(fixture);
  reused.evidenceClass = "REUSED_EXACT_SHA";
  const reusedGate = evaluate(fixture, reused);
  assert.equal(subgate(reusedGate, "LIVE-DATA-EVIDENCE-PRIORITY").status, "BLOCKED");
  assert.equal(reusedGate.status, "BLOCKED");

  const stale = makeEvidence(fixture);
  stale.observedAt = new Date(fixture.now.getTime() - 31 * 60_000).toISOString();
  const staleGate = evaluate(fixture, stale);
  assert.equal(staleGate.status, "BLOCKED");
  assert.match(staleGate.reasonCode, /EVIDENCE_STALE/);
});

test("tampered or unknown-producer evidence cannot become GREEN", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const bound = bindLiveDataEvidence(makeEvidence(fixture));
  bound.ui.warnings.push("tampered after binding");
  const tampered = evaluateLiveDataContinuity({
    evidence: bound,
    now: fixture.now,
    subjectRepository: fixture.repository,
    approvedSha: fixture.approved.sha,
    approvedTree: fixture.approved.tree,
    approvedMainRef: "refs/heads/main"
  });
  assert.equal(tampered.status, "BLOCKED");
  assert.match(tampered.reasonCode, /BINDING_MISMATCH/);

  const unknown = bindLiveDataEvidence(makeEvidence(fixture));
  unknown.producer.id = "manual-editor";
  unknown.binding.payloadSha256 = require("../lib/live-data-continuity.cjs").evidencePayloadSha256(unknown);
  const unknownGate = evaluateLiveDataContinuity({
    evidence: unknown,
    now: fixture.now,
    subjectRepository: fixture.repository,
    approvedSha: fixture.approved.sha,
    approvedTree: fixture.approved.tree,
    approvedMainRef: "refs/heads/main"
  });
  assert.equal(unknownGate.status, "BLOCKED");
  assert.match(unknownGate.reasonCode, /PRODUCER_MISMATCH/);
});

test("Europe/Oslo contract switches exactly at 07:00 and 15:00 across DST seasons", () => {
  const samples = [
    ["2026-01-15T05:59:59Z", { idag: "2026-01-14", imorgen: "2026-01-15", window: "before_07" }],
    ["2026-01-15T06:00:00Z", { idag: "2026-01-15", imorgen: "2026-01-15", window: "07_to_145959" }],
    ["2026-01-15T06:00:01Z", { idag: "2026-01-15", imorgen: "2026-01-15", window: "07_to_145959" }],
    ["2026-01-15T13:59:59Z", { idag: "2026-01-15", imorgen: "2026-01-15", window: "07_to_145959" }],
    ["2026-01-15T14:00:00Z", { idag: "2026-01-15", imorgen: "2026-01-16", window: "from_15" }],
    ["2026-01-15T14:00:01Z", { idag: "2026-01-15", imorgen: "2026-01-16", window: "from_15" }],
    ["2026-07-15T04:59:59Z", { idag: "2026-07-14", imorgen: "2026-07-15", window: "before_07" }],
    ["2026-07-15T05:00:00Z", { idag: "2026-07-15", imorgen: "2026-07-15", window: "07_to_145959" }],
    ["2026-07-15T13:00:00Z", { idag: "2026-07-15", imorgen: "2026-07-16", window: "from_15" }]
  ];
  for (const [instant, expected] of samples) {
    assert.deepEqual(expectedLiveDataDates(new Date(instant)), expected, instant);
  }
});

test("stale-data incident with healthy process and stale UI never becomes GO", (t) => {
  const fixture = createRepository({ stale: true });
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const gate = evaluate(fixture);
  assert.equal(subgate(gate, "SCHEDULER_HEALTH").status, "GREEN");
  assert.notEqual(gate.status, "GREEN");
  assert.match(gate.details.firstSafeDivergence, /OPERATIVE-DATES|READBACK|UI/);
});

test("P0 removal or weakening is caught by permanent contract tests", () => {
  const runner = fs.readFileSync(path.join(ROOT, "tests/sde-quality-engine/run.cjs"), "utf8");
  const evaluator = fs.readFileSync(path.join(ROOT, "tests/sde-quality-engine/lib/live-data-continuity.cjs"), "utf8");
  const registry = fs.readFileSync(path.join(ROOT, "tests/sde-quality-engine/contracts/green-contract.json"), "utf8");
  assert.match(runner, /liveDataContinuityGate/);
  assert.match(evaluator, /LIVE-DATA-FRESHNESS-P0/);
  assert.match(evaluator, /ACTUAL_SYNC_APPLIED/);
  assert.match(evaluator, /PUBLIC_AUTHENTICATED_READBACK/);
  assert.match(evaluator, /ACTUAL_UI_FRESHNESS/);
  assert.match(registry, /LIVE-DATA-FRESHNESS-P0/);
  assert.doesNotMatch(evaluator, /status\s*===\s*["']AMBER["']\s*\?\s*["']GREEN/);
});

test("Quality Engine attempts to repair SDE or data are critical RED", (t) => {
  const fixture = createRepository();
  t.after(() => fs.rmSync(fixture.repository, { recursive: true, force: true }));
  const evidence = makeEvidence(fixture);
  evidence.actionsAttempted = ["rewrite data/api_idag.json"];
  const gate = evaluate(fixture, evidence);
  assert.equal(subgate(gate, "LIVE-DATA-NO-MUTATION").status, "RED");
  assert.equal(gate.status, "RED");
});

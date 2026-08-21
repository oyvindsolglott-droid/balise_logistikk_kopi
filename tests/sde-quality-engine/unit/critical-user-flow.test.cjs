"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  applyEvidenceMutations,
  evaluateCriticalUserFlow,
  validateCriticalUserFlowEvidence
} = require("../lib/critical-user-flow.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, "tests/sde-quality-engine/fixtures/critical-user-flow-scenarios.json"),
  "utf8"
));

const REQUIRED_FINDING_FIELDS = [
  "findingId", "gateId", "testId", "module", "phase", "sourceResource",
  "sourceSlotOrComponent", "observed", "expected", "firstCausalLine",
  "firstSafeDivergence", "httpStatus", "contentType", "expectedBytes",
  "receivedBytes", "expectedSha256", "receivedSha256", "workerState",
  "viewModelRowCount", "domHeaderCellCount", "domRowCount", "consoleError",
  "operationalConsequence", "candidateRelation", "rootCauseStatus",
  "fullLogPath", "fullLogSha256"
];

test("critical user flow evidence schema fails closed", () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(ROOT, "tests/sde-quality-engine/contracts/sde-critical-user-flow-v1.schema.json"),
    "utf8"
  ));
  assert.equal(schema.additionalProperties, false);
  for (const section of ["coreUi", "tursatt", "asset", "worker", "syntheticImport"]) {
    assert.ok(schema.properties.observations.properties[section].required.length > 0, section);
    assert.equal(schema.properties.observations.properties[section].additionalProperties, false, section);
  }
  assert.deepEqual(validateCriticalUserFlowEvidence(fixture.base), []);
  const invalid = structuredClone(fixture.base);
  delete invalid.observations.asset.receivedBytes;
  assert.match(validateCriticalUserFlowEvidence(invalid).join("\n"), /receivedBytes/);
  const wrongType = structuredClone(fixture.base);
  wrongType.observations.coreUi.healthGreen = "true";
  assert.match(validateCriticalUserFlowEvidence(wrongType).join("\n"), /healthGreen must be boolean/);
  const extra = structuredClone(fixture.base);
  extra.observations.tursatt.uncontracted = true;
  assert.match(validateCriticalUserFlowEvidence(extra).join("\n"), /uncontracted is not allowed/);
});

test("release workflow runs the disposable black-box gate on full history", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/sde-regression-firewall.yml"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(workflow, /Check out Browserguard source[\s\S]*fetch-depth:\s*0/);
  assert.match(workflow, /Run critical SDE user-flow black-box gate/);
  assert.match(workflow, /npm run test:sde:qe:critical-user-flow/);
  assert.equal(
    packageJson.scripts["test:sde:qe:critical-user-flow"],
    "node tests/sde-quality-engine/critical-user-flow-qualification.cjs --disposable"
  );
});

test("all-green evidence is the only aggregate GREEN path", () => {
  const results = evaluateCriticalUserFlow(fixture.base);
  assert.equal(results.length, 6);
  assert.equal(results.at(-1).id, "CRITICAL-USER-FLOW-AGGREGATE");
  assert.equal(results.at(-1).status, "GREEN");
  assert.equal(results.at(-1).aggregate, true);
  assert.deepEqual(
    results.at(-1).childGates,
    [
      "CORE-UI-MODULE-ISOLATION",
      "TURSATT-RENDER-E2E",
      "HTR-ASSET-DELIVERY",
      "HTR-WORKER-INITIALIZATION",
      "HTR-SYNTHETIC-IMPORT-E2E"
    ]
  );
});

test("ten false-GREEN fixtures produce the exact fail-closed gate statuses", () => {
  assert.equal(fixture.scenarios.length, 10);
  for (const scenario of fixture.scenarios) {
    const evidence = applyEvidenceMutations(fixture.base, {
      scenarioId: scenario.id,
      ...scenario.mutations
    });
    const byId = new Map(evaluateCriticalUserFlow(evidence).map((item) => [item.id, item]));
    for (const [gateId, expected] of Object.entries(scenario.expected)) {
      assert.equal(byId.get(gateId)?.status, expected, `${scenario.id}:${gateId}`);
    }
    if (scenario.id !== "all-green") {
      assert.notEqual(byId.get("CRITICAL-USER-FLOW-AGGREGATE").status, "GREEN", scenario.id);
    }
  }
});

test("every RED gate reports concrete actionable finding fields", () => {
  for (const scenario of fixture.scenarios.filter((item) => item.id !== "all-green")) {
    const evidence = applyEvidenceMutations(fixture.base, {
      scenarioId: scenario.id,
      ...scenario.mutations
    });
    for (const gate of evaluateCriticalUserFlow(evidence).filter((item) => item.status === "RED" && !item.aggregate)) {
      assert.ok(gate.details.findings.length > 0, `${scenario.id}:${gate.id}`);
      for (const finding of gate.details.findings) {
        for (const field of REQUIRED_FINDING_FIELDS) {
          assert.ok(Object.hasOwn(finding, field), `${scenario.id}:${gate.id}:${field}`);
        }
      }
    }
  }
});

test("mutation replay is deterministic and a single critical mutation blocks aggregate", () => {
  const mutations = [
    ["observations.tursatt.domRowCount", 0],
    ["observations.tursatt.domHeaderCellCount", 0],
    ["observations.tursatt.filterTextVisible", false],
    ["observations.asset.receivedBytes", 1],
    ["observations.asset.receivedSha256", "f".repeat(64)],
    ["observations.worker.workerState", "FAILED"],
    ["observations.syntheticImport.inferenceComplete", false],
    ["observations.coreUi.unhandledRejection", true]
  ];
  for (const [key, value] of mutations) {
    const parts = key.split(".");
    const mutated = structuredClone(fixture.base);
    let target = mutated;
    for (const part of parts.slice(0, -1)) target = target[part];
    target[parts.at(-1)] = value;
    const first = evaluateCriticalUserFlow(mutated);
    const second = evaluateCriticalUserFlow(mutated);
    assert.deepEqual(first, second, key);
    assert.equal(first.at(-1).status, "RED", key);
  }
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildAccounting, validateBaselineAccounting } = require("../lib/accounting.cjs");

test("QE-0 sine 14 blokkerte funksjoner er disjunkte og permanent forklart", () => {
  const observed = validateBaselineAccounting();
  assert.equal(observed.valid, true, observed.problems.join("; "));
  assert.equal(observed.fixture.blockedFunctionTotal, 14);
  assert.deepEqual(observed.fixture.groups.map((item) => item.ids.length), [7, 5, 2]);
  assert.equal(observed.fixture.blockedResultTotal, 5);
  assert.equal(observed.fixture.criticalBlockedResultTotal, 3);
  assert.deepEqual(observed.fixture.blockedResults.filter((item) => item.critical).map((item) => item.id), [
    "QE-SERVER-TEST-ACTIONS-TABLE-REGRESSION",
    "QE-SERVER-TEST-SDE-RECOMMENDATION-ACK-ACTION",
    "QE-SERVER-TEST-SERVER-NOTE-ACTION"
  ]);
});

test("statusregnskap teller hver test, kontrakt, funksjon og gate nøyaktig én gang", () => {
  const results = [
    { id: "A", contractId: "C1", status: "GREEN", critical: true, summary: "ok" },
    { id: "B", contractId: "C2", status: "BLOCKED", critical: false, summary: "blocked" }
  ];
  const accounting = buildAccounting({
    results,
    functionMatrix: [{ id: "F1", status: "BLOCKED", contracts: ["C2"], evidenceIds: ["B"] }],
    recommendations: [{ id: "B" }],
    contracts: { contracts: [{ id: "C1", critical: true }, { id: "C2", critical: false }] }
  });
  assert.equal(accounting.testCases.total, 2);
  assert.equal(accounting.assertions.total, 2);
  assert.equal(accounting.contracts.total, 2);
  assert.equal(accounting.functions.total, 1);
  assert.equal(accounting.recommendations.total, 1);
  assert.equal(accounting.releaseGates.total, 1);
  assert.deepEqual(accounting.blocked.functions, ["F1"]);
});

test("duplikate test-ID-er avvises fail-closed", () => {
  assert.throws(() => buildAccounting({
    results: [
      { id: "A", contractId: "C", status: "GREEN", critical: true },
      { id: "A", contractId: "C", status: "GREEN", critical: true }
    ],
    functionMatrix: [], recommendations: [], contracts: { contracts: [] }
  }), /duplicate result IDs: A/);
});

test("flere unike testresultater kan bevise samme kontrakt uten dobbelttelling", () => {
  const accounting = buildAccounting({
    results: [
      { id: "REGRESSION-ROBUST", contractId: "ROBUST-001", status: "GREEN", critical: true },
      { id: "SERVER-ROBUST", contractId: "ROBUST-001", status: "GREEN", critical: true }
    ],
    functionMatrix: [],
    recommendations: [],
    contracts: { contracts: [{ id: "ROBUST-001", critical: true }] }
  });
  assert.equal(accounting.testCases.total, 2);
  assert.equal(accounting.contracts.total, 1);
  assert.deepEqual(accounting.contracts.rows[0].evidenceIds, ["REGRESSION-ROBUST", "SERVER-ROBUST"]);
});

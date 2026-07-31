"use strict";

const path = require("node:path");
const { readJson, repoRoot } = require("./core.cjs");

const STATUS_PRIORITY = Object.freeze({ GREEN: 0, AMBER: 1, UNKNOWN: 2, BLOCKED: 3, RED: 4 });

function countsFor(items, selector = (item) => item.status) {
  const counts = { GREEN: 0, AMBER: 0, RED: 0, BLOCKED: 0, UNKNOWN: 0 };
  for (const item of items) counts[selector(item)] = (counts[selector(item)] || 0) + 1;
  return counts;
}

function highestStatus(items) {
  if (!items.length) return "UNKNOWN";
  return items.reduce((status, item) =>
    STATUS_PRIORITY[item.status] > STATUS_PRIORITY[status] ? item.status : status, "GREEN");
}

function validateBaselineAccounting() {
  const fixture = readJson(path.join(repoRoot(), "tests/sde-quality-engine/fixtures/qe0-accounting-baseline.json"));
  const ids = fixture.groups.flatMap((group) => group.ids);
  const unique = new Set(ids);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  const problems = [];
  if (ids.length !== fixture.blockedFunctionTotal) problems.push("blocked total mismatch");
  if (unique.size !== ids.length) problems.push(`duplicate blocked functions: ${[...new Set(duplicates)].join(",")}`);
  if (fixture.blockedFunctionTotal > fixture.functionTotal) problems.push("blocked exceeds function total");
  const blockedResultIds = fixture.blockedResults.map((item) => item.id);
  if (blockedResultIds.length !== fixture.blockedResultTotal) problems.push("blocked result total mismatch");
  if (new Set(blockedResultIds).size !== blockedResultIds.length) problems.push("duplicate blocked result IDs");
  if (fixture.blockedResults.filter((item) => item.critical).length !== fixture.criticalBlockedResultTotal) {
    problems.push("critical blocked result total mismatch");
  }
  return { valid: problems.length === 0, problems, fixture };
}

function buildAccounting({ results, functionMatrix, recommendations, contracts }) {
  const resultIds = results.map((item) => item.id);
  const uniqueResultIds = new Set(resultIds);
  if (uniqueResultIds.size !== resultIds.length) {
    const duplicates = [...new Set(resultIds.filter((id, index) => resultIds.indexOf(id) !== index))];
    throw new Error(`QE accounting refuses duplicate result IDs: ${duplicates.join(",")}`);
  }
  const contractRows = contracts.contracts.map((contract) => {
    const evidence = results.filter((item) => item.contractId === contract.id);
    return {
      id: contract.id,
      critical: Boolean(contract.critical),
      status: highestStatus(evidence),
      evidenceIds: evidence.map((item) => item.id)
    };
  });
  const blockedResults = results.filter((item) => item.status === "BLOCKED");
  const blockedFunctions = functionMatrix.filter((item) => item.status === "BLOCKED");
  const releaseGates = results.filter((item) => item.critical);
  const criticalBlocked = releaseGates.filter((item) => ["BLOCKED", "UNKNOWN"].includes(item.status));
  const baseline = validateBaselineAccounting().fixture;
  return {
    definitions: {
      testCase: "one unique QE result ID",
      assertion: "one terminal status assertion for the corresponding unique QE result ID; not counted again as a contract or function",
      contract: "one unique green-contract ID, projected from its evidence without adding to test-case totals",
      function: "one unique function-matrix ID, projected from contracts without adding to test-case totals",
      recommendation: "one non-GREEN result recommendation",
      releaseGate: "one critical QE result; the critical subset is not added to total test cases"
    },
    testCases: { total: results.length, unique: uniqueResultIds.size, ids: resultIds },
    assertions: { total: results.length, unique: uniqueResultIds.size, statusCounts: countsFor(results) },
    contracts: { total: contractRows.length, unique: new Set(contractRows.map((item) => item.id)).size, statusCounts: countsFor(contractRows), rows: contractRows },
    functions: { total: functionMatrix.length, unique: new Set(functionMatrix.map((item) => item.id)).size, statusCounts: countsFor(functionMatrix), blocked: blockedFunctions.map((item) => ({ id: item.id, contracts: item.contracts, evidenceIds: item.evidenceIds })) },
    recommendations: { total: recommendations.length, unique: new Set(recommendations.map((item) => item.id)).size, ids: recommendations.map((item) => item.id) },
    releaseGates: { total: releaseGates.length, statusCounts: countsFor(releaseGates), criticalBlocked: criticalBlocked.map((item) => ({ id: item.id, status: item.status, summary: item.summary })) },
    blocked: {
      results: blockedResults.map((item) => ({ id: item.id, critical: item.critical, summary: item.summary })),
      functions: blockedFunctions.map((item) => item.id),
      criticalSubset: criticalBlocked.map((item) => item.id)
    },
    qe0BaselineBlockedFunctions: {
      total: baseline.blockedFunctionTotal,
      functionTotal: baseline.functionTotal,
      groups: baseline.groups,
      explanation: "QE-0 hadde 14 blokkerte funksjoner: 7 fra worktree-migrasjonsvakten, 5 fra manglende write-fri ekte flerklient-race og 2 fra autentisert visuell fullmatrise. Gruppene er disjunkte og telles én gang hver."
    },
    qe0BaselineBlockedResults: {
      total: baseline.blockedResultTotal,
      resultTotal: baseline.resultTotal,
      criticalTotal: baseline.criticalBlockedResultTotal,
      rows: baseline.blockedResults,
      criticalSubset: baseline.blockedResults.filter((item) => item.critical).map((item) => item.id),
      explanation: "QE-0 hadde fem blokkerte resultater. De tre servertestene var den kritiske delmengden; flerklient-race og visuell fullmatrise var ikke-kritiske blokkerte resultater. Resultater og kritisk delmengde summeres ikke sammen."
    }
  };
}

module.exports = { buildAccounting, countsFor, validateBaselineAccounting };

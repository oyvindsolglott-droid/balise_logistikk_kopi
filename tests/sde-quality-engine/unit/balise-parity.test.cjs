"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { readJson, repoRoot } = require("../lib/core.cjs");
const {
  FINDING_TYPES,
  PARITY_CATEGORIES,
  THREE_WAY_CATEGORIES,
  compareRecords,
  compareThreeWay,
  evaluateFreshness,
  validateOverride
} = require("../lib/balise-parity.cjs");

const fixture = readJson(path.join(repoRoot(), "tests/sde-quality-engine/fixtures/balise-parity-cases.json"));
const freshnessContract = readJson(path.join(repoRoot(), "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"));

function changed(base, field, value) {
  return { ...base, [field]: value };
}

test("paritetskategoriene er komplette og stabile", () => {
  assert.deepEqual([...PARITY_CATEGORIES], fixture.expectedCategories);
  assert.deepEqual([...FINDING_TYPES], [
    "CONFIRMED_DEFECT", "PROBABLE_DEFECT", "POSSIBLE_FALSE_POSITIVE",
    "EXPECTED_DIFFERENCE", "AUTHORIZED_OVERRIDE", "CONTRACT_AMBIGUITY",
    "TEST_ORACLE_DEFECT", "BLOCKED", "UNKNOWN"
  ]);
  assert.deepEqual([...THREE_WAY_CATEGORIES], [
    "balise_only_candidate", "candidate_only", "balise_only_published", "published_only",
    "vehicle_mismatch_candidate", "vehicle_mismatch_published",
    "consist_mismatch_candidate", "consist_mismatch_published",
    "track_mismatch_candidate", "track_mismatch_published",
    "date_mismatch_candidate", "date_mismatch_published",
    "authorized_override", "expected_difference", "unauthorized_difference",
    "possible_false_positive", "contract_ambiguity"
  ]);
});

test("treveis diagnostikk skiller occurrence-, felt- og funntype", () => {
  const published = changed(fixture.baseSde, "vehicleIds", ["74-02"]);
  const observed = compareThreeWay({
    baliseRecords: [fixture.baseBalise],
    candidateRecords: [fixture.baseSde],
    publishedRecords: [published],
    observedAt: "2026-07-31T12:00:00.000Z"
  });
  assert.equal(observed.occurrenceLevelDiscrepancies.balise_only_candidate, 0);
  assert.equal(observed.fieldLevelDiscrepancies.vehicle_mismatch_published, 1);
  assert.equal(observed.findingTypeCounts.POSSIBLE_FALSE_POSITIVE, 1);
  assert.equal(observed.findings[0].testId, "BALISE-010-LIVE");
  assert.equal(observed.findings[0].observedAt, "2026-07-31T12:00:00.000Z");
  assert.ok(Array.isArray(observed.findings[0].additionalEvidenceRequired));
});

test("departure-spor som ikke finnes i payloadkontrakten er orakelavvik, ikke SDE-defekt", () => {
  const balise = {
    ...fixture.baseBalise,
    occurrenceId: "2099-01-01|departure|10001|10:00",
    direction: "departure",
    track: "2"
  };
  const sde = {
    ...fixture.baseSde,
    occurrenceId: balise.occurrenceId,
    direction: "departure",
    track: null
  };
  const observed = compareThreeWay({
    baliseRecords: [balise],
    candidateRecords: [sde],
    publishedRecords: [sde]
  });
  assert.equal(observed.findingTypeCounts.TEST_ORACLE_DEFECT, 2);
  assert.equal(observed.fieldLevelDiscrepancies.expected_difference, 2);
  assert.equal(observed.releaseStatus, "HOLD");
});

test("utilgjengelig publisert kilde blokkerer C uten å produsere falske published-differanser", () => {
  const observed = compareThreeWay({
    baliseRecords: [fixture.baseBalise],
    candidateRecords: [fixture.baseSde],
    publishedRecords: [],
    sourceAvailability: { balise: true, candidate: true, published: false }
  });
  assert.equal(observed.releaseStatus, "BLOCKED");
  assert.equal(observed.findingTypeCounts.BLOCKED, 1);
  assert.equal(observed.occurrenceLevelDiscrepancies.balise_only_published, 0);
  assert.equal(observed.findings[0].field, "source");
});

test("symmetrisk diff finner Balise-only, SDE-only og alle feltdifferanser", () => {
  assert.equal(compareRecords([fixture.baseBalise], []).counts.balise_only, 1);
  assert.equal(compareRecords([], [fixture.baseSde]).counts.sde_only, 1);
  const cases = [
    ["trainNumber", "10002", "identity_mismatch"],
    ["vehicleIds", ["74-02"], "vehicle_mismatch"],
    ["consist", "double_set", "consist_mismatch"],
    ["track", "3", "track_mismatch"],
    ["operationalDate", "2099-01-02", "date_mismatch"],
    ["occurrenceId", "2099-01-01|arrival|10001|10:01", "occurrence_mismatch"]
  ];
  for (const [field, value, category] of cases) {
    const compared = compareRecords([fixture.baseBalise], [changed(fixture.baseSde, field, value)]);
    assert.equal(compared.counts[category] >= 1, true, field);
    assert.equal(compared.counts.unauthorized_difference >= 1, true, `${field} remains unauthorized`);
  }
  const stale = compareRecords([fixture.baseBalise], [fixture.baseSde], {
    sourceStale: { age: 1 }, sdeStale: { age: 1 }
  });
  assert.equal(stale.counts.stale_source, 1);
  assert.equal(stale.counts.stale_sde_dataset, 1);
  assert.equal(compareRecords([changed(fixture.baseBalise, "provenance", null)], [fixture.baseSde]).counts.provenance_missing, 1);
});

test("override krever full proveniens og maskerer bare eget felt", () => {
  assert.deepEqual(validateOverride(fixture.validOverride).missing, []);
  assert.equal(validateOverride({ ...fixture.validOverride, provenance: "" }).valid, false);
  const sde = changed(fixture.baseSde, "track", "3");
  const authorized = compareRecords([fixture.baseBalise], [sde], { overrides: [fixture.validOverride] });
  assert.equal(authorized.counts.authorized_override, 1);
  assert.equal(authorized.counts.track_mismatch, 0);
  assert.equal(authorized.counts.unauthorized_difference, 0);
  const secondMismatch = compareRecords([fixture.baseBalise], [{ ...sde, vehicleIds: ["74-02"] }], { overrides: [fixture.validOverride] });
  assert.equal(secondMismatch.counts.authorized_override, 1);
  assert.equal(secondMismatch.counts.vehicle_mismatch, 1);
  assert.equal(secondMismatch.counts.unauthorized_difference, 1);
});

test("ferskhet følger faktisk Oslo-refreshsyklus, ikke fast seks-timersgrense", () => {
  const observed = evaluateFreshness({
    now: new Date("2026-07-31T12:00:00Z"),
    sourceReadAt: new Date("2026-07-31T12:00:00Z"),
    sourceResponseDate: "Fri, 31 Jul 2026 12:00:00 GMT",
    sdeGeneratedAt: "31.07.2026 07:05:54",
    contract: freshnessContract
  });
  assert.equal(observed.status, "GREEN");
  assert.equal(observed.requiredRefreshBoundary, "2026-07-31T05:00:00.000Z");
  assert.ok(observed.sdeAgeSeconds > 6 * 3600);
  assert.ok(observed.allowedSdeAgeSeconds >= observed.sdeAgeSeconds);

  const stale = evaluateFreshness({
    now: new Date("2026-07-31T12:00:00Z"),
    sourceReadAt: new Date("2026-07-31T12:00:00Z"),
    sourceResponseDate: "Fri, 31 Jul 2026 12:00:00 GMT",
    sdeGeneratedAt: "31.07.2026 04:59:59",
    contract: freshnessContract
  });
  assert.equal(stale.sdeStatus, "STALE_OR_UNKNOWN");
});

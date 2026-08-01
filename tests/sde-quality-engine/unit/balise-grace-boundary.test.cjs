"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { baliseChecks } = require("../lib/checks.cjs");
const {
  effectivePublicationBoundary,
  expectedOperationalDates,
  readJson,
  repoRoot
} = require("../lib/core.cjs");
const { evaluateFreshness } = require("../lib/balise-parity.cjs");

const fixture = (name) => readJson(path.join(repoRoot(), "tests/sde-quality-engine/fixtures", name));
const contract = fixture("balise-freshness-contract.json");
const boundaryCases = fixture("balise-grace-boundary-cases.json");
const actualEvent = fixture("balise-002-actual-event.json");

test("effektiv publiseringsgrense dekker alle sykluser, datooverganger og DST", () => {
  for (const item of boundaryCases.cases) {
    const now = new Date(item.instant);
    const boundary = effectivePublicationBoundary(now, contract, { cycleHour: item.cycleHour });
    assert.equal(boundary.effectiveBoundary, item.effectiveBoundary, item.name);
    assert.equal(boundary.withinPublicationGrace, item.withinGrace, item.name);
    assert.equal(boundary.publicationGraceMinutes, 20, item.name);
    assert.equal(
      new Date(boundary.effectiveBoundary) - new Date(boundary.firstScheduledAttempt),
      20 * 60_000,
      item.name
    );
    if (item.expectedTomorrow) {
      assert.equal(expectedOperationalDates(now, contract).imorgen, item.expectedTomorrow, item.name);
    }
  }
});

test("faktisk 15:01:30-hendelse er forventet innen grace-vinduet", () => {
  const observed = baliseChecks(new Date(actualEvent.now), {
    data: actualEvent.data,
    contract
  }).find((entry) => entry.id === "BALISE-002");
  assert.equal(observed.status, actualEvent.expected.status);
  assert.equal(observed.details.classification, actualEvent.expected.classification);
  assert.equal(observed.details.expected, actualEvent.expected.expectedDate);
  assert.equal(observed.details.effectiveBoundary, actualEvent.expected.effectiveBoundary);
  assert.equal(observed.details.confirmedSdeDefect, false);
  assert.equal(observed.details.probableSdeDefect, false);
});

test("gammel api_imorgen-dato etter effektiv grense stopper porten uten SDE-defektpåstand", () => {
  const data = {
    ...actualEvent.data,
    imorgen: { ...actualEvent.data.imorgen, date: "2026-08-01" }
  };
  const observed = baliseChecks(new Date("2026-08-01T13:27:00Z"), { data, contract })
    .find((entry) => entry.id === "BALISE-002");
  assert.equal(observed.status, "RED");
  assert.equal(observed.details.classification, "STALE_DATE_AFTER_EFFECTIVE_BOUNDARY");
  assert.equal(observed.details.findingDomain, "PIPELINE_FINDING");
  assert.equal(observed.details.contractAuthority.normative, false);
  assert.equal(observed.details.confirmedSdeDefect, false);
  assert.equal(observed.details.probableSdeDefect, false);
});

test("BALISE-002 og BALISE-003 bruker identisk effektiv grense", () => {
  for (const instant of ["2026-08-01T13:01:30Z", "2026-08-01T13:27:00Z"]) {
    const checks = baliseChecks(new Date(instant), { data: actualEvent.data, contract });
    const dateCheck = checks.find((entry) => entry.id === "BALISE-002");
    const freshness = evaluateFreshness({
      now: new Date(instant),
      sourceReadAt: new Date(instant),
      sourceResponseDate: new Date(instant).toUTCString(),
      sdeGeneratedAt: actualEvent.data.imorgen.updatedAt,
      contract
    });
    assert.equal(dateCheck.details.nominalCycleBoundary, freshness.nominalCycleBoundary, instant);
    assert.equal(dateCheck.details.firstScheduledAttempt, freshness.firstScheduledAttempt, instant);
    assert.equal(dateCheck.details.publicationGraceMinutes, freshness.publicationGraceMinutes, instant);
    assert.equal(dateCheck.details.effectiveBoundary, freshness.effectiveBoundary, instant);
  }
});

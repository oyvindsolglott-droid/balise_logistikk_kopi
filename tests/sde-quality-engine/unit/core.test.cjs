"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  expectedOperationalDates,
  summarize
} = require("../lib/core.cjs");
const {
  externalResult,
  parseUpdatedAt,
  qualificationTimeoutMs
} = require("../lib/checks.cjs");

test("Europe/Oslo-dato bytter ved første forsøk pluss publiseringsgrace", () => {
  const datesOnly = (value) => ({ idag: value.idag, imorgen: value.imorgen, window: value.window });
  assert.deepEqual(
    datesOnly(expectedOperationalDates(new Date("2026-07-31T05:26:59Z"))),
    { idag: "2026-07-30", imorgen: "2026-07-31", window: "night_before_07" }
  );
  assert.deepEqual(
    datesOnly(expectedOperationalDates(new Date("2026-07-31T05:27:00Z"))),
    { idag: "2026-07-31", imorgen: "2026-07-31", window: "day_07_to_15" }
  );
  assert.deepEqual(
    datesOnly(expectedOperationalDates(new Date("2026-07-31T13:27:00Z"))),
    { idag: "2026-07-31", imorgen: "2026-08-01", window: "after_15" }
  );
});

test("updatedAt tolkes med riktig sommer- og vinteroffset i Oslo", () => {
  assert.equal(
    new Date(parseUpdatedAt("31.07.2026, 07:05:54")).toISOString(),
    "2026-07-31T05:05:54.000Z"
  );
  assert.equal(
    new Date(parseUpdatedAt("31.01.2026, 07:05:54")).toISOString(),
    "2026-01-31T06:05:54.000Z"
  );
  assert.equal(parseUpdatedAt("ugyldig"), null);
});

test("kritiske ukjente porter gir HOLD og kritisk RED gir NO-GO", () => {
  const base = {
    id: "x",
    contractId: "x",
    area: "test",
    name: "test",
    summary: "test",
    evidence: [],
    details: {},
    recommendation: null,
    durationMs: 0
  };
  assert.equal(
    summarize([{ ...base, status: "BLOCKED", critical: true }]).classification,
    "HOLD"
  );
  assert.equal(
    summarize([{ ...base, status: "BLOCKED", critical: false }]).classification,
    "GO MED AVVIK"
  );
  assert.equal(
    summarize([{ ...base, status: "RED", critical: true }]).classification,
    "NO-GO"
  );
});

test("migrasjonsfeil i en testkommando klassifiseres RED og kan ikke skjules som miljøblokkering", () => {
  const observed = externalResult(
    "x",
    "x",
    "test",
    "test",
    {
      ok: false,
      command: "node test.js",
      status: 1,
      signal: null,
      error: null,
      stdout: "",
      stderr: "Runtime schema migration must run from the approved server directory.",
      durationMs: 1
    },
    true
  );
  assert.equal(observed.status, "RED");
  assert.doesNotMatch(observed.summary, /MANGLER TESTBARHET/);
});

test("samlet qualification har et realistisk standardbudsjett", () => {
  assert.equal(qualificationTimeoutMs({}), 45 * 60 * 1000);
  assert.equal(
    qualificationTimeoutMs({ SDE_QE_QUALIFICATION_TIMEOUT_MS: "1234" }),
    1234
  );
});

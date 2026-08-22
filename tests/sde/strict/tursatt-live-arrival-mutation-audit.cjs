"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const moduleSource = fs.readFileSync(path.join(root, "sde_tursatt_live_arrival.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const moduleTest = path.join(root, "tests/sde/tursatt-live-arrival.test.cjs");
const markerTest = path.join(root, "tests/sde/tursatt-parking-marker.test.cjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-tursatt-live-mutations-"));

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function run(testFile, envName, candidate) {
  return childProcess.spawnSync(process.execPath, ["--test", testFile], {
    cwd: root,
    env: {...process.env, [envName]: candidate},
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024
  });
}

const moduleMutations = [
  ["SOURCE_REVISION_NOT_BOUND", '    "sourceRevision"\n', "", /sourceRevision/],
  ["IDENTITY_ANY_FIELD_ACCEPTED", "return EXACT_IDENTITY_FIELDS.every(field => left[field] && left[field] === right[field]);", "return EXACT_IDENTITY_FIELDS.some(field => left[field] && left[field] === right[field]);", /mismatch/],
  ["STALE_TREATED_AS_FRESH", 'if (freshness !== "fresh")', 'if (freshness === "fresh")', /stale|planned arrival/],
  ["FOUR_MINUTES_NOT_RED", "delayMinutes >= 4", "delayMinutes >= 5", /\+4/],
  ["ESTIMATE_OVERRIDES_ACTUAL", "const effectiveMs = actualMs == null ? estimatedMs : actualMs;", "const effectiveMs = estimatedMs == null ? actualMs : estimatedMs;", /actual Skien arrival/],
  ["ZERO_GETS_SUFFIX", "delayMinutes > 0 ? `+${delayMinutes}`", "delayMinutes >= 0 ? `+${delayMinutes}`", /on-time/]
];

const markerMutations = [
  ["PARKERES_LABEL_REMOVED", 'hint.textContent = "PARKERES";', 'hint.textContent = "PARKERT";', /PARKERES/],
  ["MARKER_REFRESH_REMOVED", "  refreshTursattPostArrivalParkingMarkers();", "  // marker refresh removed", /refreshes before/],
  ["FORCED_RULE_GUARD_REMOVED", "if(!need?.requiresPostArrivalShunt || !need?.forcedTrainRule) return;", "if(!need?.requiresPostArrivalShunt) return;", /canonical post-arrival needs/],
  ["CANONICAL_CACHE_LOOKUP_REMOVED", "tursattPostArrivalParkingMarkers.get(occurrencePartKey)", "null", /red split\/parking style/],
  ["TRAIN_HARDCODING_INTRODUCED", "function refreshTursattPostArrivalParkingMarkers(){", 'function refreshTursattPostArrivalParkingMarkers(){\n  const forbiddenTrain = "835";', /hardcoding/]
];

const results = [];
try {
  const baselineModule = run(moduleTest, "SDE_TURSATT_LIVE_MODULE", path.join(root, "sde_tursatt_live_arrival.js"));
  const baselineMarker = run(markerTest, "SDE_TURSATT_INDEX", path.join(root, "index.html"));
  if (baselineModule.status !== 0 || baselineMarker.status !== 0) throw new Error("mutation baseline is not green");

  for (const [id, before, after, expected] of moduleMutations) {
    const candidate = path.join(temporary, `${id}.js`);
    fs.writeFileSync(candidate, replaceOnce(moduleSource, before, after, id));
    const execution = run(moduleTest, "SDE_TURSATT_LIVE_MODULE", candidate);
    const output = `${execution.stdout || ""}\n${execution.stderr || ""}`;
    results.push({id, status: execution.status === 1 && expected.test(output) ? "PASS" : "FAIL", mutantExitCode: execution.status});
  }
  for (const [id, before, after, expected] of markerMutations) {
    const candidate = path.join(temporary, `${id}.html`);
    fs.writeFileSync(candidate, replaceOnce(indexSource, before, after, id));
    const execution = run(markerTest, "SDE_TURSATT_INDEX", candidate);
    const output = `${execution.stdout || ""}\n${execution.stderr || ""}`;
    results.push({id, status: execution.status === 1 && expected.test(output) ? "PASS" : "FAIL", mutantExitCode: execution.status});
  }
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = results.filter(item => item.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-tursatt-live-arrival-mutation-audit-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results
})}\n`);
process.exitCode = failed.length ? 1 : 0;

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");

test("host scanner routes never accept a client secret argument", () => {
  const routes = fs.readFileSync(path.join(ROOT, "server/src/togplasseringScannerRoutes.js"), "utf8");
  const ui = fs.readFileSync(path.join(ROOT, "sde_night_planning_ui.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  assert.equal(routes.includes("api_key"), false);
  assert.equal(ui.includes("api_key"), false);
  assert.equal(ui.includes("OPENAI_API_KEY"), false);
  assert.match(routes, /router\.get\("\/status"/);
  assert.match(routes, /router\.post\("\/geometry"/);
  assert.match(routes, /router\.post\("\/scan"/);
  assert.match(ui, /async function checkGeometry/);
  assert.match(ui, /async function analyzeSelectedImageLegacy/);
  assert.match(ui, /scannerStatusDiagnosis/);
  assert.match(html, /id="sdeNightScanAiBtn"/);
  assert.match(html, />Kontroller geometri</);
  assert.doesNotMatch(html, /id="key"/);
});

test("a refused scanner fails closed while a missing scanner names the engine it fell back to", () => {
  const ui = fs.readFileSync(path.join(ROOT, "sde_night_planning_ui.js"), "utf8");

  const analyze = functionSource(ui, "async function analyzeSelectedImage()");
  assert.match(analyze, /const diagnosis = await scannerStatusDiagnosis\(\);/);
  assert.match(analyze, /return dispatchScannerUnavailable\(diagnosis\);/);

  const geometry = functionSource(ui, "async function checkGeometry()");
  assert.match(geometry, /return dispatchScannerUnavailable\(error\);/);

  // Past the geometry gate there is nothing for the legacy detector to contribute.
  const scan = functionSource(ui, "async function scanSelectedImage()");
  assert.match(scan, /return reportScannerUnavailable\(error\);/);
  assert.doesNotMatch(scan, /dispatchScannerUnavailable/);

  // 401/403/503 mean the engine exists and refused us, so its verdict is never implied.
  const missing = functionSource(ui, "function scannerEngineMissing(status)");
  for (const refused of ["401", "403", "503"]) {
    assert.doesNotMatch(missing, new RegExp(`status === ${refused}`));
  }
  for (const absent of ["0", "404", "405", "501"]) {
    assert.match(missing, new RegExp(`status === ${absent}\\b`));
  }

  const dispatch = functionSource(ui, "function dispatchScannerUnavailable(diagnosis)");
  assert.match(dispatch, /scannerEngineMissing/);
  assert.match(dispatch, /runLegacyEngineWithNotice\(diagnosis\)/);
  assert.match(dispatch, /reportScannerUnavailable\(diagnosis\)/);

  // The legacy detector stays reachable, but only through the labelled wrapper.
  const legacyCallSites = (ui.match(/^(?!\s*(?:async )?function ).*analyzeSelectedImageLegacy\(\)/gm) || [])
    .map((line) => line.trim());
  assert.deepEqual(legacyCallSites, ["return await analyzeSelectedImageLegacy()"]);

  const notice = functionSource(ui, "async function runLegacyEngineWithNotice(diagnosis)");
  assert.match(notice, /V03_UNAVAILABLE/);
  assert.match(notice, /GAMMEL DETEKTOR/);
  // The label must not fabricate an import failure the legacy run did not report.
  assert.doesNotMatch(notice, /IMPORT_FAILED/);

  const report = functionSource(ui, "function reportScannerUnavailable(diagnosis)");
  assert.match(report, /geometryReady = false;/);
  assert.match(report, /scanButton\.disabled = true;/);
  assert.match(report, /SCANNER_UNAVAILABLE/);

  const post = functionSource(ui, "async function postScannerCommand(url, generation)");
  assert.match(post, /unavailable\.scannerUnavailable = true;/);
  assert.doesNotMatch(post, /unavailable\.fallback/);
  // The guard must cover /scan as well, not only /geometry.
  assert.doesNotMatch(post, /url\.indexOf\("\/geometry"\)/);
});

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces for ${signature}`);
}

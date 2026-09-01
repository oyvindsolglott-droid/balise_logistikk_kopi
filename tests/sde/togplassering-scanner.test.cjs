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

test("an unavailable scanner fails closed instead of silently rerunning the legacy detector", () => {
  const ui = fs.readFileSync(path.join(ROOT, "sde_night_planning_ui.js"), "utf8");

  const analyze = functionSource(ui, "async function analyzeSelectedImage()");
  assert.match(analyze, /const diagnosis = await scannerStatusDiagnosis\(\);/);
  assert.match(analyze, /return reportScannerUnavailable\(diagnosis\);/);
  assert.doesNotMatch(analyze, /analyzeSelectedImageLegacy/);

  const geometry = functionSource(ui, "async function checkGeometry()");
  assert.doesNotMatch(geometry, /analyzeSelectedImageLegacy/);
  assert.match(geometry, /error\.scannerUnavailable/);

  const scan = functionSource(ui, "async function scanSelectedImage()");
  assert.match(scan, /error\.scannerUnavailable/);

  // The legacy detector must never be reachable from an automatic code path again.
  const automaticCalls = ui.match(/^(?!\s*(?:async )?function ).*analyzeSelectedImageLegacy\(\)/gm) || [];
  assert.deepEqual(automaticCalls, []);

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

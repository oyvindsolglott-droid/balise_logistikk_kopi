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
  assert.match(ui, /scannerStatusAvailable/);
  assert.match(html, /id="sdeNightScanAiBtn"/);
  assert.match(html, />Kontroller geometri</);
  assert.doesNotMatch(html, /id="key"/);
});

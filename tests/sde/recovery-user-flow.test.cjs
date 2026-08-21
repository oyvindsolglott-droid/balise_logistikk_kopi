"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const ui = fs.readFileSync(path.join(ROOT, "sde_night_planning_ui.js"), "utf8");
const runtime = fs.readFileSync(path.join(ROOT, "sde_handwriting_runtime.js"), "utf8");
const worker = fs.readFileSync(path.join(ROOT, "sde_handwriting_worker.js"), "utf8");
const delivery = fs.readFileSync(path.join(ROOT, "server/src/staticAssetDelivery.js"), "utf8");

test("HTR is absent from core boot and loaded only by Importer now", () => {
  assert.doesNotMatch(html, /<script[^>]+src="sde_handwriting_(?:recognition|runtime)\.js/);
  assert.match(html, /<script type="application\/json" id="sdeLazyHtrModuleRegistry">/);
  assert.match(html, /"trigger":"sdeNightAnalyzeImageBtn"/);
  assert.match(html, /"modules":\["sde_handwriting_recognition\.js","sde_handwriting_runtime\.js"\]/);
  assert.match(ui, /async function ensureHtrModules/);
  assert.match(ui, /async function getOcrAnalyzer/);
  assert.match(ui, /await getOcrAnalyzer/);
  assert.match(ui, /sdeNightAnalyzeImageBtn/);
});

test("all runtime HTR assets are explicit fail-closed static resources", () => {
  for (const required of [
    "/assets/models/gigapdf-ocr-handwriting/manifest.json",
    "/assets/models/gigapdf-ocr-handwriting/model.onnx",
    "/assets/models/gigapdf-ocr-handwriting/dict.txt",
  ]) assert.match(delivery, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(delivery, /Content-Length/);
  assert.match(delivery, /X-Content-Type-Options/);
});

test("HTR asset download has bounded retry, timeout, byte and hash contracts", () => {
  assert.match(worker, /HTR_ASSET_DOWNLOAD_STARTED/);
  assert.match(worker, /HTR_ASSET_DOWNLOAD_COMPLETE/);
  assert.match(worker, /HTR_ASSET_HASH_VERIFIED/);
  assert.match(worker, /HTR_WORKER_READY/);
  assert.match(worker, /AbortController/);
  assert.match(worker, /content-length/i);
  assert.match(worker, /maxRetries\s*:\s*1/);
  assert.match(runtime, /htr_worker_ready_timeout/);
});

test("Tursatt render is atomic and asserts DOM parity with its view model", () => {
  assert.match(html, /function buildTursattViewModel/);
  assert.match(html, /function createTursattTableFragment/);
  assert.match(html, /function assertTursattDomMatchesViewModel/);
  assert.match(html, /table\.replaceChildren\(fragment\)/);
  assert.doesNotMatch(html, /function buildOppstilling\(\)\{[\s\S]{0,180}table\.innerHTML=""/);
});

test("core boot isolates Tursatt from unrelated module failures", () => {
  assert.match(html, /runCoreBootModule\("TURSATT",\s*buildOppstilling\)/);
  assert.match(html, /function runCoreBootModule/);
});

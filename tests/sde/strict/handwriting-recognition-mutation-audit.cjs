"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const harness = path.join(root, "tests/sde/strict/handwriting-recognition-invariants.cjs");
const sources = {
  recognition: fs.readFileSync(path.join(root, "sde_handwriting_recognition.js"), "utf8"),
  runtime: fs.readFileSync(path.join(root, "sde_handwriting_runtime.js"), "utf8"),
  worker: fs.readFileSync(path.join(root, "sde_handwriting_worker.js"), "utf8"),
  ui: fs.readFileSync(path.join(root, "sde_night_planning_ui.js"), "utf8"),
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-htr-mutations-"));

function replaceOnce(input, before, after, label){
  const index = input.indexOf(before);
  if(index < 0) throw new Error(`${label}: mutation anchor not found`);
  if(input.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0, index) + after + input.slice(index + before.length);
}

function run(candidate, label){
  const directory = path.join(temporary, label);
  fs.mkdirSync(directory, {recursive: true});
  const paths = {};
  for(const [kind, source] of Object.entries(candidate)){
    paths[kind] = path.join(directory, `${kind}.js`);
    fs.writeFileSync(paths[kind], source);
  }
  const execution = childProcess.spawnSync(process.execPath, [
    harness, paths.recognition, paths.runtime, paths.worker, paths.ui,
  ], {cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024});
  if(execution.error || execution.signal || ![0, 1].includes(execution.status)){
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const report = JSON.parse(String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if(report.schemaVersion !== "sde-handwriting-recognition-invariants-v1") throw new Error(`${label}: unexpected harness schema`);
  return {execution, report};
}

const mutations = [
  {id: "HANDWRITING_CELLS_SENT_TO_PRINT_OCR_ONLY", kind: "recognition", expected: "INV-HTR-001", apply: source => replaceOnce(source,
    'recognizerKind: "HANDWRITING"', 'recognizerKind: "PRINT_OCR"', "replace HTR recognizer")},
  {id: "HTR_LAYER_BYPASSED", kind: "ui", expected: "INV-HTR-002", apply: source => replaceOnce(source,
    "htrRuntime.mapResultToNightPlan(result, {", "logic.mapOcrResultToNightPlan(result, {", "bypass HTR mapper")},
  {id: "PERSPECTIVE_CORRECTION_DISABLED", kind: "recognition", expected: "INV-HTR-003", apply: source => replaceOnce(source,
    "perspectiveCorrectionApplied: true,", "perspectiveCorrectionApplied: false,", "disable perspective")},
  {id: "CELL_SEGMENTATION_USES_PREVIEW_COORDINATES", kind: "worker", expected: "INV-HTR-004", apply: source => replaceOnce(source,
    "registration.perspective.inverse, request", "[1,0,0,0,1,0,0,0,1], request", "use preview coordinates")},
  {id: "ROW_INDEX_SHIFTED_BY_ONE", kind: "recognition", expected: "INV-HTR-005", apply: source => replaceOnce(source,
    "cells.push(Object.freeze({\n          rowIndex,", "cells.push(Object.freeze({\n          rowIndex: rowIndex + 1,", "shift rows")},
  {id: "COLUMN_MAPPING_SHIFTED_BY_ONE", kind: "recognition", expected: "INV-HTR-006", apply: source => replaceOnce(source,
    "columnId: COLUMN_IDS[columnIndex],", "columnId: COLUMN_IDS[(columnIndex + 1) % COLUMN_IDS.length],", "shift columns")},
  {id: "FIRST_RECOGNIZED_CELL_IS_ONLY_RESULT", kind: "worker", expected: "INV-HTR-007", apply: source => replaceOnce(source,
    "const tableCells = cells.filter(cell => cell.rowIndex != null);", "const tableCells = cells.filter(cell => cell.rowIndex != null).slice(0, 1);", "truncate cells")},
  {id: "UNCERTAIN_VALUE_AUTO_ACCEPTED", kind: "recognition", expected: "INV-HTR-008", apply: source => replaceOnce(source,
    'const threshold = normalizer === "FREE_TEXT" ? 0.98 : 0.86;', "const threshold = 0;", "accept uncertainty")},
  {id: "PREVIOUS_PLAN_VALUE_USED_AS_FALLBACK", kind: "recognition", expected: "INV-HTR-009", apply: source => replaceOnce(source,
    'let selectedValue = "";', 'let selectedValue = String(context.previousPlanValue || "");', "previous fallback")},
  {id: "DESIGN_VEHICLE_ID_USED_AS_FALLBACK", kind: "recognition", expected: "INV-HTR-010", apply: source => replaceOnce(source,
    "handwritingCapable: true,", 'handwritingCapable: true, designVehicleId: "74-38",', "design vehicle")},
  {id: "CANONICAL_SLOT_VALIDATION_REMOVED", kind: "recognition", expected: "INV-HTR-011", apply: source => replaceOnce(source,
    "if(canonicalSlots.has(normalized)) sourceAlternatives.push(normalized);", "if(normalized) sourceAlternatives.push(normalized);", "remove slot validation")},
  {id: "HUMAN_CORRECTION_NOT_USED_AS_GROUND_TRUTH", kind: "recognition", expected: "INV-HTR-012", apply: source => replaceOnce(source,
    'groundTruthSource: "HUMAN_CORRECTED_FORM",', 'groundTruthSource: "UNCONFIRMED_RECOGNIZER_OUTPUT",', "discard correction provenance")},
  {id: "UNSAVED_HTR_DATA_ADDED_TO_LEARNING", kind: "ui", expected: "INV-HTR-013", apply: source => replaceOnce(source,
    "selectedImage = file;", 'selectedImage = file; root.localStorage.setItem("sde_htr_unsaved", file.name);', "persist unsaved HTR")},
  {id: "IMPORT_SUCCESS_BEFORE_HTR_COMPLETE", kind: "recognition", expected: "INV-HTR-014", apply: source => replaceOnce(source,
    'if(input.htrCompleted !== true) mappingStatus = "RECOGNITION_FAILED";', 'if(input.htrCompleted !== true) mappingStatus = "FORM_MAPPING_COMPLETE";', "premature success")},
  {id: "MODEL_HASH_NOT_VERIFIED", kind: "worker", expected: "INV-HTR-015", apply: source => replaceOnce(source,
    'await htr.verifyModelBytes(modelBytes, {modelSha256: manifest.files["inference.onnx"]});', "void modelBytes; // mutation: model hash bypassed", "bypass model hash")},
];

const results = [];
try{
  const baseline = run(sources, "baseline");
  if(baseline.execution.status !== 0 || baseline.report.counts?.fail !== 0) throw new Error("HTR mutation baseline is not green");
  for(const mutation of mutations){
    const candidate = {...sources, [mutation.kind]: mutation.apply(sources[mutation.kind])};
    const mutant = run(candidate, mutation.id);
    const failedIds = mutant.report.results.filter(result => result.status === "FAIL").map(result => result.id);
    const killed = mutant.execution.status === 1 && failedIds.includes(mutation.expected);
    results.push({
      id: mutation.id,
      status: killed ? "PASS" : "FAIL",
      mutantExitCode: mutant.execution.status,
      expectedInvariant: mutation.expected,
      failedIds,
      timeoutKill: false,
    });
  }
}finally{
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = results.filter(result => result.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-handwriting-recognition-mutation-audit-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;

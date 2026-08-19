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
    "FREE_TEXT: 0.98,", "FREE_TEXT: 0,", "accept uncertainty")},
  {id: "PREVIOUS_PLAN_VALUE_USED_AS_FALLBACK", kind: "recognition", expected: "INV-HTR-009", apply: source => replaceOnce(source,
    'let selectedValue = "";', 'let selectedValue = String(context.previousPlanValue || "");', "previous fallback")},
  {id: "DESIGN_VEHICLE_ID_USED_AS_FALLBACK", kind: "recognition", expected: "INV-HTR-010", apply: source => replaceOnce(source,
    "handwritingCapable: true,", 'handwritingCapable: true, designVehicleId: "74-38",', "design vehicle")},
  {id: "CANONICAL_SLOT_VALIDATION_REMOVED", kind: "recognition", expected: "INV-HTR-011", apply: source => replaceOnce(source,
    'let accepted = canonicalSlots.has(normalized) ? normalized : (components.length > 1 && canonicalSlots.has(target) ? normalized : "");', "let accepted = normalized;", "remove slot validation")},
  {id: "HUMAN_CORRECTION_NOT_USED_AS_GROUND_TRUTH", kind: "recognition", expected: "INV-HTR-012", apply: source => replaceOnce(source,
    'groundTruthSource: "HUMAN_CORRECTED_FORM",', 'groundTruthSource: "UNCONFIRMED_RECOGNIZER_OUTPUT",', "discard correction provenance")},
  {id: "UNSAVED_HTR_DATA_ADDED_TO_LEARNING", kind: "ui", expected: "INV-HTR-013", apply: source => replaceOnce(source,
    "selectedImage = file;", 'selectedImage = file; root.localStorage.setItem("sde_htr_unsaved", file.name);', "persist unsaved HTR")},
  {id: "IMPORT_SUCCESS_BEFORE_HTR_COMPLETE", kind: "recognition", expected: "INV-HTR-014", apply: source => replaceOnce(source,
    'if(input.htrCompleted !== true) mappingStatus = "RECOGNITION_FAILED";', 'if(input.htrCompleted !== true) mappingStatus = "FORM_MAPPING_COMPLETE";', "premature success")},
  {id: "MODEL_HASH_NOT_VERIFIED", kind: "worker", expected: "INV-HTR-015", apply: source => replaceOnce(source,
    'await htr.verifyModelBytes(modelBytes, {modelSha256: manifest.files["inference.onnx"]});', "void modelBytes; // mutation: model hash bypassed", "bypass model hash")},
  {id: "CAMERA_EDGE_SHADOW_REPLACES_FORM_GRID", kind: "recognition", expected: "INV-HTR-016", apply: source => replaceOnce(source,
    "candidate.xAtReference < width * 0.2", "candidate.xAtReference < width * 0.01", "discard actual left form rule")},
  {id: "IMAGE_ROW_BOUNDARIES_IGNORED", kind: "worker", expected: "INV-HTR-017", apply: source => replaceOnce(source,
    "rowBoundaries: detected.canonicalRowBoundaries", "rowBoundaries: null", "ignore detected row boundaries")},
  {id: "GRID_REGISTRATION_SHIFTED", kind: "worker", expected: "INV-HTR-017", apply: source => replaceOnce(source,
    "rowBoundaries: detected.canonicalRowBoundaries", "rowBoundaries: detected.canonicalRowBoundaries.map(value => value + 40)", "shift the registered grid")},
  {id: "CELL_CROP_TRUNCATES_EDGE_HANDWRITING", kind: "worker", expected: "INV-HTR-018", apply: source => replaceOnce(source,
    "boxHeight * 0.055", "boxHeight * 0.14", "restore truncating vertical padding")},
  {id: "CELL_CROP_CLIPS_FIRST_CHARACTER", kind: "worker", expected: "INV-HTR-018", apply: source => replaceOnce(source,
    'cell.columnId === "notes" ? 0.012 : 0.02', 'cell.columnId === "notes" ? 0.12 : 0.12', "clip the crop's leading edge")},
  {id: "CELL_CROP_CLIPS_LAST_CHARACTER", kind: "worker", expected: "INV-HTR-018", apply: source => replaceOnce(source,
    "x1: box.x1 - xPadding", "x1: box.x1 - Math.max(xPadding, boxWidth * 0.12)", "clip the crop's trailing edge")},
  {id: "GRID_LINES_LEFT_IN_RECOGNIZER_IMAGE", kind: "worker", expected: "INV-HTR-018", apply: source => replaceOnce(source,
    "const gridSuppression = suppressGridLinePixels(grayscale, resizedWidth, 48);", "const gridSuppression = {image: grayscale, horizontalLineCount: 0, verticalLineCount: 0};", "bypass grid-line masks")},
  {id: "STRUCTURED_FIELDS_USE_ONE_PREPROCESSING_PASS", kind: "worker", expected: "INV-HTR-018", apply: source => replaceOnce(source,
    "crop.tensors", "[crop.tensor]", "remove structured preprocessing passes")},
  {id: "ONE_PASS_CANDIDATE_AUTO_ACCEPTED", kind: "worker", expected: "INV-HTR-019", apply: source => replaceOnce(source,
    "Math.min(candidate.confidence, 0.84)", "candidate.confidence", "remove single-pass confidence cap")},
  {id: "PLAUSIBLE_WRONG_IDENTIFIER_AUTO_ACCEPTED", kind: "recognition", expected: "INV-HTR-020", apply: source => replaceOnce(source,
    "TRAIN_IDENTIFIER: 0.995", "TRAIN_IDENTIFIER: 0.86", "lower identifier review threshold")},
  {id: "LOW_CONFIDENCE_VALUE_AUTO_ACCEPTED", kind: "recognition", expected: "INV-HTR-020", apply: source => replaceOnce(source,
    "VEHICLE_ID: 0.98", "VEHICLE_ID: 0", "accept low-confidence vehicle")},
  {id: "REGISTRATION_PROGRESS_MISREPORTED", kind: "worker", expected: "INV-HTR-021", apply: source => replaceOnce(source,
    'status: "FORM_REGISTRATION_COMPLETE"', 'status: "FORM_DETECTED"', "misreport registration progress")},
  {id: "SETTNR_HYPHEN_DROPPED", kind: "recognition", expected: "INV-HTR-022", apply: source => replaceOnce(source,
    "return /^\\d{2}$/.test(left) && /^\\d{2}$/.test(right) ? `${left}-${right}` : \"\";", "return /^\\d{2}$/.test(left) && /^\\d{2}$/.test(right) ? `${left}${right}` : \"\";", "drop vehicle separator")},
  {id: "TRACK_SUFFIX_DROPPED", kind: "recognition", expected: "INV-HTR-022", apply: source => replaceOnce(source,
    'return String(value || "").normalize("NFKC").toUpperCase().replace(/\\s+/g, "").replace(/(?:-|=)+>/g, "→");', 'return String(value || "").normalize("NFKC").toUpperCase().replace(/[NSMV]/g, "").replace(/\\s+/g, "").replace(/(?:-|=)+>/g, "→");', "drop track suffix")},
  {id: "CELL_AUDIT_PROVENANCE_DROPPED", kind: "worker", expected: "INV-HTR-023", apply: source => replaceOnce(source,
    "sourceBoundingBox: request.boundingBox,", "sourceCoordinatesRemoved: true,", "drop source bounding box")},
  {id: "TEXT_LINE_SPLIT_INTO_ISOLATED_CHARACTERS", kind: "worker", expected: "INV-HTR-024", apply: source => replaceOnce(source,
    "Math.ceil(48 * ratio)", "48", "force a single-character crop width")},
  {id: "ONLY_FIRST_TOKEN_RETAINED", kind: "worker", expected: "INV-HTR-024", apply: source => replaceOnce(source,
    'text += characters[bestIndex] || "";', 'text = characters[bestIndex] || "";', "overwrite prior decoded tokens")},
  {id: "FORM_STATE_CLEARED_AFTER_RECOGNITION", kind: "ui", expected: "INV-HTR-025", apply: source => replaceOnce(source,
    "draft = plan;", "draft = logic.createNightPlan({});", "clear recognized form state")},
  {id: "PREVIOUS_IMPORT_VALUES_PERSIST", kind: "recognition", expected: "INV-HTR-026", apply: source => replaceOnce(source,
    "return createRecognitionSession(sourceImageFingerprint);", "return _session;", "retain previous import")},
  {id: "VEHICLE_CATALOG_INVENTS_VALUE", kind: "recognition", expected: "INV-HTR-027", apply: source => replaceOnce(source,
    "const candidates = normalizedCandidates(recognition);", "const candidates = normalizedCandidates(recognition); if(!candidates.length && context.vehicleCatalog?.length) candidates.push({text: context.vehicleCatalog[0], confidence: 1});", "invent from vehicle catalog")},
  {id: "SLOT_REGISTRY_INVENTS_VALUE", kind: "recognition", expected: "INV-HTR-027", apply: source => replaceOnce(source,
    "const candidates = normalizedCandidates(recognition);", "const candidates = normalizedCandidates(recognition); if(!candidates.length && context.canonicalSlots?.length) candidates.push({text: context.canonicalSlots[0], confidence: 1});", "invent from slot register")},
];

const hybridMutations = [
  {id: "ALL_FORMS_FORCED_TO_TEMPLATE_A", kind: "recognition", expected: "INV-HYBRID-001", apply: source => replaceOnce(source,
    'templateId: minimumEvidence && uniqueWinner ? best.templateId : "TEMPLATE_UNKNOWN",',
    'templateId: minimumEvidence && uniqueWinner ? "TEMPLATE_A" : "TEMPLATE_UNKNOWN",', "force all templates to A")},
  {id: "ALL_FORMS_FORCED_TO_TEMPLATE_B", kind: "recognition", expected: "INV-HYBRID-001", apply: source => replaceOnce(source,
    'templateId: minimumEvidence && uniqueWinner ? best.templateId : "TEMPLATE_UNKNOWN",',
    'templateId: minimumEvidence && uniqueWinner ? "TEMPLATE_B" : "TEMPLATE_UNKNOWN",', "force all templates to B")},
  {id: "TEMPLATE_A_TRUNCATED_TO_INTERIOR_TEMPLATE_B", kind: "recognition", expected: "INV-HTR-028", apply: source => replaceOnce(source,
    "        // The outer rules must describe the whole form, not a visually dense",
    "        const historicalRuleCountPriority = right.grid.selected.length - left.grid.selected.length;\n        if(historicalRuleCountPriority) return historicalRuleCountPriority;\n        // mutation: rule count wins before whole-form span", "prioritize interior rule count")},
  {id: "ORDINARY_STROKES_MARKED_AS_CORRECTION", kind: "recognition", expected: "INV-HTR-029", apply: source => replaceOnce(source,
    "if(longestRunAt(y) < width * 0.72) continue;\n      if(Math.max(longestRunAt(y - 1), longestRunAt(y + 1)) >= width * 0.45) return true;",
    "if(longestRunAt(y) < 0) continue;\n      if(Math.max(longestRunAt(y - 1), longestRunAt(y + 1)) >= 0) return true;", "remove correction continuity")},
  {id: "TEMPLATE_A_ADAPTIVE_NORMALIZATION_BYPASSED", kind: "worker", expected: "INV-HTR-030", apply: source => replaceOnce(source,
    'const templateAHandwritingOnly = cell.templateId === "TEMPLATE_A";',
    "const templateAHandwritingOnly = false;", "disable Template A adaptive normalization")},
  {id: "TEMPLATE_B_INN_KL_DROPPED", kind: "recognition", expected: "INV-HYBRID-002", apply: source => replaceOnce(source,
    "const TEMPLATE_B_COLUMN_IDS = CANONICAL_COLUMN_IDS;",
    'const TEMPLATE_B_COLUMN_IDS = CANONICAL_COLUMN_IDS.filter(columnId => columnId !== "arrivalTime");', "drop Inn kl")},
  {id: "TEMPLATE_B_INFO_DROPPED", kind: "recognition", expected: "INV-HYBRID-003", apply: source => replaceOnce(source,
    "const TEMPLATE_B_COLUMN_IDS = CANONICAL_COLUMN_IDS;",
    'const TEMPLATE_B_COLUMN_IDS = CANONICAL_COLUMN_IDS.filter(columnId => columnId !== "info");', "drop INFO")},
  {id: "CURRENT_DATE_OVERRIDES_SOURCE_DATE", kind: "recognition", expected: "INV-HYBRID-004", apply: source => replaceOnce(source,
    "const date = normalizeDate(candidates.date);", 'const date = "18.08.2026";', "override source date")},
  {id: "SOURCE_INITIALS_REDUCED_TO_FIRST_CHARACTER", kind: "recognition", expected: "INV-HYBRID-005", apply: source => replaceOnce(source,
    'const signature = String(candidates.signature || "").normalize("NFKC").trim();',
    'const signature = String(candidates.signature || "").normalize("NFKC").trim().slice(0, 1);', "truncate initials")},
  {id: "RED_PRINT_SENT_TO_HANDWRITING_ONLY", kind: "recognition", expected: "INV-HYBRID-006", apply: source => replaceOnce(source,
    "printInk[index] = 0;", "handwritingInk[index] = 0;", "misroute red print")},
  {id: "BLACK_HANDWRITING_SENT_TO_PRINT_OCR_ONLY", kind: "recognition", expected: "INV-HYBRID-007", apply: source => replaceOnce(source,
    "handwritingInk[index] = 0;", "printInk[index] = 0;", "misroute black handwriting")},
  {id: "PRINT_AND_HANDWRITING_LAYERS_MERGED_BLINDLY", kind: "recognition", expected: "INV-HYBRID-008", apply: source => replaceOnce(source,
    'needsReview: true,\n        reason: "PRINT_HANDWRITING_CONFLICT",',
    'needsReview: false,\n        reason: "PRINT_HANDWRITING_CONFLICT",', "accept layer conflict")},
  {id: "GRID_LINES_RECOGNIZED_AS_TEXT", kind: "recognition", expected: "INV-HYBRID-009", apply: source => replaceOnce(source,
    "if(gridMask[index]) continue;", "if(false && gridMask[index]) continue;", "disable grid exclusion")},
  {id: "ROW_MAPPING_SHIFTED", kind: "recognition", expected: "INV-HYBRID-010", apply: source => replaceOnce(source,
    "cells.push(Object.freeze({\n          rowIndex,", "cells.push(Object.freeze({\n          rowIndex: rowIndex + 1,", "shift row mapping")},
  {id: "COLUMN_MAPPING_SHIFTED", kind: "recognition", expected: "INV-HYBRID-011", apply: source => replaceOnce(source,
    "columnId: template.columns[columnIndex],", "columnId: template.columns[(columnIndex + 1) % template.columns.length],", "shift column mapping")},
  {id: "SETTNR_DROPPED", kind: "recognition", expected: "INV-HYBRID-012", apply: source => replaceOnce(source,
    "return Object.freeze(row);", 'return Object.freeze({...row, vehicleId: ""});', "drop Settnr")},
  {id: "TRACK_DROPPED", kind: "recognition", expected: "INV-HYBRID-013", apply: source => replaceOnce(source,
    "return Object.freeze(row);", 'return Object.freeze({...row, toTrack: ""});', "drop track")},
  {id: "ORPHAN_TEXT_FRAGMENT_ACCEPTED", kind: "recognition", expected: "INV-HYBRID-014", apply: source => replaceOnce(source,
    'let selectedValue = "";', 'let selectedValue = "39";', "invent orphan fragment")},
  {id: "LOW_CONFIDENCE_VALUE_AUTO_ACCEPTED", kind: "recognition", expected: "INV-HYBRID-015", apply: source => replaceOnce(source,
    "FREE_TEXT: 0.98,", "FREE_TEXT: 0,", "accept low confidence")},
  {id: "PREVIOUS_IMPORT_VALUE_USED_AS_FALLBACK", kind: "recognition", expected: "INV-HYBRID-016", apply: source => replaceOnce(source,
    'let selectedValue = "";', 'let selectedValue = String(context.previousPlanValue || "");', "reuse previous import")},
];

const results = [];
try{
  const baseline = run(sources, "baseline");
  if(baseline.execution.status !== 0 || baseline.report.counts?.fail !== 0) throw new Error("HTR mutation baseline is not green");
  for(const mutation of hybridMutations){
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

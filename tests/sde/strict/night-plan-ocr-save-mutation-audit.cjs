"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const harness = path.join(root, "tests/sde/strict/night-plan-ocr-save-invariants.cjs");
const sources = {
  logic: fs.readFileSync(path.join(root, "sde_intelligent_night_planning.js"), "utf8"),
  ui: fs.readFileSync(path.join(root, "sde_night_planning_ui.js"), "utf8"),
  storage: fs.readFileSync(path.join(root, "server/src/nightPlanStorage.js"), "utf8"),
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-night-ocr-save-mutations-"));

function replaceOnce(input, before, after, label) {
  const index = input.indexOf(before);
  if (index < 0) throw new Error(`${label}: mutation anchor not found`);
  if (input.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0, index) + after + input.slice(index + before.length);
}

function mutateFunction(input, name, before, after, label) {
  const start = input.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${label}: function ${name} not found`);
  const next = input.indexOf("\n  function ", start + 10);
  const asyncNext = input.indexOf("\n  async function ", start + 10);
  const candidates = [next, asyncNext].filter(value => value >= 0);
  const end = candidates.length ? Math.min(...candidates) : input.length;
  const body = input.slice(start, end);
  return input.slice(0, start) + replaceOnce(body, before, after, label) + input.slice(end);
}

function run(candidate, label) {
  const directory = path.join(temporary, label);
  fs.mkdirSync(directory, {recursive: true});
  const paths = {
    logic: path.join(directory, "logic.js"),
    ui: path.join(directory, "ui.js"),
    storage: path.join(directory, "storage.js"),
  };
  for (const kind of Object.keys(paths)) fs.writeFileSync(paths[kind], candidate[kind]);
  const execution = childProcess.spawnSync(process.execPath, [harness, paths.logic, paths.ui, paths.storage], {
    cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (execution.error || execution.signal || ![0, 1].includes(execution.status)) {
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const report = JSON.parse(String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if (report.schemaVersion !== "sde-night-plan-ocr-save-invariants-v1") throw new Error(`${label}: unexpected harness schema`);
  return {execution, report};
}

const mutations = [
  {id: "OCR_RESULT_NEVER_REACHES_FORM_MAPPER", kind: "ui", expected: "INV-OCR-SAVE-001", apply: input => replaceOnce(input,
    "htrRuntime.mapResultToNightPlan(result, {", "htrRuntime.mapResultToNightPlan({cells: [], mappingReport: null}, {", "disconnect HTR result")},
  {id: "FORM_MAPPER_RETURNS_ONLY_FIRST_CELL", kind: "logic", expected: "INV-OCR-SAVE-002", apply: input => replaceOnce(input,
    "for (const [key, values] of cellTokens.entries()) {", "for (const [key, values] of [...cellTokens.entries()].slice(0, 1)) {", "first cell only")},
  {id: "FORM_STATE_CLEARED_AFTER_SUCCESSFUL_MAPPING", kind: "ui", expected: "INV-OCR-SAVE-003", apply: input => replaceOnce(input,
    "draft = plan;", "draft = makeManualDraft(); // mutation clears successful mapping", "clear mapped state")},
  {id: "DOM_READS_DIFFERENT_FORM_STATE", kind: "ui", expected: "INV-OCR-SAVE-004", apply: input => replaceOnce(input,
    "rows: draft.entries.map(function row(entry)", "rows: makeManualDraft().entries.map(function row(entry)", "parallel DOM model")},
  {id: "OLD_8S_DEFAULT_PERSISTS", kind: "logic", expected: "INV-OCR-SAVE-005", apply: input => replaceOnce(input,
    "desiredSlot: makeField(entry && entry.desiredSlot, normalizeTrackCell, defaults),", "desiredSlot: makeField((entry && entry.desiredSlot) || '8S', normalizeTrackCell, defaults),", "8S default")},
  {id: "SECOND_IMPORT_DOES_NOT_CLEAR_FIRST_IMPORT", kind: "ui", expected: "INV-OCR-SAVE-006", apply: input => mutateFunction(input, "selectImage",
    "draft = makeManualDraft();", "draft = draft; // mutation retains first import", "retain first import")},
  {id: "DESIGN_SAMPLE_VALUES_USED_AS_FALLBACK", kind: "logic", expected: "INV-OCR-SAVE-007", apply: input => replaceOnce(input,
    "vehicleId: makeField(entry && entry.vehicleId, normalizeVehicle, defaults),", "vehicleId: makeField((entry && entry.vehicleId) || '74-38', normalizeVehicle, defaults),", "sample fallback")},
  {id: "OCR_SUCCESS_SHOWN_BEFORE_MAPPING", kind: "ui", expected: "INV-OCR-SAVE-008", apply: input => replaceOnce(input,
    'setImportState("IMAGE_PREPROCESSING", null);', 'setImportState("FORM_MAPPING_COMPLETE", null); // mutation: premature success', "premature success")},
  {id: "SAVE_HANDLER_MISSING", kind: "ui", expected: "INV-OCR-SAVE-009", apply: input => replaceOnce(input,
    'el("sdeNightSaveBtn")?.addEventListener("click", saveDraft);', '// mutation: save handler missing', "missing save handler")},
  {id: "SAVE_READS_EMPTY_PARALLEL_MODEL", kind: "ui", expected: "INV-OCR-SAVE-010", apply: input => mutateFunction(input, "buildSavePayload",
    "const form = buildServerForm();", "const form = {planDate: draft.operationalDate, signature: '', ds: '', rows: []};", "empty save model")},
  {id: "SAVE_SILENTLY_RETURNS_ON_INVALID_IMPORT", kind: "ui", expected: "INV-OCR-SAVE-011", apply: input => replaceOnce(input,
    'if (imageSource && !humanReviewActivated) throw new Error("image_import_not_reviewed");', "if (imageSource && !humanReviewActivated) return null; // mutation: silent noop", "silent invalid import")},
  {id: "SAVE_SKIPS_READBACK", kind: "ui", expected: "INV-OCR-SAVE-012", apply: input => replaceOnce(input,
    'const readbackResponse = await root.fetch(API_ROOT + "/" + encodeURIComponent(result.planId), {', 'const readbackResponse = {ok:true, json:async()=>result}; // mutation skips server readback\n      /*', "skip readback")},
  {id: "SAVE_CREATES_PARTIAL_RECORDS", kind: "storage", expected: "INV-OCR-SAVE-013", apply: input => replaceOnce(input,
    "if(transactionStarted) rollbackQuietly(db);", "if(false && transactionStarted) rollbackQuietly(db); // mutation retains partial records", "disable rollback")},
  {id: "DOUBLE_SAVE_CREATES_DUPLICATE_PLAN", kind: "storage", expected: "INV-OCR-SAVE-014", apply: input => replaceOnce(input,
    "const concurrentIdempotency = getIdempotency(db, validated.idempotencyKey);", "const concurrentIdempotency = null; // mutation ignores concurrent duplicate", "ignore duplicate")},
];

const results = [];
try {
  const baseline = run(sources, "baseline");
  if (baseline.execution.status !== 0 || baseline.report.counts?.fail !== 0) throw new Error("night OCR/save mutation baseline is not green");
  for (const mutation of mutations) {
    const candidate = {...sources, [mutation.kind]: mutation.apply(sources[mutation.kind])};
    const mutant = run(candidate, mutation.id);
    const failedIds = (mutant.report.results || []).filter(result => result.status === "FAIL").map(result => result.id);
    const killed = mutant.execution.status === 1 && failedIds.includes(mutation.expected);
    results.push({
      id: mutation.id, status: killed ? "PASS" : "FAIL", mutantExitCode: mutant.execution.status,
      expectedInvariant: mutation.expected, failedIds, timeoutKill: false,
    });
  }
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = results.filter(result => result.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-night-plan-ocr-save-mutation-audit-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;

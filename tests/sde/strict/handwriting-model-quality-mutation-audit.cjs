"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const harness = path.join(root, "tests/sde/strict/handwriting-model-quality-invariants.cjs");
const sources = {
  recognition: fs.readFileSync(path.join(root, "sde_handwriting_recognition.js"), "utf8"),
  worker: fs.readFileSync(path.join(root, "sde_handwriting_worker.js"), "utf8"),
  ui: fs.readFileSync(path.join(root, "sde_night_planning_ui.js"), "utf8"),
  storage: fs.readFileSync(path.join(root, "server/src/nightPlanStorage.js"), "utf8"),
  learning: fs.readFileSync(path.join(root, "scripts/sde_handwriting_learning.py"), "utf8"),
  gitignore: fs.readFileSync(path.join(root, ".gitignore"), "utf8"),
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-htr-model-quality-mutations-"));

function replaceOnce(input, before, after, label){
  const index = input.indexOf(before);
  if(index < 0) throw new Error(`${label}: mutation anchor not found`);
  if(input.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0, index) + after + input.slice(index + before.length);
}

function mutateFunction(input, name, before, after, label){
  const start = input.indexOf(`function ${name}(`);
  if(start < 0) throw new Error(`${label}: function ${name} not found`);
  const candidates = [input.indexOf("\n  function ", start + 10), input.indexOf("\n  async function ", start + 10)].filter(index => index >= 0);
  const end = candidates.length ? Math.min(...candidates) : input.length;
  return input.slice(0, start) + replaceOnce(input.slice(start, end), before, after, label) + input.slice(end);
}

function run(candidate, label){
  const directory = path.join(temporary, label);
  fs.mkdirSync(directory, {recursive: true});
  const files = {};
  for(const [kind, source] of Object.entries(candidate)){
    const extension = kind === "learning" ? ".py" : kind === "gitignore" ? ".gitignore" : ".js";
    files[kind] = path.join(directory, `${kind}${extension}`);
    fs.writeFileSync(files[kind], source);
  }
  const execution = childProcess.spawnSync(process.execPath, [
    harness, files.recognition, files.worker, files.ui, files.storage, files.learning, files.gitignore,
  ], {cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024});
  if(execution.error || execution.signal || ![0, 1].includes(execution.status)){
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const report = JSON.parse(String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if(report.schemaVersion !== "sde-handwriting-model-quality-invariants-v1") throw new Error(`${label}: unexpected harness schema`);
  return {execution, report};
}

const mutations = [
  {id: "BLANK_CELL_SENT_TO_HTR", kind: "worker", expected: "INV-MQ-001", apply: source => replaceOnce(source, "if(crop.blank){", "if(false && crop.blank){", "blank bypass")},
  {id: "GRID_NOISE_ACCEPTED_AS_TEXT", kind: "recognition", expected: "INV-MQ-002", apply: source => replaceOnce(source, "if(gridMask?.[index] || Number(image[index]) >= darkThreshold) continue;", "if(Number(image[index]) >= darkThreshold) continue;", "grid mask bypass")},
  {id: "PRINT_OCR_USED_AS_ONLY_HANDWRITING_MODEL", kind: "worker", expected: "INV-MQ-003", apply: source => replaceOnce(source, 'const HTR_MODEL_ROOT = "assets/models/gigapdf-ocr-handwriting/";', 'const HTR_MODEL_ROOT = "assets/models/latin-pp-ocrv5-mobile-rec-onnx/";', "print-only model")},
  {id: "LOW_CONFIDENCE_WRITTEN_TO_CANONICAL_FORM", kind: "recognition", expected: "INV-MQ-004", apply: source => replaceOnce(source, 'const selectedValue = disposition === "AUTO_ACCEPTED" ? proposedValue : "";', "const selectedValue = proposedValue;", "low confidence write")},
  {id: "REVIEW_SUGGESTION_COUNTS_AS_FILLED_VALUE", kind: "ui", expected: "INV-MQ-005", apply: source => replaceOnce(source, 'Object.hasOwn(field, "selectedValue") ? field.selectedValue || "" : field.normalizedValue || ""', 'Object.hasOwn(field, "selectedValue") ? field.selectedValue || field.suggestedValue || "" : field.normalizedValue || ""', "suggestion as value")},
  {id: "GIBBERISH_STRING_ACCEPTED", kind: "recognition", expected: "INV-MQ-006", apply: source => replaceOnce(source, "const gibberish = isGibberishCandidate(proposedValue, columnId);", "const gibberish = false;", "gibberish acceptance")},
  {id: "SETTNR_HYPHEN_DROPPED", kind: "recognition", expected: "INV-MQ-007", apply: source => replaceOnce(source, 'return /^\\d{2}$/.test(left) && /^\\d{2}$/.test(right) ? `${left}-${right}` : "";', 'return /^\\d{2}$/.test(left) && /^\\d{2}$/.test(right) ? `${left}${right}` : "";', "hyphen drop")},
  {id: "TRACK_SUFFIX_DROPPED", kind: "recognition", expected: "INV-MQ-008", apply: source => mutateFunction(source, "canonicalizeSlot", 'return String(value || "").normalize("NFKC").toUpperCase().replace(/\\s+/g, "")', 'return String(value || "").normalize("NFKC").toUpperCase().replace(/[NSMV]/g, "").replace(/\\s+/g, "")', "suffix drop")},
  {id: "ARROW_DROPPED", kind: "recognition", expected: "INV-MQ-009", apply: source => mutateFunction(source, "canonicalizeSlot", '.replace(/(?:-|=)+>/g, "→")', '.replace(/(?:-|=)+>/g, "")', "arrow drop")},
  {id: "PREVIOUS_IMPORT_SUGGESTIONS_PERSIST", kind: "recognition", expected: "INV-MQ-010", apply: source => mutateFunction(source, "replaceRecognitionImage", "return createRecognitionSession(sourceImageFingerprint);", "return _session;", "retain previous session")},
  {id: "RAW_MODEL_OUTPUT_USED_AS_GROUND_TRUTH", kind: "recognition", expected: "INV-MQ-011", apply: source => mutateFunction(source, "applyHumanCorrection", "rawRecognizerIsGroundTruth: false,", "rawRecognizerIsGroundTruth: true,", "raw output ground truth")},
  {id: "HUMAN_CORRECTION_NOT_STORED", kind: "recognition", expected: "INV-MQ-012", apply: source => mutateFunction(source, "applyHumanCorrection", "humanFinalValue: selectedValue,", "humanFinalValue: recognizerProposal,", "discard human correction")},
  {id: "TRAINING_USES_BLIND_HOLDOUT", kind: "learning", expected: "INV-MQ-013", apply: source => replaceOnce(source, "if not train_documents or train_documents & holdout_documents:", "if not train_documents:", "allow holdout leakage")},
  {id: "MODEL_PROMOTED_WITHOUT_GATE", kind: "learning", expected: "INV-MQ-014", apply: source => replaceOnce(source, 'if qualification.get("gate") != "GREEN" or args.approved_sha != candidate_hash:', "if args.approved_sha != candidate_hash:", "remove quality gate")},
  {id: "MODEL_HASH_NOT_VERIFIED", kind: "worker", expected: "INV-MQ-015", apply: source => replaceOnce(source, 'await htr.verifyModelBytes(modelBytes, {modelSha256: manifest.files["model.onnx"]});', "void modelBytes;", "hash bypass")},
  {id: "PRIVATE_CELL_CROPS_COMMITTED", kind: "gitignore", expected: "INV-MQ-016", apply: source => replaceOnce(source, "tests/sde/fixtures/handwriting-private/", "tests/sde/fixtures/handwriting-public/", "private crop tracking")},
  {id: "CORRECTION_BURDEN_NOT_MEASURED", kind: "ui", expected: "INV-MQ-017", apply: source => replaceOnce(source, "const correctionBurden = htrLogic.computeCorrectionBurden([...cells, ...metadataCells]);", "const correctionBurden = null;", "drop correction burden")},
];

const results = [];
try{
  const baseline = run(sources, "baseline");
  if(baseline.execution.status !== 0 || baseline.report.counts?.fail !== 0) throw new Error(`model quality mutation baseline is not green: ${baseline.execution.stdout}`);
  for(const mutation of mutations){
    const candidate = {...sources, [mutation.kind]: mutation.apply(sources[mutation.kind])};
    const mutant = run(candidate, mutation.id);
    const failedIds = mutant.report.results.filter(result => result.status === "FAIL").map(result => result.id);
    const killed = mutant.execution.status === 1 && failedIds.includes(mutation.expected);
    results.push({id: mutation.id, status: killed ? "PASS" : "FAIL", mutantExitCode: mutant.execution.status, expectedInvariant: mutation.expected, failedIds, timeoutKill: false});
  }
}finally{
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = results.filter(result => result.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-handwriting-model-quality-mutation-audit-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;

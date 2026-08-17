"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const logicPath = path.resolve(process.argv[2] || path.join(root, "sde_intelligent_night_planning.js"));
const uiPath = path.resolve(process.argv[3] || path.join(root, "sde_night_planning_ui.js"));
const storagePath = path.resolve(process.argv[4] || path.join(root, "server/src/nightPlanStorage.js"));
const logic = require(logicPath);
const ui = fs.readFileSync(uiPath, "utf8");
const storage = fs.readFileSync(storagePath, "utf8");
const results = [];

function invariant(id, description, test) {
  try {
    if (!test()) throw new Error(description);
    results.push({id, status: "PASS", description});
  } catch (error) {
    results.push({id, status: "FAIL", description, error: String(error && error.message || error)});
  }
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, "tests/sde/fixtures/night-plan", name), "utf8"));
}

function mapFixture(name, id) {
  const value = fixture(name);
  return logic.mapOcrResultToNightPlan(value.ocr, {
    planId: id,
    operationalDate: "2026-08-18",
    createdAt: "2026-08-17T18:00:00.000Z",
  });
}

function emptyValues(plan) {
  return plan.entries.flatMap(entry => [
    entry.arrivalOccurrence.normalizedValue,
    entry.departureOccurrence.normalizedValue,
    entry.vehicleId.normalizedValue,
    entry.desiredSlot.normalizedValue,
    entry.taskContext.normalizedValue,
    entry.notes.normalizedValue,
  ]);
}

invariant("INV-OCR-SAVE-001", "OCR-resultatet sendes til mapperen", () =>
  ui.includes("logic.mapOcrResultToNightPlan(result, {")
);
invariant("INV-OCR-SAVE-002", "mapperen fyller mer enn første celle og rad", () => {
  const mapped = mapFixture("historical-togplassering-skien.json", "historical-mutation-invariant");
  return mapped.ocrMapping.mappedCellCount > 1 && mapped.ocrMapping.detectedRowCount > 1;
});
invariant("INV-OCR-SAVE-003", "vellykket mapping blir gjeldende form state", () =>
  ui.includes("draft = plan;") && ui.indexOf("draft = plan;") < ui.indexOf("setImportState(draft.ocrMapping.mappingStatus")
);
invariant("INV-OCR-SAVE-004", "DOM og lagring leser samme canonical draft", () =>
  ui.includes("syncDraftFromEditor();") && ui.includes("rows: draft.entries.map(function row(entry)")
);
invariant("INV-OCR-SAVE-005", "8S finnes ikke som default", () => {
  const plan = logic.createNightPlan({
    planId: "empty-default-invariant", operationalDate: "2026-08-18",
    createdAt: "2026-08-17T18:00:00.000Z", sourceType: "HUMAN_MANUAL_PLAN",
    entries: Array.from({length: 29}, () => ({})),
  });
  return plan.entries.length === 29 && emptyValues(plan).every(value => value === "");
});
invariant("INV-OCR-SAVE-006", "ny import nullstiller første imports draft og rapport", () => {
  const start = ui.indexOf("function selectImage(");
  const end = ui.indexOf("\n  async function fileFingerprint", start);
  const body = ui.slice(start, end);
  return body.includes("releaseSelectedImage();") && body.includes("draft = makeManualDraft();")
    && body.includes('setImportState("IMAGE_SELECTED", null);');
});
invariant("INV-OCR-SAVE-007", "designverdier brukes aldri som mapperfallback", () => {
  const plan = logic.createNightPlan({
    planId: "sample-fallback-invariant", operationalDate: "2026-08-18",
    createdAt: "2026-08-17T18:00:00.000Z", sourceType: "HUMAN_MANUAL_PLAN",
    entries: Array.from({length: 29}, () => ({})),
  });
  const values = emptyValues(plan);
  return values.every(value => value === "") && !values.some(value => ["8S", "74-38", "833", "802"].includes(value));
});
invariant("INV-OCR-SAVE-008", "success vises først etter fullført skjemamapping", () =>
  ui.includes('setImportState("OCR_PROCESSING", null);')
  && ui.includes('if (report.mappingStatus === "FORM_MAPPING_COMPLETE")')
  && !ui.includes('setImportState("FORM_MAPPING_COMPLETE", null);')
);
invariant("INV-OCR-SAVE-009", "Lagre-handleren er bundet", () =>
  ui.includes('el("sdeNightSaveBtn")?.addEventListener("click", saveDraft);')
);
invariant("INV-OCR-SAVE-010", "Lagre leser synlig current form", () =>
  ui.includes("const form = buildServerForm();") && ui.includes("form,\n      source:")
);
invariant("INV-OCR-SAVE-011", "ugyldig import gir eksplisitt feil og aldri silent return", () =>
  ui.includes('throw new Error("image_import_not_reviewed")')
  && ui.includes('image_import_not_reviewed: "Planen er ikke kontrollert etter bildeimport.')
);
invariant("INV-OCR-SAVE-012", "Lagre krever eksakt server- og bildereadback", () =>
  ui.includes("const readbackResponse = await root.fetch(API_ROOT + \"/\" + encodeURIComponent(result.planId)")
  && ui.includes("canonicalJson(readback.form) !== canonicalJson(payload.form)")
  && ui.includes("night_plan_image_readback_mismatch")
);
invariant("INV-OCR-SAVE-013", "serverlagring ruller tilbake database og publisert bilde atomisk", () =>
  storage.includes('db.exec("BEGIN IMMEDIATE TRANSACTION;")')
  && storage.includes("if(transactionStarted) rollbackQuietly(db);")
  && storage.includes("if(published) removeFileQuietly(finalPath);")
);
invariant("INV-OCR-SAVE-014", "dobbeltlagring idempotensbindes før commit", () =>
  storage.includes("const existingIdempotency = getIdempotency(db, validated.idempotencyKey);")
  && storage.includes("const concurrentIdempotency = getIdempotency(db, validated.idempotencyKey);")
  && storage.includes("INSERT INTO night_plan_idempotency")
  && storage.indexOf("INSERT INTO night_plan_idempotency") < storage.indexOf('db.exec("COMMIT;")')
);

const failed = results.filter(result => result.status === "FAIL");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-night-plan-ocr-save-invariants-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;

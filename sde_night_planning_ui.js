(function initializeSdeNightPlanningUi(root) {
  "use strict";

  const logic = root.SdeNightIntelligence;
  let htrLogic = root.SdeHandwritingRecognition || null;
  let htrRuntime = root.SdeHandwritingRuntime || null;
  const HTR_MODULE_SOURCES = Object.freeze([
    Object.freeze({globalName: "SdeHandwritingRecognition", source: "sde_handwriting_recognition.js?v=3fb6714f23f22aa2efdfb28d233865edda88db125bec300216148e3634fcfa47"}),
    Object.freeze({globalName: "SdeHandwritingRuntime", source: "sde_handwriting_runtime.js?v=fec96bb8077c401ec73b64aaf75642fe53f4a7f010a9bd6632e90f424db29afe"}),
  ]);
  const API_ROOT = "/api/night-plans";
  const PLAN_STORAGE_KEY = "sde_night_plans_v1";
  const PLAN_STORE_SCHEMA = "sde-night-plan-store-v1";
  const ROW_COUNT = 29;
  const FIELD_NAMES = [
    "time",
    "arrivalOccurrence",
    "departureOccurrence",
    "vehicleId",
    "desiredSlot",
    "taskContext",
    "info",
    "notes",
  ];
  const REPORT_COLUMN_BY_FIELD = Object.freeze({
    time: "arrivalTime",
    arrivalOccurrence: "fromTrain",
    departureOccurrence: "toTrain",
    vehicleId: "vehicleId",
    desiredSlot: "toTrack",
    taskContext: "wcWater",
    info: "info",
    notes: "notes",
  });
  const SAFE_FALLBACK_WEIGHTS = Object.freeze({
    version: "sde-night-weights-safe-fallback-v1",
    deterministic: 0.8,
    humanExperience: 0.2,
    machineLearning: 0,
  });

  let initialized = false;
  let draft = null;
  let selectedImage = null;
  let selectedImageSource = null;
  let selectedImageMimeType = null;
  let selectedImageOcrCompleted = false;
  let importState = {status: "NO_IMAGE", report: null};
  let imageObjectUrl = "";
  let ocrAnalyzer = null;
  let htrModulePromise = null;
  let ocrGeneration = 0;
  let assetPromise = null;
  let editMode = true;
  let humanReviewActivated = true;
  let serverPlans = [];
  let saveAttempt = null;
  let dirty = false;
  let lastInteractionAt = Date.now();
  let activeEvidenceTarget = null;
  const inferenceAuditInMemory = [];

  function setImportState(status, report) {
    importState = {status: String(status || "NO_IMAGE"), report: report ? JSON.parse(JSON.stringify(report)) : null};
  }

  function el(id) {
    return document.getElementById(id);
  }

  function html(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fieldValue(entry, name) {
    const field = entry && entry[name];
    if (field && typeof field === "object") {
      if (field.validationState === "HUMAN_CONFIRMED") return String(field.normalizedValue || "");
      return String(Object.hasOwn(field, "selectedValue") ? field.selectedValue || "" : field.normalizedValue || "");
    }
    return String(field || "");
  }

  function makeId(prefix) {
    const suffix = root.crypto && typeof root.crypto.randomUUID === "function"
      ? root.crypto.randomUUID()
      : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
    return prefix + "-" + suffix;
  }

  function defaultOperationalDate() {
    try {
      if (typeof getTomorrowOsloIsoDate === "function") return getTomorrowOsloIsoDate();
    } catch (_error) {
    }
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function currentDataRevision() {
    try {
      if (typeof dropsVehicleStatusReadback === "object" && dropsVehicleStatusReadback) {
        return String(dropsVehicleStatusReadback.revision || "");
      }
    } catch (_error) {
    }
    try {
      return String(state && state.sharedSporplanDraftAppliedRevision || "");
    } catch (_error) {
      return "";
    }
  }

  function emptyStore() {
    return {schemaVersion: PLAN_STORE_SCHEMA, plans: []};
  }

  function readPlanStore() {
    try {
      const value = JSON.parse(root.localStorage.getItem(PLAN_STORAGE_KEY) || "null");
      if (!value || value.schemaVersion !== PLAN_STORE_SCHEMA || !Array.isArray(value.plans)) return emptyStore();
      return value;
    } catch (_error) {
      return emptyStore();
    }
  }

  function setStatus(message, tone) {
    const target = el("sdeNightPlanStatus");
    if (!target) return;
    target.textContent = String(message || "");
    target.className = "sde-night-status" + (tone ? " " + tone : "");
  }

  function makeManualDraft() {
    if (!logic) return null;
    return logic.createNightPlan({
      planId: makeId("manual-plan"),
      operationalDate: defaultOperationalDate(),
      createdAt: new Date().toISOString(),
      createdBy: "",
      sourceType: "HUMAN_MANUAL_PLAN",
      dataRevision: currentDataRevision(),
      planStatus: "DRAFT",
      entries: Array.from({length: ROW_COUNT}, function emptyEntry() { return {}; }),
    });
  }

  function markDirty() {
    dirty = true;
    saveAttempt = null;
    lastInteractionAt = Date.now();
  }

  function knownVehicleIds() {
    try {
      const catalog = getDropsVehicleCatalog();
      return Object.values(catalog).flat().map(String);
    } catch (_error) {
      return [];
    }
  }

  function knownTrainIdentifiers() {
    try {
      if (typeof getAllRelevantTursattTrains === "function") return Array.from(getAllRelevantTursattTrains()).map(String);
    } catch (_error) {
    }
    return [];
  }

  function syncDraftDate() {
    if (!draft) return;
    const date = String(el("sdeNightOperationalDate") && el("sdeNightOperationalDate").value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) draft.operationalDate = date;
  }

  function syncDraftFromEditor() {
    if (!draft) return;
    document.querySelectorAll("#sdeNightPlanRows [data-sde-night-field]").forEach(function syncField(input) {
      updateDraftField(
        Number(input.dataset.sdeNightIndex),
        String(input.dataset.sdeNightField || ""),
        input.value,
        false
      );
    });
    draft.sdeClock = String(el("sdeNightClock") && el("sdeNightClock").value || "").trim();
    draft.sdeDs = String(el("sdeNightDs") && el("sdeNightDs").value || "").trim();
  }

  function validateDraft() {
    if (!draft) return null;
    syncDraftDate();
    draft = logic.validateNightPlan(draft, {
      knownVehicleIds: knownVehicleIds(),
      validSlots: logic.VALID_SLOTS,
    });
    return draft;
  }

  function validationText(entry) {
    const warnings = Array.isArray(entry && entry.validationWarnings) ? entry.validationWarnings : [];
    const labels = {
      MISSING_VEHICLE: "Kjøretøy mangler",
      UNKNOWN_VEHICLE: "Ukjent vehicleId",
      MISSING_SLOT: "Ønsket spor mangler",
      INVALID_SLOT: "Ugyldig spor",
    };
    return warnings.map(code => labels[code] || code).join(" · ");
  }

  function renderDraftRows() {
    const host = el("sdeNightPlanRows");
    if (!host || !logic) return;
    if (!draft) draft = makeManualDraft();
    while (draft.entries.length < ROW_COUNT) draft = logic.addNightPlanEntry(draft);
    while (draft.entries.length > ROW_COUNT) draft = logic.removeNightPlanEntry(draft, draft.entries.length - 1);
    const operationalDateInput = el("sdeNightOperationalDate");
    if (operationalDateInput && document.activeElement !== operationalDateInput) {
      operationalDateInput.value = draft.operationalDate || (draft.sourceType === "HUMAN_IMPORTED_PLAN" ? "" : defaultOperationalDate());
    }
    const clockInput = el("sdeNightClock");
    const confirmedByInput = el("sdeNightConfirmedBy");
    const dsInput = el("sdeNightDs");
    if (clockInput && document.activeElement !== clockInput) clockInput.value = draft.sdeClock || "";
    if (confirmedByInput && document.activeElement !== confirmedByInput) confirmedByInput.value = draft.createdBy || "";
    if (dsInput && document.activeElement !== dsInput) dsInput.value = draft.sdeDs || "";
    const applyMetadataReview = function applyMetadataReview(input, columnId) {
      if (!input) return;
      const cell = (importState.report?.metadataCells || []).find(item => item?.columnId === columnId);
      const uncertain = cell?.needsReview === true;
      input.classList.toggle("sde-night-uncertain", uncertain);
      if (uncertain) {
        input.dataset.sdeNightMetadata = columnId;
        input.title = "Metadatafeltet krever menneskelig kontroll";
      } else {
        delete input.dataset.sdeNightMetadata;
        input.removeAttribute("title");
      }
    };
    applyMetadataReview(clockInput, "clock");
    applyMetadataReview(operationalDateInput, "date");
    applyMetadataReview(confirmedByInput, "signature");
    applyMetadataReview(dsInput, "ds");
    [operationalDateInput, clockInput, confirmedByInput, dsInput].forEach(function applyReadOnly(input) {
      if (input) input.readOnly = !editMode;
    });
    const templateId = draft.formTemplateId === "TEMPLATE_B" ? "TEMPLATE_B" : "TEMPLATE_A";
    const templateB = templateId === "TEMPLATE_B";
    const clockLabel = el("sdeNightClockLabel");
    const dsLabel = el("sdeNightDsLabel");
    if (clockLabel) clockLabel.hidden = !templateB;
    if (dsLabel) dsLabel.hidden = templateB;
    const head = el("sdeNightPlanHead");
    if (head) head.innerHTML = "<tr>" + (templateB
      ? ["Inn kl", "Fra Tog", "Til Tog", "Settnr", "Til spor", "WC/vann", "INFO", "Merknad"]
      : ["Fra Tog", "Til Tog", "Settnr", "Til spor", "Wc/vann", "Merknad"]
    ).map(function header(label) { return "<th>" + html(label) + "</th>"; }).join("") + "</tr>";
    const structure = el("sdeNightFormStructure");
    if (structure) structure.textContent = templateB ? "29 faste linjer · 8 kolonner · Template B" : "29 faste linjer · 6 kolonner · Template A";
    const editState = el("sdeNightEditState");
    if (editState) editState.textContent = editMode ? "Innholdet kan redigeres" : "Wc/vann låst i visningsmodus";
    host.innerHTML = (draft.entries || []).map(function renderEntry(entry, index) {
      const input = function input(name, label) {
        const descriptor = entry[name] || {};
        const original = String(descriptor.rawValue || "");
        const suggestion = String(descriptor.suggestedValue || "");
        const uncertain = descriptor.validationState === "REVIEW_REQUIRED" || descriptor.needsReview === true;
        return [
          "<input type=\"text\" data-sde-night-index=\"", index,
          "\" data-sde-night-field=\"", html(name),
          "\" class=\"", uncertain ? "sde-night-uncertain" : "",
          "\" value=\"", html(fieldValue(entry, name)),
          suggestion ? "\" placeholder=\"Forslag: " + html(suggestion) : "",
          "\" aria-label=\"", html(label + " linje " + (index + 1)),
          uncertain ? "\" data-sde-night-uncertain=\"true" : "",
          "\" title=\"", html(original ? "Opprinnelig OCR-verdi: " + original : "Manuell verdi"),
          "\"", editMode ? "" : " readonly",
          ">",
        ].join("");
      };
      const templateAInputs = [
        input("arrivalOccurrence", "Fra tog"),
        input("departureOccurrence", "Til tog"),
        input("vehicleId", "Settnr"),
        input("desiredSlot", "Til spor"),
        input("taskContext", "Wc/vann"),
        input("notes", "Merknad"),
      ];
      const templateBInputs = [
        input("time", "Inn kl"),
        input("arrivalOccurrence", "Fra tog"),
        input("departureOccurrence", "Til tog"),
        input("vehicleId", "Settnr"),
        input("desiredSlot", "Til spor"),
        input("taskContext", "WC/vann"),
        input("info", "INFO"),
        input("notes", "Merknad"),
      ];
      return [
        "<tr data-sde-night-row=\"", index, "\">",
        (templateB ? templateBInputs : templateAInputs).map(function cell(value) { return "<td>" + value + "</td>"; }).join(""),
        "</tr>",
      ].join("");
    }).join("");
  }

  function hideCellEvidence() {
    activeEvidenceTarget = null;
    const host = el("sdeNightCellEvidence");
    if (host) host.hidden = true;
  }

  async function showCellEvidence(input) {
    if (!input?.classList?.contains("sde-night-uncertain") || !selectedImage || !imageObjectUrl || !importState.report) {
      hideCellEvidence();
      return;
    }
    const metadataColumn = String(input.dataset.sdeNightMetadata || "");
    const rowIndex = metadataColumn ? null : Number(input.dataset.sdeNightIndex);
    const columnId = metadataColumn || REPORT_COLUMN_BY_FIELD[String(input.dataset.sdeNightField || "")];
    const cell = metadataColumn
      ? (importState.report.metadataCells || []).find(item => item?.columnId === columnId)
      : (importState.report.cells || []).find(item => Number(item?.rowIndex) === rowIndex && item?.columnId === columnId);
    const box = cell?.sourceBoundingBox || cell?.boundingBox;
    if (!box || box.coordinateSpace !== "ORIGINAL_IMAGE") {
      hideCellEvidence();
      return;
    }
    const expectedUrl = imageObjectUrl;
    try {
      const sourceImage = new root.Image();
      sourceImage.src = expectedUrl;
      await sourceImage.decode();
      if (expectedUrl !== imageObjectUrl) return;
      const landscape = sourceImage.naturalWidth > sourceImage.naturalHeight;
      const orientedWidth = landscape ? sourceImage.naturalHeight : sourceImage.naturalWidth;
      const orientedHeight = landscape ? sourceImage.naturalWidth : sourceImage.naturalHeight;
      const frameScale = Math.min(1, 1800 / Math.max(orientedWidth, orientedHeight));
      const oriented = document.createElement("canvas");
      oriented.width = orientedWidth;
      oriented.height = orientedHeight;
      const orientedContext = oriented.getContext("2d", {alpha: false});
      orientedContext.fillStyle = "#fff";
      orientedContext.fillRect(0, 0, oriented.width, oriented.height);
      if (landscape) {
        orientedContext.translate(oriented.width, 0);
        orientedContext.rotate(Math.PI / 2);
      }
      orientedContext.drawImage(sourceImage, 0, 0);
      const sx = Math.max(0, Number(box.x0) / frameScale);
      const sy = Math.max(0, Number(box.y0) / frameScale);
      const sw = Math.max(1, Math.min(oriented.width - sx, (Number(box.x1) - Number(box.x0)) / frameScale));
      const sh = Math.max(1, Math.min(oriented.height - sy, (Number(box.y1) - Number(box.y0)) / frameScale));
      const canvas = el("sdeNightCellEvidenceCanvas");
      const context = canvas?.getContext("2d", {alpha: false});
      if (!canvas || !context || !(sw > 0) || !(sh > 0)) throw new Error("cell_evidence_unavailable");
      canvas.width = Math.max(160, Math.min(640, Math.round(sw * 2)));
      canvas.height = Math.max(72, Math.min(180, Math.round(canvas.width * sh / sw)));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(oriented, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const candidateText = candidate => String(candidate?.text || "ikke funnet");
      activeEvidenceTarget = {input, cell, rowIndex, columnId, metadataColumn};
      const caption = el("sdeNightCellEvidenceCaption");
      const location = metadataColumn ? `Metadata ${columnId}` : `Rad ${rowIndex + 1}, ${columnId}`;
      const suggestion = String(cell.suggestedValue || "");
      if (caption) caption.textContent = `${location}. Forslag: ${suggestion || "ingen forsvarlig kandidat"}. Trykt: ${candidateText(cell.printedCandidate)}. Håndskrevet: ${candidateText(cell.handwrittenCandidate)}.`;
      const accept = el("sdeNightAcceptSuggestionBtn");
      if (accept) accept.disabled = !suggestion || Boolean(metadataColumn);
      const host = el("sdeNightCellEvidence");
      if (host) host.hidden = false;
    } catch (_error) {
      hideCellEvidence();
    }
  }

  function applyEvidenceAction(action) {
    const target = activeEvidenceTarget;
    if (!target || target.metadataColumn || !target.input) return;
    editMode = true;
    humanReviewActivated = true;
    const fieldName = String(target.input.dataset.sdeNightField || "");
    const rowIndex = Number(target.input.dataset.sdeNightIndex);
    if (action === "ACCEPT_SUGGESTION") {
      const suggestion = String(target.cell?.suggestedValue || "");
      if (!suggestion) return;
      updateDraftField(rowIndex, fieldName, suggestion, true);
      setStatus("Forslaget er godkjent som menneskelig kontrollert skjemaverdi. Endringen lagres først med «Lagre».", "warn");
    } else if (action === "LEAVE_BLANK") {
      updateDraftField(rowIndex, fieldName, "", true);
      setStatus("Feltet er eksplisitt beholdt tomt. Endringen lagres først med «Lagre».", "warn");
    } else if (action === "EDIT_VALUE") {
      renderDraftRows();
      const replacement = el("sdeNightPlanRows")?.querySelector(`[data-sde-night-index="${rowIndex}"][data-sde-night-field="${fieldName}"]`);
      replacement?.focus();
      replacement?.select();
      setStatus("Skriv den menneskelig kontrollerte verdien. Endringen lagres først med «Lagre».", "warn");
    }
    hideCellEvidence();
  }

  function updateDraftField(index, fieldName, value, shouldRender) {
    if (!draft || !draft.entries[index] || !FIELD_NAMES.includes(fieldName)) return;
    const changed = fieldValue(draft.entries[index], fieldName) !== String(value == null ? "" : value);
    draft = logic.updateNightPlanField(draft, index, fieldName, value);
    if (changed) markDirty();
    if (shouldRender !== false) {
      renderDraftRows();
      setStatus("Linjen er endret. Kontroller kritiske felt på nytt før CONFIRMED.", "warn");
    }
  }

  function correctedMappingReport(form) {
    if (!importState.report || !Array.isArray(importState.report.cells) || !htrLogic) return importState.report;
    const fieldNames = {
      arrivalTime: "arrivalTime",
      fromTrain: "fromTrain",
      toTrain: "toTrain",
      vehicleId: "vehicleId",
      toTrack: "toTrack",
      wcWater: "wcWater",
      info: "info",
      notes: "notes",
    };
    const cells = importState.report.cells.map(function correctedCell(cell) {
      const row = Number(cell.rowIndex);
      const formField = fieldNames[cell.columnId];
      const humanValue = Number.isInteger(row) && row >= 0 && row < ROW_COUNT && formField
        ? form.rows[row][formField]
        : String(cell.selectedValue || "");
      return htrLogic.applyHumanCorrection(cell, humanValue);
    });
    const metadataValues = {
      clock: form.clock,
      date: form.planDate,
      signature: form.signature,
      ds: form.ds,
    };
    const metadataCells = Array.isArray(importState.report.metadataCells)
      ? importState.report.metadataCells.map(function correctedMetadataCell(cell) {
        return htrLogic.applyHumanCorrection(cell, metadataValues[cell.columnId] || "");
      })
      : [];
    const mappedCellCount = cells.filter(cell => String(cell.selectedValue || "").trim()).length;
    const suggestedCellCount = cells.filter(cell => String(cell.suggestedValue || "").trim()).length;
    const recognizedCellCount = cells.filter(cell => String(cell.selectedValue || cell.suggestedValue || "").trim()).length;
    const correctionBurden = htrLogic.computeCorrectionBurden([...cells, ...metadataCells]);
    return {
      ...importState.report,
      cells,
      metadataCells,
      mappedCellCount,
      suggestedCellCount,
      recognizedCellCount,
      correctionBurden,
      reviewedCellCount: 0,
      requiresHumanReview: false,
      humanGroundTruthSource: "HUMAN_CORRECTED_FORM",
      rawRecognizerIsGroundTruth: false,
      humanReviewCompleted: true,
    };
  }

  function enableEditing() {
    editMode = true;
    humanReviewActivated = true;
    markDirty();
    renderDraftRows();
    setStatus("Innholdet er åpnet for menneskelig kontroll og korrigering. Ingen data er lagret.", "warn");
  }

  function canonicalJson(value) {
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map(function pair(key) {
        return JSON.stringify(key) + ":" + canonicalJson(value[key]);
      }).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  async function sha256Bytes(bytes) {
    const digest = await root.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), function hex(byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function buildServerForm() {
    syncDraftFromEditor();
    return {
      planDate: draft.operationalDate,
      clock: String(el("sdeNightClock")?.value || "").trim(),
      signature: String(el("sdeNightConfirmedBy")?.value || "").trim(),
      ds: String(el("sdeNightDs")?.value || "").trim(),
      rows: draft.entries.map(function row(entry) {
        return {
          arrivalTime: fieldValue(entry, "time"),
          fromTrain: fieldValue(entry, "arrivalOccurrence"),
          toTrain: fieldValue(entry, "departureOccurrence"),
          vehicleId: fieldValue(entry, "vehicleId"),
          toTrack: fieldValue(entry, "desiredSlot"),
          wcWater: fieldValue(entry, "taskContext"),
          info: fieldValue(entry, "info"),
          notes: fieldValue(entry, "notes"),
        };
      }),
    };
  }

  async function buildSavePayload() {
    const form = buildServerForm();
    if (!form.signature) throw new Error("signature_required");
    const imageSource = ["CAMERA", "DEVICE_FILE"].includes(selectedImageSource);
    if (imageSource && !humanReviewActivated) throw new Error("image_import_not_reviewed");
    if (!humanReviewActivated) throw new Error("human_review_required");
    let image = null;
    if (["CAMERA", "DEVICE_FILE"].includes(selectedImageSource)) {
      if (!selectedImage) throw new Error("source_image_required");
      const bytes = new Uint8Array(await selectedImage.arrayBuffer());
      image = {
        mimeType: selectedImageMimeType,
        originalFileName: selectedImage.name || "night-plan-image",
        bytesBase64: bytesToBase64(bytes),
      };
    }
    if (!saveAttempt) saveAttempt = makeId("night-plan-save");
    return {
      idempotencyKey: saveAttempt,
      expectedRevision: Number(draft.sdeServerRevision || 0),
      planId: draft.sdeServerPlanId || null,
      createdAt: draft.createdAt,
      status: "SAVED",
      form,
      source: {
        sourceType: draft.sdeLegacyLocal ? "LEGACY_LOCAL" : (selectedImageSource || "MANUAL"),
        ocrEngine: selectedImageOcrCompleted ? "gigapdf-crnn-handwriting-paddle-print-ensemble-onnx-wasm" : null,
        ocrVersion: selectedImageOcrCompleted ? String(htrLogic?.MODEL_SPEC?.version || "") : null,
        importedAt: selectedImageSource ? String(draft.sdeImportedAt || new Date().toISOString()) : null,
        humanCorrected: true,
        mappingStatus: imageSource ? (selectedImageOcrCompleted ? String(importState.status) : "NOT_RUN_HUMAN_ENTERED") : null,
        mappingReport: imageSource && selectedImageOcrCompleted && importState.report ? correctedMappingReport(form) : null,
      },
      image,
      pipeline: {
        modelVersion: selectedImageOcrCompleted ? String(htrLogic?.MODEL_SPEC?.version || "") : "not-run",
        pipelineVersion: "sde-night-local-real-htr-ensemble-v3",
      },
    };
  }

  async function saveDraft() {
    const button = el("sdeNightSaveBtn");
    if (button) button.disabled = true;
    setStatus("Lagrer bilde, korrigert skjema, proveniens og læringsgrunnlag atomisk …", "warn");
    try {
      const payload = await buildSavePayload();
      const response = await root.fetch(API_ROOT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(function invalidJson() { return null; });
      if (!response.ok || !result?.ok) throw new Error(result?.error || "night_plan_save_failed");
      const readbackResponse = await root.fetch(API_ROOT + "/" + encodeURIComponent(result.planId), {
        credentials: "same-origin", cache: "no-store",
      });
      const readback = await readbackResponse.json().catch(function invalidJson() { return null; });
      const expectedFormSha = await sha256Bytes(new TextEncoder().encode(canonicalJson(payload.form)));
      if (!readbackResponse.ok || !readback?.ok || readback.revision !== result.revision ||
          readback.finalFormSha256 !== expectedFormSha || canonicalJson(readback.form) !== canonicalJson(payload.form)) {
        throw new Error("night_plan_form_readback_mismatch");
      }
      if (payload.image) {
        const imageResponse = await root.fetch(
          API_ROOT + "/" + encodeURIComponent(result.planId) + "/images/" + encodeURIComponent(result.storedImageId),
          {credentials: "same-origin", cache: "no-store"}
        );
        const actualBytes = await imageResponse.arrayBuffer();
        const expectedImageSha = await sha256Bytes(await selectedImage.arrayBuffer());
        if (!imageResponse.ok || await sha256Bytes(actualBytes) !== expectedImageSha ||
            result.storedImageSha256 !== expectedImageSha || Number(result.storedImageByteCount) !== actualBytes.byteLength) {
          throw new Error("night_plan_image_readback_mismatch");
        }
      }
      draft.sdeServerPlanId = result.planId;
      draft.sdeServerRevision = result.revision;
      draft.createdBy = payload.form.signature;
      draft.sdeDs = payload.form.ds;
      dirty = false;
      saveAttempt = null;
      releaseSelectedImage();
      editMode = false;
      renderDraftRows();
      await loadServerPlans();
      setStatus("Planen er lagret og verifisert fra server: bilde, 29-raders skjema, proveniens og menneskelig korrigert læringsgrunnlag.", "ok");
    } catch (error) {
      const code = String(error?.message || error);
      const messages = {
        signature_required: "Signatur må fylles ut før lagring.",
        image_import_not_reviewed: "Planen er ikke kontrollert etter bildeimport. Velg «Endre innhold» og kontroller feltene.",
        human_review_required: "Velg «Endre innhold» og gjennomfør menneskelig kontroll før lagring.",
        source_image_required: "Originalbildet må fortsatt være valgt når en bildebasert plan lagres.",
        authentication_required: "Innloggingen må være gyldig for å lagre planen.",
        night_plan_capability_denied: "Bare Admin og TXP kan lagre nattplaner.",
      };
      setStatus(messages[code] || "Lagring eller verifisert readback feilet (" + code + "). Ingen vellykket lagring er bekreftet.", "error");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function loadServerPlans() {
    try {
      const response = await root.fetch(API_ROOT + "?limit=50", {credentials: "same-origin", cache: "no-store"});
      const result = await response.json();
      serverPlans = response.ok && result?.ok && Array.isArray(result.plans) ? result.plans : [];
    } catch (_error) {
      serverPlans = [];
    }
    renderSavedPlans();
  }

  function renderSavedPlans() {
    const host = el("sdeNightSavedPlans");
    if (!host) return;
    const legacyPlans = readPlanStore().plans;
    const serverHtml = serverPlans.map(function renderServer(plan) {
      return [
        "<article class=\"sde-night-saved-item\"><strong>", html(plan.planDate), " · SAVED</strong>",
        "<p>", html(plan.signature), " · revisjon ", html(plan.revision), " · ", html(plan.sourceType), "</p>",
        "<p class=\"sde-night-model-meta\">PlanId ", html(plan.planId), " · skjema SHA-256 ", html(plan.finalFormSha256), "</p>",
        "<button type=\"button\" data-sde-night-open-server=\"", html(plan.planId), "\">Åpne read-only</button></article>",
      ].join("");
    }).join("");
    const legacyHtml = legacyPlans.map(function renderLegacy(plan, index) {
      return [
        "<article class=\"sde-night-saved-item\"><strong>Lokal legacy-kopi · ", html(plan.operationalDate || "ukjent dato"), "</strong>",
        "<p>Leses bare lokalt og overføres aldri automatisk.</p>",
        "<button type=\"button\" data-sde-night-open-legacy=\"", index, "\">Velg for eksplisitt overføring</button></article>",
      ].join("");
    }).join("");
    host.innerHTML = serverHtml + legacyHtml || "<div class=\"sde-night-status\">Ingen serverlagrede planer eller lokale legacy-kopier.</div>";
  }

  async function openServerPlan(planId) {
    try {
      const response = await root.fetch(API_ROOT + "/" + encodeURIComponent(planId), {credentials: "same-origin", cache: "no-store"});
      const plan = await response.json();
      if (!response.ok || !plan?.ok) throw new Error("night_plan_read_failed");
      releaseSelectedImage();
      const formTemplateId = plan.provenance?.mappingReport?.templateId === "TEMPLATE_B"
        ? "TEMPLATE_B"
        : "TEMPLATE_A";
      draft = logic.createNightPlan({
        planId: makeId("server-plan-readback"), operationalDate: plan.form.planDate,
        createdAt: plan.createdAt, createdBy: plan.form.signature, sourceType: "HUMAN_MANUAL_PLAN",
        formTemplateId,
        planStatus: "DRAFT", entries: plan.form.rows.map(function row(value) {
          return {time: value.arrivalTime, arrivalOccurrence: value.fromTrain, departureOccurrence: value.toTrain,
            vehicleId: value.vehicleId, desiredSlot: value.toTrack, taskContext: value.wcWater,
            info: value.info, notes: value.notes};
        }),
      });
      draft.sdeServerPlanId = plan.planId;
      draft.sdeServerRevision = plan.revision;
      draft.sdeClock = plan.form.clock;
      draft.sdeDs = plan.form.ds;
      editMode = false;
      humanReviewActivated = false;
      dirty = false;
      renderDraftRows();
      setStatus("Serverplanen er åpnet read-only. En bildebasert revisjon krever at originalbildet velges på nytt.", "ok");
    } catch (_error) {
      setStatus("Serverplanen kunne ikke leses med verifisert tilgang.", "error");
    }
  }

  function openLegacyPlan(index) {
    const saved = readPlanStore().plans[index];
    if (!saved) return;
    releaseSelectedImage();
    draft = logic.createNightPlan({...saved, planId: makeId("legacy-transfer"), createdAt: new Date().toISOString(), planStatus: "DRAFT"});
    while (draft.entries.length < ROW_COUNT) draft = logic.addNightPlanEntry(draft);
    while (draft.entries.length > ROW_COUNT) draft = logic.removeNightPlanEntry(draft, draft.entries.length - 1);
    draft.sdeLegacyLocal = true;
    draft.sdeDs = "Legacy lokal kopi";
    editMode = true;
    humanReviewActivated = true;
    markDirty();
    renderDraftRows();
    setStatus("Den valgte legacy-kopien er lastet i minnet. Bare et eksplisitt trykk på «Lagre» overfører den.", "warn");
  }

  function validImageFile(file) {
    return logic.validateImageFileDescriptor(file);
  }

  function releaseSelectedImage() {
    ocrGeneration += 1;
    if (imageObjectUrl) root.URL.revokeObjectURL(imageObjectUrl);
    imageObjectUrl = "";
    selectedImage = null;
    selectedImageSource = null;
    selectedImageMimeType = null;
    selectedImageOcrCompleted = false;
    setImportState("NO_IMAGE", null);
    [el("sdeNightImageInput"), el("sdeNightCameraInput")].forEach(function clear(input) {
      if (input) input.value = "";
    });
    const preview = el("sdeNightImagePreview");
    if (preview) {
      preview.removeAttribute("src");
      preview.classList.remove("visible");
    }
    const remove = el("sdeNightRemoveImageBtn");
    if (remove) remove.disabled = true;
    hideCellEvidence();
  }

  function selectImage(file, sourceType) {
    const validation = validImageFile(file);
    if (!validation.ok) {
      setStatus(validation.message, "error");
      return;
    }
    releaseSelectedImage();
    draft = makeManualDraft();
    selectedImage = file;
    selectedImageSource = sourceType;
    selectedImageMimeType = validation.mimeType;
    setImportState("IMAGE_SELECTED", null);
    draft.sdeImportedAt = new Date().toISOString();
    imageObjectUrl = root.URL.createObjectURL(file);
    const preview = el("sdeNightImagePreview");
    if (preview) {
      preview.src = imageObjectUrl;
      preview.classList.add("visible");
    }
    const remove = el("sdeNightRemoveImageBtn");
    if (remove) remove.disabled = false;
    editMode = false;
    humanReviewActivated = false;
    markDirty();
    renderDraftRows();
    setStatus("Bildet er valgt og holdes bare midlertidig i nettleserminnet. Velg «Importer nå» for lokal håndskriftgjenkjenning.", "ok");
  }

  async function fileFingerprint(file) {
    if (!root.crypto || !root.crypto.subtle) return "";
    const digest = await root.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), function toHex(byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function normalizeImportedDate(value, fallbackIsoDate) {
    const raw = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const complete = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    const partial = raw.match(/^(\d{1,2})[./-](\d{1,2})$/);
    const fallbackYear = String(fallbackIsoDate || "").slice(0, 4);
    const match = complete || partial;
    if (!match) return "";
    const year = complete ? complete[3] : fallbackYear;
    const month = Number(match[2]);
    const day = Number(match[1]);
    const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(candidate + "T00:00:00Z");
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : "";
  }

  function applyImportedMetadata(plan) {
    const metadata = plan && plan.ocrMetadata || {};
    const date = normalizeImportedDate(metadata.date, plan.operationalDate);
    if (date) plan.operationalDate = date;
    else if (plan.formTemplateId === "TEMPLATE_B") plan.operationalDate = "";
    plan.createdBy = String(metadata.signature || "").trim();
    plan.sdeClock = String(metadata.clock || "").trim();
    plan.sdeDs = String(metadata.ds || "").trim();
    return plan;
  }

  function loadHtrScript(moduleDefinition) {
    if (root[moduleDefinition.globalName]) return Promise.resolve(root[moduleDefinition.globalName]);
    return new Promise(function load(resolve, reject) {
      const script = document.createElement("script");
      script.src = new URL(moduleDefinition.source, document.baseURI).href;
      script.async = true;
      script.dataset.sdeHtrModule = moduleDefinition.globalName;
      script.addEventListener("load", function loaded() {
        const loadedModule = root[moduleDefinition.globalName];
        if (loadedModule) resolve(loadedModule);
        else reject(new Error("htr_module_global_missing:" + moduleDefinition.globalName));
      }, {once: true});
      script.addEventListener("error", function failed() {
        script.remove();
        reject(new Error("htr_module_load_failed:" + moduleDefinition.globalName));
      }, {once: true});
      document.head.appendChild(script);
    });
  }

  async function ensureHtrModules(onProgress) {
    if (htrLogic && htrRuntime) return {htrLogic, htrRuntime};
    if (!htrModulePromise) {
      htrModulePromise = (async function loadModules() {
        for (const moduleDefinition of HTR_MODULE_SOURCES) {
          let loaded = false;
          let lastError = null;
          for (let attempt = 0; attempt <= 1 && !loaded; attempt += 1) {
            try {
              if (typeof onProgress === "function") onProgress({
                status: "HTR_MODULE_LOAD",
                progress: 0.01,
                module: moduleDefinition.globalName,
                attempt: attempt + 1,
              });
              await loadHtrScript(moduleDefinition);
              loaded = true;
            } catch (error) {
              lastError = error;
            }
          }
          if (!loaded) throw lastError || new Error("htr_module_load_failed");
        }
        htrLogic = root.SdeHandwritingRecognition || null;
        htrRuntime = root.SdeHandwritingRuntime || null;
        if (!htrLogic || !htrRuntime) throw new Error("local_htr_runtime_unavailable");
        return {htrLogic, htrRuntime};
      })().catch(function resetFailedModuleLoad(error) {
        htrModulePromise = null;
        throw error;
      });
    }
    return htrModulePromise;
  }

  async function getOcrAnalyzer(onProgress) {
    if (ocrAnalyzer) return ocrAnalyzer;
    await ensureHtrModules(onProgress);
    if (!htrLogic || !htrRuntime || typeof htrRuntime.createLocalHandwritingAnalyzer !== "function") {
      throw new Error("local_htr_runtime_unavailable");
    }
    if (!htrLogic.supportsLocalRuntime(root)) throw new Error("local_htr_runtime_unavailable");
    ocrAnalyzer = htrRuntime.createLocalHandwritingAnalyzer({
      environment: root,
      workerUrl: new URL("sde_handwriting_worker.js?v=969bbd7fb9d3b169063ea1bc253ab1c514dd8eaea9492be886b60277394b808c", document.baseURI).href,
      maximumDimension: 1800,
    });
    return ocrAnalyzer;
  }

  async function analyzeSelectedImage() {
    const validation = validImageFile(selectedImage);
    if (!validation.ok) {
      setStatus(validation.message, "error");
      return;
    }
    const generation = ++ocrGeneration;
    const analyzeButton = el("sdeNightAnalyzeImageBtn");
    const cancelButton = el("sdeNightCancelOcrBtn");
    if (analyzeButton) analyzeButton.disabled = true;
    if (cancelButton) cancelButton.disabled = false;
    selectedImageOcrCompleted = false;
    setImportState("IMAGE_PREPROCESSING", null);
    setStatus("Bildet klargjøres lokalt før skjemaregistrering og håndskriftgjenkjenning. Ingen bildepiksler sendes til en ekstern tjeneste.", "warn");
    try {
      const analyzer = await getOcrAnalyzer(function onLoaderProgress(message) {
        if (generation !== ocrGeneration) return;
        const target = el("sdeNightOcrProgress");
        if (target) target.textContent = String(message && message.status || "HTR_MODULE_LOAD") + " · 1 %";
      });
      const fingerprintPromise = fileFingerprint(selectedImage);
      const result = await analyzer.analyze(selectedImage, {
        canonicalSlots: logic.VALID_SLOTS,
        vehicleCatalog: knownVehicleIds(),
        trainCatalog: knownTrainIdentifiers(),
      }, function onProgress(message) {
        if (generation !== ocrGeneration) return;
        const progress = Math.round(Number(message && message.progress || 0) * 100);
        const label = String(message && message.status || "HANDWRITING_RECOGNITION_RUNNING");
        setImportState(label, null);
        const target = el("sdeNightOcrProgress");
        if (target) target.textContent = label + " · " + progress + " %";
      });
      if (generation !== ocrGeneration) return;
      const fingerprint = await fingerprintPromise;
      const progressTarget = el("sdeNightOcrProgress");
      const plan = htrRuntime.mapResultToNightPlan(result, {
        logic,
        planId: makeId("image-plan"),
        operationalDate: String(el("sdeNightOperationalDate") && el("sdeNightOperationalDate").value || defaultOperationalDate()),
        createdAt: new Date().toISOString(),
        sourceFingerprint: fingerprint ? "sha256:" + fingerprint : "",
      });
      applyImportedMetadata(plan);
      plan.dataRevision = currentDataRevision();
      draft = plan;
      while (draft.entries.length < ROW_COUNT) draft = logic.addNightPlanEntry(draft);
      while (draft.entries.length > ROW_COUNT) draft = logic.removeNightPlanEntry(draft, draft.entries.length - 1);
      draft.sdeImportedAt = new Date().toISOString();
      selectedImageOcrCompleted = true;
      setImportState(draft.ocrMapping.mappingStatus, draft.ocrMapping);
      editMode = false;
      humanReviewActivated = false;
      markDirty();
      renderDraftRows();
      const report = draft.ocrMapping;
      const summary = `${report.mappingStatus} · ${report.templateId} · 29 rader × ${report.columnCount} kolonner · ${report.mappedCellCount} autoakseptert · ${report.suggestedCellCount || 0} separate forslag · ${report.reviewedCellCount} trenger kontroll · lokal reell HTR/print-ensemble ${result.model.hashVerified ? "hashverifisert" : "ikke verifisert"} · råbildet er ikke lagret`;
      if (progressTarget) progressTarget.textContent = summary;
      if (report.mappingStatus === "FORM_MAPPING_COMPLETE") {
        setStatus("Lokal analyse er fullført og kvalitetsporten er bestått. Kontroller verdiene før lagring.", "warn");
      } else if (report.mappingStatus === "FORM_MAPPING_REQUIRES_REVIEW") {
        const reviewRate = report.cellCount ? report.reviewedCellCount / report.cellCount : 1;
        setStatus(reviewRate > 0.25
          ? "AI-en kunne ikke lese dette skjemaet godt nok. Ingen usikre verdier er fylt inn; bruk celleutsnitt og forslag eller registrer planen manuelt."
          : "Lokal analyse er fullført med et begrenset antall separate forslag. Ingen usikre forslag er fylt inn automatisk.", reviewRate > 0.25 ? "error" : "warn");
      } else if (report.mappingStatus === "RECOGNITION_FAILED") {
        setStatus("Håndskriftgjenkjenningen ga ikke et forsvarlig resultat. Ingen vellykket skjemamapping er registrert.", "error");
      } else {
        setStatus("Skjemamappingen feilet. Resultatet er ikke klassifisert som en vellykket import; velg «Endre innhold» for manuell kontroll.", "error");
      }
    } catch (error) {
      const errorMessageOnly = String((error && error.message) || error || "").trim();
      const errorStack = String((error && error.stack) || "").trim();
      const errorDetail = errorMessageOnly || errorStack;
      if (generation !== ocrGeneration || /(?:ocr|htr)_cancelled/i.test(errorMessageOnly)) {
        setImportState("IMPORT_FAILED", null);
        setStatus("Bildeanalysen ble avbrutt. Ingen plan ble lagret.", "warn");
      } else if (/unsupported_image_type/i.test(errorMessageOnly)) {
        setImportState("IMPORT_FAILED", null);
        setStatus("Ugyldig filtype. Bare JPG og PNG støttes.", "error");
      } else {
        setImportState("IMPORT_FAILED", null);
        setStatus(
          `Lokal bildeanalyse feilet. Ingen data ble lagret; bruk manuell registrering eller prøv et tydeligere bilde.${errorMessageOnly ? ` (${errorMessageOnly})` : ""}`,
          "error",
        );
      }
      if (typeof console !== "undefined" && typeof console.error === "function") {
        console.error("sde_night_planning_ui.analyzeSelectedImage failed:", error);
      }
      const target = el("sdeNightOcrProgress");
      if (target) target.textContent = `IMPORT_FAILED · råbildet er ikke lagret${errorDetail ? ` · ${errorDetail}` : ""}`;
    } finally {
      if (generation === ocrGeneration) {
        if (analyzeButton) analyzeButton.disabled = false;
        if (cancelButton) cancelButton.disabled = true;
      }
    }
  }

  async function cancelOcr() {
    ocrGeneration += 1;
    setImportState("IMPORT_FAILED", null);
    if (ocrAnalyzer && typeof ocrAnalyzer.cancel === "function") {
      try {
        await ocrAnalyzer.cancel();
      } catch (_error) {
      }
    }
    const analyzeButton = el("sdeNightAnalyzeImageBtn");
    const cancelButton = el("sdeNightCancelOcrBtn");
    if (analyzeButton) analyzeButton.disabled = false;
    if (cancelButton) cancelButton.disabled = true;
    setStatus("Bildeanalysen ble avbrutt. Ingen plan ble lagret.", "warn");
  }

  function loadDecisionAssets() {
    if (assetPromise) return assetPromise;
    assetPromise = Promise.all([
      root.fetch("config/sde-night-intelligence.json", {cache: "no-store"}).then(function parse(response) {
        if (!response.ok) throw new Error("config_http_" + response.status);
        return response.json();
      }),
      root.fetch("models/sde/production-model.json", {cache: "no-store"}).then(function parse(response) {
        if (!response.ok) throw new Error("artifact_http_" + response.status);
        return response.json();
      }),
      root.fetch("models/sde/model-registry.json", {cache: "no-store"}).then(function parse(response) {
        if (!response.ok) throw new Error("registry_http_" + response.status);
        return response.json();
      }),
    ]).then(function mapAssets(values) {
      return {config: values[0], artifact: values[1], registry: values[2], available: true};
    }).catch(function safeFallback(error) {
      return {config: null, artifact: null, registry: null, available: false, error: String(error && error.message || error)};
    });
    return assetPromise;
  }

  function plannedExperienceRecords() {
    const records = [];
    readPlanStore().plans.forEach(function eachPlan(plan) {
      if (plan.planStatus !== "CONFIRMED") return;
      (plan.entries || []).forEach(function eachEntry(entry) {
        const vehicle = fieldValue(entry, "vehicleId");
        records.push({
          sourceType: plan.sourceType,
          planStatus: plan.planStatus,
          operationalDate: plan.operationalDate,
          desiredSlot: fieldValue(entry, "desiredSlot"),
          vehicleType: vehicle.split("-")[0],
        });
      });
    });
    return records;
  }

  function minutesFromTime(value) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  }

  function candidateFeatures(entry, actualSlot) {
    const vehicle = fieldValue(entry, "vehicleId");
    const task = fieldValue(entry, "taskContext").toUpperCase();
    const features = {
      startSlot: actualSlot,
      candidateSlot: fieldValue(entry, "desiredSlot"),
      vehicleType: vehicle.split("-")[0],
      workshopNeed: /VERKSTED|REP/.test(task),
      cleaningNeed: /RENHOLD|AGILIA|VASK/.test(task),
      requiredMoveCount: actualSlot === fieldValue(entry, "desiredSlot") ? 0 : 1,
      tursattBound: Boolean(fieldValue(entry, "arrivalOccurrence") || fieldValue(entry, "departureOccurrence")),
      serviceNeed: /VANN|WC|SERVICE/.test(task),
    };
    const departureMinutes = minutesFromTime(fieldValue(entry, "time"));
    if (departureMinutes !== null) features.departureMinutes = departureMinutes;
    return features;
  }

  function currentSlotForVehicle(vehicle) {
    try {
      return String(getSdeCurrentSlotForVehicle(vehicle) || "");
    } catch (_error) {
      return "";
    }
  }

  function buildNeed(entry, actualSlot) {
    const task = fieldValue(entry, "taskContext");
    const departureOccurrence = fieldValue(entry, "departureOccurrence") || fieldValue(entry, "trainNumber");
    const part = String(departureOccurrence).match(/\/([12])$/);
    return {
      vehicle: fieldValue(entry, "vehicleId"),
      arrivalSlot: actualSlot,
      nextDepartureTrain: departureOccurrence,
      nextDepartureTime: fieldValue(entry, "time"),
      nextDeparturePart: part ? part[1] : "",
      serviceRequired: /VANN|WC|SERVICE|VERKSTED|REP/i.test(task),
    };
  }

  function buildAbsoluteGate(entry) {
    const vehicle = fieldValue(entry, "vehicleId");
    const targetSlot = fieldValue(entry, "desiredSlot");
    const actualSlot = currentSlotForVehicle(vehicle);
    if (actualSlot && actualSlot === targetSlot) {
      return {
        ok: true,
        status: "safe",
        passed: ["CANONICAL_ACTUAL_ALREADY_MATCHES", "NO_MOVE_REQUIRED"],
        actualSlot,
        baseAssessment: {status: "candidate", score: 100, reasons: ["Kjøretøyet står allerede i ønsket canonical spor; ingen flytting foreslås."]},
      };
    }
    let safety;
    try {
      safety = evaluateSdeAbsoluteTargetSlotSafety(vehicle, targetSlot, {
        placementRevision: currentDataRevision(),
        toTrain: fieldValue(entry, "departureOccurrence"),
        tilRep: /VERKSTED|REP/i.test(fieldValue(entry, "taskContext")) ? "ja" : "",
      });
    } catch (_error) {
      safety = {status: "unknown", reasonCode: "ABSOLUTE_GATE_RUNTIME_UNAVAILABLE", reason: "Canonical sikkerhetsport kunne ikke leses."};
    }
    if (!safety || !["safe", "warning"].includes(safety.status)) {
      return {
        ok: false,
        reasonCode: safety && safety.reasonCode || "TARGET_STATE_UNKNOWN",
        reason: safety && safety.reason || "Måltilstand er ukjent.",
        safety,
        actualSlot,
      };
    }
    let baseAssessment;
    try {
      baseAssessment = scoreSdeArrivalParkingCandidate(buildNeed(entry, actualSlot), targetSlot);
    } catch (_error) {
      baseAssessment = {status: "rejected", reasons: ["Eksisterende deterministisk kandidatkontroll feilet."]};
    }
    if (baseAssessment.status === "rejected") {
      return {
        ok: false,
        reasonCode: "CURRENT_DETERMINISTIC_RULE_REJECTED",
        reason: (baseAssessment.reasons || []).join(" "),
        safety,
        actualSlot,
        baseAssessment,
      };
    }
    return {
      ok: true,
      status: safety.status,
      passed: ["CANONICAL_OCCUPANCY", "CURRENT_PHYSICAL_RULES", "CURRENT_DETERMINISTIC_CANDIDATE_RULES"],
      warnings: safety.status === "warning" ? safety.reasons || [] : [],
      safety,
      actualSlot,
      baseAssessment,
    };
  }

  function appendInferenceAudit(record) {
    inferenceAuditInMemory.unshift(record);
    if (inferenceAuditInMemory.length > 200) inferenceAuditInMemory.length = 200;
  }

  function scoreText(value, status) {
    if (status === "INSUFFICIENT_DATA") return "Ikke nok data";
    if (value == null) return "Ikke tilgjengelig";
    if (typeof value === "string") {
      if (!value.trim()) return "Ikke tilgjengelig";
    } else if (typeof value !== "number") {
      return "Ikke tilgjengelig";
    }
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? String(Math.round(numericValue * 10) / 10) + "/100" : "Ikke tilgjengelig";
  }

  function analysisItemHtml(analysis, decision, machine, weights) {
    const conflict = decision && decision.status === "REJECTED_BY_ABSOLUTE_GATE";
    const classification = conflict ? "KONFLIKT" : analysis.classification;
    const className = conflict || classification === "KONFLIKT" ? " conflict" : " feasible";
    const gateReason = conflict
      ? String(decision.gate && (decision.gate.reason || decision.gate.reasonCode) || "Avvist av absolutt port")
      : (analysis.reasonCodes || []).join(" · ");
    return [
      "<article class=\"sde-night-analysis-item", className, "\">",
      "<strong>", html(analysis.vehicleId || "Ukjent kjøretøy"), " → ", html(analysis.desiredSlot || "ukjent spor"), " · ", html(classification), "</strong>",
      "<p>Canonical actual: ", html(analysis.canonicalActual || "mangler"), ". ", html(gateReason || "Alle kontrollerte porter er bestått."), "</p>",
      "<div class=\"sde-night-score-grid\">",
      "<div class=\"sde-night-score\"><strong>Operativ/heuristisk</strong><span>", html(scoreText(decision && decision.deterministicScore)), "</span></div>",
      "<div class=\"sde-night-score\"><strong>HumanExperienceScore</strong><span>", html(scoreText(decision && decision.humanExperienceScore)), "</span></div>",
      "<div class=\"sde-night-score\"><strong>MachineLearningScore</strong><span>", html(scoreText(decision && decision.machineLearningScore, machine && machine.status)), "</span></div>",
      "<div class=\"sde-night-score\"><strong>Samlet, rådgivende</strong><span>", html(scoreText(decision && decision.combinedScore)), "</span></div>",
      "</div>",
      decision && decision.explanations
        ? "<p><strong>Forklaring:</strong> " + html([
            decision.explanations.deterministic,
            decision.explanations.humanExperience,
            decision.explanations.machineLearning,
            decision.explanation,
          ].filter(Boolean).join(" ")) + "</p>"
        : "",
      "<p class=\"sde-night-model-meta\">Vekter ", html(weights.version || "ukjent"), ": operativ ",
      html(weights.deterministic), ", erfaring ", html(weights.humanExperience), ", ML ", html(weights.machineLearning),
      ". ML-status ", html(machine && machine.status || "IKKE_KJØRT"), ".</p>",
      "<p class=\"sde-night-model-meta\">Kun beslutningsstøtte. Ingen flytting, reservasjon, godkjenning eller Utført er opprettet.</p>",
      "</article>",
    ].join("");
  }

  async function analyzeDraftAgainstSde() {
    if (!draft) return;
    syncDraftFromEditor();
    const analysisDraft = logic.createNightPlan({
      ...draft,
      planId: draft.planId || makeId("analysis-plan"),
      entries: draft.entries.filter(function populated(entry) {
        return FIELD_NAMES.some(function hasValue(name) { return fieldValue(entry, name); });
      }),
    });
    if (!analysisDraft.entries.length) {
      setStatus("Planen har ingen linjer å analysere.", "error");
      return;
    }
    const host = el("sdeNightAnalysisResults");
    if (host) host.innerHTML = "<div class=\"sde-night-status warn\">Kjører absolutte porter før scoring …</div>";
    const assets = await loadDecisionAssets();
    const weights = assets.config && assets.config.weights || SAFE_FALLBACK_WEIGHTS;
    const modelStatus = el("sdeNightModelStatus");
    if (modelStatus) {
      modelStatus.textContent = assets.available
        ? "Modell " + assets.artifact.modelVersion + " · status " + assets.artifact.status + " · hash " + assets.artifact.artifactHash
        : "ML_DISABLED · modell/config/registry kunne ikke lastes. Safe fallback uten ML-vekt.";
    }
    const gateByEntry = new Map();
    const planAnalysis = logic.analyzeNightPlan(analysisDraft, {
      revision: currentDataRevision(),
      actualSlotForVehicle: currentSlotForVehicle,
      absoluteTargetGate: function absoluteTargetGate(_vehicle, _slot, entry) {
        const gate = buildAbsoluteGate(entry);
        gateByEntry.set(entry.entryId, gate);
        return gate;
      },
    });
    const experienceRecords = plannedExperienceRecords();
    const rendered = [];
    for (const analysis of planAnalysis.entries) {
      const entry = analysisDraft.entries.find(function findEntry(item) { return item.entryId === analysis.entryId; });
      const gate = gateByEntry.get(analysis.entryId) || buildAbsoluteGate(entry);
      const features = candidateFeatures(entry, gate.actualSlot || analysis.canonicalActual);
      let machine = {
        status: "ML_DISABLED",
        score: null,
        influencesCombinedScore: false,
        explanation: "Maskinlæringsvurdering er ikke tilgjengelig.",
      };
      const decision = await logic.evaluateCandidate({
        candidate: {
          vehicleId: analysis.vehicleId,
          slot: analysis.desiredSlot,
          features,
          inputRevision: currentDataRevision(),
        },
        absoluteGate: function gateFirst() { return gate; },
        deterministicScorer: function deterministic() {
          const assessment = gate.baseAssessment || {};
          return {
            score: Number(assessment.score),
            explanation: (assessment.reasons || []).slice(0, 3).join(" "),
          };
        },
        humanScorer: function human() {
          return logic.scoreHumanExperience({
            slot: analysis.desiredSlot,
            vehicleType: String(analysis.vehicleId || "").split("-")[0],
          }, experienceRecords, {now: new Date().toISOString()});
        },
        machineScorer: async function machineScorer() {
          machine = await logic.inferMachineLearning(
            {features},
            assets.artifact,
            {registry: assets.registry, absoluteGatePassed: true}
          );
          return machine;
        },
        weights,
      });
      appendInferenceAudit({
        schemaVersion: "sde-night-inference-audit-v1",
        inferenceId: makeId("inference"),
        inferredAt: new Date().toISOString(),
        modelVersion: machine.modelVersion || assets.artifact && assets.artifact.modelVersion || "",
        featureVersion: assets.artifact && assets.artifact.featureVersion || "",
        inputRevision: currentDataRevision(),
        candidate: {vehicleId: analysis.vehicleId, slot: analysis.desiredSlot},
        machineLearningStatus: machine.status,
        machineLearningScore: machine.score,
        factors: machine.factors || [],
        authority: "ADVISORY_ONLY",
      });
      rendered.push(analysisItemHtml(analysis, decision, machine, weights));
    }
    if (host) host.innerHTML = rendered.join("") || "<div class=\"sde-night-status\">Ingen analyserbare linjer.</div>";
    setStatus("Read-only analyse fullført. Canonical faktisk plassering og absolutte porter ble lest, men ikke endret.", "ok");
  }

  function renderWorkspace() {
    if (!logic) {
      setStatus("Nattplanmodulen kunne ikke lastes. Ingen handling er utført.", "error");
      return;
    }
    if (!draft) draft = makeManualDraft();
    renderDraftRows();
    renderSavedPlans();
    loadServerPlans();
  }

  function resetWorkspace(message) {
    releaseSelectedImage();
    draft = makeManualDraft();
    editMode = true;
    humanReviewActivated = true;
    dirty = false;
    saveAttempt = null;
    renderDraftRows();
    if (message) setStatus(message, "ok");
  }

  function discardUnsavedForLifecycle(message) {
    if (!dirty && !selectedImage) return;
    resetWorkspace("");
    if (message) setStatus(message, "warn");
  }

  function bindEvents() {
    if (initialized) return;
    initialized = true;
    el("sdeNightTakePhotoBtn")?.addEventListener("click", function takePhoto() { el("sdeNightCameraInput")?.click(); });
    el("sdeNightChooseImageBtn")?.addEventListener("click", function chooseImage() { el("sdeNightImageInput")?.click(); });
    el("sdeNightCameraInput")?.addEventListener("change", function onCameraImage(event) {
      selectImage(event.target.files && event.target.files[0] || null, "CAMERA");
    });
    el("sdeNightImageInput")?.addEventListener("change", function onDeviceImage(event) {
      selectImage(event.target.files && event.target.files[0] || null, "DEVICE_FILE");
    });
    el("sdeNightAnalyzeImageBtn") && el("sdeNightAnalyzeImageBtn").addEventListener("click", analyzeSelectedImage);
    el("sdeNightCancelOcrBtn") && el("sdeNightCancelOcrBtn").addEventListener("click", cancelOcr);
    el("sdeNightEditBtn")?.addEventListener("click", enableEditing);
    el("sdeNightRemoveImageBtn") && el("sdeNightRemoveImageBtn").addEventListener("click", function removeImage() {
      resetWorkspace("Råbildet, OCR-resultatet og alle ulagrede endringer er fjernet fra nettleserminnet.");
    });
    el("sdeNightNewManualBtn") && el("sdeNightNewManualBtn").addEventListener("click", function newManual() {
      resetWorkspace("Ny manuell plan med 29 tomme linjer er opprettet i nettleserminnet.");
    });
    el("sdeNightValidateBtn") && el("sdeNightValidateBtn").addEventListener("click", analyzeDraftAgainstSde);
    el("sdeNightSaveBtn")?.addEventListener("click", saveDraft);
    el("sdeNightAcceptSuggestionBtn")?.addEventListener("click", function acceptSuggestion() { applyEvidenceAction("ACCEPT_SUGGESTION"); });
    el("sdeNightEditSuggestionBtn")?.addEventListener("click", function editSuggestion() { applyEvidenceAction("EDIT_VALUE"); });
    el("sdeNightLeaveBlankBtn")?.addEventListener("click", function leaveBlank() { applyEvidenceAction("LEAVE_BLANK"); });
    el("sdeNightOperationalDate") && el("sdeNightOperationalDate").addEventListener("change", function dateChanged() {
      syncDraftDate();
      markDirty();
      setStatus("Driftsdato er endret i utkastet. Lagre eksplisitt for å beholde endringen.", "warn");
    });
    ["sdeNightClock", "sdeNightConfirmedBy", "sdeNightDs"].forEach(function bindHeader(id) {
      el(id)?.addEventListener("input", markDirty);
      el(id)?.addEventListener("focus", function metadataFocus(event) { showCellEvidence(event.target); });
    });
    el("sdeNightOperationalDate")?.addEventListener("focus", function dateFocus(event) { showCellEvidence(event.target); });
    el("sdeNightPlanRows") && el("sdeNightPlanRows").addEventListener("input", function rowInput(event) {
      const field = event.target.closest && event.target.closest("[data-sde-night-field]");
      if (field) {
        updateDraftField(Number(field.dataset.sdeNightIndex), String(field.dataset.sdeNightField || ""), field.value, false);
      }
    });
    el("sdeNightPlanRows") && el("sdeNightPlanRows").addEventListener("focusin", function rowFocus(event) {
      showCellEvidence(event.target);
    });
    el("sdeNightPlanRows") && el("sdeNightPlanRows").addEventListener("change", function rowChanged(event) {
      const field = event.target.closest && event.target.closest("[data-sde-night-field]");
      if (field) {
        updateDraftField(Number(field.dataset.sdeNightIndex), String(field.dataset.sdeNightField || ""), field.value, false);
        setStatus("Linjen er endret. Endringen finnes bare i nettleserminnet frem til «Lagre».", "warn");
      }
    });
    el("sdeNightSavedPlans") && el("sdeNightSavedPlans").addEventListener("click", function savedClicked(event) {
      const serverButton = event.target.closest && event.target.closest("[data-sde-night-open-server]");
      const legacyButton = event.target.closest && event.target.closest("[data-sde-night-open-legacy]");
      if (serverButton) openServerPlan(String(serverButton.dataset.sdeNightOpenServer || ""));
      if (legacyButton) openLegacyPlan(Number(legacyButton.dataset.sdeNightOpenLegacy));
    });
    root.addEventListener("beforeunload", releaseSelectedImage);
    root.addEventListener("pagehide", function pageHidden() { discardUnsavedForLifecycle(""); });
    const panel = el("sdeNattplanErfaring");
    if (panel && typeof MutationObserver === "function") {
      new MutationObserver(function panelChanged() {
        if (panel.hidden || panel.inert || !panel.classList.contains("active")) {
          discardUnsavedForLifecycle("Ulagret bilde, OCR-data og endringer er slettet ved navigering bort.");
        }
      }).observe(panel, {attributes: true, attributeFilter: ["hidden", "inert", "class"]});
    }
    root.setInterval(function expireSession() {
      if (Date.now() - lastInteractionAt < 30 * 60 * 1000) return;
      discardUnsavedForLifecycle("Ulagrede data er slettet fordi arbeidsøkten utløp.");
      lastInteractionAt = Date.now();
    }, 60 * 1000);
  }

  root.renderSdeNightPlanningWorkspace = renderWorkspace;
  root.SdeNightPlanUiTestApi = Object.freeze({
    getUnsavedState: function getUnsavedState() {
      return {
        dirty,
        hasImage: Boolean(selectedImage),
        sourceType: selectedImageSource || (draft.sdeLegacyLocal ? "LEGACY_LOCAL" : "MANUAL"),
        rowCount: draft.entries.length,
        importStatus: importState.status,
        mappingReport: importState.report ? JSON.parse(JSON.stringify(importState.report)) : null,
        visibleForm: draft ? buildServerForm() : null,
        humanReviewActivated,
      };
    },
    readLegacyPlans: function readLegacyPlans() { return readPlanStore().plans; },
  });
  bindEvents();
  renderWorkspace();
})(window);

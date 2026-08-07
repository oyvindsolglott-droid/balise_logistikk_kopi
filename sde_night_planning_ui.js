(function initializeSdeNightPlanningUi(root) {
  "use strict";

  const logic = root.SdeNightIntelligence;
  const PLAN_STORAGE_KEY = "sde_night_plans_v1";
  const INFERENCE_AUDIT_STORAGE_KEY = "sde_night_inference_audit_v1";
  const PLAN_STORE_SCHEMA = "sde-night-plan-store-v1";
  const FIELD_NAMES = [
    "time",
    "arrivalOccurrence",
    "departureOccurrence",
    "vehicleId",
    "desiredSlot",
    "taskContext",
    "notes",
  ];
  const SAFE_FALLBACK_WEIGHTS = Object.freeze({
    version: "sde-night-weights-safe-fallback-v1",
    deterministic: 0.8,
    humanExperience: 0.2,
    machineLearning: 0,
  });

  let initialized = false;
  let draft = null;
  let selectedImage = null;
  let imageObjectUrl = "";
  let ocrAnalyzer = null;
  let ocrGeneration = 0;
  let assetPromise = null;

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
    return String(field && typeof field === "object" ? field.normalizedValue || "" : field || "");
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

  function writePlanStore(store) {
    root.localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify({
      schemaVersion: PLAN_STORE_SCHEMA,
      plans: Array.isArray(store && store.plans) ? store.plans : [],
    }));
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
      entries: [{}],
    });
  }

  function knownVehicleIds() {
    try {
      const catalog = getDropsVehicleCatalog();
      return Object.values(catalog).flat().map(String);
    } catch (_error) {
      return [];
    }
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
    document.querySelectorAll("#sdeNightPlanRows [data-sde-night-confirm]").forEach(function syncConfirmation(input) {
      const entry = draft.entries[Number(input.dataset.sdeNightConfirm)];
      if (entry) entry.confirmationState = input.checked ? "CONFIRMED" : "UNCONFIRMED";
    });
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
    validateDraft();
    const operationalDateInput = el("sdeNightOperationalDate");
    if (operationalDateInput && document.activeElement !== operationalDateInput) {
      operationalDateInput.value = draft.operationalDate || defaultOperationalDate();
    }
    host.innerHTML = (draft.entries || []).map(function renderEntry(entry, index) {
      const warning = validationText(entry);
      const excluded = entry.confirmationState === "EXCLUDED";
      const rowClass = excluded ? " class=\"excluded\"" : warning ? " class=\"invalid\"" : "";
      const confidenceValues = FIELD_NAMES.map(function confidence(name) {
        return Number(entry[name] && entry[name].confidence);
      }).filter(Number.isFinite);
      const minimumConfidence = confidenceValues.length ? Math.min.apply(null, confidenceValues) : null;
      const interpretation = draft.sourceType === "HUMAN_IMPORTED_PLAN"
        ? "Laveste felt-confidence " + Math.round(Number(minimumConfidence || 0) * 100) + "% · " + entry.confirmationState
        : "Manuell input · " + entry.confirmationState;
      const input = function input(name, label) {
        const descriptor = entry[name] || {};
        const original = String(descriptor.rawValue || "");
        return [
          "<input type=\"text\" data-sde-night-index=\"", index,
          "\" data-sde-night-field=\"", html(name),
          "\" value=\"", html(fieldValue(entry, name)),
          "\" aria-label=\"", html(label + " linje " + (index + 1)),
          "\" title=\"", html(original ? "Opprinnelig: " + original : "Manuell verdi"),
          "\">",
        ].join("");
      };
      return [
        "<tr", rowClass, " data-sde-night-row=\"", index, "\">",
        "<td><span>", entry.order || index + 1, "</span><div class=\"sde-night-order-actions\">",
        "<button type=\"button\" data-sde-night-move=\"", index, "\" data-sde-night-direction=\"UP\" aria-label=\"Flytt linje ", index + 1, " opp\"", index === 0 ? " disabled" : "", ">↑</button>",
        "<button type=\"button\" data-sde-night-move=\"", index, "\" data-sde-night-direction=\"DOWN\" aria-label=\"Flytt linje ", index + 1, " ned\"", index === draft.entries.length - 1 ? " disabled" : "", ">↓</button>",
        "</div></td>",
        "<td>", input("time", "Tid"), "</td>",
        "<td>", input("arrivalOccurrence", "Fra tog"), "</td>",
        "<td>", input("departureOccurrence", "Til tog"), "</td>",
        "<td>", input("vehicleId", "Kjøretøy"),
        warning ? "<span class=\"sde-night-field-note\">" + html(warning) + "</span>" : "",
        "</td>",
        "<td>", input("desiredSlot", "Ønsket spor"), "</td>",
        "<td>", input("taskContext", "Oppgave"), "</td>",
        "<td>", input("notes", "Notat"), "</td>",
        "<td><span class=\"sde-night-field-note\">", html(interpretation), "</span></td>",
        "<td class=\"sde-night-confirm-cell\"><input type=\"checkbox\" data-sde-night-confirm=\"", index,
        "\" aria-label=\"Kritiske felt kontrollert for linje ", index + 1, "\"",
        entry.confirmationState === "CONFIRMED" ? " checked" : "",
        excluded ? " disabled" : "",
        "></td>",
        "<td><button type=\"button\" data-sde-night-exclude=\"", index, "\">", excluded ? "Gjenoppta" : "Avvis", "</button> ",
        "<button type=\"button\" data-sde-night-remove=\"", index, "\">Fjern</button></td>",
        "</tr>",
      ].join("");
    }).join("");
  }

  function updateDraftField(index, fieldName, value, shouldRender) {
    if (!draft || !draft.entries[index] || !FIELD_NAMES.includes(fieldName)) return;
    draft = logic.updateNightPlanField(draft, index, fieldName, value);
    if (shouldRender !== false) {
      renderDraftRows();
      setStatus("Linjen er endret. Kontroller kritiske felt på nytt før CONFIRMED.", "warn");
    }
  }

  function addDraftEntry() {
    if (!draft) draft = makeManualDraft();
    draft = logic.addNightPlanEntry(draft);
    draft.entries[draft.entries.length - 1].entryId = makeId("manual-entry");
    renderDraftRows();
    setStatus("Tom linje lagt til. Fyll inn og kontroller kjøretøy og ønsket spor.", "warn");
  }

  function removeDraftEntry(index) {
    if (!draft || !draft.entries[index]) return;
    draft = logic.removeNightPlanEntry(draft, index);
    renderDraftRows();
    setStatus("Linjen er fjernet fra utkastet. Ingen operativ tilstand er endret.", "warn");
  }

  function moveDraftEntry(index, direction) {
    if (!draft) return;
    draft = logic.moveNightPlanEntry(draft, index, direction);
    renderDraftRows();
    setStatus("Rekkefølgen er endret i utkastet. Ingen operativ tilstand er endret.", "warn");
  }

  function toggleDraftEntryExcluded(index) {
    if (!draft || !draft.entries[index]) return;
    const exclude = draft.entries[index].confirmationState !== "EXCLUDED";
    draft = logic.setNightPlanEntryExcluded(draft, index, exclude);
    renderDraftRows();
    setStatus(
      exclude
        ? "Linjen er satt til EXCLUDED og tas ikke med i analyse eller bekreftelseskrav."
        : "Linjen er gjenopptatt som UNCONFIRMED og må kontrolleres på nytt.",
      "warn"
    );
  }

  function collectCorrections(plan) {
    const corrections = [];
    (plan.entries || []).forEach(function eachEntry(entry) {
      FIELD_NAMES.forEach(function eachField(name) {
        const descriptor = entry[name] || {};
        if (!descriptor.humanCorrected && !descriptor.humanAdded) return;
        corrections.push({
          entryId: entry.entryId,
          field: name,
          originalValue: String(descriptor.rawValue || ""),
          correctedValue: String(descriptor.normalizedValue || ""),
          originalConfidence: Number(descriptor.confidence || 0),
          humanAdded: descriptor.humanAdded === true,
        });
      });
    });
    return corrections;
  }

  function averageOriginalConfidence(plan) {
    const values = [];
    (plan.entries || []).forEach(function eachEntry(entry) {
      FIELD_NAMES.forEach(function eachField(name) {
        const value = Number(entry[name] && entry[name].confidence);
        if (Number.isFinite(value)) values.push(value);
      });
    });
    if (!values.length) return null;
    return Math.round(values.reduce((total, value) => total + value, 0) / values.length * 1000) / 1000;
  }

  function criticalFieldsReady(plan) {
    return logic.canConfirmNightPlan(plan);
  }

  function saveDraft(status) {
    if (!logic || !draft) return;
    syncDraftFromEditor();
    validateDraft();
    const confirmedBy = String(el("sdeNightConfirmedBy") && el("sdeNightConfirmedBy").value || "").trim();
    if (status === "CONFIRMED" && !criticalFieldsReady(draft)) {
      setStatus("CONFIRMED krever gyldig vehicleId, gyldig spor og avkrysset menneskelig kontroll på hver linje.", "error");
      return;
    }
    if (status === "CONFIRMED" && !confirmedBy) {
      setStatus("Oppgi rolle eller initialer for den som bekrefter planen.", "error");
      return;
    }
    const now = new Date().toISOString();
    const saved = logic.createNightPlan({
      ...draft,
      planStatus: status,
      createdBy: draft.createdBy || confirmedBy,
      dataRevision: currentDataRevision(),
      audit: {
        confirmedAt: status === "CONFIRMED" ? now : "",
        confirmedBy: status === "CONFIRMED" ? confirmedBy : "",
        originalConfidence: averageOriginalConfidence(draft),
        corrections: collectCorrections(draft),
        savedAt: now,
        rawImagePersisted: false,
        authority: "PLAN_EXPERIENCE_ONLY",
      },
    });
    const store = readPlanStore();
    const index = store.plans.findIndex(function samePlan(plan) { return plan.planId === saved.planId; });
    if (index >= 0) store.plans[index] = saved;
    else store.plans.unshift(saved);
    writePlanStore(store);
    draft = saved;
    releaseSelectedImage();
    renderDraftRows();
    renderSavedPlans();
    setStatus(
      status === "CONFIRMED"
        ? "Planen er lagret som CONFIRMED i separat plan-/erfaringspersistence. Dette er ikke bevis på gjennomføring."
        : "Utkastet er lagret separat som DRAFT. Ingen operativ business-write er utført.",
      "ok"
    );
  }

  function renderSavedPlans() {
    const host = el("sdeNightSavedPlans");
    if (!host) return;
    const plans = readPlanStore().plans;
    if (!plans.length) {
      host.innerHTML = "<div class=\"sde-night-status\">Ingen planer er lagret i denne nettleseren.</div>";
      return;
    }
    host.innerHTML = plans.map(function renderSaved(plan) {
      const audit = plan.audit || {};
      return [
        "<article class=\"sde-night-saved-item\">",
        "<strong>", html(plan.operationalDate || "Ukjent dato"), " · ", html(plan.planStatus || "DRAFT"), "</strong>",
        "<p>", html(String((plan.entries || []).length)), " linje(r) · ", html(plan.sourceType || "ukjent kilde"), "</p>",
        "<p class=\"sde-night-model-meta\">PlanId ", html(plan.planId || ""), " · datarevision ", html(plan.dataRevision || "ukjent"),
        audit.confirmedBy ? " · bekreftet av " + html(audit.confirmedBy) : "",
        audit.confirmedAt ? " · " + html(audit.confirmedAt) : "",
        "</p>",
        "<button type=\"button\" data-sde-night-open=\"", html(plan.planId || ""), "\">Åpne kopi</button>",
        "</article>",
      ].join("");
    }).join("");
  }

  function openSavedPlan(planId) {
    const saved = readPlanStore().plans.find(function findPlan(plan) { return plan.planId === planId; });
    if (!saved) return;
    draft = logic.createNightPlan({
      ...saved,
      planId: makeId("plan-copy"),
      createdAt: new Date().toISOString(),
      planStatus: "DRAFT",
      audit: {
        confirmedAt: "",
        confirmedBy: "",
        originalConfidence: saved.audit && saved.audit.originalConfidence,
        corrections: [],
        copiedFromPlanId: saved.planId,
      },
    });
    const confirmedBy = el("sdeNightConfirmedBy");
    if (confirmedBy) confirmedBy.value = "";
    renderDraftRows();
    setStatus("En kopi av den lagrede planen er åpnet som DRAFT. Originalen er uendret.", "ok");
  }

  function validImageFile(file) {
    return logic.validateImageFileDescriptor(file);
  }

  function releaseSelectedImage() {
    ocrGeneration += 1;
    if (imageObjectUrl) root.URL.revokeObjectURL(imageObjectUrl);
    imageObjectUrl = "";
    selectedImage = null;
    const input = el("sdeNightImageInput");
    if (input) input.value = "";
    const preview = el("sdeNightImagePreview");
    if (preview) {
      preview.removeAttribute("src");
      preview.classList.remove("visible");
    }
    const remove = el("sdeNightRemoveImageBtn");
    if (remove) remove.disabled = true;
  }

  function selectImage(file) {
    releaseSelectedImage();
    const validation = validImageFile(file);
    if (!validation.ok) {
      setStatus(validation.message, "error");
      return;
    }
    selectedImage = file;
    imageObjectUrl = root.URL.createObjectURL(file);
    const preview = el("sdeNightImagePreview");
    if (preview) {
      preview.src = imageObjectUrl;
      preview.classList.add("visible");
    }
    const remove = el("sdeNightRemoveImageBtn");
    if (remove) remove.disabled = false;
    setStatus("Bildet er valgt og holdes bare midlertidig i nettleserminnet.", "ok");
  }

  async function fileFingerprint(file) {
    if (!root.crypto || !root.crypto.subtle) return "";
    const digest = await root.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), function toHex(byte) {
      return byte.toString(16).padStart(2, "0");
    }).join("");
  }

  function getOcrAnalyzer() {
    if (ocrAnalyzer) return ocrAnalyzer;
    if (!root.Tesseract || typeof root.Tesseract.createWorker !== "function") {
      throw new Error("local_ocr_runtime_unavailable");
    }
    ocrAnalyzer = logic.createLocalOcrAnalyzer({
      createWorker: root.Tesseract.createWorker,
      workerPath: new URL("assets/vendor/tesseract/worker.min.js", document.baseURI).href,
      corePath: new URL("assets/vendor/tesseract-core", document.baseURI).href,
      langPath: new URL("assets/vendor/tessdata", document.baseURI).href,
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
    setStatus("Lokal OCR analyserer bildet. Ingen bildepiksler sendes til en ekstern tjeneste.", "warn");
    try {
      const analyzer = getOcrAnalyzer();
      const fingerprintPromise = fileFingerprint(selectedImage);
      const result = await analyzer.analyze(selectedImage, function onProgress(message) {
        if (generation !== ocrGeneration) return;
        const progress = Math.round(Number(message && message.progress || 0) * 100);
        const label = String(message && message.status || "analyserer");
        const target = el("sdeNightOcrProgress");
        if (target) target.textContent = label + " · " + progress + " %";
      });
      if (generation !== ocrGeneration) return;
      const fingerprint = await fingerprintPromise;
      const plan = logic.parseOcrText(result.rawText, {
        planId: makeId("image-plan"),
        operationalDate: String(el("sdeNightOperationalDate") && el("sdeNightOperationalDate").value || defaultOperationalDate()),
        createdAt: new Date().toISOString(),
        createdBy: "",
        sourceFingerprint: fingerprint ? "sha256:" + fingerprint : "",
        ocrConfidence: result.confidence,
      });
      plan.dataRevision = currentDataRevision();
      if (!plan.entries.length) {
        throw new Error("ocr_no_plan_lines");
      }
      draft = plan;
      renderDraftRows();
      setStatus(
        "Bildet er tolket til " + plan.entries.length + " planlinje(r). Kontroller og korriger alle kritiske felt; OCR er aldri truth.",
        "warn"
      );
      const target = el("sdeNightOcrProgress");
      if (target) target.textContent = "OCR ferdig · råbildet er ikke lagret";
    } catch (error) {
      if (generation !== ocrGeneration || /ocr_cancelled/i.test(String(error && error.message || error))) {
        setStatus("Bildeanalysen ble avbrutt. Ingen plan ble lagret.", "warn");
      } else if (/unsupported_image_type/i.test(String(error && error.message || error))) {
        setStatus("Ugyldig filtype. Bare JPG og PNG støttes.", "error");
      } else if (/ocr_no_plan_lines/i.test(String(error && error.message || error))) {
        setStatus("Bildet kunne leses, men ingen sikre planlinjer ble funnet. Prøv et skarpere bilde eller registrer manuelt.", "error");
      } else {
        setStatus("Lokal bildeanalyse feilet. Ingen data ble lagret; bruk manuell registrering eller prøv et tydeligere bilde.", "error");
      }
    } finally {
      if (generation === ocrGeneration) {
        if (analyzeButton) analyzeButton.disabled = false;
        if (cancelButton) cancelButton.disabled = true;
      }
    }
  }

  async function cancelOcr() {
    ocrGeneration += 1;
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
    try {
      const existing = JSON.parse(root.localStorage.getItem(INFERENCE_AUDIT_STORAGE_KEY) || "[]");
      const records = Array.isArray(existing) ? existing : [];
      records.unshift(record);
      root.localStorage.setItem(INFERENCE_AUDIT_STORAGE_KEY, JSON.stringify(records.slice(0, 200)));
    } catch (_error) {
    }
  }

  function scoreText(value) {
    return Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 10) / 10) + "/100" : "Ikke tilgjengelig";
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
      "<div class=\"sde-night-score\"><strong>MachineLearningScore</strong><span>", html(scoreText(decision && decision.machineLearningScore)), "</span></div>",
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
    validateDraft();
    renderDraftRows();
    if (!draft.entries.length) {
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
    const planAnalysis = logic.analyzeNightPlan(draft, {
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
      const entry = draft.entries.find(function findEntry(item) { return item.entryId === analysis.entryId; });
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
  }

  function bindEvents() {
    if (initialized) return;
    initialized = true;
    el("sdeNightImageInput") && el("sdeNightImageInput").addEventListener("change", function onImage(event) {
      selectImage(event.target.files && event.target.files[0] || null);
    });
    el("sdeNightAnalyzeImageBtn") && el("sdeNightAnalyzeImageBtn").addEventListener("click", analyzeSelectedImage);
    el("sdeNightCancelOcrBtn") && el("sdeNightCancelOcrBtn").addEventListener("click", cancelOcr);
    el("sdeNightRemoveImageBtn") && el("sdeNightRemoveImageBtn").addEventListener("click", function removeImage() {
      releaseSelectedImage();
      setStatus("Råbildet er fjernet fra nettleserminnet. Utkastet er beholdt.", "ok");
    });
    el("sdeNightNewManualBtn") && el("sdeNightNewManualBtn").addEventListener("click", function newManual() {
      releaseSelectedImage();
      draft = makeManualDraft();
      const confirmedBy = el("sdeNightConfirmedBy");
      if (confirmedBy) confirmedBy.value = "";
      renderDraftRows();
      setStatus("Ny manuell DRAFT er opprettet i samme canonical nattplanmodell.", "ok");
    });
    el("sdeNightAddEntryBtn") && el("sdeNightAddEntryBtn").addEventListener("click", addDraftEntry);
    el("sdeNightValidateBtn") && el("sdeNightValidateBtn").addEventListener("click", analyzeDraftAgainstSde);
    el("sdeNightSaveDraftBtn") && el("sdeNightSaveDraftBtn").addEventListener("click", function saveAsDraft() { saveDraft("DRAFT"); });
    el("sdeNightConfirmPlanBtn") && el("sdeNightConfirmPlanBtn").addEventListener("click", function confirmPlan() { saveDraft("CONFIRMED"); });
    el("sdeNightOperationalDate") && el("sdeNightOperationalDate").addEventListener("change", function dateChanged() {
      syncDraftDate();
      setStatus("Driftsdato er endret i utkastet. Lagre eksplisitt for å beholde endringen.", "warn");
    });
    el("sdeNightPlanRows") && el("sdeNightPlanRows").addEventListener("input", function rowInput(event) {
      const field = event.target.closest && event.target.closest("[data-sde-night-field]");
      if (field) {
        updateDraftField(Number(field.dataset.sdeNightIndex), String(field.dataset.sdeNightField || ""), field.value, false);
      }
    });
    el("sdeNightPlanRows") && el("sdeNightPlanRows").addEventListener("change", function rowChanged(event) {
      const field = event.target.closest && event.target.closest("[data-sde-night-field]");
      if (field) {
        updateDraftField(Number(field.dataset.sdeNightIndex), String(field.dataset.sdeNightField || ""), field.value, false);
        setStatus("Linjen er endret. Kontroller kritiske felt på nytt før CONFIRMED.", "warn");
        return;
      }
      const confirmation = event.target.closest && event.target.closest("[data-sde-night-confirm]");
      if (confirmation && draft && draft.entries[Number(confirmation.dataset.sdeNightConfirm)]) {
        draft.entries[Number(confirmation.dataset.sdeNightConfirm)].confirmationState = confirmation.checked ? "CONFIRMED" : "UNCONFIRMED";
        setStatus(confirmation.checked ? "Linjen er markert menneskelig kontrollert." : "Menneskelig kontroll er fjernet fra linjen.", "warn");
      }
    });
    el("sdeNightPlanRows") && el("sdeNightPlanRows").addEventListener("click", function rowClicked(event) {
      const confirmation = event.target.closest && event.target.closest("[data-sde-night-confirm]");
      if (confirmation && draft && draft.entries[Number(confirmation.dataset.sdeNightConfirm)]) {
        const entry = draft.entries[Number(confirmation.dataset.sdeNightConfirm)];
        const checked = confirmation.checked === true;
        entry.confirmationState = checked ? "CONFIRMED" : "UNCONFIRMED";
        setStatus(checked ? "Linjen er markert menneskelig kontrollert." : "Menneskelig kontroll er fjernet fra linjen.", "warn");
        return;
      }
      const button = event.target.closest && event.target.closest("[data-sde-night-remove]");
      if (button) removeDraftEntry(Number(button.dataset.sdeNightRemove));
      const excludeButton = event.target.closest && event.target.closest("[data-sde-night-exclude]");
      if (excludeButton) toggleDraftEntryExcluded(Number(excludeButton.dataset.sdeNightExclude));
      const moveButton = event.target.closest && event.target.closest("[data-sde-night-move]");
      if (moveButton) moveDraftEntry(Number(moveButton.dataset.sdeNightMove), String(moveButton.dataset.sdeNightDirection || ""));
    });
    el("sdeNightSavedPlans") && el("sdeNightSavedPlans").addEventListener("click", function savedClicked(event) {
      const button = event.target.closest && event.target.closest("[data-sde-night-open]");
      if (button) openSavedPlan(String(button.dataset.sdeNightOpen || ""));
    });
    root.addEventListener("beforeunload", releaseSelectedImage);
  }

  root.renderSdeNightPlanningWorkspace = renderWorkspace;
  bindEvents();
  renderWorkspace();
})(window);

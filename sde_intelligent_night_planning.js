(function attachSdeNightIntelligence(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SdeNightIntelligence = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildSdeNightIntelligence() {
  "use strict";

  const VALID_SLOTS = Object.freeze([
    "1N", "1S", "2N", "2S", "3N", "3M", "3S", "4N", "4M", "4S",
    "5N", "5M", "5S", "6N", "6S", "6SS", "7N", "7S", "7SS", "8N",
    "8S", "8SS", "9", "10N", "10S", "11N", "11S", "12N", "12S", "VN", "VS",
  ]);
  const VALID_SLOT_SET = new Set(VALID_SLOTS);
  const PLAN_STATUSES = new Set(["DRAFT", "CONFIRMED", "ARCHIVED"]);
  const CONFIRMATION_STATES = new Set(["UNCONFIRMED", "CONFIRMED", "EXCLUDED"]);
  const IMAGE_MIME_TYPES = Object.freeze(["image/jpeg", "image/png"]);
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const FORM_ROW_COUNT = 29;
  const FORM_COLUMN_FIELDS = Object.freeze([
    "arrivalOccurrence", "departureOccurrence", "vehicleId",
    "desiredSlot", "taskContext", "notes",
  ]);
  const FORM_COLUMN_RATIOS = Object.freeze([0.015, 0.14, 0.27, 0.40, 0.52, 0.63, 0.985]);
  const EDITABLE_FIELDS = Object.freeze([
    "time",
    "trainNumber",
    "arrivalOccurrence",
    "departureOccurrence",
    "vehicleId",
    "desiredSlot",
    "taskContext",
    "info",
    "notes",
  ]);
  const FEATURE_ALLOWLIST = Object.freeze([
    "startSlot",
    "candidateSlot",
    "departureMinutes",
    "arrivalMinutes",
    "vehicleType",
    "workshopNeed",
    "cleaningNeed",
    "dispositionCode",
    "faultCount",
    "reservationCount",
    "blockingVehicleCount",
    "requiredMoveCount",
    "tursattBound",
    "departureOrder",
    "serviceNeed",
  ]);
  const FEATURE_ALLOWLIST_SET = new Set(FEATURE_ALLOWLIST);
  const LABEL_ALLOWLIST = Object.freeze([
    "replanOccurred",
    "morningConflict",
    "moveCount",
    "departureBlocked",
    "planCompleted",
  ]);

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, Number(value)));
  }

  function cleanText(value) {
    return String(value == null ? "" : value).trim();
  }

  function normalizeVehicle(value) {
    const match = cleanText(value).toUpperCase().match(/\b(69|70|74|75)[\s-]?(\d{2})\b/);
    return match ? `${match[1]}-${match[2]}` : cleanText(value).toUpperCase().replace(/\s+/g, "");
  }

  function normalizeSlot(value) {
    return cleanText(value).toUpperCase().replace(/\s+/g, "");
  }

  function normalizeTime(value) {
    const match = cleanText(value).match(/\b(\d{1,2})[:.](\d{2})\b/);
    if (!match) return "";
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return "";
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  function normalizeTrain(value) {
    const match = cleanText(value).match(/\b(\d{3,5}(?:\/[12])?)\b/);
    return match ? match[1] : "";
  }

  function normalizeTrainCell(value) {
    return cleanText(value).replace(/[‐‑‒–—]/g, "-").replace(/\s+/g, " ");
  }

  function normalizeTrackCell(value) {
    return cleanText(value)
      .toUpperCase()
      .replace(/[‐‑‒–—]/g, "-")
      .replace(/(?:-|=)+\s*>/g, "→")
      .replace(/\s*→\s*/g, "→")
      .replace(/\s+/g, "");
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  async function sha256Hex(value) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle || typeof TextEncoder !== "function") throw new Error("sha256_unavailable");
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function makeField(input, normalize, defaults) {
    if (input && typeof input === "object" && !Array.isArray(input) && "normalizedValue" in input) {
      const copied = clone(input);
      copied.rawValue = cleanText(copied.rawValue);
      copied.normalizedValue = normalize(copied.normalizedValue);
      copied.confidence = clamp(Number(copied.confidence ?? defaults.confidence), 0, 1);
      copied.sourceRegion = copied.sourceRegion || defaults.sourceRegion;
      copied.validationState = cleanText(copied.validationState || defaults.validationState) || "UNCONFIRMED";
      return copied;
    }
    const rawValue = cleanText(input);
    return {
      rawValue,
      normalizedValue: normalize(rawValue),
      confidence: clamp(Number(defaults.confidence), 0, 1),
      sourceRegion: defaults.sourceRegion,
      validationState: defaults.validationState,
    };
  }

  function normalizeEntry(entry, index, options) {
    const sourceRegion = entry && entry.sourceRegion ? clone(entry.sourceRegion) : {line: index + 1};
    const confidence = Number(entry && entry.confidence != null ? entry.confidence : options.defaultConfidence);
    const validationState = cleanText(entry && entry.validationState) || "UNCONFIRMED";
    const defaults = {sourceRegion, confidence, validationState};
    const confirmationState = CONFIRMATION_STATES.has(cleanText(entry && entry.confirmationState))
      ? cleanText(entry.confirmationState)
      : "UNCONFIRMED";
    return {
      entryId: cleanText(entry && entry.entryId) || `${options.planId}-entry-${index + 1}`,
      vehicleId: makeField(entry && entry.vehicleId, normalizeVehicle, defaults),
      desiredSlot: makeField(entry && entry.desiredSlot, normalizeTrackCell, defaults),
      trainNumber: makeField(entry && entry.trainNumber, normalizeTrain, defaults),
      arrivalOccurrence: makeField(entry && entry.arrivalOccurrence, normalizeTrainCell, defaults),
      departureOccurrence: makeField(entry && entry.departureOccurrence, normalizeTrainCell, defaults),
      taskContext: makeField(entry && entry.taskContext, cleanText, defaults),
      info: makeField(entry && entry.info, cleanText, defaults),
      notes: makeField(entry && entry.notes, cleanText, defaults),
      time: makeField(entry && entry.time, normalizeTime, defaults),
      order: Number.isFinite(Number(entry && entry.order)) ? Number(entry.order) : index + 1,
      confirmationState,
      validationWarnings: Array.isArray(entry && entry.validationWarnings) ? [...entry.validationWarnings] : [],
    };
  }

  function createNightPlan(input) {
    const source = input && typeof input === "object" ? input : {};
    const planId = cleanText(source.planId);
    if (!planId) throw new TypeError("planId is required");
    const operationalDate = cleanText(source.operationalDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationalDate)) throw new TypeError("operationalDate must use YYYY-MM-DD");
    const createdAt = cleanText(source.createdAt);
    if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new TypeError("createdAt must be an ISO timestamp");
    const planStatus = PLAN_STATUSES.has(cleanText(source.planStatus)) ? cleanText(source.planStatus) : "DRAFT";
    const sourceType = cleanText(source.sourceType) || "HUMAN_MANUAL_PLAN";
    const entries = Array.isArray(source.entries) ? source.entries : [];
    return {
      schemaVersion: "sde-night-plan-v1",
      planId,
      operationalDate,
      createdAt,
      createdBy: cleanText(source.createdBy),
      sourceType,
      formTemplateId: ["TEMPLATE_A", "TEMPLATE_B"].includes(cleanText(source.formTemplateId)) ? cleanText(source.formTemplateId) : "TEMPLATE_A",
      sourceFingerprint: cleanText(source.sourceFingerprint),
      planStatus,
      dataRevision: cleanText(source.dataRevision),
      ocrMetadata: source.ocrMetadata && typeof source.ocrMetadata === "object" ? clone(source.ocrMetadata) : null,
      ocrMapping: source.ocrMapping && typeof source.ocrMapping === "object" ? clone(source.ocrMapping) : null,
      audit: source.audit && typeof source.audit === "object" ? clone(source.audit) : {
        confirmedAt: "",
        confirmedBy: "",
        originalConfidence: null,
        corrections: [],
      },
      entries: entries.map((entry, index) => normalizeEntry(entry || {}, index, {
        planId,
        defaultConfidence: sourceType === "HUMAN_MANUAL_PLAN" ? 1 : 0.5,
      })),
    };
  }

  function extractLabelledTrain(line, label) {
    const expression = new RegExp(`\\b${label}\\s*(?:tog)?\\s*[:#-]?\\s*(\\d{3,5}(?:\\/[12])?)\\b`, "i");
    const match = String(line).match(expression);
    return match ? match[1] : "";
  }

  function extractSlot(line) {
    const tokens = String(line).toUpperCase().match(/\b(?:1[0-2](?:SS|[NSM])?|[1-9](?:SS|[NSM])?|VN|VS)\b/g) || [];
    return tokens.map(normalizeSlot).find(token => VALID_SLOT_SET.has(token)) || "";
  }

  function extractTaskContext(line) {
    const tasks = [];
    if (/\b(?:wc|vann|fyll|tøm)\b/i.test(line)) tasks.push("VANN_WC");
    if (/\b(?:rep|verksted|reparasjon)\b/i.test(line)) tasks.push("VERKSTED");
    if (/\b(?:renhold|agilia|vask)\b/i.test(line)) tasks.push("RENHOLD");
    if (/\b(?:drei|dreies|turner)\b/i.test(line)) tasks.push("DREIING");
    return tasks.join("+");
  }

  function ocrField(rawValue, normalizedValue, confidence, lineNumber) {
    return {
      rawValue: cleanText(rawValue),
      normalizedValue,
      confidence: clamp(confidence, 0, 1),
      sourceRegion: {line: lineNumber},
      validationState: "UNCONFIRMED",
    };
  }

  function parseOcrText(rawText, options) {
    const source = options && typeof options === "object" ? options : {};
    const baseConfidence = clamp(Number(source.ocrConfidence ?? 0.72), 0, 1);
    const lines = String(rawText || "").replace(/\r\n?/g, "\n").split("\n");
    const entries = [];
    lines.forEach((rawLine, index) => {
      const line = cleanText(rawLine);
      if (!line) return;
      const vehicleMatch = line.toUpperCase().match(/\b(69|70|74|75)[\s-]?(\d{2})\b/);
      const vehicle = vehicleMatch ? `${vehicleMatch[1]}-${vehicleMatch[2]}` : "";
      const arrival = extractLabelledTrain(line, "fra");
      const departure = extractLabelledTrain(line, "til");
      const fallbackTrains = line.match(/\b\d{3,5}(?:\/[12])?\b/g) || [];
      const trainNumber = departure || arrival || fallbackTrains[0] || "";
      const desiredSlot = extractSlot(line);
      const time = normalizeTime(line);
      const taskContext = extractTaskContext(line);
      if (!vehicle && !desiredSlot && !time && !arrival && !departure && !taskContext) return;
      const populated = [vehicle, desiredSlot, time, trainNumber].filter(Boolean).length;
      const confidence = clamp(baseConfidence * (0.65 + populated * 0.0875), 0.1, 0.99);
      const lineNumber = index + 1;
      entries.push({
        vehicleId: ocrField(vehicleMatch ? vehicleMatch[0] : "", vehicle, confidence, lineNumber),
        desiredSlot: ocrField(desiredSlot, desiredSlot, confidence, lineNumber),
        trainNumber: ocrField(trainNumber, trainNumber, confidence, lineNumber),
        arrivalOccurrence: ocrField(arrival, arrival, confidence, lineNumber),
        departureOccurrence: ocrField(departure, departure, confidence, lineNumber),
        taskContext: ocrField(taskContext, taskContext, confidence, lineNumber),
        notes: ocrField("", "", confidence, lineNumber),
        time: ocrField(time, time, confidence, lineNumber),
        confirmationState: "UNCONFIRMED",
        confidence,
        sourceRegion: {line: lineNumber},
      });
    });
    return createNightPlan({
      planId: source.planId,
      operationalDate: source.operationalDate,
      createdAt: source.createdAt,
      createdBy: source.createdBy,
      sourceType: "HUMAN_IMPORTED_PLAN",
      sourceFingerprint: source.sourceFingerprint,
      planStatus: "DRAFT",
      entries,
    });
  }

  function normalizeOcrConfidence(value) {
    const numeric = Number(value);
    return clamp(Number.isFinite(numeric) && numeric > 1 ? numeric / 100 : numeric || 0, 0, 1);
  }

  function normalizeOcrToken(token, index) {
    const value = token && typeof token === "object" ? token : {};
    const text = cleanText(value.text);
    const sourceBbox = value.bbox && typeof value.bbox === "object" ? value.bbox : {};
    const bbox = {
      x0: Number(sourceBbox.x0), y0: Number(sourceBbox.y0),
      x1: Number(sourceBbox.x1), y1: Number(sourceBbox.y1),
    };
    const hasGeometry = [bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)
      && bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0;
    return {
      index,
      text,
      confidence: normalizeOcrConfidence(value.confidence),
      bbox: hasGeometry ? bbox : null,
      lineIndex: Number.isFinite(Number(value.lineIndex)) ? Number(value.lineIndex) : null,
    };
  }

  function flattenOcrBlocks(blocks) {
    const tokens = [];
    let lineIndex = 0;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      for (const paragraph of Array.isArray(block && block.paragraphs) ? block.paragraphs : []) {
        for (const line of Array.isArray(paragraph && paragraph.lines) ? paragraph.lines : []) {
          const words = Array.isArray(line && line.words) ? line.words : [];
          if (words.length) {
            for (const word of words) tokens.push({...word, lineIndex});
          } else if (cleanText(line && line.text)) {
            tokens.push({text: line.text, confidence: line.confidence, bbox: line.bbox, lineIndex});
          }
          lineIndex += 1;
        }
      }
    }
    return {tokens, lineCount: lineIndex};
  }

  function normalizeHeaderText(value) {
    return cleanText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
  }

  function headerKind(value) {
    const normalized = normalizeHeaderText(value);
    if (/^FRATOG$/.test(normalized)) return "fromTrain";
    if (/^TILTOG$/.test(normalized)) return "toTrain";
    if (/^(?:SETT?NR|SETTNUMMER)$/.test(normalized)) return "vehicleId";
    if (/^TILSPOR$/.test(normalized)) return "toTrack";
    if (/^(?:WC|WCVANN|VANN)$/.test(normalized)) return "wcWater";
    if (/^MERKNAD$/.test(normalized)) return "notes";
    return "";
  }

  function verticallyRelated(left, right, imageHeight) {
    if (left.lineIndex != null && right.lineIndex != null && left.lineIndex === right.lineIndex) return true;
    if (!left.bbox || !right.bbox) return false;
    const leftCenter = (left.bbox.y0 + left.bbox.y1) / 2;
    const rightCenter = (right.bbox.y0 + right.bbox.y1) / 2;
    return Math.abs(leftCenter - rightCenter) <= Math.max(10, imageHeight * 0.012);
  }

  function detectFormHeaders(tokens, dataTop, imageHeight) {
    const candidates = [];
    const headerTokens = tokens.filter(token => token.bbox && (token.bbox.y0 + token.bbox.y1) / 2 < dataTop);
    for (let start = 0; start < headerTokens.length; start += 1) {
      for (let length = 1; length <= 3 && start + length <= headerTokens.length; length += 1) {
        const slice = headerTokens.slice(start, start + length);
        const sorted = [...slice].sort((left, right) => left.bbox.x0 - right.bbox.x0);
        if (sorted.some((token, index) => index > 0 && !verticallyRelated(sorted[index - 1], token, imageHeight))) continue;
        const kind = headerKind(sorted.map(token => token.text).join(""));
        if (!kind) continue;
        candidates.push({
          kind,
          indexes: sorted.map(token => token.index),
          confidence: sorted.reduce((sum, token) => sum + token.confidence, 0) / sorted.length,
        });
      }
    }
    const detected = new Map();
    for (const candidate of candidates.sort((left, right) => right.confidence - left.confidence || right.indexes.length - left.indexes.length)) {
      if (!detected.has(candidate.kind)) detected.set(candidate.kind, candidate);
    }
    return detected;
  }

  function validTableGeometry(source, imageWidth, imageHeight) {
    const candidate = source && typeof source === "object" ? source : {};
    const boundaries = Array.isArray(candidate.columnBoundaries) ? candidate.columnBoundaries.map(Number) : [];
    const validBoundaries = boundaries.length === 7 && boundaries.every(Number.isFinite)
      && boundaries.every((value, index) => index === 0 || value > boundaries[index - 1]);
    const dataTop = Number(candidate.dataTop);
    const dataBottom = Number(candidate.dataBottom);
    if (validBoundaries && Number.isFinite(dataTop) && Number.isFinite(dataBottom) && dataBottom > dataTop) {
      return {
        left: boundaries[0], right: boundaries[6], dataTop, dataBottom,
        columnBoundaries: boundaries,
        source: cleanText(candidate.source) || "DETECTED_TABLE_GEOMETRY",
      };
    }
    return {
      left: imageWidth * FORM_COLUMN_RATIOS[0],
      right: imageWidth * FORM_COLUMN_RATIOS[6],
      dataTop: imageHeight * 0.19,
      dataBottom: imageHeight * 0.975,
      columnBoundaries: FORM_COLUMN_RATIOS.map(ratio => imageWidth * ratio),
      source: "KNOWN_FORM_LAYOUT_FALLBACK",
    };
  }

  function metadataValue(tokens, label, nextLabel, excludedIndexes, imageHeight) {
    if (!label || !label.bbox) return "";
    const centerY = (label.bbox.y0 + label.bbox.y1) / 2;
    const upperX = nextLabel && nextLabel.bbox ? nextLabel.bbox.x0 : Number.POSITIVE_INFINITY;
    const candidates = tokens.filter(token => token.bbox && !excludedIndexes.has(token.index)
      && token.bbox.x0 >= label.bbox.x1 && token.bbox.x0 < upperX
      && Math.abs(((token.bbox.y0 + token.bbox.y1) / 2) - centerY) <= Math.max(12, imageHeight * 0.025));
    for (const token of candidates) excludedIndexes.add(token.index);
    return candidates.sort((left, right) => left.bbox.x0 - right.bbox.x0).map(token => token.text).join(" ").trim();
  }

  function mappingField(value, confidence, sourceRegion) {
    return {
      rawValue: cleanText(value),
      normalizedValue: cleanText(value),
      confidence: normalizeOcrConfidence(confidence),
      sourceRegion: clone(sourceRegion),
      validationState: confidence >= 0.85 ? "MAPPED" : "REVIEW_REQUIRED",
    };
  }

  function mapOcrResultToNightPlan(ocrResult, options) {
    const result = ocrResult && typeof ocrResult === "object" ? ocrResult : {};
    const source = options && typeof options === "object" ? options : {};
    const suppliedTokens = Array.isArray(result.tokens) ? result.tokens : [];
    const rawTokens = suppliedTokens.length
      ? suppliedTokens
      : cleanText(result.rawText).split(/\s+/).filter(Boolean).map(text => ({text, confidence: result.confidence}));
    const tokens = rawTokens.map(normalizeOcrToken).filter(token => token.text);
    const geometryTokens = tokens.filter(token => token.bbox);
    const derivedWidth = geometryTokens.reduce((maximum, token) => Math.max(maximum, token.bbox.x1), 0);
    const derivedHeight = geometryTokens.reduce((maximum, token) => Math.max(maximum, token.bbox.y1), 0);
    const imageWidth = Math.max(1, Number(result.imageWidth) || derivedWidth || 1);
    const imageHeight = Math.max(1, Number(result.imageHeight) || derivedHeight || 1);
    const geometry = validTableGeometry(result.tableGeometry, imageWidth, imageHeight);
    const headers = detectFormHeaders(tokens, geometry.dataTop, imageHeight);
    const excludedIndexes = new Set();
    for (const candidate of headers.values()) for (const index of candidate.indexes) excludedIndexes.add(index);

    const metadataLabels = {};
    for (const token of tokens.filter(item => item.bbox && (item.bbox.y0 + item.bbox.y1) / 2 < geometry.dataTop)) {
      const normalized = normalizeHeaderText(token.text);
      if (normalized === "DATO") metadataLabels.date = token;
      if (normalized === "SIGNATUR") metadataLabels.signature = token;
      if (normalized === "DS") metadataLabels.ds = token;
    }
    for (const token of Object.values(metadataLabels)) if (token) excludedIndexes.add(token.index);
    const ocrMetadata = {
      date: metadataValue(tokens, metadataLabels.date, metadataLabels.signature, excludedIndexes, imageHeight),
      signature: metadataValue(tokens, metadataLabels.signature, metadataLabels.ds, excludedIndexes, imageHeight),
      ds: metadataValue(tokens, metadataLabels.ds, null, excludedIndexes, imageHeight),
    };

    const cellTokens = new Map();
    const discardedReasonCounts = {};
    const discarded = [];
    function discard(token, reason) {
      discarded.push({tokenIndex: token.index, reason});
      discardedReasonCounts[reason] = Number(discardedReasonCounts[reason] || 0) + 1;
    }
    for (const token of tokens) {
      if (excludedIndexes.has(token.index)) continue;
      const normalized = normalizeHeaderText(token.text);
      if (/^(?:TOGPLASSERINGSKIEN|TOGPLASSERING|SKIEN)$/.test(normalized)) continue;
      if (!token.bbox) { discard(token, "MISSING_GEOMETRY"); continue; }
      const centerX = (token.bbox.x0 + token.bbox.x1) / 2;
      const centerY = (token.bbox.y0 + token.bbox.y1) / 2;
      if (centerX < geometry.left || centerX >= geometry.right || centerY < geometry.dataTop || centerY >= geometry.dataBottom) {
        discard(token, "OUTSIDE_FORM");
        continue;
      }
      let column = -1;
      for (let index = 0; index < 6; index += 1) {
        if (centerX >= geometry.columnBoundaries[index] && centerX < geometry.columnBoundaries[index + 1]) {
          column = index;
          break;
        }
      }
      const row = Math.floor(((centerY - geometry.dataTop) / (geometry.dataBottom - geometry.dataTop)) * FORM_ROW_COUNT);
      if (column < 0 || row < 0 || row >= FORM_ROW_COUNT) { discard(token, "OUTSIDE_FORM"); continue; }
      const minimumConfidence = column === 5 ? 0.35 : 0.45;
      if (token.confidence < minimumConfidence) { discard(token, "LOW_CONFIDENCE"); continue; }
      const key = `${row}:${column}`;
      if (!cellTokens.has(key)) cellTokens.set(key, []);
      cellTokens.get(key).push(token);
    }

    const entries = Array.from({length: FORM_ROW_COUNT}, () => ({}));
    const mappedRows = new Set();
    let mappedCellCount = 0;
    for (const [key, values] of cellTokens.entries()) {
      const [row, column] = key.split(":").map(Number);
      const sorted = values.sort((left, right) => left.bbox.x0 - right.bbox.x0);
      const text = sorted.map(token => token.text).join(" ").trim();
      if (!text) continue;
      const confidence = sorted.reduce((sum, token) => sum + token.confidence, 0) / sorted.length;
      entries[row][FORM_COLUMN_FIELDS[column]] = mappingField(text, confidence, {
        row: row + 1,
        column: column + 1,
        tokenIndexes: sorted.map(token => token.index),
      });
      mappedRows.add(row);
      mappedCellCount += 1;
    }

    const detectedHeaderCount = headers.size;
    const detectedRowCount = mappedRows.size;
    const ocrTokenCount = tokens.length;
    const unmappedTokenCount = discarded.length;
    const meanMappedConfidence = [...cellTokens.values()].flat().reduce((sum, token) => sum + token.confidence, 0)
      / Math.max(1, [...cellTokens.values()].flat().length);
    const mappingRatio = mappedCellCount / Math.max(1, mappedCellCount + unmappedTokenCount);
    const mappingConfidence = clamp(
      (detectedHeaderCount / 6) * 0.35
      + mappingRatio * 0.25
      + meanMappedConfidence * 0.2
      + Math.min(1, detectedRowCount / 3) * 0.2,
      0,
      1,
    );
    let mappingStatus = "FORM_MAPPING_REQUIRES_REVIEW";
    if (ocrTokenCount === 0) mappingStatus = "OCR_FAILED";
    else if (mappedCellCount === 0) mappingStatus = "MAPPING_FAILED";
    else if (ocrTokenCount >= 8 && mappedCellCount <= 1) mappingStatus = "MAPPING_FAILED";
    else if (detectedHeaderCount === 6 && mappedCellCount >= 2 && mappingRatio >= 0.45) mappingStatus = "FORM_MAPPING_COMPLETE";
    else if (detectedHeaderCount < 3) mappingStatus = "FORM_MAPPING_REQUIRES_REVIEW";

    const ocrMapping = {
      schemaVersion: "sde-night-form-mapping-report-v1",
      ocrTokenCount,
      recognizedLineCount: Number(result.lineCount) || new Set(tokens.map(token => token.lineIndex).filter(Number.isFinite)).size,
      detectedHeaderCount,
      detectedRowCount,
      mappedCellCount,
      unmappedTokenCount,
      mappingConfidence: Number(mappingConfidence.toFixed(4)),
      mappingStatus,
      discardedReasonCounts,
      geometrySource: geometry.source,
      requiresHumanReview: mappingStatus !== "FORM_MAPPING_COMPLETE" || meanMappedConfidence < 0.85,
    };
    return createNightPlan({
      planId: source.planId,
      operationalDate: source.operationalDate,
      createdAt: source.createdAt,
      createdBy: source.createdBy,
      sourceType: "HUMAN_IMPORTED_PLAN",
      sourceFingerprint: source.sourceFingerprint,
      planStatus: "DRAFT",
      ocrMetadata,
      ocrMapping,
      entries,
    });
  }

  function valueOf(field) {
    if (field && typeof field === "object" && "normalizedValue" in field) return field.normalizedValue;
    return field;
  }

  function validateImageFileDescriptor(file, options) {
    const maximumBytes = Number(options && options.maximumBytes || MAX_IMAGE_BYTES);
    if (!file) {
      return {ok: false, reasonCode: "MISSING_IMAGE", message: "Velg et JPG- eller PNG-bilde først."};
    }
    const name = cleanText(file.name).toLowerCase();
    const mimeType = cleanText(file.type).toLowerCase();
    const extensionAllowed = /\.(?:jpe?g|png)$/.test(name);
    const mimeAllowed = IMAGE_MIME_TYPES.includes(mimeType);
    if (!extensionAllowed || (mimeType && !mimeAllowed)) {
      return {ok: false, reasonCode: "UNSUPPORTED_IMAGE_TYPE", message: "Ugyldig filtype. Bare JPG og PNG støttes."};
    }
    const size = Number(file.size);
    if (!Number.isFinite(size) || size <= 0) {
      return {ok: false, reasonCode: "EMPTY_IMAGE", message: "Bildet er tomt eller kunne ikke leses."};
    }
    if (size > maximumBytes) {
      return {ok: false, reasonCode: "IMAGE_TOO_LARGE", message: "Bildet er større enn 8 MB. Velg et mindre bilde."};
    }
    return {ok: true, reasonCode: "IMAGE_ACCEPTED", mimeType: mimeType || (/\.png$/.test(name) ? "image/png" : "image/jpeg")};
  }

  function updateNightPlanField(plan, entryIndex, fieldName, value) {
    if (!plan || !Array.isArray(plan.entries)) throw new TypeError("canonical night plan is required");
    if (!EDITABLE_FIELDS.includes(cleanText(fieldName))) throw new TypeError("unsupported night plan field");
    const next = clone(plan);
    const entry = next.entries[Number(entryIndex)];
    if (!entry) throw new RangeError("night plan entry does not exist");
    const normalizers = {
      time: normalizeTime,
      trainNumber: normalizeTrain,
      arrivalOccurrence: normalizeTrainCell,
      departureOccurrence: normalizeTrainCell,
      vehicleId: normalizeVehicle,
      desiredSlot: normalizeTrackCell,
      taskContext: cleanText,
      info: cleanText,
      notes: cleanText,
    };
    const previous = entry[fieldName] && typeof entry[fieldName] === "object"
      ? entry[fieldName]
      : {rawValue: cleanText(entry[fieldName]), confidence: 1, sourceRegion: null};
    entry[fieldName] = {
      ...previous,
      rawValue: cleanText(previous.rawValue),
      normalizedValue: normalizers[fieldName](value),
      validationState: "HUMAN_CONFIRMED",
      humanCorrected: true,
    };
    entry.confirmationState = "UNCONFIRMED";
    return next;
  }

  function addNightPlanEntry(plan, entryInput) {
    if (!plan || !Array.isArray(plan.entries)) throw new TypeError("canonical night plan is required");
    const next = clone(plan);
    const index = next.entries.length;
    const entry = normalizeEntry(entryInput || {}, index, {
      planId: next.planId,
      defaultConfidence: next.sourceType === "HUMAN_MANUAL_PLAN" ? 1 : 0.5,
    });
    EDITABLE_FIELDS.forEach(name => {
      entry[name].humanAdded = true;
    });
    next.entries.push(entry);
    return next;
  }

  function removeNightPlanEntry(plan, entryIndex) {
    if (!plan || !Array.isArray(plan.entries)) throw new TypeError("canonical night plan is required");
    const next = clone(plan);
    const index = Number(entryIndex);
    if (!Number.isInteger(index) || index < 0 || index >= next.entries.length) {
      throw new RangeError("night plan entry does not exist");
    }
    next.entries.splice(index, 1);
    return next;
  }

  function moveNightPlanEntry(plan, entryIndex, direction) {
    if (!plan || !Array.isArray(plan.entries)) throw new TypeError("canonical night plan is required");
    const next = clone(plan);
    const from = Number(entryIndex);
    const delta = cleanText(direction).toUpperCase() === "UP" ? -1 : cleanText(direction).toUpperCase() === "DOWN" ? 1 : 0;
    const to = from + delta;
    if (!Number.isInteger(from) || !delta || from < 0 || from >= next.entries.length || to < 0 || to >= next.entries.length) {
      return next;
    }
    const [entry] = next.entries.splice(from, 1);
    next.entries.splice(to, 0, entry);
    next.entries.forEach((item, index) => {
      item.order = index + 1;
    });
    return next;
  }

  function setNightPlanEntryExcluded(plan, entryIndex, excluded) {
    if (!plan || !Array.isArray(plan.entries)) throw new TypeError("canonical night plan is required");
    const next = clone(plan);
    const entry = next.entries[Number(entryIndex)];
    if (!entry) throw new RangeError("night plan entry does not exist");
    entry.confirmationState = excluded === false ? "UNCONFIRMED" : "EXCLUDED";
    return next;
  }

  function canConfirmNightPlan(plan) {
    const activeEntries = plan && Array.isArray(plan.entries)
      ? plan.entries.filter(entry => entry.confirmationState !== "EXCLUDED")
      : [];
    return Boolean(
      activeEntries.length
      && activeEntries.every(entry => (
        entry.vehicleId && entry.vehicleId.validationState === "VALID"
        && entry.desiredSlot && entry.desiredSlot.validationState === "VALID"
        && entry.confirmationState === "CONFIRMED"
      ))
    );
  }

  function validateNightPlan(plan, context) {
    const knownVehicles = new Set((context && context.knownVehicleIds || []).map(normalizeVehicle));
    const validSlots = new Set((context && context.validSlots || VALID_SLOTS).map(normalizeSlot));
    const result = clone(plan);
    result.entries = (result.entries || []).map(entry => {
      const next = clone(entry);
      if (next.confirmationState === "EXCLUDED") {
        next.validationWarnings = [];
        next.vehicleId.validationState = "EXCLUDED";
        next.desiredSlot.validationState = "EXCLUDED";
        return next;
      }
      const warnings = [];
      const vehicle = normalizeVehicle(valueOf(next.vehicleId));
      const slot = normalizeSlot(valueOf(next.desiredSlot));
      if (!vehicle) warnings.push("MISSING_VEHICLE");
      else if (knownVehicles.size && !knownVehicles.has(vehicle)) warnings.push("UNKNOWN_VEHICLE");
      if (!slot) warnings.push("MISSING_SLOT");
      else if (!validSlots.has(slot)) warnings.push("INVALID_SLOT");
      next.vehicleId.validationState = warnings.includes("UNKNOWN_VEHICLE") || warnings.includes("MISSING_VEHICLE") ? "INVALID" : "VALID";
      next.desiredSlot.validationState = warnings.includes("INVALID_SLOT") || warnings.includes("MISSING_SLOT") ? "INVALID" : "VALID";
      next.validationWarnings = warnings;
      return next;
    });
    const activeEntries = result.entries.filter(entry => entry.confirmationState !== "EXCLUDED");
    result.valid = activeEntries.length > 0 && activeEntries.every(entry => entry.validationWarnings.length === 0);
    result.createdVehicleIds = [];
    return result;
  }

  function analyzeNightPlan(plan, context) {
    if (!context || typeof context.absoluteTargetGate !== "function") throw new TypeError("absoluteTargetGate is required");
    const entries = (plan.entries || []).filter(entry => entry.confirmationState !== "EXCLUDED").map(entry => {
      const vehicleId = normalizeVehicle(valueOf(entry.vehicleId));
      const desiredSlot = normalizeSlot(valueOf(entry.desiredSlot));
      const canonicalActual = cleanText(typeof context.actualSlotForVehicle === "function" ? context.actualSlotForVehicle(vehicleId) : "");
      const gate = context.absoluteTargetGate(vehicleId, desiredSlot, clone(entry)) || {ok: false, reasonCode: "TARGET_STATE_UNKNOWN"};
      const reasonCodes = [];
      let classification;
      if (!vehicleId || !desiredSlot || !canonicalActual) {
        classification = "MANGLENDE DATA";
        if (!vehicleId) reasonCodes.push("MISSING_VEHICLE");
        if (!desiredSlot) reasonCodes.push("MISSING_SLOT");
        if (!canonicalActual) reasonCodes.push("MISSING_CANONICAL_ACTUAL");
      } else if (gate.ok !== true) {
        classification = "KONFLIKT";
        reasonCodes.push(cleanText(gate.reasonCode) || "ABSOLUTE_GATE_REJECTED");
      } else if ((gate.prerequisites || []).length || (gate.warnings || []).length) {
        classification = "GJENNOMFØRBAR MED FORUTSETNINGER";
        reasonCodes.push(...(gate.prerequisites || []), ...(gate.warnings || []));
      } else {
        classification = "GJENNOMFØRBAR";
      }
      return {
        entryId: entry.entryId,
        vehicleId,
        desiredSlot,
        canonicalActual,
        classification,
        reasonCodes,
        gate: clone(gate),
      };
    });
    return {
      schemaVersion: "sde-night-plan-analysis-v1",
      planId: plan.planId,
      inputRevision: cleanText(context.revision),
      sideEffectPolicy: "READ_ONLY",
      entries,
    };
  }

  function daysBetween(earlier, later) {
    const start = Date.parse(`${cleanText(earlier)}T00:00:00.000Z`);
    const end = Date.parse(later);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 3650;
    return Math.max(0, (end - start) / 86400000);
  }

  function scoreHumanExperience(candidate, records, options) {
    const slot = normalizeSlot(candidate && candidate.slot);
    const vehicleType = cleanText(candidate && candidate.vehicleType);
    const now = cleanText(options && options.now) || new Date().toISOString();
    const sourceRecords = Array.isArray(records) ? records : [];
    let excludedRecommendationCount = 0;
    let irrelevantRecordCount = 0;
    const relevant = [];
    sourceRecords.forEach(record => {
      if (cleanText(record && record.sourceType) === "SDE_RECOMMENDATION") {
        excludedRecommendationCount += 1;
        return;
      }
      if (normalizeSlot(record && record.desiredSlot) !== slot) {
        irrelevantRecordCount += 1;
        return;
      }
      if (vehicleType && cleanText(record && record.vehicleType) && cleanText(record.vehicleType) !== vehicleType) {
        irrelevantRecordCount += 1;
        return;
      }
      const sourceType = cleanText(record && record.sourceType);
      if (sourceType === "HUMAN_IMPORTED_PLAN" || sourceType === "HUMAN_MANUAL_PLAN") {
        if (cleanText(record.planStatus) !== "CONFIRMED") return;
        relevant.push({record, kind: "planned", baseWeight: 0.35, success: 0.65});
      } else if (sourceType === "AUTHORITATIVE_EXECUTED_RESULT") {
        const completed = cleanText(record.actualOutcome) === "COMPLETED";
        const finalMatches = normalizeSlot(record.actualFinalSlot) === slot;
        const replan = record.replanOccurred === true || cleanText(record.actualOutcome) === "REPLAN_REQUIRED";
        relevant.push({record, kind: "executed", baseWeight: 1, success: completed && finalMatches && !replan ? 1 : 0});
      }
    });
    const plannedCount = relevant.filter(item => item.kind === "planned").length;
    const authoritativelyExecutedCount = relevant.filter(item => item.kind === "executed").length;
    const replanCount = relevant.filter(item => item.kind === "executed" && (item.record.replanOccurred === true || cleanText(item.record.actualOutcome) === "REPLAN_REQUIRED")).length;
    if (!relevant.length) {
      return {
        status: "INSUFFICIENT_DATA",
        score: null,
        plannedCount: 0,
        authoritativelyExecutedCount: 0,
        excludedRecommendationCount,
        irrelevantRecordCount,
        evidence: [],
        explanation: "Ingen sammenlignbar menneskelig eller autoritativt gjennomført erfaring.",
      };
    }
    let weightedSuccess = 0;
    let totalWeight = 0;
    const evidence = [];
    relevant.forEach(item => {
      const ageDays = daysBetween(item.record.operationalDate, now);
      const recency = Math.pow(0.5, ageDays / 180);
      const weight = item.baseWeight * recency;
      weightedSuccess += item.success * weight;
      totalWeight += weight;
      evidence.push({
        recordId: cleanText(item.record.recordId),
        operationalDate: cleanText(item.record.operationalDate),
        kind: item.kind,
        outcome: cleanText(item.record.actualOutcome || item.record.planStatus),
        finalSlot: normalizeSlot(item.record.actualFinalSlot),
        success: item.success,
        weight: Math.round(weight * 1000000) / 1000000,
      });
    });
    const score = Math.round(clamp(totalWeight ? weightedSuccess / totalWeight * 100 : 0, 0, 100));
    return {
      status: "AVAILABLE",
      score,
      plannedCount,
      authoritativelyExecutedCount,
      replanCount,
      excludedRecommendationCount,
      irrelevantRecordCount,
      evidence,
      explanation: `Erfaringsgrunnlag: ${plannedCount} bekreftet planlagt og ${authoritativelyExecutedCount} autoritativt gjennomført. ${replanCount} gjennomført historikk krevde replanlegging. Faktiske datoer: ${evidence.map(item => item.operationalDate).filter(Boolean).join(", ") || "ingen"}.`,
    };
  }

  function increment(map, key) {
    map[key] = Number(map[key] || 0) + 1;
  }

  function buildTrainingDataset(records) {
    const exclusions = {};
    const rows = [];
    const operationalRevisions = new Set();
    const operationalDates = new Set();
    (Array.isArray(records) ? records : []).forEach(record => {
      if (cleanText(record && record.sourceType) !== "AUTHORITATIVE_EXECUTED_RESULT") {
        increment(
          exclusions,
          cleanText(record && record.sourceType) === "SDE_RECOMMENDATION"
            ? "SDE_RECOMMENDATION_NOT_GROUND_TRUTH"
            : "UNVERIFIED_PLAN_NOT_GROUND_TRUTH"
        );
        return;
      }
      if (record.currentSafetyValid !== true) {
        increment(exclusions, "INVALID_UNDER_CURRENT_SAFETY_RULES");
        return;
      }
      const featureEntries = Object.entries(record.features || {});
      if (featureEntries.some(([key]) => !FEATURE_ALLOWLIST_SET.has(key))) {
        increment(exclusions, "NON_ALLOWLISTED_FEATURE");
        return;
      }
      const decisionAt = Date.parse(record.decisionAt);
      if (!Number.isFinite(decisionAt) || featureEntries.some(([, descriptor]) => (
        !descriptor
        || !Number.isFinite(Date.parse(descriptor.knownAt))
        || Date.parse(descriptor.knownAt) > decisionAt
      ))) {
        increment(exclusions, "FUTURE_FEATURE_LEAKAGE");
        return;
      }
      if (!Number.isFinite(Date.parse(record.outcomeKnownAt)) || Date.parse(record.outcomeKnownAt) <= decisionAt) {
        increment(exclusions, "INVALID_OUTCOME_PROVENANCE");
        return;
      }
      if (LABEL_ALLOWLIST.some(label => !(label in (record.labels || {})))) {
        increment(exclusions, "MISSING_TARGET_LABEL");
        return;
      }
      const features = Object.fromEntries(featureEntries.map(([key, descriptor]) => [key, clone(descriptor.value)]));
      rows.push({
        recordId: cleanText(record.recordId),
        operationalDate: cleanText(record.operationalDate),
        decisionAt: cleanText(record.decisionAt),
        outcomeKnownAt: cleanText(record.outcomeKnownAt),
        operationalRevision: cleanText(record.operationalRevision),
        features,
        labels: Object.fromEntries(LABEL_ALLOWLIST.map(label => [label, clone(record.labels[label])])),
      });
      if (record.operationalRevision) operationalRevisions.add(cleanText(record.operationalRevision));
      if (record.operationalDate) operationalDates.add(cleanText(record.operationalDate));
    });
    rows.sort((left, right) => left.operationalDate.localeCompare(right.operationalDate) || left.recordId.localeCompare(right.recordId));
    return {
      schemaVersion: "sde-night-training-dataset-v1",
      featureVersion: "sde-night-features-v1",
      targetVersion: "sde-night-targets-v1",
      rows,
      exclusions,
      provenance: {
        sourcePolicy: "AUTHORITATIVE_EXECUTED_RESULT_ONLY",
        recordCount: rows.length,
        operationalDates: [...operationalDates].sort(),
        operationalRevisions: [...operationalRevisions].sort(),
        features: [...FEATURE_ALLOWLIST],
        labels: [...LABEL_ALLOWLIST],
        excludedRecords: Object.values(exclusions).reduce((total, count) => total + count, 0),
      },
    };
  }

  function registeredModelEntry(registry, artifact) {
    const entries = Array.isArray(registry)
      ? registry
      : registry && Array.isArray(registry.models) ? registry.models : [];
    return entries.find(entry => (
      cleanText(entry && entry.modelId) === cleanText(artifact && artifact.modelId)
      && cleanText(entry && entry.modelVersion) === cleanText(artifact && artifact.modelVersion)
      && cleanText(entry && entry.artifactHash).toLowerCase() === cleanText(artifact && artifact.artifactHash).toLowerCase()
      && cleanText(entry && entry.status) === "CHAMPION"
    ));
  }

  function validateChampionModelContract(artifact) {
    const requiredTargets = [
      "replanProbability",
      "morningConflictProbability",
      "departureBlockingProbability",
      "planCompletionProbability",
      "expectedMoveCount",
    ];
    if (!artifact.featureSchema || typeof artifact.featureSchema !== "object") {
      return {ok: false, reasonCode: "MODEL_FEATURE_SCHEMA_MISSING"};
    }
    const numericNames = Object.keys(artifact.featureSchema.numeric || {});
    const categoricalEntries = Object.entries(artifact.featureSchema.categorical || {});
    const categoricalNames = categoricalEntries.map(([name]) => name);
    if ([...numericNames, ...categoricalNames].some(name => !FEATURE_ALLOWLIST_SET.has(name))) {
      return {ok: false, reasonCode: "MODEL_FEATURE_NOT_ALLOWLISTED"};
    }
    const encodedNames = new Set(numericNames);
    categoricalEntries.forEach(([name, categories]) => {
      (Array.isArray(categories) ? categories : []).forEach(category => encodedNames.add(`${name}=${category}`));
    });
    if (requiredTargets.some(target => !artifact.models[target] || typeof artifact.models[target] !== "object")) {
      return {ok: false, reasonCode: "MODEL_TARGET_CONTRACT_INCOMPLETE"};
    }
    for (const [target, model] of Object.entries(artifact.models)) {
      const expectedType = target === "expectedMoveCount" ? "linear" : "logistic";
      if (model.type !== expectedType || !Number.isFinite(Number(model.intercept)) || !model.weights || typeof model.weights !== "object") {
        return {ok: false, reasonCode: "MODEL_PARAMETER_CONTRACT_INVALID"};
      }
      if (Object.entries(model.weights).some(([name, weight]) => !encodedNames.has(name) || !Number.isFinite(Number(weight)))) {
        return {ok: false, reasonCode: "MODEL_PARAMETER_FEATURE_INVALID"};
      }
    }
    return {ok: true};
  }

  async function validateModelArtifact(artifact, registry) {
    const required = ["schemaVersion", "modelId", "modelVersion", "status", "featureVersion", "targetVersion", "artifactHash"];
    if (!artifact || typeof artifact !== "object" || required.some(key => !cleanText(artifact[key]))) {
      return {ok: false, reasonCode: "MODEL_ARTIFACT_CONTRACT_INVALID"};
    }
    if (artifact.schemaVersion !== "sde-night-model-artifact-v1") {
      return {ok: false, reasonCode: "MODEL_ARTIFACT_SCHEMA_UNKNOWN"};
    }
    const unsigned = clone(artifact);
    delete unsigned.artifactHash;
    let calculatedHash;
    try {
      calculatedHash = await sha256Hex(canonical(unsigned));
    } catch (_) {
      return {ok: false, reasonCode: "MODEL_HASH_RUNTIME_UNAVAILABLE"};
    }
    if (calculatedHash !== String(artifact.artifactHash).toLowerCase()) {
      return {ok: false, reasonCode: "MODEL_ARTIFACT_HASH_MISMATCH", calculatedHash};
    }
    if (artifact.status === "CHAMPION" && (!artifact.models || typeof artifact.models !== "object")) {
      return {ok: false, reasonCode: "MODEL_ARTIFACT_MODELS_MISSING"};
    }
    if (artifact.status === "CHAMPION") {
      const modelContract = validateChampionModelContract(artifact);
      if (!modelContract.ok) return modelContract;
    }
    if (artifact.status === "CHAMPION" && (!artifact.promotion || !cleanText(artifact.promotion.sourceArtifactHash))) {
      return {ok: false, reasonCode: "MODEL_CHAMPION_APPROVAL_MISSING"};
    }
    if (artifact.status === "CHAMPION" && !registeredModelEntry(registry, artifact)) {
      return {ok: false, reasonCode: "MODEL_ARTIFACT_UNREGISTERED"};
    }
    return {ok: true, calculatedHash};
  }

  function featureValue(features, name) {
    const value = features && features[name];
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function runTransparentModel(model, features) {
    const contributions = [];
    let raw = Number(model && model.intercept || 0);
    Object.entries(model && model.weights || {}).forEach(([name, weight]) => {
      const contribution = featureValue(features, name) * Number(weight || 0);
      raw += contribution;
      contributions.push({feature: name, contribution});
    });
    const prediction = model && model.type === "logistic"
      ? 1 / (1 + Math.exp(-clamp(raw, -30, 30)))
      : raw;
    contributions.sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
    return {prediction, contributions};
  }

  function encodeArtifactFeatures(features, featureSchema) {
    if (!featureSchema || typeof featureSchema !== "object") return clone(features || {});
    const encoded = {};
    Object.entries(featureSchema.numeric || {}).forEach(([name, descriptor]) => {
      const mean = Number(descriptor && descriptor.mean || 0);
      const scale = Number(descriptor && descriptor.scale || 1) || 1;
      const raw = features && features[name];
      const available = raw !== null && raw !== "" && Number.isFinite(Number(raw));
      encoded[name] = available ? (Number(raw) - mean) / scale : 0;
    });
    Object.entries(featureSchema.categorical || {}).forEach(([name, categories]) => {
      const actual = cleanText(features && features[name]).toUpperCase();
      (Array.isArray(categories) ? categories : []).forEach(category => {
        encoded[`${name}=${category}`] = actual === cleanText(category).toUpperCase() ? 1 : 0;
      });
    });
    return encoded;
  }

  function explainableFeatureName(name) {
    const labels = {
      departureMinutes: "avgangstid",
      arrivalMinutes: "ankomsttid",
      faultCount: "registrerte feil",
      reservationCount: "reservasjoner",
      blockingVehicleCount: "blokkerende kjøretøy",
      requiredMoveCount: "nødvendige flyttinger",
      departureOrder: "avgangsrekkefølge",
      serviceNeed: "servicebehov",
      workshopNeed: "verkstedbehov",
      cleaningNeed: "renholdsbehov",
      tursattBound: "Tursatt-binding",
      startSlot: "startspor",
      candidateSlot: "kandidatspor",
      vehicleType: "materielltype",
      dispositionCode: "disposisjon",
    };
    const rawName = cleanText(name).split("=")[0];
    return labels[rawName] || rawName;
  }

  async function inferMachineLearning(candidate, artifact, options) {
    const integrity = await validateModelArtifact(artifact, options && options.registry);
    if (!integrity.ok) {
      return {
        status: "ML_DISABLED",
        score: null,
        influencesCombinedScore: false,
        reasonCode: integrity.reasonCode,
        explanation: "Maskinlæringsvurdering er ikke tilgjengelig fordi modellartifactens integritet ikke kunne verifiseres.",
      };
    }
    if (artifact.status === "INSUFFICIENT_DATA") {
      return {
        status: "INSUFFICIENT_DATA",
        score: null,
        influencesCombinedScore: false,
        modelVersion: artifact.modelVersion,
        explanation: "Maskinlæring: utilstrekkelig historisk datagrunnlag.",
      };
    }
    if (artifact.status !== "CHAMPION") {
      return {
        status: "ML_DISABLED",
        score: null,
        influencesCombinedScore: false,
        modelVersion: artifact.modelVersion,
        explanation: "Maskinlæringsvurdering er ikke tilgjengelig fordi modellen ikke er eksplisitt godkjent som champion.",
      };
    }
    if (!options || options.absoluteGatePassed !== true) {
      return {
        status: "ML_DISABLED",
        score: null,
        influencesCombinedScore: false,
        modelVersion: artifact.modelVersion,
        reasonCode: "ABSOLUTE_GATE_EVIDENCE_REQUIRED",
        explanation: "Maskinlæringsvurdering beregnes bare etter dokumentert godkjent absolutt port.",
      };
    }
    const features = candidate && candidate.features || candidate || {};
    const encodedFeatures = encodeArtifactFeatures(features, artifact.featureSchema);
    const outputs = {};
    const contributions = [];
    Object.entries(artifact.models).forEach(([target, model]) => {
      const result = runTransparentModel(model, encodedFeatures);
      outputs[target] = result.prediction;
      result.contributions.slice(0, 3).forEach(item => contributions.push({
        ...item,
        displayFeature: explainableFeatureName(item.feature),
        target,
      }));
    });
    const replan = clamp(outputs.replanProbability ?? 0.5, 0, 1);
    const morning = clamp(outputs.morningConflictProbability ?? 0.5, 0, 1);
    const blocking = clamp(outputs.departureBlockingProbability ?? 0.5, 0, 1);
    const completion = clamp(outputs.planCompletionProbability ?? 0.5, 0, 1);
    const movePenalty = clamp(Number(outputs.expectedMoveCount ?? 3) / 8, 0, 1);
    const score = Math.round(clamp((completion * 0.35 + (1 - replan) * 0.25 + (1 - morning) * 0.2 + (1 - blocking) * 0.1 + (1 - movePenalty) * 0.1) * 100, 0, 100));
    const top = contributions.sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution)).slice(0, 4);
    return {
      status: "AVAILABLE",
      score,
      influencesCombinedScore: true,
      modelVersion: artifact.modelVersion,
      outputs,
      factors: top,
      explanation: top.length
        ? `Maskinlæringsvurderingen bygger særlig på ${[...new Set(top.map(item => item.displayFeature))].join(", ")}.`
        : "Maskinlæringsvurderingen er tilgjengelig, men har ingen sterke enkeltfaktorer.",
    };
  }

  function numericScore(result) {
    const value = result && typeof result === "object" ? result.score : result;
    return Number.isFinite(Number(value)) ? clamp(Number(value), 0, 100) : null;
  }

  async function evaluateCandidate(input) {
    if (!input || typeof input.absoluteGate !== "function") throw new TypeError("absoluteGate is required");
    const gate = await input.absoluteGate(clone(input.candidate));
    if (!gate || gate.ok !== true) {
      return {
        status: "REJECTED_BY_ABSOLUTE_GATE",
        candidate: clone(input.candidate),
        gate: clone(gate || {ok: false, reasonCode: "ABSOLUTE_GATE_UNKNOWN"}),
        deterministicScore: null,
        humanExperienceScore: null,
        machineLearningScore: null,
        combinedScore: null,
        explanation: "Kandidaten er avvist av en absolutt port før scoring.",
      };
    }
    const deterministicResult = typeof input.deterministicScorer === "function" ? await input.deterministicScorer(clone(input.candidate)) : null;
    const humanResult = typeof input.humanScorer === "function" ? await input.humanScorer(clone(input.candidate)) : null;
    const machineResult = typeof input.machineScorer === "function" ? await input.machineScorer(clone(input.candidate)) : null;
    const deterministicScore = numericScore(deterministicResult);
    const humanExperienceScore = humanResult && humanResult.status !== "AVAILABLE" ? null : numericScore(humanResult);
    const machineLearningScore = machineResult && machineResult.status !== "AVAILABLE" ? null : numericScore(machineResult);
    const configuredWeights = {
      version: cleanText(input.weights && input.weights.version) || "unversioned",
      deterministic: Number(input.weights && input.weights.deterministic || 0),
      humanExperience: Number(input.weights && input.weights.humanExperience || 0),
      machineLearning: Number(input.weights && input.weights.machineLearning || 0),
    };
    const active = [
      {score: deterministicScore, weight: configuredWeights.deterministic},
      {score: humanExperienceScore, weight: configuredWeights.humanExperience},
      {score: machineLearningScore, weight: configuredWeights.machineLearning},
    ].filter(item => item.score != null && item.weight > 0);
    const totalWeight = active.reduce((total, item) => total + item.weight, 0);
    const combinedScore = totalWeight ? Math.round(active.reduce((total, item) => total + item.score * item.weight, 0) / totalWeight * 10) / 10 : null;
    const difference = humanExperienceScore != null && machineLearningScore != null
      ? Math.abs(humanExperienceScore - machineLearningScore)
      : null;
    const disagreement = difference != null && difference >= 20
      ? {status: "SIGNIFICANT_DISAGREEMENT", difference}
      : {status: difference == null ? "NOT_COMPARABLE" : "ALIGNED", difference};
    const explanation = disagreement.status === "SIGNIFICANT_DISAGREEMENT"
      ? "Menneskelig erfaring og maskinlæringsvurderingen er tydelig uenige; begge forklaringer skal vurderes før et fysisk gyldig alternativ velges."
      : "Samlet anbefaling er beregnet etter at alle absolutte porter var bestått.";
    return {
      status: "RANKED_DECISION_SUPPORT",
      candidate: clone(input.candidate),
      gate: clone(gate),
      deterministicScore,
      humanExperienceScore,
      machineLearningScore,
      combinedScore,
      weights: configuredWeights,
      disagreement,
      explanations: {
        deterministic: cleanText(deterministicResult && deterministicResult.explanation),
        humanExperience: cleanText(humanResult && humanResult.explanation),
        machineLearning: cleanText(machineResult && machineResult.explanation),
      },
      explanation,
    };
  }

  function assessModelDrift(input) {
    const source = input || {};
    const sampleCount = Number(source.sampleCount || 0);
    const minimumSamples = Number(source.minimumSamples || 0);
    if (sampleCount < minimumSamples) {
      return {
        status: "INSUFFICIENT_DRIFT_DATA",
        machineLearningWeightAllowed: true,
        requiresControlledRetraining: false,
        runtimeRetrainingTriggered: false,
      };
    }
    const threshold = Number(source.maximumBrierDegradation || 0.1);
    const metrics = ["replanBrier", "morningConflictBrier"];
    const degraded = metrics.filter(metric => Number(source.current && source.current[metric]) - Number(source.baseline && source.baseline[metric]) > threshold);
    const drift = degraded.length > 0;
    return {
      status: drift ? "MODEL_DRIFT" : "STABLE",
      degradedMetrics: degraded,
      machineLearningWeightAllowed: !drift,
      requiresControlledRetraining: drift,
      runtimeRetrainingTriggered: false,
    };
  }

  function createLocalOcrAnalyzer(options) {
    const source = options || {};
    if (typeof source.createWorker !== "function") throw new TypeError("createWorker is required");
    let activeSession = null;
    async function terminateSession(session) {
      if (!session || session.terminated || !session.worker || typeof session.worker.terminate !== "function") return;
      session.terminated = true;
      await session.worker.terminate();
    }
    return {
      async analyze(image, onProgress) {
        const type = cleanText(image && image.type).toLowerCase();
        if (type && type !== "image/jpeg" && type !== "image/png") throw new TypeError("unsupported_image_type");
        const session = {worker: null, terminated: false, cancelled: false};
        activeSession = session;
        try {
          session.worker = await source.createWorker("nor+eng", 1, {
            workerPath: source.workerPath,
            corePath: source.corePath,
            langPath: source.langPath,
            logger: typeof onProgress === "function" ? onProgress : undefined,
          });
          if (session.cancelled) throw new Error("ocr_cancelled");
          const result = await session.worker.recognize(image, {}, {text: true, blocks: true});
          if (session.cancelled) throw new Error("ocr_cancelled");
          const rawConfidence = Number(result && result.data && result.data.confidence || 0);
          const structured = flattenOcrBlocks(result && result.data && result.data.blocks);
          return {
            rawText: cleanText(result && result.data && result.data.text),
            confidence: clamp(rawConfidence > 1 ? rawConfidence / 100 : rawConfidence, 0, 1),
            tokens: structured.tokens.map(normalizeOcrToken),
            ocrTokenCount: structured.tokens.length,
            lineCount: structured.lineCount,
            imageWidth: Number(image && (image.width || image.naturalWidth) || 0) || undefined,
            imageHeight: Number(image && (image.height || image.naturalHeight) || 0) || undefined,
            tableGeometry: result && result.data && result.data.tableGeometry
              ? clone(result.data.tableGeometry)
              : (image && image.sdeOcrGeometry ? clone(image.sdeOcrGeometry) : undefined),
            sourceType: "LOCAL_BROWSER_OCR",
            rawImagePersisted: false,
          };
        } finally {
          await terminateSession(session);
          if (activeSession === session) activeSession = null;
        }
      },
      async cancel() {
        if (!activeSession) return false;
        activeSession.cancelled = true;
        await terminateSession(activeSession);
        return true;
      },
    };
  }

  return Object.freeze({
    VALID_SLOTS,
    FEATURE_ALLOWLIST,
    LABEL_ALLOWLIST,
    IMAGE_MIME_TYPES,
    MAX_IMAGE_BYTES,
    canonical,
    createNightPlan,
    parseOcrText,
    mapOcrResultToNightPlan,
    validateImageFileDescriptor,
    updateNightPlanField,
    addNightPlanEntry,
    removeNightPlanEntry,
    moveNightPlanEntry,
    setNightPlanEntryExcluded,
    canConfirmNightPlan,
    validateNightPlan,
    analyzeNightPlan,
    scoreHumanExperience,
    buildTrainingDataset,
    validateModelArtifact,
    inferMachineLearning,
    evaluateCandidate,
    assessModelDrift,
    createLocalOcrAnalyzer,
  });
});

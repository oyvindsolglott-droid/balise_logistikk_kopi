(function attachSdeHandwritingRecognition(root, factory){
  "use strict";
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  if(root) root.SdeHandwritingRecognition = api;
})(typeof window !== "undefined" ? window : globalThis, function createSdeHandwritingRecognition(){
  "use strict";

  const PIPELINE_STAGES = Object.freeze([
    "IMAGE",
    "ORIENTATION",
    "PERSPECTIVE_CORRECTION",
    "TEMPLATE_REGISTRATION",
    "CELL_SEGMENTATION",
    "HANDWRITING_RECOGNITION",
    "FIELD_NORMALIZATION",
    "FORM_MAPPING",
  ]);
  const COLUMN_IDS = Object.freeze(["fromTrain", "toTrain", "vehicleId", "toTrack", "wcWater", "notes"]);
  const MODEL_SPEC = Object.freeze({
    id: "PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx",
    revision: "89d3a50e2c27e2e7cceeab0e944c25c807d5db4f",
    version: "latin-pp-ocrv5-mobile-rec-onnx@89d3a50e",
    modelSha256: "7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498",
    runtime: "onnxruntime-web@1.27.0",
    executionProvider: "wasm",
    remoteModelsAllowed: false,
    handwritingCapable: true,
    requiresWebGpu: false,
  });
  const TEMPLATE = Object.freeze({
    width: 1200,
    height: 1500,
    dataTop: 285,
    dataBottom: 1465,
    columnBoundaries: Object.freeze([26, 168, 329, 484, 636, 770, 1174]),
    metadata: Object.freeze([
      Object.freeze({columnId: "date", canonicalBox: Object.freeze({x0: 155, y0: 55, x1: 390, y1: 130})}),
      Object.freeze({columnId: "signature", canonicalBox: Object.freeze({x0: 535, y0: 55, x1: 770, y1: 130})}),
      Object.freeze({columnId: "ds", canonicalBox: Object.freeze({x0: 925, y0: 55, x1: 1174, y1: 130})}),
    ]),
  });

  function finitePoint(value, label){
    const point = value && typeof value === "object" ? value : {};
    const x = Number(point.x);
    const y = Number(point.y);
    if(!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`invalid_${label}_point`);
    return {x, y};
  }

  function solveLinearSystem(matrix, vector){
    const size = vector.length;
    const augmented = matrix.map((row, index) => [...row, vector[index]]);
    for(let column = 0; column < size; column += 1){
      let pivot = column;
      for(let row = column + 1; row < size; row += 1){
        if(Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
      }
      if(Math.abs(augmented[pivot][column]) < 1e-12) throw new Error("perspective_transform_singular");
      [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
      const divisor = augmented[column][column];
      for(let item = column; item <= size; item += 1) augmented[column][item] /= divisor;
      for(let row = 0; row < size; row += 1){
        if(row === column) continue;
        const factor = augmented[row][column];
        for(let item = column; item <= size; item += 1){
          augmented[row][item] -= factor * augmented[column][item];
        }
      }
    }
    return augmented.map(row => row[size]);
  }

  function homography(fromPoints, toPoints){
    if(!Array.isArray(fromPoints) || !Array.isArray(toPoints) || fromPoints.length !== 4 || toPoints.length !== 4){
      throw new Error("perspective_transform_requires_four_points");
    }
    const matrix = [];
    const vector = [];
    for(let index = 0; index < 4; index += 1){
      const from = finitePoint(fromPoints[index], "source");
      const to = finitePoint(toPoints[index], "target");
      matrix.push([from.x, from.y, 1, 0, 0, 0, -to.x * from.x, -to.x * from.y]);
      vector.push(to.x);
      matrix.push([0, 0, 0, from.x, from.y, 1, -to.y * from.x, -to.y * from.y]);
      vector.push(to.y);
    }
    const values = solveLinearSystem(matrix, vector);
    return Object.freeze([...values, 1]);
  }

  function createPerspectiveTransform(original, canonical){
    return Object.freeze({
      forward: homography(original, canonical),
      inverse: homography(canonical, original),
      applied: true,
    });
  }

  function projectPoint(transform, point){
    if(!Array.isArray(transform) || transform.length !== 9) throw new Error("invalid_perspective_transform");
    const clean = finitePoint(point, "projected");
    const divisor = (transform[6] * clean.x) + (transform[7] * clean.y) + transform[8];
    if(Math.abs(divisor) < 1e-12) throw new Error("perspective_projection_at_infinity");
    return Object.freeze({
      x: ((transform[0] * clean.x) + (transform[1] * clean.y) + transform[2]) / divisor,
      y: ((transform[3] * clean.x) + (transform[4] * clean.y) + transform[5]) / divisor,
    });
  }

  function projectBox(transform, box){
    const points = [
      projectPoint(transform, {x: box.x0, y: box.y0}),
      projectPoint(transform, {x: box.x1, y: box.y0}),
      projectPoint(transform, {x: box.x1, y: box.y1}),
      projectPoint(transform, {x: box.x0, y: box.y1}),
    ];
    return Object.freeze({
      x0: Math.min(...points.map(point => point.x)),
      y0: Math.min(...points.map(point => point.y)),
      x1: Math.max(...points.map(point => point.x)),
      y1: Math.max(...points.map(point => point.y)),
      coordinateSpace: "ORIGINAL_IMAGE",
      polygon: Object.freeze(points),
    });
  }

  function fullImageQuadrilateral(width, height){
    return [
      {x: 0, y: 0},
      {x: width, y: 0},
      {x: width, y: height},
      {x: 0, y: height},
    ];
  }

  function registerTemplate(input = {}){
    const imageWidth = Number(input.imageWidth);
    const imageHeight = Number(input.imageHeight);
    if(!(imageWidth > 0) || !(imageHeight > 0)) throw new Error("invalid_form_image_dimensions");
    const original = (input.quadrilateral || fullImageQuadrilateral(imageWidth, imageHeight)).map((point, index) => finitePoint(point, `corner_${index}`));
    const canonical = fullImageQuadrilateral(TEMPLATE.width, TEMPLATE.height);
    const perspective = createPerspectiveTransform(original, canonical);
    const rowHeight = (TEMPLATE.dataBottom - TEMPLATE.dataTop) / 29;
    const cells = [];
    for(let rowIndex = 0; rowIndex < 29; rowIndex += 1){
      for(let columnIndex = 0; columnIndex < COLUMN_IDS.length; columnIndex += 1){
        const canonicalBox = Object.freeze({
          x0: TEMPLATE.columnBoundaries[columnIndex],
          y0: TEMPLATE.dataTop + (rowIndex * rowHeight),
          x1: TEMPLATE.columnBoundaries[columnIndex + 1],
          y1: TEMPLATE.dataTop + ((rowIndex + 1) * rowHeight),
        });
        cells.push(Object.freeze({
          rowIndex,
          columnId: COLUMN_IDS[columnIndex],
          canonicalBox,
          boundingBox: projectBox(perspective.inverse, canonicalBox),
        }));
      }
    }
    const metadataCells = TEMPLATE.metadata.map(item => Object.freeze({
      rowIndex: null,
      columnId: item.columnId,
      canonicalBox: item.canonicalBox,
      boundingBox: projectBox(perspective.inverse, item.canonicalBox),
    }));
    return Object.freeze({
      status: "FORM_DETECTED",
      templateVersion: "togplassering-skien-29x6-v1",
      canonicalWidth: TEMPLATE.width,
      canonicalHeight: TEMPLATE.height,
      perspectiveCorrectionApplied: true,
      perspective,
      cells: Object.freeze(cells),
      metadataCells: Object.freeze(metadataCells),
    });
  }

  function normalizerFor(columnId){
    if(columnId === "vehicleId") return "VEHICLE_ID";
    if(columnId === "toTrack") return "CANONICAL_SLOT";
    if(columnId === "wcWater") return "WC_WATER_SYMBOL";
    if(columnId === "notes" || columnId === "signature" || columnId === "ds") return "FREE_TEXT";
    if(columnId === "date") return "DATE";
    return "TRAIN_IDENTIFIER";
  }

  function createRecognitionRequests(registration){
    if(!registration || registration.status !== "FORM_DETECTED") throw new Error("form_registration_required");
    return Object.freeze([...registration.metadataCells, ...registration.cells].map(cell => Object.freeze({
      ...cell,
      recognizerKind: "HANDWRITING",
      normalizer: normalizerFor(cell.columnId),
      recognizerVersion: MODEL_SPEC.version,
    })));
  }

  function normalizedCandidates(recognition){
    const raw = Array.isArray(recognition?.candidates) ? recognition.candidates : [];
    return raw.map(candidate => ({
      text: String(candidate?.text || "").normalize("NFKC").trim(),
      confidence: clamp(Number(candidate?.confidence || 0), 0, 1),
    })).filter(candidate => candidate.text);
  }

  function canonicalizeVehicle(value){
    const parts = String(value || "").toUpperCase().replace(/[–—]/g, "-").replace(/\s+/g, "").split("-");
    if(parts.length !== 2) return "";
    const digits = part => part.replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/Z/g, "2").replace(/S/g, "5").replace(/G/g, "6").replace(/B/g, "8");
    const left = digits(parts[0]);
    const right = digits(parts[1]);
    return /^\d{2}$/.test(left) && /^\d{2}$/.test(right) ? `${left}-${right}` : "";
  }

  function canonicalizeSlot(value){
    return String(value || "").normalize("NFKC").toUpperCase().replace(/\s+/g, "").replace(/(?:-|=)+>/g, "→");
  }

  function normalizeTrain(value){
    const upper = String(value || "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
    if(upper === "REP") return upper;
    const normalized = upper.replace(/[OQ]/g, "0").replace(/[IL|]/g, "1").replace(/\)/g, "2");
    return /^\d+[A-Z]?$/.test(normalized) ? normalized : "";
  }

  function wcSymbol(value){
    const compact = String(value || "").trim();
    if(/[★☆*✱✳]/.test(compact)) return "*";
    if(/[✓✔√]/.test(compact)) return "CHECK";
    if(/[✕✖×xX]/.test(compact)) return "CROSS";
    if(/[○◯⭕]/.test(compact) || /^\([^)]*\)$/.test(compact)) return "CIRCLE";
    return "";
  }

  function normalizeDate(value){
    const raw = String(value || "").normalize("NFKC").trim();
    const digits = raw.replace(/\D/g, "");
    if(digits.length === 8){
      const day = Number(digits.slice(0, 2));
      const month = Number(digits.slice(2, 4));
      const year = Number(digits.slice(4));
      if(day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2199){
        return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
      }
    }
    return raw;
  }

  function unique(values){
    return [...new Set(values.filter(Boolean))];
  }

  function normalizeRecognition(recognition, context = {}){
    const columnId = String(recognition?.columnId || "");
    const normalizer = normalizerFor(columnId);
    const candidates = normalizedCandidates(recognition);
    const sourceAlternatives = [];
    let selectedValue = "";
    let validationState = "UNREADABLE";
    let confidence = candidates[0]?.confidence || 0;
    if(normalizer === "VEHICLE_ID"){
      for(const candidate of candidates){
        const normalized = canonicalizeVehicle(candidate.text);
        if(normalized) sourceAlternatives.push(normalized);
      }
      selectedValue = sourceAlternatives[0] || "";
      validationState = selectedValue ? (Array.isArray(context.vehicleCatalog) && context.vehicleCatalog.length && !context.vehicleCatalog.includes(selectedValue) ? "REVIEW_REQUIRED" : "VALID") : "UNSUPPORTED";
    }else if(normalizer === "CANONICAL_SLOT"){
      const canonicalSlots = new Set(Array.isArray(context.canonicalSlots) ? context.canonicalSlots.map(canonicalizeSlot) : []);
      for(const candidate of candidates){
        const normalized = canonicalizeSlot(candidate.text);
        const components = normalized.split("→");
        const target = components.at(-1);
        if(canonicalSlots.has(normalized)) sourceAlternatives.push(normalized);
        else if(components.length > 1 && canonicalSlots.has(target)) sourceAlternatives.push(normalized);
      }
      selectedValue = sourceAlternatives[0] || "";
      validationState = selectedValue ? "VALID" : "UNSUPPORTED";
    }else if(normalizer === "WC_WATER_SYMBOL"){
      sourceAlternatives.push(...candidates.map(candidate => wcSymbol(candidate.text)));
      selectedValue = sourceAlternatives.find(Boolean) || "";
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }else if(normalizer === "TRAIN_IDENTIFIER"){
      sourceAlternatives.push(...candidates.map(candidate => normalizeTrain(candidate.text)));
      selectedValue = sourceAlternatives.find(Boolean) || "";
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }else if(normalizer === "DATE"){
      sourceAlternatives.push(...candidates.map(candidate => normalizeDate(candidate.text)));
      selectedValue = sourceAlternatives.find(Boolean) || "";
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }else{
      sourceAlternatives.push(...candidates.map(candidate => candidate.text));
      selectedValue = sourceAlternatives.find(Boolean) || "";
      validationState = selectedValue ? "VALID" : "UNREADABLE";
    }
    const alternatives = unique(sourceAlternatives);
    // Free handwriting is deliberately fail-closed: a plausible-looking note is
    // not silently accepted unless the recognizer is exceptionally confident.
    const threshold = normalizer === "FREE_TEXT" ? 0.98 : 0.86;
    const needsReview = !selectedValue || confidence < threshold || validationState !== "VALID";
    if(!selectedValue) confidence = Math.min(confidence, 0.49);
    return Object.freeze({
      selectedValue,
      normalizedValue: selectedValue,
      confidence,
      alternatives: Object.freeze(alternatives),
      needsReview,
      validationState,
      normalizer,
    });
  }

  function buildMappingReport(input = {}){
    const cells = Array.isArray(input.cells) ? input.cells : [];
    const metadataCells = Array.isArray(input.metadataCells) ? input.metadataCells : [];
    const mappedCellCount = cells.filter(cell => String(cell?.selectedValue || "").trim()).length;
    const allRecognizedCells = [...metadataCells, ...cells];
    const reviewedCellCount = allRecognizedCells.filter(cell => cell?.needsReview === true).length;
    let mappingStatus;
    if(input.htrCompleted !== true) mappingStatus = "RECOGNITION_FAILED";
    else if(input.registrationStatus !== "CELLS_SEGMENTED" || cells.length !== 29 * 6 || metadataCells.length !== 3) mappingStatus = "MAPPING_FAILED";
    else if(mappedCellCount <= 1) mappingStatus = "MAPPING_FAILED";
    else if(reviewedCellCount > 0) mappingStatus = "FORM_MAPPING_REQUIRES_REVIEW";
    else mappingStatus = "FORM_MAPPING_COMPLETE";
    const confidenceValues = allRecognizedCells.map(cell => Number(cell?.confidence)).filter(Number.isFinite);
    return Object.freeze({
      schemaVersion: "sde-night-form-mapping-report-v2",
      mappingStatus,
      htrCompleted: input.htrCompleted === true,
      registrationStatus: String(input.registrationStatus || ""),
      templateVersion: "togplassering-skien-29x6-v1",
      recognizerVersion: MODEL_SPEC.version,
      modelSha256: MODEL_SPEC.modelSha256,
      cellCount: cells.length,
      mappedCellCount,
      reviewedCellCount,
      requiresHumanReview: reviewedCellCount > 0 || mappingStatus !== "FORM_MAPPING_COMPLETE",
      mappingConfidence: confidenceValues.length ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length : 0,
      cells: Object.freeze(cells.map(cell => Object.freeze({...cell}))),
      metadataCells: Object.freeze(metadataCells.map(cell => Object.freeze({...cell}))),
    });
  }

  function applyHumanCorrection(cell, finalValue){
    const selectedValue = String(finalValue == null ? "" : finalValue).normalize("NFKC").trim();
    return Object.freeze({
      ...cell,
      selectedValue,
      normalizedValue: selectedValue,
      humanFinalValue: selectedValue,
      needsReview: false,
      groundTruthSource: "HUMAN_CORRECTED_FORM",
      rawRecognizerIsGroundTruth: false,
    });
  }

  function createRecognitionSession(sourceImageFingerprint){
    return Object.freeze({
      sourceImageFingerprint: String(sourceImageFingerprint || ""),
      cells: Object.freeze([]),
      status: "IMAGE_PREPROCESSING",
    });
  }

  function recordRecognition(session, cell){
    return Object.freeze({...session, cells: Object.freeze([...(session?.cells || []), Object.freeze({...cell})])});
  }

  function replaceRecognitionImage(_session, sourceImageFingerprint){
    return createRecognitionSession(sourceImageFingerprint);
  }

  async function digestSha256(bytes){
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if(globalThis.crypto?.subtle?.digest){
      const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
      return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    }
    if(typeof require === "function") return require("node:crypto").createHash("sha256").update(view).digest("hex");
    throw new Error("sha256_unavailable");
  }

  async function verifyModelBytes(bytes, manifest){
    const expected = String(manifest?.modelSha256 || "").toLowerCase();
    if(!/^[a-f0-9]{64}$/.test(expected)) throw new Error("invalid_model_manifest_hash");
    const actual = await digestSha256(bytes);
    if(actual !== expected) throw new Error("model_hash_mismatch");
    return true;
  }

  function supportsLocalRuntime(environment = globalThis){
    return typeof environment?.Worker === "function"
      && Boolean(environment?.WebAssembly)
      && typeof environment?.crypto?.subtle?.digest === "function";
  }

  function clamp(value, minimum, maximum){
    return Math.max(minimum, Math.min(maximum, value));
  }

  return Object.freeze({
    COLUMN_IDS,
    MODEL_SPEC,
    PIPELINE_STAGES,
    TEMPLATE,
    applyHumanCorrection,
    buildMappingReport,
    createPerspectiveTransform,
    createRecognitionRequests,
    createRecognitionSession,
    normalizeRecognition,
    projectPoint,
    recordRecognition,
    registerTemplate,
    replaceRecognitionImage,
    supportsLocalRuntime,
    verifyModelBytes,
  });
});

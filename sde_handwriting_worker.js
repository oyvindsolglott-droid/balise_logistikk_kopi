import "./sde_handwriting_recognition.js?v=6e2774d66f637e22554df0d2b5e65c8fe98a1a8a9681a2dd329a3465c575bb6d";
import * as ort from "./assets/vendor/onnxruntime-web/ort.wasm.min.mjs";

const htr = globalThis.SdeHandwritingRecognition;
const MODEL_ROOT = "assets/models/latin-pp-ocrv5-mobile-rec-onnx/";
const RUNTIME_ROOT = new URL("assets/vendor/onnxruntime-web/", self.location.href).href;

ort.env.wasm.wasmPaths = RUNTIME_ROOT;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = "error";

let runtimePromise = null;
let activeSessionId = "";
let cancelledSessionId = "";

function post(type, sessionId, payload = {}){
  self.postMessage({type, sessionId, ...payload});
}

function sameOriginUrl(relativePath){
  const url = new URL(relativePath, self.location.href);
  if(url.origin !== self.location.origin) throw new Error("cross_origin_htr_asset_blocked");
  return url;
}

async function fetchBytes(relativePath, cache = "force-cache"){
  const response = await fetch(sameOriginUrl(relativePath), {
    credentials: "same-origin",
    cache,
    redirect: "error",
  });
  if(!response.ok) throw new Error(`htr_asset_http_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function parseCharacterDictionary(text){
  const marker = "  character_dict:";
  const start = text.indexOf(marker);
  if(start < 0) throw new Error("htr_character_dictionary_missing");
  const values = text.slice(start).split(/\r?\n/).filter(line => line.startsWith("  - ")).map(line => {
    let value = line.slice(4);
    if((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))){
      value = value.slice(1, -1);
    }
    return value;
  });
  if(values.length !== 836) throw new Error("htr_character_dictionary_invalid");
  return Object.freeze(["", ...values, " "]);
}

async function initializeRuntime(){
  if(runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const manifestResponse = await fetch(sameOriginUrl(`${MODEL_ROOT}manifest.json`), {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if(!manifestResponse.ok) throw new Error(`htr_manifest_http_${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    if(manifest.modelRevision !== htr.MODEL_SPEC.revision
      || manifest.files?.["inference.onnx"] !== htr.MODEL_SPEC.modelSha256
      || manifest.runtime?.version !== "1.27.0"
      || manifest.runtime?.executionProvider !== "wasm"
      || manifest.networkPolicy?.remoteModelFallback !== false){
      throw new Error("htr_manifest_contract_mismatch");
    }
    const [modelBytes, dictionaryBytes] = await Promise.all([
      fetchBytes(`${MODEL_ROOT}inference.onnx`),
      fetchBytes(`${MODEL_ROOT}inference.yml`),
    ]);
    await htr.verifyModelBytes(modelBytes, {modelSha256: manifest.files["inference.onnx"]});
    await htr.verifyModelBytes(dictionaryBytes, {modelSha256: manifest.files["inference.yml"]});
    const characters = parseCharacterDictionary(new TextDecoder("utf-8", {fatal: true}).decode(dictionaryBytes));
    const session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
    });
    return Object.freeze({manifest, characters, session});
  })().catch(error => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

function grayscaleAt(pixels, width, x, y){
  const boundedX = Math.max(0, Math.min(width - 1, x));
  const height = Math.floor(pixels.length / (width * 4));
  const boundedY = Math.max(0, Math.min(height - 1, y));
  const offset = ((boundedY * width) + boundedX) * 4;
  return (pixels[offset] * 0.299) + (pixels[offset + 1] * 0.587) + (pixels[offset + 2] * 0.114);
}

function bilinearGray(pixels, width, height, x, y){
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const dx = Math.max(0, Math.min(1, x - x0));
  const dy = Math.max(0, Math.min(1, y - y0));
  const top = grayscaleAt(pixels, width, x0, y0) * (1 - dx) + grayscaleAt(pixels, width, x1, y0) * dx;
  const bottom = grayscaleAt(pixels, width, x0, y1) * (1 - dx) + grayscaleAt(pixels, width, x1, y1) * dx;
  return top * (1 - dy) + bottom * dy;
}

function percentile(sorted, ratio){
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)))] || 0;
}

function modelTensorFromGrayscale(image, width, height){
  const tensor = new Float32Array(3 * 48 * 320);
  for(let y = 0; y < height; y += 1){
    for(let x = 0; x < width; x += 1){
      const value = (image[(y * width) + x] / 127.5) - 1;
      const index = (y * 320) + x;
      tensor[index] = value;
      tensor[(48 * 320) + index] = value;
      tensor[(2 * 48 * 320) + index] = value;
    }
  }
  return tensor;
}

function suppressGridLinePixels(image, width, height){
  const horizontalMask = new Uint8Array(height);
  const verticalMask = new Uint8Array(width);
  for(let y = 0; y < height; y += 1){
    let dark = 0;
    for(let x = 0; x < width; x += 1) if(image[(y * width) + x] < 150) dark += 1;
    if(dark >= width * 0.68) horizontalMask[y] = 1;
  }
  for(let x = 0; x < width; x += 1){
    let dark = 0;
    for(let y = 0; y < height; y += 1) if(image[(y * width) + x] < 150) dark += 1;
    if(dark >= height * 0.68) verticalMask[x] = 1;
  }
  const output = Uint8Array.from(image);
  for(let y = 0; y < height; y += 1){
    for(let x = 0; x < width; x += 1){
      if(!horizontalMask[y] && !verticalMask[x]) continue;
      const index = (y * width) + x;
      let replacement = 255;
      if(horizontalMask[y]){
        const above = image[(Math.max(0, y - 2) * width) + x];
        const below = image[(Math.min(height - 1, y + 2) * width) + x];
        replacement = Math.min(replacement, Math.min(above, below));
      }
      if(verticalMask[x]){
        const left = image[(y * width) + Math.max(0, x - 2)];
        const right = image[(y * width) + Math.min(width - 1, x + 2)];
        replacement = Math.min(replacement, Math.min(left, right));
      }
      output[index] = replacement;
    }
  }
  return Object.freeze({
    image: output,
    horizontalLineCount: horizontalMask.reduce((sum, value) => sum + value, 0),
    verticalLineCount: verticalMask.reduce((sum, value) => sum + value, 0),
  });
}

function cellInputTensor(pixels, imageWidth, imageHeight, inverseTransform, cell){
  const box = cell.canonicalBox;
  const boxWidth = box.x1 - box.x0;
  const boxHeight = box.y1 - box.y0;
  const xPadding = Math.max(2, boxWidth * (cell.columnId === "notes" ? 0.012 : 0.02));
  const yPadding = Math.max(2, boxHeight * 0.055);
  const inner = {
    x0: box.x0 + xPadding,
    y0: box.y0 + yPadding,
    x1: box.x1 - xPadding,
    y1: box.y1 - yPadding,
  };
  const ratio = Math.max(0.4, (inner.x1 - inner.x0) / Math.max(1, inner.y1 - inner.y0));
  const resizedWidth = Math.max(20, Math.min(320, Math.ceil(48 * ratio)));
  const grayscale = new Uint8Array(resizedWidth * 48);
  for(let y = 0; y < 48; y += 1){
    const canonicalY = inner.y0 + ((y + 0.5) / 48) * (inner.y1 - inner.y0);
    for(let x = 0; x < resizedWidth; x += 1){
      const canonicalX = inner.x0 + ((x + 0.5) / resizedWidth) * (inner.x1 - inner.x0);
      const original = htr.projectPoint(inverseTransform, {x: canonicalX, y: canonicalY});
      grayscale[(y * resizedWidth) + x] = Math.round(bilinearGray(pixels, imageWidth, imageHeight, original.x, original.y));
    }
  }
  const gridSuppression = suppressGridLinePixels(grayscale, resizedWidth, 48);
  const lineSuppressed = gridSuppression.image;
  const ordered = [...lineSuppressed].sort((left, right) => left - right);
  const dark = percentile(ordered, 0.02);
  const paper = percentile(ordered, 0.92);
  const range = Math.max(24, paper - dark);
  const normalized = new Uint8Array(lineSuppressed.length);
  let inkPixels = 0;
  for(let index = 0; index < lineSuppressed.length; index += 1){
    const value = Math.max(0, Math.min(255, Math.round(((lineSuppressed[index] - dark) / range) * 255)));
    normalized[index] = value;
    if(value < 165) inkPixels += 1;
  }
  const inkRatio = inkPixels / Math.max(1, normalized.length);
  const blank = inkPixels < Math.max(7, normalized.length * 0.0055) || inkRatio > 0.68;
  const binaryDark = Uint8Array.from(normalized, value => value < 145 ? 0 : 255);
  const binaryFaint = Uint8Array.from(normalized, value => value < 190 ? 0 : 255);
  const tensors = Object.freeze([
    modelTensorFromGrayscale(normalized, resizedWidth, 48),
    modelTensorFromGrayscale(binaryDark, resizedWidth, 48),
    modelTensorFromGrayscale(binaryFaint, resizedWidth, 48),
  ]);
  return Object.freeze({
    tensor: tensors[0],
    tensors,
    blank,
    inkRatio,
    croppedCellImage: normalized,
    cropWidth: resizedWidth,
    cropHeight: 48,
    gridLineMask: Object.freeze({
      horizontalLineCount: gridSuppression.horizontalLineCount,
      verticalLineCount: gridSuppression.verticalLineCount,
    }),
  });
}

function decodeCtc(output, characters, allowedCharacters = null){
  const timeSteps = Number(output.dims[1]);
  const classCount = Number(output.dims[2]);
  const allowedIndexes = allowedCharacters == null
    ? null
    : [0, ...characters.map((character, index) => allowedCharacters.has(character) ? index : -1).filter(index => index > 0)];
  let previous = -1;
  let text = "";
  let confidenceSum = 0;
  let characterCount = 0;
  for(let time = 0; time < timeSteps; time += 1){
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    const offset = time * classCount;
    const indexes = allowedIndexes || Array.from({length: classCount}, (_unused, index) => index);
    for(const index of indexes){
      if(index >= classCount) continue;
      const value = Number(output.data[offset + index]);
      if(value > bestValue){
        bestValue = value;
        bestIndex = index;
      }
    }
    if(bestIndex !== 0 && bestIndex !== previous){
      text += characters[bestIndex] || "";
      confidenceSum += bestValue;
      characterCount += 1;
    }
    previous = bestIndex;
  }
  return Object.freeze({
    text: text.trim(),
    confidence: characterCount ? confidenceSum / characterCount : 0,
  });
}

function recognitionAlphabet(columnId){
  if(columnId === "fromTrain" || columnId === "toTrain") return new Set("0123456789REP¹²".split(""));
  if(columnId === "vehicleId") return new Set("0123456789-– ".split(""));
  if(columnId === "toTrack") return new Set("0123456789NSMV→>-+ ".split(""));
  if(columnId === "wcWater") return new Set("*xX()○◯✓✔√✕✖×".split(""));
  if(columnId === "date") return new Set("0123456789./-".split(""));
  return null;
}

async function recognizeCell(runtime, tensor, columnId){
  const output = await runtime.session.run({
    x: new ort.Tensor("float32", tensor, [1, 3, 48, 320]),
  });
  const unrestricted = decodeCtc(output.fetch_name_0, runtime.characters);
  const alphabet = recognitionAlphabet(columnId);
  const constrained = alphabet ? decodeCtc(output.fetch_name_0, runtime.characters, alphabet) : unrestricted;
  const candidates = [];
  for(const candidate of [constrained, unrestricted]){
    if(!candidate.text || candidates.some(value => value.text === candidate.text)) continue;
    candidates.push(candidate);
  }
  return Object.freeze({unrestricted, candidates: Object.freeze(candidates)});
}

function emptyCellResult(cell, inkRatio){
  const unreadableCrop = inkRatio > 0.68;
  return Object.freeze({
    rowIndex: cell.rowIndex,
    columnId: cell.columnId,
    boundingBox: cell.boundingBox,
    recognizedText: "",
    rawCandidates: Object.freeze([]),
    normalizedValue: "",
    selectedValue: "",
    confidence: unreadableCrop ? 0 : 1,
    alternatives: Object.freeze([]),
    needsReview: unreadableCrop,
    validationState: unreadableCrop ? "CROP_UNREADABLE" : "BLANK_IMAGE_CELL",
    recognizerVersion: htr.MODEL_SPEC.version,
    sourceBoundingBox: cell.boundingBox,
    normalizationReason: unreadableCrop ? "CROP_UNREADABLE" : "BLANK_IMAGE_CELL",
    groundTruthSource: "UNCONFIRMED_RECOGNIZER_OUTPUT",
    rawRecognizerIsGroundTruth: false,
    imageEvidence: Object.freeze({inkRatio, blank: !unreadableCrop}),
  });
}

async function analyze(message){
  const sessionId = String(message.sessionId || "");
  activeSessionId = sessionId;
  cancelledSessionId = "";
  const width = Number(message.width);
  const height = Number(message.height);
  const pixels = new Uint8ClampedArray(message.pixels);
  if(!(width > 0) || !(height > 0) || pixels.length !== width * height * 4) throw new Error("invalid_htr_image_frame");

  post("progress", sessionId, {status: "IMAGE_PREPROCESSING", progress: 0.05});
  const detected = htr.detectFormRegistration({pixels, width, height});
  if(detected.source !== "FORM_GRID_RULE_SEQUENCE" || detected.verticalLineCount !== 7 || detected.confidence < 0.55){
    throw new Error("form_registration_failed");
  }
  const registration = htr.registerTemplate({
    imageWidth: width,
    imageHeight: height,
    quadrilateral: detected.corners,
    rowBoundaries: detected.canonicalRowBoundaries,
  });
  post("progress", sessionId, {status: "FORM_REGISTRATION_COMPLETE", progress: 0.12, detection: detected});
  const requests = htr.createRecognitionRequests(registration);
  post("progress", sessionId, {status: "CELL_SEGMENTATION_COMPLETE", progress: 0.18, cellCount: 29 * 6});
  post("progress", sessionId, {status: "HANDWRITING_RECOGNITION_RUNNING", progress: 0.2});
  const runtime = await initializeRuntime();
  const cells = [];
  for(let index = 0; index < requests.length; index += 1){
    if(cancelledSessionId === sessionId || activeSessionId !== sessionId) throw new Error("htr_cancelled");
    const request = requests[index];
    const crop = cellInputTensor(pixels, width, height, registration.perspective.inverse, request);
    if(crop.blank){
      cells.push(emptyCellResult(request, crop.inkRatio));
    }else{
      const passes = [];
      const passTensors = ["notes", "signature", "ds"].includes(request.columnId) ? [crop.tensor] : crop.tensors;
      for(const tensor of passTensors) passes.push(await recognizeCell(runtime, tensor, request.columnId));
      const votes = new Map();
      for(const pass of passes){
        for(const candidate of pass.candidates){
          const current = votes.get(candidate.text) || {text: candidate.text, confidence: 0, votes: 0};
          current.confidence = Math.max(current.confidence, candidate.confidence);
          current.votes += 1;
          votes.set(candidate.text, current);
        }
      }
      const consensusCandidates = [...votes.values()]
        .map(candidate => ({
          text: candidate.text,
          confidence: candidate.votes >= 2 ? candidate.confidence : Math.min(candidate.confidence, 0.84),
          votes: candidate.votes,
        }))
        .sort((left, right) => (right.votes - left.votes) || (right.confidence - left.confidence));
      const raw = passes[0];
      const normalized = htr.normalizeRecognition({
        columnId: request.columnId,
        candidates: consensusCandidates,
      }, {
        canonicalSlots: Array.isArray(message.canonicalSlots) ? message.canonicalSlots : [],
        vehicleCatalog: Array.isArray(message.vehicleCatalog) ? message.vehicleCatalog : [],
      });
      cells.push(Object.freeze({
        rowIndex: request.rowIndex,
        columnId: request.columnId,
        boundingBox: request.boundingBox,
        recognizedText: raw.unrestricted.text,
        rawCandidates: Object.freeze(consensusCandidates.map(candidate => Object.freeze({...candidate}))),
        normalizedValue: normalized.normalizedValue,
        selectedValue: normalized.selectedValue,
        confidence: normalized.confidence,
        alternatives: normalized.alternatives,
        needsReview: normalized.needsReview,
        validationState: normalized.validationState,
        recognizerVersion: htr.MODEL_SPEC.version,
        sourceBoundingBox: request.boundingBox,
        normalizationReason: normalized.normalizationReason,
        groundTruthSource: "UNCONFIRMED_RECOGNIZER_OUTPUT",
        rawRecognizerIsGroundTruth: false,
        imageEvidence: Object.freeze({inkRatio: crop.inkRatio, blank: false}),
      }));
    }
    post("progress", sessionId, {
      status: "HANDWRITING_RECOGNITION_RUNNING",
      progress: 0.2 + (0.72 * ((index + 1) / requests.length)),
      processedCellCount: index + 1,
      totalCellCount: requests.length,
    });
  }
  const tableCells = cells.filter(cell => cell.rowIndex != null);
  const metadataCells = cells.filter(cell => cell.rowIndex == null);
  const report = htr.buildMappingReport({
    htrCompleted: true,
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
    cells: tableCells,
    metadataCells,
  });
  post("complete", sessionId, {
    result: {
      status: report.mappingStatus,
      registration: {
        status: "CELL_SEGMENTATION_COMPLETE",
        templateVersion: registration.templateVersion,
        perspectiveCorrectionApplied: true,
        detectionConfidence: detected.confidence,
        detectionSource: detected.source,
        verticalLineCount: detected.verticalLineCount,
        horizontalLineCount: detected.horizontalLineCount,
        quadrilateral: detected.corners,
      },
      cells: tableCells,
      metadataCells,
      mappingReport: report,
      model: {
        id: htr.MODEL_SPEC.id,
        revision: htr.MODEL_SPEC.revision,
        version: htr.MODEL_SPEC.version,
        sha256: htr.MODEL_SPEC.modelSha256,
        runtime: htr.MODEL_SPEC.runtime,
        executionProvider: "wasm",
        hashVerified: true,
      },
    },
  });
}

self.addEventListener("message", event => {
  const message = event.data || {};
  if(message.type === "cancel"){
    cancelledSessionId = String(message.sessionId || activeSessionId || "");
    return;
  }
  if(message.type !== "analyze") return;
  analyze(message).catch(error => {
    post("error", String(message.sessionId || ""), {error: String(error?.message || error)});
  });
});

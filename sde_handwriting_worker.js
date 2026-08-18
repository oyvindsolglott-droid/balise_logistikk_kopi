import "./sde_handwriting_recognition.js?v=f34cc5c606700a100524abdc9ef35c060f6adb13be59323e19a313b3dd2c9028";
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

function strongestHorizontalLine(pixels, width, height, startRatio, endRatio, edgePreference){
  const start = Math.max(0, Math.floor(height * startRatio));
  const end = Math.min(height - 1, Math.ceil(height * endRatio));
  let best = null;
  const edgeCandidates = [];
  for(let y = start; y <= end; y += 1){
    const positions = [];
    for(let x = 0; x < width; x += 1){
      if(grayscaleAt(pixels, width, x, y) < 105) positions.push(x);
    }
    if(positions.length < width * 0.25) continue;
    const candidate = {
      y,
      count: positions.length,
      left: positions[Math.min(positions.length - 1, Math.floor(positions.length * 0.01))],
      right: positions[Math.max(0, Math.ceil(positions.length * 0.99) - 1)],
    };
    candidate.span = candidate.right - candidate.left;
    const score = candidate.count + (candidate.span * 0.35);
    if(candidate.span > width * 0.65) edgeCandidates.push({...candidate, score});
    if(!best || score > best.score) best = {...candidate, score};
  }
  if(edgePreference === "top" && edgeCandidates.length) return edgeCandidates[0];
  if(edgePreference === "bottom" && edgeCandidates.length) return edgeCandidates.at(-1);
  return best;
}

function fitBoundaryLine(pixels, width, height, edge){
  const maximumDepth = Math.floor(height * 0.22);
  const points = [];
  for(let x = 0; x < width; x += 2){
    let found = null;
    if(edge === "top"){
      for(let y = 0; y <= maximumDepth; y += 1){
        if(grayscaleAt(pixels, width, x, y) < 100){ found = y; break; }
      }
    }else{
      for(let y = height - 1; y >= height - 1 - maximumDepth; y -= 1){
        if(grayscaleAt(pixels, width, x, y) < 100){ found = y; break; }
      }
    }
    if(found != null) points.push({x, y: found});
  }
  if(points.length < width * 0.28) return null;
  const regression = values => {
    const meanX = values.reduce((sum, point) => sum + point.x, 0) / values.length;
    const meanY = values.reduce((sum, point) => sum + point.y, 0) / values.length;
    const divisor = values.reduce((sum, point) => sum + ((point.x - meanX) ** 2), 0);
    const slope = divisor ? values.reduce((sum, point) => sum + ((point.x - meanX) * (point.y - meanY)), 0) / divisor : 0;
    return {slope, intercept: meanY - (slope * meanX)};
  };
  let line = regression(points);
  const residuals = points.map(point => Math.abs(point.y - ((line.slope * point.x) + line.intercept))).sort((a, b) => a - b);
  const medianResidual = residuals[Math.floor(residuals.length / 2)] || 0;
  const tolerance = Math.max(3, medianResidual * 3);
  const filtered = points.filter(point => Math.abs(point.y - ((line.slope * point.x) + line.intercept)) <= tolerance);
  if(filtered.length < width * 0.25) return null;
  line = regression(filtered);
  const xs = filtered.map(point => point.x);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  return Object.freeze({
    left,
    right,
    yAtLeft: (line.slope * left) + line.intercept,
    yAtRight: (line.slope * right) + line.intercept,
    span: right - left,
    sampleCount: filtered.length,
  });
}

function detectQuadrilateral(pixels, width, height){
  const topEdge = fitBoundaryLine(pixels, width, height, "top");
  const bottomEdge = fitBoundaryLine(pixels, width, height, "bottom");
  if(topEdge && bottomEdge
    && topEdge.span > width * 0.65
    && bottomEdge.span > width * 0.65
    && Math.min(bottomEdge.yAtLeft, bottomEdge.yAtRight) - Math.max(topEdge.yAtLeft, topEdge.yAtRight) > height * 0.68){
    return Object.freeze({
      corners: Object.freeze([
        Object.freeze({x: topEdge.left, y: topEdge.yAtLeft}),
        Object.freeze({x: topEdge.right, y: topEdge.yAtRight}),
        Object.freeze({x: bottomEdge.right, y: bottomEdge.yAtRight}),
        Object.freeze({x: bottomEdge.left, y: bottomEdge.yAtLeft}),
      ]),
      confidence: Math.min(1, (topEdge.sampleCount + bottomEdge.sampleCount) / width),
      source: "DARK_FORM_EDGE_REGRESSION",
    });
  }
  const top = strongestHorizontalLine(pixels, width, height, 0, 0.16, "top");
  const bottom = strongestHorizontalLine(pixels, width, height, 0.77, 0.999, "bottom");
  if(top && bottom && top.span > width * 0.65 && bottom.span > width * 0.65 && bottom.y - top.y > height * 0.68){
    return Object.freeze({
      corners: Object.freeze([
        Object.freeze({x: top.left, y: top.y}),
        Object.freeze({x: top.right, y: top.y}),
        Object.freeze({x: bottom.right, y: bottom.y}),
        Object.freeze({x: bottom.left, y: bottom.y}),
      ]),
      confidence: Math.min(1, ((top.span + bottom.span) / (2 * width)) * ((bottom.y - top.y) / height)),
      source: "DARK_FORM_BOUNDARY",
    });
  }
  const insetX = Math.max(1, width * 0.01);
  const insetY = Math.max(1, height * 0.01);
  return Object.freeze({
    corners: Object.freeze([
      Object.freeze({x: insetX, y: insetY}),
      Object.freeze({x: width - insetX, y: insetY}),
      Object.freeze({x: width - insetX, y: height - insetY}),
      Object.freeze({x: insetX, y: height - insetY}),
    ]),
    confidence: 0.5,
    source: "KNOWN_FORM_EDGE_FALLBACK",
  });
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

function cellInputTensor(pixels, imageWidth, imageHeight, inverseTransform, cell){
  const box = cell.canonicalBox;
  const boxWidth = box.x1 - box.x0;
  const boxHeight = box.y1 - box.y0;
  const xPadding = Math.max(3, boxWidth * (cell.columnId === "notes" ? 0.018 : 0.045));
  const yPadding = Math.max(3, boxHeight * 0.14);
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
  const ordered = [...grayscale].sort((left, right) => left - right);
  const dark = percentile(ordered, 0.02);
  const paper = percentile(ordered, 0.92);
  const range = Math.max(24, paper - dark);
  const normalized = new Uint8Array(grayscale.length);
  let inkPixels = 0;
  for(let index = 0; index < grayscale.length; index += 1){
    const value = Math.max(0, Math.min(255, Math.round(((grayscale[index] - dark) / range) * 255)));
    normalized[index] = value;
    if(value < 165) inkPixels += 1;
  }
  const inkRatio = inkPixels / Math.max(1, normalized.length);
  const blank = inkPixels < Math.max(7, normalized.length * 0.0055) || inkRatio > 0.68;
  const tensor = new Float32Array(3 * 48 * 320);
  for(let y = 0; y < 48; y += 1){
    for(let x = 0; x < resizedWidth; x += 1){
      const value = (normalized[(y * resizedWidth) + x] / 127.5) - 1;
      const index = (y * 320) + x;
      tensor[index] = value;
      tensor[(48 * 320) + index] = value;
      tensor[(2 * 48 * 320) + index] = value;
    }
  }
  return Object.freeze({
    tensor,
    blank,
    inkRatio,
    croppedCellImage: normalized,
    cropWidth: resizedWidth,
    cropHeight: 48,
  });
}

function decodeCtc(output, characters){
  const timeSteps = Number(output.dims[1]);
  const classCount = Number(output.dims[2]);
  let previous = -1;
  let text = "";
  let confidenceSum = 0;
  let characterCount = 0;
  for(let time = 0; time < timeSteps; time += 1){
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    const offset = time * classCount;
    for(let index = 0; index < classCount; index += 1){
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

async function recognizeCell(runtime, crop){
  const output = await runtime.session.run({
    x: new ort.Tensor("float32", crop.tensor, [1, 3, 48, 320]),
  });
  return decodeCtc(output.fetch_name_0, runtime.characters);
}

function emptyCellResult(cell, inkRatio){
  const unreadableCrop = inkRatio > 0.68;
  return Object.freeze({
    rowIndex: cell.rowIndex,
    columnId: cell.columnId,
    boundingBox: cell.boundingBox,
    recognizedText: "",
    normalizedValue: "",
    selectedValue: "",
    confidence: unreadableCrop ? 0 : 1,
    alternatives: Object.freeze([]),
    needsReview: unreadableCrop,
    validationState: unreadableCrop ? "CROP_UNREADABLE" : "BLANK_IMAGE_CELL",
    recognizerVersion: htr.MODEL_SPEC.version,
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
  const detected = detectQuadrilateral(pixels, width, height);
  const registration = htr.registerTemplate({imageWidth: width, imageHeight: height, quadrilateral: detected.corners});
  post("progress", sessionId, {status: "FORM_DETECTED", progress: 0.12, detection: detected});
  const requests = htr.createRecognitionRequests(registration);
  post("progress", sessionId, {status: "CELLS_SEGMENTED", progress: 0.18, cellCount: 29 * 6});
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
      const raw = await recognizeCell(runtime, crop);
      const normalized = htr.normalizeRecognition({
        columnId: request.columnId,
        candidates: raw.text ? [{text: raw.text, confidence: raw.confidence}] : [],
      }, {
        canonicalSlots: Array.isArray(message.canonicalSlots) ? message.canonicalSlots : [],
        vehicleCatalog: Array.isArray(message.vehicleCatalog) ? message.vehicleCatalog : [],
      });
      cells.push(Object.freeze({
        rowIndex: request.rowIndex,
        columnId: request.columnId,
        boundingBox: request.boundingBox,
        recognizedText: raw.text,
        normalizedValue: normalized.normalizedValue,
        selectedValue: normalized.selectedValue,
        confidence: normalized.confidence,
        alternatives: normalized.alternatives,
        needsReview: normalized.needsReview,
        validationState: normalized.validationState,
        recognizerVersion: htr.MODEL_SPEC.version,
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
    registrationStatus: "CELLS_SEGMENTED",
    cells: tableCells,
    metadataCells,
  });
  post("complete", sessionId, {
    result: {
      status: report.mappingStatus,
      registration: {
        status: "CELLS_SEGMENTED",
        templateVersion: registration.templateVersion,
        perspectiveCorrectionApplied: true,
        detectionConfidence: detected.confidence,
        detectionSource: detected.source,
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

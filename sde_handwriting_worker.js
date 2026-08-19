import "./sde_handwriting_recognition.js?v=22c43705f366b179af24ec2b8bcb1a8b19f109b8ebdacb2832dccd60ed55ce28";
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

function bilinearChannel(pixels, width, height, x, y, channel){
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const dx = Math.max(0, Math.min(1, x - x0));
  const dy = Math.max(0, Math.min(1, y - y0));
  const at = (sampleX, sampleY) => pixels[((sampleY * width) + sampleX) * 4 + channel];
  const top = at(x0, y0) * (1 - dx) + at(x1, y0) * dx;
  const bottom = at(x0, y1) * (1 - dx) + at(x1, y1) * dx;
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

function tightlyFittedTensor(image, width, height){
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for(let y = 0; y < height; y += 1){
    for(let x = 0; x < width; x += 1){
      if(image[(y * width) + x] >= 235) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if(maxX < minX || maxY < minY) return modelTensorFromGrayscale(image, width, height);
  minX = Math.max(0, minX - 2);
  minY = Math.max(0, minY - 2);
  maxX = Math.min(width - 1, maxX + 2);
  maxY = Math.min(height - 1, maxY + 2);
  const sourceWidth = maxX - minX + 1;
  const sourceHeight = maxY - minY + 1;
  const targetWidth = Math.max(8, Math.min(320, Math.round((sourceWidth / sourceHeight) * 48)));
  const fitted = new Uint8Array(targetWidth * 48);
  for(let y = 0; y < 48; y += 1){
    const sourceY = Math.min(maxY, minY + Math.floor((y / 48) * sourceHeight));
    for(let x = 0; x < targetWidth; x += 1){
      const sourceX = Math.min(maxX, minX + Math.floor((x / targetWidth) * sourceWidth));
      fitted[(y * targetWidth) + x] = image[(sourceY * width) + sourceX];
    }
  }
  return modelTensorFromGrayscale(fitted, targetWidth, 48);
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
  const pixelMask = new Uint8Array(width * height);
  for(let y = 0; y < height; y += 1){
    for(let x = 0; x < width; x += 1){
      if(!horizontalMask[y] && !verticalMask[x]) continue;
      const index = (y * width) + x;
      pixelMask[index] = 1;
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
    pixelMask,
    horizontalLineCount: horizontalMask.reduce((sum, value) => sum + value, 0),
    verticalLineCount: verticalMask.reduce((sum, value) => sum + value, 0),
  });
}

function preprocessingPasses(image){
  const ordered = [...image].sort((left, right) => left - right);
  const dark = percentile(ordered, 0.02);
  const paper = percentile(ordered, 0.92);
  const range = Math.max(24, paper - dark);
  const normalized = Uint8Array.from(image, value => (
    Math.max(0, Math.min(255, Math.round(((value - dark) / range) * 255)))
  ));
  return Object.freeze([
    normalized,
    Uint8Array.from(normalized, value => value < 145 ? 0 : 255),
    Uint8Array.from(normalized, value => value < 190 ? 0 : 255),
  ]);
}

function layerPreprocessingPasses(layer, grayscale){
  return preprocessingPasses(Uint8Array.from(layer, (value, index) => value === 0 ? grayscale[index] : 255));
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
  const originalCrop = new Uint8ClampedArray(resizedWidth * 48 * 4);
  for(let y = 0; y < 48; y += 1){
    const canonicalY = inner.y0 + ((y + 0.5) / 48) * (inner.y1 - inner.y0);
    for(let x = 0; x < resizedWidth; x += 1){
      const canonicalX = inner.x0 + ((x + 0.5) / resizedWidth) * (inner.x1 - inner.x0);
      const original = htr.projectPoint(inverseTransform, {x: canonicalX, y: canonicalY});
      const pixelIndex = (y * resizedWidth) + x;
      const cropOffset = pixelIndex * 4;
      for(let channel = 0; channel < 3; channel += 1){
        originalCrop[cropOffset + channel] = Math.round(bilinearChannel(pixels, imageWidth, imageHeight, original.x, original.y, channel));
      }
      originalCrop[cropOffset + 3] = 255;
      grayscale[pixelIndex] = Math.round(bilinearGray(pixels, imageWidth, imageHeight, original.x, original.y));
    }
  }
  const gridSuppression = suppressGridLinePixels(grayscale, resizedWidth, 48);
  const separated = htr.separateInkLayers({
    width: resizedWidth,
    height: 48,
    pixels: originalCrop,
    gridMask: gridSuppression.pixelMask,
    handwritingLuminanceThreshold: cell.templateId === "TEMPLATE_B" ? 130 : 190,
  });
  const adaptivePasses = preprocessingPasses(gridSuppression.image);
  const adaptiveInkPixels = [...adaptivePasses[1]].filter(value => value === 0).length;
  const templateAHandwritingOnly = cell.templateId === "TEMPLATE_A";
  const metadataField = cell.rowIndex == null;
  const combinedInkPixels = templateAHandwritingOnly
    ? adaptiveInkPixels
    : [...separated.combinedInk].filter(value => value === 0).length;
  const inkRatio = combinedInkPixels / Math.max(1, separated.combinedInk.length);
  const blankThreshold = metadataField ? 0.0005 : 0.0035;
  const blank = combinedInkPixels < Math.max(metadataField ? 3 : 5, separated.combinedInk.length * blankThreshold) || inkRatio > 0.68;
  const printPasses = templateAHandwritingOnly
    ? []
    : layerPreprocessingPasses(separated.printInk, grayscale);
  const handwritingPasses = templateAHandwritingOnly
    ? adaptivePasses
    : layerPreprocessingPasses(separated.handwritingInk, grayscale);
  const fitMetadata = metadataField && cell.templateId === "TEMPLATE_B";
  const tensorFor = image => fitMetadata
    ? tightlyFittedTensor(image, resizedWidth, 48)
    : modelTensorFromGrayscale(image, resizedWidth, 48);
  const printTensors = Object.freeze(printPasses.map(tensorFor));
  const handwritingTensors = Object.freeze(handwritingPasses.map(tensorFor));
  return Object.freeze({
    printTensors,
    handwritingTensors,
    blank,
    inkRatio,
    originalCrop,
    cropWidth: resizedWidth,
    cropHeight: 48,
    printInkRatio: templateAHandwritingOnly ? 0 : separated.printInkRatio,
    handwritingInkRatio: templateAHandwritingOnly ? inkRatio : separated.handwritingInkRatio,
    strikeThroughDetected: htr.detectStrikeThrough(
      templateAHandwritingOnly ? adaptivePasses[1] : separated.handwritingInk,
      resizedWidth,
      48,
    ),
    gridLineMask: Object.freeze({
      horizontalLineCount: gridSuppression.horizontalLineCount,
      verticalLineCount: gridSuppression.verticalLineCount,
      gridPixelCount: separated.gridPixelCount,
      adaptiveInkNormalizationApplied: templateAHandwritingOnly,
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
  if(columnId === "fromTrain" || columnId === "toTrain") return new Set("0123456789REP/¹²".split(""));
  if(columnId === "vehicleId") return new Set("0123456789-– ".split(""));
  if(columnId === "toTrack") return new Set("0123456789NSMV→>-+ ".split(""));
  if(columnId === "wcWater") return new Set("*xX()○◯✓✔√✕✖×".split(""));
  if(columnId === "arrivalTime" || columnId === "clock") return new Set("0123456789:. ".split(""));
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

async function recognizeLayer(runtime, tensors, columnId){
  const passes = [];
  for(const tensor of tensors) passes.push(await recognizeCell(runtime, tensor, columnId));
  const votes = new Map();
  for(const pass of passes){
    for(const candidate of pass.candidates){
      const current = votes.get(candidate.text) || {text: candidate.text, confidence: 0, votes: 0};
      current.confidence = Math.max(current.confidence, candidate.confidence);
      current.votes += 1;
      votes.set(candidate.text, current);
    }
  }
  const candidates = [...votes.values()]
    .map(candidate => ({
      text: candidate.text,
      confidence: candidate.votes >= 2 ? candidate.confidence : Math.min(candidate.confidence, 0.84),
      votes: candidate.votes,
    }))
    .sort((left, right) => (right.votes - left.votes) || (right.confidence - left.confidence));
  return Object.freeze({
    recognizedText: passes[0]?.unrestricted?.text || "",
    candidates: Object.freeze(candidates),
    candidate: candidates[0] ? Object.freeze({text: candidates[0].text, confidence: candidates[0].confidence}) : null,
  });
}

function emptyCellResult(cell, inkRatio){
  const unreadableCrop = inkRatio > 0.68;
  return Object.freeze({
    rowIndex: cell.rowIndex,
    columnId: cell.columnId,
    boundingBox: cell.boundingBox,
    recognizedText: "",
    rawCandidates: Object.freeze([]),
    printedCandidate: null,
    handwrittenCandidate: null,
    finalCandidate: Object.freeze({text: "", confidence: unreadableCrop ? 0 : 1}),
    normalizedValue: "",
    selectedValue: "",
    confidence: unreadableCrop ? 0 : 1,
    alternatives: Object.freeze([]),
    needsReview: unreadableCrop,
    validationState: unreadableCrop ? "CROP_UNREADABLE" : "BLANK_IMAGE_CELL",
    recognizerVersion: htr.MODEL_SPEC.version,
    recognitionMode: "HYBRID_PRINT_OCR_HTR",
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
  post("progress", sessionId, {status: "TEMPLATE_DETECTION", progress: 0.07});
  const detected = htr.detectFormRegistration({pixels, width, height});
  if(detected.source !== "FORM_GRID_RULE_SEQUENCE"
    || !["TEMPLATE_A", "TEMPLATE_B"].includes(detected.templateId)
    || ![7, 9].includes(detected.verticalLineCount)
    || detected.confidence < 0.55){
    throw new Error("form_registration_failed");
  }
  const registration = htr.registerTemplate({
    imageWidth: width,
    imageHeight: height,
    templateId: detected.templateId,
    quadrilateral: detected.corners,
    rowBoundaries: detected.canonicalRowBoundaries,
  });
  post("progress", sessionId, {status: "FORM_REGISTRATION_COMPLETE", progress: 0.12, detection: detected});
  post("progress", sessionId, {status: "TEMPLATE_REGISTERED", progress: 0.14, detection: detected});
  const requests = htr.createRecognitionRequests(registration);
  post("progress", sessionId, {status: "CELL_SEGMENTATION_COMPLETE", progress: 0.18, cellCount: 29 * registration.columnCount});
  post("progress", sessionId, {status: "PRINT_OCR_RUNNING", progress: 0.19});
  post("progress", sessionId, {status: "HANDWRITING_RECOGNITION_RUNNING", progress: 0.195});
  post("progress", sessionId, {status: "HYBRID_PRINT_OCR_HTR_RUNNING", progress: 0.2});
  const runtime = await initializeRuntime();
  const registrationRequiresReview = detected.horizontalLineCount !== 30 || detected.rowGeometryStable !== true;
  const cells = [];
  for(let index = 0; index < requests.length; index += 1){
    if(cancelledSessionId === sessionId || activeSessionId !== sessionId) throw new Error("htr_cancelled");
    const request = requests[index];
    const crop = cellInputTensor(pixels, width, height, registration.perspective.inverse, request);
    if(crop.blank){
      cells.push(emptyCellResult(request, crop.inkRatio));
    }else{
      const minimumLayerRatio = request.rowIndex == null ? 0.0003 : 0.0015;
      const printed = crop.printInkRatio >= minimumLayerRatio
        ? await recognizeLayer(runtime, crop.printTensors, request.columnId)
        : Object.freeze({recognizedText: "", candidates: Object.freeze([]), candidate: null});
      const handwritten = crop.handwritingInkRatio >= minimumLayerRatio
        ? await recognizeLayer(runtime, crop.handwritingTensors, request.columnId)
        : Object.freeze({recognizedText: "", candidates: Object.freeze([]), candidate: null});
      const context = {
        canonicalSlots: Array.isArray(message.canonicalSlots) ? message.canonicalSlots : [],
        vehicleCatalog: Array.isArray(message.vehicleCatalog) ? message.vehicleCatalog : [],
      };
      const reconciled = htr.reconcileLayerCandidates({
        columnId: request.columnId,
        printedCandidate: printed.candidate,
        handwrittenCandidate: handwritten.candidate,
        strikeThroughDetected: crop.strikeThroughDetected,
      }, context);
      const normalized = reconciled.normalized || htr.normalizeRecognition({
        columnId: request.columnId,
        candidates: reconciled.finalCandidate.text ? [reconciled.finalCandidate] : [],
      }, context);
      const rawCandidates = [...printed.candidates.map(candidate => ({...candidate, sourceLayer: "PRINT_OCR"})),
        ...handwritten.candidates.map(candidate => ({...candidate, sourceLayer: "HANDWRITING_HTR"}))];
      const recognitionFailed = !reconciled.finalCandidate.text;
      cells.push(Object.freeze({
        rowIndex: request.rowIndex,
        columnId: request.columnId,
        boundingBox: request.boundingBox,
        recognizedText: [printed.recognizedText, handwritten.recognizedText].filter(Boolean).join(" | "),
        rawCandidates: Object.freeze(rawCandidates.map(candidate => Object.freeze({...candidate}))),
        printedCandidate: reconciled.printedCandidate,
        handwrittenCandidate: reconciled.handwrittenCandidate,
        finalCandidate: reconciled.finalCandidate,
        normalizedValue: reconciled.finalCandidate.text,
        selectedValue: reconciled.finalCandidate.text,
        confidence: reconciled.finalCandidate.confidence,
        alternatives: normalized.alternatives,
        needsReview: recognitionFailed || reconciled.needsReview || registrationRequiresReview,
        validationState: recognitionFailed || reconciled.needsReview || registrationRequiresReview ? "REVIEW_REQUIRED" : normalized.validationState,
        recognizerVersion: htr.MODEL_SPEC.version,
        recognitionMode: "HYBRID_PRINT_OCR_HTR",
        sourceBoundingBox: request.boundingBox,
        normalizationReason: registrationRequiresReview
          ? "ROW_GRID_REQUIRES_REVIEW"
          : recognitionFailed
            ? "NONBLANK_CROP_UNREADABLE"
            : reconciled.reason,
        groundTruthSource: "UNCONFIRMED_RECOGNIZER_OUTPUT",
        rawRecognizerIsGroundTruth: false,
        imageEvidence: Object.freeze({
          inkRatio: crop.inkRatio,
          printInkRatio: crop.printInkRatio,
          handwritingInkRatio: crop.handwritingInkRatio,
          strikeThroughDetected: crop.strikeThroughDetected,
          gridLineMask: crop.gridLineMask,
          blank: false,
        }),
      }));
    }
    post("progress", sessionId, {
      status: "HYBRID_PRINT_OCR_HTR_RUNNING",
      progress: 0.2 + (0.72 * ((index + 1) / requests.length)),
      processedCellCount: index + 1,
      totalCellCount: requests.length,
    });
  }
  const tableCells = cells.filter(cell => cell.rowIndex != null);
  const metadataCells = cells.filter(cell => cell.rowIndex == null);
  const report = htr.buildMappingReport({
    templateId: registration.templateId,
    htrCompleted: true,
    registrationStatus: "CELL_SEGMENTATION_COMPLETE",
    cells: tableCells,
    metadataCells,
  });
  post("progress", sessionId, {
    status: report.mappingStatus === "FORM_MAPPING_COMPLETE" ? "CELL_MAPPING_COMPLETE" : "CELL_MAPPING_REQUIRES_REVIEW",
    progress: 0.98,
  });
  post("complete", sessionId, {
    result: {
      status: report.mappingStatus,
      registration: {
        status: "CELL_SEGMENTATION_COMPLETE",
        templateId: registration.templateId,
        templateVersion: registration.templateVersion,
        columnCount: registration.columnCount,
        perspectiveCorrectionApplied: true,
        detectionConfidence: detected.confidence,
        detectionSource: detected.source,
        verticalLineCount: detected.verticalLineCount,
        horizontalLineCount: detected.horizontalLineCount,
        rowGeometryStable: detected.rowGeometryStable === true,
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

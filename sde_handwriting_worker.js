import "./sde_handwriting_recognition.js?v=d6d88c3214987c685ee4bcb1bbb90f67481e6a61bdcb30a19353e7001377469d";
import * as ort from "./assets/vendor/onnxruntime-web/ort.wasm.min.mjs";

const htr = globalThis.SdeHandwritingRecognition;
const HTR_MODEL_ROOT = "assets/models/gigapdf-ocr-handwriting/";
const PRINT_MODEL_ROOT = "assets/models/latin-pp-ocrv5-mobile-rec-onnx/";
const RUNTIME_ROOT = new URL("assets/vendor/onnxruntime-web/", self.location.href).href;

ort.env.wasm.wasmPaths = RUNTIME_ROOT;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.logLevel = "error";

let runtimePromise = null;
let activeSessionId = "";
let cancelledSessionId = "";
const activeAssetControllers = new Set();
const HTR_ASSET_POLICY = Object.freeze({
  timeoutMs: 30_000,
  maxRetries: 1,
  maxBytes: 32 * 1024 * 1024,
});

function post(type, sessionId, payload = {}){
  self.postMessage({type, sessionId, ...payload});
}

function sameOriginUrl(relativePath){
  const url = new URL(relativePath, self.location.href);
  if(url.origin !== self.location.origin) throw new Error("cross_origin_htr_asset_blocked");
  return url;
}

async function sha256Hex(bytes){
  const digest = await self.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
}

function assetError(code, resource, details = {}){
  const error = new Error(code);
  error.diagnostic = Object.freeze({code, resource, ...details});
  return error;
}

async function fetchBytes(relativePath, options = {}){
  const resource = String(relativePath || "");
  const cache = String(options.cache || "force-cache");
  const expectedSha256 = String(options.expectedSha256 || "").toLowerCase();
  const acceptedContentTypes = Array.isArray(options.acceptedContentTypes)
    ? options.acceptedContentTypes.map(value => String(value).toLowerCase())
    : [];
  const requestedMaxBytes = Number(options.maxBytes);
  const maxBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes > 0
    ? Math.min(HTR_ASSET_POLICY.maxBytes, Math.floor(requestedMaxBytes))
    : HTR_ASSET_POLICY.maxBytes;
  const timeoutMs = Math.max(10, Math.min(HTR_ASSET_POLICY.timeoutMs, Number(options.timeoutMs || HTR_ASSET_POLICY.timeoutMs)));
  const startedAt = performance.now();
  let lastError = null;

  for(let attempt = 0; attempt <= HTR_ASSET_POLICY.maxRetries; attempt += 1){
    if(cancelledSessionId && cancelledSessionId === activeSessionId) throw assetError("htr_cancelled", resource);
    const controller = new AbortController();
    activeAssetControllers.add(controller);
    const timeout = setTimeout(() => controller.abort("htr_asset_timeout"), timeoutMs);
    post("progress", activeSessionId, {
      status: "HTR_ASSET_DOWNLOAD_STARTED",
      progress: 0.2,
      resource,
      attempt: attempt + 1,
      maxAttempts: HTR_ASSET_POLICY.maxRetries + 1,
    });
    try{
      const response = await fetch(sameOriginUrl(resource), {
        credentials: "same-origin",
        cache,
        redirect: "error",
        signal: controller.signal,
      });
      if(!response.ok) throw assetError(`htr_asset_http_${response.status}`, resource, {status: response.status});
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if(contentType.startsWith("text/html")
        || (acceptedContentTypes.length && !acceptedContentTypes.some(value => contentType.startsWith(value)))){
        throw assetError("htr_asset_content_type_mismatch", resource, {contentType});
      }
      const contentLengthValue = String(response.headers.get("content-length") || "").trim();
      const contentLengthPresent = contentLengthValue !== "";
      if(contentLengthPresent && !/^\d+$/.test(contentLengthValue)){
        throw assetError("htr_asset_content_length_invalid", resource, {contentLength: contentLengthValue});
      }
      const expectedBytes = contentLengthPresent ? Number(contentLengthValue) : null;
      if(expectedBytes !== null && expectedBytes > maxBytes){
        throw assetError("htr_asset_size_limit_exceeded", resource, {expectedBytes, maxBytes});
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if(bytes.byteLength > maxBytes){
        throw assetError("htr_asset_size_limit_exceeded", resource, {receivedBytes: bytes.byteLength, maxBytes});
      }
      if(expectedBytes !== null && bytes.byteLength !== expectedBytes){
        throw assetError("htr_asset_content_length_mismatch", resource, {expectedBytes, receivedBytes: bytes.byteLength});
      }
      const actualSha256 = expectedSha256 ? await sha256Hex(bytes) : "";
      if(expectedSha256 && actualSha256 !== expectedSha256){
        throw assetError("htr_asset_hash_mismatch", resource, {expectedSha256, actualSha256, receivedBytes: bytes.byteLength});
      }
      post("progress", activeSessionId, {
        status: "HTR_ASSET_DOWNLOAD_COMPLETE",
        progress: 0.2,
        resource,
        attempt: attempt + 1,
        contentType,
        expectedBytes,
        receivedBytes: bytes.byteLength,
        contentLengthPresent,
        maxBytes,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if(expectedSha256){
        post("progress", activeSessionId, {
          status: "HTR_ASSET_HASH_VERIFIED",
          progress: 0.2,
          resource,
          sha256: actualSha256,
        });
      }
      return bytes;
    }catch(error){
      lastError = controller.signal.aborted
        ? assetError("htr_asset_timeout", resource, {attempt: attempt + 1})
        : error;
      if(cancelledSessionId && cancelledSessionId === activeSessionId) throw assetError("htr_cancelled", resource);
      if(attempt < HTR_ASSET_POLICY.maxRetries){
        post("progress", activeSessionId, {
          status: "HTR_ASSET_RETRY",
          progress: 0.2,
          resource,
          attempt: attempt + 2,
          reason: String(lastError?.message || lastError),
        });
      }
    }finally{
      clearTimeout(timeout);
      activeAssetControllers.delete(controller);
    }
  }
  throw lastError || assetError("htr_asset_download_failed", resource);
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

function parseHtrDictionary(text){
  const values = String(text || "").split(/\r?\n/).filter(value => value.length > 0);
  if(values.length !== 557) throw new Error("htr_character_dictionary_invalid");
  return Object.freeze(values);
}

async function initializeRuntime(){
  if(runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const initializationStartedAt = performance.now();
    const manifestBytes = await fetchBytes(`${HTR_MODEL_ROOT}manifest.json`, {
      cache: "no-store",
      acceptedContentTypes: ["application/json"],
      maxBytes: 64 * 1024,
    });
    const manifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(manifestBytes));
    if(manifest.modelRevision !== htr.MODEL_SPEC.revision
      || manifest.files?.["model.onnx"] !== htr.MODEL_SPEC.modelSha256
      || manifest.runtime?.version !== "1.27.0"
      || manifest.runtime?.executionProvider !== "wasm"
      || manifest.networkPolicy?.remoteModelFallback !== false){
      throw new Error("htr_manifest_contract_mismatch");
    }
    const printManifestBytes = await fetchBytes(`${PRINT_MODEL_ROOT}manifest.json`, {
      cache: "no-store",
      acceptedContentTypes: ["application/json"],
      maxBytes: 64 * 1024,
    });
    const printManifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(printManifestBytes));
    if(printManifest.modelRevision !== htr.PRINT_MODEL_SPEC.revision
      || printManifest.files?.["inference.onnx"] !== htr.PRINT_MODEL_SPEC.modelSha256
      || printManifest.networkPolicy?.remoteModelFallback !== false){
      throw new Error("print_manifest_contract_mismatch");
    }
    const [modelBytes, dictionaryBytes, printModelBytes, printDictionaryBytes] = await Promise.all([
      fetchBytes(`${HTR_MODEL_ROOT}model.onnx`, {expectedSha256: manifest.files["model.onnx"], acceptedContentTypes: ["application/octet-stream"], maxBytes: 16 * 1024 * 1024}),
      fetchBytes(`${HTR_MODEL_ROOT}dict.txt`, {expectedSha256: manifest.files["dict.txt"], acceptedContentTypes: ["text/plain"], maxBytes: 64 * 1024}),
      fetchBytes(`${PRINT_MODEL_ROOT}inference.onnx`, {expectedSha256: printManifest.files["inference.onnx"], acceptedContentTypes: ["application/octet-stream"], maxBytes: 16 * 1024 * 1024}),
      fetchBytes(`${PRINT_MODEL_ROOT}inference.yml`, {expectedSha256: printManifest.files["inference.yml"], acceptedContentTypes: ["text/yaml"], maxBytes: 64 * 1024}),
    ]);
    await htr.verifyModelBytes(modelBytes, {modelSha256: manifest.files["model.onnx"]});
    await htr.verifyModelBytes(dictionaryBytes, {modelSha256: manifest.files["dict.txt"]});
    await htr.verifyModelBytes(printModelBytes, {modelSha256: printManifest.files["inference.onnx"]});
    await htr.verifyModelBytes(printDictionaryBytes, {modelSha256: printManifest.files["inference.yml"]});
    const htrCharacters = parseHtrDictionary(new TextDecoder("utf-8", {fatal: true}).decode(dictionaryBytes));
    const printCharacters = parseCharacterDictionary(new TextDecoder("utf-8", {fatal: true}).decode(printDictionaryBytes));
    const sessionOptions = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
      enableCpuMemArena: true,
      enableMemPattern: true,
    };
    const sessionStartedAt = performance.now();
    post("progress", activeSessionId, {status: "HTR_MODEL_SESSION_INITIALIZING", progress: 0.2});
    const [htrSession, printSession] = await Promise.all([
      ort.InferenceSession.create(modelBytes, sessionOptions),
      ort.InferenceSession.create(printModelBytes, sessionOptions),
    ]);
    post("progress", activeSessionId, {
      status: "HTR_MODEL_SESSION_READY",
      progress: 0.2,
      sessionDurationMs: Math.round(performance.now() - sessionStartedAt),
      initializationDurationMs: Math.round(performance.now() - initializationStartedAt),
    });
    return Object.freeze({manifest, printManifest, htrCharacters, printCharacters, htrSession, printSession});
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

function htrTensorFromGrayscale(image, width, height){
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for(let y = 0; y < height; y += 1){
    for(let x = 0; x < width; x += 1){
      if(image[(y * width) + x] >= 235) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if(maxX < minX || maxY < minY) return Object.freeze({tensor: new Float32Array(32 * 16), width: 16});
  minX = Math.max(0, minX - 2); minY = Math.max(0, minY - 2);
  maxX = Math.min(width - 1, maxX + 2); maxY = Math.min(height - 1, maxY + 2);
  const sourceWidth = maxX - minX + 1;
  const sourceHeight = maxY - minY + 1;
  const targetWidth = Math.max(16, Math.min(512, Math.round((sourceWidth / Math.max(1, sourceHeight)) * 32)));
  const tensor = new Float32Array(32 * targetWidth);
  for(let y = 0; y < 32; y += 1){
    const sourceY = Math.min(maxY, minY + Math.floor(((y + 0.5) / 32) * sourceHeight));
    for(let x = 0; x < targetWidth; x += 1){
      const sourceX = Math.min(maxX, minX + Math.floor(((x + 0.5) / targetWidth) * sourceWidth));
      tensor[(y * targetWidth) + x] = 1 - (Number(image[(sourceY * width) + sourceX]) / 255);
    }
  }
  return Object.freeze({tensor, width: targetWidth});
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
    // Form rules span essentially the full crop. A lower projection cutoff
    // erased legitimate tall handwriting strokes (notably 1, N and arrow
    // stems) before either recognizer saw them.
    if(dark >= width * 0.90) horizontalMask[y] = 1;
  }
  for(let x = 0; x < width; x += 1){
    let dark = 0;
    for(let y = 0; y < height; y += 1) if(image[(y * width) + x] < 150) dark += 1;
    if(dark >= height * 0.90) verticalMask[x] = 1;
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
  const metadataField = cell.rowIndex == null;
  const adaptiveInkPixels = [...adaptivePasses[1]].filter(value => value === 0).length;
  const templateAHandwritingOnly = cell.templateId === "TEMPLATE_A";
  const combinedInkPixels = templateAHandwritingOnly
    ? adaptiveInkPixels
    : [...separated.combinedInk].filter(value => value === 0).length;
  const inkRatio = combinedInkPixels / Math.max(1, separated.combinedInk.length);
  const blankClassification = htr.classifyBlankCell({
    image: gridSuppression.image,
    width: resizedWidth,
    height: 48,
    gridMask: gridSuppression.pixelMask,
    darkThreshold: 160,
  });
  const minimumInkRatio = metadataField ? 0.10
    : cell.columnId === "notes" || cell.columnId === "info" ? 0.085
      : cell.columnId === "wcWater" ? 0.13
        : 0.12;
  const blank = blankClassification.blank || inkRatio < minimumInkRatio || inkRatio > 0.68;
  const printPasses = templateAHandwritingOnly
    ? adaptivePasses
    : layerPreprocessingPasses(separated.printInk, grayscale);
  const handwritingPasses = templateAHandwritingOnly
    ? adaptivePasses
    : layerPreprocessingPasses(separated.handwritingInk, grayscale);
  const fitMetadata = metadataField && cell.templateId === "TEMPLATE_B";
  const tensorFor = image => fitMetadata
    ? tightlyFittedTensor(image, resizedWidth, 48)
    : modelTensorFromGrayscale(image, resizedWidth, 48);
  const printTensors = Object.freeze([
    ...printPasses.map(tensorFor),
    // A tightly fitted pass preserves faint terminal glyphs (N/S/M and
    // occurrence marks) that occupy only a small part of a wide table cell.
    tightlyFittedTensor(printPasses[0], resizedWidth, 48),
  ]);
  const handwritingTensors = Object.freeze(handwritingPasses.map(tensorFor));
  return Object.freeze({
    printTensors,
    handwritingTensors,
    handwritingImages: Object.freeze(handwritingPasses),
    symbolImage: adaptivePasses[1],
    symbolWidth: resizedWidth,
    symbolHeight: 48,
    blank,
    inkRatio,
    originalCrop,
    cropWidth: resizedWidth,
    cropHeight: 48,
    printInkRatio: templateAHandwritingOnly ? inkRatio : separated.printInkRatio,
    handwritingInkRatio: templateAHandwritingOnly ? inkRatio : separated.handwritingInkRatio,
    strikeThroughDetected: false,
    gridLineMask: Object.freeze({
      horizontalLineCount: gridSuppression.horizontalLineCount,
      verticalLineCount: gridSuppression.verticalLineCount,
      gridPixelCount: separated.gridPixelCount,
      adaptiveInkNormalizationApplied: templateAHandwritingOnly,
    }),
    blankClassification,
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
  const output = await runtime.printSession.run({
    x: new ort.Tensor("float32", tensor, [1, 3, 48, 320]),
  });
  const unrestricted = decodeCtc(output.fetch_name_0, runtime.printCharacters);
  const alphabet = recognitionAlphabet(columnId);
  const constrained = alphabet ? decodeCtc(output.fetch_name_0, runtime.printCharacters, alphabet) : unrestricted;
  const candidates = [];
  for(const candidate of [constrained, unrestricted]){
    if(!candidate.text || candidates.some(value => value.text === candidate.text)) continue;
    candidates.push(candidate);
  }
  return Object.freeze({unrestricted, candidates: Object.freeze(candidates)});
}

function decodeHtrCtc(output, characters, allowedCharacters = null){
  const timeSteps = Number(output.dims[1]);
  const classCount = Number(output.dims[2]);
  const blankIndex = classCount - 1;
  const allowedIndexes = allowedCharacters == null
    ? null
    : [...characters.map((character, index) => allowedCharacters.has(character) ? index : -1).filter(index => index >= 0), blankIndex];
  let previous = blankIndex;
  let text = "";
  let confidenceSum = 0;
  let characterCount = 0;
  for(let time = 0; time < timeSteps; time += 1){
    const offset = time * classCount;
    const indexes = allowedIndexes || Array.from({length: classCount}, (_unused, index) => index);
    let bestIndex = blankIndex;
    let bestLogit = Number.NEGATIVE_INFINITY;
    let maximumLogit = Number.NEGATIVE_INFINITY;
    for(let index = 0; index < classCount; index += 1) maximumLogit = Math.max(maximumLogit, Number(output.data[offset + index]));
    let denominator = 0;
    for(let index = 0; index < classCount; index += 1) denominator += Math.exp(Number(output.data[offset + index]) - maximumLogit);
    for(const index of indexes){
      const logit = Number(output.data[offset + index]);
      if(logit > bestLogit){ bestLogit = logit; bestIndex = index; }
    }
    if(bestIndex !== blankIndex && bestIndex !== previous){
      text += characters[bestIndex] || "";
      confidenceSum += Math.exp(bestLogit - maximumLogit) / Math.max(Number.EPSILON, denominator);
      characterCount += 1;
    }
    previous = bestIndex;
  }
  return Object.freeze({text: text.trim(), confidence: characterCount ? confidenceSum / characterCount : 0});
}

async function recognizeHtrCell(runtime, image, width, height, columnId){
  const prepared = htrTensorFromGrayscale(image, width, height);
  const output = await runtime.htrSession.run({
    x: new ort.Tensor("float32", prepared.tensor, [1, 1, 32, prepared.width]),
  });
  const logits = output.logits || output[Object.keys(output)[0]];
  const unrestricted = decodeHtrCtc(logits, runtime.htrCharacters);
  const candidates = [];
  for(const candidate of [unrestricted]){
    if(!candidate.text || candidates.some(value => value.text === candidate.text)) continue;
    candidates.push(candidate);
  }
  return Object.freeze({unrestricted, candidates: Object.freeze(candidates)});
}

async function recognizeHtrLayer(runtime, images, width, height, columnId){
  const passes = [];
  for(const image of images) passes.push(await recognizeHtrCell(runtime, image, width, height, columnId));
  const votes = new Map();
  for(const pass of passes){
    for(const candidate of pass.candidates){
      const current = votes.get(candidate.text) || {text: candidate.text, confidence: 0, votes: 0};
      current.confidence = Math.max(current.confidence, candidate.confidence);
      current.votes += 1;
      votes.set(candidate.text, current);
    }
  }
  const candidates = [...votes.values()].sort((left, right) => (right.votes - left.votes) || (right.confidence - left.confidence));
  return Object.freeze({
    recognizedText: passes[0]?.unrestricted?.text || "",
    candidates: Object.freeze(candidates),
    candidate: candidates[0] ? Object.freeze({...candidates[0]}) : null,
  });
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
    candidate: candidates[0] ? Object.freeze({...candidates[0]}) : null,
  });
}

function segmentStructuredGlyphs(image, width, height){
  const projection = Array.from({length: width}, () => 0);
  for(let y = 2; y < height - 2; y += 1){
    for(let x = 2; x < width - 2; x += 1){
      if(image[(y * width) + x] === 0) projection[x] += 1;
    }
  }
  const runs = [];
  let start = -1;
  let blankColumns = 0;
  for(let x = 2; x < width - 2; x += 1){
    if(projection[x] > 0){
      if(start < 0) start = x;
      blankColumns = 0;
    }else if(start >= 0){
      blankColumns += 1;
      if(blankColumns >= 3){
        const end = x - blankColumns;
        if(end >= start) runs.push({x0: start, x1: end});
        start = -1;
      }
    }
  }
  if(start >= 0) runs.push({x0: start, x1: width - 3});
  return runs.map(run => {
    let y0 = height;
    let y1 = 0;
    let ink = 0;
    for(let y = 2; y < height - 2; y += 1){
      for(let x = run.x0; x <= run.x1; x += 1){
        if(image[(y * width) + x] !== 0) continue;
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        ink += 1;
      }
    }
    return {...run, y0, y1, ink};
  }).filter(run => run.ink >= 5 && run.y1 >= run.y0);
}

async function recognizeStructuredSegments(runtime, crop, columnId){
  if(columnId !== "toTrack") return Object.freeze({candidate: null, diagnostics: null});
  const glyphs = segmentStructuredGlyphs(crop.symbolImage, crop.symbolWidth, crop.symbolHeight)
    .filter(glyph => (glyph.y1 - glyph.y0 + 1) >= crop.symbolHeight * 0.24);
  if(glyphs.length < 2 || glyphs.length > 7) return Object.freeze({
    candidate: null,
    diagnostics: Object.freeze({glyphCount: glyphs.length, characters: Object.freeze([])}),
  });
  let text = "";
  let confidence = 1;
  const characters = [];
  for(let glyphIndex = 0; glyphIndex < glyphs.length; glyphIndex += 1){
    const glyph = glyphs[glyphIndex];
    const padding = 3;
    const glyphWidth = glyph.x1 - glyph.x0 + 1;
    const isolatedWidth = glyphWidth + (padding * 2);
    const isolated = new Uint8Array(isolatedWidth * crop.symbolHeight).fill(255);
    for(let y = Math.max(0, glyph.y0 - 1); y <= Math.min(crop.symbolHeight - 1, glyph.y1 + 1); y += 1){
      for(let x = glyph.x0; x <= glyph.x1; x += 1){
        isolated[(y * isolatedWidth) + (x - glyph.x0) + padding] = crop.symbolImage[(y * crop.symbolWidth) + x];
      }
    }
    const recognized = await recognizeCell(runtime, tightlyFittedTensor(isolated, isolatedWidth, crop.symbolHeight), columnId);
    const normalizedCharacters = recognized.candidates.map(candidate => ({...candidate, text: candidate.text.toUpperCase().replace(/\s+/g, "")}));
    const edgeBorder = (glyphIndex === 0 || glyphIndex === glyphs.length - 1)
      && normalizedCharacters.some(candidate => /^[I|\[\]]$/.test(candidate.text));
    const character = edgeBorder ? null : normalizedCharacters.find(candidate => /^[0-9NSM>]{1,3}$/.test(candidate.text));
    characters.push(Object.freeze({
      raw: recognized.candidates.map(candidate => candidate.text).slice(0, 2),
      accepted: character?.text || "",
      ignoredBorder: edgeBorder,
    }));
    if(!character) continue;
    text += character.text;
    confidence = Math.min(confidence, character.confidence);
  }
  const complete = characters.every(character => character.accepted || character.ignoredBorder);
  return Object.freeze({
    candidate: complete && text ? Object.freeze({text, confidence, votes: 1}) : null,
    diagnostics: Object.freeze({glyphCount: glyphs.length, characters: Object.freeze(characters)}),
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
    suggestedValue: "",
    disposition: unreadableCrop ? "REJECTED" : "EMPTY",
    confidence: unreadableCrop ? 0 : 1,
    alternatives: Object.freeze([]),
    needsReview: unreadableCrop,
    validationState: unreadableCrop ? "CROP_UNREADABLE" : "BLANK_IMAGE_CELL",
    recognizerVersion: htr.MODEL_SPEC.version,
    recognitionMode: "LOCAL_REAL_HTR_ENSEMBLE",
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
    || detected.confidence < 0.55
    || detected.horizontalLineCount !== 30
    || detected.rowGeometryStable !== true){
    throw new Error(htr.formRegistrationFailureMessage(detected));
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
  post("progress", sessionId, {status: "LOCAL_REAL_HTR_ENSEMBLE_RUNNING", progress: 0.2});
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
      const visualSymbol = request.columnId === "wcWater"
        ? htr.classifyWcWaterSymbol({image: crop.symbolImage, width: crop.symbolWidth, height: crop.symbolHeight})
        : null;
      const structuredGlyph = request.columnId === "toTrack"
        ? htr.classifySingleStrokeGlyph({image: crop.symbolImage, width: crop.symbolWidth, height: crop.symbolHeight})
        : null;
      const geometricCandidate = visualSymbol?.symbol || structuredGlyph?.value || "";
      const geometricConfidence = visualSymbol?.symbol ? visualSymbol.confidence : structuredGlyph?.confidence;
      const printed = geometricCandidate
        ? Object.freeze({recognizedText: geometricCandidate, candidates: Object.freeze([{text: geometricCandidate, confidence: geometricConfidence, votes: 3}]), candidate: Object.freeze({text: geometricCandidate, confidence: geometricConfidence, votes: 3})})
        : crop.printInkRatio >= minimumLayerRatio
        ? await recognizeLayer(runtime, crop.printTensors, request.columnId)
        : Object.freeze({recognizedText: "", candidates: Object.freeze([]), candidate: null});
      const handwritten = geometricCandidate
        ? Object.freeze({recognizedText: geometricCandidate, candidates: Object.freeze([{text: geometricCandidate, confidence: geometricConfidence, votes: 3}]), candidate: Object.freeze({text: geometricCandidate, confidence: geometricConfidence, votes: 3})})
        : crop.handwritingInkRatio >= minimumLayerRatio
        ? await recognizeHtrLayer(runtime, crop.handwritingImages, crop.cropWidth, crop.cropHeight, request.columnId)
        : Object.freeze({recognizedText: "", candidates: Object.freeze([]), candidate: null});
      const structuredSegmentResult = geometricCandidate
        ? Object.freeze({candidate: null, diagnostics: null})
        : await recognizeStructuredSegments(runtime, crop, request.columnId);
      const structuredSegmentCandidate = structuredSegmentResult.candidate;
      const context = {
        canonicalSlots: Array.isArray(message.canonicalSlots) ? message.canonicalSlots : [],
        vehicleCatalog: Array.isArray(message.vehicleCatalog) ? message.vehicleCatalog : [],
        trainCatalog: Array.isArray(message.trainCatalog) ? message.trainCatalog : [],
      };
      const reconciled = htr.reconcileLayerCandidates({
        columnId: request.columnId,
        printedCandidate: printed.candidate,
        handwrittenCandidate: handwritten.candidate,
        strikeThroughDetected: crop.strikeThroughDetected,
      }, context);
      const rawCandidates = [...printed.candidates.map(candidate => ({...candidate, sourceLayer: "PRINT_OCR"})),
        ...handwritten.candidates.map(candidate => ({...candidate, sourceLayer: "HANDWRITING_HTR"})),
        ...(structuredSegmentCandidate ? [{...structuredSegmentCandidate, sourceLayer: "STRUCTURED_SEGMENT_OCR"}] : [])];
      const normalized = htr.normalizeRecognition({
        columnId: request.columnId,
        candidates: rawCandidates,
      }, context);
      const recognitionFailed = rawCandidates.length === 0;
      const inkLayerConflict = Boolean(
        printed.candidate
        && handwritten.candidate
        && String(printed.candidate.text || "") !== String(handwritten.candidate.text || "")
        && crop.handwritingInkRatio >= crop.printInkRatio * 1.10
      );
      const explicitLayerConflict = ["PRINT_HANDWRITING_CONFLICT", "STRIKETHROUGH_OR_CORRECTION"].includes(reconciled.reason);
      const layerReview = explicitLayerConflict || inkLayerConflict;
      const layerReviewReason = inkLayerConflict ? "PRINT_HANDWRITING_INK_CONFLICT" : reconciled.reason;
      const layerReviewCanSuggest = layerReview && normalized.disposition !== "REJECTED" && Boolean(normalized.normalizedValue);
      const effectiveDisposition = layerReviewCanSuggest ? "REVIEW_SUGGESTION" : normalized.disposition;
      const effectiveSelectedValue = layerReview ? "" : normalized.selectedValue;
      const effectiveSuggestedValue = layerReviewCanSuggest ? normalized.normalizedValue : normalized.suggestedValue;
      const finalCandidate = Object.freeze({
        text: normalized.normalizedValue,
        confidence: normalized.confidence,
        votes: normalized.consensusVotes,
      });
      cells.push(Object.freeze({
        rowIndex: request.rowIndex,
        columnId: request.columnId,
        boundingBox: request.boundingBox,
        recognizedText: [printed.recognizedText, handwritten.recognizedText].filter(Boolean).join(" | "),
        rawCandidates: Object.freeze(rawCandidates.map(candidate => Object.freeze({...candidate}))),
        printedCandidate: reconciled.printedCandidate,
        handwrittenCandidate: reconciled.handwrittenCandidate,
        finalCandidate,
        normalizedValue: normalized.normalizedValue,
        selectedValue: effectiveSelectedValue,
        suggestedValue: effectiveSuggestedValue,
        disposition: effectiveDisposition,
        confidence: normalized.confidence,
        alternatives: normalized.alternatives,
        needsReview: recognitionFailed || layerReview || normalized.needsReview || registrationRequiresReview,
        validationState: recognitionFailed || layerReview || normalized.needsReview || registrationRequiresReview ? "REVIEW_REQUIRED" : normalized.validationState,
        recognizerVersion: htr.MODEL_SPEC.version,
        recognitionMode: "LOCAL_REAL_HTR_ENSEMBLE",
        sourceBoundingBox: request.boundingBox,
        normalizationReason: registrationRequiresReview
          ? "ROW_GRID_REQUIRES_REVIEW"
          : recognitionFailed
            ? "NONBLANK_CROP_UNREADABLE"
            : layerReview
              ? layerReviewReason
              : normalized.normalizationReason,
        groundTruthSource: "UNCONFIRMED_RECOGNIZER_OUTPUT",
        rawRecognizerIsGroundTruth: false,
        imageEvidence: Object.freeze({
          inkRatio: crop.inkRatio,
          printInkRatio: crop.printInkRatio,
          handwritingInkRatio: crop.handwritingInkRatio,
          strikeThroughDetected: crop.strikeThroughDetected,
          gridLineMask: crop.gridLineMask,
          blank: false,
          blankClassification: crop.blankClassification,
          symbolClassification: visualSymbol,
          structuredGlyphClassification: structuredGlyph,
        }),
      }));
    }
    post("progress", sessionId, {
      status: "LOCAL_REAL_HTR_ENSEMBLE_RUNNING",
      progress: 0.2 + (0.72 * ((index + 1) / requests.length)),
      processedCellCount: index + 1,
      totalCellCount: requests.length,
    });
  }
  const tableCellsBeforeOccurrenceReview = cells.filter(cell => cell.rowIndex != null);
  const occurrenceGroups = new Map();
  for(const cell of tableCellsBeforeOccurrenceReview){
    if(!["fromTrain", "toTrain"].includes(cell.columnId)) continue;
    const value = String(cell.normalizedValue || "");
    const match = value.match(/^(\d{3})([¹²])?$/);
    if(!match) continue;
    const key = `${cell.columnId}:${match[1]}`;
    const group = occurrenceGroups.get(key) || [];
    group.push({cell, occurrence: match[2] || ""});
    occurrenceGroups.set(key, group);
  }
  const occurrenceUpdates = new Map();
  for(const group of occurrenceGroups.values()){
    if(group.length !== 2) continue;
    const ordered = [...group].sort((left, right) => left.cell.rowIndex - right.cell.rowIndex);
    const occurrences = ordered.map(item => item.occurrence);
    const base = String(ordered[0].cell.normalizedValue || "").replace(/[¹²]$/, "");
    const trainCatalog = new Set((Array.isArray(message.trainCatalog) ? message.trainCatalog : []).map(value => String(value || "")));
    const catalogConfirmsPair = (trainCatalog.has(`${base}¹`) && trainCatalog.has(`${base}²`))
      || (trainCatalog.has(`${base}/1`) && trainCatalog.has(`${base}/2`));
    if(occurrences[0] === "" && occurrences[1] === "²"){
      occurrenceUpdates.set(ordered[0].cell, "¹");
      occurrenceUpdates.set(ordered[1].cell, "²");
    }else if(occurrences[0] === "¹" && occurrences[1] === ""){
      occurrenceUpdates.set(ordered[1].cell, "²");
    }else if(occurrences[0] === "" && occurrences[1] === "" && catalogConfirmsPair){
      occurrenceUpdates.set(ordered[0].cell, "¹");
      occurrenceUpdates.set(ordered[1].cell, "²");
    }
  }
  const tableCells = tableCellsBeforeOccurrenceReview.map(cell => {
    const occurrence = occurrenceUpdates.get(cell);
    if(!occurrence) return cell;
    const base = String(cell.normalizedValue || "").replace(/[¹²]$/, "");
    const normalizedValue = `${base}${occurrence}`;
    const explicitConflict = [
      "PRINT_HANDWRITING_CONFLICT", "PRINT_HANDWRITING_INK_CONFLICT",
      "STRIKETHROUGH_OR_CORRECTION", "ROW_GRID_REQUIRES_REVIEW",
    ].includes(cell.normalizationReason);
    const documentPairAccepted = !explicitConflict
      && Number(cell.finalCandidate?.votes || 0) >= 2
      && Number(cell.confidence || 0) >= 0.40;
    const disposition = documentPairAccepted ? "AUTO_ACCEPTED" : cell.disposition;
    const selectedValue = disposition === "AUTO_ACCEPTED" ? normalizedValue : "";
    const suggestedValue = disposition === "REVIEW_SUGGESTION" ? normalizedValue : "";
    return Object.freeze({
      ...cell,
      normalizedValue,
      selectedValue,
      suggestedValue,
      disposition,
      needsReview: documentPairAccepted ? false : cell.needsReview,
      validationState: documentPairAccepted ? "VALID" : cell.validationState,
      finalCandidate: Object.freeze({...cell.finalCandidate, text: normalizedValue}),
      alternatives: Object.freeze([normalizedValue, ...cell.alternatives.filter(value => value !== normalizedValue)]),
      normalizationReason: documentPairAccepted
        ? "DOCUMENT_OCCURRENCE_PAIR_CONFIRMED"
        : "DOCUMENT_OCCURRENCE_SEQUENCE_CONFIRMED",
    });
  });
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
        modelType: "REAL_LOCAL_HTR",
        printModel: {
          id: htr.PRINT_MODEL_SPEC.id,
          revision: htr.PRINT_MODEL_SPEC.revision,
          sha256: htr.PRINT_MODEL_SPEC.modelSha256,
          hashVerified: true,
        },
      },
    },
  });
}

self.addEventListener("message", event => {
  const message = event.data || {};
  if(message.type === "cancel"){
    cancelledSessionId = String(message.sessionId || activeSessionId || "");
    activeAssetControllers.forEach(controller => controller.abort("htr_cancelled"));
    return;
  }
  if(message.type !== "analyze") return;
  analyze(message).catch(error => {
    post("error", String(message.sessionId || ""), {error: String(error?.message || error)});
  });
});

post("ready", "", {status: "HTR_WORKER_READY", runtime: "onnxruntime-web@1.27.0", executionProvider: "wasm"});

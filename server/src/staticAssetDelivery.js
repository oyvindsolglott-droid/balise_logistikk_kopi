"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CACHE_POLICIES = Object.freeze({
  APPLICATION: "private, max-age=600, must-revalidate",
  IMMUTABLE_VENDOR: "private, max-age=31536000, immutable",
  RUNTIME_METADATA: "no-store",
});

const ASSET_DEFINITIONS = Object.freeze([
  definition("/sde_intelligent_night_planning.js", ".", "sde_intelligent_night_planning.js", "application/javascript; charset=utf-8", CACHE_POLICIES.APPLICATION),
  definition("/sde_night_planning_ui.js", ".", "sde_night_planning_ui.js", "application/javascript; charset=utf-8", CACHE_POLICIES.APPLICATION),
  definition("/sde_handwriting_recognition.js", ".", "sde_handwriting_recognition.js", "application/javascript; charset=utf-8", CACHE_POLICIES.APPLICATION),
  definition("/sde_handwriting_runtime.js", ".", "sde_handwriting_runtime.js", "application/javascript; charset=utf-8", CACHE_POLICIES.APPLICATION),
  definition("/sde_handwriting_worker.js", ".", "sde_handwriting_worker.js", "application/javascript; charset=utf-8", CACHE_POLICIES.APPLICATION),
  definition("/sde_tursatt_post_arrival.js", ".", "sde_tursatt_post_arrival.js", "application/javascript; charset=utf-8", CACHE_POLICIES.APPLICATION),
  definition("/sde_tursatt_live_arrival.js", ".", "sde_tursatt_live_arrival.js", "application/javascript; charset=utf-8", CACHE_POLICIES.APPLICATION),
  definition("/assets/registrer-plan-i-sde-button.png", "assets", "registrer-plan-i-sde-button.png", "image/png", CACHE_POLICIES.APPLICATION),
  definition("/assets/vendor/tesseract/tesseract.min.js", "assets/vendor/tesseract", "tesseract.min.js", "application/javascript; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/tesseract/worker.min.js", "assets/vendor/tesseract", "worker.min.js", "application/javascript; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/tesseract-core/tesseract-core-lstm.wasm.js", "assets/vendor/tesseract-core", "tesseract-core-lstm.wasm.js", "application/javascript; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js", "assets/vendor/tesseract-core", "tesseract-core-simd-lstm.wasm.js", "application/javascript; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js", "assets/vendor/tesseract-core", "tesseract-core-relaxedsimd-lstm.wasm.js", "application/javascript; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/tessdata/nor.traineddata.gz", "assets/vendor/tessdata", "nor.traineddata.gz", "application/gzip", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/tessdata/eng.traineddata.gz", "assets/vendor/tessdata", "eng.traineddata.gz", "application/gzip", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/onnxruntime-web/ort.wasm.min.mjs", "assets/vendor/onnxruntime-web", "ort.wasm.min.mjs", "application/javascript; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs", "assets/vendor/onnxruntime-web", "ort-wasm-simd-threaded.mjs", "application/javascript; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm", "assets/vendor/onnxruntime-web", "ort-wasm-simd-threaded.wasm", "application/wasm", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/models/gigapdf-ocr-handwriting/manifest.json", "assets/models/gigapdf-ocr-handwriting", "manifest.json", "application/json; charset=utf-8", CACHE_POLICIES.RUNTIME_METADATA),
  definition("/assets/models/gigapdf-ocr-handwriting/model.onnx", "assets/models/gigapdf-ocr-handwriting", "model.onnx", "application/octet-stream", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/models/gigapdf-ocr-handwriting/dict.txt", "assets/models/gigapdf-ocr-handwriting", "dict.txt", "text/plain; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/models/latin-pp-ocrv5-mobile-rec-onnx/manifest.json", "assets/models/latin-pp-ocrv5-mobile-rec-onnx", "manifest.json", "application/json; charset=utf-8", CACHE_POLICIES.RUNTIME_METADATA),
  definition("/assets/models/latin-pp-ocrv5-mobile-rec-onnx/inference.onnx", "assets/models/latin-pp-ocrv5-mobile-rec-onnx", "inference.onnx", "application/octet-stream", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/assets/models/latin-pp-ocrv5-mobile-rec-onnx/inference.yml", "assets/models/latin-pp-ocrv5-mobile-rec-onnx", "inference.yml", "text/yaml; charset=utf-8", CACHE_POLICIES.IMMUTABLE_VENDOR),
  definition("/config/sde-night-intelligence.json", "config", "sde-night-intelligence.json", "application/json; charset=utf-8", CACHE_POLICIES.RUNTIME_METADATA),
  definition("/models/sde/production-model.json", "models/sde", "production-model.json", "application/json; charset=utf-8", CACHE_POLICIES.RUNTIME_METADATA),
  definition("/models/sde/model-registry.json", "models/sde", "model-registry.json", "application/json; charset=utf-8", CACHE_POLICIES.RUNTIME_METADATA),
]);

function createApprovedStaticAssetHandler({repositoryRoot}){
  const manifest = buildManifest(repositoryRoot);
  return async function approvedStaticAssetHandler(req, res, next){
    if(req.method !== "GET" && req.method !== "HEAD") return next();

    const requestPath = normalizeAssetRequestPath(req.originalUrl || req.url || "");
    if(!requestPath) return next();
    const approved = manifest.get(requestPath);
    if(!approved) return next();

    const resolved = resolveFileWithinRoot(approved.rootPath, approved.relativePath);
    if(!resolved.ok || !resolved.stat.isFile()){
      return sendNotFound(res);
    }

    let bytes;
    try{
      bytes = await fs.promises.readFile(resolved.filePath);
    }catch(_error){
      return sendNotFound(res);
    }

    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    res.status(200);
    res.set("Content-Type", approved.contentType);
    res.set("Content-Length", String(bytes.length));
    res.set("Cache-Control", approved.cacheControl);
    res.set("ETag", `"sha256-${digest}"`);
    res.set("Last-Modified", resolved.stat.mtime.toUTCString());
    res.set("X-Content-Type-Options", "nosniff");
    if(req.method === "HEAD") return res.end();
    return res.send(bytes);
  };
}

function buildManifest(repositoryRoot){
  const root = path.resolve(String(repositoryRoot || ""));
  return new Map(ASSET_DEFINITIONS.map(item => [
    item.requestPath,
    Object.freeze({
      ...item,
      rootPath: path.resolve(root, item.rootRelativePath),
    }),
  ]));
}

function normalizeAssetRequestPath(rawUrl){
  if(typeof rawUrl !== "string" || !rawUrl) return null;
  const queryIndex = rawUrl.indexOf("?");
  const encodedPath = (queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl).split("#", 1)[0];
  if(!encodedPath.startsWith("/") || encodedPath.startsWith("//")) return null;
  if(encodedPath.includes("\\") || encodedPath.includes("\0")) return null;

  let decodedPath = encodedPath;
  for(let round = 0; round < 3; round += 1){
    if(!/%[0-9a-f]{2}/i.test(decodedPath)) break;
    let next;
    try{
      next = decodeURIComponent(decodedPath);
    }catch(_error){
      return null;
    }
    if(next === decodedPath) break;
    decodedPath = next;
  }

  if(decodedPath !== encodedPath) return null;
  if(/%[0-9a-f]{2}/i.test(decodedPath)) return null;
  if(decodedPath.includes("\\") || decodedPath.includes("\0") || decodedPath.startsWith("//")) return null;
  const segments = decodedPath.split("/").filter(Boolean);
  if(segments.some(segment => segment === "." || segment === ".." || segment.startsWith("."))) return null;
  if(path.posix.normalize(decodedPath) !== decodedPath) return null;
  return decodedPath;
}

function resolveFileWithinRoot(rootPath, relativePath){
  let realRoot;
  let candidate;
  let realFile;
  let stat;
  try{
    realRoot = fs.realpathSync(path.resolve(rootPath));
    candidate = path.resolve(realRoot, relativePath);
    const candidateRelative = path.relative(realRoot, candidate);
    if(isOutside(candidateRelative)) return {ok: false, reason: "outside_root"};
    realFile = fs.realpathSync(candidate);
    const realRelative = path.relative(realRoot, realFile);
    if(isOutside(realRelative)) return {ok: false, reason: "symlink_outside_root"};
    stat = fs.statSync(realFile);
  }catch(_error){
    return {ok: false, reason: "unavailable"};
  }
  return {ok: true, filePath: realFile, stat};
}

function isOutside(relativePath){
  return relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

function definition(requestPath, rootRelativePath, relativePath, contentType, cacheControl){
  return Object.freeze({requestPath, rootRelativePath, relativePath, contentType, cacheControl});
}

function sendNotFound(res){
  return res.status(404).json({ok: false, error: "not_found"});
}

module.exports = {
  ASSET_DEFINITIONS,
  CACHE_POLICIES,
  buildManifest,
  createApprovedStaticAssetHandler,
  normalizeAssetRequestPath,
  resolveFileWithinRoot,
};

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const WORKER_SOURCE = fs.readFileSync(path.join(ROOT, "sde_handwriting_worker.js"), "utf8")
  .replace(/^import .*;$/gm, "");

function headers(values) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {get(name) { return normalized.get(String(name).toLowerCase()) || null; }};
}

function response(body, options = {}) {
  const bytes = Buffer.from(body);
  const headerValues = {
    "content-type": options.contentType || "application/octet-stream",
  };
  if (!options.omitContentLength) {
    headerValues["content-length"] = options.contentLength == null ? bytes.length : options.contentLength;
  }
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers: headers(headerValues),
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  };
}

function loadWorker(fetchImplementation) {
  const messages = [];
  const listeners = new Map();
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    Uint8Array,
    Uint8ClampedArray,
    URL,
    fetch: fetchImplementation,
    performance,
    setTimeout,
    clearTimeout,
    crypto: crypto.webcrypto,
    location: {href: "https://sde.invalid/sde_handwriting_worker.js", origin: "https://sde.invalid"},
    SdeHandwritingRecognition: {},
    ort: {env: {wasm: {}}, InferenceSession: {create: async () => ({})}},
  });
  context.globalThis = context;
  context.self = context;
  context.postMessage = message => messages.push(message);
  context.addEventListener = (type, listener) => listeners.set(type, listener);
  vm.runInContext(WORKER_SOURCE, context, {filename: "sde_handwriting_worker.js"});
  return {context, messages, listeners};
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

test("complete model response verifies length, content type and SHA", async () => {
  const body = Buffer.from("complete-model-bytes");
  const {context, messages} = loadWorker(async () => response(body));
  const bytes = await context.fetchBytes("assets/model.onnx", {
    expectedSha256: sha256(body),
    acceptedContentTypes: ["application/octet-stream"],
  });
  assert.equal(bytes.byteLength, body.length);
  assert.ok(messages.some(message => message.status === "HTR_ASSET_DOWNLOAD_COMPLETE" && message.receivedBytes === body.length));
  assert.ok(messages.some(message => message.status === "HTR_ASSET_HASH_VERIFIED" && message.sha256 === sha256(body)));
});

test("HTTP/2 manifest without Content-Length remains bounded and readable", async () => {
  const body = Buffer.from('{"schemaVersion":"sde-local-htr-model-manifest-v2"}');
  const {context, messages} = loadWorker(async () => response(body, {
    contentType: "application/json",
    omitContentLength: true,
  }));
  const bytes = await context.fetchBytes("assets/models/gigapdf-ocr-handwriting/manifest.json", {
    acceptedContentTypes: ["application/json"],
    maxBytes: 64 * 1024,
  });
  assert.equal(bytes.byteLength, body.length);
  assert.ok(messages.some(message => message.status === "HTR_ASSET_DOWNLOAD_COMPLETE"
    && message.contentLengthPresent === false
    && message.expectedBytes === null
    && message.receivedBytes === body.length));
});

test("headerless response still fails closed above its explicit byte limit", async () => {
  const body = Buffer.alloc(65, 1);
  let calls = 0;
  const {context} = loadWorker(async () => {
    calls += 1;
    return response(body, {omitContentLength: true});
  });
  await assert.rejects(
    context.fetchBytes("assets/oversized.bin", {maxBytes: 64}),
    /htr_asset_size_limit_exceeded/,
  );
  assert.equal(calls, 2, "one clean retry and no third request");
});

for (const scenario of [
  {
    name: "404 is a real local asset error",
    create: () => response("missing", {ok: false, status: 404, contentType: "application/json"}),
    expected: "htr_asset_http_404",
  },
  {
    name: "HTML login fallback is rejected",
    create: () => response("<html>login</html>", {contentType: "text/html; charset=utf-8"}),
    expected: "htr_asset_content_type_mismatch",
  },
  {
    name: "truncated body is rejected",
    create: () => response("short", {contentLength: 100}),
    expected: "htr_asset_content_length_mismatch",
  },
  {
    name: "wrong model hash is rejected",
    create: () => response("wrong-hash"),
    expected: "htr_asset_hash_mismatch",
    hash: sha256("expected-body"),
  },
]) test(scenario.name, async () => {
  let calls = 0;
  const {context} = loadWorker(async () => { calls += 1; return scenario.create(); });
  await assert.rejects(
    context.fetchBytes("assets/model.onnx", {
      expectedSha256: scenario.hash || "",
      acceptedContentTypes: ["application/octet-stream"],
    }),
    new RegExp(scenario.expected),
  );
  assert.equal(calls, 2, "one clean retry and no third request");
});

test("hanging response is aborted and retried at most once", async () => {
  let calls = 0;
  const {context} = loadWorker((_url, options) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true});
    });
  });
  await assert.rejects(
    context.fetchBytes("assets/model.onnx", {timeoutMs: 15}),
    /htr_asset_timeout/,
  );
  assert.equal(calls, 2);
});

test("a transient failure gets one clean retry and then succeeds", async () => {
  const body = Buffer.from("retry-success");
  let calls = 0;
  const {context, messages} = loadWorker(async () => {
    calls += 1;
    if(calls === 1) throw new Error("temporary-network-failure");
    return response(body);
  });
  const bytes = await context.fetchBytes("assets/model.onnx", {
    expectedSha256: sha256(body),
    acceptedContentTypes: ["application/octet-stream"],
  });
  assert.equal(bytes.byteLength, body.length);
  assert.equal(calls, 2);
  assert.equal(messages.filter(message => message.status === "HTR_ASSET_RETRY").length, 1);
});

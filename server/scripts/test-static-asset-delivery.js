"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {DatabaseSync} = require("node:sqlite");
const {
  normalizeAssetRequestPath,
  resolveFileWithinRoot,
} = require("../src/staticAssetDelivery");

const SERVER_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(SERVER_ROOT, "..");
const HOST = "127.0.0.1";
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sde-static-assets-"));
const DATABASE_PATH = path.join(TEMP_ROOT, "sde-static-assets.sqlite3");
const LOG_PATH = path.join(TEMP_ROOT, "server.log");

const ASSETS = Object.freeze([
  asset("/sde_intelligent_night_planning.js", "sde_intelligent_night_planning.js", "application/javascript; charset=utf-8", "private, max-age=600, must-revalidate"),
  asset("/sde_night_planning_ui.js", "sde_night_planning_ui.js", "application/javascript; charset=utf-8", "private, max-age=600, must-revalidate"),
  asset("/assets/vendor/tesseract/tesseract.min.js", "assets/vendor/tesseract/tesseract.min.js", "application/javascript; charset=utf-8", "private, max-age=31536000, immutable"),
  asset("/assets/vendor/tesseract/worker.min.js", "assets/vendor/tesseract/worker.min.js", "application/javascript; charset=utf-8", "private, max-age=31536000, immutable"),
  asset("/assets/vendor/tesseract-core/tesseract-core-lstm.wasm.js", "assets/vendor/tesseract-core/tesseract-core-lstm.wasm.js", "application/javascript; charset=utf-8", "private, max-age=31536000, immutable"),
  asset("/assets/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js", "assets/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js", "application/javascript; charset=utf-8", "private, max-age=31536000, immutable"),
  asset("/assets/vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js", "assets/vendor/tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js", "application/javascript; charset=utf-8", "private, max-age=31536000, immutable"),
  asset("/assets/vendor/tessdata/nor.traineddata.gz", "assets/vendor/tessdata/nor.traineddata.gz", "application/gzip", "private, max-age=31536000, immutable"),
  asset("/assets/vendor/tessdata/eng.traineddata.gz", "assets/vendor/tessdata/eng.traineddata.gz", "application/gzip", "private, max-age=31536000, immutable"),
  asset("/config/sde-night-intelligence.json", "config/sde-night-intelligence.json", "application/json; charset=utf-8", "no-store"),
  asset("/models/sde/production-model.json", "models/sde/production-model.json", "application/json; charset=utf-8", "no-store"),
  asset("/models/sde/model-registry.json", "models/sde/model-registry.json", "application/json; charset=utf-8", "no-store"),
]);

const NEGATIVE_PATHS = Object.freeze([
  "/unknown-night-module.js",
  "/config/unknown.json",
  "/models/sde/unknown.json",
  "/assets/vendor/tesseract/unknown.js",
  "/assets/vendor/tesseract/",
  "/assets/vendor/tesseract-core/",
  "/assets/vendor/tessdata/",
  "/assets/vendor/tesseract/LICENSE.md",
  "/.git/config",
  "/.env",
  "/server/src/index.js",
  "/server/data/sde-server.sqlite3",
  "/tests/sde/firewall.test.cjs",
  "/scripts/train_sde_night_model.py",
  "/package.json",
  "/README.md",
]);

const TRAVERSAL_PATHS = Object.freeze([
  "/assets/vendor/tesseract/../tesseract-core/tesseract-core-lstm.wasm.js",
  "/assets/vendor/tesseract/%2e%2e/tesseract-core/tesseract-core-lstm.wasm.js",
  "/assets/vendor/tesseract/%2e%2e%2ftesseract-core/tesseract-core-lstm.wasm.js",
  "/assets/vendor/tesseract/..%2ftesseract-core/tesseract-core-lstm.wasm.js",
  "/assets/vendor/tesseract/%252e%252e%252ftesseract-core/tesseract-core-lstm.wasm.js",
  "/assets/vendor/tesseract/%5c..%5ctesseract-core%5ctesseract-core-lstm.wasm.js",
  "/assets/vendor/tesseract/%255c..%255ctesseract-core%255ctesseract-core-lstm.wasm.js",
  "/%2e%2e/server/src/index.js",
  "/..%2fserver/src/index.js",
  "/%252e%252e%252fserver%252fsrc%252findex.js",
  "/%2Fetc/passwd",
  "/assets/vendor/tesseract/%00worker.min.js",
]);

let serverProcess = null;

async function main(){
  verifyPathHelpers();
  const port = await getFreePort();
  serverProcess = startServer(port);
  try{
    await waitForHealth(port);
    await new Promise(resolve => setTimeout(resolve, 150));

    const before = await operationalSnapshot(port);
    const db = new DatabaseSync(DATABASE_PATH, {readOnly: true});
    const dataVersionBefore = Number(db.prepare("PRAGMA data_version").get().data_version);
    const databaseHashBefore = sha256(fs.readFileSync(DATABASE_PATH));

    for(const expected of ASSETS){
      const response = await request(port, "GET", `${expected.requestPath}?asset-contract=1`);
      assert.equal(response.status, 200, `GET ${expected.requestPath}`);
      assert.equal(response.body.length, expected.bytes.length, `GET ${expected.requestPath} body length`);
      assert.equal(sha256(response.body), expected.sha256, `GET ${expected.requestPath} SHA-256`);
      assert.equal(response.headers["content-type"], expected.contentType, `GET ${expected.requestPath} MIME`);
      assert.equal(response.headers["cache-control"], expected.cacheControl, `GET ${expected.requestPath} cache`);
      assert.equal(response.headers["x-content-type-options"], "nosniff", `GET ${expected.requestPath} nosniff`);
      assert.match(String(response.headers.etag || ""), /^"sha256-[0-9a-f]{64}"$/, `GET ${expected.requestPath} ETag`);
      assert.ok(response.headers["last-modified"], `GET ${expected.requestPath} Last-Modified`);

      const head = await request(port, "HEAD", expected.requestPath);
      assert.equal(head.status, 200, `HEAD ${expected.requestPath}`);
      assert.equal(head.body.length, 0, `HEAD ${expected.requestPath} body`);
      assert.equal(Number(head.headers["content-length"]), expected.bytes.length, `HEAD ${expected.requestPath} Content-Length`);
      assert.equal(head.headers["content-type"], expected.contentType, `HEAD ${expected.requestPath} MIME`);
      assert.equal(head.headers["cache-control"], expected.cacheControl, `HEAD ${expected.requestPath} cache`);
    }

    for(const requestPath of [...NEGATIVE_PATHS, ...TRAVERSAL_PATHS]){
      const response = await request(port, "GET", requestPath);
      assert.equal(response.status, 404, `GET ${requestPath} must be denied`);
      assert.match(String(response.headers["content-type"] || ""), /^application\/json\b/, `GET ${requestPath} error MIME`);
      assert.doesNotMatch(response.body.toString("utf8"), /Users\/|\\Users\\|balise_logistikk_kopi/, `GET ${requestPath} must not leak paths`);
      assert.notEqual(response.headers["content-type"], "text/html; charset=utf-8", `GET ${requestPath} must not HTML-fallback`);
    }

    for(const method of ["POST", "PUT", "PATCH", "DELETE"]){
      const response = await request(port, method, ASSETS[0].requestPath, Buffer.from("{}"), {
        "Content-Type": "application/json",
      });
      assert.equal(response.status, 404, `${method} asset must not be delivered`);
      assert.notEqual(response.headers["content-type"], ASSETS[0].contentType, `${method} asset MIME`);
      assert.notEqual(sha256(response.body), ASSETS[0].sha256, `${method} asset body`);
    }

    const missingWasm = await request(port, "GET", "/assets/vendor/tesseract-core/tesseract-core.wasm");
    assert.equal(missingWasm.status, 404, "untracked WASM must be a real 404");
    assert.notEqual(missingWasm.headers["content-type"], "text/html; charset=utf-8");

    const after = await operationalSnapshot(port);
    const dataVersionAfter = Number(db.prepare("PRAGMA data_version").get().data_version);
    const databaseHashAfter = sha256(fs.readFileSync(DATABASE_PATH));
    db.close();

    assert.deepEqual(after, before, "asset GET/HEAD must not change operational readback");
    assert.equal(dataVersionAfter, dataVersionBefore, "asset GET/HEAD must not change SQLite data_version");
    assert.equal(databaseHashAfter, databaseHashBefore, "asset GET/HEAD must not change database bytes");

    process.stdout.write(JSON.stringify({
      status: "PASS",
      positiveAssets: ASSETS.length,
      headAssets: ASSETS.length,
      negativePaths: NEGATIVE_PATHS.length,
      traversalPaths: TRAVERSAL_PATHS.length,
      negativeMethods: 4,
      businessWrite: false,
      databaseHash: databaseHashAfter,
    }, null, 2) + "\n");
  }finally{
    await stopServer();
    fs.rmSync(TEMP_ROOT, {recursive: true, force: true});
  }
}

function verifyPathHelpers(){
  assert.equal(
    normalizeAssetRequestPath("/sde_night_planning_ui.js?v=20260807c"),
    "/sde_night_planning_ui.js",
  );
  for(const requestPath of TRAVERSAL_PATHS){
    assert.equal(normalizeAssetRequestPath(requestPath), null, `normalizer must reject ${requestPath}`);
  }
  for(const requestPath of ["//etc/passwd", "/.git/config", "/assets//worker.min.js"]){
    assert.equal(normalizeAssetRequestPath(requestPath), null, `normalizer must reject ${requestPath}`);
  }

  const symlinkRoot = path.join(TEMP_ROOT, "symlink-root");
  const outsideRoot = path.join(TEMP_ROOT, "outside-root");
  fs.mkdirSync(symlinkRoot, {recursive: true});
  fs.mkdirSync(outsideRoot, {recursive: true});
  fs.writeFileSync(path.join(symlinkRoot, "inside.js"), "inside", "utf8");
  fs.writeFileSync(path.join(outsideRoot, "outside.js"), "outside", "utf8");
  fs.symlinkSync(path.join(symlinkRoot, "inside.js"), path.join(symlinkRoot, "inside-link.js"));
  fs.symlinkSync(path.join(outsideRoot, "outside.js"), path.join(symlinkRoot, "outside-link.js"));
  assert.equal(resolveFileWithinRoot(symlinkRoot, "inside-link.js").ok, true, "in-root symlink may resolve");
  assert.deepEqual(
    resolveFileWithinRoot(symlinkRoot, "outside-link.js"),
    {ok: false, reason: "symlink_outside_root"},
  );
  assert.deepEqual(
    resolveFileWithinRoot(symlinkRoot, "../outside-root/outside.js"),
    {ok: false, reason: "outside_root"},
  );
}

function asset(requestPath, relativePath, contentType, cacheControl){
  const filePath = path.join(REPOSITORY_ROOT, relativePath);
  const bytes = fs.readFileSync(filePath);
  return Object.freeze({
    requestPath,
    relativePath,
    filePath,
    bytes,
    sha256: sha256(bytes),
    contentType,
    cacheControl,
  });
}

function sha256(value){
  return crypto.createHash("sha256").update(value).digest("hex");
}

function getFreePort(){
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function startServer(port){
  const output = fs.openSync(LOG_PATH, "w");
  const env = {...process.env};
  for(const key of Object.keys(env)){
    if(key.startsWith("SDE_ENABLE_")) delete env[key];
  }
  env.PORT = String(port);
  env.SDE_SERVER_DB_PATH = DATABASE_PATH;
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_ROOT,
    env,
    stdio: ["ignore", output, output],
  });
  fs.closeSync(output);
  return child;
}

async function waitForHealth(port){
  const deadline = Date.now() + 10_000;
  while(Date.now() < deadline){
    if(serverProcess.exitCode !== null){
      throw new Error(`Isolated server exited early.\n${readLog()}`);
    }
    try{
      const response = await request(port, "GET", "/api/health");
      if(response.status === 200) return;
    }catch(_error){
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for isolated server.\n${readLog()}`);
}

function request(port, method, requestPath, body = null, headers = {}){
  return new Promise((resolve, reject) => {
    const requestHeaders = {...headers};
    if(body){
      requestHeaders["Content-Length"] = String(body.length);
    }
    const req = http.request({
      hostname: HOST,
      port,
      method,
      path: requestPath,
      timeout: 10_000,
      headers: requestHeaders,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out: ${method} ${requestPath}`)));
    req.on("error", reject);
    if(body) req.write(body);
    req.end();
  });
}

async function operationalSnapshot(port){
  const endpoints = [
    "/api/state/revision",
    "/api/events?sinceRevision=0",
    "/api/operational-state/events",
    "/api/shared-sporplan-draft",
    "/api/vehicle-status",
  ];
  const snapshot = {};
  for(const endpoint of endpoints){
    const response = await request(port, "GET", endpoint);
    assert.equal(response.status, 200, `snapshot ${endpoint}`);
    snapshot[endpoint] = JSON.parse(response.body.toString("utf8"));
  }
  return snapshot;
}

function readLog(){
  try{
    return fs.readFileSync(LOG_PATH, "utf8");
  }catch(_error){
    return "";
  }
}

function stopServer(){
  if(!serverProcess || serverProcess.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => serverProcess.kill("SIGKILL"), 3000);
    serverProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    serverProcess.kill("SIGTERM");
  });
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

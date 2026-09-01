"use strict";

const {spawn} = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const {createCapabilityGuard} = require("./nightPlanRoutes");
const {
  loadIdentityRoleBindingsCatalog,
  validateIdentityRoleBindingsCatalog
} = require("./identityRoleBindings");
const {CAPABILITY_IDS} = require("./runtimeAuthorization");

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const SCANNER_DIR_NAME = "togplassering_scanner_v03";

function extractMultipartFile(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  if (!boundaryMatch) throw Object.assign(new Error("missing_multipart_boundary"), {status: 400, code: "scanner_multipart_invalid"});
  const boundary = Buffer.from(`--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`);
  const parts = [];
  let start = 0;
  while (start < buffer.length) {
    const index = buffer.indexOf(boundary, start);
    if (index < 0) break;
    if (start > 0) parts.push(buffer.slice(start, index));
    start = index + boundary.length;
    if (buffer.slice(start, start + 2).toString() === "--") break;
    if (buffer.slice(start, start + 2).toString() === "\r\n") start += 2;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd).toString("utf8");
    if (!/name="file"/i.test(header)) continue;
    let body = part.slice(headerEnd + 4);
    if (body.slice(-2).toString() === "\r\n") body = body.slice(0, -2);
    const filenameMatch = /filename="([^"]*)"/i.exec(header);
    return {
      filename: filenameMatch ? filenameMatch[1] : "upload.jpg",
      bytes: body
    };
  }
  throw Object.assign(new Error("missing_file_field"), {status: 400, code: "scanner_file_missing"});
}

function readRequestBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error("scanner_request_too_large"), {status: 413, code: "scanner_request_too_large"}));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runCli(repositoryRoot, args, env, timeoutMs) {
  const cli = path.join(repositoryRoot, "server", SCANNER_DIR_NAME, "cli.py");
  const python = env.SDE_PYTHON || "python3";
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-B", cli, ...args], {
      cwd: path.join(repositoryRoot, "server", SCANNER_DIR_NAME),
      env: {
        PATH: env.PATH || process.env.PATH,
        HOME: env.HOME || process.env.HOME,
        LANG: env.LANG || process.env.LANG,
        LC_ALL: env.LC_ALL || process.env.LC_ALL,
        PYTHONPATH: env.PYTHONPATH || process.env.PYTHONPATH,
        OPENAI_API_KEY: env.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "",
        SDE_PYTHON: python
      }
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      const text = Buffer.concat(stdout).toString("utf8").trim();
      let payload = null;
      try {
        payload = JSON.parse(text.split("\n").filter(Boolean).at(-1) || "{}");
      } catch (_error) {
        payload = {ok: false, error: "scanner_json_invalid"};
      }
      if (code !== 0 || payload?.ok === false) {
        const error = new Error(payload?.error || `scanner_exit_${code}`);
        error.status = 422;
        error.code = "scanner_failed";
        error.detail = payload?.error || Buffer.concat(stderr).toString("utf8").slice(0, 500);
        reject(error);
        return;
      }
      resolve(payload);
    });
  });
}

function createTogplasseringScannerApi(options = {}) {
  const env = options.env || process.env;
  const repositoryRoot = options.repositoryRoot;
  if (!repositoryRoot) throw new TypeError("Scanner API requires repositoryRoot.");
  // Without a catalog the guard cannot resolve any role, so every verified
  // identity is denied. Load it the same way the night-plan API does.
  const roleBindingsCatalog = Object.hasOwn(options, "roleBindingsCatalog")
    ? validateIdentityRoleBindingsCatalog(options.roleBindingsCatalog)
    : loadIdentityRoleBindingsCatalog({
        env,
        readFileSync: options.readRoleBindingsFile
      });
  const authorizeRead = createCapabilityGuard(CAPABILITY_IDS.NIGHT_PLAN_READ, {
    env,
    jwks: options.jwks,
    verifier: options.verifier,
    verifyIdentityRequest: options.verifyIdentityRequest,
    roleBindingsCatalog
  });

  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  async function handle(command, req, res, next) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sde-v03-scanner-"));
    try {
      const raw = await readRequestBuffer(req, MAX_IMAGE_BYTES);
      const file = extractMultipartFile(raw, req.get("content-type"));
      if (!file.bytes.length) {
        return res.status(400).json({ok: false, error: "scanner_file_empty"});
      }
      const imagePath = path.join(tmp, file.filename.replace(/[^A-Za-z0-9._-]/g, "_") || "upload.jpg");
      fs.writeFileSync(imagePath, file.bytes);
      const args = [command, imagePath];
      if (command === "scan") {
        const doubleCheck = String(req.query.double_check || "true").toLowerCase();
        if (["0", "false", "no", "off"].includes(doubleCheck)) args.push("--no-double-check");
        const model = String(req.query.model || "").trim();
        if (model) args.push("--model", model);
      }
      const timeouts = {scan: 240000, read: 180000};
      const payload = await runCli(repositoryRoot, args, env, timeouts[command] || 120000);
      return res.status(200).json(payload);
    } catch (error) {
      if (error?.status) {
        return res.status(error.status).json({
          ok: false,
          error: error.code || "scanner_failed",
          detail: error.detail || error.message
        });
      }
      return next(error);
    } finally {
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  }

  router.get("/status", authorizeRead, (_req, res) => {
    res.status(200).json({
      ok: true,
      engine: "togplassering-skien-scanner-v0.3",
      localReader: "local-pp-ocrv5",
      clientApiKey: false,
      persistsImages: false
    });
  });
  router.post("/geometry", authorizeRead, (req, res, next) => {
    handle("geometry", req, res, next);
  });
  router.post("/read", authorizeRead, (req, res, next) => {
    handle("read", req, res, next);
  });
  router.post("/scan", authorizeRead, (req, res, next) => {
    handle("scan", req, res, next);
  });

  return Object.freeze({
    router,
    status: Object.freeze({
      engine: "togplassering-skien-scanner-v0.3",
      maxImageBytes: MAX_IMAGE_BYTES,
      persistsImages: false,
      clientApiKey: false
    })
  });
}

module.exports = {
  MAX_IMAGE_BYTES,
  createTogplasseringScannerApi,
  extractMultipartFile
};

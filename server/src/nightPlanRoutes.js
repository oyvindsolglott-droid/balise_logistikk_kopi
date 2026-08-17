"use strict";

const express = require("express");
const {verifyAccessIdentityRequest} = require("./accessIdentity");
const {
  loadIdentityRoleBindingsCatalog,
  resolveIdentityRoleBinding,
  validateIdentityRoleBindingsCatalog
} = require("./identityRoleBindings");
const {
  CAPABILITY_IDS,
  evaluateRuntimeAuthorization
} = require("./runtimeAuthorization");
const {
  ALLOWED_MIME_TYPES,
  MAX_IMAGE_BYTES,
  NightPlanStorageError,
  ROW_COUNT,
  STORAGE_SCHEMA_VERSION,
  cleanupNightPlanImageOrphans,
  ensureNightPlanSchema,
  getNightPlan,
  getNightPlanImage,
  listNightPlans,
  preparePrivateStorage,
  saveNightPlan
} = require("./nightPlanStorage");

const NIGHT_PLAN_STORAGE_ENABLED_ENV = "SDE_ENABLE_NIGHT_PLAN_STORAGE";
const NIGHT_PLAN_IMAGE_STORAGE_ENV = "SDE_NIGHT_PLAN_IMAGE_DIR";
const REQUEST_BODY_LIMIT = "12mb";

function createNightPlanApi(options = {}){
  const env = options.env || process.env;
  const db = options.db;
  const repositoryRoot = options.repositoryRoot;
  const imageStorageRoot = options.imageStorageRoot || env[NIGHT_PLAN_IMAGE_STORAGE_ENV];
  const enabled = env[NIGHT_PLAN_STORAGE_ENABLED_ENV] === "1";
  if(!db) throw new TypeError("Night-plan API requires a database.");

  let cleanup = Object.freeze({removedCount: 0, removed: Object.freeze([])});
  if(enabled){
    ensureNightPlanSchema(db);
    preparePrivateStorage({imageStorageRoot, repositoryRoot});
    cleanup = cleanupNightPlanImageOrphans(db, {imageStorageRoot, repositoryRoot});
  }

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
  const authorizeSave = createCapabilityGuard(CAPABILITY_IDS.NIGHT_PLAN_SAVE, {
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

  router.get("/", authorizeRead, storageEnabledGuard(enabled), (req, res) => {
    const limit = Number.parseInt(String(req.query.limit || "50"), 10);
    res.status(200).json({
      ok: true,
      mode: "night_plan_documentation",
      schemaVersion: STORAGE_SCHEMA_VERSION,
      plans: listNightPlans(db, limit)
    });
  });

  router.get("/:planId", authorizeRead, storageEnabledGuard(enabled), (req, res, next) => {
    try{
      const plan = getNightPlan(db, req.params.planId);
      if(!plan) return res.status(404).json({ok: false, error: "night_plan_not_found"});
      return res.status(200).json(plan);
    }catch(error){
      return next(error);
    }
  });

  router.get("/:planId/images/:imageId", authorizeRead, storageEnabledGuard(enabled), (req, res, next) => {
    try{
      const image = getNightPlanImage(db, req.params.planId, req.params.imageId, {
        imageStorageRoot,
        repositoryRoot
      });
      if(!image) return res.status(404).json({ok: false, error: "night_plan_image_not_found"});
      res.set("Content-Type", image.mimeType);
      res.set("Content-Length", String(image.byteCount));
      res.set("Content-Security-Policy", "default-src 'none'; sandbox");
      res.set("Content-Disposition", `inline; filename="${image.imageId}.${image.mimeType === "image/png" ? "png" : "jpg"}"`);
      res.set("X-SDE-Image-SHA256", image.sha256);
      return res.status(200).send(image.bytes);
    }catch(error){
      return next(error);
    }
  });

  router.post(
    "/",
    authorizeSave,
    storageEnabledGuard(enabled),
    express.json({limit: REQUEST_BODY_LIMIT, type: "application/json"}),
    (req, res, next) => {
      try{
        const result = saveNightPlan(db, req.body, {
          imageStorageRoot,
          repositoryRoot,
          savedBy: req.sdeNightPlanIdentity.subject
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      }catch(error){
        return next(error);
      }
    }
  );

  router.use((error, _req, res, _next) => {
    if(error instanceof NightPlanStorageError){
      return res.status(error.status).json({
        ok: false,
        error: error.code,
        message: error.message,
        ...error.details
      });
    }
    if(error?.type === "entity.too.large"){
      return res.status(413).json({ok: false, error: "night_plan_request_too_large"});
    }
    if(error instanceof SyntaxError && Object.hasOwn(error, "body")){
      return res.status(400).json({ok: false, error: "night_plan_json_invalid"});
    }
    return res.status(500).json({ok: false, error: "night_plan_server_error"});
  });

  return Object.freeze({
    router,
    status: Object.freeze({
      enabled,
      ready: enabled,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      rowCount: ROW_COUNT,
      maxImageBytes: MAX_IMAGE_BYTES,
      allowedImageMimeTypes: ALLOWED_MIME_TYPES,
      startupOrphansRemoved: cleanup.removedCount,
      operationalAuthority: false,
      operationalWritesAllowed: false
    })
  });
}

function createCapabilityGuard(capability, options){
  const verifyIdentity = options.verifyIdentityRequest || verifyAccessIdentityRequest;
  return async function nightPlanCapabilityGuard(req, res, next){
    let identityResult;
    try{
      identityResult = await verifyIdentity({
        headers: req.headers,
        env: options.env,
        jwks: options.jwks,
        verifier: options.verifier
      });
    }catch(_error){
      return res.status(503).json({ok: false, error: "access_identity_verification_unavailable"});
    }
    if(identityResult?.ok !== true){
      return res.status(identityResult?.status || 401).json({
        ok: false,
        error: identityResult?.publicError || "authentication_required"
      });
    }
    const roleResult = resolveIdentityRoleBinding(identityResult.identity, options.roleBindingsCatalog);
    const decision = evaluateRuntimeAuthorization({
      identity: identityResult.identity,
      roleResult,
      capability
    });
    if(decision.allowed !== true){
      return res.status(403).json({ok: false, error: "night_plan_capability_denied"});
    }
    req.sdeNightPlanIdentity = Object.freeze({
      subject: identityResult.identity.subject,
      capability,
      role: decision.role
    });
    return next();
  };
}

function storageEnabledGuard(enabled){
  return function requireNightPlanStorageEnabled(_req, res, next){
    if(enabled) return next();
    return res.status(503).json({
      ok: false,
      error: "night_plan_storage_disabled",
      message: "Private night-plan storage is not enabled on this server."
    });
  };
}

module.exports = {
  NIGHT_PLAN_IMAGE_STORAGE_ENV,
  NIGHT_PLAN_STORAGE_ENABLED_ENV,
  REQUEST_BODY_LIMIT,
  createCapabilityGuard,
  createNightPlanApi
};

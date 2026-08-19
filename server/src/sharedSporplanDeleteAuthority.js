"use strict";

const {verifyAccessIdentityRequest} = require("./accessIdentity");
const {
  loadIdentityRoleBindingsCatalog,
  resolveIdentityRoleBinding,
  validateIdentityRoleBindingsCatalog
} = require("./identityRoleBindings");
const {CAPABILITY_IDS, evaluateRuntimeAuthorization} = require("./runtimeAuthorization");

const SHARED_SPORPLAN_RESET_MARKER_KEY = "__shared_sporplan_reset__";
const SHARED_SPORPLAN_RESET_MARKER_VALUE = "SDE-SYNC-M";
const SHARED_SPORPLAN_DELETE_CAPABILITY = CAPABILITY_IDS.INPUT_SPORPLAN_DELETE;

function isSharedSporplanDeletePayload(payload){
  const draft = payload?.draft;
  if(!isPlainObject(draft)) return false;
  const maps = [draft.grunnoppstilling, draft.grunnoppstillingRep];
  return maps.some(map => isPlainObject(map) && Object.entries(map).some(([key,value]) => (
    String(key || "").trim() === SHARED_SPORPLAN_RESET_MARKER_KEY &&
    String(value || "").trim() === SHARED_SPORPLAN_RESET_MARKER_VALUE
  )));
}

function createSharedSporplanDeleteCapabilityGuard(options = {}){
  const env = options.env || process.env;
  const verifyIdentity = options.verifyIdentityRequest || verifyAccessIdentityRequest;
  const roleBindingsCatalog = Object.hasOwn(options,"roleBindingsCatalog")
    ? validateIdentityRoleBindingsCatalog(options.roleBindingsCatalog)
    : loadIdentityRoleBindingsCatalog({env,readFileSync:options.readRoleBindingsFile});

  return async function sharedSporplanDeleteCapabilityGuard(req,res,next){
    if(!isSharedSporplanDeletePayload(req.body)) return next();

    res.set?.("Cache-Control","no-store");
    res.set?.("Pragma","no-cache");

    let identityResult;
    try{
      identityResult = await verifyIdentity({
        headers:req.headers,
        env,
        jwks:options.jwks,
        verifier:options.verifier
      });
    }catch(_error){
      return res.status(503).json({ok:false,error:"access_identity_verification_unavailable"});
    }

    if(identityResult?.ok !== true){
      return res.status(identityResult?.status || 401).json({
        ok:false,
        error:identityResult?.publicError || "authentication_required"
      });
    }
    if(roleBindingsCatalog.valid !== true){
      return res.status(503).json({ok:false,error:"role_binding_unavailable"});
    }

    const roleResult = resolveIdentityRoleBinding(identityResult.identity,roleBindingsCatalog);
    const decision = evaluateRuntimeAuthorization({
      identity:identityResult.identity,
      roleResult,
      capability:SHARED_SPORPLAN_DELETE_CAPABILITY
    });
    if(decision.allowed !== true){
      return res.status(403).json({ok:false,error:"input_sporplan_delete_capability_denied"});
    }

    req.sdeSharedSporplanDeleteIdentity = Object.freeze({
      subject:identityResult.identity.subject,
      capability:SHARED_SPORPLAN_DELETE_CAPABILITY,
      roles:Object.freeze([...decision.roles]),
      capabilitySourceRoles:Object.freeze([...decision.capabilitySourceRoles]),
      roleBindingId:roleResult.roleBindingId,
      identitySource:identityResult.identity.source || "cloudflare_access"
    });
    return next();
  };
}

function buildAuthorizedSharedSporplanDeletePayload(payload,verifiedIdentity){
  if(!isSharedSporplanDeletePayload(payload)){
    throw new TypeError("Shared Sporplan delete payload requires the canonical reset marker.");
  }
  if(
    !verifiedIdentity ||
    typeof verifiedIdentity.subject !== "string" ||
    verifiedIdentity.capability !== SHARED_SPORPLAN_DELETE_CAPABILITY ||
    !Array.isArray(verifiedIdentity.roles) ||
    verifiedIdentity.roles.length === 0
  ){
    throw new TypeError("Verified Shared Sporplan delete identity is required.");
  }

  return {
    expectedRevision:payload.expectedRevision,
    draft:clone(payload.draft),
    audit:{
      actor:verifiedIdentity.subject,
      device:normalizeAuditDevice(payload?.audit?.device),
      clientContext:{
        ...clone(isPlainObject(payload?.audit?.clientContext) ? payload.audit.clientContext : {}),
        verifiedCapability:verifiedIdentity.capability,
        verifiedRoles:[...verifiedIdentity.roles],
        capabilitySourceRoles:[...(verifiedIdentity.capabilitySourceRoles || [])],
        roleBindingId:verifiedIdentity.roleBindingId || null,
        identitySource:verifiedIdentity.identitySource || "cloudflare_access",
        serverAuthorizedDelete:true
      }
    }
  };
}

function normalizeAuditDevice(value){
  return typeof value === "string" && value.length <= 128 ? value : null;
}

function clone(value){
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value){
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

module.exports = {
  SHARED_SPORPLAN_DELETE_CAPABILITY,
  SHARED_SPORPLAN_RESET_MARKER_KEY,
  SHARED_SPORPLAN_RESET_MARKER_VALUE,
  buildAuthorizedSharedSporplanDeletePayload,
  createSharedSporplanDeleteCapabilityGuard,
  isSharedSporplanDeletePayload
};

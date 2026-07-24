"use strict";

const fs = require("node:fs");
const { ROLE_KEYS } = require("./identityPolicy");

const IDENTITY_ROLE_BINDINGS_ENV = "SDE_IDENTITY_ROLE_BINDINGS_PATH";
const ROLE_BINDING_SOURCE = "server_config";
const MAX_BINDING_ID_LENGTH = 160;
const MAX_SUBJECT_LENGTH = 320;
const MAX_DESCRIPTION_LENGTH = 500;

const ALLOWED_IDENTITY_ROLES = Object.freeze([
  ROLE_KEYS.ADMIN_PILOT,
  ROLE_KEYS.AGILA,
  ROLE_KEYS.DROPS,
  ROLE_KEYS.SDE_SKIFTERE,
  ROLE_KEYS.TXP,
  ROLE_KEYS.VERKSTED
].sort());
const ALLOWED_IDENTITY_ROLE_SET = new Set(ALLOWED_IDENTITY_ROLES);

function validateIdentityRoleBindingsCatalog(input, options = {}){
  const configured = options.configured !== false;
  const diagnostics = new Set();
  const normalizedBindings = [];

  if(!isPlainObject(input) || !Array.isArray(input.bindings)){
    diagnostics.add("role_bindings_invalid_catalog_shape");
    return invalidCatalog(configured, diagnostics);
  }

  for(const binding of input.bindings){
    const normalized = normalizeBinding(binding, diagnostics);
    if(normalized) normalizedBindings.push(normalized);
  }

  const bindingIdCounts = countBy(normalizedBindings, (binding) => binding.bindingId);
  if([...bindingIdCounts.values()].some((count) => count > 1)){
    diagnostics.add("role_binding_duplicate_binding_id");
  }

  const activeBySubject = groupBy(
    normalizedBindings.filter((binding) => binding.enabled),
    (binding) => binding.subject
  );
  for(const subjectBindings of activeBySubject.values()){
    if(subjectBindings.length <= 1) continue;
    diagnostics.add("role_binding_duplicate_active_subject");
  }

  if(diagnostics.size > 0) return invalidCatalog(configured, diagnostics);

  const bindings = Object.freeze(
    [...normalizedBindings]
      .sort(compareBindings)
      .map((binding) => Object.freeze(binding))
  );
  return Object.freeze({
    configured,
    valid: true,
    diagnostics: Object.freeze([]),
    bindings
  });
}

function loadIdentityRoleBindingsCatalog(options = {}){
  const env = options.env || process.env;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const configuredPath = normalizeRuntimePath(env[IDENTITY_ROLE_BINDINGS_ENV]);

  if(!configuredPath){
    return Object.freeze({
      configured: false,
      valid: true,
      diagnostics: Object.freeze([]),
      bindings: Object.freeze([])
    });
  }

  let raw;
  try{
    raw = readFileSync(configuredPath, "utf8");
  }catch(_error){
    return invalidCatalog(true, new Set(["role_bindings_file_unavailable"]));
  }

  let parsed;
  try{
    parsed = JSON.parse(String(raw));
  }catch(_error){
    return invalidCatalog(true, new Set(["role_bindings_json_invalid"]));
  }

  return validateIdentityRoleBindingsCatalog(parsed, { configured: true });
}

function resolveIdentityRoleBinding(identity, catalog){
  const diagnostics = new Set();

  if(!catalog || catalog.valid !== true || !Array.isArray(catalog.bindings)){
    diagnostics.add("role_bindings_catalog_invalid");
    for(const diagnostic of catalog?.diagnostics || []) diagnostics.add(diagnostic);
    return unresolvedRoleBinding(diagnostics);
  }

  if(
    !identity ||
    identity.identityVerified !== true ||
    identity.identityKind !== "human" ||
    typeof identity.subject !== "string"
  ){
    return unresolvedRoleBinding(diagnostics);
  }

  const binding = catalog.bindings.find((candidate) => (
    candidate.enabled === true && candidate.subject === identity.subject
  ));
  if(!binding) return unresolvedRoleBinding(diagnostics);

  if(binding.expectedEmail && binding.expectedEmail !== identity.email){
    diagnostics.add("role_binding_expected_email_mismatch");
  }

  return Object.freeze({
    roleResolved: true,
    roles: binding.roles,
    roleBindingSource: ROLE_BINDING_SOURCE,
    roleBindingId: binding.bindingId,
    diagnostics: freezeDiagnostics(diagnostics),
    runtimeRoleEnforcement: false,
    writeAuthority: false
  });
}

function normalizeBinding(binding, diagnostics){
  if(!isPlainObject(binding)){
    diagnostics.add("role_binding_invalid_entry");
    return null;
  }

  const bindingId = normalizeExactString(binding.bindingId, MAX_BINDING_ID_LENGTH);
  const subject = normalizeExactString(binding.subject, MAX_SUBJECT_LENGTH);
  const rawRoles = Array.isArray(binding.roles)
    ? binding.roles
    : (binding.role === undefined ? null : [binding.role]);
  const roles = rawRoles?.map((role) => normalizeExactString(role, MAX_BINDING_ID_LENGTH)) || null;
  const enabled = binding.enabled;
  const expectedEmail = binding.expectedEmail === undefined
    ? null
    : normalizeEmail(binding.expectedEmail);
  const description = binding.description === undefined
    ? null
    : normalizeExactString(binding.description, MAX_DESCRIPTION_LENGTH);

  if(!bindingId) diagnostics.add("role_binding_invalid_binding_id");
  if(!subject) diagnostics.add("role_binding_invalid_subject");
  if(
    !roles ||
    roles.length === 0 ||
    roles.some((role) => !role || !ALLOWED_IDENTITY_ROLE_SET.has(role))
  ){
    diagnostics.add(roles?.some(Boolean) ? "role_binding_unknown_role" : "role_binding_invalid_role");
  }
  if(roles && new Set(roles).size !== roles.length){
    diagnostics.add("role_binding_duplicate_role");
  }
  if(typeof enabled !== "boolean") diagnostics.add("role_binding_invalid_enabled");
  if(binding.expectedEmail !== undefined && !expectedEmail){
    diagnostics.add("role_binding_invalid_expected_email");
  }
  if(binding.description !== undefined && !description){
    diagnostics.add("role_binding_invalid_description");
  }

  if(
    !bindingId ||
    !subject ||
    !roles ||
    roles.length === 0 ||
    roles.some((role) => !role || !ALLOWED_IDENTITY_ROLE_SET.has(role)) ||
    new Set(roles).size !== roles.length ||
    typeof enabled !== "boolean" ||
    (binding.expectedEmail !== undefined && !expectedEmail) ||
    (binding.description !== undefined && !description)
  ){
    return null;
  }

  const normalizedRoles = Object.freeze([...roles].sort());
  const normalized = {
    bindingId,
    subject,
    roles: normalizedRoles,
    role: normalizedRoles.length === 1 ? normalizedRoles[0] : null,
    enabled
  };
  if(expectedEmail) normalized.expectedEmail = expectedEmail;
  if(description) normalized.description = description;
  return normalized;
}

function unresolvedRoleBinding(diagnostics){
  return Object.freeze({
    roleResolved: false,
    roles: Object.freeze([]),
    roleBindingSource: null,
    roleBindingId: null,
    diagnostics: freezeDiagnostics(diagnostics),
    runtimeRoleEnforcement: false,
    writeAuthority: false
  });
}

function invalidCatalog(configured, diagnostics){
  return Object.freeze({
    configured,
    valid: false,
    diagnostics: freezeDiagnostics(diagnostics),
    bindings: Object.freeze([])
  });
}

function freezeDiagnostics(diagnostics){
  return Object.freeze([...diagnostics].sort());
}

function compareBindings(left, right){
  return left.bindingId.localeCompare(right.bindingId) ||
    left.subject.localeCompare(right.subject) ||
    left.roles.join(",").localeCompare(right.roles.join(","));
}

function countBy(values, selector){
  const counts = new Map();
  for(const value of values){
    const key = selector(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function groupBy(values, selector){
  const groups = new Map();
  for(const value of values){
    const key = selector(value);
    const group = groups.get(key) || [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function normalizeRuntimePath(value){
  if(typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeExactString(value, maximumLength){
  if(typeof value !== "string" || value.length === 0 || value.length > maximumLength) return null;
  if(value !== value.trim()) return null;
  if(/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function normalizeEmail(value){
  if(typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if(!normalized || normalized.length > 254) return null;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function isPlainObject(value){
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

module.exports = {
  ALLOWED_IDENTITY_ROLES,
  IDENTITY_ROLE_BINDINGS_ENV,
  ROLE_BINDING_SOURCE,
  loadIdentityRoleBindingsCatalog,
  resolveIdentityRoleBinding,
  validateIdentityRoleBindingsCatalog
};

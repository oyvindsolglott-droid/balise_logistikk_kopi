"use strict";

const ENDPOINT_CLASSES = Object.freeze({
  PUBLIC_READ_ONLY: "public_read_only",
  REVIEW_NEEDED_READ_ONLY: "review_needed_read_only",
  PRIVATE_READBACK_CANDIDATE: "private_readback_candidate",
  WRITE_BLOCKED: "write_blocked",
  UNKNOWN: "unknown"
});

const AUTH_RIGHTS = Object.freeze({
  READ_ONLY: "read_only",
  READBACK_AUDIT: "readback_audit",
  WRITE: "write",
  TEST_WRITE: "test_write",
  PRODUCTION_WRITE: "production_write",
  OPERATIONAL_AUTHORITY: "operational_authority"
});

const HIGH_RISK_SCOPES = Object.freeze([
  "sde-shift-orders",
  "sde-shift-completion-status",
  "txp-operational-blocks",
  "drops-dispatch-decisions",
  "operational-authority-state"
]);

const PUBLIC_READ_ONLY_ENDPOINTS = Object.freeze([
  ["GET", "/api/health"],
  ["GET", "/api/server/status"],
  ["GET", "/api/state/revision"],
  ["GET", "/api/tursatt/live-arrivals"]
]);

const REVIEW_NEEDED_ENDPOINTS = Object.freeze([
  ["GET", "/api/state"],
  ["GET", "/api/events"],
  ["GET", "/api/operational-state"],
  ["GET", "/api/operational-state/events"],
  ["GET", "/api/stream"],
  ["GET", "/"],
  ["GET", "/app"]
]);

const WRITE_BLOCKED_ENDPOINTS = Object.freeze([
  ["POST", "/api/operational-state/snapshot"],
  ["POST", "/api/actions/test-note"],
  ["POST", "/api/actions/action-contract-test"],
  ["POST", "/api/actions/actions-table-test"],
  ["POST", "/api/actions/server-note"],
  ["POST", "/api/actions/sde-recommendation-ack"]
]);

const READ_ONLY_RIGHTS = new Set([
  AUTH_RIGHTS.READ_ONLY,
  AUTH_RIGHTS.READBACK_AUDIT
]);

const WRITE_RIGHTS = new Set([
  AUTH_RIGHTS.WRITE,
  AUTH_RIGHTS.TEST_WRITE,
  AUTH_RIGHTS.PRODUCTION_WRITE
]);

function classifyEndpoint(method, rawPath) {
  const normalizedMethod = normalizeMethod(method);
  const path = normalizePath(rawPath);

  if (!normalizedMethod || !path) {
    return endpointDecision(ENDPOINT_CLASSES.UNKNOWN, normalizedMethod, path, "unknown_endpoint");
  }

  if (normalizedMethod === "POST") {
    const matchedWrite = hasEndpoint(WRITE_BLOCKED_ENDPOINTS, normalizedMethod, path);
    return endpointDecision(
      ENDPOINT_CLASSES.WRITE_BLOCKED,
      normalizedMethod,
      path,
      matchedWrite ? "write_endpoint_blocked" : "post_default_blocked",
      {
        requestedRight: AUTH_RIGHTS.WRITE
      }
    );
  }

  if (normalizedMethod !== "GET") {
    return endpointDecision(ENDPOINT_CLASSES.UNKNOWN, normalizedMethod, path, "unknown_method");
  }

  if (hasEndpoint(PUBLIC_READ_ONLY_ENDPOINTS, normalizedMethod, path)) {
    return endpointDecision(ENDPOINT_CLASSES.PUBLIC_READ_ONLY, normalizedMethod, path, "public_read_only");
  }

  if (
    hasEndpoint(REVIEW_NEEDED_ENDPOINTS, normalizedMethod, path) ||
    path.startsWith("/data/") ||
    path.startsWith("/assets/")
  ) {
    return endpointDecision(
      ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY,
      normalizedMethod,
      path,
      "review_needed_read_only"
    );
  }

  return endpointDecision(ENDPOINT_CLASSES.UNKNOWN, normalizedMethod, path, "unknown_endpoint");
}

function normalizeIdentityContext(rawContext = {}) {
  const raw = isPlainObject(rawContext) ? rawContext : {};
  const identity = isPlainObject(raw.identity) ? raw.identity : {};
  const trustedBoundary = raw.trustedBoundary === true;
  const authenticatedIdentityId = normalizeString(raw.authenticatedIdentityId) || normalizeString(identity.id);
  const role = normalizeString(raw.role) || normalizeString(identity.role);
  const scopes = normalizeScopes(raw.scopes !== undefined ? raw.scopes : identity.scopes);

  return {
    authenticatedIdentityId,
    role,
    scopes,
    trustedBoundary,
    sourceIp: normalizeString(raw.sourceIp),
    localNetworkMetadata: clonePlainObject(raw.localNetworkMetadata),
    actor: clonePlainObject(raw.actor),
    device: clonePlainObject(raw.device),
    clientContext: clonePlainObject(raw.clientContext),
    untrustedClientFields: Object.freeze({
      clientHeaders: clonePlainObject(raw.clientHeaders),
      frontendDataLevel: normalizeString(raw.frontendDataLevel),
      actorProvided: Boolean(raw.actor),
      deviceProvided: Boolean(raw.device),
      clientContextProvided: Boolean(raw.clientContext),
      localLanClaimed: raw.localLan === true
    })
  };
}

function isTrustedIdentityContext(identityContext) {
  const normalized = normalizeIdentityContext(identityContext);
  return Boolean(normalized.trustedBoundary && normalized.authenticatedIdentityId);
}

function evaluateAuthDecision(identityContext = {}, requestContext = {}) {
  const identity = normalizeIdentityContext(identityContext);
  const endpoint = classifyEndpoint(requestContext.method, requestContext.path);
  const endpointClass = normalizeString(requestContext.endpointClass) || endpoint.endpointClass;
  const requestedRight = normalizeString(requestContext.requestedRight) ||
    endpoint.requestedRight ||
    AUTH_RIGHTS.READBACK_AUDIT;
  const scope = normalizeString(requestContext.scope || requestContext.requestedScope);
  const base = {
    endpointClass,
    method: endpoint.method,
    path: endpoint.path,
    requestedRight,
    scope,
    role: identity.role,
    authenticatedIdentityId: identity.authenticatedIdentityId,
    audit: buildAuthAuditDecision({
      identityContext: identity,
      requestContext: {
        ...requestContext,
        endpointClass,
        method: endpoint.method,
        path: endpoint.path,
        requestedRight,
        scope
      },
      allowed: false,
      reason: "pending"
    })
  };

  if (endpointClass === ENDPOINT_CLASSES.UNKNOWN) {
    return deny("unknown_endpoint", base);
  }

  if (requestedRight === AUTH_RIGHTS.OPERATIONAL_AUTHORITY) {
    return deny("operational_authority_denied", base);
  }

  if (WRITE_RIGHTS.has(requestedRight) || endpointClass === ENDPOINT_CLASSES.WRITE_BLOCKED) {
    return deny("write_denied", base);
  }

  if (!READ_ONLY_RIGHTS.has(requestedRight)) {
    return deny("unknown_requested_right", base);
  }

  if (endpointClass === ENDPOINT_CLASSES.PUBLIC_READ_ONLY) {
    if (requestedRight !== AUTH_RIGHTS.READ_ONLY) {
      return deny("public_read_only_only", base);
    }
    return allow("public_read_allowed", base);
  }

  if (endpointClass === ENDPOINT_CLASSES.REVIEW_NEEDED_READ_ONLY) {
    return deny("review_needed_not_private_runtime", base);
  }

  if (endpointClass !== ENDPOINT_CLASSES.PRIVATE_READBACK_CANDIDATE) {
    return deny("unknown_endpoint_class", base);
  }

  if (!scope) {
    return deny("missing_scope", base);
  }

  if (HIGH_RISK_SCOPES.includes(scope)) {
    return deny("high_risk_scope_denied", base);
  }

  const catalog = normalizeRoleScopeCatalog(requestContext.roleScopeCatalog);
  const knownScopes = getKnownScopes(catalog);
  if (!knownScopes.has(scope)) {
    return deny("unknown_scope", base);
  }

  if (!identity.authenticatedIdentityId) {
    return deny("missing_identity", base);
  }

  if (!identity.trustedBoundary) {
    return deny("trusted_boundary_required", base);
  }

  if (!identity.role) {
    return deny("missing_role", base);
  }

  if (!Object.prototype.hasOwnProperty.call(catalog, identity.role)) {
    return deny("unknown_role", base);
  }

  if (!identity.scopes.includes(scope)) {
    return deny("identity_scope_not_assigned", base);
  }

  const roleScopeRights = catalog[identity.role] || {};
  const rights = Array.isArray(roleScopeRights[scope]) ? roleScopeRights[scope] : [];
  if (!rights.includes(AUTH_RIGHTS.READBACK_AUDIT) && !rights.includes(AUTH_RIGHTS.READ_ONLY)) {
    return deny("role_scope_not_allowed", base);
  }

  return allow("readback_allowed", {
    ...base,
    role: identity.role,
    authenticatedIdentityId: identity.authenticatedIdentityId
  });
}

function buildAuthAuditDecision({
  identityContext = {},
  requestContext = {},
  allowed = false,
  reason = "unknown"
} = {}) {
  const identity = normalizeIdentityContext(identityContext);
  const method = normalizeMethod(requestContext.method);
  const path = normalizePath(requestContext.path);
  const scope = normalizeString(requestContext.scope || requestContext.requestedScope);
  const requestedRight = normalizeString(requestContext.requestedRight);

  return {
    authenticatedIdentityId: identity.authenticatedIdentityId,
    role: identity.role,
    actor: identity.actor,
    device: identity.device,
    clientContext: identity.clientContext,
    sourceIp: identity.sourceIp,
    localNetworkMetadata: identity.localNetworkMetadata,
    trustedBoundary: identity.trustedBoundary,
    actorIsIdentity: false,
    deviceIsIdentity: false,
    clientContextIsIdentity: false,
    method,
    path,
    endpointClass: normalizeString(requestContext.endpointClass),
    scope,
    requestedRight,
    decision: allowed ? "allow" : "deny",
    reason
  };
}

function endpointDecision(endpointClass, method, path, reason, extra = {}) {
  return {
    endpointClass,
    method,
    path,
    reason,
    requestedRight: AUTH_RIGHTS.READ_ONLY,
    ...extra
  };
}

function allow(reason, details) {
  return withDecision(true, reason, details);
}

function deny(reason, details) {
  return withDecision(false, reason, details);
}

function withDecision(allowed, reason, details) {
  return {
    allowed,
    reason,
    endpointClass: details.endpointClass,
    method: details.method,
    path: details.path,
    requestedRight: details.requestedRight,
    scope: details.scope,
    role: details.role,
    authenticatedIdentityId: details.authenticatedIdentityId,
    audit: buildAuthAuditDecision({
      identityContext: {
        identity: {
          id: details.authenticatedIdentityId,
          role: details.role,
          scopes: details.scope ? [details.scope] : []
        },
        trustedBoundary: details.audit?.trustedBoundary === true,
        actor: details.audit?.actor,
        device: details.audit?.device,
        clientContext: details.audit?.clientContext,
        sourceIp: details.audit?.sourceIp,
        localNetworkMetadata: details.audit?.localNetworkMetadata
      },
      requestContext: details,
      allowed,
      reason
    })
  };
}

function normalizeRoleScopeCatalog(catalog) {
  if (!isPlainObject(catalog)) return Object.freeze({});
  return Object.freeze(
    Object.entries(catalog).reduce((result, [role, scopes]) => {
      if (!isPlainObject(scopes)) return result;
      result[role] = Object.freeze(
        Object.entries(scopes).reduce((scopeResult, [scope, rights]) => {
          scopeResult[scope] = Object.freeze(
            Array.isArray(rights) ? rights.map(normalizeString).filter(Boolean) : []
          );
          return scopeResult;
        }, {})
      );
      return result;
    }, {})
  );
}

function getKnownScopes(catalog) {
  const scopes = new Set();
  Object.values(catalog).forEach((roleScopes) => {
    Object.keys(roleScopes).forEach((scope) => scopes.add(scope));
  });
  return scopes;
}

function hasEndpoint(entries, method, path) {
  return entries.some(([entryMethod, entryPath]) => entryMethod === method && entryPath === path);
}

function normalizeMethod(method) {
  return normalizeString(method)?.toUpperCase() || null;
}

function normalizePath(rawPath) {
  const value = normalizeString(rawPath);
  if (!value) return null;
  const withoutQuery = value.split("?")[0].split("#")[0];
  if (!withoutQuery) return "/";
  return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(normalizeString).filter(Boolean));
  }
  const normalized = normalizeString(value);
  return Object.freeze(normalized ? [normalized] : []);
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clonePlainObject(value) {
  if (!isPlainObject(value)) return null;
  return Object.freeze({ ...value });
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

module.exports = {
  AUTH_RIGHTS,
  ENDPOINT_CLASSES,
  HIGH_RISK_SCOPES,
  buildAuthAuditDecision,
  classifyEndpoint,
  evaluateAuthDecision,
  isTrustedIdentityContext,
  normalizeIdentityContext
};

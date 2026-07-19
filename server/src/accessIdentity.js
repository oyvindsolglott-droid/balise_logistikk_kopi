"use strict";

const ACCESS_IDENTITY_SOURCE = "cloudflare_access_jwt";
const ACCESS_JWT_ALGORITHM = "RS256";
const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const MAX_IDENTITY_VALUE_LENGTH = 320;

let joseModulePromise = null;
const remoteJwksByUrl = new Map();

function getAccessIdentityConfiguration(env = process.env){
  const rawTeamDomain = normalizeString(env.SDE_CF_ACCESS_TEAM_DOMAIN);
  const audience = normalizeString(env.SDE_CF_ACCESS_AUDIENCE);

  if(!rawTeamDomain || !audience){
    return Object.freeze({
      configured: false,
      valid: false,
      diagnosticCode: "access_configuration_missing"
    });
  }

  let teamDomain;
  try{
    const parsed = new URL(rawTeamDomain);
    const validOrigin = parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      (parsed.pathname === "" || parsed.pathname === "/") &&
      parsed.search === "" &&
      parsed.hash === "";
    const validAccessHost = parsed.hostname.toLowerCase().endsWith(".cloudflareaccess.com");
    if(!validOrigin || !validAccessHost) throw new Error("invalid Cloudflare Access origin");
    teamDomain = parsed.origin;
  }catch(_error){
    return Object.freeze({
      configured: true,
      valid: false,
      diagnosticCode: "access_configuration_invalid"
    });
  }

  if(audience.length > MAX_IDENTITY_VALUE_LENGTH){
    return Object.freeze({
      configured: true,
      valid: false,
      diagnosticCode: "access_configuration_invalid"
    });
  }

  return Object.freeze({
    configured: true,
    valid: true,
    diagnosticCode: null,
    teamDomain,
    issuer: teamDomain,
    audience,
    jwksUrl: `${teamDomain}${ACCESS_CERTS_PATH}`,
    algorithm: ACCESS_JWT_ALGORITHM
  });
}

function extractAccessJwtAssertion(headers = {}){
  const value = getHeaderValue(headers, "cf-access-jwt-assertion");
  if(typeof value !== "string") return null;
  const token = value.trim();
  return token || null;
}

async function verifyAccessIdentityRequest(options = {}){
  const config = getAccessIdentityConfiguration(options.env || process.env);
  if(!config.valid){
    return failureResult(
      503,
      config.diagnosticCode,
      config.diagnosticCode === "access_configuration_missing"
        ? "access_identity_configuration_missing"
        : "access_identity_configuration_invalid"
    );
  }

  const token = extractAccessJwtAssertion(options.headers);
  if(!token){
    return failureResult(401, "access_token_missing", "authentication_required");
  }

  try{
    const verification = options.verifier
      ? await options.verifier(token, config)
      : await verifyTokenWithJose(token, config, options.jwks);
    const identity = projectVerifiedIdentity(verification.payload, verification.protectedHeader, config);
    return Object.freeze({
      ok: true,
      status: 200,
      diagnosticCode: null,
      identity
    });
  }catch(error){
    const diagnosticCode = classifyVerificationError(error);
    if(diagnosticCode === "access_jwks_unavailable"){
      return failureResult(503, diagnosticCode, "access_identity_verification_unavailable");
    }
    return failureResult(401, diagnosticCode, "authentication_failed");
  }
}

async function verifyTokenWithJose(token, config, injectedJwks){
  const jose = await loadJose();
  const jwks = injectedJwks || await getRemoteJwks(jose, config.jwksUrl);
  return jose.jwtVerify(token, jwks, {
    algorithms: [ACCESS_JWT_ALGORITHM],
    issuer: config.issuer,
    audience: config.audience,
    requiredClaims: ["sub", "iat", "exp"]
  });
}

async function getRemoteJwks(jose, jwksUrl){
  let jwks = remoteJwksByUrl.get(jwksUrl);
  if(!jwks){
    jwks = jose.createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
      cacheMaxAge: 600000
    });
    remoteJwksByUrl.set(jwksUrl, jwks);
  }
  return jwks;
}

function projectVerifiedIdentity(payload, protectedHeader, config){
  if(!payload || typeof payload !== "object" || Array.isArray(payload)){
    throw invalidVerifiedPayload();
  }
  if(!protectedHeader || protectedHeader.alg !== ACCESS_JWT_ALGORITHM){
    throw invalidVerifiedPayload();
  }

  const subject = normalizeSafeIdentityValue(payload.sub);
  if(!subject || typeof payload.iat !== "number" || typeof payload.exp !== "number"){
    throw invalidVerifiedPayload();
  }

  const email = normalizeEmail(payload.email);
  const serviceTokenId = normalizeSafeIdentityValue(payload.common_name);
  const tokenId = normalizeSafeIdentityValue(payload.jti);
  const identityKind = serviceTokenId ? "service" : (email ? "human" : "unknown");
  const identity = {
    authenticated: true,
    identityVerified: true,
    identitySource: ACCESS_IDENTITY_SOURCE,
    identityKind,
    subject,
    issuedAt: epochSecondsToIso(payload.iat),
    expiresAt: epochSecondsToIso(payload.exp),
    issuer: config.issuer,
    audienceMatched: true,
    roleResolved: false,
    roles: Object.freeze([]),
    runtimeRoleEnforcement: false,
    writeAuthority: false
  };

  if(email && identityKind === "human") identity.email = email;
  if(tokenId) identity.tokenId = tokenId;
  if(serviceTokenId && identityKind === "service") identity.serviceTokenId = serviceTokenId;
  return Object.freeze(identity);
}

function createAccessIdentitySessionHandler(options = {}){
  const env = options.env || process.env;
  const jwks = options.jwks;
  const verifier = options.verifier;

  return async function accessIdentitySessionHandler(req, res){
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
    const result = await verifyAccessIdentityRequest({
      headers: req.headers,
      env,
      jwks,
      verifier
    });

    if(result.ok){
      return res.status(200).json({
        ok: true,
        ...result.identity
      });
    }

    return res.status(result.status).json({
      ok: false,
      error: result.publicError,
      ...unauthenticatedIdentityReadModel()
    });
  };
}

function failureResult(status, diagnosticCode, publicError){
  return Object.freeze({
    ok: false,
    status,
    diagnosticCode,
    publicError,
    identity: unauthenticatedIdentityReadModel()
  });
}

function unauthenticatedIdentityReadModel(){
  return Object.freeze({
    authenticated: false,
    identityVerified: false,
    identitySource: ACCESS_IDENTITY_SOURCE,
    identityKind: "unknown",
    roleResolved: false,
    roles: Object.freeze([]),
    runtimeRoleEnforcement: false,
    writeAuthority: false
  });
}

function classifyVerificationError(error){
  if(error?.code === "ERR_JWT_EXPIRED") return "access_token_expired";
  if(error?.code === "ERR_JWT_CLAIM_VALIDATION_FAILED"){
    if(error.claim === "iss") return "access_token_issuer_mismatch";
    if(error.claim === "aud") return "access_token_audience_mismatch";
    return "access_token_invalid";
  }

  if([
    "ERR_JWKS_NETWORK",
    "ERR_JWKS_TIMEOUT",
    "ERR_JWKS_INVALID",
    "ERR_JOSE_GENERIC"
  ].includes(error?.code)){
    return "access_jwks_unavailable";
  }

  if(error instanceof TypeError && isLikelyNetworkError(error)){
    return "access_jwks_unavailable";
  }

  return "access_token_invalid";
}

function isLikelyNetworkError(error){
  return error?.cause !== undefined || /fetch|network|socket|connect|dns/i.test(String(error?.message || ""));
}

function invalidVerifiedPayload(){
  const error = new Error("Verified Access token payload did not satisfy the identity contract.");
  error.code = "ERR_ACCESS_IDENTITY_PAYLOAD";
  return error;
}

function epochSecondsToIso(value){
  const date = new Date(value * 1000);
  if(!Number.isFinite(date.getTime())) throw invalidVerifiedPayload();
  return date.toISOString();
}

function normalizeEmail(value){
  const normalized = normalizeString(value)?.toLowerCase();
  if(!normalized || normalized.length > 254) return null;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeSafeIdentityValue(value){
  const normalized = normalizeString(value);
  if(!normalized || normalized.length > MAX_IDENTITY_VALUE_LENGTH) return null;
  if(/[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeString(value){
  if(typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function getHeaderValue(headers, expectedName){
  if(!headers || typeof headers !== "object") return null;
  const expected = expectedName.toLowerCase();
  for(const [name, value] of Object.entries(headers)){
    if(name.toLowerCase() !== expected) continue;
    if(Array.isArray(value)) return value.length === 1 ? value[0] : null;
    return value;
  }
  return null;
}

function loadJose(){
  joseModulePromise ||= import("jose");
  return joseModulePromise;
}

module.exports = {
  ACCESS_IDENTITY_SOURCE,
  ACCESS_JWT_ALGORITHM,
  classifyVerificationError,
  createAccessIdentitySessionHandler,
  extractAccessJwtAssertion,
  getAccessIdentityConfiguration,
  projectVerifiedIdentity,
  verifyAccessIdentityRequest,
  verifyTokenWithJose
};

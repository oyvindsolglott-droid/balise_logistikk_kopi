"use strict";

const { result } = require("./core.cjs");

const ALLOWED_METHODS = Object.freeze(new Set(["GET", "HEAD"]));
const DEFAULT_ENDPOINTS = Object.freeze([
  "/api/health",
  "/api/server/status",
  "/api/state/revision",
  "/api/operational-state/events",
  "/api/shared-sporplan-draft",
  "/api/vehicle-status"
]);

function assertReadOnlyMethod(method) {
  const normalized = String(method || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(normalized)) {
    throw new Error(`SDE_QE_READ_ONLY_GUARD: ${normalized} er forbudt`);
  }
  return normalized;
}

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.startsWith("/") || endpoint.startsWith("//")) {
    throw new Error(`Ugyldig production-endepunkt: ${String(endpoint)}`);
  }
  return endpoint;
}

async function guardedFetch(baseUrl, endpoint, options = {}) {
  const method = assertReadOnlyMethod(options.method);
  const normalized = normalizeEndpoint(endpoint);
  const url = new URL(normalized, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error("SDE_QE_READ_ONLY_GUARD: cross-origin forespørsel er forbudt");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10_000);
  try {
    const response = await fetch(url, {
      method,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.1" }
    });
    const body = method === "HEAD" ? "" : await response.text();
    return {
      method,
      endpoint: normalized,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") || "",
      bodyLength: body.length,
      body: body.slice(0, 20_000)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runProductionReadOnly(baseUrl, endpoints = DEFAULT_ENDPOINTS) {
  if (!baseUrl) {
    return {
      ledger: [],
      results: [
        result({
          id: "PROD-READONLY-URL",
          contractId: "QE-SAFE-001",
          area: "production-safety",
          name: "Produksjonskontroll er teknisk read-only",
          status: "BLOCKED",
          critical: true,
          summary: "SDE_QE_PRODUCTION_URL er ikke satt; ingen produksjonsforespørsel ble sendt.",
          evidence: ["request-ledger: 0 requests"],
          recommendation: "Sett SDE_QE_PRODUCTION_URL eksplisitt og kjør npm run test:sde:production-readonly."
        })
      ]
    };
  }

  const ledger = [];
  const results = [];
  for (const endpoint of endpoints) {
    try {
      const observed = await guardedFetch(baseUrl, endpoint, { method: "GET" });
      ledger.push({ method: observed.method, endpoint: observed.endpoint, status: observed.status });
      results.push(result({
        id: `PROD-GET-${endpoint.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase()}`,
        contractId: "QE-SAFE-001",
        area: "production-readonly",
        name: `GET ${endpoint}`,
        status: observed.ok ? "GREEN" : "RED",
        critical: true,
        summary: observed.ok ? `HTTP ${observed.status}` : `HTTP ${observed.status}`,
        evidence: [`GET ${endpoint}`, `content-type=${observed.contentType}`, `bytes=${observed.bodyLength}`],
        details: { status: observed.status, contentType: observed.contentType, bodyLength: observed.bodyLength }
      }));
    } catch (error) {
      results.push(result({
        id: `PROD-GET-${endpoint.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toUpperCase()}`,
        contractId: "QE-SAFE-001",
        area: "production-readonly",
        name: `GET ${endpoint}`,
        status: "BLOCKED",
        critical: true,
        summary: `Read-only kontroll kunne ikke fullføres: ${error.message}`,
        evidence: [`request-ledger=${JSON.stringify(ledger)}`],
        recommendation: "Bekreft nettverk, autentisert lesekontekst og endpoint uten å utvide tillatte HTTP-metoder."
      }));
    }
  }
  return { ledger, results };
}

module.exports = {
  ALLOWED_METHODS,
  DEFAULT_ENDPOINTS,
  assertReadOnlyMethod,
  guardedFetch,
  normalizeEndpoint,
  runProductionReadOnly
};

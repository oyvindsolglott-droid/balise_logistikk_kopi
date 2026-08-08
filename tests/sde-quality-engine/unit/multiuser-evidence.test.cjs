"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { result, summarize } = require("../lib/core.cjs");
const {
  DATA_ONLY_PATHS,
  buildEvidenceManifest,
  evaluateActualSyncEvidence,
  evaluateMultiuserEvidence,
  manifestHash,
  stableStringify
} = require("../lib/multiuser-evidence.cjs");
const { canonicalGateProjection, renderHtml, renderJUnit } = require("../lib/reporters.cjs");

const APPROVED_SHA = "a".repeat(40);
const APPROVED_TREE = "b".repeat(40);
const FIXED_NOW = new Date("2026-08-08T14:00:00.000Z");

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function writeJson(file, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, raw);
  return raw;
}

function validLive(runId = "run-1") {
  const identities = [
    {
      maskedIdentity: "user-a-****",
      upstreamIssuer: "access.example.invalid",
      upstreamPrincipalId: "subject-a",
      serverSubject: "subject-a",
      identitySource: "cloudflare-access",
      role: "dispatcher",
      capabilities: ["read:sporplan"],
      accessResult: "ALLOWED",
      authContainerId: "auth-a",
      sessionContainerId: "session-a",
      cookieStoreId: "cookie-store-a",
      localStorageContainerId: "local-storage-a",
      sessionStorageContainerId: "session-storage-a"
    },
    {
      maskedIdentity: "user-b-****",
      upstreamIssuer: "access.example.invalid",
      upstreamPrincipalId: "subject-b",
      serverSubject: "subject-b",
      identitySource: "cloudflare-access",
      role: "viewer",
      capabilities: ["read:sporplan"],
      accessResult: "ALLOWED",
      authContainerId: "auth-b",
      sessionContainerId: "session-b",
      cookieStoreId: "cookie-store-b",
      localStorageContainerId: "local-storage-b",
      sessionStorageContainerId: "session-storage-b"
    }
  ];
  return {
    schemaId: "sde-multiuser-live-observations",
    schemaVersion: "1",
    collectionRunId: runId,
    observedAt: FIXED_NOW.toISOString(),
    identities,
    stateReadbacks: identities.map((identity) => ({ containerId: identity.sessionContainerId, subject: identity.serverSubject, capabilities: identity.capabilities })),
    viewportObservations: identities.flatMap((identity) => ["desktop", "mobile"].map((viewport) => ({ containerId: identity.sessionContainerId, viewport, result: "PASS" }))),
    polling: { ticks: 4, durationSeconds: 45 },
    writeGuard: { result: "PASS", allowedMethods: ["GET", "HEAD"], protectedMethods: ["POST", "PUT", "PATCH", "DELETE"] },
    networkSummaryRef: "network-summary-redacted.json",
    consoleErrors: 0,
    requestErrors: 0,
    pageErrors: 0,
    businessState: {
      snapshots: [0, 1, 2].map((index) => ({
        reference: `business-state-${index}.json`,
        businessLogicalHash: "c".repeat(64),
        fullDatabaseLogicalHash: "d".repeat(64),
        auditCursor: index
      })),
      technicalAppendOnlyEvents: [],
      productionWriteLedger: []
    }
  };
}

function validIsolated(runId = "run-1") {
  const assertions = Object.fromEntries([
    "send", "receive", "reply", "acknowledgement", "receipt",
    "threadId", "rootMessageId", "parentMessageId", "senderLevel",
    "capabilityEnforcement", "idempotency", "noDuplicates", "noReplyLoop",
    "noAcknowledgementLoop", "noReceiptLoop", "sessionIsolation",
    "identityIsolation", "sequential", "concurrent"
  ].map((key) => [key, "PASS"]));
  return {
    schemaId: "sde-multiuser-isolated-write-results",
    schemaVersion: "1",
    collectionRunId: runId,
    environment: {
      kind: "isolated-test-server",
      databasePath: "[TMP]/synthetic-isolated.sqlite",
      productionNetworkCalls: 0,
      productionSecretsPresent: false,
      codeSha: APPROVED_SHA,
      codeTree: APPROVED_TREE
    },
    commands: [{ command: "node --test synthetic-multiuser.test.cjs", exitCode: 0 }],
    totals: { passed: Object.keys(assertions).length, failed: 0, skipped: 0 },
    assertions
  };
}

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-multiuser-"));
  const runId = options.runId || "run-1";
  const livePath = path.join(directory, "live-observations.json");
  const isolatedPath = path.join(directory, "isolated-write-results.json");
  const manifestPath = path.join(directory, "evidence-package.json");
  const live = options.live === null ? null : structuredClone(options.live || validLive(runId));
  const isolated = options.isolated === null ? null : structuredClone(options.isolated || validIsolated(runId));
  if (live) writeJson(livePath, live);
  if (isolated) writeJson(isolatedPath, isolated);
  const manifest = buildEvidenceManifest({
    livePath: live ? livePath : null,
    isolatedPath: isolated ? isolatedPath : null,
    outputPath: manifestPath,
    approvedSha: APPROVED_SHA,
    approvedTree: APPROVED_TREE,
    now: FIXED_NOW,
    collectionRunId: runId
  });
  if (options.manifest) options.manifest(manifest);
  if (!options.preserveManifestHash) manifest.manifest.payloadSha256 = manifestHash(manifest);
  writeJson(manifestPath, manifest);
  const evaluate = (overrides = {}) => evaluateMultiuserEvidence({
    inputPath: manifestPath,
    approvedSha: APPROVED_SHA,
    approvedTree: APPROVED_TREE,
    now: FIXED_NOW,
    ...overrides
  });
  const rewriteArtifact = (kind, value, { updateReference = true } = {}) => {
    const file = kind === "live-observations" ? livePath : isolatedPath;
    const raw = writeJson(file, value);
    if (updateReference) {
      const reference = manifest.artifacts.find((item) => item.kind === kind);
      reference.sha256 = sha256(raw);
      reference.bytes = Buffer.byteLength(raw);
      manifest.manifest.payloadSha256 = manifestHash(manifest);
      writeJson(manifestPath, manifest);
    }
  };
  return { directory, live, isolated, manifest, manifestPath, livePath, isolatedPath, evaluate, rewriteArtifact };
}

function cleanup(value) {
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function subgate(gate, id) {
  return gate.details.subgates.find((item) => item.id === id);
}

function sampleReport(gate) {
  return {
    runId: "multiuser-unit",
    generatedAt: FIXED_NOW.toISOString(),
    suite: "unit",
    git: { commit: APPROVED_SHA, branch: "test", baseline: APPROVED_SHA, clean: true, changedFiles: [] },
    results: [gate],
    summary: summarize([gate]),
    functionMatrix: [],
    commands: [],
    productionSafety: { allowedMethods: ["GET", "HEAD"], ledger: [], guardVerified: true },
    recommendations: []
  };
}

test("01 ingen evidensfil gir BLOCKED", () => {
  const gate = evaluateMultiuserEvidence({ approvedSha: APPROVED_SHA, approvedTree: APPROVED_TREE, now: FIXED_NOW });
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_EVIDENCE_MISSING");
});

test("02 ugyldig JSON gir BLOCKED", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-invalid-json-"));
  const file = path.join(directory, "evidence.json");
  fs.writeFileSync(file, "{not-json");
  const gate = evaluateMultiuserEvidence({ inputPath: file, approvedSha: APPROVED_SHA, approvedTree: APPROVED_TREE, now: FIXED_NOW });
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_EVIDENCE_MALFORMED");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("03 ukjent schema gir BLOCKED", () => {
  const value = fixture({ manifest: (manifest) => { manifest.schemaVersion = "999"; } });
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_UNKNOWN_SCHEMA");
  cleanup(value);
});

test("04 feil manifesthash gir BLOCKED", () => {
  const value = fixture();
  value.manifest.narrativeAssessment = "edited after hashing";
  writeJson(value.manifestPath, value.manifest);
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_MANIFEST_HASH_MISMATCH");
  cleanup(value);
});

test("05 feil kildeartefakthash blir aldri GREEN", () => {
  const value = fixture();
  value.live.consoleErrors = 1;
  value.rewriteArtifact("live-observations", value.live, { updateReference: false });
  const gate = value.evaluate();
  assert.notEqual(gate.status, "GREEN");
  assert.equal(gate.reasonCode, "MULTIUSER_SOURCE_ARTIFACT_HASH_MISMATCH");
  cleanup(value);
});

test("06 feil kode-SHA gir BLOCKED", () => {
  const value = fixture();
  const gate = value.evaluate({ approvedSha: "f".repeat(40) });
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_WRONG_CODE_IDENTITY");
  cleanup(value);
});

test("07 gyldig data-only descendant tillates", () => {
  const value = fixture({ manifest: (manifest) => {
    manifest.codeIdentity.runtimeHead = "c".repeat(40);
    manifest.codeIdentity.runtimeTree = "d".repeat(40);
    manifest.codeIdentity.ancestry = [{ sha: "c".repeat(40), changedFiles: [...DATA_ONLY_PATHS] }];
  } });
  const gate = value.evaluate();
  assert.equal(gate.status, "GREEN");
  assert.equal(subgate(gate, "MULTIUSER-CODE-BINDING").reasonCode, "MULTIUSER_DATA_ONLY_DESCENDANT_VALID");
  cleanup(value);
});

test("08 descendant med kode- eller assetfil blir BLOCKED", () => {
  const value = fixture({ manifest: (manifest) => {
    manifest.codeIdentity.runtimeHead = "c".repeat(40);
    manifest.codeIdentity.runtimeTree = "d".repeat(40);
    manifest.codeIdentity.ancestry = [{ sha: "c".repeat(40), changedFiles: ["index.html"] }];
    manifest.codeIdentity.codeAssetHashes.runtime = "e".repeat(64);
  } });
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_DESCENDANT_NOT_DATA_ONLY");
  cleanup(value);
});

test("09 bare én identitet gir BLOCKED/TOOL BLOCKER-semantikk", () => {
  const value = fixture();
  value.live.identities.pop();
  value.rewriteArtifact("live-observations", value.live);
  const gate = value.evaluate();
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_SECOND_IDENTITY_NOT_ESTABLISHED");
  cleanup(value);
});

test("10 samme subject uten to upstream-identiteter er BLOCKED, ikke RED", () => {
  const value = fixture();
  value.live.identities[1].upstreamPrincipalId = "subject-a";
  value.live.identities[1].serverSubject = "subject-a";
  value.rewriteArtifact("live-observations", value.live);
  const gate = value.evaluate();
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_SECOND_IDENTITY_NOT_ESTABLISHED");
  cleanup(value);
});

test("11 ulike upstream-identiteter med krysset serverreadback gir RED", () => {
  const value = fixture();
  value.live.identities[0].serverSubject = "subject-b";
  value.live.identities[1].serverSubject = "subject-a";
  value.rewriteArtifact("live-observations", value.live);
  const gate = value.evaluate();
  assert.equal(gate.status, "RED");
  assert.equal(gate.reasonCode, "MULTIUSER_IDENTITY_COLLISION_OR_LEAKAGE");
  assert.equal(summarize([gate]).classification, "NO-GO");
  cleanup(value);
});

test("12 ulike subjects uten bevist sessionseparasjon gir BLOCKED", () => {
  const value = fixture();
  value.live.stateReadbacks = [];
  value.rewriteArtifact("live-observations", value.live);
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_SESSION_SEPARATION_UNPROVEN");
  cleanup(value);
});

test("13 live GREEN og manglende isolated-write gir aggregat BLOCKED", () => {
  const value = fixture({ isolated: null });
  const gate = value.evaluate();
  assert.equal(subgate(gate, "MULTIUSER-LIVE-READONLY").status, "GREEN");
  assert.equal(subgate(gate, "MULTIUSER-ISOLATED-WRITE").status, "BLOCKED");
  assert.equal(gate.status, "BLOCKED");
  cleanup(value);
});

test("14 isolated-write GREEN og manglende live gir aggregat BLOCKED", () => {
  const value = fixture({ live: null });
  const gate = value.evaluate();
  assert.equal(subgate(gate, "MULTIUSER-ISOLATED-WRITE").status, "GREEN");
  assert.equal(subgate(gate, "MULTIUSER-LIVE-READONLY").status, "BLOCKED");
  assert.equal(gate.status, "BLOCKED");
  cleanup(value);
});

test("15 begge underporter GREEN med kompatibel kode gir aggregat GREEN", () => {
  const value = fixture();
  assert.equal(value.evaluate().status, "GREEN");
  cleanup(value);
});

test("16 identitets-, cache- eller sessionlekkasje gir RED", () => {
  const value = fixture();
  value.live.identities[1].sessionContainerId = "session-a";
  value.rewriteArtifact("live-observations", value.live);
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_SESSION_OR_CACHE_LEAKAGE");
  assert.equal(value.evaluate().status, "RED");
  cleanup(value);
});

test("17 produksjons-business-write i live-evidens gir RED", () => {
  const value = fixture();
  value.live.businessState.productionWriteLedger.push({ method: "POST", category: "BUSINESS_WRITE" });
  value.rewriteArtifact("live-observations", value.live);
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_LIVE_BUSINESS_WRITE");
  cleanup(value);
});

test("18 cookie, token eller JWT gir RED uten å gjengis", () => {
  const value = fixture();
  const syntheticSecret = "eyJzeW50aGV0aWMiOiJ0cnVlIn0.QUJDREVGR0hJSktMTU5PUA.c3ludGhldGljLXNpZ25hdHVyZQ";
  value.live.jwt = syntheticSecret;
  value.rewriteArtifact("live-observations", value.live);
  const gate = value.evaluate();
  assert.equal(gate.status, "RED");
  assert.equal(gate.reasonCode, "MULTIUSER_SECRET_FOUND");
  assert.doesNotMatch(JSON.stringify(gate), new RegExp(syntheticSecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  cleanup(value);
});

test("19 legitim append-only Access-event med full attribusjon er ikke RED", () => {
  const value = fixture();
  value.live.businessState.snapshots[1].fullDatabaseLogicalHash = "e".repeat(64);
  value.live.businessState.snapshots[2].fullDatabaseLogicalHash = "f".repeat(64);
  value.live.businessState.technicalAppendOnlyEvents = [{ kind: "ACCESS_AUDIT", attributed: true, actor: "masked-access-subject" }];
  value.rewriteArtifact("live-observations", value.live);
  assert.equal(value.evaluate().status, "GREEN");
  cleanup(value);
});

test("20 databasehash endret uten attribusjon gir BLOCKED", () => {
  const value = fixture();
  value.live.businessState.snapshots[2].fullDatabaseLogicalHash = "e".repeat(64);
  value.rewriteArtifact("live-observations", value.live);
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_DATABASE_CHANGE_UNATTRIBUTED");
  cleanup(value);
});

test("21 narrativ GREEN kan ikke overstyre kanonisk BLOCKED", () => {
  const value = fixture({ isolated: null, manifest: (manifest) => { manifest.narrativeAssessment = "GREEN"; } });
  const gate = value.evaluate();
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.details.narrativeAssessment, "NON_AUTHORITATIVE");
  cleanup(value);
});

test("22 hardkodet BLOCKED er fjernet, men tom evidens forblir BLOCKED", () => {
  const gate = evaluateMultiuserEvidence({ inputPaths: [], approvedSha: APPROVED_SHA, approvedTree: APPROVED_TREE, now: FIXED_NOW });
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.id, "MULTIUSER-LIVE-001");
});

test("23 manuelt redigert QE-status uten evidens avvises", () => {
  const value = fixture({ manifest: (manifest) => { manifest.canonicalGateStatus = "GREEN"; } });
  const gate = value.evaluate();
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_UNTRUSTED_FINAL_STATUS");
  cleanup(value);
});

test("24 to up_to_date uten faktisk synced-evidens gir ikke actual-sync GREEN", () => {
  assert.deepEqual(evaluateActualSyncEvidence(["up_to_date", "up_to_date"], []), { status: "BLOCKED", reasonCode: "ACTUAL_SYNC_NOT_OBSERVED" });
});

test("25 faktisk synced med kun tre autoriserte datafiler kan bli GREEN", () => {
  assert.deepEqual(evaluateActualSyncEvidence(["up_to_date", "synced"], [...DATA_ONLY_PATHS]), { status: "GREEN", reasonCode: "ACTUAL_SYNC_DATA_ONLY_VALID" });
});

test("26 teknisk gyldig JSON fra ukjent produsent gir BLOCKED", () => {
  const value = fixture({ manifest: (manifest) => { manifest.producer.id = "handwritten-json"; } });
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_UNKNOWN_PRODUCER");
  cleanup(value);
});

test("27 manglende produsentmetadata gir BLOCKED", () => {
  const value = fixture({ manifest: (manifest) => { delete manifest.producer; } });
  assert.equal(value.evaluate().status, "BLOCKED");
  cleanup(value);
});

test("28 produsent uten source artifact chain gir BLOCKED", () => {
  const value = fixture({ manifest: (manifest) => { manifest.artifacts = []; } });
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_SOURCE_CHAIN_MISSING");
  cleanup(value);
});

test("29 manuell attestasjon kan ikke erstatte maskinassertion", () => {
  const value = fixture({ manifest: (manifest) => { manifest.producer.manualAttestations = ["sessionIsolation=true"]; } });
  value.live.stateReadbacks = [];
  value.rewriteArtifact("live-observations", value.live);
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_SESSION_SEPARATION_UNPROVEN");
  cleanup(value);
});

test("30 selvdeklarert subjectsDifferent uten observasjon avvises", () => {
  const value = fixture();
  value.live.subjectsDifferent = true;
  value.rewriteArtifact("live-observations", value.live);
  const gate = value.evaluate();
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_UNTRUSTED_FINAL_STATUS");
  cleanup(value);
});

test("31 urelatert BLOCKED-port forblir uendret", () => {
  const value = fixture();
  const unrelated = result({ id: "UX-LIVE-001", area: "ux", name: "UX", status: "BLOCKED", critical: false, summary: "Urelatert" });
  const results = [value.evaluate(), unrelated];
  assert.equal(results[0].status, "GREEN");
  assert.equal(results[1].status, "BLOCKED");
  cleanup(value);
});

test("32 parent og children med samme rotårsak dobbelttelles ikke", () => {
  const value = fixture({ isolated: null });
  const gate = value.evaluate();
  assert.equal(gate.counted, true);
  assert.ok(gate.details.subgates.every((item) => item.counted === false));
  assert.equal(summarize([gate]).total, 1);
  cleanup(value);
});

test("33 samme input gir samme status, reason, aggregate og total", () => {
  const value = fixture();
  const first = value.evaluate();
  const second = value.evaluate();
  assert.equal(stableStringify(canonicalGateProjection(first)), stableStringify(canonicalGateProjection(second)));
  assert.deepEqual(summarize([first]), summarize([second]));
  cleanup(value);
});

test("34 JSON, HTML og JUnit eksponerer samme kanoniske gateobjekt", () => {
  const value = fixture();
  const gate = value.evaluate();
  const report = sampleReport(gate);
  const json = JSON.parse(JSON.stringify(report));
  const html = renderHtml(report);
  const junit = renderJUnit(report);
  const projection = canonicalGateProjection(json.results[0]);
  assert.match(html, new RegExp(`data-gate-status="${projection.status}"`));
  assert.match(html, new RegExp(`data-reason-code="${projection.reasonCode}"`));
  assert.match(junit, new RegExp(`&quot;status&quot;:&quot;${projection.status}&quot;`));
  assert.match(junit, new RegExp(`&quot;reasonCode&quot;:&quot;${projection.reasonCode}&quot;`));
  assert.match(html, /"total":1/);
  assert.match(junit, /tests="1"/);
  cleanup(value);
});

test("35 gammel rapport uten nye evidensfelter forblir eksplisitt BLOCKED", () => {
  const legacy = { id: "MULTIUSER-LIVE-001", area: "multiuser", name: "Legacy", status: "BLOCKED", critical: false, summary: "Legacy missing evidence", evidence: [], details: {}, durationMs: 0 };
  const projection = canonicalGateProjection(legacy);
  assert.equal(projection.status, "BLOCKED");
  assert.notEqual(projection.status, "GREEN");
});

test("36 alle kritiske krav validert gir relevant aggregat GREEN", () => {
  const value = fixture();
  const gate = value.evaluate();
  assert.equal(gate.status, "GREEN");
  assert.equal(gate.reasonCode, "MULTIUSER_ALL_CRITICAL_REQUIREMENTS_VALID");
  assert.equal(gate.details.subgates.filter((item) => item.critical).every((item) => item.status === "GREEN"), true);
  cleanup(value);
});

test("37 flere eksplisitte inputpakker gir BLOCKED", () => {
  const first = fixture();
  const second = fixture({ runId: "run-2" });
  const gate = evaluateMultiuserEvidence({ inputPaths: [first.manifestPath, second.manifestPath], approvedSha: APPROVED_SHA, approvedTree: APPROVED_TREE, now: FIXED_NOW });
  assert.equal(gate.reasonCode, "MULTIUSER_CONFLICTING_EVIDENCE");
  cleanup(first);
  cleanup(second);
});

test("38 symlink-input avvises fail-closed", { skip: process.platform === "win32" }, () => {
  const value = fixture();
  const link = path.join(value.directory, "evidence-link.json");
  fs.symlinkSync(value.manifestPath, link);
  const gate = evaluateMultiuserEvidence({ inputPath: link, approvedSha: APPROVED_SHA, approvedTree: APPROVED_TREE, now: FIXED_NOW });
  assert.equal(gate.reasonCode, "MULTIUSER_EVIDENCE_UNSAFE_PATH");
  cleanup(value);
});

test("39 ukjent kritisk felt avvises", () => {
  const value = fixture({ manifest: (manifest) => { manifest.unrecognizedCriticalClaim = true; } });
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_SCHEMA_UNKNOWN_FIELD");
  cleanup(value);
});

test("40 stale kritisk evidens gir BLOCKED", () => {
  const value = fixture();
  const gate = value.evaluate({ now: new Date("2026-08-20T14:00:00.000Z") });
  assert.equal(gate.reasonCode, "MULTIUSER_EVIDENCE_STALE");
  cleanup(value);
});

test("41 alle tre flerbrukerschemaer er lukkede og versjonerte", () => {
  const contracts = path.resolve(__dirname, "../contracts");
  for (const name of [
    "sde-multiuser-evidence-v1.schema.json",
    "sde-multiuser-live-observations-v1.schema.json",
    "sde-multiuser-isolated-write-results-v1.schema.json"
  ]) {
    const schema = JSON.parse(fs.readFileSync(path.join(contracts, name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.additionalProperties, false);
    assert.doesNotMatch(JSON.stringify(schema), /canonicalGateStatus|subjectsDifferent/);
  }
});

test("42 repository-produsenten bygger en validerbar pakke uten sluttstatus", () => {
  const value = fixture();
  assert.equal(value.manifest.producer.id, "sde-qe-multiuser-evidence-pack-builder");
  assert.equal(Object.hasOwn(value.manifest, "canonicalGateStatus"), false);
  assert.equal(value.evaluate().status, "GREEN");
  cleanup(value);
});

test("43 produsenten arver og kryssvaliderer collection run-ID", () => {
  const value = fixture({ runId: "machine-run-43" });
  const inherited = buildEvidenceManifest({
    livePath: value.livePath,
    isolatedPath: value.isolatedPath,
    outputPath: path.join(value.directory, "inherited-package.json"),
    approvedSha: APPROVED_SHA,
    approvedTree: APPROVED_TREE,
    now: FIXED_NOW
  });
  assert.equal(inherited.collectionRunId, "machine-run-43");
  assert.equal(value.evaluate().status, "GREEN");
  cleanup(value);
});

test("44 manglende kritisk boolean er UNPROVEN/BLOCKED, ikke falskt RED", () => {
  const value = fixture();
  delete value.isolated.environment.productionSecretsPresent;
  value.rewriteArtifact("isolated-write-results", value.isolated);
  const gate = value.evaluate();
  assert.equal(gate.status, "BLOCKED");
  assert.equal(gate.reasonCode, "MULTIUSER_SCHEMA_INVALID");
  cleanup(value);
});

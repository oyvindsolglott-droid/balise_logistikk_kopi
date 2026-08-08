"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { gitValue, repoRoot, result } = require("./core.cjs");

const SCHEMA_ID = "sde-multiuser-evidence";
const SCHEMA_VERSION = "1";
const GATE_VERSION = "2.0.0";
const PRODUCER_ID = "sde-qe-multiuser-evidence-pack-builder";
const PRODUCER_VERSION = "1.0.0";
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const DATA_ONLY_PATHS = Object.freeze([
  "data/api_idag.json",
  "data/api_imorgen.json",
  "data/sde-data-provenance.json"
]);
const REQUIRED_ISOLATED_ASSERTIONS = Object.freeze([
  "send", "receive", "reply", "acknowledgement", "receipt",
  "threadId", "rootMessageId", "parentMessageId", "senderLevel",
  "capabilityEnforcement", "idempotency", "noDuplicates",
  "noReplyLoop", "noAcknowledgementLoop", "noReceiptLoop",
  "sessionIsolation", "identityIsolation", "sequential", "concurrent"
]);

class EvidenceError extends Error {
  constructor(reasonCode, message, status = "BLOCKED") {
    super(message);
    this.name = "EvidenceError";
    this.reasonCode = reasonCode;
    this.status = status;
  }
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function manifestPayload(manifest) {
  const copy = structuredClone(manifest);
  if (copy.manifest) copy.manifest.payloadSha256 = "";
  return stableStringify(copy);
}

function manifestHash(manifest) {
  return sha256Bytes(manifestPayload(manifest));
}

function producerSourcePath() {
  return path.join(repoRoot(), "tests/sde-quality-engine/tools/build-multiuser-evidence.cjs");
}

function producerSourceSha256() {
  return sha256Bytes(fs.readFileSync(producerSourcePath()));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, name) {
  if (!isPlainObject(value)) throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", `${name} må være et objekt.`);
  return value;
}

function requireArray(value, name, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", `${name} må være en liste med minst ${min} elementer.`);
  }
  return value;
}

function requireString(value, name, pattern = null) {
  if (typeof value !== "string" || !value.length || (pattern && !pattern.test(value))) {
    throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", `${name} har ugyldig format.`);
  }
  return value;
}

function requireNumber(value, name, { min = null } = {}) {
  if (!Number.isFinite(value) || (min != null && value < min)) {
    throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", `${name} må være et gyldig tall.`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", `${name} må være boolean.`);
  return value;
}

function exactKeys(value, allowed, name) {
  requireObject(value, name);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    const directStatus = unknown.some((key) => /status|green|subjectsDifferent/i.test(key));
    throw new EvidenceError(
      directStatus ? "MULTIUSER_UNTRUSTED_FINAL_STATUS" : "MULTIUSER_SCHEMA_UNKNOWN_FIELD",
      `${name} har ukjente felt: ${unknown.join(", ")}.`
    );
  }
}

const SECRET_KEY_RULES = Object.freeze([
  ["PASSWORD", /^(?:password|passwd|pwd)$/i],
  ["ONE_TIME_CODE", /^(?:otp|passcode|onetimecode)$/i],
  ["AUTHORIZATION", /^(?:authorization|proxyauthorization)$/i],
  ["COOKIE", /^(?:cookie|setcookie|cookievalue)$/i],
  ["COOKIE_HASH", /^(?:cookiehash|sessionhash)$/i],
  ["SESSION_COOKIE", /^(?:sessioncookie|sessiontoken)$/i],
  ["ACCESS_TOKEN", /^(?:accesstoken|cfaccesstoken|idtoken|refreshtoken)$/i],
  ["ACCESS_TOKEN", /^(?:token|authtoken|bearertoken)$/i],
  ["TOKEN_HASH", /^(?:tokenhash|accesstokenhash)$/i],
  ["JWT", /^(?:jwt|jsonwebtoken)$/i],
  ["TUNNEL_TOKEN", /^(?:tunneltoken|cloudflaredtoken)$/i],
  ["API_SECRET", /^(?:apisecret|apikey|clientsecret)$/i],
  ["CREDENTIAL", /^(?:credential|credentials|logincredential)$/i],
  ["GENERIC_SECRET", /^(?:secret|secretvalue|authsecret)$/i]
]);

const SECRET_TEXT_RULES = Object.freeze([
  ["PASSWORD", /(?:^|[^a-z])(?:password|passwd|pwd)\s*[:=]\s*[^\s,;}{]{6,}/i],
  ["ONE_TIME_CODE", /(?:^|[^a-z])(?:otp|one[-_ ]?time[-_ ]?code|passcode)\s*[:=]\s*[^\s,;}{]{4,}/i],
  ["CREDENTIAL_LOGIN_URL", /https?:\/\/[^\s]+[?&](?:credential|code|otp|password|secret|token|key)=[^&#\s]{6,}/i],
  ["COOKIE", /(?:^|[^a-z])(?:cookie|set-cookie|cookievalue)\s*[:=]\s*[^\s,;}{]{6,}/i],
  ["COOKIE_HASH", /(?:cookie[-_ ]?hash|session[-_ ]?hash)\s*[:=]\s*[A-Za-z0-9._~+\/-]{8,}/i],
  ["SESSION_COOKIE", /session[-_ ]?cookie\s*[:=]\s*[^\s,;}{]{6,}/i],
  ["ACCESS_TOKEN", /(?:access[-_ ]?token|cf-access-token)\s*[:=]\s*[^\s,;}{]{8,}/i],
  ["TOKEN_HASH", /token[-_ ]?hash\s*[:=]\s*[A-Za-z0-9._~+\/-]{8,}/i],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ["AUTHORIZATION", /\bauthorization\s*[:=]\s*(?:basic|bearer|digest|token)?\s*[^\s,;}{]{8,}/i],
  ["RAW_NETWORK_CREDENTIAL", /(?:raw[-_ ]?har|har\s*=|headers?\s*[:=]).{0,160}(?:authorization|cookie|credential|token).{0,80}(?:value\s*[:=]|[:=])\s*[^\s,;}{]{6,}/i],
  ["TUNNEL_TOKEN", /(?:cloudflared|tunnel)[-_ ]?token\s*[:=]\s*[^\s,;}{]{8,}/i],
  ["API_SECRET", /api[-_ ]?(?:secret|key)\s*[:=]\s*[^\s,;}{]{8,}/i],
  ["BEARER_TOKEN", /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i]
]);

function normalizedSecretKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, "");
}

function secretCategoryForKey(key) {
  const normalized = normalizedSecretKey(key);
  return SECRET_KEY_RULES.find(([, pattern]) => pattern.test(normalized))?.[0] || null;
}

function secretCategoryForText(value) {
  const text = String(value);
  return SECRET_TEXT_RULES.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function safeJsonPointer(parts) {
  if (!parts.length) return "$";
  return `$${parts.map((part) => {
    if (typeof part === "number") return `[${part}]`;
    if (secretCategoryForKey(part)) return ".[REDACTED_FIELD]";
    const safe = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(part) ? part : "[REDACTED_FIELD]";
    return `.${safe}`;
  }).join("")}`;
}

function findSecret(value, parts = []) {
  if (typeof value === "string") {
    const category = secretCategoryForText(value);
    return category ? { category, location: safeJsonPointer(parts) } : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = findSecret(value[index], [...parts, index]);
      if (finding) return finding;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;

  const semanticNameEntry = Object.entries(value).find(([key, child]) =>
    /^(?:name|headername|parametername)$/i.test(normalizedSecretKey(key)) && typeof child === "string"
  );
  const semanticValueEntry = Object.entries(value).find(([key, child]) =>
    /^(?:value|headervalue|parametervalue)$/i.test(normalizedSecretKey(key)) && child != null && child !== ""
  );
  if (semanticNameEntry && semanticValueEntry) {
    const category = secretCategoryForKey(semanticNameEntry[1]);
    if (category) {
      return { category, location: safeJsonPointer([...parts, semanticValueEntry[0]]) };
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const category = secretCategoryForKey(key);
    if (category && child != null && child !== "") {
      return { category, location: safeJsonPointer([...parts, key]) };
    }
    const finding = findSecret(child, [...parts, key]);
    if (finding) return finding;
  }
  return null;
}

function secretError(label, finding) {
  return new EvidenceError(
    "MULTIUSER_SECRET_FOUND",
    `${label} inneholder forbudt hemmelighetskategori ${finding.category}; location=${finding.location}; value=[REDACTED].`,
    "RED"
  );
}

function assertSecretFree(parsed, label) {
  try {
    const finding = findSecret(parsed);
    if (finding) throw secretError(label, finding);
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError("MULTIUSER_SECRET_SCAN_FAILED", `${label} kunne ikke secret-skannes kontrollert.`, "BLOCKED");
  }
}

function readEvidenceFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new EvidenceError("MULTIUSER_EVIDENCE_MISSING", `${label} finnes ikke.`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new EvidenceError("MULTIUSER_EVIDENCE_UNSAFE_PATH", `${label} må være en vanlig fil, ikke symlink eller katalog.`);
  }
  if (stat.size > MAX_EVIDENCE_BYTES) {
    throw new EvidenceError("MULTIUSER_EVIDENCE_TOO_LARGE", `${label} overskrider maksimal evidensstørrelse.`);
  }
  const raw = fs.readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const finding = secretCategoryForText(raw);
    if (finding) throw secretError(label, { category: finding, location: "$" });
    throw new EvidenceError("MULTIUSER_EVIDENCE_MALFORMED", `${label} er ikke gyldig JSON.`);
  }
  assertSecretFree(parsed, label);
  return { raw, parsed, bytes: Buffer.byteLength(raw), sha256: sha256Bytes(raw) };
}

function validateManifestShape(manifest) {
  exactKeys(manifest, [
    "schemaId", "schemaVersion", "gateContractVersion", "evidencePackageId",
    "collectionRunId", "generatedAt", "observedAt", "timeZone", "freshnessClass",
    "producer", "codeIdentity", "artifacts", "manifest", "narrativeAssessment"
  ], "manifest");
  if (manifest.schemaId !== SCHEMA_ID || manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new EvidenceError("MULTIUSER_UNKNOWN_SCHEMA", "Evidenspakken har ukjent schema-id eller schema-versjon.");
  }
  if (manifest.gateContractVersion !== GATE_VERSION) {
    throw new EvidenceError("MULTIUSER_GATE_VERSION_MISMATCH", "Evidenspakken gjelder en annen gatekontraktversjon.");
  }
  for (const key of ["evidencePackageId", "collectionRunId", "generatedAt", "observedAt", "timeZone", "freshnessClass"]) {
    requireString(manifest[key], `manifest.${key}`);
  }
  if (manifest.timeZone !== "Europe/Oslo") {
    throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", "Evidensens tidssone må være Europe/Oslo.");
  }
  if (!["FRESH_OBSERVED", "REUSED_EXACT_SHA"].includes(manifest.freshnessClass)) {
    throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", "Ukjent freshnessClass.");
  }
  const producer = requireObject(manifest.producer, "manifest.producer");
  exactKeys(producer, [
    "id", "version", "codeSha256", "codeGitSha", "codeTree", "invocationId",
    "invocationCommand", "collectionMode", "trustLevel", "manualAttestations"
  ], "manifest.producer");
  for (const key of ["id", "version", "codeSha256", "codeGitSha", "codeTree", "invocationId", "collectionMode", "trustLevel"]) {
    requireString(producer[key], `manifest.producer.${key}`);
  }
  requireArray(producer.invocationCommand, "manifest.producer.invocationCommand", { min: 1 });
  if (producer.invocationCommand.some((part) => typeof part !== "string" || /https?:\/\//i.test(part))) {
    throw new EvidenceError("MULTIUSER_PRODUCER_INVOCATION_UNSAFE", "Produsentens invocation må være sanitert og uten nettverks-URL.");
  }
  requireArray(producer.manualAttestations, "manifest.producer.manualAttestations");
  const code = requireObject(manifest.codeIdentity, "manifest.codeIdentity");
  exactKeys(code, [
    "approvedSha", "approvedTree", "runtimeBranch", "runtimeHead", "runtimeTree",
    "ancestry", "codeAssetHashes"
  ], "manifest.codeIdentity");
  for (const key of ["approvedSha", "approvedTree", "runtimeBranch", "runtimeHead", "runtimeTree"]) {
    requireString(code[key], `manifest.codeIdentity.${key}`);
  }
  requireArray(code.ancestry, "manifest.codeIdentity.ancestry");
  for (const [index, entry] of code.ancestry.entries()) {
    exactKeys(entry, ["sha", "changedFiles"], `manifest.codeIdentity.ancestry[${index}]`);
    requireString(entry.sha, `manifest.codeIdentity.ancestry[${index}].sha`);
    requireArray(entry.changedFiles, `manifest.codeIdentity.ancestry[${index}].changedFiles`);
  }
  exactKeys(code.codeAssetHashes, ["approved", "runtime"], "manifest.codeIdentity.codeAssetHashes");
  requireString(code.codeAssetHashes.approved, "manifest.codeIdentity.codeAssetHashes.approved", /^[a-f0-9]{64}$/);
  requireString(code.codeAssetHashes.runtime, "manifest.codeIdentity.codeAssetHashes.runtime", /^[a-f0-9]{64}$/);
  requireArray(manifest.artifacts, "manifest.artifacts");
  for (const [index, artifact] of manifest.artifacts.entries()) {
    exactKeys(artifact, ["kind", "path", "sha256", "bytes"], `manifest.artifacts[${index}]`);
    requireString(artifact.kind, `manifest.artifacts[${index}].kind`);
    requireString(artifact.path, `manifest.artifacts[${index}].path`);
    requireString(artifact.sha256, `manifest.artifacts[${index}].sha256`, /^[a-f0-9]{64}$/);
    requireNumber(artifact.bytes, `manifest.artifacts[${index}].bytes`, { min: 1 });
  }
  exactKeys(manifest.manifest, ["algorithm", "payloadSha256", "sanitizationStatus", "piiStatus", "secretStatus"], "manifest.manifest");
  if (manifest.manifest.algorithm !== "sha256") throw new EvidenceError("MULTIUSER_SCHEMA_INVALID", "Kun sha256-manifest støttes.");
  requireString(manifest.manifest.payloadSha256, "manifest.manifest.payloadSha256", /^[a-f0-9]{64}$/);
  for (const key of ["sanitizationStatus", "piiStatus", "secretStatus"]) requireString(manifest.manifest[key], `manifest.manifest.${key}`);
  if (manifest.manifest.sanitizationStatus !== "SANITIZED" || manifest.manifest.piiStatus !== "MASKED_IDENTIFIERS_ONLY" || manifest.manifest.secretStatus !== "SECRET_FREE") {
    throw new EvidenceError("MULTIUSER_SANITIZATION_UNPROVEN", "Manifestet dokumenterer ikke sanitert, maskert og secret-free evidens.");
  }
}

function validateProducer(manifest) {
  const producer = manifest.producer;
  const evaluator = currentGitIdentity();
  if (producer.id !== PRODUCER_ID || producer.version !== PRODUCER_VERSION) {
    throw new EvidenceError("MULTIUSER_UNKNOWN_PRODUCER", "Evidenspakken kommer fra en ukjent eller ikke tillatt produsent.");
  }
  if (producer.codeSha256 !== producerSourceSha256()) {
    throw new EvidenceError("MULTIUSER_PRODUCER_CODE_MISMATCH", "Produsentens kildekodehash matcher ikke repositoryets versjon.");
  }
  if (producer.collectionMode !== "live-readonly+isolated-write" || producer.trustLevel !== "REPOSITORY_OWNED_LOCAL") {
    throw new EvidenceError("MULTIUSER_PRODUCER_UNTRUSTED", "Produsentens collection mode eller trust level er ikke tillatt.");
  }
  if (producer.codeGitSha !== evaluator.sha || producer.codeTree !== evaluator.tree) {
    throw new EvidenceError("MULTIUSER_PRODUCER_CODE_MISMATCH", "Produsentens Git-identitet matcher ikke evaluatorrepositoryets faktiske commit/tree.");
  }
  return {
    id: producer.id,
    version: producer.version,
    codeSha256: producer.codeSha256,
    codeGitSha: producer.codeGitSha,
    codeTree: producer.codeTree
  };
}

function validateFreshness(manifest, now = new Date()) {
  const generated = new Date(manifest.generatedAt);
  const observed = new Date(manifest.observedAt);
  if (!Number.isFinite(generated.getTime()) || !Number.isFinite(observed.getTime()) || observed > generated) {
    throw new EvidenceError("MULTIUSER_TIME_INVALID", "Evidensens tidsfelter er ugyldige eller motsigende.");
  }
  if (now.getTime() - observed.getTime() > 72 * 60 * 60 * 1000 || observed.getTime() - now.getTime() > 5 * 60 * 1000) {
    throw new EvidenceError("MULTIUSER_EVIDENCE_STALE", "Kritisk flerbrukerevidens er eldre enn tillatt ferskhetsvindu.");
  }
}

function gitRead(repository, args, options = {}) {
  const allowedExitCodes = options.allowedExitCodes || [0];
  const child = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      LC_ALL: "C"
    }
  });
  if (child.error || !allowedExitCodes.includes(child.status)) {
    throw new EvidenceError("MULTIUSER_GIT_AUTHORITY_UNAVAILABLE", "Trusted Git repository kunne ikke leses kontrollert.");
  }
  return { status: child.status, stdout: child.stdout.trim() };
}

function trustedRepository(input) {
  if (!input) {
    throw new EvidenceError("MULTIUSER_SUBJECT_REPOSITORY_MISSING", "Eksplisitt trusted subject repository må oppgis.");
  }
  const repository = path.resolve(input);
  let stat;
  try {
    stat = fs.lstatSync(repository);
  } catch (error) {
    throw new EvidenceError("MULTIUSER_SUBJECT_REPOSITORY_MISSING", "Trusted subject repository finnes ikke lokalt.");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new EvidenceError("MULTIUSER_SUBJECT_REPOSITORY_UNSAFE", "Trusted subject repository må være en lokal, ordinær katalog.");
  }
  if (gitRead(repository, ["rev-parse", "--is-inside-work-tree"]).stdout !== "true") {
    throw new EvidenceError("MULTIUSER_SUBJECT_REPOSITORY_INVALID", "Trusted subject repository er ikke et Git worktree.");
  }
  if (gitRead(repository, ["rev-parse", "--is-shallow-repository"]).stdout !== "false") {
    throw new EvidenceError("MULTIUSER_GIT_HISTORY_INCOMPLETE", "Trusted subject repository har shallow eller ufullstendig historikk.");
  }
  return repository;
}

function fullGitObject(value, label) {
  if (!/^[a-f0-9]{40}$/.test(value || "")) {
    throw new EvidenceError("MULTIUSER_GIT_OBJECT_INVALID", `${label} må være en full, entydig 40-tegns Git-SHA.`);
  }
  return value;
}

function commitTree(repository, sha, label) {
  fullGitObject(sha, label);
  const exists = gitRead(repository, ["cat-file", "-e", `${sha}^{commit}`], { allowedExitCodes: [0, 1, 128] });
  if (exists.status !== 0) {
    throw new EvidenceError("MULTIUSER_GIT_OBJECT_MISSING", `${label} finnes ikke som lokalt commitobjekt.`);
  }
  return gitRead(repository, ["rev-parse", `${sha}^{tree}`]).stdout;
}

function codeAssetHash(repository, sha) {
  const output = gitRead(repository, ["ls-tree", "-r", "-z", sha]).stdout;
  const entries = output.split("\0").filter(Boolean).filter((entry) => {
    const tab = entry.indexOf("\t");
    const file = tab >= 0 ? entry.slice(tab + 1) : "";
    return !DATA_ONLY_PATHS.includes(file);
  });
  return sha256Bytes(entries.join("\0"));
}

function actualAncestry(repository, approvedSha, runtimeSha) {
  const ancestor = gitRead(repository, ["merge-base", "--is-ancestor", approvedSha, runtimeSha], { allowedExitCodes: [0, 1] });
  if (ancestor.status !== 0) {
    throw new EvidenceError("MULTIUSER_ANCESTRY_UNPROVEN", "Runtime commit er ikke en faktisk descendant av approved commit.");
  }
  const parentLines = gitRead(repository, ["rev-list", "--reverse", "--topo-order", "--parents", `${approvedSha}..${runtimeSha}`]).stdout
    .split("\n").filter(Boolean);
  if (parentLines.some((line) => line.trim().split(/\s+/).length !== 2)) {
    throw new EvidenceError("MULTIUSER_GIT_HISTORY_AMBIGUOUS", "Descendantintervallet inneholder merge- eller tvetydig historikk.");
  }
  return parentLines.map((line) => {
    const sha = line.split(/\s+/)[0];
    const changedFiles = gitRead(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", `${sha}^`, sha]).stdout
      .split("\n").filter(Boolean).sort();
    return { sha, changedFiles };
  });
}

function inspectSubjectIdentity({ subjectRepository, approvedSha, approvedTree, runtimeSha = approvedSha }) {
  const repository = trustedRepository(subjectRepository);
  fullGitObject(approvedSha, "approved SHA");
  fullGitObject(approvedTree, "approved tree");
  fullGitObject(runtimeSha, "runtime SHA");
  const actualApprovedTree = commitTree(repository, approvedSha, "Approved commit");
  const actualRuntimeTree = commitTree(repository, runtimeSha, "Runtime commit");
  if (actualApprovedTree !== approvedTree) {
    throw new EvidenceError("MULTIUSER_CODE_TREE_MISMATCH", "Rapportert approved tree matcher ikke commitens faktiske tree.");
  }
  const ancestry = runtimeSha === approvedSha ? [] : actualAncestry(repository, approvedSha, runtimeSha);
  const changedFiles = [...new Set(ancestry.flatMap((entry) => entry.changedFiles))].sort();
  const unauthorized = changedFiles.filter((file) => !DATA_ONLY_PATHS.includes(file));
  const approvedCodeAssetHash = codeAssetHash(repository, approvedSha);
  const runtimeCodeAssetHash = codeAssetHash(repository, runtimeSha);
  if (unauthorized.length || approvedCodeAssetHash !== runtimeCodeAssetHash) {
    throw new EvidenceError("MULTIUSER_DESCENDANT_NOT_DATA_ONLY", "Runtime descendant inneholder faktisk kode-, test-, config-, modell- eller assetendring.");
  }
  return {
    repository,
    approvedSha,
    approvedTree: actualApprovedTree,
    runtimeSha,
    runtimeTree: actualRuntimeTree,
    ancestry,
    changedFiles,
    approvedCodeAssetHash,
    runtimeCodeAssetHash,
    dataOnlyDescendant: runtimeSha !== approvedSha
  };
}

function validateCodeIdentity(code, expected = {}) {
  const approvedSha = expected.approvedSha;
  const approvedTree = expected.approvedTree;
  if (!approvedSha || !approvedTree) {
    throw new EvidenceError("MULTIUSER_APPROVED_CODE_NOT_SPECIFIED", "Godkjent code SHA/tree må oppgis eksplisitt sammen med evidensen.");
  }
  if (code.approvedSha !== approvedSha || code.approvedTree !== approvedTree) {
    throw new EvidenceError("MULTIUSER_WRONG_CODE_IDENTITY", "Evidensens approved SHA/tree matcher ikke eksplisitt godkjent kode.");
  }
  const actual = inspectSubjectIdentity({
    subjectRepository: expected.subjectRepository,
    approvedSha,
    approvedTree,
    runtimeSha: code.runtimeHead
  });
  if (code.runtimeTree !== actual.runtimeTree) {
    throw new EvidenceError("MULTIUSER_CODE_TREE_MISMATCH", "Rapportert runtime tree matcher ikke commitens faktiske tree.");
  }
  if (stableStringify(code.ancestry) !== stableStringify(actual.ancestry)) {
    throw new EvidenceError("MULTIUSER_ANCESTRY_MISMATCH", "Rapportert ancestry eller changedFiles matcher ikke den faktiske Git-grafen.");
  }
  if (
    code.codeAssetHashes.approved !== actual.approvedCodeAssetHash ||
    code.codeAssetHashes.runtime !== actual.runtimeCodeAssetHash
  ) {
    throw new EvidenceError("MULTIUSER_CODE_ASSET_HASH_MISMATCH", "Rapporterte kode-/assethasher matcher ikke faktiske Git-objekter.");
  }
  return {
    mode: actual.dataOnlyDescendant ? "DATA_ONLY_DESCENDANT" : "EXACT_APPROVED_SHA",
    dataOnlyDescendant: actual.dataOnlyDescendant,
    changedFiles: actual.changedFiles,
    subjectRepository: actual.repository,
    approvedSha: actual.approvedSha,
    approvedTree: actual.approvedTree,
    runtimeSha: actual.runtimeSha,
    runtimeTree: actual.runtimeTree,
    ancestryVerified: true,
    dataOnlyScopeVerified: true,
    codeAssetHashesVerified: true
  };
}

function resolveArtifact(baseDirectory, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new EvidenceError("MULTIUSER_EVIDENCE_UNSAFE_PATH", "Kildeartefakt må være en relativ sti uten parent traversal.");
  }
  const resolved = path.resolve(baseDirectory, relativePath);
  if (path.dirname(resolved) !== baseDirectory) {
    throw new EvidenceError("MULTIUSER_EVIDENCE_UNSAFE_PATH", "Kildeartefakt må ligge direkte i evidensmappen.");
  }
  return resolved;
}

function readArtifacts(manifest, baseDirectory) {
  if (!manifest.artifacts.length) {
    throw new EvidenceError("MULTIUSER_SOURCE_CHAIN_MISSING", "Produsentmetadata finnes, men source artifact chain mangler.");
  }
  const byKind = new Map();
  for (const reference of manifest.artifacts) {
    if (byKind.has(reference.kind)) throw new EvidenceError("MULTIUSER_CONFLICTING_EVIDENCE", `Flere motstridende ${reference.kind}-artefakter er oppgitt.`);
    const artifact = readEvidenceFile(resolveArtifact(baseDirectory, reference.path), `kildeartefakt ${reference.kind}`);
    if (artifact.sha256 !== reference.sha256 || artifact.bytes !== reference.bytes) {
      throw new EvidenceError("MULTIUSER_SOURCE_ARTIFACT_HASH_MISMATCH", `Kildeartefakt ${reference.kind} matcher ikke manifestets hash/byte count.`);
    }
    byKind.set(reference.kind, { ...artifact, reference });
  }
  return byKind;
}

function validateLiveShape(live) {
  exactKeys(live, [
    "schemaId", "schemaVersion", "collectionRunId", "observedAt", "identities",
    "stateReadbacks", "viewportObservations", "polling", "writeGuard",
    "networkSummaryRef", "consoleErrors", "requestErrors", "pageErrors", "businessState"
  ], "live");
  if (live.schemaId !== "sde-multiuser-live-observations" || live.schemaVersion !== "1") {
    throw new EvidenceError("MULTIUSER_LIVE_SCHEMA_INVALID", "Live-artefakten har ukjent schema.");
  }
  requireString(live.collectionRunId, "live.collectionRunId");
  requireString(live.observedAt, "live.observedAt");
  requireArray(live.identities, "live.identities", { min: 1 });
  requireArray(live.stateReadbacks, "live.stateReadbacks");
  requireArray(live.viewportObservations, "live.viewportObservations");
  requireObject(live.polling, "live.polling");
  requireObject(live.writeGuard, "live.writeGuard");
  requireString(live.networkSummaryRef, "live.networkSummaryRef");
  requireNumber(live.consoleErrors, "live.consoleErrors", { min: 0 });
  requireNumber(live.requestErrors, "live.requestErrors", { min: 0 });
  requireNumber(live.pageErrors, "live.pageErrors", { min: 0 });
  requireObject(live.businessState, "live.businessState");
}

function child(id, status, reasonCode, summary, evidence = []) {
  return { id, gateVersion: GATE_VERSION, status, reasonCode, severity: "CRITICAL", critical: true, parentGate: "MULTIUSER-LIVE-001", childGates: [], aggregate: false, counted: false, summary, evidence };
}

function blockedChild(id, reasonCode, summary, evidence = []) {
  return child(id, "BLOCKED", reasonCode, summary, evidence);
}

function evaluateLive(artifact, manifest) {
  if (!artifact) return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_LIVE_EVIDENCE_MISSING", "Live-readonly-evidens mangler.");
  const live = artifact.parsed;
  try {
    validateLiveShape(live);
    if (live.collectionRunId !== manifest.collectionRunId || live.observedAt !== manifest.observedAt) {
      return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_LIVE_PROVENANCE_MISMATCH", "Live-observasjonen er ikke bundet til collection run og observedAt.");
    }
    if (live.identities.length !== 2) {
      return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_SECOND_IDENTITY_NOT_ESTABLISHED", "To upstream Access-identiteter ble ikke etablert.");
    }
    const normalized = live.identities.map((identity, index) => {
      exactKeys(identity, [
        "maskedIdentity", "upstreamIssuer", "upstreamPrincipalId", "serverSubject",
        "identitySource", "role", "capabilities", "accessResult", "authContainerId",
        "sessionContainerId", "cookieStoreId", "localStorageContainerId", "sessionStorageContainerId"
      ], `live.identities[${index}]`);
      for (const key of [
        "maskedIdentity", "upstreamIssuer", "upstreamPrincipalId", "serverSubject", "identitySource",
        "role", "accessResult", "authContainerId", "sessionContainerId", "cookieStoreId",
        "localStorageContainerId", "sessionStorageContainerId"
      ]) requireString(identity[key], `live.identities[${index}].${key}`);
      requireArray(identity.capabilities, `live.identities[${index}].capabilities`, { min: 1 });
      return identity;
    });
    const upstreamKeys = normalized.map((identity) => `${identity.upstreamIssuer}\u0000${identity.upstreamPrincipalId}`);
    if (new Set(upstreamKeys).size !== 2) {
      return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_SECOND_IDENTITY_NOT_ESTABLISHED", "Samme upstream identity er observert i begge sessions; dette er en testoppsettblokkering, ikke en produktfeil.");
    }
    const subjectMismatch = normalized.some((identity) => identity.serverSubject !== identity.upstreamPrincipalId);
    const subjectCollision = new Set(normalized.map((identity) => identity.serverSubject)).size !== 2;
    if (subjectMismatch || subjectCollision) {
      return child("MULTIUSER-LIVE-READONLY", "RED", "MULTIUSER_IDENTITY_COLLISION_OR_LEAKAGE", "To ulike upstream-identiteter er bevist, men serverreadback kolliderer eller krysses.", [artifact.reference.path]);
    }
    const containerFields = ["authContainerId", "sessionContainerId", "cookieStoreId", "localStorageContainerId", "sessionStorageContainerId"];
    for (const field of containerFields) {
      if (new Set(normalized.map((identity) => identity[field])).size !== 2) {
        return child("MULTIUSER-LIVE-READONLY", "RED", "MULTIUSER_SESSION_OR_CACHE_LEAKAGE", `${field} er delt mellom beviste ulike identiteter.`, [artifact.reference.path]);
      }
    }
    if (normalized.some((identity) => identity.identitySource !== "cloudflare-access" || identity.accessResult !== "ALLOWED")) {
      return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_AUTHORITY_READBACK_UNPROVEN", "Identity source eller Access-resultat er ikke maskinverifisert.");
    }
    if (live.stateReadbacks.length < 2) return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_SESSION_SEPARATION_UNPROVEN", "Session-/cacheisolasjon mangler maskinreadback.");
    for (const [index, readback] of live.stateReadbacks.entries()) {
      exactKeys(readback, ["containerId", "subject", "capabilities"], `live.stateReadbacks[${index}]`);
      requireString(readback.containerId, `live.stateReadbacks[${index}].containerId`);
      requireString(readback.subject, `live.stateReadbacks[${index}].subject`);
      requireArray(readback.capabilities, `live.stateReadbacks[${index}].capabilities`);
    }
    for (const identity of normalized) {
      const readback = live.stateReadbacks.find((item) => item.containerId === identity.sessionContainerId);
      if (!readback || readback.subject !== identity.serverSubject || stableStringify(readback.capabilities) !== stableStringify(identity.capabilities)) {
        return child("MULTIUSER-LIVE-READONLY", "RED", "MULTIUSER_IDENTITY_COLLISION_OR_LEAKAGE", "Session-state eller capabilities tilhører feil identity.", [artifact.reference.path]);
      }
    }
    for (const [index, observation] of live.viewportObservations.entries()) {
      exactKeys(observation, ["containerId", "viewport", "result"], `live.viewportObservations[${index}]`);
    }
    const viewports = new Set(live.viewportObservations.filter((item) => item.result === "PASS").map((item) => `${item.containerId}:${item.viewport}`));
    const requiredViewportKeys = normalized.flatMap((identity) => ["desktop", "mobile"].map((viewport) => `${identity.sessionContainerId}:${viewport}`));
    if (requiredViewportKeys.some((key) => !viewports.has(key))) {
      return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_VIEWPORT_MATRIX_INCOMPLETE", "Desktop-/mobilmatrisen er ikke komplett.");
    }
    exactKeys(live.polling, ["ticks", "durationSeconds"], "live.polling");
    exactKeys(live.writeGuard, ["result", "allowedMethods", "protectedMethods"], "live.writeGuard");
    requireNumber(live.polling.ticks, "live.polling.ticks", { min: 0 });
    requireNumber(live.polling.durationSeconds, "live.polling.durationSeconds", { min: 0 });
    requireString(live.writeGuard.result, "live.writeGuard.result");
    requireArray(live.writeGuard.allowedMethods, "live.writeGuard.allowedMethods");
    requireArray(live.writeGuard.protectedMethods, "live.writeGuard.protectedMethods");
    if (live.polling.ticks < 2 || live.polling.durationSeconds <= 0) {
      return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_POLLING_UNPROVEN", "Pollingobservasjonen er ikke tilstrekkelig.");
    }
    const protectedMethods = new Set(live.writeGuard.protectedMethods || []);
    if (live.writeGuard.result !== "PASS" || ["POST", "PUT", "PATCH", "DELETE"].some((method) => !protectedMethods.has(method))) {
      return child("MULTIUSER-LIVE-READONLY", "RED", "MULTIUSER_LIVE_WRITE_GUARD_FAILED", "Live write-guard er ikke bevist aktiv.", [artifact.reference.path]);
    }
    if (live.consoleErrors || live.requestErrors || live.pageErrors) {
      return child("MULTIUSER-LIVE-READONLY", "RED", "MULTIUSER_LIVE_RUNTIME_ERRORS", "Liveobservasjonen inneholder console-, request- eller page-errors.", [artifact.reference.path]);
    }
    const business = live.businessState;
    exactKeys(business, ["snapshots", "technicalAppendOnlyEvents", "productionWriteLedger"], "live.businessState");
    if (!Array.isArray(business.productionWriteLedger)) return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_WRITE_LEDGER_UNPROVEN", "Production write ledger mangler.");
    if (business.productionWriteLedger.length) {
      return child("MULTIUSER-LIVE-READONLY", "RED", "MULTIUSER_LIVE_BUSINESS_WRITE", "Produksjons-business-write er observert i live-evidensen.", [artifact.reference.path]);
    }
    if (!Array.isArray(business.snapshots) || business.snapshots.length !== 3) {
      return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_BUSINESS_STATE_UNPROVEN", "Business-state før, mellom og etter er ikke komplett.");
    }
    for (const [index, snapshot] of business.snapshots.entries()) {
      exactKeys(snapshot, ["reference", "businessLogicalHash", "fullDatabaseLogicalHash", "auditCursor"], `live.businessState.snapshots[${index}]`);
      requireString(snapshot.reference, `live.businessState.snapshots[${index}].reference`);
      requireString(snapshot.businessLogicalHash, `live.businessState.snapshots[${index}].businessLogicalHash`, /^[a-f0-9]{64}$/);
      requireString(snapshot.fullDatabaseLogicalHash, `live.businessState.snapshots[${index}].fullDatabaseLogicalHash`, /^[a-f0-9]{64}$/);
    }
    const logicalHashes = new Set(business.snapshots.map((snapshot) => snapshot.businessLogicalHash));
    if (logicalHashes.size !== 1) {
      return child("MULTIUSER-LIVE-READONLY", "RED", "MULTIUSER_LIVE_BUSINESS_STATE_CHANGED", "Business-state endret seg under read-only-observasjonen.", [artifact.reference.path]);
    }
    const databaseHashes = new Set(business.snapshots.map((snapshot) => snapshot.fullDatabaseLogicalHash));
    if (databaseHashes.size > 1) {
      const events = Array.isArray(business.technicalAppendOnlyEvents) ? business.technicalAppendOnlyEvents : [];
      for (const [index, event] of events.entries()) exactKeys(event, ["kind", "attributed", "actor"], `live.businessState.technicalAppendOnlyEvents[${index}]`);
      if (!events.length || events.some((event) => !event.attributed || event.kind !== "ACCESS_AUDIT")) {
        return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_DATABASE_CHANGE_UNATTRIBUTED", "Full databasehash endret seg uten komplett attribusjon.");
      }
    }
    return child("MULTIUSER-LIVE-READONLY", "GREEN", "MULTIUSER_LIVE_READONLY_VALID", "To identiteter og live-isolasjon er maskinverifisert uten produksjons-business-write.", [artifact.reference.path]);
  } catch (error) {
    if (error instanceof EvidenceError) return child("MULTIUSER-LIVE-READONLY", error.status, error.reasonCode, error.message);
    return blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_LIVE_EVALUATION_ERROR", "Live-evidensen kunne ikke evalueres kontrollert.");
  }
}

function evaluateIsolated(artifact, manifest) {
  if (!artifact) return blockedChild("MULTIUSER-ISOLATED-WRITE", "MULTIUSER_ISOLATED_WRITE_EVIDENCE_MISSING", "Isolated-write-evidens mangler.");
  try {
    const isolated = artifact.parsed;
    exactKeys(isolated, ["schemaId", "schemaVersion", "collectionRunId", "environment", "commands", "totals", "assertions"], "isolated");
    if (isolated.schemaId !== "sde-multiuser-isolated-write-results" || isolated.schemaVersion !== "1") throw new EvidenceError("MULTIUSER_ISOLATED_SCHEMA_INVALID", "Isolated-write-artefakten har ukjent schema.");
    if (isolated.collectionRunId !== manifest.collectionRunId) throw new EvidenceError("MULTIUSER_ISOLATED_PROVENANCE_MISMATCH", "Isolated-write-resultatet er ikke bundet til collection run.");
    const environment = requireObject(isolated.environment, "isolated.environment");
    exactKeys(environment, ["kind", "databasePath", "productionNetworkCalls", "productionSecretsPresent", "codeSha", "codeTree"], "isolated.environment");
    requireString(environment.kind, "isolated.environment.kind");
    requireString(environment.databasePath, "isolated.environment.databasePath");
    requireNumber(environment.productionNetworkCalls, "isolated.environment.productionNetworkCalls", { min: 0 });
    requireBoolean(environment.productionSecretsPresent, "isolated.environment.productionSecretsPresent");
    requireString(environment.codeSha, "isolated.environment.codeSha");
    requireString(environment.codeTree, "isolated.environment.codeTree");
    if (environment.kind !== "isolated-test-server" || !/isolated|tmp|synthetic/i.test(environment.databasePath || "")) throw new EvidenceError("MULTIUSER_ISOLATED_ENVIRONMENT_UNPROVEN", "Isolated-write kjørte ikke i dokumentert isolert testmiljø.");
    if (environment.productionNetworkCalls !== 0 || environment.productionSecretsPresent !== false) {
      return child("MULTIUSER-ISOLATED-WRITE", "RED", "MULTIUSER_ISOLATED_PRODUCTION_LEAKAGE", "Isolated-write brukte produksjonsnettverk eller produksjonshemmeligheter.", [artifact.reference.path]);
    }
    if (environment.codeSha !== manifest.codeIdentity.approvedSha || environment.codeTree !== manifest.codeIdentity.approvedTree) throw new EvidenceError("MULTIUSER_ISOLATED_CODE_MISMATCH", "Isolated-write gjelder ikke godkjent kode SHA/tree.");
    requireArray(isolated.commands, "isolated.commands", { min: 1 });
    for (const [index, command] of isolated.commands.entries()) {
      exactKeys(command, ["command", "exitCode"], `isolated.commands[${index}]`);
      requireString(command.command, `isolated.commands[${index}].command`);
      requireNumber(command.exitCode, `isolated.commands[${index}].exitCode`);
    }
    if (isolated.commands.some((command) => command.exitCode !== 0)) return child("MULTIUSER-ISOLATED-WRITE", "RED", "MULTIUSER_ISOLATED_COMMAND_FAILED", "En isolated-write-kommando feilet.", [artifact.reference.path]);
    const totals = requireObject(isolated.totals, "isolated.totals");
    exactKeys(totals, ["passed", "failed", "skipped"], "isolated.totals");
    for (const key of ["passed", "failed", "skipped"]) requireNumber(totals[key], `isolated.totals.${key}`, { min: 0 });
    if (!Number.isInteger(totals.passed) || totals.passed < REQUIRED_ISOLATED_ASSERTIONS.length || totals.failed !== 0 || totals.skipped !== 0) {
      return child("MULTIUSER-ISOLATED-WRITE", "RED", "MULTIUSER_ISOLATED_SEMANTIC_FAILURE", "Isolated-write har failure, skip eller ufullstendig assertiondekning.", [artifact.reference.path]);
    }
    const assertions = requireObject(isolated.assertions, "isolated.assertions");
    exactKeys(assertions, [...REQUIRED_ISOLATED_ASSERTIONS], "isolated.assertions");
    for (const key of REQUIRED_ISOLATED_ASSERTIONS) requireString(assertions[key], `isolated.assertions.${key}`);
    const missing = REQUIRED_ISOLATED_ASSERTIONS.filter((key) => assertions[key] !== "PASS");
    if (missing.length) return child("MULTIUSER-ISOLATED-WRITE", "RED", "MULTIUSER_ISOLATED_SEMANTIC_FAILURE", `Isolated-write feilet krav: ${missing.join(", ")}.`, [artifact.reference.path]);
    return child("MULTIUSER-ISOLATED-WRITE", "GREEN", "MULTIUSER_ISOLATED_WRITE_VALID", "Isolert testserver/database validerer write-semantikk uten produksjonsnettverk eller secrets.", [artifact.reference.path]);
  } catch (error) {
    if (error instanceof EvidenceError) return child("MULTIUSER-ISOLATED-WRITE", error.status, error.reasonCode, error.message);
    return blockedChild("MULTIUSER-ISOLATED-WRITE", "MULTIUSER_ISOLATED_EVALUATION_ERROR", "Isolated-write-evidensen kunne ikke evalueres kontrollert.");
  }
}

function aggregateResult(children, evidencePath, packageId = null, identities = {}) {
  const red = children.find((item) => item.status === "RED");
  const blocked = children.find((item) => ["BLOCKED", "UNKNOWN"].includes(item.status));
  const status = red ? "RED" : blocked ? "BLOCKED" : "GREEN";
  const reasonCode = red?.reasonCode || blocked?.reasonCode || "MULTIUSER_ALL_CRITICAL_REQUIREMENTS_VALID";
  const summary = status === "GREEN"
    ? "Live-readonly, isolated-write, integritet, proveniens, hemmelighetskontroll og kodebinding er GREEN."
    : `${red || blocked ? (red || blocked).summary : "Flerbrukerevidensen er ufullstendig."}`;
  return result({
    id: "MULTIUSER-LIVE-001",
    contractId: "CONCURRENCY-001",
    area: "multiuser",
    name: "Autentisert fleridentitetskontrakt",
    status,
    critical: true,
    gateVersion: GATE_VERSION,
    reasonCode,
    severity: "CRITICAL",
    parentGate: null,
    childGates: children.map((item) => item.id),
    aggregate: true,
    counted: true,
    summary,
    evidence: [evidencePath || "explicit --multiuser-evidence input: missing", ...children.flatMap((item) => item.evidence || [])],
    details: {
      evidencePackageId: packageId,
      assuranceLevel: "REPOSITORY_OWNED_HASH_CHAIN_NO_CRYPTOGRAPHIC_NON_REPUDIATION",
      canonicalMachineStatus: status,
      narrativeAssessment: "NON_AUTHORITATIVE",
      producerIdentity: identities.producerIdentity || null,
      subjectIdentity: identities.subjectIdentity || null,
      subgates: children
    },
    recommendation: status === "GREEN" ? null : "Lever en fersk, secret-free evidenspakke fra repositoryets tillatte produsent via eksplisitt CLI-input."
  });
}

function errorAggregate(error, evidencePath) {
  const status = error instanceof EvidenceError ? error.status : "BLOCKED";
  const reasonCode = error instanceof EvidenceError ? error.reasonCode : "MULTIUSER_EVIDENCE_EVALUATION_ERROR";
  const safeMessage = error instanceof EvidenceError ? error.message : "Evidensen kunne ikke evalueres kontrollert.";
  const children = [
    child("MULTIUSER-EVIDENCE-INTEGRITY", status, reasonCode, safeMessage),
    blockedChild("MULTIUSER-EVIDENCE-PROVENANCE", "MULTIUSER_PROVENANCE_NOT_EVALUATED", "Proveniens ble ikke evaluert etter fail-closed avvisning."),
    reasonCode === "MULTIUSER_SECRET_FOUND"
      ? child("MULTIUSER-SECRET-FREE", "RED", reasonCode, safeMessage)
      : blockedChild("MULTIUSER-SECRET-FREE", "MULTIUSER_SECRET_SCAN_NOT_EVALUATED", "Secret-free-kontroll ble ikke fullført etter fail-closed avvisning."),
    blockedChild("MULTIUSER-CODE-BINDING", "MULTIUSER_CODE_BINDING_NOT_EVALUATED", "Kodebinding ble ikke evaluert etter fail-closed avvisning."),
    blockedChild("MULTIUSER-LIVE-READONLY", "MULTIUSER_LIVE_NOT_EVALUATED", "Live-readonly ble ikke evaluert."),
    blockedChild("MULTIUSER-ISOLATED-WRITE", "MULTIUSER_ISOLATED_NOT_EVALUATED", "Isolated-write ble ikke evaluert.")
  ];
  return aggregateResult(children, evidencePath);
}

function evaluateMultiuserEvidence(options = {}) {
  const inputs = options.inputPaths || (options.inputPath ? [options.inputPath] : []);
  if (!inputs.length) return errorAggregate(new EvidenceError("MULTIUSER_EVIDENCE_MISSING", "Eksplisitt flerbrukerevidens er ikke oppgitt."), null);
  if (inputs.length !== 1) return errorAggregate(new EvidenceError("MULTIUSER_CONFLICTING_EVIDENCE", "Nøyaktig én eksplisitt evidenspakke må oppgis."), inputs.join(","));
  const evidencePath = path.resolve(inputs[0]);
  try {
    const packageFile = readEvidenceFile(evidencePath, "flerbruker-evidensmanifest");
    const manifest = packageFile.parsed;
    validateManifestShape(manifest);
    if (manifestHash(manifest) !== manifest.manifest.payloadSha256) throw new EvidenceError("MULTIUSER_MANIFEST_HASH_MISMATCH", "Evidensmanifestets payloadhash matcher ikke innholdet.");
    const producerIdentity = validateProducer(manifest);
    validateFreshness(manifest, options.now || new Date());
    const binding = validateCodeIdentity(manifest.codeIdentity, options);
    const artifacts = readArtifacts(manifest, path.dirname(evidencePath));
    const children = [
      child("MULTIUSER-EVIDENCE-INTEGRITY", "GREEN", "MULTIUSER_EVIDENCE_INTEGRITY_VALID", "Manifest og source artifact hash chain er gyldig.", manifest.artifacts.map((item) => item.path)),
      child("MULTIUSER-EVIDENCE-PROVENANCE", "GREEN", "MULTIUSER_EVIDENCE_PROVENANCE_VALID", "Repository-eid produsent, collection run og kildeartefakter er validert."),
      child("MULTIUSER-SECRET-FREE", "GREEN", "MULTIUSER_EVIDENCE_SECRET_FREE", "Manifest og kildeartefakter er kontrollert uten hemmelighetsfunn."),
      child("MULTIUSER-CODE-BINDING", "GREEN", binding.dataOnlyDescendant ? "MULTIUSER_DATA_ONLY_DESCENDANT_VALID" : "MULTIUSER_EXACT_CODE_IDENTITY_VALID", binding.dataOnlyDescendant ? "Runtime er en validert data-only descendant med byteidentiske kode/assets." : "Runtime SHA/tree er eksakt godkjent kodeidentitet."),
      evaluateLive(artifacts.get("live-observations"), manifest),
      evaluateIsolated(artifacts.get("isolated-write-results"), manifest)
    ];
    return aggregateResult(children, evidencePath, manifest.evidencePackageId, {
      producerIdentity,
      subjectIdentity: binding
    });
  } catch (error) {
    return errorAggregate(error, evidencePath);
  }
}

function currentGitIdentity() {
  return {
    sha: gitValue(["rev-parse", "HEAD"]),
    tree: gitValue(["rev-parse", "HEAD^{tree}"]),
    branch: gitValue(["branch", "--show-current"]) || "detached"
  };
}

function buildEvidenceManifest({ livePath, isolatedPath, outputPath, approvedSha, approvedTree, subjectRepository, runtimeSha = approvedSha, now = new Date(), collectionRunId = null, manualAttestations = [] }) {
  if (!outputPath) throw new Error("outputPath er påkrevd");
  const evaluator = currentGitIdentity();
  const subject = inspectSubjectIdentity({ subjectRepository, approvedSha, approvedTree, runtimeSha });
  const artifactInputs = [
    ["live-observations", livePath],
    ["isolated-write-results", isolatedPath]
  ].filter(([, file]) => file);
  const sourceArtifacts = artifactInputs.map(([kind, file]) => {
    const source = readEvidenceFile(path.resolve(file), kind);
    requireString(source.parsed.collectionRunId, `${kind}.collectionRunId`);
    const targetName = path.basename(file);
    return { kind, source, reference: { kind, path: targetName, sha256: source.sha256, bytes: source.bytes } };
  });
  const sourceRunIds = [...new Set(sourceArtifacts.map((item) => item.source.parsed.collectionRunId))];
  if (sourceRunIds.length > 1 || (collectionRunId && sourceRunIds.some((id) => id !== collectionRunId))) {
    throw new EvidenceError("MULTIUSER_SOURCE_RUN_CONFLICT", "Kildeartefaktene har motstridende collection run-ID-er.");
  }
  const runId = collectionRunId || sourceRunIds[0] || `multiuser-${now.toISOString().replace(/[:.]/g, "-")}`;
  const artifacts = sourceArtifacts.map((item) => item.reference);
  const liveArtifact = sourceArtifacts.find((item) => item.kind === "live-observations");
  const observedAt = liveArtifact ? liveArtifact.source.parsed.observedAt : now.toISOString();
  const manifest = {
    schemaId: SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    gateContractVersion: GATE_VERSION,
    evidencePackageId: `pkg-${runId}`,
    collectionRunId: runId,
    generatedAt: now.toISOString(),
    observedAt,
    timeZone: "Europe/Oslo",
    freshnessClass: "FRESH_OBSERVED",
    producer: {
      id: PRODUCER_ID,
      version: PRODUCER_VERSION,
      codeSha256: producerSourceSha256(),
      codeGitSha: evaluator.sha,
      codeTree: evaluator.tree,
      invocationId: `invoke-${runId}`,
      invocationCommand: ["node", "tests/sde-quality-engine/tools/build-multiuser-evidence.cjs", "--live", "[PATH]", "--isolated", "[PATH]", "--output", "[PATH]", "--subject-repository", "[TRUSTED_LOCAL_REPOSITORY]", "--runtime-sha", "[GIT_SHA]"],
      collectionMode: "live-readonly+isolated-write",
      trustLevel: "REPOSITORY_OWNED_LOCAL",
      manualAttestations
    },
    codeIdentity: {
      approvedSha,
      approvedTree: subject.approvedTree,
      runtimeBranch: "trusted-local-git-subject",
      runtimeHead: subject.runtimeSha,
      runtimeTree: subject.runtimeTree,
      ancestry: subject.ancestry,
      codeAssetHashes: { approved: subject.approvedCodeAssetHash, runtime: subject.runtimeCodeAssetHash }
    },
    artifacts,
    manifest: {
      algorithm: "sha256",
      payloadSha256: "",
      sanitizationStatus: "SANITIZED",
      piiStatus: "MASKED_IDENTIFIERS_ONLY",
      secretStatus: "SECRET_FREE"
    },
    narrativeAssessment: "Non-authoritative context only; Quality Engine computes canonical status."
  };
  manifest.manifest.payloadSha256 = manifestHash(manifest);
  return manifest;
}

function evaluateActualSyncEvidence(syncRuns, changedFiles) {
  const actuallySynced = Array.isArray(syncRuns) && syncRuns.some((run) => run === "synced");
  const dataOnly = Array.isArray(changedFiles) && changedFiles.length > 0 && changedFiles.every((file) => DATA_ONLY_PATHS.includes(file));
  return { status: actuallySynced && dataOnly ? "GREEN" : "BLOCKED", reasonCode: actuallySynced ? (dataOnly ? "ACTUAL_SYNC_DATA_ONLY_VALID" : "ACTUAL_SYNC_CHANGED_FILES_INVALID") : "ACTUAL_SYNC_NOT_OBSERVED" };
}

module.exports = {
  DATA_ONLY_PATHS,
  EvidenceError,
  GATE_VERSION,
  PRODUCER_ID,
  PRODUCER_VERSION,
  REQUIRED_ISOLATED_ASSERTIONS,
  SCHEMA_ID,
  SCHEMA_VERSION,
  buildEvidenceManifest,
  evaluateActualSyncEvidence,
  evaluateMultiuserEvidence,
  findSecret,
  inspectSubjectIdentity,
  manifestHash,
  producerSourceSha256,
  stableStringify
};

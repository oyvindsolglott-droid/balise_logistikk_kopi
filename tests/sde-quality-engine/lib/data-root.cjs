"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  effectivePublicationBoundary,
  expectedOperationalDates,
  readJson,
  repoRoot
} = require("./core.cjs");

const DATA_ROOT_ENV = "SDE_QE_DATA_ROOT";
const MANIFEST_FILE = ".sde-qe-data-fixture.json";
const MANIFEST_SCHEMA = "sde-qe-data-fixture/v1";
const TIME_ZONE = "Europe/Oslo";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const FILES = Object.freeze([
  Object.freeze({logicalName: "api_idag.json", sourcePath: "data/api_idag.json"}),
  Object.freeze({logicalName: "api_imorgen.json", sourcePath: "data/api_imorgen.json"}),
  Object.freeze({logicalName: "sde-data-provenance.json", sourcePath: "data/sde-data-provenance.json"})
]);
const LOGICAL_FILES = new Map(FILES.map((entry) => [entry.logicalName, entry]));
const SOURCE_FILES = new Set(FILES.map((entry) => entry.sourcePath));

class DataRootError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "DataRootError";
    this.code = code;
    this.details = details;
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function gitEnvironment() {
  const environment = {...process.env};
  for (const key of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"
  ]) delete environment[key];
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  return environment;
}

function runGit(repository, args, {binary = false, code = "DATA_FIXTURE_GIT_FAILED"} = {}) {
  const result = childProcess.spawnSync("git", args, {
    cwd: repository,
    env: gitEnvironment(),
    encoding: binary ? null : "utf8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0 || result.error || result.signal) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : result.stderr;
    throw new DataRootError(code, `git ${args.join(" ")} failed: ${String(detail || result.error?.message || result.signal || "unknown").trim()}`);
  }
  return binary ? result.stdout : String(result.stdout).trim();
}

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new DataRootError("DATA_ROOT_PATH_INVALID", `${label} must be a non-empty NUL-free path.`);
  }
  if (!path.isAbsolute(value) || path.normalize(value) !== value || path.resolve(value) !== value) {
    throw new DataRootError("DATA_ROOT_PATH_NOT_CANONICAL", `${label} must be an absolute normalized path: ${value}`);
  }
  const stat = fs.lstatSync(value, {throwIfNoEntry: false});
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new DataRootError("DATA_ROOT_DIRECTORY_UNSAFE", `${label} must be a real directory, not a symlink: ${value}`);
  }
  const real = fs.realpathSync(value);
  if (real !== value) throw new DataRootError("DATA_ROOT_PATH_NOT_CANONICAL", `${label} realpath differs from the supplied path.`);
  return real;
}

function validateRef(value) {
  if (typeof value !== "string" || !/^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
      value.includes("..") || value.includes("//") || value.includes("@{") || value.endsWith("/")) {
    throw new DataRootError("DATA_FIXTURE_SOURCE_REF_INVALID", `Unsafe source ref: ${String(value)}`);
  }
  return value;
}

function validGitObject(value) {
  return /^[a-f0-9]{40,64}$/.test(String(value || ""));
}

function parseJsonBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new DataRootError("DATA_FIXTURE_JSON_INVALID", `${label} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DataRootError("DATA_FIXTURE_JSON_INVALID", `${label} must contain a JSON object.`);
  }
  return value;
}

function parseUpdatedAt(value) {
  const match = String(value || "").match(/^(\d{2})\.(\d{2})\.(\d{4})[ ,T]+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second] = match;
  const desiredLocal = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  let candidate = desiredLocal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const observedLocal = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    candidate += desiredLocal - observedLocal;
  }
  return Number.isFinite(candidate) ? candidate : null;
}

function validatePayloads(bytesByLogicalName, contract, now = new Date()) {
  const testTime = new Date(now);
  if (!Number.isFinite(testTime.getTime())) throw new DataRootError("DATA_FIXTURE_TIME_INVALID", "Validation time is invalid.");
  if (!contract || contract.timeZone !== TIME_ZONE) {
    throw new DataRootError("DATA_FIXTURE_FRESHNESS_CONTRACT_INVALID", `Freshness contract must use ${TIME_ZONE}.`);
  }
  const idag = parseJsonBytes(bytesByLogicalName.get("api_idag.json"), "api_idag.json");
  const imorgen = parseJsonBytes(bytesByLogicalName.get("api_imorgen.json"), "api_imorgen.json");
  const provenance = parseJsonBytes(bytesByLogicalName.get("sde-data-provenance.json"), "sde-data-provenance.json");
  const expected = expectedOperationalDates(testTime, contract);
  const boundary = new Date(effectivePublicationBoundary(testTime, contract).requiredRefreshBoundary);
  const generatedAtByMode = new Map();
  for (const [mode, payload] of [["idag", idag], ["imorgen", imorgen]]) {
    if (payload.mode !== mode || payload.date !== expected[mode]) {
      throw new DataRootError("DATA_FIXTURE_STALE_OPERATIONAL_DATE", `${mode} operational date is ${payload.date}; expected ${expected[mode]}.`);
    }
    const generatedAt = parseUpdatedAt(payload.updatedAt);
    if (generatedAt === null || generatedAt < boundary.getTime() || generatedAt > testTime.getTime() + 60_000) {
      throw new DataRootError("DATA_FIXTURE_STALE_UPDATED_AT", `${mode} updatedAt ${payload.updatedAt} is outside the current refresh boundary.`);
    }
    generatedAtByMode.set(mode, generatedAt);
  }
  if (provenance.schema !== "sde-data-provenance/v1" || !String(provenance.generationId || "").trim() ||
      provenance.timeZone !== TIME_ZONE || provenance.source?.snapshotStable !== true) {
    throw new DataRootError("DATA_FIXTURE_PROVENANCE_INVALID", "Provenance schema, generation, timezone, or stable-source evidence is invalid.");
  }
  const cycleDateMatch = String(provenance.intendedCycle?.date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const cycleHour = Number(provenance.intendedCycle?.hour);
  const intendedCycleMs = cycleDateMatch
    ? parseUpdatedAt(`${cycleDateMatch[3]}.${cycleDateMatch[2]}.${cycleDateMatch[1]} ${String(cycleHour).padStart(2, "0")}:00:00`)
    : null;
  const expectedCycleId = cycleDateMatch && Number.isInteger(cycleHour)
    ? `${provenance.intendedCycle.date}T${String(cycleHour).padStart(2, "0")}:00@${TIME_ZONE}`
    : null;
  if (intendedCycleMs === null || !contract.cycleHours.includes(cycleHour) || intendedCycleMs < boundary.getTime() ||
      intendedCycleMs > testTime.getTime() || provenance.intendedCycle?.id !== expectedCycleId ||
      [...generatedAtByMode.values()].some((generatedAt) => generatedAt < intendedCycleMs)) {
    throw new DataRootError("DATA_FIXTURE_PROVENANCE_CYCLE_MISMATCH", "Provenance intended cycle differs from the current effective refresh boundary.");
  }
  for (const [mode, logicalName, payload] of [
    ["idag", "api_idag.json", idag],
    ["imorgen", "api_imorgen.json", imorgen]
  ]) {
    const bytes = bytesByLogicalName.get(logicalName);
    const observed = provenance.datasets?.[mode];
    if (!observed || observed.path !== `data/${logicalName}` || observed.operationalDate !== payload.date ||
        observed.sha256 !== sha256(bytes) || observed.bytes !== bytes.length) {
      throw new DataRootError("DATA_FIXTURE_PROVENANCE_HASH_MISMATCH", `Provenance identity for ${logicalName} differs from the exact payload bytes.`);
    }
  }
  return {
    payloads: {idag, imorgen},
    provenance,
    expectedOperationalDateContract: {
      evaluatedAt: testTime.toISOString(),
      timeZone: TIME_ZONE,
      today: expected.idag,
      tomorrow: expected.imorgen,
      window: expected.window,
      requiredRefreshBoundary: boundary.toISOString(),
      contractSha256: sha256(Buffer.from(stableJson(contract)))
    }
  };
}

function dataOnlyVerification(repository, consumerCandidateSha, sourceCommit) {
  const mergeBase = runGit(repository, ["merge-base", consumerCandidateSha, sourceCommit], {code: "DATA_FIXTURE_MERGE_BASE_UNAVAILABLE"});
  if (!validGitObject(mergeBase)) throw new DataRootError("DATA_FIXTURE_MERGE_BASE_INVALID", "Merge base is not a Git object ID.");
  const commits = runGit(repository, ["rev-list", "--reverse", `${mergeBase}..${sourceCommit}`])
    .split(/\r?\n/).filter(Boolean).map((commit) => {
      const parents = runGit(repository, ["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean);
      if (parents.length !== 1) throw new DataRootError("DATA_FIXTURE_NON_DATA_HISTORY", `Source-only commit ${commit} is not single-parent.`);
      const changedPaths = runGit(repository, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
        .split(/\r?\n/).filter(Boolean).sort();
      const forbidden = changedPaths.filter((file) => !SOURCE_FILES.has(file));
      if (!changedPaths.length || forbidden.length) {
        throw new DataRootError("DATA_FIXTURE_NON_DATA_HISTORY", `Source-only commit ${commit} violates the data-only allowlist: ${forbidden.join(",") || "no data paths"}.`);
      }
      return {commit, parent: parents[0], changedPaths};
    });
  if (!commits.length) throw new DataRootError("DATA_FIXTURE_SOURCE_NOT_FRESHER", "Source ref has no data-only commits beyond the candidate merge base.");
  return {mergeBase, range: `${mergeBase}..${sourceCommit}`, commitCount: commits.length, commits};
}

function fixtureIdentity(manifest) {
  return {
    schema: manifest.schema,
    sourceRepository: manifest.sourceRepository,
    sourceRef: manifest.sourceRef,
    sourceCommit: manifest.sourceCommit,
    sourceTree: manifest.sourceTree,
    mergeBase: manifest.mergeBase,
    files: manifest.files,
    provenanceFileSha256: manifest.provenanceFileSha256,
    expectedOperationalDateContract: manifest.expectedOperationalDateContract,
    dataOnlyVerification: manifest.dataOnlyVerification
  };
}

function freshnessIdentity(evidence) {
  return {
    timeZone: evidence?.timeZone,
    today: evidence?.today,
    tomorrow: evidence?.tomorrow,
    window: evidence?.window,
    requiredRefreshBoundary: evidence?.requiredRefreshBoundary,
    contractSha256: evidence?.contractSha256
  };
}

function materializeDataFixture({sourceRepository, sourceRef, consumerCandidateSha, outputRoot, now = new Date()}) {
  const sourceRoot = canonicalDirectory(sourceRepository, "sourceRepository");
  validateRef(sourceRef);
  if (!validGitObject(consumerCandidateSha)) throw new DataRootError("DATA_FIXTURE_CONSUMER_INVALID", "consumerCandidateSha must be an exact Git object ID.");
  const verifiedConsumer = runGit(sourceRoot, ["rev-parse", "--verify", `${consumerCandidateSha}^{commit}`], {code: "DATA_FIXTURE_CONSUMER_UNAVAILABLE"});
  if (verifiedConsumer !== consumerCandidateSha) throw new DataRootError("DATA_FIXTURE_CONSUMER_MISMATCH", "consumerCandidateSha did not resolve exactly.");
  const sourceCommit = runGit(sourceRoot, ["rev-parse", "--verify", `${sourceRef}^{commit}`], {code: "DATA_FIXTURE_SOURCE_REF_UNAVAILABLE"});
  const sourceTree = runGit(sourceRoot, ["rev-parse", `${sourceCommit}^{tree}`]);
  const verification = dataOnlyVerification(sourceRoot, consumerCandidateSha, sourceCommit);
  const fileRecords = FILES.map(({logicalName, sourcePath}) => {
    const bytes = runGit(sourceRoot, ["show", `${sourceCommit}:${sourcePath}`], {binary: true, code: "DATA_FIXTURE_BLOB_UNAVAILABLE"});
    const blobObjectId = runGit(sourceRoot, ["rev-parse", `${sourceCommit}:${sourcePath}`]);
    if (!validGitObject(blobObjectId) || runGit(sourceRoot, ["cat-file", "-t", blobObjectId]) !== "blob") {
      throw new DataRootError("DATA_FIXTURE_BLOB_INVALID", `${sourcePath} is not an exact Git blob.`);
    }
    return {logicalName, sourcePath, blobObjectId, byteLength: bytes.length, sha256: sha256(bytes), bytes};
  });
  const bytesByLogicalName = new Map(fileRecords.map((entry) => [entry.logicalName, entry.bytes]));
  const contractPath = path.join(sourceRoot, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json");
  const contract = readJson(contractPath);
  const validated = validatePayloads(bytesByLogicalName, contract, now);
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot) || path.normalize(outputRoot) !== outputRoot || path.resolve(outputRoot) !== outputRoot || outputRoot.includes("\0")) {
    throw new DataRootError("DATA_ROOT_PATH_NOT_CANONICAL", "outputRoot must be an absolute normalized path.");
  }
  if (fs.existsSync(outputRoot)) throw new DataRootError("DATA_ROOT_ALREADY_EXISTS", `Refusing to overwrite existing outputRoot: ${outputRoot}`);
  canonicalDirectory(path.dirname(outputRoot), "outputRoot parent");
  fs.mkdirSync(outputRoot, {mode: 0o700});
  const fixtureRootRealpath = fs.realpathSync(outputRoot);
  try {
    for (const record of fileRecords) {
      fs.writeFileSync(path.join(outputRoot, record.logicalName), record.bytes, {flag: "wx", mode: 0o600});
    }
    const manifest = {
      schema: MANIFEST_SCHEMA,
      sourceRepository: sourceRoot,
      sourceRef,
      sourceCommit,
      sourceTree,
      mergeBase: verification.mergeBase,
      materializedAt: new Date(now).toISOString(),
      timeZone: TIME_ZONE,
      files: fileRecords.map(({bytes: _bytes, ...record}) => record),
      provenanceFileSha256: sha256(bytesByLogicalName.get("sde-data-provenance.json")),
      expectedOperationalDateContract: validated.expectedOperationalDateContract,
      dataOnlyVerification: verification,
      consumerCandidateSha,
      fixtureRootRealpath
    };
    manifest.fixtureId = sha256(Buffer.from(stableJson(fixtureIdentity(manifest))));
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(outputRoot, MANIFEST_FILE), manifestBytes, {flag: "wx", mode: 0o600});
    for (const record of fileRecords) fs.chmodSync(path.join(outputRoot, record.logicalName), 0o400);
    fs.chmodSync(path.join(outputRoot, MANIFEST_FILE), 0o400);
    fs.chmodSync(outputRoot, 0o500);
    return {root: fixtureRootRealpath, fixtureId: manifest.fixtureId, manifestHash: sha256(manifestBytes), manifest};
  } catch (error) {
    fs.rmSync(outputRoot, {recursive: true, force: true});
    throw error;
  }
}

function safeFile(root, logicalName) {
  if (!LOGICAL_FILES.has(logicalName)) throw new DataRootError("DATA_ROOT_LOGICAL_FILE_FORBIDDEN", `Logical file is outside the allowlist: ${logicalName}`);
  const file = path.join(root, logicalName);
  const stat = fs.lstatSync(file, {throwIfNoEntry: false});
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new DataRootError("DATA_ROOT_FILE_UNSAFE", `${logicalName} must be a regular file, not a symlink.`);
  const real = fs.realpathSync(file);
  if (!real.startsWith(`${root}${path.sep}`) || path.dirname(real) !== root) {
    throw new DataRootError("DATA_ROOT_FILE_ESCAPE", `${logicalName} escapes the isolated root.`);
  }
  return {file, stat};
}

function readManifest(root) {
  const file = path.join(root, MANIFEST_FILE);
  const stat = fs.lstatSync(file, {throwIfNoEntry: false});
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
    throw new DataRootError("DATA_ROOT_MANIFEST_UNSAFE", `Fixture manifest is missing, too large, or not a regular file: ${file}`);
  }
  const real = fs.realpathSync(file);
  if (path.dirname(real) !== root) throw new DataRootError("DATA_ROOT_MANIFEST_ESCAPE", "Fixture manifest escapes the isolated root.");
  const bytes = fs.readFileSync(file);
  return {manifest: parseJsonBytes(bytes, MANIFEST_FILE), bytes};
}

function resolveCandidateSha(repositoryRoot, candidateSha, environment) {
  const selected = candidateSha || environment.SDE_PREPUSH_CANDIDATE_SHA || runGit(repositoryRoot, ["rev-parse", "HEAD"], {code: "DATA_FIXTURE_CONSUMER_UNAVAILABLE"});
  if (!validGitObject(selected)) throw new DataRootError("DATA_FIXTURE_CONSUMER_INVALID", "Current candidate SHA is invalid.");
  return selected;
}

function resolveDataRoot(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || repoRoot());
  const environment = options.env === undefined ? process.env : options.env;
  const selected = options.dataRoot === undefined ? environment[DATA_ROOT_ENV] : options.dataRoot;
  if (!selected) return {mode: "DEFAULT", root: path.join(repositoryRoot, "data"), fixtureId: null, manifest: null};
  const root = canonicalDirectory(selected, DATA_ROOT_ENV);
  const {manifest, bytes: manifestBytes} = readManifest(root);
  if (manifest.schema !== MANIFEST_SCHEMA) throw new DataRootError("DATA_ROOT_MANIFEST_SCHEMA_MISMATCH", `Unsupported manifest schema: ${manifest.schema}`);
  if (manifest.fixtureRootRealpath !== root) throw new DataRootError("DATA_ROOT_MANIFEST_PATH_MISMATCH", "fixtureRootRealpath differs from the resolved root.");
  if (manifest.timeZone !== TIME_ZONE) throw new DataRootError("DATA_ROOT_TIMEZONE_MISMATCH", `Manifest timezone must be ${TIME_ZONE}.`);
  validateRef(manifest.sourceRef);
  const sourceRoot = canonicalDirectory(manifest.sourceRepository, "manifest.sourceRepository");
  const candidateSha = resolveCandidateSha(repositoryRoot, options.candidateSha, environment);
  if (manifest.consumerCandidateSha !== candidateSha) throw new DataRootError("DATA_ROOT_CONSUMER_CANDIDATESHA_MISMATCH", "consumerCandidateSha differs from the current candidate SHA.");
  const sourceCommit = runGit(sourceRoot, ["rev-parse", "--verify", `${manifest.sourceRef}^{commit}`], {code: "DATA_ROOT_SOURCE_REF_UNAVAILABLE"});
  if (sourceCommit !== manifest.sourceCommit) throw new DataRootError("DATA_ROOT_SOURCECOMMIT_MISMATCH", "sourceCommit differs from the current exact source ref.");
  const sourceTree = runGit(sourceRoot, ["rev-parse", `${sourceCommit}^{tree}`]);
  if (sourceTree !== manifest.sourceTree) throw new DataRootError("DATA_ROOT_SOURCETREE_MISMATCH", "sourceTree differs from the exact source commit tree.");
  const verification = dataOnlyVerification(sourceRoot, candidateSha, sourceCommit);
  if (verification.mergeBase !== manifest.mergeBase || stableJson(verification) !== stableJson(manifest.dataOnlyVerification)) {
    throw new DataRootError("DATA_ROOT_DATA_ONLY_VERIFICATION_MISMATCH", "mergeBase or data-only source history differs from the manifest.");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== FILES.length) throw new DataRootError("DATA_ROOT_FILE_MANIFEST_INVALID", "Manifest must identify exactly three data files.");
  const bytesByLogicalName = new Map();
  for (let index = 0; index < FILES.length; index += 1) {
    const expected = FILES[index];
    const observed = manifest.files[index];
    if (observed?.logicalName !== expected.logicalName || observed?.sourcePath !== expected.sourcePath || !validGitObject(observed.blobObjectId)) {
      throw new DataRootError("DATA_ROOT_FILE_MANIFEST_INVALID", `Manifest entry ${index} differs from the exact allowlist.`);
    }
    const {file, stat} = safeFile(root, expected.logicalName);
    const fileBytes = fs.readFileSync(file);
    const sourceBytes = runGit(sourceRoot, ["show", `${sourceCommit}:${expected.sourcePath}`], {binary: true, code: "DATA_ROOT_SOURCE_BLOB_UNAVAILABLE"});
    const blobObjectId = runGit(sourceRoot, ["rev-parse", `${sourceCommit}:${expected.sourcePath}`]);
    if (stat.size !== observed.byteLength || fileBytes.length !== observed.byteLength || sha256(fileBytes) !== observed.sha256 ||
        blobObjectId !== observed.blobObjectId || !fileBytes.equals(sourceBytes)) {
      throw new DataRootError("DATA_ROOT_BLOB_HASH_MISMATCH", `${expected.logicalName} byte, hash, size, or Git blob identity differs.`);
    }
    bytesByLogicalName.set(expected.logicalName, fileBytes);
  }
  if (manifest.provenanceFileSha256 !== sha256(bytesByLogicalName.get("sde-data-provenance.json"))) {
    throw new DataRootError("DATA_ROOT_PROVENANCE_HASH_MISMATCH", "Provenance file hash differs from the manifest.");
  }
  const contract = readJson(path.join(repositoryRoot, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"));
  const validated = validatePayloads(bytesByLogicalName, contract, options.now || new Date());
  if (stableJson(freshnessIdentity(validated.expectedOperationalDateContract)) !==
      stableJson(freshnessIdentity(manifest.expectedOperationalDateContract))) {
    throw new DataRootError("DATA_ROOT_FRESHNESS_EVIDENCE_MISMATCH", "Current operational-date contract differs from materialization evidence.");
  }
  const expectedFixtureId = sha256(Buffer.from(stableJson(fixtureIdentity(manifest))));
  if (manifest.fixtureId !== expectedFixtureId) throw new DataRootError("DATA_ROOT_FIXTURE_ID_MISMATCH", "fixtureId does not match the canonical fixture identity.");
  return {
    mode: "ISOLATED_FRESH_DATA",
    root,
    fixtureId: manifest.fixtureId,
    manifest,
    manifestHash: sha256(manifestBytes)
  };
}

function readDataBytes(logicalName, options = {}) {
  if (!LOGICAL_FILES.has(logicalName)) throw new DataRootError("DATA_ROOT_LOGICAL_FILE_FORBIDDEN", `Logical file is outside the allowlist: ${logicalName}`);
  const resolved = options.resolved || resolveDataRoot(options);
  if (resolved.mode === "ISOLATED_FRESH_DATA") return fs.readFileSync(safeFile(resolved.root, logicalName).file);
  return fs.readFileSync(path.join(resolved.root, logicalName));
}

function readDataJson(logicalName, options = {}) {
  return parseJsonBytes(readDataBytes(logicalName, options), logicalName);
}

function dataRootEnvironment(resolved) {
  const root = typeof resolved === "string" ? resolved : resolved?.root;
  if (!root || !path.isAbsolute(root)) throw new DataRootError("DATA_ROOT_ENVIRONMENT_INVALID", "A resolved absolute data root is required.");
  return {[DATA_ROOT_ENV]: root};
}

module.exports = {
  DATA_ROOT_ENV,
  FILES,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  DataRootError,
  dataRootEnvironment,
  materializeDataFixture,
  readDataBytes,
  readDataJson,
  resolveDataRoot,
  validatePayloads
};

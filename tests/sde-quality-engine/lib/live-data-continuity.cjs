"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { addDays, nowOsloParts, result } = require("./core.cjs");
const {
  DATA_ONLY_PATHS,
  EvidenceError,
  findSecret,
  stableStringify
} = require("./multiuser-evidence.cjs");

const SCHEMA_VERSION = "sde-live-data-continuity/v1";
const GATE_VERSION = "1.0.0";
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
const PRODUCER_ID = "sde-qe-live-data-continuity-observer";
const PRODUCER_VERSION = "1.0.0";
const PRIORITY = Object.freeze({
  HISTORICAL_REPORT: 0,
  MANUAL_ATTESTATION: 1,
  REUSED_EXACT_SHA: 2,
  FRESH_OBSERVED: 3
});
const REQUIRED_TOP_LEVEL = Object.freeze([
  "schemaVersion", "observedAt", "deployedAt", "timeZone", "evidenceClass", "source",
  "scheduler", "applyReadiness", "actualSync", "privateReadback",
  "publicReadback", "ui", "publicationAttestation", "historicalReport",
  "manualAttestation", "actionsAttempted", "producer", "binding"
]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function producerSourceSha256() {
  return sha256(fs.readFileSync(__filename));
}

function evidencePayloadSha256(evidence) {
  const copy = structuredClone(evidence);
  if (copy.binding) copy.binding.payloadSha256 = "";
  return sha256(Buffer.from(stableStringify(copy)));
}

function bindLiveDataEvidence(evidence) {
  const copy = structuredClone(evidence);
  copy.producer = {
    id: PRODUCER_ID,
    version: PRODUCER_VERSION,
    codeSha256: producerSourceSha256(),
    collectionMode: "repository-owned-read-only-observer",
    trustLevel: "REPOSITORY_OWNED_LOCAL"
  };
  copy.binding = { algorithm: "sha256", payloadSha256: "" };
  copy.binding.payloadSha256 = evidencePayloadSha256(copy);
  return copy;
}

function expectedLiveDataDates(now = new Date()) {
  const oslo = nowOsloParts(now);
  if (oslo.hour < 7) {
    return { idag: addDays(oslo.isoDate, -1), imorgen: oslo.isoDate, window: "before_07" };
  }
  if (oslo.hour < 15) {
    return { idag: oslo.isoDate, imorgen: oslo.isoDate, window: "07_to_145959" };
  }
  return { idag: oslo.isoDate, imorgen: addDays(oslo.isoDate, 1), window: "from_15" };
}

function isFreshTimestamp(value, now, maxAgeMs = 30 * 60 * 1000) {
  const observed = new Date(value);
  if (!Number.isFinite(observed.getTime())) return false;
  const age = now.getTime() - observed.getTime();
  return age >= -5 * 60 * 1000 && age <= maxAgeMs;
}

function child(id, status, reasonCode, summary, details = {}, evidence = []) {
  return {
    id,
    status,
    reasonCode,
    summary,
    details,
    evidence: Array.isArray(evidence) ? evidence : [evidence]
  };
}

function blocked(id, reasonCode, summary, details = {}) {
  return child(id, "BLOCKED", reasonCode, summary, details);
}

function gitRead(repository, args, allowedExitCodes = [0]) {
  const observed = spawnSync("git", ["-C", repository, ...args], {
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
  if (observed.error || !allowedExitCodes.includes(observed.status)) {
    throw new EvidenceError(
      "LIVE_DATA_GIT_AUTHORITY_UNAVAILABLE",
      `Git readback feilet kontrollert for ${args[0] || "unknown"}.`
    );
  }
  return { status: observed.status, stdout: observed.stdout.trim() };
}

function gitBytes(repository, objectPath) {
  const observed = spawnSync("git", ["-C", repository, "show", objectPath], {
    encoding: null,
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
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
  if (observed.error || observed.status !== 0) {
    throw new EvidenceError("LIVE_DATA_GIT_BLOB_UNAVAILABLE", `Git-blob ${objectPath} kunne ikke leses.`);
  }
  return Buffer.from(observed.stdout);
}

function activeGitOperations(repository) {
  const operations = [];
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
    const gitPath = gitRead(repository, ["rev-parse", "--git-path", name]).stdout;
    if (fs.existsSync(gitPath)) operations.push(name);
  }
  return operations;
}

function inspectDataOnlyCommits(repository, approvedSha, runtimeSha) {
  if (approvedSha === runtimeSha) return { commits: [], changedFiles: [], valid: true, violations: [] };
  const lines = gitRead(repository, [
    "rev-list", "--reverse", "--topo-order", "--parents", `${approvedSha}..${runtimeSha}`
  ]).stdout.split("\n").filter(Boolean);
  const violations = [];
  const commits = [];
  for (const line of lines) {
    const fields = line.split(/\s+/);
    if (fields.length !== 2) {
      violations.push(`${fields[0]}: mergecommit eller tvetydig historikk`);
      continue;
    }
    const [commitSha, parentSha] = fields;
    const raw = gitRead(repository, [
      "diff-tree", "--no-commit-id", "--raw", "-r", "--no-renames", parentSha, commitSha
    ]).stdout.split("\n").filter(Boolean);
    const numstat = gitRead(repository, [
      "diff-tree", "--no-commit-id", "--numstat", "-r", "--no-renames", parentSha, commitSha
    ]).stdout.split("\n").filter(Boolean);
    const changedFiles = [];
    for (const entry of raw) {
      const match = entry.match(/^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])\t(.+)$/);
      if (!match) {
        violations.push(`${commitSha}: ukjent raw diff-format`);
        continue;
      }
      const [, oldMode, newMode, status, file] = match;
      changedFiles.push(file);
      if (!DATA_ONLY_PATHS.includes(file)) violations.push(`${commitSha}: uautorisert fil ${file}`);
      if (status !== "M") violations.push(`${commitSha}: ${file} har status ${status}`);
      if (oldMode !== "100644" || newMode !== "100644") {
        violations.push(`${commitSha}: ${file} har mode-endring, symlink eller gitlink`);
      }
    }
    for (const entry of numstat) {
      const [added, deleted, ...fileParts] = entry.split("\t");
      if (added === "-" || deleted === "-") {
        violations.push(`${commitSha}: binærfil ${fileParts.join("\t")}`);
      }
    }
    commits.push({ sha: commitSha, parent: parentSha, changedFiles: [...new Set(changedFiles)].sort() });
  }
  const changedFiles = [...new Set(commits.flatMap((entry) => entry.changedFiles))].sort();
  return { commits, changedFiles, valid: violations.length === 0, violations };
}

function inspectRuntime({ subjectRepository, approvedSha, approvedTree, approvedMainRef }) {
  const repository = path.resolve(subjectRepository || "");
  const branchRead = gitRead(repository, ["symbolic-ref", "--short", "-q", "HEAD"], [0, 1]);
  const branch = branchRead.status === 0 ? branchRead.stdout : "detached";
  const head = gitRead(repository, ["rev-parse", "HEAD"]).stdout;
  const tree = gitRead(repository, ["rev-parse", "HEAD^{tree}"]).stdout;
  const dirty = gitRead(repository, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout
    .split("\n").filter(Boolean);
  const operations = activeGitOperations(repository);
  const mainTip = gitRead(repository, ["rev-parse", "--verify", `${approvedMainRef}^{commit}`]).stdout;
  const onMainLine = gitRead(
    repository,
    ["merge-base", "--is-ancestor", approvedSha, mainTip],
    [0, 1]
  ).status === 0;
  const actualApprovedTree = gitRead(repository, ["rev-parse", `${approvedSha}^{tree}`]).stdout;
  const runtimeDescendant = gitRead(
    repository,
    ["merge-base", "--is-ancestor", approvedSha, head],
    [0, 1]
  ).status === 0;
  const descendant = inspectDataOnlyCommits(repository, approvedSha, head);
  return {
    repository,
    branch,
    head,
    tree,
    dirty,
    operations,
    mainTip,
    onMainLine,
    actualApprovedTree,
    approvedTreeMatches: actualApprovedTree === approvedTree,
    runtimeDescendant,
    descendant
  };
}

function runtimeData(repository, head) {
  const datasets = {};
  for (const mode of ["idag", "imorgen"]) {
    const file = `data/api_${mode}.json`;
    const bytes = gitBytes(repository, `${head}:${file}`);
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (_error) {
      throw new EvidenceError("LIVE_DATA_RUNTIME_JSON_INVALID", `${file} er ikke gyldig JSON.`, "RED");
    }
    datasets[mode] = {
      path: file,
      date: parsed.date || null,
      bytes: bytes.length,
      sha256: sha256(bytes),
      blob: gitRead(repository, ["rev-parse", `${head}:${file}`]).stdout,
      raw: bytes,
      parsed
    };
  }
  const provenanceBytes = gitBytes(repository, `${head}:data/sde-data-provenance.json`);
  let provenance;
  try {
    provenance = JSON.parse(provenanceBytes.toString("utf8"));
  } catch (_error) {
    throw new EvidenceError("LIVE_DATA_PROVENANCE_JSON_INVALID", "Genereringsproveniens er ikke gyldig JSON.", "RED");
  }
  return { datasets, provenance, provenanceBytes };
}

function readbackGate(id, readback, datasets, { publicRoute = false, now = new Date() } = {}) {
  if (!readback || typeof readback !== "object") {
    return blocked(id, `${id}_EVIDENCE_MISSING`, `${id} mangler kritisk evidens.`);
  }
  if (readback.available !== true) {
    return blocked(id, `${id}_TOOL_BLOCKER_UNAVAILABLE`, `${id} kunne ikke observeres autentisert.`);
  }
  if (!isFreshTimestamp(readback.observedAt, now)) {
    return blocked(id, `${id}_EVIDENCE_STALE`, `${id} mangler en fersk tidsbundet observasjon.`);
  }
  const transportProblems = [];
  if (readback.httpStatus !== 200) transportProblems.push(`HTTP ${readback.httpStatus}`);
  if (!/^application\/json\b/i.test(String(readback.contentType || ""))) {
    transportProblems.push(`Content-Type ${readback.contentType || "mangler"}`);
  }
  if (readback.bodyKind !== "json") transportProblems.push(`bodyKind=${readback.bodyKind || "mangler"}`);
  if (publicRoute && readback.authenticated !== true) transportProblems.push("authenticated=false");
  if (transportProblems.length) {
    return child(
      id,
      "RED",
      `${id}_TRANSPORT_OR_AUTH_MISMATCH`,
      `${id} returnerte login/redirect/Access/feilformat: ${transportProblems.join(", ")}.`,
      { transportProblems, bodyKind: readback.bodyKind || null }
    );
  }
  const mismatches = [];
  for (const mode of ["idag", "imorgen"]) {
    const actual = readback.datasets?.[mode];
    const expected = datasets[mode];
    if (!actual) {
      mismatches.push(`${mode}: mangler`);
      continue;
    }
    for (const field of ["date", "bytes", "sha256"]) {
      if (actual[field] !== expected[field]) mismatches.push(`${mode}.${field}`);
    }
  }
  return child(
    id,
    mismatches.length ? "RED" : "GREEN",
    mismatches.length ? `${id}_BYTE_OR_DATE_MISMATCH` : `${id}_VERIFIED`,
    mismatches.length
      ? `${id} avviker fra runtime Git-bytes: ${mismatches.join(", ")}.`
      : `${id} matcher runtime Git-byteantall, SHA-256 og operative datoer.`,
    {
      mismatches,
      httpStatus: readback.httpStatus,
      contentType: readback.contentType,
      gitBlobs: { idag: datasets.idag.blob, imorgen: datasets.imorgen.blob }
    }
  );
}

function provenanceGate(runtime, evidence) {
  const findings = [];
  const generation = runtime.provenance;
  if (generation?.schema !== "sde-data-provenance/v1") findings.push("ukjent genereringsschema");
  if (generation?.timeZone !== "Europe/Oslo") findings.push("genereringstidssone er ikke Europe/Oslo");
  for (const mode of ["idag", "imorgen"]) {
    const declared = generation?.datasets?.[mode];
    const actual = runtime.datasets[mode];
    if (!declared) {
      findings.push(`${mode}: mangler genereringsproveniens`);
      continue;
    }
    if (declared.operationalDate !== actual.date) findings.push(`${mode}: operationalDate mismatch`);
    if (declared.bytes !== actual.bytes) findings.push(`${mode}: byte count mismatch`);
    if (declared.sha256 !== actual.sha256) findings.push(`${mode}: SHA-256 mismatch`);
  }
  if (findings.length) {
    return child(
      "LIVE-DATA-PROVENANCE",
      "RED",
      "LIVE_DATA_GENERATION_PROVENANCE_CONTRADICTION",
      findings.join("; "),
      { findings, generationGit: generation?.git || null }
    );
  }
  const attestation = evidence.publicationAttestation;
  if (!attestation || attestation.available !== true) {
    return blocked(
      "LIVE-DATA-PROVENANCE",
      "UNATTESTED_GENERATION",
      "Genereringsproveniens er konsistent, men commit/tree/publiseringsattestasjon mangler.",
      { generationGit: generation?.git || null, publicationAttestation: "UNAVAILABLE" }
    );
  }
  const publicationMismatches = [];
  if (attestation.dataCommit !== runtime.head) publicationMismatches.push("dataCommit");
  if (attestation.dataTree !== runtime.tree) publicationMismatches.push("dataTree");
  for (const mode of ["idag", "imorgen"]) {
    for (const field of ["date", "bytes", "sha256"]) {
      if (attestation.datasets?.[mode]?.[field] !== runtime.datasets[mode][field]) {
        publicationMismatches.push(`${mode}.${field}`);
      }
    }
  }
  return child(
    "LIVE-DATA-PROVENANCE",
    publicationMismatches.length ? "RED" : "GREEN",
    publicationMismatches.length ? "LIVE_DATA_PUBLICATION_ATTESTATION_MISMATCH" : "LIVE_DATA_PROVENANCE_VERIFIED",
    publicationMismatches.length
      ? `Publiseringsattestasjonen motsier runtime: ${publicationMismatches.join(", ")}.`
      : "Genereringsproveniens og separat commit/tree-bundet publiseringsattestasjon er verifisert.",
    { generationGit: generation?.git || null, publicationMismatches }
  );
}

function aggregate(children, context = {}) {
  const red = children.find((item) => item.status === "RED");
  const unproven = children.find((item) => ["BLOCKED", "UNKNOWN", "AMBER"].includes(item.status));
  const status = red ? "RED" : unproven ? "BLOCKED" : "GREEN";
  const first = red || unproven || null;
  const historicalGreen = context.evidence?.historicalReport?.status === "GREEN";
  const evidencePriority = {
    order: ["FRESH_OBSERVED", "REUSED_EXACT_SHA", "MANUAL_ATTESTATION", "HISTORICAL_REPORT"],
    winner: context.evidence?.evidenceClass || "NONE",
    historicalGreenOverridden: Boolean(historicalGreen && status !== "GREEN")
  };
  const p0 = result({
    id: "LIVE-DATA-FRESHNESS-P0",
    contractId: "LIVE-DATA-FRESHNESS-P0",
    area: "live-data-continuity",
    name: "Komplett live-data continuity",
    status,
    critical: true,
    gateVersion: GATE_VERSION,
    reasonCode: first?.reasonCode || "LIVE_DATA_CONTINUITY_ALL_CRITICAL_REQUIREMENTS_GREEN",
    severity: "CRITICAL",
    childGates: children.map((item) => item.id),
    aggregate: true,
    counted: true,
    summary: status === "GREEN"
      ? "Ekstern kilde, operative data, Git/runtime, sync, private/public readback, UI og proveniens er GREEN."
      : `${first?.id || "LIVE-DATA-EVIDENCE"}: ${first?.summary || "kritisk evidens mangler"}`,
    evidence: [
      "tests/sde-quality-engine/contracts/sde-live-data-continuity-v1.schema.json",
      ...(context.evidencePath ? [context.evidencePath] : [])
    ],
    details: {
      approvedCodeSha: context.approvedSha || null,
      approvedCodeTree: context.approvedTree || null,
      runtimeBranch: context.runtime?.branch || null,
      runtimeHead: context.runtime?.head || null,
      runtimeTree: context.runtime?.tree || null,
      dataOnlyDescendantStatus: context.runtime
        ? context.runtime.head === context.approvedSha
          ? "EXACT_APPROVED_SHA"
          : subgateStatus(children, "LIVE-DATA-CODE-IDENTITY")
        : "UNPROVEN",
      operativeWindow: context.expected?.window || null,
      expectedDates: context.expected
        ? { idag: context.expected.idag, imorgen: context.expected.imorgen }
        : null,
      actualDates: context.runtime
        ? { idag: context.runtime.datasets?.idag?.date || null, imorgen: context.runtime.datasets?.imorgen?.date || null }
        : null,
      schedulerHealth: subgateStatus(children, "SCHEDULER_HEALTH"),
      applyReadiness: subgateStatus(children, "DATA_APPLY_READINESS"),
      actualSyncApplied: subgateStatus(children, "ACTUAL_SYNC_APPLIED"),
      privateReadback: subgateStatus(children, "PRIVATE_ORIGIN_READBACK"),
      publicAuthenticatedReadback: subgateStatus(children, "PUBLIC_AUTHENTICATED_READBACK"),
      actualUiFreshness: subgateStatus(children, "ACTUAL_UI_FRESHNESS"),
      provenance: subgateStatus(children, "LIVE-DATA-PROVENANCE"),
      evidencePriority,
      firstSafeDivergence: first?.id || null,
      p0Aggregate: status,
      overallVerdict: status === "GREEN" ? "GO" : status === "RED" ? "NO-GO" : "HOLD",
      subgates: children
    },
    recommendation: status === "GREEN"
      ? null
      : "Stopp samlet GO/merge/release til den første sikre divergensen er lukket med fersk, bundet evidens."
  });
  return p0;
}

function subgateStatus(children, id) {
  return children.find((item) => item.id === id)?.status || "NOT_EVALUATED";
}

function evidenceErrorGate(error, context = {}) {
  const status = error instanceof EvidenceError && error.status === "RED" ? "RED" : "BLOCKED";
  const safeMessage = error instanceof EvidenceError
    ? error.message
    : "Live-data-evidensen kunne ikke evalueres kontrollert.";
  const reasonCode = error instanceof EvidenceError
    ? error.reasonCode
    : "LIVE_DATA_EVIDENCE_EVALUATION_ERROR";
  return aggregate([
    child("LIVE-DATA-EVIDENCE", status, reasonCode, safeMessage)
  ], context);
}

function validateEvidenceShape(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_SCHEMA_INVALID", "Live-data-evidens må være et objekt.");
  }
  const missing = REQUIRED_TOP_LEVEL.filter((key) => !Object.hasOwn(evidence, key));
  if (missing.length) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_MISSING_CRITICAL_FIELD", `Kritiske evidensfelt mangler: ${missing.join(", ")}.`);
  }
  if (evidence.schemaVersion !== SCHEMA_VERSION || evidence.timeZone !== "Europe/Oslo") {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_SCHEMA_INVALID", "Ukjent schema eller tidsauthority.");
  }
  if (!Object.hasOwn(PRIORITY, evidence.evidenceClass)) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_CLASS_INVALID", "Ukjent evidensprioritet.");
  }
  if (!Array.isArray(evidence.actionsAttempted)) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_SCHEMA_INVALID", "actionsAttempted må være en liste.");
  }
  const unknown = Object.keys(evidence).filter((key) => !REQUIRED_TOP_LEVEL.includes(key));
  if (unknown.length) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_SCHEMA_UNKNOWN_FIELD", `Ukjente evidensfelt: ${unknown.join(", ")}.`);
  }
  const observedAt = new Date(evidence.observedAt);
  if (!Number.isFinite(observedAt.getTime())) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_TIME_INVALID", "observedAt er ugyldig.");
  }
  const expectedProducerKeys = ["id", "version", "codeSha256", "collectionMode", "trustLevel"];
  if (!evidence.producer || expectedProducerKeys.some((key) => !Object.hasOwn(evidence.producer, key)) ||
    Object.keys(evidence.producer).some((key) => !expectedProducerKeys.includes(key))) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_PRODUCER_INVALID", "Evidensprodusenten er manglende eller ukjent.");
  }
  if (evidence.producer.id !== PRODUCER_ID || evidence.producer.version !== PRODUCER_VERSION ||
    evidence.producer.codeSha256 !== producerSourceSha256() ||
    evidence.producer.collectionMode !== "repository-owned-read-only-observer" ||
    evidence.producer.trustLevel !== "REPOSITORY_OWNED_LOCAL") {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_PRODUCER_MISMATCH", "Evidensen er ikke bundet til godkjent repository-produsentkode.");
  }
  if (evidence.binding?.algorithm !== "sha256" ||
    !/^[a-f0-9]{64}$/.test(evidence.binding?.payloadSha256 || "") ||
    evidence.binding.payloadSha256 !== evidencePayloadSha256(evidence)) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_BINDING_MISMATCH", "Evidensens kanoniske payload-SHA-256 matcher ikke innholdet.");
  }
}

function evaluateLiveDataContinuity(options = {}) {
  const context = {
    approvedSha: options.approvedSha || null,
    approvedTree: options.approvedTree || null,
    evidence: options.evidence || null,
    evidencePath: options.evidencePath || null
  };
  try {
    const evidence = options.evidence;
    validateEvidenceShape(evidence);
    if (!options.subjectRepository || !options.approvedSha || !options.approvedTree || !options.approvedMainRef) {
      throw new EvidenceError(
        "LIVE_DATA_APPROVED_IDENTITY_MISSING",
        "Trusted runtime-repository, approved SHA/tree og autorisert main-ref må oppgis eksplisitt."
      );
    }
    const now = options.now || new Date();
    if (!isFreshTimestamp(evidence.observedAt, now)) {
      throw new EvidenceError("LIVE_DATA_EVIDENCE_STALE", "Live-data-evidensen er eldre enn det ferske P0-vinduet.");
    }
    const deployedAt = new Date(evidence.deployedAt);
    if (!Number.isFinite(deployedAt.getTime()) || deployedAt > new Date(evidence.observedAt)) {
      throw new EvidenceError("LIVE_DATA_DEPLOY_TIME_INVALID", "Deploy- og observasjonstid er ugyldig eller motsigende.");
    }
    const expected = expectedLiveDataDates(now);
    const runtimeIdentity = inspectRuntime(options);
    const runtime = {
      ...runtimeIdentity,
      ...runtimeData(runtimeIdentity.repository, runtimeIdentity.head)
    };
    context.runtime = runtime;
    context.expected = expected;
    const children = [];

    const source = evidence.source;
    if (source?.available !== true) {
      children.push(blocked(
        "LIVE-DATA-SOURCE",
        "LIVE_DATA_SOURCE_TOOL_BLOCKER_UNAVAILABLE",
        "Ekstern kilde er utilgjengelig; ingen produktfeil utledes."
      ));
    } else if (source.httpStatus !== 200 ||
      !/^application\/json\b/i.test(String(source.contentType || "")) ||
      !isFreshTimestamp(source.observedAt, now)) {
      children.push(blocked(
        "LIVE-DATA-SOURCE",
        "LIVE_DATA_SOURCE_EVIDENCE_STALE_OR_UNUSABLE",
        "Ekstern kilde mangler fersk, brukbar JSON-observasjon."
      ));
    } else {
      const sourceMismatches = [];
      const generatedSource = runtime.provenance?.source || {};
      if (source.rawStationSha256 !== generatedSource.rawStationSha256) sourceMismatches.push("rawStationSha256");
      if (source.vehicleSha256 !== generatedSource.vehicleSha256) sourceMismatches.push("vehicleSha256");
      if (source.snapshotStable !== true || generatedSource.snapshotStable !== true) sourceMismatches.push("snapshotStable");
      children.push(child(
        "LIVE-DATA-SOURCE",
        sourceMismatches.length ? "RED" : "GREEN",
        sourceMismatches.length ? "LIVE_DATA_SOURCE_GENERATION_BINDING_MISMATCH" : "LIVE_DATA_SOURCE_OBSERVED_AND_BOUND",
        sourceMismatches.length
          ? `Ekstern kilde motsier genereringsproveniens: ${sourceMismatches.join(", ")}.`
          : "Ekstern kilde er ferskt observert og SHA-256-bundet til genereringsproveniens.",
        { observedAt: source.observedAt, sourceMismatches }
      ));
    }

    const dateMismatches = ["idag", "imorgen"].filter((mode) => runtime.datasets[mode].date !== expected[mode]);
    children.push(child(
      "LIVE-DATA-OPERATIVE-DATES",
      dateMismatches.length ? "RED" : "GREEN",
      dateMismatches.length ? "LIVE_DATA_OPERATIVE_DATE_MISMATCH" : "LIVE_DATA_OPERATIVE_DATES_VERIFIED",
      dateMismatches.length
        ? `Faktisk dato avviker i ${dateMismatches.join(", ")}; forventet idag=${expected.idag}, imorgen=${expected.imorgen}, vindu=${expected.window}.`
        : `Operativ datokontrakt er oppfylt for ${expected.window}.`,
      {
        timeZone: "Europe/Oslo",
        window: expected.window,
        expected: { idag: expected.idag, imorgen: expected.imorgen },
        actual: { idag: runtime.datasets.idag.date, imorgen: runtime.datasets.imorgen.date }
      }
    ));

    const codeProblems = [];
    if (runtime.branch !== "main") codeProblems.push(`runtime branch=${runtime.branch}`);
    if (runtime.dirty.length) codeProblems.push("runtime worktree er urent");
    if (runtime.operations.length) codeProblems.push(`aktive Git-operasjoner=${runtime.operations.join(",")}`);
    if (!runtime.onMainLine) codeProblems.push("APPROVED_CODE_SHA ligger ikke på autorisert main-linje");
    if (!runtime.approvedTreeMatches) codeProblems.push("APPROVED_CODE_TREE matcher ikke faktisk commit-tree");
    if (!runtime.runtimeDescendant) codeProblems.push("RUNTIME_HEAD er ikke descendant av APPROVED_CODE_SHA");
    if (!runtime.descendant.valid) codeProblems.push(...runtime.descendant.violations);
    children.push(child(
      "LIVE-DATA-CODE-IDENTITY",
      codeProblems.length ? "RED" : "GREEN",
      codeProblems.length ? "LIVE_DATA_RUNTIME_IDENTITY_INVALID" : "LIVE_DATA_RUNTIME_IDENTITY_VERIFIED",
      codeProblems.length
        ? codeProblems.join("; ")
        : runtime.head === options.approvedSha
          ? "Runtime main er ren og eksakt APPROVED_CODE_SHA/tree."
          : "Runtime main er ren og en verifisert tre-fil data-only-descendant.",
      {
        approvedSha: options.approvedSha,
        approvedTree: options.approvedTree,
        runtimeBranch: runtime.branch,
        runtimeHead: runtime.head,
        runtimeTree: runtime.tree,
        commits: runtime.descendant.commits,
        changedFiles: runtime.descendant.changedFiles,
        codeProblems
      }
    ));

    const scheduler = evidence.scheduler;
    const schedulerMissing = !scheduler || [
      "checkedAt", "processHealthy", "intervalObserved", "attemptedAfterDeploy", "exitCode", "blocker"
    ].some((key) => !Object.hasOwn(scheduler || {}, key));
    const schedulerHealthy = !schedulerMissing && scheduler.processHealthy === true &&
      scheduler.intervalObserved === true && scheduler.attemptedAfterDeploy === true &&
      scheduler.exitCode === 0 && scheduler.blocker == null &&
      isFreshTimestamp(scheduler.checkedAt, now) && new Date(scheduler.checkedAt) >= deployedAt;
    children.push(schedulerMissing
      ? blocked("SCHEDULER_HEALTH", "SCHEDULER_HEALTH_EVIDENCE_MISSING", "Scheduler-evidens er ufullstendig.")
      : child(
        "SCHEDULER_HEALTH",
        schedulerHealthy ? "GREEN" : "RED",
        schedulerHealthy ? "SCHEDULER_HEALTH_VERIFIED" : "SCHEDULER_HEALTH_FAILURE",
        schedulerHealthy ? "Prosess, intervall, post-deploy-forsøk og exitstatus er verifisert." : "Scheduler/prosess har et konkret avvik.",
        scheduler
      ));

    const readiness = evidence.applyReadiness;
    const readinessMissing = !readiness || [
      "branchGuardPassed", "historyCompared", "dataOnlyCandidateEvaluated"
    ].some((key) => !Object.hasOwn(readiness || {}, key));
    const readinessGreen = !readinessMissing && readiness.branchGuardPassed === true &&
      readiness.historyCompared === true && readiness.dataOnlyCandidateEvaluated === true &&
      runtime.branch === "main" && runtime.onMainLine;
    children.push(readinessMissing
      ? blocked("DATA_APPLY_READINESS", "DATA_APPLY_READINESS_EVIDENCE_MISSING", "Apply-readiness-evidens er ufullstendig.")
      : child(
        "DATA_APPLY_READINESS",
        readinessGreen ? "GREEN" : "RED",
        readinessGreen ? "DATA_APPLY_READINESS_VERIFIED" : "DATA_APPLY_READINESS_FAILURE",
        readinessGreen ? "Main-guard, historikksammenligning og data-only-vurdering er klare." : "Runtime kunne ikke bevise at en legitim data-only-commit kan vurderes.",
        readiness
      ));

    const sync = evidence.actualSync;
    if (!sync || typeof sync !== "object") {
      children.push(blocked("ACTUAL_SYNC_APPLIED", "ACTUAL_SYNC_EVIDENCE_MISSING", "Actual-sync-evidens mangler."));
    } else if (sync.state === "up_to_date") {
      children.push(blocked(
        "ACTUAL_SYNC_APPLIED",
        "ACTUAL_SYNC_NOT_OBSERVED",
        "up_to_date beviser ikke at en ny data-only-commit faktisk ble anvendt.",
        sync
      ));
    } else {
      const changedFilesMatch = JSON.stringify([...(sync.changedFiles || [])].sort()) ===
        JSON.stringify(runtime.descendant.changedFiles);
      const actualSyncGreen = sync.state === "synced" && runtime.head !== options.approvedSha &&
        sync.previousHead === options.approvedSha && sync.detectedHead === runtime.head &&
        sync.headMoved === true && sync.commitsClassified === true &&
        sync.servedBytesMatch === true && sync.codeAssetsIdentical === true && changedFilesMatch &&
        runtime.descendant.valid;
      children.push(child(
        "ACTUAL_SYNC_APPLIED",
        actualSyncGreen ? "GREEN" : "RED",
        actualSyncGreen ? "ACTUAL_SYNC_DATA_ONLY_APPLIED" : "ACTUAL_SYNC_CONTRADICTION",
        actualSyncGreen
          ? "Ny data-only-descendant ble oppdaget, klassifisert, anvendt og servert med uendret kode/assets."
          : "Påstått actual sync er ikke bundet til faktisk HEAD-flytting, klassifiserte commits og servert byteidentitet.",
        { ...sync, changedFilesMatch }
      ));
    }

    children.push(readbackGate(
      "PRIVATE_ORIGIN_READBACK",
      evidence.privateReadback,
      runtime.datasets,
      { now }
    ));
    children.push(readbackGate(
      "PUBLIC_AUTHENTICATED_READBACK",
      evidence.publicReadback,
      runtime.datasets,
      { publicRoute: true, now }
    ));

    const ui = evidence.ui;
    if (!ui || ui.available !== true || !isFreshTimestamp(ui.observedAt, now)) {
      children.push(blocked(
        "ACTUAL_UI_FRESHNESS",
        ui?.available === true
          ? "ACTUAL_UI_FRESHNESS_EVIDENCE_STALE"
          : "ACTUAL_UI_FRESHNESS_TOOL_BLOCKER_UNAVAILABLE",
        ui?.available === true
          ? "Nettleserens operative visning mangler fersk tidsbundet observasjon."
          : "Nettleserens faktiske operative visning kunne ikke observeres."
      ));
    } else {
      const uiProblems = [];
      if (ui.displayedDates?.idag !== expected.idag) uiProblems.push("idag-dato");
      if (ui.displayedDates?.imorgen !== expected.imorgen) uiProblems.push("imorgen-dato");
      if (!Array.isArray(ui.warnings)) uiProblems.push("warning-state mangler");
      else if (ui.warnings.length) uiProblems.push(`warnings=${ui.warnings.join(" | ")}`);
      children.push(child(
        "ACTUAL_UI_FRESHNESS",
        uiProblems.length ? "RED" : "GREEN",
        uiProblems.length ? "ACTUAL_UI_FRESHNESS_MISMATCH" : "ACTUAL_UI_FRESHNESS_VERIFIED",
        uiProblems.length
          ? `Brukerflaten motsier operativ kontrakt: ${uiProblems.join(", ")}.`
          : "Faktisk DOM-dato og warning-state matcher den operative kontrakten.",
        { displayedDates: ui.displayedDates, warnings: ui.warnings }
      ));
    }

    children.push(provenanceGate(runtime, evidence));
    const freshObserved = evidence.evidenceClass === "FRESH_OBSERVED";
    children.push(child(
      "LIVE-DATA-EVIDENCE-PRIORITY",
      freshObserved ? "GREEN" : "BLOCKED",
      freshObserved ? "LIVE_DATA_FRESH_EVIDENCE_PRIORITY_ENFORCED" : "LIVE_DATA_FRESH_OBSERVATION_REQUIRED",
      freshObserved
        ? "FRESH_OBSERVED evalueres foran gjenbrukt, manuell og historisk evidens."
        : `${evidence.evidenceClass} kan ikke alene lukke kritiske ferskhets- og readbackkrav.`,
      { evidenceClass: evidence.evidenceClass, priority: PRIORITY[evidence.evidenceClass] }
    ));
    children.push(child(
      "LIVE-DATA-NO-MUTATION",
      evidence.actionsAttempted.length ? "RED" : "GREEN",
      evidence.actionsAttempted.length ? "LIVE_DATA_QE_MUTATION_ATTEMPT" : "LIVE_DATA_QE_READ_ONLY_VERIFIED",
      evidence.actionsAttempted.length
        ? `Testemaskinen forsøkte forbudt reparasjon: ${evidence.actionsAttempted.join(", ")}.`
        : "Quality Engine observerte og klassifiserte uten produkt- eller dataendring.",
      { actionsAttempted: evidence.actionsAttempted }
    ));

    return aggregate(children, context);
  } catch (error) {
    if (error instanceof EvidenceError && /DESCENDANT_NOT_DATA_ONLY/.test(error.reasonCode)) {
      error.status = "RED";
    }
    return evidenceErrorGate(error, context);
  }
}

function readEvidenceFile(inputPath) {
  const file = path.resolve(inputPath);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (_error) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_MISSING", "Eksplisitt live-data-evidens finnes ikke.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_UNSAFE_PATH", "Live-data-evidens må være en ordinær, avgrenset JSON-fil.");
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    throw new EvidenceError("LIVE_DATA_EVIDENCE_MALFORMED", "Live-data-evidens er ikke gyldig JSON.");
  }
  const secret = findSecret(parsed);
  if (secret) {
    throw new EvidenceError(
      "LIVE_DATA_SECRET_FOUND",
      `Live-data-evidens inneholder forbudt hemmelighetskategori ${secret.category}; value=[REDACTED].`,
      "RED"
    );
  }
  return { file, parsed };
}

function liveDataContinuityGate(options = {}) {
  const inputPaths = options.inputPaths || (options.inputPath ? [options.inputPath] : []);
  if (inputPaths.length !== 1) {
    const reason = inputPaths.length
      ? "Nøyaktig én eksplisitt live-data-evidenspakke må oppgis."
      : "Eksplisitt live-data-evidens er ikke oppgitt.";
    return evidenceErrorGate(new EvidenceError("LIVE_DATA_EVIDENCE_MISSING", reason), {
      approvedSha: options.approvedSha,
      approvedTree: options.approvedTree
    });
  }
  try {
    const loaded = readEvidenceFile(inputPaths[0]);
    return evaluateLiveDataContinuity({
      ...options,
      evidence: loaded.parsed,
      evidencePath: loaded.file
    });
  } catch (error) {
    return evidenceErrorGate(error, {
      approvedSha: options.approvedSha,
      approvedTree: options.approvedTree,
      evidencePath: inputPaths[0]
    });
  }
}

module.exports = {
  GATE_VERSION,
  PRIORITY,
  PRODUCER_ID,
  PRODUCER_VERSION,
  SCHEMA_VERSION,
  bindLiveDataEvidence,
  evidencePayloadSha256,
  evaluateLiveDataContinuity,
  expectedLiveDataDates,
  inspectDataOnlyCommits,
  liveDataContinuityGate,
  readEvidenceFile
};

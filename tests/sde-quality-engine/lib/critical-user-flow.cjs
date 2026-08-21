"use strict";

const { result } = require("./core.cjs");

const GATE_IDS = Object.freeze([
  "CORE-UI-MODULE-ISOLATION",
  "TURSATT-RENDER-E2E",
  "HTR-ASSET-DELIVERY",
  "HTR-WORKER-INITIALIZATION",
  "HTR-SYNTHETIC-IMPORT-E2E"
]);

const REQUIRED = Object.freeze({
  coreUi: [
    "healthGreen", "htrLazyAtBoot", "htrLazyAfterSelection", "mainMenuVisible", "sporplanVisible", "tursattSurvivesHtrFailure",
    "globalBlankPage", "unhandledRejection", "manualPlanAvailable"
  ],
  tursatt: [
    "viewModelRowCount", "domHeaderCellCount", "expectedHeaderCellCount", "domRowCount",
    "fixtureValuesMatch", "filterTextVisible", "desktopGreen", "mobile390Green", "webkitGreen"
  ],
  asset: [
    "sourceResource", "httpStatus", "contentType", "expectedContentType", "expectedBytes",
    "receivedBytes", "expectedSha256", "receivedSha256", "htmlFallback", "downloadComplete",
    "timeout", "abort", "retryCount"
  ],
  worker: ["runtimeState", "workerState", "modelSessionState", "controlledFailure"],
  syntheticImport: [
    "fileSelected", "imageDecoded", "inferenceComplete", "formMappingState",
    "productionWrites", "userDataUsed"
  ]
});

const FIELD_TYPES = Object.freeze({
  coreUi: Object.fromEntries(REQUIRED.coreUi.map((field) => [field, "boolean"])),
  tursatt: {
    viewModelRowCount: "integer",
    domHeaderCellCount: "integer",
    expectedHeaderCellCount: "integer",
    domRowCount: "integer",
    fixtureValuesMatch: "boolean",
    filterTextVisible: "boolean",
    desktopGreen: "boolean",
    mobile390Green: "boolean",
    webkitGreen: "boolean"
  },
  asset: {
    sourceResource: "string",
    httpStatus: "integer",
    contentType: "string",
    expectedContentType: "string",
    expectedBytes: "integer",
    receivedBytes: "integer",
    expectedSha256: "sha256",
    receivedSha256: "sha256",
    htmlFallback: "boolean",
    downloadComplete: "boolean",
    timeout: "boolean",
    abort: "boolean",
    retryCount: "integer"
  },
  worker: Object.fromEntries(REQUIRED.worker.map((field) => [field, field === "controlledFailure" ? "boolean" : "string"])),
  syntheticImport: {
    fileSelected: "boolean",
    imageDecoded: "boolean",
    inferenceComplete: "boolean",
    formMappingState: "string",
    productionWrites: "integer",
    userDataUsed: "boolean"
  }
});

function matchesType(value, type) {
  if (type === "integer") return Number.isInteger(value) && value >= 0;
  if (type === "sha256") return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  return typeof value === type;
}

function deepMerge(base, changes) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return changes;
  const output = base && typeof base === "object" && !Array.isArray(base)
    ? structuredClone(base)
    : {};
  for (const [key, value] of Object.entries(changes)) {
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? deepMerge(output[key], value)
      : structuredClone(value);
  }
  return output;
}

function applyEvidenceMutations(base, mutations) {
  return deepMerge(base, mutations);
}

function validateCriticalUserFlowEvidence(evidence) {
  const problems = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["evidence must be an object"];
  }
  if (evidence.schemaVersion !== "sde-critical-user-flow/v1") {
    problems.push("schemaVersion must be sde-critical-user-flow/v1");
  }
  if (typeof evidence.scenarioId !== "string" || !evidence.scenarioId.trim()) {
    problems.push("scenarioId must be a non-empty string");
  }
  for (const key of Object.keys(evidence)) {
    if (!["schemaVersion", "scenarioId", "observations"].includes(key)) {
      problems.push(`${key} is not allowed`);
    }
  }
  if (!evidence.observations || typeof evidence.observations !== "object") {
    problems.push("observations must be an object");
    return problems;
  }
  for (const key of Object.keys(evidence.observations)) {
    if (!Object.hasOwn(REQUIRED, key)) problems.push(`observations.${key} is not allowed`);
  }
  for (const [section, fields] of Object.entries(REQUIRED)) {
    const value = evidence.observations[section];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`observations.${section} must be an object`);
      continue;
    }
    for (const field of Object.keys(value)) {
      if (!fields.includes(field)) problems.push(`observations.${section}.${field} is not allowed`);
    }
    for (const field of fields) {
      if (!Object.hasOwn(value, field)) {
        problems.push(`observations.${section}.${field} is required`);
      } else if (!matchesType(value[field], FIELD_TYPES[section][field])) {
        problems.push(`observations.${section}.${field} must be ${FIELD_TYPES[section][field]}`);
      }
    }
  }
  return problems;
}

function finding(evidence, gateId, testId, moduleName, phase, observed, expected, consequence) {
  const { asset = {}, worker = {}, tursatt = {}, coreUi = {} } = evidence.observations || {};
  return {
    findingId: `${gateId}-${String(evidence.scenarioId || "INVALID").toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`,
    gateId,
    testId,
    module: moduleName,
    phase,
    sourceResource: asset.sourceResource || "index.html",
    sourceSlotOrComponent: moduleName,
    observed,
    expected,
    firstCausalLine: `tests/sde-quality-engine/lib/critical-user-flow.cjs:${gateId}`,
    firstSafeDivergence: phase,
    httpStatus: asset.httpStatus ?? null,
    contentType: asset.contentType ?? null,
    expectedBytes: asset.expectedBytes ?? null,
    receivedBytes: asset.receivedBytes ?? null,
    expectedSha256: asset.expectedSha256 ?? null,
    receivedSha256: asset.receivedSha256 ?? null,
    workerState: worker.workerState ?? null,
    viewModelRowCount: tursatt.viewModelRowCount ?? null,
    domHeaderCellCount: tursatt.domHeaderCellCount ?? null,
    domRowCount: tursatt.domRowCount ?? null,
    consoleError: coreUi.unhandledRejection ? "unhandledrejection" : null,
    operationalConsequence: consequence,
    candidateRelation: "CANDIDATE_REPRODUCED",
    rootCauseStatus: "CONFIRMED",
    fullLogPath: "tests/sde-quality-engine/reports/critical-user-flow-black-box.json",
    fullLogSha256: null
  };
}

function gate({ id, area, name, ok, evidence, testId, moduleName, phase, observed, expected, consequence, details = {} }) {
  const findings = ok ? [] : [finding(
    evidence, id, testId, moduleName, phase, observed, expected, consequence
  )];
  return result({
    id,
    contractId: id,
    area,
    name,
    status: ok ? "GREEN" : "RED",
    critical: true,
    summary: ok ? `${name} er bevist med fersk, strukturert evidens.` : consequence,
    evidence: [
      `scenario:${evidence.scenarioId}`,
      "tests/sde-quality-engine/contracts/sde-critical-user-flow-v1.schema.json"
    ],
    details: { ...details, findings }
  });
}

function evaluateCriticalUserFlow(evidence) {
  const problems = validateCriticalUserFlowEvidence(evidence);
  if (problems.length) {
    throw new Error(`Invalid critical-user-flow evidence: ${problems.join("; ")}`);
  }
  const { coreUi, tursatt, asset, worker, syntheticImport } = evidence.observations;

  const coreOk = coreUi.healthGreen && coreUi.htrLazyAtBoot && coreUi.htrLazyAfterSelection &&
    coreUi.mainMenuVisible && coreUi.sporplanVisible &&
    coreUi.tursattSurvivesHtrFailure && !coreUi.globalBlankPage &&
    !coreUi.unhandledRejection && coreUi.manualPlanAvailable;
  const tursattOk = tursatt.viewModelRowCount > 0 &&
    tursatt.expectedHeaderCellCount > 0 &&
    tursatt.domHeaderCellCount === tursatt.expectedHeaderCellCount &&
    tursatt.domRowCount === tursatt.viewModelRowCount &&
    tursatt.fixtureValuesMatch && tursatt.filterTextVisible && tursatt.desktopGreen &&
    tursatt.mobile390Green && tursatt.webkitGreen;
  const assetOk = asset.httpStatus === 200 &&
    String(asset.contentType).toLowerCase().startsWith(String(asset.expectedContentType).toLowerCase()) &&
    asset.expectedBytes > 0 && asset.receivedBytes === asset.expectedBytes &&
    asset.receivedSha256 === asset.expectedSha256 &&
    !asset.htmlFallback && asset.downloadComplete && !asset.timeout && !asset.abort &&
    Number.isInteger(asset.retryCount) && asset.retryCount >= 0 && asset.retryCount <= 1;
  const workerOk = worker.runtimeState === "READY" && worker.workerState === "READY" &&
    worker.modelSessionState === "READY" && !worker.controlledFailure;
  const importOk = syntheticImport.fileSelected && syntheticImport.imageDecoded &&
    syntheticImport.inferenceComplete &&
    ["FORM_MAPPING_COMPLETE", "FORM_MAPPING_REQUIRES_REVIEW"].includes(syntheticImport.formMappingState) &&
    syntheticImport.productionWrites === 0 && !syntheticImport.userDataUsed;

  const results = [
    gate({
      id: "CORE-UI-MODULE-ISOLATION",
      area: "critical-user-flow",
      name: "Core UI tåler isolert HTR-feil",
      ok: coreOk,
      evidence,
      testId: "CUF-CORE-001",
      moduleName: "core-ui",
      phase: "HTR_FAILURE_ISOLATION",
      observed: JSON.stringify(coreUi),
      expected: "Core starter uten HTR; hovedmeny, Sporplan, Tursatt og manuell plan forblir tilgjengelige uten unhandled rejection.",
      consequence: "HTR-feil kan blanke eller blokkere en annen kritisk SDE-modul.",
      details: { ...coreUi }
    }),
    gate({
      id: "TURSATT-RENDER-E2E",
      area: "critical-user-flow",
      name: "Tursatt materialiserer view-model i DOM",
      ok: tursattOk,
      evidence,
      testId: "CUF-TURSATT-001",
      moduleName: "tursatt",
      phase: "DOM_MATERIALIZATION",
      observed: `viewModel=${tursatt.viewModelRowCount}, headers=${tursatt.domHeaderCellCount}, rows=${tursatt.domRowCount}`,
      expected: `headers=${tursatt.expectedHeaderCellCount}, rows=${tursatt.viewModelRowCount}, fixture values and desktop/mobile/WebKit GREEN`,
      consequence: "Tursatt har gyldig datagrunnlag, men ingen komplett brukerrettet tabell vises.",
      details: { ...tursatt }
    }),
    gate({
      id: "HTR-ASSET-DELIVERY",
      area: "critical-user-flow",
      name: "HTR-modellasset leveres komplett og hashverifisert",
      ok: assetOk,
      evidence,
      testId: "CUF-ASSET-001",
      moduleName: "htr-asset",
      phase: "MODEL_ASSET_HASH_VERIFY",
      observed: `status=${asset.httpStatus}, type=${asset.contentType}, bytes=${asset.receivedBytes}, sha=${asset.receivedSha256}`,
      expected: `status=200, type=${asset.expectedContentType}, bytes=${asset.expectedBytes}, sha=${asset.expectedSha256}, retry<=1`,
      consequence: `HTR-modellen mottok ${asset.receivedBytes} av ${asset.expectedBytes} bytes eller brøt type/hash/timeout-kontrakten og kan ikke initialiseres.`,
      details: { ...asset }
    }),
    gate({
      id: "HTR-WORKER-INITIALIZATION",
      area: "critical-user-flow",
      name: "HTR-runtime, worker og modellsesjon blir READY",
      ok: workerOk,
      evidence,
      testId: "CUF-WORKER-001",
      moduleName: "htr-worker",
      phase: "MODEL_SESSION_CREATE",
      observed: JSON.stringify(worker),
      expected: "runtimeState=READY, workerState=READY, modelSessionState=READY",
      consequence: "HTR-workeren eller modellsesjonen blir ikke READY; importflyten må stoppe lokalt.",
      details: { ...worker }
    }),
    gate({
      id: "HTR-SYNTHETIC-IMPORT-E2E",
      area: "critical-user-flow",
      name: "Syntetisk HTR-import fullfører uten produksjonswrite",
      ok: importOk,
      evidence,
      testId: "CUF-IMPORT-001",
      moduleName: "night-plan-import",
      phase: "FORM_MAPPING",
      observed: JSON.stringify(syntheticImport),
      expected: "Filvalg, decode, inference og form mapping fullfører med productionWrites=0 og userDataUsed=false.",
      consequence: "Den isolerte syntetiske importen fullfører ikke hele filvalg→decode→inference→mapping-kjeden.",
      details: { ...syntheticImport }
    })
  ];

  const aggregateOk = results.every((item) => item.status === "GREEN");
  results.push(result({
    id: "CRITICAL-USER-FLOW-AGGREGATE",
    contractId: "CRITICAL-USER-FLOW-AGGREGATE",
    area: "critical-user-flow",
    name: "Kritisk SDE-brukerflyt",
    status: aggregateOk ? "GREEN" : "RED",
    critical: true,
    aggregate: true,
    childGates: [...GATE_IDS],
    summary: aggregateOk
      ? "Alle fem kritiske brukerflytporter er GREEN."
      : `Kritisk brukerflyt blokkeres av: ${results.filter((item) => item.status !== "GREEN").map((item) => item.id).join(", ")}.`,
    evidence: results.map((item) => item.id),
    details: {
      childStatuses: Object.fromEntries(results.map((item) => [item.id, item.status])),
      findings: results.flatMap((item) => item.details.findings || [])
    }
  }));
  return results;
}

module.exports = {
  GATE_IDS,
  applyEvidenceMutations,
  evaluateCriticalUserFlow,
  validateCriticalUserFlowEvidence
};

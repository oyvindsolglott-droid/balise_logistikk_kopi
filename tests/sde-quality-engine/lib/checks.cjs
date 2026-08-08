"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  compactOutput,
  expectedOperationalDates,
  nowOsloParts,
  readJson,
  repoRoot,
  result,
  runCommand
} = require("./core.cjs");
const { buildInventory } = require("./inventory.cjs");
const { validateBaselineAccounting } = require("./accounting.cjs");
const { evaluateMultiuserEvidence } = require("./multiuser-evidence.cjs");
const {
  FINDING_TYPES,
  PARITY_CATEGORIES,
  THREE_WAY_CATEGORIES,
  compareRecords,
  compareThreeWay,
  evaluateFreshness,
  validateOverride
} = require("./balise-parity.cjs");

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function validateRegistry() {
  const root = repoRoot();
  const contractFile = path.join(root, "tests/sde-quality-engine/contracts/green-contract.json");
  const matrixFile = path.join(root, "tests/sde-quality-engine/matrix/function-matrix.json");
  const registry = readJson(contractFile);
  const matrix = readJson(matrixFile);
  const problems = [];
  const contractIds = registry.contracts.map((item) => item.id);
  const functionIds = matrix.functions.map((item) => item.id);
  problems.push(...duplicateValues(contractIds).map((id) => `duplikat contract ${id}`));
  problems.push(...duplicateValues(functionIds).map((id) => `duplikat function ${id}`));
  const known = new Set(contractIds);
  for (const item of registry.contracts) {
    for (const field of ["id", "area", "name", "expected"]) {
      if (!item[field]) problems.push(`${item.id || "ukjent contract"} mangler ${field}`);
    }
    if (!Array.isArray(item.evidence) || !item.evidence.length) {
      problems.push(`${item.id} mangler evidence`);
    }
  }
  for (const item of matrix.functions) {
    for (const field of ["id", "module", "name", "source", "expected"]) {
      if (!item[field]) problems.push(`${item.id || "ukjent function"} mangler ${field}`);
    }
    if (!Array.isArray(item.testTypes) || !item.testTypes.length) {
      problems.push(`${item.id} mangler testTypes`);
    }
    if (!Array.isArray(item.contracts) || !item.contracts.length) {
      problems.push(`${item.id} mangler contracts`);
    } else {
      for (const contractId of item.contracts) {
        if (!known.has(contractId)) problems.push(`${item.id} peker på ukjent ${contractId}`);
      }
    }
  }
  const covered = new Set(matrix.functions.flatMap((item) => item.contracts || []));
  for (const contract of registry.contracts) {
    if (!covered.has(contract.id)) problems.push(`${contract.id} mangler funksjonskobling`);
  }
  return result({
    id: "QE-CORE-001",
    area: "quality-engine",
    name: "Kontrakt- og matrisefiler er gyldige",
    status: problems.length ? "RED" : "GREEN",
    critical: true,
    summary: problems.length
      ? `${problems.length} kontrakt-/matriseavvik`
      : `${registry.contracts.length} kontrakter og ${matrix.functions.length} funksjoner er maskinlesbare og koblet.`,
    evidence: [path.relative(root, contractFile), path.relative(root, matrixFile)],
    details: { problems, contractCount: registry.contracts.length, functionCount: matrix.functions.length },
    recommendation: problems.length ? "Rett registeret før nye funksjoner kvalifiseres." : null
  });
}

function validateAccounting() {
  const observed = validateBaselineAccounting();
  return result({
    id: "QE-CORE-003",
    area: "quality-engine",
    name: "QE-0-statusregnskap er disjunkt og reproduserbart",
    status: observed.valid ? "GREEN" : "RED",
    critical: true,
    summary: observed.valid
      ? `${observed.fixture.blockedFunctionTotal} blokkerte QE-0-funksjoner er fordelt i disjunkte grupper på ${observed.fixture.groups.map((group) => group.ids.length).join("+")}.`
      : observed.problems.join("; "),
    evidence: ["tests/sde-quality-engine/fixtures/qe0-accounting-baseline.json"],
    details: observed,
    recommendation: observed.valid ? null : "Rett det maskinlesbare statusregnskapet før releaseklassifisering."
  });
}

function parseUpdatedAt(value) {
  const match = String(value || "").match(/^(\d{2})\.(\d{2})\.(\d{4})[ ,T]+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second] = match;
  const desiredLocal = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  let candidate = desiredLocal;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value])
    );
    const observedLocal = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    candidate += desiredLocal - observedLocal;
  }
  return Number.isFinite(candidate) ? candidate : null;
}

function loadBaliseData() {
  const root = repoRoot();
  return {
    idag: readJson(path.join(root, "data/api_idag.json")),
    imorgen: readJson(path.join(root, "data/api_imorgen.json"))
  };
}

function contexts(payload) {
  return Object.values(payload.arrivals || {})
    .map((entry) => entry && entry.movementContext)
    .filter(Boolean);
}

function baliseChecks(now = new Date(), options = {}) {
  const root = repoRoot();
  const data = options.data || loadBaliseData();
  const freshnessContract = options.contract || readJson(
    path.join(root, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json")
  );
  const expected = expectedOperationalDates(now, freshnessContract);
  const oslo = nowOsloParts(now);
  const results = [];

  results.push(result({
    id: "BALISE-001",
    area: "tursatt-balise",
    name: "Dagens payload har korrekt operativ dato",
    status: data.idag.date === expected.idag ? "GREEN" : "RED",
    critical: true,
    summary: `api_idag=${data.idag.date}, forventet=${expected.idag}, vindu=${expected.window}`,
    evidence: ["data/api_idag.json", `Europe/Oslo=${oslo.display}`],
    details: { actual: data.idag.date, expected: expected.idag, window: expected.window },
    recommendation: data.idag.date === expected.idag ? null : "Kjør eller reparer den eksisterende datageneratoren; ikke overstyr dato i QE."
  }));
  const tomorrowBoundary = expected.boundaries.imorgen;
  const tomorrowMatches = data.imorgen.date === expected.imorgen;
  const tomorrowClassification = tomorrowMatches
    ? tomorrowBoundary.withinPublicationGrace
      ? "EXPECTED_WITHIN_GRACE_WINDOW"
      : "EXPECTED_DATE_MATCH"
    : tomorrowBoundary.effectiveBoundaryReached
      ? "STALE_DATE_AFTER_EFFECTIVE_BOUNDARY"
      : "PREMATURE_DATE_TRANSITION";
  const tomorrowFindingDomain = tomorrowMatches
    ? "NONE"
    : tomorrowBoundary.effectiveBoundaryReached
      ? "PIPELINE_FINDING"
      : "TESTABILITY_FINDING";
  results.push(result({
    id: "BALISE-002",
    area: "tursatt-balise",
    name: "Morgendagens payload følger tidsvinduet",
    status: tomorrowMatches ? "GREEN" : "RED",
    critical: true,
    summary: `api_imorgen=${data.imorgen.date}, forventet=${expected.imorgen}, klassifisering=${tomorrowClassification}; lokal tid=${tomorrowBoundary.currentTimeLocal}; nominell grense=${tomorrowBoundary.nominalCycleBoundary}; første forsøk=${tomorrowBoundary.firstScheduledAttempt}; grace=${tomorrowBoundary.publicationGraceMinutes} min; effektiv grense=${tomorrowBoundary.effectiveBoundary}; gjenstår=${tomorrowBoundary.timeRemainingSeconds.toFixed(0)} s.`,
    evidence: [
      "data/api_imorgen.json",
      "tests/sde-quality-engine/fixtures/balise-freshness-contract.json",
      "update_static_data.get_operational_tursatt_dates"
    ],
    details: {
      actual: data.imorgen.date,
      expected: expected.imorgen,
      window: expected.window,
      classification: tomorrowClassification,
      findingDomain: tomorrowFindingDomain,
      confirmedSdeDefect: false,
      probableSdeDefect: false,
      contractAuthority: freshnessContract.authority,
      ...tomorrowBoundary
    },
    recommendation: tomorrowMatches
      ? null
      : tomorrowBoundary.effectiveBoundaryReached
        ? "Undersøk den tekniske publiseringspipelinen read-only; den ikke-normative kontrakten beviser ikke en SDE-produktfeil."
        : "Undersøk datovalg eller testgrunnlag; ikke klassifiser SDE som defekt."
  }));

  for (const [mode, payload] of Object.entries(data)) {
    const freshness = evaluateFreshness({
      now,
      sourceReadAt: now,
      sourceResponseDate: now.toUTCString(),
      sourceOwnTimestamp: null,
      sdeGeneratedAt: payload.updatedAt,
      serverLastUpdate: null,
      contract: freshnessContract
    });
    results.push(result({
      id: `BALISE-003-${mode.toUpperCase()}`,
      contractId: "BALISE-003",
      area: "tursatt-balise",
      name: `${mode} payload følger faktisk refreshplan`,
      status: freshness.sdeStatus === "FRESH" ? "GREEN" : "RED",
      critical: true,
      summary: freshness.sdeGeneratedAtIso == null
        ? `updatedAt kan ikke parses: ${payload.updatedAt}`
        : `updatedAt=${payload.updatedAt}; generert=${freshness.sdeGeneratedAtIso}; påkrevd grense=${freshness.requiredRefreshBoundary}; alder=${freshness.sdeAgeSeconds.toFixed(0)} s; tillatt=${freshness.allowedSdeAgeSeconds.toFixed(0)} s.`,
      evidence: [`data/api_${mode}.json`, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"],
      details: freshness,
      recommendation: freshness.sdeStatus === "FRESH" ? null : "Bekreft automatisk refresh mot faktisk Europe/Oslo-plan; ikke bruk en fast seks- eller trettitimersgrense."
    }));
  }

  for (const [mode, payload] of Object.entries(data)) {
    const movementContexts = contexts(payload);
    const occurrences = movementContexts.map((item) => item.occurrenceId).filter(Boolean);
    const duplicateOccurrences = duplicateValues(occurrences);
    const missingIdentity = movementContexts
      .filter((item) => !item.occurrenceId || !item.operationalDate || !item.trainNumber)
      .map((item) => item.occurrenceId || item.trainNumber || "ukjent");
    const wrongDate = movementContexts
      .filter((item) => item.operationalDate !== payload.date)
      .map((item) => item.occurrenceId);
    results.push(result({
      id: `BALISE-004-${mode.toUpperCase()}`,
      contractId: "BALISE-004",
      area: "tursatt-balise",
      name: `${mode} forekomstidentiteter er entydige`,
      status: duplicateOccurrences.length || missingIdentity.length || wrongDate.length ? "RED" : "GREEN",
      critical: true,
      summary: `${movementContexts.length} movement contexts; ${duplicateOccurrences.length} duplikater; ${missingIdentity.length} mangler identitet; ${wrongDate.length} feil dato.`,
      evidence: [`data/api_${mode}.json:arrivals[*].movementContext`],
      details: { duplicateOccurrences, missingIdentity, wrongDate }
    }));

    const inconsistentTrain = movementContexts.filter((item) => {
      const occurrenceTrain = String(item.occurrenceId || "").split("|")[2];
      return occurrenceTrain && occurrenceTrain !== String(item.trainNumber || "");
    });
    results.push(result({
      id: `BALISE-005-${mode.toUpperCase()}`,
      contractId: "BALISE-005",
      area: "tursatt-balise",
      name: `${mode} tognummer og materiell er forekomstbundet`,
      status: inconsistentTrain.length ? "RED" : "GREEN",
      critical: true,
      summary: `${movementContexts.length - inconsistentTrain.length}/${movementContexts.length} contexts har tognummer som samsvarer med occurrenceId.`,
      evidence: [`data/api_${mode}.json`, "test_update_static_data.py"],
      details: { inconsistent: inconsistentTrain.map((item) => item.occurrenceId) }
    }));

    const invalidConsists = movementContexts.filter((item) => {
      const ids = Array.isArray(item.vehicleIds) ? item.vehicleIds.filter(Boolean) : [];
      return ids.length > 1 && new Set(ids).size !== ids.length;
    });
    results.push(result({
      id: `BALISE-006-${mode.toUpperCase()}`,
      contractId: "BALISE-006",
      area: "tursatt-balise",
      name: `${mode} dobbeltsett har unik sammensetning`,
      status: invalidConsists.length ? "RED" : "GREEN",
      critical: true,
      summary: `${invalidConsists.length} forekomster har duplisert kjøretøy i consist.`,
      evidence: [`data/api_${mode}.json:movementContext.vehicleIds`, "test_update_static_data.py"],
      details: { invalid: invalidConsists.map((item) => item.occurrenceId) }
    }));

    const trackContexts = movementContexts.filter((item) => String(item.platformTrack || "").trim());
    const missingProvenance = trackContexts.filter((item) =>
      !item.rawTrackField || !item.rawTrackValue || !item.sourceUpdatedAt || !item.trackProvenance
    );
    results.push(result({
      id: `BALISE-007-${mode.toUpperCase()}`,
      contractId: "BALISE-007",
      area: "tursatt-balise",
      name: `${mode} plattformspor har actual provenance`,
      status: missingProvenance.length ? "RED" : trackContexts.length ? "GREEN" : "BLOCKED",
      critical: true,
      summary: `${trackContexts.length} contexts har plattformspor; ${missingProvenance.length} mangler proveniens.`,
      evidence: [`data/api_${mode}.json:movementContext.trackProvenance`],
      details: { missing: missingProvenance.map((item) => item.occurrenceId) },
      recommendation: trackContexts.length ? null : "Kilden mangler actual-spor; behold diagnostic-only fremfor å bruke plan/historikk."
    }));
  }

  const generatorSource = fs.readFileSync(path.join(root, "update_static_data.py"), "utf8");
  const generatorTests = fs.readFileSync(path.join(root, "test_update_static_data.py"), "utf8");
  const platformTests = fs.readFileSync(
    path.join(root, "tests/sde/test_balise_actual_platform.py"),
    "utf8"
  );
  const rawIsPreserved =
    /"rawTrackField"\s*:\s*"stop_track"/.test(generatorSource) &&
    /"rawTrackValue"\s*:\s*raw_track/.test(generatorSource) &&
    /"platformTrack"\s*:\s*normalize_balise_platform_track\(raw_track\)/.test(generatorSource) &&
    /trackProvenance/.test(generatorSource) &&
    /rawTrackField/.test(platformTests) &&
    /rawTrackValue/.test(platformTests) &&
    /trackProvenance/.test(platformTests);
  results.push(result({
    id: "BALISE-008",
    area: "tursatt-balise",
    name: "Overstyring skilles fra rådata",
    status: rawIsPreserved ? "GREEN" : "AMBER",
    critical: true,
    summary: rawIsPreserved
      ? "Rått stop_track, normalisert platformTrack og provenance bevares i separate felt og testes permanent."
      : "Separat råverdi, normalisert verdi og provenance kunne ikke bevises samlet.",
    evidence: ["update_static_data.py", "tests/sde/test_balise_actual_platform.py"],
    recommendation: rawIsPreserved ? null : "Legg testbar provenance til override-kontrakten uten å endre rådata."
  }));

  const boundaryFixture = readJson(path.join(root, "tests/sde-quality-engine/fixtures/balise-boundaries.json"));
  const boundaryErrors = boundaryFixture.cases.filter((item) => {
    const observed = expectedOperationalDates(new Date(item.instant));
    return observed.idag !== item.expected.idag ||
      observed.imorgen !== item.expected.imorgen ||
      observed.window !== item.expected.window;
  });
  results.push(result({
    id: "BALISE-009",
    area: "tursatt-balise",
    name: "DST- og tidsgrenser er deterministiske",
    status: boundaryErrors.length ? "RED" : "GREEN",
    critical: true,
    summary: `${boundaryFixture.cases.length - boundaryErrors.length}/${boundaryFixture.cases.length} effektive 07:27/15:27/DST-fixtures er korrekte.`,
    evidence: ["tests/sde-quality-engine/fixtures/balise-boundaries.json", "server/scripts/test_sync_production_balise_data.py"],
    details: { failures: boundaryErrors }
  }));

  const parityFixture = readJson(path.join(root, "tests/sde-quality-engine/fixtures/balise-parity-cases.json"));
  const syntheticParity = compareRecords([parityFixture.baseBalise], [parityFixture.baseSde]);
  const syntheticThreeWay = compareThreeWay({
    baliseRecords: [parityFixture.baseBalise],
    candidateRecords: [parityFixture.baseSde],
    publishedRecords: [parityFixture.baseSde],
    observedAt: now.toISOString()
  });
  const categoryContractGreen =
    JSON.stringify([...PARITY_CATEGORIES]) === JSON.stringify(parityFixture.expectedCategories) &&
    FINDING_TYPES.length === 9 &&
    THREE_WAY_CATEGORIES.length === 17 &&
    syntheticParity.counts.unauthorized_difference === 0 &&
    syntheticThreeWay.findingCount === 0 &&
    validateOverride(parityFixture.validOverride).valid;
  results.push(result({
    id: "BALISE-010-CONTRACT",
    contractId: "BALISE-010",
    area: "tursatt-balise",
    name: "Symmetrisk Balise-paritetskontrakt er komplett",
    status: categoryContractGreen ? "GREEN" : "RED",
    critical: true,
    summary: categoryContractGreen
      ? `${THREE_WAY_CATEGORIES.length} treveiskategorier, ${FINDING_TYPES.length} funntyper og full override-proveniens er permanent testet.`
      : "Paritetskategorier, syntetisk null-diff eller override-proveniens avviker.",
    evidence: [
      "tests/sde-quality-engine/lib/balise-parity.cjs",
      "tests/sde-quality-engine/fixtures/balise-parity-cases.json",
      "tests/sde-quality-engine/unit/balise-parity.test.cjs"
    ],
    details: {
      legacyCategories: [...PARITY_CATEGORIES],
      threeWayCategories: [...THREE_WAY_CATEGORIES],
      findingTypes: [...FINDING_TYPES],
      counts: syntheticParity.counts,
      threeWay: syntheticThreeWay
    }
  }));

  const liveCommand = runCommand("node", ["tests/sde-quality-engine/lib/balise-parity.cjs"], {
    timeoutMs: 3 * 60 * 1000
  });
  let live = null;
  try {
    live = JSON.parse(String(liveCommand.stdout || "").trim());
  } catch (_error) {
    live = null;
  }
  const unavailable = live?.status === "BLOCKED" || live?.threeWay?.releaseStatus === "BLOCKED";
  const liveCounts = live?.threeWay?.findingTypeCounts || {};
  const releaseStatus = live?.threeWay?.releaseStatus || null;
  const liveGreen = Boolean(live?.ok) && releaseStatus === "SDE_GREEN";
  const liveNoGo = Boolean(live?.ok) && releaseStatus === "SDE_NO_GO";
  results.push(result({
    id: "BALISE-010-LIVE",
    contractId: "BALISE-010",
    area: "tursatt-balise",
    name: "Ekte Balise, kandidat og publisert SDE er treveis klassifisert",
    status: liveGreen ? "GREEN" : unavailable ? "BLOCKED" : liveNoGo ? "RED" : "AMBER",
    critical: true,
    summary: liveGreen
      ? `${live.coverage.baliseRecords} autoritative Balise-forekomster er sammenlignet uavhengig og symmetrisk uten uautoriserte differanser.`
      : unavailable
        ? live?.publishedSnapshot?.blockedReason || live?.blockedReason || "BLOCKED – AUTHORITATIVE SOURCE UNAVAILABLE"
        : liveNoGo
          ? `SDE-kontrakten har sannsynlige eller bekreftede brudd: ${JSON.stringify(liveCounts)}.`
          : `Treveis observasjon krever videre undersøkelse: ${JSON.stringify(liveCounts)}.`,
    evidence: [
      "GET https://balise.no/api/station/SKN?content=all&passthru=true",
      "GET https://balise.no/api/train/vehicles?route=<routeId>",
      liveCommand.command,
      compactOutput(liveCommand)
    ],
    details: live || {
      command: liveCommand.command,
      exitCode: liveCommand.status,
      error: liveCommand.error
    },
    durationMs: liveCommand.durationMs,
    recommendation: liveGreen
      ? null
      : unavailable
        ? "Gjenoppta først når den uavhengige autoritative Balise-kilden kan leses; intern konsistens er ikke live paritet."
        : "Undersøk hvert sporbare funn separat. Ikke endre SDE før systemeier har vurdert kontrakt, snapshot-skew og alternative forklaringer."
  }));
  return results;
}

function staticChecks(inventory = buildInventory(), options = {}) {
  const root = repoRoot();
  const matrix = readJson(path.join(root, "tests/sde-quality-engine/matrix/function-matrix.json"));
  const requiredModules = [
    "Tursatt", "DROPS", "Sporplan", "TXP Input Sporplan", "SDE Vaktplan",
    "SDE Skiftebevegelser", "Turnering Kveld", "Turnering Natt",
    "Verksted/STADLER", "Agilia", "Direktemeldinger", "Server API", "Access/Login"
  ];
  const presentModules = new Set(matrix.functions.map((item) => item.module));
  const missingModules = requiredModules.filter((item) => !presentModules.has(item));
  const accessValues = inventory.accessLevels.map((item) => item.value).sort();
  const expectedAccess = ["0", "1", "2", "3", "4", "5"];
  const navTabs = new Set(inventory.navigation.filter((item) => !item.hidden).map((item) => item.tab));
  const requiredTabs = [
    "oppstilling", "dropsMateriellstyrer", "sporplan", "grunnoppstilling",
    "sdeVaktplan", "sdeSkiftebevegelser", "turneringKveld", "turneringNatt",
    "verkstedBestillinger", "agilia"
  ];
  const missingTabs = requiredTabs.filter((item) => !navTabs.has(item));
  const imageButtonsWithoutLabel = inventory.navigation.filter((item) =>
    /graphic/.test(item.className || "") && !item.ariaLabel && item.tab !== "oppstilling"
  );
  const writeRoutes = inventory.source.serverRoutes.filter((route) => !["GET", "HEAD"].includes(route.method));
  const readRoutes = inventory.source.serverRoutes.filter((route) => ["GET", "HEAD"].includes(route.method));
  const nightFiles = [
    "sde_intelligent_night_planning.js",
    "sde_night_planning_ui.js",
    "config/sde-night-intelligence.json",
    "models/sde/production-model.json",
    "models/sde/model-registry.json",
    "tests/sde/intelligent-night-planning.test.cjs",
    "tests/sde/test_sde_night_model.py"
  ];
  const missingNightFiles = nightFiles.filter((file) => !fs.existsSync(path.join(root, file)));
  const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const nightUiSource = fs.existsSync(path.join(root, "sde_night_planning_ui.js"))
    ? fs.readFileSync(path.join(root, "sde_night_planning_ui.js"), "utf8")
    : "";
  const nightModuleSource = fs.existsSync(path.join(root, "sde_intelligent_night_planning.js"))
    ? fs.readFileSync(path.join(root, "sde_intelligent_night_planning.js"), "utf8")
    : "";
  const nightContractProblems = [
    ...missingNightFiles.map((file) => `mangler ${file}`),
    !/data-tab="sdeNattplanErfaring"/.test(indexSource) ? "mangler nattplan-tab" : null,
    !/assets\/vendor\/tesseract\/tesseract\.min\.js/.test(indexSource) ? "mangler lokal OCR-runtime" : null,
    /https?:\/\//.test(nightUiSource) ? "UI peker på ekstern tjeneste" : null,
    /localStorage\.setItem|fetch\(/.test(nightModuleSource) ? "beslutningsmodul har write/nettverksflate" : null,
    !/absoluteGatePassed: true/.test(nightUiSource) ? "ML mangler gate-evidens" : null
  ].filter(Boolean);

  return [
    result({
      id: "ACCESS-001",
      area: "access",
      name: "Alle seks tilgangsnivåer finnes",
      status: JSON.stringify(accessValues) === JSON.stringify(expectedAccess) ? "GREEN" : "RED",
      critical: true,
      summary: `Observerte nivåer: ${accessValues.join(", ") || "ingen"}.`,
      evidence: ["index.html#accessLevelSelect"],
      details: { accessLevels: inventory.accessLevels }
    }),
    result({
      id: "NAV-001",
      area: "navigation",
      name: "Alle hovedmoduler er inventarisert",
      status: missingModules.length || missingTabs.length ? "RED" : "GREEN",
      critical: true,
      summary: `${requiredModules.length - missingModules.length}/${requiredModules.length} matriseområder og ${requiredTabs.length - missingTabs.length}/${requiredTabs.length} tabs finnes.`,
      evidence: ["function-matrix.json", "index.html[data-tab]"],
      details: { missingModules, missingTabs }
    }),
    result({
      id: "API-001",
      area: "server-api",
      name: "Server-API er inventarisert",
      status: inventory.tests.server.length >= 20 && inventory.source.serverRoutes.length > 0 ? "GREEN" : "AMBER",
      critical: true,
      summary: `${readRoutes.length} read-ruter, ${writeRoutes.length} write-ruter og ${inventory.tests.server.length} server-testfiler er funnet.`,
      evidence: ["server/src/index.js", "server/scripts/test-*.js"],
      details: { readRoutes, writeRoutes, serverTests: inventory.tests.server }
    }),
    result({
      id: "UX-002",
      area: "ux",
      name: "Grafiske menyknapper har tilgjengelig navn",
      status: imageButtonsWithoutLabel.length ? "AMBER" : "GREEN",
      critical: false,
      summary: imageButtonsWithoutLabel.length
        ? `${imageButtonsWithoutLabel.length} grafiske knapper mangler eksplisitt aria-label.`
        : "Alle inventariserte grafiske menyknapper har eksplisitt aria-label.",
      evidence: ["index.html navigation markup"],
      details: { missing: imageButtonsWithoutLabel.map((item) => item.tab) }
    }),
    result({
      id: "QE-INVENTORY-001",
      contractId: "QE-CORE-001",
      area: "quality-engine",
      name: "Kilde- og testinventar er generert",
      status: "GREEN",
      critical: false,
      summary: `${inventory.source.indexFunctionNames.length} navngitte index-funksjoner, ${inventory.tests.permanent.length} permanente testressurser og ${inventory.matrix.functions} produktfunksjoner er registrert.`,
      evidence: ["dynamic inventory"],
      details: {
        indexFunctionCount: inventory.source.indexFunctionNames.length,
        permanentTestResources: inventory.tests.permanent.length,
        pythonTests: inventory.tests.python.length,
        serverTests: inventory.tests.server.length
      }
    }),
    result({
      id: "NIGHT-INTELLIGENCE-001",
      area: "night-intelligence",
      name: "Nattintelligens er registrert med lokal OCR og read-only authority",
      status: nightContractProblems.length ? "RED" : "GREEN",
      critical: true,
      summary: nightContractProblems.length
        ? nightContractProblems.join("; ")
        : "Canonical nattplan, lokal OCR, erfaring, modellartifact og gate-evidens er eksplisitt registrert uten nettverks- eller writeflate i beslutningsmodulen.",
      evidence: nightFiles,
      details: {problems: nightContractProblems}
    }),
    evaluateMultiuserEvidence({
      inputPaths: options.multiuserEvidencePaths,
      approvedSha: options.multiuserApprovedSha,
      approvedTree: options.multiuserApprovedTree,
      subjectRepository: options.multiuserSubjectRepository,
      now: options.now
    }),
    result({
      id: "UX-LIVE-001",
      contractId: "UX-001",
      area: "ux",
      name: "Autentisert visuell desktop/390-px fullmatrise",
      status: "BLOCKED",
      critical: false,
      summary: "Statisk og harness-basert dekning finnes, men en fersk autentisert produksjonsmatrise inngår ikke i standardmotoren.",
      evidence: ["existing browser harnesses", "production method guard"],
      recommendation: "Kjør separat autentisert read-only browserjobb med skjermbilder og console/network-ledger."
    })
  ];
}

function externalResult(id, contractId, area, name, commandResult, critical = true, options = {}) {
  const output = compactOutput(commandResult);
  const blocked = Boolean(
    commandResult.error && /ENOENT|not found/i.test(commandResult.error)
  ) || Boolean(options.blockedPattern?.test(output));
  return result({
    id,
    contractId,
    area,
    name,
    status: commandResult.ok ? "GREEN" : blocked ? "BLOCKED" : "RED",
    critical,
    summary: commandResult.ok
      ? `Kommando fullførte på ${(commandResult.durationMs / 1000).toFixed(2)} s.`
      : blocked
        ? `BLOCKED – MANGLER TESTBARHET: ${options.blockedSummary || "kommandoen kan ikke kjøres i dette miljøet."}`
        : `Kommando feilet med status ${commandResult.status ?? "ukjent"}${commandResult.signal ? `, signal ${commandResult.signal}` : ""}.`,
    evidence: [commandResult.command, output],
    details: {
      command: commandResult.command,
      exitCode: commandResult.status,
      signal: commandResult.signal,
      error: commandResult.error
    },
    durationMs: commandResult.durationMs,
    recommendation: commandResult.ok
      ? null
      : blocked
        ? options.blockedRecommendation || "Etabler en sikker, eksplisitt testbarhet uten å svekke produksjonsvakten."
        : "Reproduser kommandoen isolert og rett årsaken uten å svekke testen."
  });
}

function runPythonSuite() {
  const command = runCommand("python3", [
    "-m", "unittest", "-v",
    "test_update_static_data.py",
    "test_sde_schedule_observability.py",
    "tests/sde/test_balise_actual_platform.py",
    "server/scripts/test_sync_production_balise_data.py"
  ], { timeoutMs: 12 * 60 * 1000 });
  return externalResult(
    "QE-PYTHON-001",
    "BALISE-009",
    "tursatt-balise",
    "Generator-, Balise- og sync-regresjoner",
    command
  );
}

function qualificationTimeoutMs(env = process.env) {
  const configured = Number(env.SDE_QE_QUALIFICATION_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 45 * 60 * 1000;
}

function qualificationNodePath(root = repoRoot(), env = process.env) {
  return [...new Set([
    path.join(root, "server", "node_modules"),
    ...String(env.NODE_PATH || "").split(path.delimiter).filter(Boolean)
  ])].join(path.delimiter);
}

function runRegressionSuite() {
  const root = repoRoot();
  const command = runCommand("npm", ["run", "test:sde:qualification"], {
    env: { NODE_PATH: qualificationNodePath(root) },
    timeoutMs: qualificationTimeoutMs()
  });
  return externalResult(
    "QE-REGRESSION-001",
    "SDE-001",
    "regression",
    "Permanent SDE qualification",
    command
  );
}

function runStrictSuite() {
  const command = runCommand("npm", ["run", "test:sde:strict"], { timeoutMs: 20 * 60 * 1000 });
  return externalResult(
    "QE-STRICT-001",
    "SDE-001",
    "regression",
    "Permanent strict firewall",
    command
  );
}

function runUnitSuite() {
  const command = runCommand("npm", ["run", "test:sde:qe:unit"], { timeoutMs: 2 * 60 * 1000 });
  return externalResult(
    "QE-UNIT-001",
    "QE-CORE-001",
    "quality-engine",
    "Quality Engine unit tests",
    command
  );
}

function serverScriptArgument(root, file) {
  const serverRoot = path.join(root, "server");
  const absoluteFile = path.resolve(root, file);
  const relativeFile = path.relative(serverRoot, absoluteFile);
  if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) {
    throw new Error(`Server-test ligger utenfor server/: ${file}`);
  }
  return relativeFile;
}

function runServerSuite(inventory = buildInventory()) {
  const root = repoRoot();
  const serverRoot = path.join(root, "server");
  const localNodePath = path.join(serverRoot, "node_modules");
  const nodePath = process.env.SDE_QE_SERVER_NODE_PATH || localNodePath;
  const scripts = inventory.tests.server.filter((file) => file.endsWith(".js"));
  if (!fs.existsSync(nodePath)) {
    return scripts.map((file) => result({
      id: `QE-SERVER-${path.basename(file).replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toUpperCase()}`,
      contractId: "API-001",
      area: "server-api",
      name: `Serverkontrakt ${path.basename(file)}`,
      status: "BLOCKED",
      critical: true,
      summary: "BLOCKED – MANGLER TESTBARHET: serveravhengigheter er ikke installert.",
      evidence: [path.relative(root, path.join(serverRoot, "package-lock.json"))],
      recommendation: "Kjør npm ci --prefix server før full Quality Engine-kjøring."
    }));
  }
  return scripts.map((file) => {
    const basename = path.basename(file);
    let contractId = "API-001";
    if (/access|auth|identity|authorization|policy/.test(basename)) contractId = "ACCESS-002";
    else if (/shared-sporplan/.test(basename)) contractId = "STATE-001";
    else if (/operational-state/.test(basename)) contractId = "STATE-002";
    else if (/workshop/.test(basename)) contractId = "WORKSHOP-001";
    else if (/server-note/.test(basename)) contractId = "MSG-001";
    else if (/vehicle-status-contract/.test(basename)) contractId = "STATUS-001";
    else if (/vehicle-status|catalog-parity/.test(basename)) contractId = "STATUS-002";
    else if (/recommendation-ack/.test(basename)) contractId = "SDE-004";
    const command = runCommand("node", [serverScriptArgument(root, file)], {
      cwd: serverRoot,
      env: { NODE_PATH: nodePath },
      timeoutMs: 3 * 60 * 1000
    });
    return externalResult(
      `QE-SERVER-${path.basename(file).replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toUpperCase()}`,
      contractId,
      "server-api",
      `Serverkontrakt ${path.basename(file)}`,
      command,
      true
    );
  });
}

function mapFunctionStatuses(matrix, results) {
  const byContract = new Map();
  for (const item of results) {
    if (!byContract.has(item.contractId)) byContract.set(item.contractId, []);
    byContract.get(item.contractId).push(item);
  }
  return matrix.functions.map((item) => {
    const evidence = item.contracts.flatMap((contractId) => byContract.get(contractId) || []);
    const missingContracts = item.contracts.filter((contractId) => !byContract.has(contractId));
    let status = "UNKNOWN";
    if (evidence.length) {
      if (evidence.some((entry) => entry.status === "RED")) status = "RED";
      else if (evidence.some((entry) => entry.status === "BLOCKED")) status = "BLOCKED";
      else if (missingContracts.length || evidence.some((entry) => entry.status === "UNKNOWN")) status = "UNKNOWN";
      else if (evidence.some((entry) => entry.status === "AMBER")) status = "AMBER";
      else status = "GREEN";
    }
    return {
      ...item,
      status,
      missingContracts,
      evidenceIds: evidence.map((entry) => entry.id)
    };
  });
}

module.exports = {
  baliseChecks,
  externalResult,
  loadBaliseData,
  mapFunctionStatuses,
  parseUpdatedAt,
  qualificationNodePath,
  qualificationTimeoutMs,
  runPythonSuite,
  runRegressionSuite,
  serverScriptArgument,
  runServerSuite,
  runStrictSuite,
  runUnitSuite,
  staticChecks,
  validateAccounting,
  validateRegistry
};

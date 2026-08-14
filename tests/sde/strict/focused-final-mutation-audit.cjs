"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const generatorSource = fs.readFileSync(path.join(root, "update_static_data.py"), "utf8");
const targetHarness = path.join(root, "tests/sde/harnesses/sde-blocked-target-three-card-harness.js");
const emptyDropHarness = path.join(root, "tests/sde/harnesses/sde-empty-target-drag-intent-harness.js");
const egressHarness = path.join(root, "tests/sde/harnesses/sde-trapped-egress-chain-harness.js");
const vnReliefHarness = path.join(root, "tests/sde/strict/vn-relief-invariants.cjs");
const suffixPersistenceHarness = path.join(root, "tests/sde/strict/suffix-persistence-invariants.cjs");
const menuHarness = path.join(root, "tests/sde/harnesses/sde-menu-access-layout-harness.js");
const baliseHarness = path.join(root, "tests/sde/harnesses/sde-24xx-focused-mutation-harness.py");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-final-focused-mutations-"));

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`${label}: mutation anchor not found`);
  if (source.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function mutateFunction(source, name, before, after, label) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${label}: function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 10);
  const end = next < 0 ? source.length : next;
  const body = source.slice(start, end);
  const mutated = replaceOnce(body, before, after, label);
  return source.slice(0, start) + mutated + source.slice(end);
}

function run(command, args) {
  return childProcess.spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseReport(runResult, schemaVersion, label) {
  if (runResult.error) throw new Error(`${label}: infrastructure error: ${runResult.error.message}`);
  if (runResult.signal) throw new Error(`${label}: terminated by ${runResult.signal}`);
  if (![0, 1].includes(runResult.status)) throw new Error(`${label}: unexpected exit ${runResult.status}`);
  const line = String(runResult.stdout || "").trim().split(/\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(`${label}: missing structured report`);
  const report = JSON.parse(line);
  if (report?.schemaVersion !== schemaVersion) throw new Error(`${label}: unexpected schemaVersion`);
  return report;
}

function runBalise(source, scenario, label) {
  const file = path.join(temporary, `${label}.py`);
  fs.writeFileSync(file, source);
  const execution = run("python3", ["-B", baliseHarness, file, scenario]);
  return {execution, report:parseReport(execution, "sde-24xx-focused-mutation-harness-v1", label)};
}

function runTarget(source, label) {
  const file = path.join(temporary, `${label}.html`);
  fs.writeFileSync(file, source);
  const execution = run(process.execPath, [targetHarness, file]);
  return {execution, report:parseReport(execution, "sde-blocked-target-three-card-harness-v1", label)};
}

function runEmptyDrop(source, label) {
  return runIndexHarness(source,label,emptyDropHarness,"sde-empty-target-drag-intent-harness-v1");
}

function runIndexHarness(source, label, harness, schemaVersion) {
  const file = path.join(temporary, `${label}.html`);
  fs.writeFileSync(file, source);
  const execution = run(process.execPath, [harness, file]);
  return {execution, report:parseReport(execution, schemaVersion, label)};
}

function runEgress(source, label) {
  return runIndexHarness(source,label,egressHarness,"sde-trapped-egress-harness-v1");
}

function runVnRelief(source, label) {
  return runIndexHarness(source,label,vnReliefHarness,"sde-vn-relief-invariants-v1");
}

function runSuffixPersistence(source, label) {
  return runIndexHarness(source,label,suffixPersistenceHarness,"sde-suffix-persistence-invariants-v1");
}

function runMenu(source, label) {
  return runIndexHarness(source,label,menuHarness,"sde-menu-access-layout-harness-v1");
}

const mutations = [
  {
    id: "MAIN_AND_RECOVERY_DELETED_AFTER_RELEASE_COMPLETION",
    kind: "suffixPersistence",
    expectedInvariant: "COMPLETING_RELEASE_MUST_NOT_DELETE_MAIN_OR_RECOVERY",
    apply: source => mutateFunction(
      source,
      "getSdeTrappedEgressCarriedReleases",
      'if(record?.action !== "completed") return [];',
      'if(record?.action === "completed") return []; // focused mutation: delete suffix after completed release',
      "completed release deletes suffix",
    ),
  },
  {
    id: "EXPECTED_TEMP_OCCUPANT_TREATED_AS_CONFLICT",
    kind: "suffixPersistence",
    expectedInvariant: "EXPECTED_TEMP_OCCUPANT_IS_NOT_A_CONFLICT",
    apply: source => mutateFunction(
      source,
      "getSdeTrappedEgressCarriedReleases",
      "if(!vehicle || !fromSlot || !toSlot || !actualSlot) return [];",
      "if(!vehicle || !fromSlot || !toSlot || !actualSlot) return [];\n    if(actualSlot === toSlot) return []; // focused mutation: expected temporary occupant is a conflict",
      "expected temporary occupant rejected",
    ),
  },
  {
    id: "ORIGINAL_MAIN_INTENT_DROPPED_DURING_REPLAN",
    kind: "suffixPersistence",
    expectedInvariant: "REPLAN_PRESERVES_ORIGINAL_MAIN_INTENT",
    apply: source => {
      const mutableTarget = mutateFunction(
        source,
        "buildSdeCompleteTrappedEgressPlan",
        "const requestedTarget = normalizeSlot(row?.recommendedSlot || row?.toSlot); // SDE_EGRESS_REQUESTED_TARGET",
        "let requestedTarget = normalizeSlot(row?.recommendedSlot || row?.toSlot); // focused mutation: mutable intent",
        "mutable main intent",
      );
      return mutateFunction(
        mutableTarget,
        "buildSdeCompleteTrappedEgressPlan",
        "const carriedReleases = getSdeTrappedEgressCarriedReleases(row,occupancy);",
        'const carriedReleases = getSdeTrappedEgressCarriedReleases(row,occupancy);\n  if(carriedReleases.some(step=>step.unexpectedTemporaryOccupancy)) requestedTarget = "10"; // focused mutation: drop original target during replan',
        "drop main target during replan",
      );
    },
  },
  {
    id: "STALE_SUFFIX_AND_NEW_SUFFIX_COEXIST",
    kind: "suffixPersistence",
    expectedInvariant: "REPLAN_ATOMICALLY_REPLACES_STALE_SUFFIX",
    apply: source => mutateFunction(
      source,
      "buildSdeCompleteTrappedEgressPlan",
      "const carriedReleases = getSdeTrappedEgressCarriedReleases(row,occupancy);",
      'const carriedReleases = getSdeTrappedEgressCarriedReleases(row,occupancy);\n  if(carriedReleases.some(step=>step.unexpectedTemporaryOccupancy)) carriedReleases.push({...carriedReleases[0],vehicle:"STALE-SUFFIX",fromSlot:"6N",toSlot:"VN",carriedCompletedRelease:false,completedActionKey:""}); // focused mutation: stale and fresh suffix coexist',
      "stale suffix retained during replan",
    ),
  },
  {
    id: "TRAIN_NUMBER_ONLY_VEHICLE_LOOKUP",
    kind: "balise",
    apply: source => replaceOnce(
      source,
      "def normalize_train_no(",
      'TRAIN_NUMBER_ONLY_VEHICLE_LOOKUP = {"2473": "69-99"}  # focused mutation\n\ndef normalize_train_no(',
      "train-number-only lookup",
    ),
  },
  {
    id: "CROSS_DATE_24XX_ASSIGNMENT_LEAK",
    kind: "balise",
    apply: source => replaceOnce(
      source,
      'and str(route_info.get("operationalDate") or "").strip() == str(operational_date or "").strip()',
      "and True  # focused mutation: accept another operational date",
      "cross-date occurrence",
    ),
  },
  {
    id: "STADLER_BUTTON_SHRUNK",
    kind: "menu",
    expectedInvariant: "INV-MENU-001",
    apply: source => replaceOnce(
      source,
      ".segmented button.seg-stadler-graphic{\nposition:relative;",
      ".segmented button.seg-stadler-graphic{\ngrid-column:span 1; /* focused mutation: shrink STADLER */\nposition:relative;",
      "stadler shrink",
    ),
  },
  {
    id: "NIGHTPLAN_VISIBLE_TO_ALL_LEVELS",
    kind: "menu",
    expectedInvariant: "INV-MENU-002",
    apply: source => replaceOnce(
      source,
      'const SDE_NIGHT_PLAN_ALLOWED_LEVELS = Object.freeze(["0","2"]);',
      'const SDE_NIGHT_PLAN_ALLOWED_LEVELS = Object.freeze(["0","1","2","3","4","5"]); // focused mutation',
      "nightplan all levels",
    ),
  },
  {
    id: "NIGHTPLAN_OLD_LABEL_RESTORED",
    kind: "menu",
    expectedInvariant: "INV-MENU-003",
    apply: source => replaceOnce(
      source,
      'const SDE_NIGHT_PLAN_BUTTON_LABEL = "Registrer Nattplan";',
      'const SDE_NIGHT_PLAN_BUTTON_LABEL = "Nattplan og erfaring"; // focused mutation',
      "nightplan old label",
    ),
  },
  {
    id: "EMPTY_SLOT_REJECTED_BEFORE_PLANNER",
    kind: "emptyDrop",
    expectedInvariant: "INV-EMPTY-DROP-001",
    apply: source => mutateFunction(
      source,
      "getSdeNightPlacementDragTargetEligibility",
      "return {\n    droppable:true,\n    dragIntentAccepted:true,",
      "return {\n    droppable:false, // focused mutation: reject empty target\n    dragIntentAccepted:false,",
      "empty target rejected before planner",
    ),
  },
  {
    id: "DIRECT_ROUTE_BLOCKAGE_PAINTS_EMPTY_TARGET_RED",
    kind: "emptyDrop",
    expectedInvariant: "INV-EMPTY-DROP-003",
    apply: source => mutateFunction(
      source,
      "getSdeNightPlacementDragTargetEligibility",
      "renderRedUnavailable:false,\n    physicalTargetUnavailable:false,\n    targetAvailabilityState:reliefRequired",
      "renderRedUnavailable:true, // focused mutation: relief paints target red\n    physicalTargetUnavailable:true,\n    targetAvailabilityState:reliefRequired",
      "empty target painted red",
    ),
  },
  {
    id: "DROP_INTENT_NEVER_REACHES_CANONICAL_PLANNER",
    kind: "emptyDrop",
    expectedInvariant: "INV-EMPTY-DROP-004",
    apply: source => mutateFunction(
      source,
      "applySdeNightPlacementDragOverride",
      "const order = stageSdeCanonicalGraphicDragOrder(override);",
      "const order = null; throw new Error('focused mutation: planner bypassed');",
      "drop intent planner bypass",
    ),
  },
  {
    id: "RELIEF_SEARCH_ONLY_CHECKS_ONE_DIRECTION",
    kind: "emptyDrop",
    expectedInvariant: "INV-EMPTY-DROP-005",
    apply: source => mutateFunction(
      source,
      "getSdeMovePhysicalAccessAssessment",
      "const targetAccessOptions = getSdeAccessOptionsForSlot(toSlot, \"target\");",
      "const targetAccessOptions = getSdeAccessOptionsForSlot(toSlot, \"target\").slice(0,1); // focused mutation",
      "one-direction relief search",
    ),
  },
  {
    id: "VN_REMOVED_FROM_RELIEF_CANDIDATES",
    kind: "vnRelief",
    expectedInvariant: "AVAILABLE-VN-IS-NOT-IGNORED",
    apply: source => mutateFunction(
      source,
      "getSdeTrappedEgressTemporaryCandidateOrder",
      'const dedicatedVn = options?.preferDedicatedVn === true ? ["VN"] : [];',
      "const dedicatedVn = []; // focused mutation: remove VN",
      "VN removed from relief candidates",
    ),
  },
  {
    id: "ORDINARY_TRACK_RANKED_BEFORE_SAFE_VN",
    kind: "vnRelief",
    expectedInvariant: "VN-PREFERRED-OVER-ORDINARY-TRACK-FOR-GLOBAL-RELIEF",
    apply: source => mutateFunction(
      source,
      "getSdeTrappedEgressTemporaryCandidateOrder",
      'if(options?.preferDedicatedVn === true && (left === "VN" || right === "VN")){',
      'if(false && options?.preferDedicatedVn === true && (left === "VN" || right === "VN")){ // focused mutation',
      "ordinary tracks before VN",
    ),
  },
  {
    id: "SEARCH_STOPS_AFTER_FIRST_REJECTED_CANDIDATE",
    kind: "vnRelief",
    expectedInvariant: "ONE-FAILED-CANDIDATE-DOES-NOT-END-SEARCH",
    apply: source => mutateFunction(
      source,
      "buildSdeCompleteTrappedEgressPlan",
      "for(const targetSlot of selectionOrder){",
      "for(const targetSlot of selectionOrder.slice(0,1)){ // focused mutation: stop after first rejected candidate",
      "relief search stops after first candidate",
    ),
  },
  {
    id: "USER_MUST_REPEAT_DRAG_AFTER_STATE_CHANGE",
    kind: "vnRelief",
    expectedInvariant: "ACTUAL-STATE-CHANGE-TRIGGERS-AUTOMATIC-REPLAN",
    apply: source => mutateFunction(
      source,
      "reconcileSdeCanonicalGraphicDragOrderFromActualState",
      "if(!override || !generatedMove || override?.sdeCanonicalGraphicDragOrder !== true) return false;",
      "return false; // focused mutation: require a new drag\n  if(!override || !generatedMove || override?.sdeCanonicalGraphicDragOrder !== true) return false;",
      "automatic replan disabled",
    ),
  },
  {
    id: "REPLAN_REQUIRED_STOPS_WITHOUT_NEW_SUFFIX",
    kind: "vnRelief",
    expectedInvariant: "ACTUAL-STATE-CHANGE-TRIGGERS-AUTOMATIC-REPLAN",
    apply: source => mutateFunction(
      source,
      "reconcileSdeCanonicalGraphicDragOrderFromActualState",
      "const replannedRows = buildSdePhysicalBlockerGuardMoves([generatedMove], {reconcileActive:false});",
      "const replannedRows = []; // focused mutation: error-only without a new plan",
      "replan returns no plan",
    ),
  },
  {
    id: "OCCUPIED_TEMP_TARGET_ACCEPTED",
    kind: "vnRelief",
    expectedInvariant: "OCCUPIED-ORDINARY-TEMP-TARGET-IS-REJECTED",
    apply: source => mutateFunction(
      source,
      "assessSdeTrappedEgressVirtualMove",
      "if(targetVehicle && !haveSameSdeVehicleTokens(targetVehicle,vehicleId)) return {valid:false};",
      "if(false && targetVehicle && !haveSameSdeVehicleTokens(targetVehicle,vehicleId)) return {valid:false}; // focused mutation",
      "occupied temporary target accepted",
    ),
  },
  {
    id: "RELEASE_CARD_OMITTED",
    expectedInvariant: "BLOCKER_CARD_PRESENT",
    apply: source => mutateFunction(
      source,
      "buildSdePhysicalBlockerGuardMoves",
      "if(freeingMove && freeingKey && !insertedFreeingKeys.has(freeingKey)){",
      "if(false && freeingMove && freeingKey && !insertedFreeingKeys.has(freeingKey)){ /* focused mutation */",
      "blocker card omitted",
    ),
  },
  {
    id: "MAIN_CARD_READY_BEFORE_RELEASE",
    expectedInvariant: "MAIN_BLOCKED_UNTIL_RELEASE",
    apply: source => mutateFunction(
      source,
      "annotateSdeTemporaryAccessReliefMainRow",
      "sdePhysicalDependsOn:[plan.releaseActionKey],",
      "sdePhysicalDependsOn:[], // focused mutation: main bypasses release",
      "main dependency",
    ),
  },
  {
    id: "RECOVERY_CARD_OMITTED",
    expectedInvariant: "RECOVERY_CARD_PRESENT",
    apply: source => mutateFunction(
      source,
      "buildSdePhysicalBlockerGuardMoves",
      "const returnRow = buildSdeTemporaryAccessReturnRow(accessChainPlan);",
      "const returnRow = null; // focused mutation: recovery omitted",
      "recovery card omitted",
    ),
  },
  {
    id: "RECOVERY_ALWAYS_RETURNS_TO_ORIGINAL_SLOT",
    kind: "egress",
    expectedInvariant: "INV-EGRESS-024",
    apply: source => mutateFunction(
      source,
      "getSdeTrappedEgressRecoveryCandidateOrder",
      "if(explicit) return [explicit];",
      "if(explicit) return [explicit];\n  return [normalizeSlot(release?.fromSlot)]; // focused mutation: ignore post-main topology",
      "recovery always original",
    ),
  },
  {
    id: "RECOVERY_CREATES_TRAPPED_EMPTY_SLOT",
    kind: "egress",
    expectedInvariant: "INV-EGRESS-023",
    apply: source => mutateFunction(
      source,
      "getSdeButtTrackTemporaryVnPair",
      "returnSlot:blockedFrom,\n    recoverySlot:blockedFrom",
      "returnSlot:blockerFrom, // focused mutation: trap empty S slot\n    recoverySlot:blockerFrom",
      "butt recovery traps S",
    ),
  },
  {
    id: "RECOVERY_POINTS_TO_STALE_DESTINATION",
    expectedInvariant: "AUTHORITATIVE_RECOVERY_REPLACES_STALE_DESTINATION",
    apply: source => mutateFunction(
      source,
      "applySdeCanonicalRetargetIntentToRow",
      "recommendedSlot:targetSlot,\n    toSlot:targetSlot,",
      "recommendedSlot:isRecovery ? originalTarget : targetSlot,\n    toSlot:isRecovery ? originalTarget : targetSlot, // focused mutation: stale recovery destination",
      "stale recovery destination",
    ),
  },
  {
    id: "PARTIAL_CHAIN_ALLOWED",
    expectedInvariant: "NO_PARTIAL_THREE_CARD_PROJECTION",
    apply: source => {
      const withoutRecovery = mutateFunction(
        source,
        "buildSdePhysicalBlockerGuardMoves",
        "const returnRow = buildSdeTemporaryAccessReturnRow(accessChainPlan);",
        "const returnRow = null; // focused mutation: partial chain",
        "partial chain",
      );
      return replaceOnce(
        withoutRecovery,
        "if(!structural.complete){ // SDE_BLOCKED_SLOT_COMPLETE_PLAN_GATE",
        "if(false && !structural.complete){ /* focused mutation: allow partial projection */",
        "partial projection gate",
      );
    },
  },
  {
    id: "ACTUAL_PLACEMENT_CHANGED_BEFORE_AUTHORIZED_COMPLETION",
    kind: "suffixPersistence",
    expectedInvariant: "ACTUAL_PLACEMENT_CHANGES_ONLY_AFTER_AUTHORIZED_COMPLETION",
    apply: source => mutateFunction(
      source,
      "buildSdePhysicalBlockerGuardMoves",
      "const reconciledRows = reconcileSdeFinalVnRecoveryRows(guarded, sourceRows);",
      "const reconciledRows = reconcileSdeFinalVnRecoveryRows(guarded, sourceRows);\n  const mutationRow=rawRows[0]; const mutationTarget=normalizeSlot(mutationRow?.recommendedSlot||mutationRow?.toSlot); if(mutationRow&&mutationTarget) state.grunnoppstilling[mutationTarget]=sanitizeVehicleValue(mutationRow.vehicle); // focused mutation",
      "planning writes actual placement",
    ),
  },
];

const reports = [];
try {
  for (const mutation of mutations) {
    const baseline = mutation.kind === "balise"
      ? runBalise(generatorSource, mutation.id, `${mutation.id}-baseline`)
      : mutation.kind === "menu"
        ? runMenu(indexSource, `${mutation.id}-baseline`)
      : mutation.kind === "emptyDrop"
          ? runEmptyDrop(indexSource, `${mutation.id}-baseline`)
      : mutation.kind === "suffixPersistence"
          ? runSuffixPersistence(indexSource, `${mutation.id}-baseline`)
      : mutation.kind === "egress"
          ? runEgress(indexSource, `${mutation.id}-baseline`)
          : mutation.kind === "vnRelief"
            ? runVnRelief(indexSource, `${mutation.id}-baseline`)
          : runTarget(indexSource, `${mutation.id}-baseline`);
    if (baseline.execution.status !== 0) throw new Error(`${mutation.id}: green baseline failed`);

    const mutatedSource = mutation.apply(mutation.kind === "balise" ? generatorSource : indexSource);
    const mutant = mutation.kind === "balise"
      ? runBalise(mutatedSource, mutation.id, mutation.id)
      : mutation.kind === "menu"
        ? runMenu(mutatedSource, mutation.id)
      : mutation.kind === "emptyDrop"
          ? runEmptyDrop(mutatedSource, mutation.id)
      : mutation.kind === "suffixPersistence"
          ? runSuffixPersistence(mutatedSource, mutation.id)
      : mutation.kind === "egress"
          ? runEgress(mutatedSource, mutation.id)
          : mutation.kind === "vnRelief"
            ? runVnRelief(mutatedSource, mutation.id)
          : runTarget(mutatedSource, mutation.id);
    const structuredFailure = mutant.execution.status === 1;
    const invariantObserved = mutation.kind === "balise"
      ? mutant.report.status === "FAIL" && mutant.report.invariantId === mutation.id && mutant.report.structured === true
      : ["menu","egress","vnRelief","suffixPersistence"].includes(mutation.kind)
        ? mutant.report.counts?.fail > 0
          && mutant.report.results?.some(report=>report.id===mutation.expectedInvariant&&report.status==="FAIL")
        : mutation.kind === "emptyDrop"
          ? mutant.report.results?.some(report=>report.id===mutation.expectedInvariant&&report.status==="FAIL")
        : mutant.report.counts?.fail > 0
        && mutant.report.reports?.some(report=>report.invariantFailures?.includes(mutation.expectedInvariant));
    reports.push({
      id: mutation.id,
      status: structuredFailure && invariantObserved ? "PASS" : "FAIL",
      mutantExitCode: mutant.execution.status,
      structuredKill: structuredFailure && invariantObserved,
      expectedInvariant: mutation.expectedInvariant || mutation.id,
    });
  }
} finally {
  fs.rmSync(temporary, {recursive:true, force:true});
}

const failed = reports.filter(report=>report.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-final-focused-mutation-audit-v1",
  counts:{total:reports.length,pass:reports.length-failed.length,fail:failed.length},
  reports,
})}\n`);
process.exitCode = failed.length ? 1 : 0;

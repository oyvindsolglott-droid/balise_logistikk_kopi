"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const generatorSource = fs.readFileSync(path.join(root, "update_static_data.py"), "utf8");
const targetHarness = path.join(root, "tests/sde/harnesses/sde-blocked-target-three-card-harness.js");
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

const mutations = [
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
    id: "BLOCKER_CARD_OMITTED",
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
    id: "MAIN_CARD_ACTIVATED_BEFORE_RELEASE",
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
    id: "PARTIAL_THREE_CARD_PROJECTION_ALLOWED",
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
    id: "ACTUAL_PLACEMENT_CHANGED_BEFORE_COMPLETION",
    expectedInvariant: "ACTUAL_PLACEMENT_UNCHANGED_BEFORE_COMPLETION",
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
      : runTarget(indexSource, `${mutation.id}-baseline`);
    if (baseline.execution.status !== 0) throw new Error(`${mutation.id}: green baseline failed`);

    const mutatedSource = mutation.apply(mutation.kind === "balise" ? generatorSource : indexSource);
    const mutant = mutation.kind === "balise"
      ? runBalise(mutatedSource, mutation.id, mutation.id)
      : runTarget(mutatedSource, mutation.id);
    const structuredFailure = mutant.execution.status === 1;
    const invariantObserved = mutation.kind === "balise"
      ? mutant.report.status === "FAIL" && mutant.report.invariantId === mutation.id && mutant.report.structured === true
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

"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {STRICT_INVARIANT_IDS} = require("./qualification-contract.cjs");

const root = path.resolve(__dirname, "../../..");
const sourcePath = path.join(root, "index.html");
const source = fs.readFileSync(sourcePath, "utf8");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-firewall-mutations-"));

function replaceOnce(value, search, replacement, name) {
  const index = value.indexOf(search);
  if (index < 0) throw new Error(`${name}: mutation anchor not found`);
  return value.slice(0, index) + replacement + value.slice(index + search.length);
}

function countOccurrences(value, search) {
  if (!search) return 0;
  return value.split(search).length - 1;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const X1_MUTANT_ID = "X1-bind-canRetarget-to-canCancel";
const X1_BEFORE_LINE = "    const canRetarget = isSdeCanonicalRetargetableOutcome(outcome);";
const X1_AFTER_LINE = "    const canRetarget = isSdeCanonicalRetargetableOutcome(outcome) && !isRecovery(outcome); /* mutation: bind retarget to cancellation */";
const X1_EXPECTED_INVARIANT_IDS = Object.freeze(["INV-REROUTE-001", "INV-REROUTE-004", "INV-REROUTE-008"]);

function countExactLines(value, line) {
  return String(value).split(/\r?\n/).filter(item => item === line).length;
}

function validateX1MutationApplication(original, mutated) {
  const errors = [];
  const originalLines = String(original).split(/\r?\n/);
  const mutatedLines = String(mutated).split(/\r?\n/);
  if (countExactLines(original, X1_BEFORE_LINE) !== 1) errors.push("X1 target line must exist exactly once");
  if (countExactLines(mutated, X1_BEFORE_LINE) !== 0) errors.push("X1 target line must be fully replaced");
  if (countExactLines(mutated, X1_AFTER_LINE) !== 1) errors.push("X1 replacement line must exist exactly once");
  if (originalLines.length !== mutatedLines.length) errors.push("X1 must preserve line count");
  const changedLineIndexes = [];
  for (let index = 0; index < Math.max(originalLines.length, mutatedLines.length); index += 1) {
    if (originalLines[index] !== mutatedLines[index]) changedLineIndexes.push(index);
  }
  if (changedLineIndexes.length !== 1) errors.push(`X1 must change exactly one source line, got ${changedLineIndexes.length}`);
  const targetIndex = originalLines.indexOf(X1_BEFORE_LINE);
  if (changedLineIndexes.length === 1 && changedLineIndexes[0] !== targetIndex) errors.push("X1 changed an unrelated source line");
  if (targetIndex >= 0 && mutatedLines[targetIndex] !== X1_AFTER_LINE) errors.push("X1 replacement does not match the locked mutation");
  return {
    ok: errors.length === 0,
    errors,
    changedLineCount: changedLineIndexes.length,
    changedHunkCount: changedLineIndexes.length === 1 ? 1 : null,
    targetLineNumber: targetIndex >= 0 ? targetIndex + 1 : null,
    beforeLineSha256: sha256(X1_BEFORE_LINE),
    afterLineSha256: sha256(X1_AFTER_LINE),
  };
}

function applyX1Mutation(value) {
  if (countExactLines(value, X1_BEFORE_LINE) !== 1) throw new Error("independent canRetarget: expected exactly one authoritative X1 target line");
  const html = replaceOnce(value, X1_BEFORE_LINE, X1_AFTER_LINE, "independent canRetarget");
  const validation = validateX1MutationApplication(value, html);
  if (!validation.ok) throw new Error(`X1 mutation application failed closed: ${validation.errors.join("; ")}`);
  return {
    html,
    metadata: {
      strategy: "bind-authoritative-card-canRetarget-to-recovery-cancel-semantics",
      functionName: "buildSdeCanonicalCardProjection/resolveCanRetarget",
      changedOccurrences: 1,
      ...validation,
      beforeLine: X1_BEFORE_LINE,
      afterLine: X1_AFTER_LINE,
    },
  };
}

const ACTIVE_SOURCE_MUTANT_IDS = Object.freeze([
  "A-bypass-cancellation-modal",
  "B-mutate-cancellation-state-before-save",
  "C-mutate-state-on-modal-cancel",
  "D-remove-learning-reason-and-comment",
  "E-remove-exiting-status",
  "F-remove-replacement-authority",
  "G-change-5-plus-2",
  "H-hide-ordered-and-exiting-cards",
  "I-keep-placeholder-after-removeAt",
  "G-allow-occupied-target-card",
  "H-rank-VN-before-local-south",
  "I-remove-mandatory-recovery",
  "X1-bind-canRetarget-to-canCancel",
  "X2-ignore-contextual-rejected-target",
  "X3-bypass-whole-chain-target-filter",
  "X4-retain-old-retarget-resource-identity",
  "X5-drop-mandatory-retarget-recovery",
  "Y1-SINGLE-BLOCKER-CAP",
  "Y2-OMIT-RELEASE-OR-RECOVERY",
  "Y3-WRONG-DEPENDENCY-ORDER",
  "Y4-PARTIAL-RESOURCE-PROJECTION",
  "Y5-ORIGINAL-SNAPSHOT-AFTER-PROGRESS",
  "Y6-RETARGET-BOUND-TO-CANCEL",
  "Y7-UNSAFE-CANDIDATE-OR-TARGET-OVERRIDE",
  "Y8-RECURSIVE-DRAG-BYPASSES-COMPLETE-EGRESS",
  "Y9-DROP-ACTIONABLE-MID-CHAIN-SUFFIX",
  "Y10-NULL-MATCHMEDIA-DEREFERENCE",
  "Z1-DROP-PARENT-INTENT-ON-PREREQUISITE-CANCEL",
  "Z2-REUSE-REJECTED-CHAIN",
  "Z3-COMMIT-PARTIAL-CANCELLED-CHAIN",
  "Z4-RETAIN-STALE-CANCELLED-RESOURCES",
  "Z5-POISON-GLOBAL-DRAG-AFTER-CHAIN-FAILURE",
  "PASSIVE-SWEEP-DISABLED",
  "PARTIAL-PROJECTION-ALLOWED",
  "STALE-HISTORY-OVERRIDES-FRESH-ACTUAL",
  "MANDATORY-RECOVERY-OR-ADAPTER-OMITTED",
]);
const ACTIVE_MUTATION_SCENARIO_IDS = Object.freeze([
  ...ACTIVE_SOURCE_MUTANT_IDS,
  "qualification-contract-positive",
  "qualification-contract-fail-closed-negatives",
]);

if (ACTIVE_SOURCE_MUTANT_IDS.length !== 36 || ACTIVE_MUTATION_SCENARIO_IDS.length !== 38) {
  throw new Error("active mutation catalogs have unexpected totals");
}

function validateExactCatalog(actualIds, expectedIds, label) {
  const errors = [];
  if (!Array.isArray(actualIds)) return {ok: false, errors: [`${label} must be an array`]};
  if (actualIds.some(id => typeof id !== "string" || !id)) errors.push(`${label} IDs must be non-empty strings`);
  if (new Set(actualIds).size !== actualIds.length) errors.push(`${label} IDs must be unique`);
  if (actualIds.length !== expectedIds.length) errors.push(`${label} total must be ${expectedIds.length}`);
  const actual = [...actualIds].sort();
  const expected = [...expectedIds].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${label} IDs must match the active catalog exactly`);
  return {ok: errors.length === 0, errors};
}

function validateMutationStrictReport(report, strictExitCode) {
  const errors = [];
  if (report?.schemaVersion !== "sde-strict-report-v1") errors.push("unexpected strict schemaVersion");
  if (report?.mode !== "strict") errors.push("unexpected strict mode");
  if (report?.counts?.total !== STRICT_INVARIANT_IDS.length) errors.push(`strict total must be ${STRICT_INVARIANT_IDS.length}`);
  if (!Array.isArray(report?.results)) {
    errors.push("strict results must be an array");
  } else {
    errors.push(...validateExactCatalog(report.results.map(item => item?.id), STRICT_INVARIANT_IDS, "strict invariant").errors);
    if (report.results.some(item => !["PASS", "FAIL"].includes(item?.status))) errors.push("strict statuses must be PASS or FAIL");
  }
  if (!Array.isArray(report?.failIds)) {
    errors.push("strict failIds must be an array");
  } else {
    if (new Set(report.failIds).size !== report.failIds.length) errors.push("strict failIds must be unique");
    if (report.failIds.some(id => !STRICT_INVARIANT_IDS.includes(id))) errors.push("strict failIds must belong to the active invariant catalog");
  }
  if (Array.isArray(report?.results) && Array.isArray(report?.failIds)) {
    const failures = report.results.filter(item => item?.status === "FAIL").map(item => item.id).sort();
    if (JSON.stringify(failures) !== JSON.stringify([...report.failIds].sort())) errors.push("strict failIds must match failed result IDs");
    if (report?.counts?.fail !== failures.length) errors.push("strict fail count must match failed results");
    if (report?.counts?.pass !== report.results.length - failures.length) errors.push("strict pass count must match passed results");
    if (strictExitCode !== (failures.length ? 1 : 0)) errors.push("strict exit code must match failure state");
  }
  return {ok: errors.length === 0, errors};
}

function parseMutationStrictRun(run, name) {
  if (run?.error) {
    const code = String(run.error.code || "child_error");
    throw new Error(`${name} infrastructure error (${code}): ${run.error.message || run.error}`);
  }
  if (run?.signal) throw new Error(`${name} infrastructure error: terminated by ${run.signal}`);
  if (![0, 1].includes(run?.status)) {
    throw new Error(`${name} infrastructure error: unexpected exit ${String(run?.status)}${run?.stderr ? `: ${run.stderr}` : ""}`);
  }
  if (String(run.stderr || "").trim()) {
    throw new Error(`${name} infrastructure error: unexpected stderr/warning: ${String(run.stderr).trim()}`);
  }
  const lines = String(run.stdout || "").trim().split(/\n/).filter(Boolean);
  if (!lines.length) throw new Error(`${name} infrastructure error: missing final strict JSON`);
  let report;
  try {
    report = JSON.parse(lines.at(-1));
  } catch (error) {
    throw new Error(`${name} infrastructure error: malformed final strict JSON: ${error.message}`);
  }
  const validation = validateMutationStrictReport(report, run.status);
  if (!validation.ok) throw new Error(`${name} returned an incomplete strict report: ${validation.errors.join("; ")}`);
  return {...report, strictExitCode: run.status};
}

function isStructuredMutationKill(mutation, report) {
  if (!report || report.strictExitCode !== 1 || !Array.isArray(report.failIds)) return false;
  return mutation.any
    ? mutation.catches.some(id => report.failIds.includes(id))
    : mutation.catches.every(id => report.failIds.includes(id));
}

function isRejected(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

function syntheticStrictReport(failIds=[]) {
  const failed = new Set(failIds);
  const results = STRICT_INVARIANT_IDS.map(id => ({id, status: failed.has(id) ? "FAIL" : "PASS", detail: "self-validation"}));
  return {
    schemaVersion: "sde-strict-report-v1",
    mode: "strict",
    counts: {total: results.length, pass: results.length - failed.size, fail: failed.size},
    failIds: [...failIds],
    results,
  };
}

function validateScenarioReports(reports) {
  const catalog = validateExactCatalog(reports?.map(item => item?.id), ACTIVE_MUTATION_SCENARIO_IDS, "mutation scenario");
  const errors = [...catalog.errors];
  if (Array.isArray(reports) && reports.some(item => item?.status !== "PASS")) errors.push("every mutation scenario must be executed and pass; survivors are forbidden");
  return {ok: errors.length === 0, errors};
}

function runCatalogSelfValidation({baseline, x1Report, x1Application, x1Mutation}) {
  const passReports = ACTIVE_MUTATION_SCENARIO_IDS.map(id => ({id, status: "PASS"}));
  const validPassReport = syntheticStrictReport();
  const validFailReport = syntheticStrictReport(X1_EXPECTED_INVARIANT_IDS);
  const validPassRun = {status: 0, signal: null, error: null, stderr: "", stdout: `${JSON.stringify(validPassReport)}\n`};
  const validFailRun = {status: 1, signal: null, error: null, stderr: "", stdout: `${JSON.stringify(validFailReport)}\n`};
  const wrongTargetSource = source.replace(X1_BEFORE_LINE, "    const unrelatedCapability = isSdeCanonicalRetargetableOutcome(outcome);");
  const multipleHunkSource = `${x1Application?.mutatedSource || ""}\n<!-- unintended second X1 hunk -->`;
  const scenarios = [
    {id: "exact-active-193-id-catalog-is-accepted", passed: validateExactCatalog([...STRICT_INVARIANT_IDS], STRICT_INVARIANT_IDS, "strict invariant").ok},
    {id: "missing-invariant-id-is-rejected", passed: !validateExactCatalog(STRICT_INVARIANT_IDS.slice(0, -1), STRICT_INVARIANT_IDS, "strict invariant").ok},
    {id: "extra-invariant-id-is-rejected", passed: !validateExactCatalog([...STRICT_INVARIANT_IDS, "INV-EXTRA-001"], STRICT_INVARIANT_IDS, "strict invariant").ok},
    {id: "duplicate-invariant-id-is-rejected", passed: !validateExactCatalog([...STRICT_INVARIANT_IDS.slice(0, -1), STRICT_INVARIANT_IDS[0]], STRICT_INVARIANT_IDS, "strict invariant").ok},
    {id: "missing-y10-scenario-is-rejected", passed: !validateScenarioReports(passReports.filter(item => item.id !== "Y10-NULL-MATCHMEDIA-DEREFERENCE")).ok},
    {id: "extra-mutation-scenario-is-rejected", passed: !validateScenarioReports([...passReports, {id: "UNKNOWN-MUTATION", status: "PASS"}]).ok},
    {id: "duplicate-mutation-scenario-is-rejected", passed: !validateScenarioReports([...passReports.slice(0, -1), passReports[0]]).ok},
    {id: "survivor-is-rejected", passed: !validateScenarioReports(passReports.map((item, index) => index === 0 ? {...item, status: "FAIL"} : item)).ok},
    {id: "missing-source-mutant-is-rejected", passed: !validateExactCatalog(ACTIVE_SOURCE_MUTANT_IDS.slice(0, -1), ACTIVE_SOURCE_MUTANT_IDS, "source mutant").ok},
    {id: "duplicate-source-mutant-is-rejected", passed: !validateExactCatalog([...ACTIVE_SOURCE_MUTANT_IDS.slice(0, -1), ACTIVE_SOURCE_MUTANT_IDS[0]], ACTIVE_SOURCE_MUTANT_IDS, "source mutant").ok},
    {id: "unchanged-candidate-harness-exit-zero-is-structured", passed: baseline?.strictExitCode === 0 && baseline?.failIds?.length === 0 && baseline?.counts?.total === STRICT_INVARIANT_IDS.length},
    {id: "x1-structured-invariant-failure-is-killed", passed: x1Application?.validation?.ok === true && isStructuredMutationKill(x1Mutation, x1Report)},
    {id: "generic-exit-two-is-rejected", passed: isRejected(()=>parseMutationStrictRun({...validFailRun, status: 2}, "self-exit-two"))},
    {id: "malformed-json-is-rejected", passed: isRejected(()=>parseMutationStrictRun({...validFailRun, stdout: "{not-json\n"}, "self-malformed"))},
    {id: "missing-final-json-is-rejected", passed: isRejected(()=>parseMutationStrictRun({...validFailRun, stdout: ""}, "self-missing-json"))},
    {id: "timeout-is-rejected", passed: isRejected(()=>parseMutationStrictRun({...validFailRun, status: null, error: Object.assign(new Error("timeout"), {code: "ETIMEDOUT"})}, "self-timeout"))},
    {id: "signal-is-rejected", passed: isRejected(()=>parseMutationStrictRun({...validFailRun, status: null, signal: "SIGTERM"}, "self-signal"))},
    {id: "unknown-warning-is-rejected", passed: isRejected(()=>parseMutationStrictRun({...validFailRun, stderr: "unexpected warning"}, "self-warning"))},
    {id: "wrong-x1-target-is-rejected", passed: isRejected(()=>applyX1Mutation(wrongTargetSource))},
    {id: "multiple-x1-hunks-are-rejected", passed: !validateX1MutationApplication(source, multipleHunkSource).ok},
    {id: "missing-x1-expected-invariant-is-rejected", passed: !isStructuredMutationKill(x1Mutation, {...x1Report, failIds: (x1Report?.failIds || []).filter(id => id !== X1_EXPECTED_INVARIANT_IDS[0])})},
    {id: "x1-survivor-is-rejected", passed: !isStructuredMutationKill(x1Mutation, {...parseMutationStrictRun(validPassRun, "self-survivor"), failIds: []})},
  ];
  return {
    status: scenarios.every(item => item.passed) ? "PASS" : "FAIL",
    counts: {
      total: scenarios.length,
      pass: scenarios.filter(item => item.passed).length,
      fail: scenarios.filter(item => !item.passed).length,
    },
    scenarios: scenarios.map(item => ({id: item.id, status: item.passed ? "PASS" : "FAIL"})),
  };
}

function applySemanticStrategy(value, strategies, name) {
  const matching = strategies.filter(strategy => strategy.matches(value));
  if (matching.length !== 1) {
    throw new Error(`${name}: expected exactly one semantic strategy, got ${matching.length}`);
  }

  const strategy = matching[0];
  const beforeSnippets = [];
  const afterSnippets = [];
  let changed = value;
  let changedOccurrences = 0;

  for (const edit of strategy.edits) {
    const occurrences = countOccurrences(changed, edit.before);
    if (occurrences !== 1) {
      throw new Error(`${name}/${strategy.id}/${edit.name}: expected exactly one occurrence, got ${occurrences}`);
    }
    changed = replaceOnce(changed, edit.before, edit.after, `${name}/${strategy.id}/${edit.name}`);
    beforeSnippets.push(edit.before);
    afterSnippets.push(edit.after);
    changedOccurrences += occurrences;
  }

  if (changed === value) throw new Error(`${name}/${strategy.id}: mutation changed no source`);
  return {
    html: changed,
    metadata: {
      strategy: strategy.id,
      functionName: strategy.functionName,
      changedOccurrences,
      beforeSnippetSha256: sha256(beforeSnippets.join("\n---\n")),
      afterSnippetSha256: sha256(afterSnippets.join("\n---\n")),
      edits: strategy.edits.map(edit => ({
        name: edit.name,
        beforeSnippetSha256: sha256(edit.before),
        afterSnippetSha256: sha256(edit.after),
        ...(strategy.reportSnippets ? {
          beforeSnippet: edit.before,
          afterSnippet: edit.after,
        } : {}),
      })),
    },
  };
}

function strictReport(html, name) {
  const target = path.join(temporary, `${name}.html`);
  fs.writeFileSync(target, html);
  const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, "strict-runner.cjs"), target], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseMutationStrictRun(run, name);
}

const legacyOccupiedTargetGuard = "if(getSdeVehicleInSlot(mainTargetSlot)) return null;";
const canonicalOccupiedTargetGate = "const targetOccupiedByOtherVehicle = targetOccupiedByOtherVehicleBeforeSequence";
const legacyVnFirstReturn = "return Array.from(new Set([...(preferDedicatedVn ? [\"VN\"] : []),...ordinaryCandidates]));";
const canonicalLocalFirstReturn = "return Array.from(new Set([...ordinaryCandidates,...(preferDedicatedVn ? [\"VN\"] : [])]));";
const forcedVnFirstReturn = "return preferDedicatedVn ? [\"VN\", ...ordinaryCandidates.filter(slot=>slot !== \"VN\")] : ordinaryCandidates; /* mutation: force VN before local relief */";
const localReturnValidation = "if(!returnAccessOption) return null;";
const bypassedLocalReturnValidation = "if(false && !returnAccessOption) return null; /* mutation: bypass mandatory local return validation */";
const legacyProjectedCardOrder = "...(reader.cardProjection.actionableCards || []),\n    ...(reader.cardProjection.handlerBlockedCards || []),\n    ...(reader.cardProjection.blockedChainCards || []),\n    ...(reader.cardProjection.exitingCards || [])";
const reversedLegacyProjectedCardOrder = "...(reader.cardProjection.actionableCards || []).reverse(),\n    ...(reader.cardProjection.handlerBlockedCards || []),\n    ...(reader.cardProjection.blockedChainCards || []),\n    ...(reader.cardProjection.exitingCards || []).reverse()";
const reorderedLegacyPlaceholderCards = "...(reader.cardProjection.exitingCards || []),\n    ...(reader.cardProjection.actionableCards || []),\n    ...(reader.cardProjection.handlerBlockedCards || []),\n    ...(reader.cardProjection.blockedChainCards || [])";
const legacyProjectedCardsFunction = `function getSdeCanonicalProductionProjectedCards(reader){
  return [
    ${legacyProjectedCardOrder}
  ];
}`;
const reversedLegacyProjectedCardsFunction = legacyProjectedCardsFunction.replace(legacyProjectedCardOrder, reversedLegacyProjectedCardOrder);
const reorderedLegacyPlaceholderCardsFunction = legacyProjectedCardsFunction.replace(legacyProjectedCardOrder, reorderedLegacyPlaceholderCards);
const canonicalFinalCardOrder = "if(left.exiting !== right.exiting) return left.exiting ? -1 : 1;\n    if(left.exiting && right.exiting && left.cancelledAtMs !== right.cancelledAtMs){\n      return left.cancelledAtMs - right.cancelledAtMs;\n    }";
const reversedCanonicalFinalCardOrder = "if(left.exiting !== right.exiting) return left.exiting ? 1 : -1; /* mutation: replacement before exiting */\n    if(left.exiting && right.exiting && left.cancelledAtMs !== right.cancelledAtMs){\n      return right.cancelledAtMs - left.cancelledAtMs; /* mutation: newest exiting first */\n    }";
const removedCancelledCard = 'if(cancelledUiState.hidden) return "";';
const retainedCancelledCardPlaceholder = 'if(cancelledUiState.hidden) return `<article class="sde-shift-card sde-mutation-placeholder" data-sde-canonical-card-id="${card.canonicalCardId}" data-sde-placeholder="true" style="display:block;min-width:240px;min-height:1px"></article>`;';
const executableOnlyVisibleCardsFunction = `function getSdeCanonicalProductionVisibleCards(reader){
  return orderSdeCanonicalProductionProjectedCards(
    (reader.cardProjection.actionableCards || []).filter(card=>{
      const adapter = reader.handlerAdapters?.[card.canonicalCardId];
      return card.status === "actionable"
        && adapter?.ready === true
        && (adapter.canComplete === true || adapter.canCancel === true);
    })
  );
}`;
const lifecycleVisibleCardsFunction = `function getSdeCanonicalProductionVisibleCards(reader){
  const actionableCards = (reader.cardProjection.actionableCards || []).filter(card=>{
      const adapter = reader.handlerAdapters?.[card.canonicalCardId];
      return card.status === "actionable"
        && adapter?.ready === true
        && (adapter.canComplete === true || adapter.canCancel === true);
    });
  return orderSdeCanonicalProductionProjectedCards([
    ...actionableCards,
    ...(reader.cardProjection.handlerBlockedCards || []),
    ...(reader.cardProjection.blockedChainCards || []),
    ...(reader.cardProjection.exitingCards || [])
  ]);
}`;

const mutations = [
  {
    id: "A-bypass-cancellation-modal",
    apply: html => replaceOnce(html, 'const learningReason = await getSdeMoveLearningReason("cancelled", {', 'const learningReason = getSdeNoMoveLearningReason("modal bypass"); /* mutation */ void ({', "modal bypass"),
    catches: ["INV-CANCEL-001"],
  },
  {
    id: "B-mutate-cancellation-state-before-save",
    apply: html => replaceOnce(
      html,
      'const learningReason = await getSdeMoveLearningReason("cancelled", {',
      'state.sdeMoveActions.__mutation_before_save={action:"cancelled"}; /* mutation */ const learningReason = await getSdeMoveLearningReason("cancelled", {',
      "before-save state",
    ),
    catches: ["INV-CANCEL-002"],
  },
  {
    id: "C-mutate-state-on-modal-cancel",
    apply: html => replaceOnce(
      html,
      "const cancel = () => finish(null);",
      'const cancel = () => { state.sdeMoveActions.__mutation_cancel={action:"cancelled"}; finish(null); };',
      "modal Cancel state",
    ),
    catches: ["INV-CANCEL-003"],
  },
  {
    id: "D-remove-learning-reason-and-comment",
    apply: html => replaceOnce(
      replaceOnce(html, "reasonCode:primaryReason.code,", 'reasonCode:"no_reason",', "learning reason"),
      "commentText,\n      reasonCatalogVersion:1",
      'commentText:"",\n      reasonCatalogVersion:1',
      "learning comment",
    ),
    catches: ["INV-CANCEL-004"],
  },
  {
    id: "E-remove-exiting-status",
    apply: html => replaceOnce(html, 'status:"dismissing",', 'status:"removed",', "exiting status"),
    catches: ["INV-CANCEL-005"],
  },
  {
    id: "F-remove-replacement-authority",
    apply: html => replaceOnce(
      html,
      "cancellationRecord.replacedByCardId = replacementKey;",
      'cancellationRecord.replacedByCardId = ""; /* mutation */',
      "replacement authority",
    ),
    catches: ["INV-CANCEL-006"],
  },
  {
    id: "G-change-5-plus-2",
    apply: html => replaceOnce(replaceOnce(html, "const SDE_RELEASE_CANCELLED_HOLD_MS = 5000;", "const SDE_RELEASE_CANCELLED_HOLD_MS = 4000;", "hold time"), "const SDE_RELEASE_CANCELLED_EXIT_MS = 2000;", "const SDE_RELEASE_CANCELLED_EXIT_MS = 1000;", "exit time"),
    catches: ["INV-CANCEL-007", "INV-CANCEL-008"],
  },
  {
    id: "H-hide-ordered-and-exiting-cards",
    apply: html => applySemanticStrategy(html, [{
      id: "hide-ordered-and-exiting-production-cards",
      functionName: "getSdeCanonicalProductionVisibleCards",
      reportSnippets: true,
      matches: sourceValue => countOccurrences(sourceValue, lifecycleVisibleCardsFunction) === 1,
      edits: [{
        name: "hide ordered and exiting cards",
        before: lifecycleVisibleCardsFunction,
        after: executableOnlyVisibleCardsFunction,
      }],
    }], "ordered and exiting card visibility"),
    catches: ["INV-CANCEL-010", "INV-CANCEL-011"],
  },
  {
    id: "I-keep-placeholder-after-removeAt",
    apply: html => applySemanticStrategy(html, [{
      id: "expose-all-cards-and-retain-placeholder",
      functionName: "getSdeCanonicalProductionVisibleCards + buildSdeCanonicalProductionCardHtml",
      reportSnippets: true,
      matches: sourceValue => countOccurrences(sourceValue, lifecycleVisibleCardsFunction) === 1
        && countOccurrences(sourceValue, removedCancelledCard) === 1,
      edits: [
        {name: "retain measurable cancelled-card layout placeholder", before: removedCancelledCard, after: retainedCancelledCardPlaceholder},
      ],
    }], "placeholder after removeAt"),
    catches: ["INV-CANCEL-012", "INV-CANCEL-013"],
  },
  {
    id: "G-allow-occupied-target-card",
    apply: html => applySemanticStrategy(html, [
      {
        id: "legacy-late-access-relief-guard",
        functionName: "buildSdeTemporaryAccessReliefChainPlan",
        matches: sourceValue => countOccurrences(sourceValue, legacyOccupiedTargetGuard) === 1
          && countOccurrences(sourceValue, canonicalOccupiedTargetGate) === 0,
        edits: [{
          name: "late occupied-target guard",
          before: legacyOccupiedTargetGuard,
          after: "if(false && getSdeVehicleInSlot(mainTargetSlot)) return null; /* mutation: allow occupied target */",
        }],
      },
      {
        id: "canonical-early-target-occupancy-gate",
        functionName: "buildSdeCanonicalPlan",
        matches: sourceValue => countOccurrences(sourceValue, canonicalOccupiedTargetGate) === 1,
        edits: [{
          name: "early canonical occupied-target gate",
          before: canonicalOccupiedTargetGate,
          after: "const targetOccupiedByOtherVehicle = false && targetOccupiedByOtherVehicleBeforeSequence",
        }],
      },
    ], "occupied target guard"),
    catches: ["INV-TARGET-004", "INV-TARGET-007", "INV-TARGET-008"],
  },
  {
    id: "H-rank-VN-before-local-south",
    apply: html => applySemanticStrategy(html, [
      {
        id: "legacy-vn-first-ranking",
        functionName: "getSdePhysicalBlockerAccessReliefCandidateOrder + buildSdeTemporaryAccessReliefChainPlan",
        matches: sourceValue => countOccurrences(sourceValue, legacyVnFirstReturn) === 1
          && countOccurrences(sourceValue, canonicalLocalFirstReturn) === 0,
        edits: [
          {name: "candidate ranking", before: legacyVnFirstReturn, after: forcedVnFirstReturn},
          {name: "local return validation", before: localReturnValidation, after: bypassedLocalReturnValidation},
        ],
      },
      {
        id: "canonical-local-first-ranking",
        functionName: "getSdePhysicalBlockerAccessReliefCandidateOrder + buildSdeTemporaryAccessReliefChainPlan",
        matches: sourceValue => countOccurrences(sourceValue, canonicalLocalFirstReturn) === 1
          && countOccurrences(sourceValue, legacyVnFirstReturn) === 0,
        edits: [
          {name: "candidate ranking", before: canonicalLocalFirstReturn, after: forcedVnFirstReturn},
          {name: "local return validation", before: localReturnValidation, after: bypassedLocalReturnValidation},
        ],
      },
    ], "VN rank"),
    catches: ["INV-RELIEF-001", "INV-RELIEF-002", "INV-RELIEF-003", "INV-RELIEF-007"],
  },
  {
    id: "I-remove-mandatory-recovery",
    apply: html => replaceOnce(html, "function buildSdeTemporaryAccessReturnRow(plan){\n  if(", "function buildSdeTemporaryAccessReturnRow(plan){\n  return null;\n  if(", "mandatory recovery"),
    catches: ["INV-RELIEF-009"],
  },
  {
    id: X1_MUTANT_ID,
    apply: applyX1Mutation,
    catches: [...X1_EXPECTED_INVARIANT_IDS],
  },
  {
    id: "X2-ignore-contextual-rejected-target",
    apply: html => replaceOnce(
      html,
      "const manualRejectedTargets = new Set(retargetIntent?.rejectedTargets || []);",
      "const manualRejectedTargets = new Set(); /* mutation: ignore user rejection */",
      "contextual rejected target",
    ),
    catches: ["INV-REROUTE-002", "INV-REROUTE-006"],
  },
  {
    id: "X3-bypass-whole-chain-target-filter",
    apply: html => replaceOnce(
      html,
      "if(!candidateOrder.includes(targetSlot)) return {ok:false,reason:`${targetSlot} er ikke en fysisk og tidsmessig validert kandidat i denne kjeden.`};",
      "if(false && !candidateOrder.includes(targetSlot)) return {ok:false,reason:`${targetSlot} er ikke en fysisk og tidsmessig validert kandidat i denne kjeden.`}; /* mutation */",
      "whole-chain candidate filter",
    ),
    catches: ["INV-REROUTE-003"],
  },
  {
    id: "X4-retain-old-retarget-resource-identity",
    apply: html => replaceOnce(
      html,
      "normalizeSdeCanonicalToken(producer).toLowerCase() || \"other\", targetSlot || \"targetless\", exiting ? \"exiting\" : \"operative\"",
      "normalizeSdeCanonicalToken(producer).toLowerCase() || \"other\", row?.sdeCanonicalRetargetOriginalTarget || targetSlot || \"targetless\", exiting ? \"exiting\" : \"operative\" /* mutation: retain old resource identity */",
      "retarget resource identity",
    ),
    catches: ["INV-REROUTE-005"],
  },
  {
    id: "X5-drop-mandatory-retarget-recovery",
    apply: html => replaceOnce(
      html,
      "function buildSdeCanonicalAlternateReliefReturnRow(plan){\n  if(",
      "function buildSdeCanonicalAlternateReliefReturnRow(plan){\n  return null; /* mutation: drop recovery */\n  if(",
      "retarget mandatory recovery",
    ),
    catches: ["INV-REROUTE-002", "INV-REROUTE-004"],
    any: true,
  },
  {
    id: "Y1-SINGLE-BLOCKER-CAP",
    apply: html => replaceOnce(
      html,
      "const candidateBlockers = [...blockingItems]; // SDE_EGRESS_ALL_BLOCKERS",
      "const candidateBlockers = [...blockingItems].slice(0,1); // mutation: single blocker cap",
      "all recursive blockers",
    ),
    catches: ["INV-EGRESS-002", "INV-EGRESS-003"],
  },
  {
    id: "Y2-OMIT-RELEASE-OR-RECOVERY",
    apply: html => replaceOnce(
      html,
      "const recoverySteps = releaseSteps.slice().reverse(); // SDE_EGRESS_MANDATORY_RECOVERY",
      "const recoverySteps = []; // mutation: omit mandatory recovery",
      "mandatory trapped recovery",
    ),
    catches: ["INV-EGRESS-001", "INV-EGRESS-005", "INV-EGRESS-006", "INV-EGRESS-010"],
  },
  {
    id: "Y3-WRONG-DEPENDENCY-ORDER",
    apply: html => replaceOnce(
      html,
      "const mainDependencies = releaseActionKeys.length ? [releaseActionKeys.at(-1)] : []; // SDE_EGRESS_MAIN_DEPENDENCIES",
      "const mainDependencies = []; // mutation: main becomes actionable before prerequisites",
      "trapped dependency order",
    ),
    catches: ["INV-EGRESS-004", "INV-EGRESS-005"],
  },
  {
    id: "Y4-PARTIAL-RESOURCE-PROJECTION",
    apply: html => replaceOnce(
      html,
      "sdeTrappedEgressRouteResources:[...step.routeResources], // SDE_EGRESS_COMPLETE_RESOURCES",
      "sdeTrappedEgressRouteResources:[], // mutation: partial resource projection",
      "trapped route resources",
    ),
    catches: ["INV-EGRESS-005", "INV-EGRESS-010", "INV-EGRESS-011"],
  },
  {
    id: "Y5-ORIGINAL-SNAPSHOT-AFTER-PROGRESS",
    apply: html => replaceOnce(
      html,
      "const source = state.grunnoppstilling || {}; // SDE_EGRESS_FRESH_ACTUAL",
      "const source = globalThis.__sdeEgressOriginalSnapshot || (globalThis.__sdeEgressOriginalSnapshot={...(state.grunnoppstilling||{})}); // mutation: original snapshot",
      "fresh trapped actual state",
    ),
    catches: ["INV-EGRESS-009", "INV-EGRESS-011"],
  },
  {
    id: "Y6-RETARGET-BOUND-TO-CANCEL",
    apply: html => replaceOnce(
      html,
      "canRetarget:Boolean(canRetarget), // SDE_RETARGET_CAPABILITY_INDEPENDENT",
      "canRetarget:Boolean(canRetarget && !recoveryRequired && !(outcome.dependencies||[]).length), // mutation: bind retarget to cancel/actionable",
      "nested retarget independence",
    ),
    catches: ["INV-EGRESS-008", "INV-REROUTE-004"],
  },
  {
    id: "Y7-UNSAFE-CANDIDATE-OR-TARGET-OVERRIDE",
    apply: html => replaceOnce(
      html,
      "const requestedTarget = normalizeSlot(row?.recommendedSlot || row?.toSlot); // SDE_EGRESS_REQUESTED_TARGET",
      "const requestedTarget = getSdeResolutionCandidateSlots(row?.fromSlot||row?.arrivalSlot)[0] || normalizeSlot(row?.recommendedSlot||row?.toSlot); // mutation: override user target",
      "requested trapped target",
    ),
    catches: ["INV-EGRESS-007", "INV-EGRESS-010", "INV-EGRESS-012"],
  },
  {
    id: "Y8-RECURSIVE-DRAG-BYPASSES-COMPLETE-EGRESS",
    apply: html => replaceOnce(
      html,
      "getSdeCompleteTrappedEgressBlockState(blockedMoveRequest, getSdeHardPhysicalBlockStateForMove(blockedMoveRequest)) // SDE_EGRESS_GRAPHIC_COMPLETE_BLOCK_STATE",
      "getSdeHardPhysicalBlockStateForMove(blockedMoveRequest) /* mutation: bypass complete recursive egress */",
      "recursive graphical complete block state",
    ),
    catches: ["INV-EGRESS-013"],
  },
  {
    id: "Y9-DROP-ACTIONABLE-MID-CHAIN-SUFFIX",
    apply: html => replaceOnce(
      html,
      "&& (row.sdeTrappedEgressChainStep === true || row.sdePhysicalDependsOn.map(value=>String(value || \"\").trim()).filter(Boolean).length) // SDE_EGRESS_ACTIONABLE_SUFFIX",
      "&& row.sdeTrappedEgressChainStep !== true && row.sdePhysicalDependsOn.map(value=>String(value || \"\").trim()).filter(Boolean).length /* mutation: drop trapped-egress actionable suffix */",
      "actionable mid-chain suffix",
    ),
    catches: ["INV-EGRESS-014"],
  },
  {
    id: "Y10-NULL-MATCHMEDIA-DEREFERENCE",
    apply: html => replaceOnce(
      html,
      "return mediaQuery?.matches === true; // SDE_EGRESS_NULL_SAFE_MOTION",
      "return mediaQuery.matches === true; /* mutation: null MediaQueryList dereference */",
      "null-safe reduced motion",
    ),
    catches: ["INV-EGRESS-015"],
  },
  {
    id: "Z1-DROP-PARENT-INTENT-ON-PREREQUISITE-CANCEL",
    apply: html => replaceOnce(
      html,
      "const parentIntent = getSdePrerequisiteCancellationParentIntent(cancelledRow, data); // SDE_PREREQUISITE_CANCEL_PRESERVE_PARENT",
      "const parentIntent = null; /* mutation: drop parent intent */",
      "prerequisite parent intent",
    ),
    catches: ["INV-EGRESS-016", "INV-EGRESS-017"],
  },
  {
    id: "Z2-REUSE-REJECTED-CHAIN",
    apply: html => replaceOnce(
      html,
      "const rejection = setSdeCanonicalRetargetIntent(cancelledRow, {mode:\"reject_target\", rejectedTarget}); // SDE_PREREQUISITE_CANCEL_CONTEXTUAL_REJECTION",
      "const rejection = {ok:true,intent:null}; /* mutation: reuse rejected chain */",
      "contextual prerequisite rejection",
    ),
    catches: ["INV-EGRESS-017", "INV-EGRESS-019"],
  },
  {
    id: "Z3-COMMIT-PARTIAL-CANCELLED-CHAIN",
    apply: html => replaceOnce(
      html,
      "const atomicReplacement = replacement; // SDE_PREREQUISITE_CANCEL_ATOMIC_PLAN",
      "const atomicReplacement = replacement?.kind === \"diagnostic\" ? {...replacement,kind:\"complete\",rows:[cancelledRow]} : {...replacement,rows:(replacement?.rows||[]).filter(row=>row.sdePhysicalDependencyRole===\"return\")}; /* mutation: partial cancelled chain */",
      "atomic prerequisite replacement",
    ),
    catches: ["INV-EGRESS-018", "INV-EGRESS-020"],
  },
  {
    id: "Z4-RETAIN-STALE-CANCELLED-RESOURCES",
    apply: html => replaceOnce(
      html,
      "const staleOutcomeIds = getSdePrerequisiteCancellationStaleOutcomeIds(cancelledRow, parentIntent, data); // SDE_PREREQUISITE_CANCEL_STALE_RESOURCES",
      "const staleOutcomeIds = []; /* mutation: retain stale cancelled resources */",
      "stale prerequisite resources",
    ),
    catches: ["INV-EGRESS-019"],
  },
  {
    id: "Z5-POISON-GLOBAL-DRAG-AFTER-CHAIN-FAILURE",
    apply: html => applySemanticStrategy(html, [{
      id: "current-prerequisite-cancellation-finalizer",
      functionName: "handleSdeShiftMoveAction/finalizeSdePrerequisiteCancellationTransientDragState",
      matches: sourceValue => countOccurrences(sourceValue, "finalizeSdePrerequisiteCancellationTransientDragState(); // SDE_PREREQUISITE_CANCEL_DRAG_CLEANUP") === 1,
      edits: [{
        name: "post-cancellation drag cleanup",
        before: "finalizeSdePrerequisiteCancellationTransientDragState(); // SDE_PREREQUISITE_CANCEL_DRAG_CLEANUP",
        after: "sdeProductionReaderFallbackError = new Error(\"mutation: poison global graphical drag\");",
      }],
    }], "post-cancellation drag cleanup"),
    catches: ["INV-EGRESS-021"],
  },
  {
    id: "PASSIVE-SWEEP-DISABLED",
    apply: html => replaceOnce(
      html,
      "const passiveBlockedSlotSweep = reconcileSdePassiveBlockedSlotRows(snapshot); // SDE_BLOCKED_SLOT_PASSIVE_SWEEP",
      "const passiveBlockedSlotSweep = {enforced:true,operativeRows:(snapshot.legacy?.finalCards||[]).filter(row=>row?.sdeTrappedEgressDiagnosticOnly!==true),findings:[],admittedProtectedChainIds:[]}; /* mutation: passive sweep disabled */",
      "passive blocked-slot sweep",
    ),
    catches: ["INV-BLOCKED-SLOT-002"],
  },
  {
    id: "PARTIAL-PROJECTION-ALLOWED",
    apply: html => replaceOnce(
      html,
      "if(!structural.complete){ // SDE_BLOCKED_SLOT_COMPLETE_PLAN_GATE",
      "if(false && !structural.complete){ /* mutation: partial projection allowed */",
      "blocked-slot complete-plan gate",
    ),
    catches: ["INV-BLOCKED-SLOT-003"],
  },
  {
    id: "STALE-HISTORY-OVERRIDES-FRESH-ACTUAL",
    apply: html => replaceOnce(
      html,
      "if(occupiedTarget){ // SDE_BLOCKED_SLOT_FRESH_ACTUAL_AUTHORITY",
      "if(false && occupiedTarget){ /* mutation: stale history overrides fresh actual */",
      "blocked-slot fresh actual authority",
    ),
    catches: ["INV-BLOCKED-SLOT-005"],
  },
  {
    id: "MANDATORY-RECOVERY-OR-ADAPTER-OMITTED",
    apply: html => replaceOnce(
      html,
      "const initialAdapterCards = getSdeCanonicalProductionProjectedCards(reader).filter(needsHandlerAdapter); // SDE_BLOCKED_SLOT_MANDATORY_ADAPTERS",
      "const initialAdapterCards = getSdeCanonicalProductionProjectedCards(reader).filter(card=>needsHandlerAdapter(card) && card.recoveryRequired!==true); /* mutation: mandatory recovery adapter omitted */",
      "blocked-slot mandatory adapters",
    ),
    catches: ["INV-BLOCKED-SLOT-009"],
  },
];

const reports = [];
let catalogSelfValidation;
try {
  const baseline = strictReport(source, "active-baseline");
  if (baseline.strictExitCode !== 0 || baseline.failIds.length !== 0) throw new Error("active strict baseline must pass before mutation execution");
  const sourceCatalog = validateExactCatalog(mutations.map(item => item.id), ACTIVE_SOURCE_MUTANT_IDS, "source mutant");
  if (!sourceCatalog.ok) throw new Error(sourceCatalog.errors.join("; "));
  const x1Mutation = mutations.find(item => item.id === X1_MUTANT_ID);
  if (!x1Mutation) throw new Error("authoritative X1 mutation is missing");
  let x1Report = null;
  let x1Application = null;

  for (const mutation of mutations) {
    const applied = mutation.apply(source);
    const mutatedSource = typeof applied === "string" ? applied : applied.html;
    const metadata = typeof applied === "string" ? null : applied.metadata;
    if (mutatedSource === source) throw new Error(`${mutation.id}: mutation changed no source`);
    const report = strictReport(mutatedSource, mutation.id);
    const caught = isStructuredMutationKill(mutation, report);
    if (mutation.id === X1_MUTANT_ID) {
      x1Report = report;
      x1Application = {mutatedSource, validation: validateX1MutationApplication(source, mutatedSource)};
    }
    reports.push({
      id: mutation.id,
      status: caught ? "PASS" : "FAIL",
      expectedRedIds: mutation.catches,
      actualFailIds: report.failIds,
      strictExitCode: report.strictExitCode,
      structuredKill: caught && report.strictExitCode === 1,
      ...(metadata || {}),
    });
  }

  catalogSelfValidation = runCatalogSelfValidation({baseline, x1Report, x1Application, x1Mutation});
  if (catalogSelfValidation.status !== "PASS") throw new Error("mutation catalog self-validation failed");

  const metaRun = childProcess.spawnSync(process.execPath, [path.join(__dirname, "qualification-contract-meta.cjs")], {cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024});
  const metaReport = JSON.parse(String(metaRun.stdout || "").trim().split(/\n/).filter(Boolean).at(-1));
  const positive = metaReport.scenarios?.find(item => item.id === "valid-closed-baseline-passes");
  const negativeIds = [
    "nonzero-strict-is-rejected",
    "fail-id-is-rejected",
    "malformed-strict-output-is-rejected",
    "count-mismatch-is-rejected",
    "duplicate-invariant-id-is-rejected",
    "one-of-three-semantic-differences-is-rejected",
    "baseline-exit-one-makes-determinism-red",
  ];
  const negatives = negativeIds.map(id => metaReport.scenarios?.find(item => item.id === id));
  reports.push({id: "qualification-contract-positive", status: metaRun.status === 0 && positive?.status === "PASS" ? "PASS" : "FAIL", expectedExitCode: 0, actualExitCode: metaRun.status});
  reports.push({id: "qualification-contract-fail-closed-negatives", status: metaRun.status === 0 && negatives.every(item => item?.status === "PASS") ? "PASS" : "FAIL", expectedExitCode: 0, actualExitCode: metaRun.status, scenarios: negativeIds});
  const scenarioCatalog = validateScenarioReports(reports);
  if (!scenarioCatalog.ok) {
    const failingReports = reports.filter(item => item.status === "FAIL");
    throw new Error(`${scenarioCatalog.errors.join("; ")}; failingReports=${JSON.stringify(failingReports)}`);
  }
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = reports.filter(item => item.status === "FAIL");
const mutationReports = reports.filter(item=>!item.id.startsWith("qualification-contract-"));
process.stdout.write(`${JSON.stringify({schemaVersion: "sde-mutation-audit-v1", catalogSelfValidation, sourceMutantCounts:{total:mutationReports.length,pass:mutationReports.filter(item=>item.status==="PASS").length,fail:mutationReports.filter(item=>item.status==="FAIL").length}, mutationCounts:{total:mutationReports.length,pass:mutationReports.filter(item=>item.status==="PASS").length,fail:mutationReports.filter(item=>item.status==="FAIL").length}, counts: {total: reports.length, pass: reports.length - failed.length, fail: failed.length}, reports})}\n`);
process.exit(failed.length ? 1 : 0);

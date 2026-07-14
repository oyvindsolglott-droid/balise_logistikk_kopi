"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || ![0, 1].includes(run.status)) throw new Error(`${name} crashed: ${run.error || run.stderr || run.stdout}`);
  const report = JSON.parse(String(run.stdout).trim().split(/\n/).filter(Boolean).at(-1));
  if (report?.counts?.total !== 37 || !Array.isArray(report?.failIds)) {
    throw new Error(`${name} returned an incomplete strict report`);
  }
  return {...report, strictExitCode: run.status};
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
    id: "H-reverse-card-order",
    apply: html => applySemanticStrategy(html, [
      {
        id: "legacy-projected-array-order",
        functionName: "getSdeCanonicalProductionProjectedCards",
        reportSnippets: true,
        matches: sourceValue => countOccurrences(sourceValue, legacyProjectedCardsFunction) === 1
          && countOccurrences(sourceValue, canonicalFinalCardOrder) === 0,
        edits: [{
          name: "legacy projected card order",
          before: legacyProjectedCardsFunction,
          after: reversedLegacyProjectedCardsFunction,
        }],
      },
      {
        id: "canonical-final-local-card-order",
        functionName: "orderSdeCanonicalProductionProjectedCards",
        reportSnippets: true,
        matches: sourceValue => countOccurrences(sourceValue, canonicalFinalCardOrder) === 1,
        edits: [{
          name: "final local exiting and replacement order",
          before: canonicalFinalCardOrder,
          after: reversedCanonicalFinalCardOrder,
        }],
      },
    ], "card order"),
    catches: ["INV-CANCEL-010", "INV-CANCEL-011"],
  },
  {
    id: "I-keep-placeholder-after-removeAt",
    apply: html => applySemanticStrategy(html, [
      {
        id: "legacy-placeholder-and-render-order",
        functionName: "getSdeCanonicalProductionProjectedCards + buildSdeCanonicalProductionCardHtml + renderSdeCanonicalProductionReader",
        reportSnippets: true,
        matches: sourceValue => countOccurrences(sourceValue, legacyProjectedCardsFunction) === 1
          && countOccurrences(sourceValue, canonicalFinalCardOrder) === 0,
        edits: [
          {name: "legacy placeholder order", before: legacyProjectedCardsFunction, after: reorderedLegacyPlaceholderCardsFunction},
          {name: "legacy placeholder", before: removedCancelledCard, after: 'if(cancelledUiState.hidden) return `<article data-sde-canonical-card-id="${card.canonicalCardId}" data-sde-placeholder="true"></article>`;'},
          {name: "legacy placeholder render order", before: "const cardsHtml = projectedCards.map((card,index)=>", after: "const cardsHtml = projectedCards.reverse().map((card,index)=>"},
        ],
      },
      {
        id: "canonical-layout-placeholder-after-removeAt",
        functionName: "buildSdeCanonicalProductionCardHtml",
        reportSnippets: true,
        matches: sourceValue => countOccurrences(sourceValue, canonicalFinalCardOrder) === 1
          && countOccurrences(sourceValue, removedCancelledCard) === 1,
        edits: [{
          name: "retain measurable cancelled-card layout placeholder",
          before: removedCancelledCard,
          after: retainedCancelledCardPlaceholder,
        }],
      },
    ], "placeholder after removeAt"),
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
];

const reports = [];
try {
  for (const mutation of mutations) {
    const applied = mutation.apply(source);
    const mutatedSource = typeof applied === "string" ? applied : applied.html;
    const metadata = typeof applied === "string" ? null : applied.metadata;
    if (mutatedSource === source) throw new Error(`${mutation.id}: mutation changed no source`);
    const report = strictReport(mutatedSource, mutation.id);
    const caught = mutation.any
      ? mutation.catches.some(id => report.failIds.includes(id))
      : mutation.catches.every(id => report.failIds.includes(id));
    reports.push({
      id: mutation.id,
      status: caught ? "PASS" : "FAIL",
      expectedRedIds: mutation.catches,
      actualFailIds: report.failIds,
      strictExitCode: report.strictExitCode,
      ...(metadata || {}),
    });
  }

  const expectedPath = path.join(__dirname, "baseline-expected-failures.json");
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const baselineVariants = [
    {name: "remove-one", ids: expected.expectedFailIds.slice(1)},
    {name: "add-false", ids: [...expected.expectedFailIds, "INV-FALSE-999"]},
  ];
  for (const variant of baselineVariants) {
    const target = path.join(temporary, `${variant.name}.json`);
    fs.writeFileSync(target, `${JSON.stringify({schemaVersion: expected.schemaVersion, expectedFailIds: variant.ids}, null, 2)}\n`);
    const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, "baseline-audit.cjs"), sourcePath, target], {cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024});
    reports.push({id: `baseline-${variant.name}`, status: run.status === 1 ? "PASS" : "FAIL", expectedExitCode: 1, actualExitCode: run.status});
  }
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = reports.filter(item => item.status === "FAIL");
process.stdout.write(`${JSON.stringify({schemaVersion: "sde-mutation-audit-v1", counts: {total: reports.length, pass: reports.length - failed.length, fail: failed.length}, reports})}\n`);
process.exit(failed.length ? 1 : 0);

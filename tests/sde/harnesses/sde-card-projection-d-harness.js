const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync(process.argv[2], "utf8");
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  .map(match=>match[1])
  .find(source=>source.includes("function normalizeSdeCanonicalToken")) || "";
const start = script.indexOf("function normalizeSdeCanonicalToken");
const end = script.indexOf("function getSdeMoveCardDisplayIndex");
assert(start >= 0 && end > start, "canonical block missing");
const canonicalBlock = script.slice(start, end);

global.normalizeSlot = value => String(value || "").trim().toUpperCase();
global.sanitizeVehicleValue = value => String(value || "").trim();
global.getSdeShiftSnapshotHash = value => {
  let hash = 0;
  for(const character of String(value || "")) hash = (Math.imul(31, hash) + character.charCodeAt(0)) | 0;
  return `h${(hash >>> 0).toString(16)}`;
};
global.window = {location:{search:""}};
vm.runInThisContext(canonicalBlock, {filename:"canonical-card-projection.js"});

const buildPlan = vm.runInThisContext("buildSdeCanonicalPlan");
const buildProjection = vm.runInThisContext("buildSdeCanonicalCardProjection");
const buildSnapshot = vm.runInThisContext("buildSdeCanonicalShadowRuntimeSnapshot");
const buildReport = vm.runInThisContext("buildSdeCanonicalShadowReport");

const row = (vehicle, fromSlot, targetSlot, key, extra={}) => ({
  vehicle,
  fromSlot,
  recommendedSlot:targetSlot,
  toSlot:targetSlot,
  stableActionKey:key,
  needKey:`need-${vehicle}`,
  source:"SDE",
  ...extra
});
const actualSources = placements => [{
  source:"canonical-actual",
  selected:true,
  rows:placements.map(([vehicle,slot])=>({slot, mat:vehicle}))
}];
const planFor = (rows, placements, options={}) => buildPlan({
  actualSources:actualSources(placements),
  candidateRows:rows,
  activeAuthorities:options.activeAuthorities || {},
  completedActionKeys:options.completedActionKeys || []
});
const normalized = value => JSON.stringify(value);

function duplicateScenario(vehicle, source, firstTarget, secondTarget){
  const candidates = [
    row(vehicle, source, firstTarget, `${vehicle}-a`),
    row(vehicle, source, secondTarget, `${vehicle}-b`)
  ];
  const plan = planFor(candidates, [[vehicle,source]]);
  const projection = buildProjection(plan);
  assert.strictEqual(projection.actionableCards.length, 0);
  assert.strictEqual(projection.diagnostics.length, 1);
  assert.strictEqual(projection.diagnostics[0].diagnosticType, "competing_targets");
  assert.strictEqual(projection.exitingCards.length, 0);
  assert.strictEqual(projection.activeProposalCount, 0);
  return {candidates, plan, projection};
}

const duplicate6963 = duplicateScenario("69-63", "10S", "12N", "9");
const duplicate7411 = duplicateScenario("74-11", "5N", "5S", "4N");

const authorityRows = [
  row("69-63", "10S", "12N", "authority-a", {sdeActiveOutcomeId:"authority-a"}),
  row("69-63", "10S", "9", "authority-b")
];
const authorityProjection = buildProjection(planFor(authorityRows, [["69-63","10S"]]));
assert.strictEqual(authorityProjection.actionableCards.length, 1);
assert.strictEqual(authorityProjection.actionableCards[0].targetSlot, "12N");
assert.strictEqual(authorityProjection.activeProposalCount, 1);
assert.strictEqual(authorityProjection.actionableCards[0].canComplete, true);

const targetlessRow = row("70-01", "8", "", "targetless", {isSdeCancellationFailClosed:true});
const targetlessProjection = buildProjection(planFor([targetlessRow], [["70-01","8"]]));
assert.strictEqual(targetlessProjection.actionableCards.length, 0);
assert.strictEqual(targetlessProjection.diagnostics.length, 1);
assert.strictEqual(targetlessProjection.diagnostics[0].diagnosticType, "fail_closed_after_cancellation");
assert.strictEqual(targetlessProjection.activeProposalCount, 0);
for(const forbiddenField of ["canComplete","canCancel","canDelete","reservation","overlay"]){
  assert.strictEqual(Object.prototype.hasOwnProperty.call(targetlessProjection.diagnostics[0], forbiddenField), false);
}

const exitingRow = row("71-02", "7", "11", "cancelled-old", {status:"dismissing", sdeCancellationDismissalCard:true});
const replacementRow = row("71-02", "7", "12N", "replacement-new", {isSdeCancellationReplacementMove:true});
const cancellationActions = {"cancelled-old":{
  cancelledAt:"2026-07-13T00:00:00.000Z",
  exitStartedAt:"2026-07-13T00:00:05.000Z",
  removeAt:"2026-07-13T00:00:07.000Z"
}};
const replacementProjection = buildProjection(
  planFor([exitingRow, replacementRow], [["71-02","7"]]),
  {actionRecords:cancellationActions}
);
assert.strictEqual(replacementProjection.actionableCards.length, 1);
assert.strictEqual(replacementProjection.exitingCards.length, 1);
assert.strictEqual(replacementProjection.activeProposalCount, 1);
assert.deepStrictEqual(
  [replacementProjection.exitingCards[0].canComplete, replacementProjection.exitingCards[0].canCancel, replacementProjection.exitingCards[0].canDelete, replacementProjection.exitingCards[0].active],
  [false,false,false,false]
);
assert.strictEqual(replacementProjection.exitingCards[0].exitStartsAt, "2026-07-13T00:00:05.000Z");

const noReplacementProjection = buildProjection(
  planFor([exitingRow], [["71-02","7"]]),
  {actionRecords:cancellationActions}
);
assert.strictEqual(noReplacementProjection.actionableCards.length, 0);
assert.strictEqual(noReplacementProjection.exitingCards.length, 1);
assert.strictEqual(noReplacementProjection.diagnostics.length, 1);
assert.strictEqual(noReplacementProjection.diagnostics[0].diagnosticType, "missing_replacement");
assert.strictEqual(noReplacementProjection.activeProposalCount, 0);

const validSimulatedSourceVnChainRows = [
  row("72-03", "11N", "VN", "vn-step-1", {needKey:"", canonicalChainId:"vn-chain", sdePhysicalDependencyRole:"prerequisite", sdePhysicalChainStep:1, canonicalChainStepActive:true}),
  row("72-04", "11S", "12N", "vn-step-2", {needKey:"", canonicalChainId:"vn-chain", sdePhysicalDependencyRole:"dependent", sdePhysicalChainStep:2, sdePhysicalDependsOn:["vn-step-1"]}),
  row("72-03", "VN", "11S", "vn-step-3", {needKey:"", canonicalChainId:"vn-chain", sdePhysicalDependencyRole:"return", sdePhysicalChainStep:3, sdePhysicalDependsOn:["vn-step-2"]})
];
const vnChainProjection = buildProjection(planFor(validSimulatedSourceVnChainRows, [["72-03","11N"],["72-04","11S"]]));
assert.strictEqual(vnChainProjection.chains.length, 1);
assert.strictEqual(vnChainProjection.chains[0].stepCount, 3);
assert.strictEqual(vnChainProjection.actionableCards.length, 1);
assert.strictEqual(vnChainProjection.blockedChainCards.length, 2);
assert.strictEqual(vnChainProjection.activeProposalCount, 1);
assert.strictEqual(vnChainProjection.actionableCards[0].canComplete, true);
assert(vnChainProjection.blockedChainCards.every(card=>!card.canComplete && !card.canCancel && !card.canDelete));

const concreteRecovery = row("73-04", "VN", "VS", "vn-concrete", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-recovery-73", sdeVnEntryToken:"entry-73"});
const fallbackRecovery = row("73-04", "VN", "", "vn-fallback", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-recovery-73", sdeVnRecoveryStatus:"missing_recovery_metadata"});
const recoveryProjection = buildProjection(planFor([concreteRecovery, fallbackRecovery], [["73-04","VN"]]));
assert.strictEqual(recoveryProjection.actionableCards.length, 1);
assert.strictEqual(recoveryProjection.actionableCards[0].targetSlot, "VS");
assert.strictEqual(recoveryProjection.actionableCards[0].canDelete, false);
assert.strictEqual(recoveryProjection.actionableCards[0].canCancel, false);
assert.strictEqual(recoveryProjection.actionableCards[0].recoveryRequired, true);
assert.strictEqual(recoveryProjection.diagnostics[0].diagnosticType, "suppressed_targetless_candidate");

const independentRows = [row("80-01", "4M", "8", "independent-a"), row("80-02", "5N", "9", "independent-b")];
const independentProjection = buildProjection(planFor(independentRows, [["80-01","4M"],["80-02","5N"]]));
assert.strictEqual(independentProjection.actionableCards.length, 2);
assert.strictEqual(independentProjection.activeProposalCount, 2);
assert.strictEqual(new Set(independentProjection.actionableCards.map(card=>card.obligationId)).size, 2);

const localRow = row("81-01", "6", "10S", "local", {isNightPlacementGenerated:true});
const localProjection = buildProjection(planFor([localRow], [["81-01","6"]]));
assert.strictEqual(localProjection.actionableCards[0].canDelete, true);
assert.strictEqual(localProjection.actionableCards[0].canComplete, true);
assert.strictEqual(localProjection.actionableCards[0].canCancel, true);
assert(!localProjection.actionableCards[0].canonicalCardId.includes("|local"), "legacy card id used as primary identity");
assert.strictEqual(localProjection.cardByOutcomeId[localProjection.actionableCards[0].activeOutcomeId].canonicalCardId, localProjection.actionableCards[0].canonicalCardId);

const physicallyInvalidRow = row("81-02", "6", "10N", "physical-invalid", {canonicalPhysicalValid:false, canonicalPhysicalInvalidReason:"blocked"});
const physicallyInvalidProjection = buildProjection(planFor([physicallyInvalidRow], [["81-02","6"]]));
assert.strictEqual(physicallyInvalidProjection.actionableCards.length, 0);
assert.strictEqual(physicallyInvalidProjection.diagnostics[0].diagnosticType, "physically_invalid");

const directSourceMissingDiagnosticOnlyRow = row("81-03", "6", "10N", "missing-actual");
const directSourceMissingDiagnosticOnlyPlan = planFor([directSourceMissingDiagnosticOnlyRow], []);
const directSourceMissingDiagnosticOnlyProjection = buildProjection(directSourceMissingDiagnosticOnlyPlan);
assert.strictEqual(directSourceMissingDiagnosticOnlyPlan.activeOutcomes.length, 0);
assert.strictEqual(directSourceMissingDiagnosticOnlyProjection.actionableCards.length, 0);
assert.strictEqual(directSourceMissingDiagnosticOnlyProjection.blockedChainCards.length, 0);
assert.strictEqual(directSourceMissingDiagnosticOnlyProjection.diagnostics.length, 1);
assert.strictEqual(directSourceMissingDiagnosticOnlyProjection.diagnostics[0].diagnosticType, "missing_actual_source");

const cycleRows = [
  row("82-01", "7", "8", "cycle-a", {sdePhysicalChainId:"cycle", sdePhysicalChainStep:1, sdePhysicalDependsOn:["cycle-b"]}),
  row("82-01", "8", "9", "cycle-b", {sdePhysicalChainId:"cycle", sdePhysicalChainStep:2, sdePhysicalDependsOn:["cycle-a"]})
];
const cycleProjection = buildProjection(planFor(cycleRows, [["82-01","7"]]));
assert.strictEqual(cycleProjection.actionableCards.length, 0);
assert.strictEqual(cycleProjection.blockedChainCards.length, 0);
assert(cycleProjection.diagnostics.every(item=>item.diagnosticType === "cyclic_dependency"));

const visible = duplicate6963.candidates;
const duplicateComparison = compareSdeCanonicalCardProjectionWithLegacy(duplicate6963.projection, {
  visibleCards:visible,
  activeCards:visible,
  activeButtonCount:4,
  activeCount:2
});
assert(duplicateComparison.classifications.includes("LEGACY_DUPLICATE_ACTIONABLE_CARD"));
assert(duplicateComparison.classifications.includes("LEGACY_ACTIVE_COUNT_MISMATCH"));
assert(duplicateComparison.classifications.includes("CANONICAL_DIAGNOSTIC_ONLY"));
assert(duplicateComparison.classifications.includes("LEGACY_EXTRA_ACTION_BUTTON"));
const targetlessComparison = compareSdeCanonicalCardProjectionWithLegacy(targetlessProjection, {visibleCards:[targetlessRow], activeCards:[targetlessRow], activeButtonCount:1, activeCount:1});
assert(targetlessComparison.classifications.includes("LEGACY_TARGETLESS_ACTION_CARD"));
const missingReplacementComparison = compareSdeCanonicalCardProjectionWithLegacy(noReplacementProjection, {visibleCards:[exitingRow], activeCards:[], activeCount:0});
assert(missingReplacementComparison.classifications.includes("LEGACY_MISSING_REPLACEMENT"));
const cancelledComparison = compareSdeCanonicalCardProjectionWithLegacy(replacementProjection, {visibleCards:[exitingRow, replacementRow], activeCards:[exitingRow, replacementRow], activeButtonCount:2, activeCount:2});
assert(cancelledComparison.classifications.includes("LEGACY_CANCELLED_CARD_STILL_ACTIONABLE"));
const chainComparison = compareSdeCanonicalCardProjectionWithLegacy(vnChainProjection, {visibleCards:validSimulatedSourceVnChainRows, activeCards:[validSimulatedSourceVnChainRows[0]], activeButtonCount:1, activeCount:1});
assert(chainComparison.classifications.includes("LEGITIMATE_CHAIN_CARD_DIFFERENCE"));
const matchComparison = compareSdeCanonicalCardProjectionWithLegacy(localProjection, {visibleCards:[localRow], activeCards:[localRow], activeButtonCount:2, activeCount:1});
assert(matchComparison.classifications.includes("CARD_PROJECTION_MATCH"));

const reportSnapshot = buildSnapshot({
  actualSources:actualSources([["69-63","10S"]]),
  rawMoves:duplicate6963.candidates,
  finalCards:duplicate6963.candidates,
  activeCards:duplicate6963.candidates,
  visibleCards:duplicate6963.candidates,
  activeButtonCount:4,
  activeCount:2
});
const report = buildReport(reportSnapshot, {generatedAt:"2026-07-13T00:00:00.000Z", snapshotMs:0});
assert(report.cardProjection);
assert(report.cardProjectionComparison);
assert(Number.isFinite(report.performance.cardProjectionMs));
assert(Number.isFinite(report.performance.cardProjectionComparisonMs));
JSON.stringify(report);

const deterministicPlan = planFor([...validSimulatedSourceVnChainRows, ...independentRows], [["72-03","11N"],["72-04","11S"],["80-01","4M"],["80-02","5N"]]);
const planBefore = JSON.stringify(deterministicPlan);
const deterministicProjection = normalized(buildProjection(deterministicPlan));
for(let index = 0; index < 3; index += 1) assert.strictEqual(normalized(buildProjection(deterministicPlan)), deterministicProjection);
assert.strictEqual(JSON.stringify(deterministicPlan), planBefore, "projection mutated canonical plan");
for(let index = 0; index < 10; index += 1){
  const permuted = JSON.parse(JSON.stringify(deterministicPlan));
  if(index % 2) permuted.candidateOutcomes.reverse();
  if(index % 3) permuted.outcomesByObligationStep.reverse();
  if(index % 4) permuted.activeOutcomes.reverse();
  permuted.outcomesByObligationStep.forEach(group=>{
    if(index % 2) group.candidates.reverse();
    group.candidates.forEach(candidate=>candidate.legacyAliases?.reverse());
  });
  permuted.activeOutcomes.forEach(candidate=>candidate.legacyAliases?.reverse());
  permuted.activeChains?.forEach(chain=>chain.steps.reverse());
  assert.strictEqual(normalized(buildProjection(permuted)), deterministicProjection, `projection permutation ${index}`);
}

const projectionSource = script.slice(script.indexOf("function buildSdeCanonicalCardProjection"), script.indexOf("const SDE_CANONICAL_SHADOW_CLASSIFICATIONS"));
for(const token of ["document.","innerHTML","localStorage","fetch(","XMLHttpRequest","setTimeout(","setInterval(","addEventListener(","renderSde"]){
  assert(!projectionSource.includes(token), `forbidden projection token ${token}`);
}

console.log(JSON.stringify({
  ok:true,
  scenarios:["69-63","74-11","authority","targetless","cancelled-replacement","cancelled-no-replacement","valid-simulated-source-vn-three-step","vn-recovery-fallback","independent-needs","delete-metadata","physically-invalid","direct-source-missing-is-diagnostic-only","cycle","legacy-comparison"],
  deterministicRuns:3,
  permutations:10,
  performance:report.performance,
  projectionMetadata:report.cardProjection.metadata,
  comparisonClassifications:report.cardProjectionComparison.classifications
}, null, 2));

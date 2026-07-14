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
vm.runInThisContext(canonicalBlock, {filename:"canonical-reservation-projection.js"});

const buildPlan = vm.runInThisContext("buildSdeCanonicalPlan");
const buildCards = vm.runInThisContext("buildSdeCanonicalCardProjection");
const buildReservations = vm.runInThisContext("buildSdeCanonicalReservationProjection");
const compareReservations = vm.runInThisContext("compareSdeCanonicalReservationProjectionWithLegacy");
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
  provenance:"harness-canonical-actual",
  selected:true,
  rows:placements.map(([vehicle,slot])=>({slot, mat:vehicle}))
}];
const project = (rows, placements, options={}) => {
  const plan = buildPlan({
    actualSources:actualSources(placements),
    candidateRows:rows,
    activeAuthorities:options.activeAuthorities || {},
    completedActionKeys:options.completedActionKeys || []
  });
  const cards = buildCards(plan, {actionRecords:options.actionRecords || {}});
  const reservations = buildReservations(plan, cards);
  return {plan,cards,reservations};
};
const hasConflict = (projection,classification) => projection.conflicts.some(item=>item.classification === classification);
const normalized = value => JSON.stringify(value);

const direct = project([row("60-01","1","2","direct")], [["60-01","1"]]);
assert.strictEqual(direct.cards.actionableCards.length, 1);
assert.strictEqual(direct.reservations.actualOccupancies.length, 1);
assert.strictEqual(direct.reservations.actualOccupancies[0].targetSlot, "1");
assert.strictEqual(direct.reservations.actualOccupancies[0].releasedAfterStep, direct.cards.actionableCards[0].stepId);
assert.strictEqual(direct.reservations.reservations.length, 1);
assert.strictEqual(direct.reservations.reservations[0].reservationKind, "direct_target");
assert.strictEqual(direct.reservations.reservations[0].targetSlot, "2");
assert(direct.reservations.reservationsBySlot["2"]);
assert(direct.reservations.reservationsByOutcomeId[direct.cards.actionableCards[0].activeOutcomeId]);

function competing(vehicle, source, firstTarget, secondTarget){
  const result = project([
    row(vehicle, source, firstTarget, `${vehicle}-a`),
    row(vehicle, source, secondTarget, `${vehicle}-b`)
  ], [[vehicle,source]]);
  assert.strictEqual(result.cards.actionableCards.length, 0);
  assert.strictEqual(result.reservations.reservations.length, 0);
  assert(result.cards.diagnostics.some(item=>item.diagnosticType === "competing_targets"));
  return result;
}
const duplicate6963 = competing("69-63","10S","12N","9");
const duplicate7411 = competing("74-11","5N","5S","4N");

const authorityRows = [
  row("69-63","10S","12N","authority-a", {sdeActiveOutcomeId:"authority-a"}),
  row("69-63","10S","9","authority-b")
];
const authority = project(authorityRows, [["69-63","10S"]]);
assert.strictEqual(authority.reservations.reservations.length, 1);
assert.strictEqual(authority.reservations.reservations[0].targetSlot, "12N");
assert(!authority.reservations.reservations.some(item=>item.targetSlot === "9"));

const exitingRow = row("71-02","7","11","cancelled-old", {status:"dismissing", sdeCancellationDismissalCard:true});
const replacementRow = row("71-02","7","12N","replacement-new", {isSdeCancellationReplacementMove:true});
const replacement = project([exitingRow,replacementRow], [["71-02","7"]]);
assert.strictEqual(replacement.cards.exitingCards.length, 1);
assert.strictEqual(replacement.reservations.reservations.length, 1);
assert.strictEqual(replacement.reservations.reservations[0].targetSlot, "12N");
assert(!replacement.reservations.reservations.some(item=>item.targetSlot === "11"));
const noReplacement = project([exitingRow], [["71-02","7"]]);
assert.strictEqual(noReplacement.reservations.reservations.length, 0);
assert.strictEqual(noReplacement.reservations.actualOccupancies[0].targetSlot, "7");

const targetless = project([row("70-01","8","","targetless", {isSdeCancellationFailClosed:true})], [["70-01","8"]]);
assert.strictEqual(targetless.reservations.reservations.length, 0);
assert.strictEqual(targetless.reservations.actualOccupancies.length, 1);

const recoveryRows = [
  row("74-20","VN","10N","recovery-concrete", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-74-20", sdeVnEntryToken:"entry-74-20"}),
  row("74-20","VN","","recovery-fallback", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-74-20", sdeVnRecoveryStatus:"missing_recovery_metadata"})
];
const recovery = project(recoveryRows, [["74-20","VN"]]);
assert.strictEqual(recovery.reservations.actualOccupancies[0].targetSlot, "VN");
assert.strictEqual(recovery.reservations.reservations.length, 1);
assert.strictEqual(recovery.reservations.reservations[0].targetSlot, "10N");
assert.strictEqual(recovery.reservations.reservations[0].reservationKind, "vn_recovery_target");
assert.strictEqual(recovery.cards.actionableCards[0].canDelete, false);
assert(!recovery.reservations.reservations.some(item=>!item.targetSlot));

const occupiedRecovery = project(recoveryRows, [["74-20","VN"],["69-55","10N"]]);
assert.strictEqual(occupiedRecovery.reservations.reservations.length, 0);
assert(hasConflict(occupiedRecovery.reservations,"ACTUAL_OCCUPANCY_CONFLICT"));
assert(hasConflict(occupiedRecovery.reservations,"ACTIONABLE_OUTCOME_WITHOUT_RESERVATION"));

const vnChainRows = [
  row("72-03","11N","VN","vn-step-1", {needKey:"", canonicalChainId:"vn-chain", sdePhysicalDependencyRole:"prerequisite", sdePhysicalChainStep:1, canonicalChainStepActive:true}),
  row("72-04","11S","12N","vn-step-2", {needKey:"", canonicalChainId:"vn-chain", sdePhysicalDependencyRole:"dependent", sdePhysicalChainStep:2, sdePhysicalDependsOn:["vn-step-1"]}),
  row("72-03","VN","11S","vn-step-3", {needKey:"", canonicalChainId:"vn-chain", sdePhysicalDependencyRole:"return", sdePhysicalChainStep:3, sdePhysicalDependsOn:["vn-step-2"]})
];
const vnChain = project(vnChainRows, [["72-03","11N"],["72-04","11S"]]);
assert.strictEqual(vnChain.reservations.reservations.length, 3);
assert.strictEqual(vnChain.reservations.chainTimelines.length, 1);
assert.strictEqual(vnChain.reservations.chainTimelines[0].steps.length, 3);
assert(vnChain.reservations.chainTimelines[0].steps.every(step=>step.accepted));
assert.strictEqual(vnChain.reservations.conflicts.length, 0);
assert(vnChain.reservations.diagnostics.some(item=>item.classification === "LEGITIMATE_SEQUENTIAL_REUSE" && item.slot === "11S"));
assert(vnChain.reservations.reservations.find(item=>item.targetSlot === "VN").routeResources.includes("VS"));

const reuseRows = [
  row("81-01","11S","12N","reuse-out", {canonicalChainId:"reuse-chain", sdePhysicalDependencyRole:"prerequisite", sdePhysicalChainStep:1, canonicalChainStepActive:true}),
  row("81-02","5N","11S","reuse-in", {canonicalChainId:"reuse-chain", sdePhysicalDependencyRole:"dependent", sdePhysicalChainStep:2, sdePhysicalDependsOn:["reuse-out"]})
];
const reuse = project(reuseRows, [["81-01","11S"],["81-02","5N"]]);
assert.strictEqual(reuse.reservations.reservations.length, 2);
assert(reuse.reservations.diagnostics.some(item=>item.classification === "LEGITIMATE_SEQUENTIAL_REUSE"));
const reuseWithoutDependency = project([
  reuseRows[0],
  row("81-02","5N","11S","reuse-in-no-dependency", {canonicalChainId:"reuse-chain", sdePhysicalDependencyRole:"dependent", sdePhysicalChainStep:2})
], [["81-01","11S"],["81-02","5N"]]);
assert(hasConflict(reuseWithoutDependency.reservations,"ACTUAL_OCCUPANCY_CONFLICT"));
assert(hasConflict(reuseWithoutDependency.reservations,"MISSING_DEPENDENCY"));
assert(!reuseWithoutDependency.reservations.reservations.some(item=>item.targetSlot === "11S"));

const independentChains = project([
  row("82-01","1","9","chain-a", {sdePhysicalChainId:"chain-a", sdePhysicalChainStep:1}),
  row("82-02","2","9","chain-b", {sdePhysicalChainId:"chain-b", sdePhysicalChainStep:1})
], [["82-01","1"],["82-02","2"]]);
assert.strictEqual(independentChains.reservations.reservations.length, 0);
assert(hasConflict(independentChains.reservations,"TARGET_INTERVAL_OVERLAP"));
assert(hasConflict(independentChains.reservations,"OVERLAPPING_CHAIN_TARGET"));

const routeConflict = project([
  row("82-11","1","VN","route-a", {canonicalChainId:"route-a", sdePhysicalDependencyRole:"prerequisite", sdePhysicalChainStep:1, canonicalChainStepActive:true}),
  row("82-12","2","VS","route-b", {canonicalChainId:"route-b", sdePhysicalDependencyRole:"prerequisite", sdePhysicalChainStep:1, canonicalChainStepActive:true})
], [["82-11","1"],["82-12","2"]]);
assert.strictEqual(routeConflict.reservations.reservations.length, 0);
assert(hasConflict(routeConflict.reservations,"VN_RESOURCE_OVERLAP"));
assert(hasConflict(routeConflict.reservations,"VS_RESOURCE_OVERLAP"));

const sameVehiclePlan = buildPlan({
  actualSources:actualSources([["83-01","3"]]),
  candidateRows:[row("83-01","3","8","vehicle-a"),row("83-01","3","9","vehicle-b")]
});
const forcedCards = {
  actionableCards:sameVehiclePlan.candidateOutcomes.map(outcome=>({
    canonicalCardId:`forced|${outcome.candidateOutcomeId}`,
    obligationId:outcome.obligationId,
    stepId:outcome.stepId,
    activeOutcomeId:outcome.candidateOutcomeId,
    vehicleId:outcome.vehicleId,
    sourceSlot:outcome.sourceSlot,
    targetSlot:outcome.targetSlot,
    chainId:"",
    sequenceStep:outcome.sequenceStep,
    dependencyIds:[],
    status:"actionable",
    recoveryRequired:false,
    producerProvenance:{producer:outcome.producer,provenance:outcome.provenance},
    legacyAliases:outcome.legacyAliases
  })),
  blockedChainCards:[], exitingCards:[], diagnostics:[]
};
const sameVehicle = buildReservations(sameVehiclePlan, forcedCards);
assert.strictEqual(sameVehicle.reservations.length, 0);
assert(hasConflict(sameVehicle,"VEHICLE_INTERVAL_OVERLAP"));

const occupiedTarget = project([row("84-02","5N","10N","occupied-target")], [["84-01","10N"],["84-02","5N"]]);
assert.strictEqual(occupiedTarget.reservations.reservations.length, 0);
assert(hasConflict(occupiedTarget.reservations,"ACTUAL_OCCUPANCY_CONFLICT"));
assert(hasConflict(occupiedTarget.reservations,"MISSING_RELEASE_STEP"));

const staleActual = project([row("85-01","6","7","stale-source")], [["85-01","5"]]);
assert.strictEqual(staleActual.reservations.reservations.length, 0);
assert(hasConflict(staleActual.reservations,"ACTUAL_OCCUPANCY_CONFLICT"));

const malformedCards = {actionableCards:[{...direct.cards.actionableCards[0], activeOutcomeId:"missing-outcome", targetSlot:""}],blockedChainCards:[],exitingCards:[],diagnostics:[]};
const malformed = buildReservations(direct.plan, malformedCards);
assert(hasConflict(malformed,"TARGETLESS_RESERVATION_ATTEMPT"));
const missingActionable = buildReservations(direct.plan,{actionableCards:[],blockedChainCards:[],exitingCards:[],diagnostics:[]});
assert(hasConflict(missingActionable,"RESERVATION_WITHOUT_ACTIONABLE_OUTCOME"));

const directCanonical = direct.reservations.reservations[0];
const matchComparison = compareReservations(direct.reservations,{reservations:[{targetSlot:"2",vehicle:"60-01",activeOutcomeId:directCanonical.activeOutcomeId}]});
assert(matchComparison.classifications.includes("RESERVATION_PROJECTION_MATCH"));
const duplicateComparison = compareReservations(direct.reservations,{reservations:[{targetSlot:"2",vehicle:"60-01"},{targetSlot:"2",vehicle:"60-01"}]});
assert(duplicateComparison.classifications.includes("LEGACY_DUPLICATE_RESERVATION"));
assert(duplicateComparison.classifications.includes("LEGACY_OVERLAPPING_TARGET"));
const missingComparison = compareReservations(direct.reservations,{reservations:[]});
assert(missingComparison.classifications.includes("LEGACY_MISSING_RESERVATION"));
const diagnosticComparison = compareReservations(duplicate6963.reservations,{reservations:[{targetSlot:"12N",vehicle:"69-63"},{targetSlot:"9",vehicle:"69-63"}]});
assert(diagnosticComparison.classifications.includes("LEGACY_EXTRA_RESERVATION"));
assert(diagnosticComparison.classifications.includes("LEGACY_RESERVATION_FOR_DIAGNOSTIC"));
const sequentialComparison = compareReservations(reuse.reservations,{reservations:[]});
assert(sequentialComparison.classifications.includes("CANONICAL_SEQUENCE_ONLY"));
assert(sequentialComparison.classifications.includes("LEGITIMATE_SEQUENTIAL_DIFFERENCE"));

const deterministicInput = vnChain.plan;
const deterministicCards = vnChain.cards;
const inputBefore = JSON.stringify(deterministicInput);
const cardsBefore = JSON.stringify(deterministicCards);
const baseline = normalized(buildReservations(deterministicInput,deterministicCards));
for(let index=0; index<3; index+=1) assert.strictEqual(normalized(buildReservations(deterministicInput,deterministicCards)), baseline);
assert.strictEqual(JSON.stringify(deterministicInput),inputBefore,"reservation projection mutated canonical plan");
assert.strictEqual(JSON.stringify(deterministicCards),cardsBefore,"reservation projection mutated card projection");
for(let index=0; index<10; index+=1){
  const permutedPlan = JSON.parse(JSON.stringify(deterministicInput));
  const permutedCards = JSON.parse(JSON.stringify(deterministicCards));
  if(index%2) permutedPlan.candidateOutcomes.reverse();
  if(index%3) permutedPlan.activeChains.reverse();
  if(index%4) permutedPlan.actualPlacements.reverse();
  permutedPlan.candidateOutcomes.forEach(outcome=>{ if(index%2) outcome.legacyAliases.reverse(); });
  if(index%2) permutedCards.actionableCards.reverse();
  if(index%3) permutedCards.blockedChainCards.reverse();
  permutedCards.actionableCards.forEach(card=>{ if(index%2) card.legacyAliases.reverse(); });
  permutedCards.blockedChainCards.forEach(card=>{ if(index%2) card.legacyAliases.reverse(); });
  assert.strictEqual(normalized(buildReservations(permutedPlan,permutedCards)), baseline, `reservation permutation ${index}`);
}

const reportSnapshot = buildSnapshot({
  actualSources:actualSources([["60-01","1"]]),
  rawMoves:[row("60-01","1","2","direct")],
  finalCards:[row("60-01","1","2","direct")],
  activeCards:[row("60-01","1","2","direct")],
  activeCount:1,
  legacyReservations:[{targetSlot:"2",vehicle:"60-01"}]
});
const report = buildReport(reportSnapshot,{generatedAt:"2026-07-13T00:00:00.000Z",snapshotMs:0});
assert(report.reservationProjection);
assert(report.reservationProjectionComparison);
assert(Number.isFinite(report.performance.reservationProjectionMs));
assert(Number.isFinite(report.performance.reservationProjectionComparisonMs));
JSON.stringify(report);

const projectionSource = script.slice(script.indexOf("function buildSdeCanonicalReservationProjection"),script.indexOf("const SDE_CANONICAL_SHADOW_CLASSIFICATIONS"));
for(const token of ["document.","innerHTML","localStorage","sessionStorage","fetch(","XMLHttpRequest","setTimeout(","setInterval(","addEventListener(","renderSde","buildSdeMoveReservationMap"]){
  assert(!projectionSource.includes(token),`forbidden reservation projection token ${token}`);
}

console.log(JSON.stringify({
  ok:true,
  scenarios:["direct","69-63","74-11","authority","cancelled-replacement","cancelled-no-replacement","targetless","vn-recovery-fallback","vn-recovery-occupied","vn-three-step","sequential-reuse","reuse-missing-dependency","independent-chain-overlap","vn-vs-resource-overlap","vehicle-overlap","actual-occupancy-conflict","stale-actual","diagnostic-exiting-no-reservation","legacy-comparison"],
  deterministicRuns:3,
  permutations:10,
  reportPerformance:report.performance,
  metadata:vnChain.reservations.metadata,
  vnTimeline:vnChain.reservations.chainTimelines[0],
  occupiedConflictClasses:occupiedTarget.reservations.conflicts.map(item=>item.classification),
  comparisonClasses:{match:matchComparison.classifications,duplicate:duplicateComparison.classifications,sequential:sequentialComparison.classifications}
},null,2));

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync(process.argv[2], "utf8");
const script = html.split("<script>").slice(1).map(part=>part.split("</script>")[0])
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
vm.runInThisContext(canonicalBlock, {filename:"canonical-graphic-projection.js"});

const buildPlan = vm.runInThisContext("buildSdeCanonicalPlan");
const buildCards = vm.runInThisContext("buildSdeCanonicalCardProjection");
const buildReservations = vm.runInThisContext("buildSdeCanonicalReservationProjection");
const buildGraphics = vm.runInThisContext("buildSdeCanonicalGraphicProjection");
const compareGraphics = vm.runInThisContext("compareSdeCanonicalGraphicProjectionWithLegacy");
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
  provenance:"graphic-harness-actual",
  selected:true,
  rows:placements.map(([vehicle,slot])=>({slot,mat:vehicle}))
}];
const project = (rows,placements,options={}) => {
  const plan = buildPlan({
    actualSources:actualSources(placements),
    candidateRows:rows,
    activeAuthorities:options.activeAuthorities || {},
    completedActionKeys:options.completedActionKeys || []
  });
  const cards = buildCards(plan,{actionRecords:options.actionRecords || {}});
  const reservations = buildReservations(plan,cards);
  const graphics = buildGraphics(plan,cards,reservations);
  return {plan,cards,reservations,graphics};
};
const normalized = value => JSON.stringify(value);
const hasDiagnostic = (projection,type) => projection.unresolvedDiagnostics.some(item=>item.diagnosticType === type);
const hasConflict = (projection,type) => projection.conflicts.some(item=>item.classification === type);

const direct = project([row("60-01","1","2","direct")],[["60-01","1"]]);
assert.deepStrictEqual(direct.graphics.actualSlots.map(item=>[item.vehicleId,item.slot]),[["60-01","1"]]);
assert.strictEqual(direct.graphics.activeOverlays.length,1);
assert.strictEqual(direct.graphics.deferredOverlays.length,0);
assert.strictEqual(direct.graphics.activeOverlays[0].targetSlot,"2");
assert.strictEqual(direct.graphics.activeOverlays[0].reservationId,direct.reservations.reservations[0].reservationId);
assert.strictEqual(direct.graphics.activeOverlays[0].canonicalCardId,direct.cards.actionableCards[0].canonicalCardId);
assert(direct.graphics.overlaysByOutcomeId[direct.cards.actionableCards[0].activeOutcomeId]);
assert.strictEqual(direct.graphics.overlaysBySlot["2"].length,1);
assert.strictEqual(direct.graphics.slotRenderModels.find(item=>item.slot === "1").actualOccupancies[0].vehicleId,"60-01");
assert.strictEqual(direct.graphics.metadata.schemaVersion,"sde-canonical-graphic-projection-v1");

function competing(vehicle,source,firstTarget,secondTarget){
  const result = project([
    row(vehicle,source,firstTarget,`${vehicle}-a`),
    row(vehicle,source,secondTarget,`${vehicle}-b`)
  ],[[vehicle,source]]);
  assert.strictEqual(result.graphics.actualSlots[0].slot,source);
  assert.strictEqual(result.graphics.activeOverlays.length,0);
  assert.strictEqual(result.graphics.deferredOverlays.length,0);
  assert(hasDiagnostic(result.graphics,"competing_targets"));
  return result;
}
const duplicate6963 = competing("69-63","10S","12N","9");
const duplicate7411 = competing("74-11","5N","5S","4N");

const authorityRows = [
  row("69-63","10S","12N","authority-a",{sdeActiveOutcomeId:"authority-a"}),
  row("69-63","10S","9","authority-b")
];
const authority = project(authorityRows,[["69-63","10S"]]);
assert.strictEqual(authority.graphics.actualSlots[0].slot,"10S");
assert.strictEqual(authority.graphics.activeOverlays.length,1);
assert.strictEqual(authority.graphics.activeOverlays[0].targetSlot,"12N");
assert.strictEqual(authority.graphics.activeOverlays[0].reservationId,authority.reservations.reservations[0].reservationId);

const exitingRow = row("71-02","7","11","cancelled-old",{status:"dismissing",sdeCancellationDismissalCard:true});
const replacementRow = row("71-02","7","12N","replacement-new",{isSdeCancellationReplacementMove:true});
const replacement = project([exitingRow,replacementRow],[["71-02","7"]]);
assert.strictEqual(replacement.cards.exitingCards.length,1);
assert.strictEqual(replacement.graphics.activeOverlays.length,1);
assert.strictEqual(replacement.graphics.activeOverlays[0].targetSlot,"12N");
assert(!replacement.graphics.activeOverlays.some(item=>item.targetSlot === "11"));
const cancelledOnly = project([exitingRow],[["71-02","7"]]);
assert.strictEqual(cancelledOnly.graphics.activeOverlays.length,0);
assert.strictEqual(cancelledOnly.graphics.actualSlots[0].slot,"7");

const targetless = project([row("70-01","8","","targetless",{isSdeCancellationFailClosed:true})],[["70-01","8"]]);
assert.strictEqual(targetless.graphics.activeOverlays.length,0);
assert(hasDiagnostic(targetless.graphics,"fail_closed_after_cancellation"));

const recoveryRows = [
  row("74-20","VN","10N","recovery-concrete",{sdeVnRecoveryRequired:true,sdeVnRecoveryObligationId:"vn-74-20",sdeVnEntryToken:"entry-74-20"}),
  row("74-20","VN","","recovery-fallback",{sdeVnRecoveryRequired:true,sdeVnRecoveryObligationId:"vn-74-20",sdeVnRecoveryStatus:"missing_recovery_metadata"})
];
const recovery = project(recoveryRows,[["74-20","VN"]]);
assert.strictEqual(recovery.graphics.actualSlots[0].slot,"VN");
assert.strictEqual(recovery.graphics.activeOverlays.length,1);
assert.strictEqual(recovery.graphics.activeOverlays[0].targetSlot,"10N");
assert(hasDiagnostic(recovery.graphics,"suppressed_targetless_candidate"));

const vnChainRows = [
  row("72-03","11N","VN","vn-step-1",{needKey:"",canonicalChainId:"vn-chain",sdePhysicalDependencyRole:"prerequisite",sdePhysicalChainStep:1,canonicalChainStepActive:true}),
  row("72-04","11S","12N","vn-step-2",{needKey:"",canonicalChainId:"vn-chain",sdePhysicalDependencyRole:"dependent",sdePhysicalChainStep:2,sdePhysicalDependsOn:["vn-step-1"]}),
  row("72-03","VN","11S","vn-step-3",{needKey:"",canonicalChainId:"vn-chain",sdePhysicalDependencyRole:"return",sdePhysicalChainStep:3,sdePhysicalDependsOn:["vn-step-2"]})
];
const vnChain = project(vnChainRows,[["72-03","11N"],["72-04","11S"]]);
assert.strictEqual(vnChain.graphics.actualSlots.length,2);
assert.strictEqual(vnChain.graphics.activeOverlays.length,1);
assert.strictEqual(vnChain.graphics.activeOverlays[0].targetSlot,"VN");
assert.strictEqual(vnChain.graphics.deferredOverlays.length,2);
assert.deepStrictEqual(vnChain.graphics.deferredOverlays.map(item=>item.targetSlot).sort(),["11S","12N"]);
assert(vnChain.graphics.deferredOverlays.every(item=>item.dependencyIds.length));
assert.strictEqual(vnChain.graphics.conflicts.length,0);

const reuseRows = [
  row("81-01","11S","12N","reuse-out",{canonicalChainId:"reuse-chain",sdePhysicalDependencyRole:"prerequisite",sdePhysicalChainStep:1,canonicalChainStepActive:true}),
  row("81-02","5N","11S","reuse-in",{canonicalChainId:"reuse-chain",sdePhysicalDependencyRole:"dependent",sdePhysicalChainStep:2,sdePhysicalDependsOn:["reuse-out"]})
];
const sequentialReuse = project(reuseRows,[["81-01","11S"],["81-02","5N"]]);
assert.strictEqual(sequentialReuse.graphics.activeOverlays.length,1);
assert.strictEqual(sequentialReuse.graphics.deferredOverlays.length,1);
assert(!sequentialReuse.graphics.conflicts.length);

const overlap = project([
  row("82-01","1","9","chain-a",{sdePhysicalChainId:"chain-a",sdePhysicalChainStep:1}),
  row("82-02","2","9","chain-b",{sdePhysicalChainId:"chain-b",sdePhysicalChainStep:1})
],[["82-01","1"],["82-02","2"]]);
assert.strictEqual(overlap.graphics.activeOverlays.length,0);
assert(overlap.reservations.conflicts.some(item=>item.classification === "TARGET_INTERVAL_OVERLAP"));

const staleActual = project([row("85-01","6","7","stale-source")],[["85-01","5"]]);
assert.strictEqual(staleActual.graphics.actualSlots[0].slot,"5");
assert.strictEqual(staleActual.graphics.activeOverlays.length,0);
assert(hasDiagnostic(staleActual.graphics,"stale_actual_source") || hasDiagnostic(staleActual.graphics,"ACTUAL_OCCUPANCY_CONFLICT"));

const partialActualPlan = buildPlan({
  actualSources:[
    {source:"canonical-actual",selected:true,rows:[]},
    {source:"legacy-alternative",rows:[{slot:"6",mat:"86-01"}]}
  ],
  candidateRows:[row("86-01","6","8","partial-actual")]
});
const partialCards = buildCards(partialActualPlan);
const partialReservations = buildReservations(partialActualPlan,partialCards);
const partialGraphics = buildGraphics(partialActualPlan,partialCards,partialReservations);
assert.strictEqual(partialGraphics.activeOverlays.length,0);
assert(partialGraphics.unresolvedDiagnostics.some(item=>["actual_source_mismatch","missing_canonical_actual_source","missing_actual_source"].includes(item.diagnosticType)));

const missingReservationGraphics = buildGraphics(direct.plan,direct.cards,{...direct.reservations,reservations:[]});
assert.strictEqual(missingReservationGraphics.activeOverlays.length,0);
assert(hasConflict(missingReservationGraphics,"ACTIONABLE_CARD_WITHOUT_RESERVATION"));
const missingOverlayGraphics = buildGraphics(direct.plan,{...direct.cards,actionableCards:[]},direct.reservations);
assert.strictEqual(missingOverlayGraphics.activeOverlays.length,0);
assert(hasConflict(missingOverlayGraphics,"RESERVATION_WITHOUT_OVERLAY"));
const diagnosticCardProjection = JSON.parse(JSON.stringify(direct.cards));
diagnosticCardProjection.diagnostics.push({
  diagnosticType:"forced_diagnostic",
  obligationId:direct.cards.actionableCards[0].obligationId,
  stepId:direct.cards.actionableCards[0].stepId,
  candidateSummary:[{candidateOutcomeId:direct.cards.actionableCards[0].activeOutcomeId,targetSlot:"2"}]
});
const diagnosticOverlayGraphics = buildGraphics(direct.plan,diagnosticCardProjection,direct.reservations);
assert.strictEqual(diagnosticOverlayGraphics.activeOverlays.length,0);
assert(hasConflict(diagnosticOverlayGraphics,"DIAGNOSTIC_OUTCOME_WITH_OVERLAY"));
const duplicateCardProjection = JSON.parse(JSON.stringify(direct.cards));
duplicateCardProjection.actionableCards.push(JSON.parse(JSON.stringify(duplicateCardProjection.actionableCards[0])));
const duplicateOverlayGraphics = buildGraphics(direct.plan,duplicateCardProjection,direct.reservations);
assert.strictEqual(duplicateOverlayGraphics.activeOverlays.length,0);
assert(hasConflict(duplicateOverlayGraphics,"MULTIPLE_OVERLAYS_FOR_OUTCOME"));
assert(hasConflict(duplicateOverlayGraphics,"MULTIPLE_OVERLAYS_FOR_OBLIGATION_STEP"));

const directOverlay = direct.graphics.activeOverlays[0];
const matchingLegacy = {
  actualSlots:[{slot:"1",mat:"60-01"}],
  overlays:[{sourceSlot:"1",targetSlot:"2",vehicle:"60-01",activeOutcomeId:directOverlay.activeOutcomeId}],
  unresolvedMarkers:[]
};
const matchComparison = compareGraphics(direct.graphics,matchingLegacy);
assert.deepStrictEqual(matchComparison.classifications,["GRAPHIC_PROJECTION_MATCH"]);
const duplicateComparison = compareGraphics(direct.graphics,{...matchingLegacy,overlays:[...matchingLegacy.overlays,...matchingLegacy.overlays]});
assert(duplicateComparison.classifications.includes("LEGACY_DUPLICATE_OVERLAY"));
const missingComparison = compareGraphics(direct.graphics,{actualSlots:matchingLegacy.actualSlots,overlays:[]});
assert(missingComparison.classifications.includes("LEGACY_MISSING_OVERLAY"));
const diagnosticComparison = compareGraphics(duplicate6963.graphics,{
  actualSlots:[{slot:"10S",mat:"69-63"}],
  overlays:[{sourceSlot:"10S",targetSlot:"12N",vehicle:"69-63"}]
});
assert(diagnosticComparison.classifications.includes("LEGACY_EXTRA_OVERLAY"));
assert(diagnosticComparison.classifications.includes("LEGACY_OVERLAY_FOR_DIAGNOSTIC"));
assert(diagnosticComparison.classifications.includes("CANONICAL_DIAGNOSTIC_ONLY"));
const missingActualComparison = compareGraphics(direct.graphics,{overlays:matchingLegacy.overlays,actualSlots:[]});
assert(missingActualComparison.classifications.includes("LEGACY_ACTUAL_SOURCE_MISSING"));
const replacedActualComparison = compareGraphics(direct.graphics,{overlays:matchingLegacy.overlays,actualSlots:[{slot:"2",mat:"60-01"}]});
assert(replacedActualComparison.classifications.includes("LEGACY_ACTUAL_SOURCE_REPLACED_BY_PLAN"));
const chainComparison = compareGraphics(vnChain.graphics,{
  actualSlots:[{slot:"11N",mat:"72-03"},{slot:"11S",mat:"72-04"}],
  overlays:[{sourceSlot:"11N",targetSlot:"VN",vehicle:"72-03"}]
});
assert(chainComparison.classifications.includes("CANONICAL_DEFERRED_OVERLAY_ONLY"));
assert(chainComparison.classifications.includes("LEGITIMATE_CHAIN_OVERLAY_DIFFERENCE"));

const planBefore = normalized(vnChain.plan);
const cardsBefore = normalized(vnChain.cards);
const reservationsBefore = normalized(vnChain.reservations);
const baseline = normalized(buildGraphics(vnChain.plan,vnChain.cards,vnChain.reservations));
for(let index=0;index<3;index+=1) assert.strictEqual(normalized(buildGraphics(vnChain.plan,vnChain.cards,vnChain.reservations)),baseline);
assert.strictEqual(normalized(vnChain.plan),planBefore,"graphic projection mutated canonical plan");
assert.strictEqual(normalized(vnChain.cards),cardsBefore,"graphic projection mutated card projection");
assert.strictEqual(normalized(vnChain.reservations),reservationsBefore,"graphic projection mutated reservation projection");
for(let index=0;index<10;index+=1){
  const plan = JSON.parse(planBefore);
  const cards = JSON.parse(cardsBefore);
  const reservations = JSON.parse(reservationsBefore);
  if(index%2) plan.candidateOutcomes.reverse();
  if(index%3) plan.actualPlacements.reverse();
  if(index%4) plan.conflicts.reverse();
  if(index%2) cards.actionableCards.reverse();
  if(index%3) cards.blockedChainCards.reverse();
  if(index%4) cards.diagnostics.reverse();
  if(index%2) reservations.actualOccupancies.reverse();
  if(index%3) reservations.reservations.reverse();
  if(index%4) reservations.diagnostics.reverse();
  assert.strictEqual(normalized(buildGraphics(plan,cards,reservations)),baseline,`graphic permutation/hydration ${index}`);
}

const reportSnapshot = buildSnapshot({
  actualSources:actualSources([["60-01","1"]]),
  rawMoves:[row("60-01","1","2","direct")],
  finalCards:[row("60-01","1","2","direct")],
  activeCards:[row("60-01","1","2","direct")],
  activeCount:1,
  legacyReservations:[{targetSlot:"2",vehicle:"60-01"}],
  legacyOverlays:[{sourceSlot:"1",targetSlot:"2",vehicle:"60-01"}]
});
const report = buildReport(reportSnapshot,{generatedAt:"2026-07-13T00:00:00.000Z",snapshotMs:0});
assert(report.graphicProjection);
assert(report.graphicProjectionComparison);
assert.strictEqual(report.graphicProjection.activeOverlays.length,1);
assert(Number.isFinite(report.performance.graphicProjectionMs));
assert(Number.isFinite(report.performance.graphicProjectionComparisonMs));
JSON.stringify(report);

const projectionSource = script.slice(script.indexOf("function buildSdeCanonicalGraphicProjection"),script.indexOf("const SDE_CANONICAL_SHADOW_CLASSIFICATIONS"));
for(const token of ["document.","innerHTML","localStorage","sessionStorage","fetch(","XMLHttpRequest","setTimeout(","setInterval(","addEventListener(","renderSde","persist("]){
  assert(!projectionSource.includes(token),`forbidden graphic projection token ${token}`);
}

console.log(JSON.stringify({
  ok:true,
  scenarios:["actual-slot","active-overlay","69-63","74-11","authority","cancelled-exiting","targetless-fail-closed","vn-recovery","vn-three-step","target-overlap","sequential-reuse","actual-source-mismatch","partial-actual-state","card-reservation-overlay-invariants","legacy-graphic-comparison"],
  deterministicRuns:3,
  permutationsAndHydrationOrders:10,
  directMetadata:direct.graphics.metadata,
  chainMetadata:vnChain.graphics.metadata,
  chainOverlayTargets:{active:vnChain.graphics.activeOverlays.map(item=>item.targetSlot),deferred:vnChain.graphics.deferredOverlays.map(item=>item.targetSlot)},
  comparisonClasses:{match:matchComparison.classifications,diagnostic:diagnosticComparison.classifications,chain:chainComparison.classifications},
  reportPerformance:report.performance
},null,2));

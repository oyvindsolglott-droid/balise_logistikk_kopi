"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(process.argv[2], "utf8");
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  .map(match=>match[1])
  .find(source=>source.includes("function normalizeSdeCanonicalToken")) || "";
const canonicalStart = script.indexOf("function normalizeSdeCanonicalToken");
const canonicalEnd = script.indexOf("function getSdeMoveCardDisplayIndex", canonicalStart);
const readerStart = script.indexOf("let sdeProductionReaderFallbackError", canonicalEnd);
const readerEnd = script.indexOf("function buildSdeLimitedPlanningData", readerStart);
assert.ok(canonicalStart >= 0 && canonicalEnd > canonicalStart, "canonical block missing");
assert.ok(readerStart > canonicalEnd && readerEnd > readerStart, "production reader block missing");

global.normalizeSlot = value=>String(value || "").trim().toUpperCase();
global.sanitizeVehicleValue = value=>String(value || "").trim();
global.haveSameSdeVehicleTokens = (left,right)=>sanitizeVehicleValue(left) === sanitizeVehicleValue(right);
global.getSdeShiftSnapshotHash = value=>String(value || "").length.toString(16);
global.window = {location:{search:"",hostname:"localhost"}};
global.escapeHtml = value=>String(value ?? "");
global.getSdeMoveActionKey = row=>String(row?.sdeNightPlacementGeneratedActionKey || row?.stableActionKey || row?.actionKey || "").trim();
global.getSdeMoveActionLookupKeys = row=>Array.from(new Set([
  getSdeMoveActionKey(row),
  String(row?.sdeNightPlacementOriginalActionKey || "").trim()
].filter(Boolean)));
global.getSdeMoveCardDeleteBlockReason = ()=>"";
global.buildSdeCanonicalPendulumPreviewDiagnostics = ()=>[];
global.buildSdeDiagnosticSectionHtml = options=>`${options.title}|${options.count}|${options.bodyHtml}`;

vm.runInThisContext(script.slice(canonicalStart, canonicalEnd), {filename:"canonical-models.js"});
vm.runInThisContext(script.slice(readerStart, readerEnd), {filename:"canonical-reader.js"});

const outcomeKey = "move|need-69-55|69-55|5M|direct-1";
const base = {
  vehicle:"69-55",
  fromSlot:"5M",
  arrivalSlot:"5M",
  originalFromSlot:"5M",
  needKey:"need-69-55",
  sdeCancellationNeedKey:"need-69-55",
  canonicalPurpose:"night-parking",
  source:"SDE"
};
const activeRow = (targetSlot, actionKey, round=1)=>({
  ...base,
  stableActionKey:actionKey,
  actionKey,
  recommendedSlot:targetSlot,
  toSlot:targetSlot,
  sdeCanonicalOutcomeKey:outcomeKey,
  sdeOutcomeKey:outcomeKey,
  sdeOutcomeActive:true,
  sdeActiveOutcomeId:actionKey,
  sdeCancellationRoundNumber:round,
  isWrongTrackReplacementMove:true,
  isSdeCancellationReplacementMove:true,
  recommendationReason:"Nytt fysisk vurdert forslag etter Annullert."
});
const exitingRow = (targetSlot, actionKey, replacementKey, round=1)=>({
  ...base,
  stableActionKey:actionKey,
  actionKey,
  recommendedSlot:targetSlot,
  toSlot:targetSlot,
  sdeCanonicalOutcomeKey:outcomeKey,
  sdeOutcomeKey:outcomeKey,
  sdeOutcomeActive:false,
  sdeActiveOutcomeId:replacementKey,
  sdeCancellationRoundNumber:round,
  sdeCancellationDismissalCard:true,
  recommendationReason:"Annullert. Kortet avsluttes."
});
const makeSnapshot = (rows, activeActionKey, actions={})=>({
  schemaVersion:"sde-canonical-shadow-runtime-v1",
  actualSources:[{source:"canonical-actual",provenance:"q-harness",selected:true,rows:[{vehicleId:"69-55",slot:"5M"}]}],
  actualStateReconciliation:{diagnostics:[]},
  legacy:{finalCards:rows,activeCards:rows.filter(row=>!row.sdeCancellationDismissalCard),visibleCards:rows,activeButtonCount:0,activeCount:1,reservations:[],overlays:[],actualSlots:[{vehicleId:"69-55",slot:"5M"}],unresolvedMarkers:[]},
  runtimeState:{actions,activeAuthorities:{[outcomeKey]:{activeOutcomeId:activeActionKey}}},
  infrastructure:{}
});
const cancelledRecord = (row,replacementKey,targetSlot)=>({
  action:"cancelled",
  outcomeKey,
  activeOutcomeId:replacementKey,
  replacedByCardId:replacementKey,
  replacementTargetSlot:targetSlot,
  snapshot:row
});

const originalKey = "move-69-55-5M-1N";
const replacementKey = "sde-cancel-replacement|69-55|r1|1S";
const old1N = exitingRow("1N",originalKey,replacementKey,1);
const replacement1S = activeRow("1S",replacementKey,1);
const firstReader = buildSdeCanonicalProductionReader(makeSnapshot(
  [old1N,replacement1S],
  replacementKey,
  {[originalKey]:cancelledRecord(old1N,replacementKey,"1S")}
));
assert.equal(firstReader.cardProjection.actionableCards.length,1);
assert.equal(firstReader.cardProjection.handlerBlockedCards.length,0);
assert.equal(firstReader.cardProjection.exitingCards.length,1);
assert.equal(firstReader.cardProjection.activeProposalCount,1);
assert.equal(firstReader.reservationProjection.reservations.length,1);
assert.equal(firstReader.graphicProjection.activeOverlays.length,1);
const replacementCard = firstReader.cardProjection.actionableCards[0];
const replacementAdapter = firstReader.handlerAdapters[replacementCard.canonicalCardId];
const oldOutcome = firstReader.canonicalPlan.candidateOutcomes.find(item=>item.status === "exiting");
const replacementOutcome = firstReader.canonicalPlan.candidateOutcomes.find(item=>item.targetSlot === "1S");
assert.ok(oldOutcome && replacementOutcome);
assert.equal(oldOutcome.obligationId,replacementOutcome.obligationId);
assert.equal(oldOutcome.stepId,replacementOutcome.stepId);
assert.notEqual(oldOutcome.candidateOutcomeId,replacementOutcome.candidateOutcomeId);
assert.equal(replacementAdapter.ready,true);
assert.equal(replacementAdapter.row.toSlot,"1S");
assert.equal(replacementAdapter.actionKey,replacementKey);
assert.equal(replacementAdapter.canComplete,true);
assert.equal(replacementAdapter.canCancel,true);
assert.equal(replacementAdapter.canDelete,false,"replacement is not a deletable local standalone card");
assert.equal(replacementAdapter.reservation.targetSlot,"1S");
assert.equal(replacementAdapter.overlay.targetSlot,"1S");
const actionControls = buildSdeCanonicalCardActionControlsHtml(replacementCard,replacementAdapter);
assert.match(actionControls,/>Utført</);
assert.match(actionControls,/>Annullert</);
assert.doesNotMatch(actionControls,/sperret|Handling krever avklaring/);
const exitingCard = firstReader.cardProjection.exitingCards[0];
assert.equal(exitingCard.canComplete,false);
assert.equal(exitingCard.canCancel,false);
assert.equal(firstReader.reservationProjection.reservations.some(item=>item.activeOutcomeId === exitingCard.activeOutcomeId),false);
assert.equal(firstReader.graphicProjection.activeOverlays.some(item=>item.activeOutcomeId === exitingCard.activeOutcomeId),false);

const postLifecycleReader = buildSdeCanonicalProductionReader(makeSnapshot([replacement1S],replacementKey,{}));
assert.equal(postLifecycleReader.cardProjection.exitingCards.length,0);
assert.equal(postLifecycleReader.cardProjection.actionableCards.length,1);
assert.equal(postLifecycleReader.handlerAdapters[postLifecycleReader.cardProjection.actionableCards[0].canonicalCardId].ready,true);

const secondKey = "sde-cancel-replacement|69-55|r2|2S";
const old1S = exitingRow("1S",replacementKey,secondKey,1);
const replacement2S = activeRow("2S",secondKey,2);
const secondReader = buildSdeCanonicalProductionReader(makeSnapshot(
  [old1S,replacement2S],
  secondKey,
  {[replacementKey]:cancelledRecord(old1S,secondKey,"2S")}
));
assert.equal(secondReader.cardProjection.actionableCards.length,1);
assert.equal(secondReader.cardProjection.exitingCards.length,1);
assert.equal(secondReader.cardProjection.activeProposalCount,1);
assert.equal(secondReader.reservationProjection.reservations.length,1);
assert.equal(secondReader.graphicProjection.activeOverlays.length,1);
assert.equal(secondReader.cardProjection.actionableCards[0].targetSlot,"2S");
assert.equal(secondReader.canonicalPlan.candidateOutcomes.some(item=>item.targetSlot === "1N"),false,"first rejected target must not return");
assert.equal(secondReader.handlerAdapters[secondReader.cardProjection.actionableCards[0].canonicalCardId].ready,true);

const duplicateReader = buildSdeCanonicalProductionReaderSource(makeSnapshot([replacement1S],replacementKey,{}));
const duplicateSourceCard = duplicateReader.cardProjection.actionableCards[0];
duplicateReader.runtimeSnapshot.legacy.finalCards = [replacement1S,{...replacement1S}];
const duplicateAdapter = buildSdeCanonicalHandlerAdapter(duplicateSourceCard,duplicateReader);
applySdeCanonicalHandlerActionableGate(duplicateReader,{[duplicateSourceCard.canonicalCardId]:duplicateAdapter});
duplicateReader.handlerAdapters = Object.fromEntries(getSdeCanonicalProductionProjectedCards(duplicateReader).map(card=>[
  card.canonicalCardId,buildSdeCanonicalHandlerAdapter(card,duplicateReader)
]));
assert.equal(duplicateReader.cardProjection.actionableCards.length,0);
assert.equal(duplicateReader.cardProjection.activeProposalCount,0);
assert.equal(duplicateReader.cardProjection.handlerBlockedCards.length,1);
assert.equal(duplicateReader.reservationProjection.reservations.length,0);
assert.equal(duplicateReader.graphicProjection.activeOverlays.length,0);
assert.ok(buildSdeCanonicalProductionDiagnostics(duplicateReader).some(item=>item.diagnosticType === "handler_adapter_blocked"));
const blockedCard = duplicateReader.cardProjection.handlerBlockedCards[0];
const blockedAdapter = duplicateReader.handlerAdapters[blockedCard.canonicalCardId];
assert.equal(blockedAdapter.ready,false);
assert.ok(blockedAdapter.reasons.some(reason=>reason.includes("nøyaktig ett legacy handlingsgrunnlag")));
const blockedControls = buildSdeCanonicalCardActionControlsHtml(blockedCard,blockedAdapter);
assert.equal(blockedControls,"","handler-blocked cards must expose no production controls");
assert.equal(getSdeCanonicalProductionVisibleCards(duplicateReader).length,0,"handler-blocked cards must stay out of the production card list");
assert.deepEqual(buildSdeCanonicalProductionScorePresentation(duplicateReader,buildSdeCanonicalProductionDiagnostics(duplicateReader),100),{
  calculated:false,label:"Ikke beregnet",detail:"Ingen gjennomførbar plan"
});

const sourceReader = buildSdeCanonicalProductionReaderSource(makeSnapshot([replacement1S],replacementKey,{}));
const sourceCard = sourceReader.cardProjection.actionableCards[0];
sourceReader.runtimeSnapshot.legacy.finalCards = [];
const nullAdapter = buildSdeCanonicalHandlerAdapter(sourceCard,sourceReader);
assert.equal(nullAdapter.ready,false);
assert.ok(nullAdapter.reasons.some(reason=>reason.includes("nøyaktig ett legacy handlingsgrunnlag")));
applySdeCanonicalHandlerActionableGate(sourceReader,{[sourceCard.canonicalCardId]:nullAdapter});
assert.equal(sourceReader.canonicalPlan.activeOutcomes.length,0);
assert.equal(sourceReader.cardProjection.actionableCards.length,0);
assert.equal(sourceReader.cardProjection.handlerBlockedCards.length,1);
assert.equal(sourceReader.reservationProjection.reservations.length,0);
assert.equal(sourceReader.graphicProjection.activeOverlays.length,0);

const mismatchSourceAdapter = buildSdeCanonicalHandlerAdapter({...replacementCard,sourceSlot:"6M"},firstReader);
assert.equal(mismatchSourceAdapter.ready,false);
assert.ok(mismatchSourceAdapter.reasons.includes("source samsvarer ikke"));
const mismatchTargetAdapter = buildSdeCanonicalHandlerAdapter({...replacementCard,targetSlot:"1N"},firstReader);
assert.equal(mismatchTargetAdapter.ready,false);
assert.ok(mismatchTargetAdapter.reasons.includes("target samsvarer ikke"));
const noReservationReader = {...firstReader,reservationProjection:{...firstReader.reservationProjection,reservations:[]}};
const noReservationAdapter = buildSdeCanonicalHandlerAdapter(replacementCard,noReservationReader);
assert.equal(noReservationAdapter.ready,false);
assert.ok(noReservationAdapter.reasons.includes("target har ikke nøyaktig én canonical reservasjon"));
const noOverlayReader = {...firstReader,graphicProjection:{...firstReader.graphicProjection,activeOverlays:[]}};
const noOverlayAdapter = buildSdeCanonicalHandlerAdapter(replacementCard,noOverlayReader);
assert.equal(noOverlayAdapter.ready,false);
assert.ok(noOverlayAdapter.reasons.includes("target har ikke nøyaktig ett canonical overlay"));
const dependencyReader = JSON.parse(JSON.stringify(firstReader));
const dependencyOutcome = dependencyReader.canonicalPlan.candidateOutcomes.find(item=>item.candidateOutcomeId === replacementCard.activeOutcomeId);
dependencyOutcome.unmetDependencies = ["unmet-dependency"];
const dependencyAdapter = buildSdeCanonicalHandlerAdapter(replacementCard,dependencyReader);
assert.equal(dependencyAdapter.ready,false);
assert.ok(dependencyAdapter.reasons.includes("dependencies er ikke oppfylt"));

assert.ok(script.includes("const SDE_RELEASE_CANCELLED_HOLD_MS = 5000;"));
assert.ok(script.includes("const SDE_RELEASE_CANCELLED_EXIT_MS = 2000;"));
assert.equal(script.slice(readerStart,readerEnd).includes("persist("),false);
assert.equal(script.slice(readerStart,readerEnd).includes("fetch("),false);
assert.equal(script.slice(readerStart,readerEnd).includes("localStorage"),false);
assert.ok(script.slice(readerStart,readerEnd).includes("handleSdeShiftMoveAction("));

console.log(JSON.stringify({
  ok:true,
  firstReplacement:{
    sameObligation:oldOutcome.obligationId === replacementOutcome.obligationId,
    sameStep:oldOutcome.stepId === replacementOutcome.stepId,
    oldTarget:oldOutcome.targetSlot,
    newTarget:replacementOutcome.targetSlot,
    activeOutcomeId:replacementOutcome.candidateOutcomeId,
    handlerActionKey:replacementAdapter.actionKey,
    productionVisibleCards:getSdeCanonicalProductionVisibleCards(firstReader).length,
    internalProjectedCards:firstReader.cardProjection.actionableCards.length + firstReader.cardProjection.exitingCards.length,
    actionableCards:firstReader.cardProjection.actionableCards.length,
    reservations:firstReader.reservationProjection.reservations.length,
    overlays:firstReader.graphicProjection.activeOverlays.length,
    adapterReady:replacementAdapter.ready,
    canComplete:replacementAdapter.canComplete,
    canCancel:replacementAdapter.canCancel,
    canDelete:replacementAdapter.canDelete
  },
  afterLifecycle:{productionVisibleCards:getSdeCanonicalProductionVisibleCards(postLifecycleReader).length,adapterReady:true},
  secondReplacement:{oldTarget:"1S",newTarget:"2S",firstTargetReturned:false,actionableCards:1,reservations:1,overlays:1,adapterReady:true},
  failClosedGate:{productionVisibleCards:getSdeCanonicalProductionVisibleCards(duplicateReader).length,actionableCards:duplicateReader.cardProjection.actionableCards.length,handlerBlockedCards:duplicateReader.cardProjection.handlerBlockedCards.length,reservations:0,overlays:0,diagnostic:"handler_adapter_blocked"},
  invalidAdapters:["null","multiple","old-target-alias","source-mismatch","reservation-missing","overlay-missing","dependency-unmet"],
  lifecycle:"5+2 unchanged",
  sideEffects:"no new persist/fetch/localStorage in reader"
},null,2));

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(process.argv[2], "utf8");
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  .map(match=>match[1])
  .find(source=>source.includes("function normalizeSdeCanonicalToken")) || "";
const authorityStart = script.indexOf("function getSdeMoveActionKey");
const authorityEnd = script.indexOf("/*\n  Parallell, skjult SDE read-model", authorityStart);
const canonicalStart = script.indexOf("function normalizeSdeCanonicalToken");
const canonicalEnd = script.indexOf("function getSdeMoveCardDisplayIndex", canonicalStart);
const readerStart = script.indexOf("let sdeProductionReaderFallbackError", canonicalEnd);
const readerEnd = script.indexOf("function buildSdeLimitedPlanningData", readerStart);
assert.ok(authorityStart >= 0 && authorityEnd > authorityStart, "authority block missing");
assert.ok(canonicalStart >= 0 && canonicalEnd > canonicalStart, "canonical block missing");
assert.ok(readerStart > canonicalEnd && readerEnd > readerStart, "production reader block missing");

global.normalizeSlot = value=>String(value || "").trim().toUpperCase();
global.sanitizeVehicleValue = value=>String(value || "").trim();
global.normalizeVehicleToken = value=>sanitizeVehicleValue(value).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
global.normalizeTimeString = value=>String(value || "").trim();
global.normalizeTognr = value=>String(value || "").trim();
global.haveSameSdeVehicleTokens = (left,right)=>normalizeVehicleToken(left) === normalizeVehicleToken(right);
global.getSdeMoveNeedKey = row=>String(row?.needKey || row?.sdeNightPlacementGeneratedNeedKey || "").trim();
global.getSdePhysicalReleaseReplanKey = ()=>"";
global.getSdeShiftSnapshotHash = value=>String(value || "").length.toString(16);
global.window = {location:{search:"",hostname:"localhost"}};
global.escapeHtml = value=>String(value ?? "");
global.getSdeMoveActionLookupKeys = row=>Array.from(new Set([
  getSdeMoveActionKey(row),
  String(row?.sdeNightPlacementOriginalActionKey || "").trim()
].filter(Boolean)));
global.getSdeMoveCardDeleteBlockReason = ()=>"";
global.buildSdeCanonicalPendulumPreviewDiagnostics = ()=>[];
global.buildSdeDiagnosticSectionHtml = options=>`${options.title}|${options.count}|${options.bodyHtml}`;
global.isSdeMoveCardLocallyDeleted = ()=>false;
global.getSdeMoveActionRecord = key=>global.state.sdeMoveActions?.[key] || null;
global.isSdeMoveCardActioned = row=>Boolean(getSdeMoveActionRecord(getSdeMoveActionKey(row)));
global.state = {sdeMoveActions:{},sdeActiveMoveOutcomes:{}};

vm.runInThisContext(script.slice(authorityStart, authorityEnd), {filename:"active-authority.js"});
vm.runInThisContext(script.slice(canonicalStart, canonicalEnd), {filename:"canonical-models.js"});
vm.runInThisContext(script.slice(readerStart, readerEnd), {filename:"canonical-reader.js"});

const workshopRequest = {
  exitRequestId:"exit-request-a",
  vehicleId:"74-07",
  visitId:"visit-a",
  sourceSlot:"7S",
  placementRevision:"shared-sporplan:241",
  status:"REQUESTED"
};
const workshopRow = {
  vehicle:"74-07",
  fromSlot:"7S",
  arrivalSlot:"7S",
  originalFromSlot:"7S",
  recommendedSlot:"4N",
  toSlot:"4N",
  needKey:"workshop-exit|exit-request-a",
  stableActionKey:"workshop-exit|exit-request-a",
  source:"Bestilt utkjøring fra Verksted",
  canonicalPurpose:"workshop-exit",
  isWorkshopMoveNeed:true,
  isWorkshopExitRequestNeed:true,
  workshopExitRequestId:"exit-request-a",
  workshopExitVisitId:"visit-a",
  workshopExitPlacementRevision:"shared-sporplan:241",
  workshopExitClassification:"RESERVE",
  recommendationReason:"Fersk autoritativ klassifisering og fysisk trygg målplassering."
};
const dragActionKey = "night-placement-drag|7014|10S|8N|request-b";
const dragOutcomeKey = "move|manual|7014|10S|7014|10S|direct-1";
const dragRow = {
  vehicle:"70-14",
  fromSlot:"10S",
  arrivalSlot:"10S",
  originalFromSlot:"10S",
  recommendedSlot:"8N",
  toSlot:"8N",
  needKey:`night-placement-drag-need|${dragActionKey}`,
  stableActionKey:dragActionKey,
  sdeNightPlacementGeneratedActionKey:dragActionKey,
  sdeNightPlacementGeneratedNeedKey:`night-placement-drag-need|${dragActionKey}`,
  sdeCanonicalOutcomeKey:dragOutcomeKey,
  sdeOutcomeKey:dragOutcomeKey,
  sdeOutcomeActive:true,
  canonicalPurpose:"vehicle-relocation",
  canonicalProducer:"graphic_drag_generated_move",
  source:"night-placement-drag",
  sdeCanonicalGraphicDragOrder:true,
  sdeNightPlacementDragIdentity:"request-b",
  manualPlanId:"manual-graphic-order|request-b",
  sdeNightPlacementDragOverrideActive:true,
  isNightPlacementGenerated:true,
  isManualOnly:true
};
const dragAuthority = {
  outcomeKey:dragOutcomeKey,
  activeOutcomeId:dragActionKey,
  legacyActionKey:dragActionKey,
  vehicle:"70-14",
  physicalFromSlot:"10S",
  requestedTarget:"8N",
  producer:"graphic_drag_generated_move",
  dragRequestId:"request-b",
  createdAt:"2026-07-28T08:00:00.000Z",
  updatedAt:"2026-07-28T08:00:00.000Z"
};

function makeSnapshot(rows, actualRows, authorities={}){
  return {
    schemaVersion:"sde-canonical-shadow-runtime-v1",
    actualSources:[{source:"canonical-actual",provenance:"unified-pipeline-harness",selected:true,rows:actualRows}],
    actualStateReconciliation:{diagnostics:[]},
    legacy:{
      finalCards:rows,
      activeCards:rows,
      visibleCards:rows,
      activeButtonCount:0,
      activeCount:rows.length,
      reservations:[],
      overlays:[],
      actualSlots:actualRows,
      unresolvedMarkers:[]
    },
    runtimeState:{actions:{},activeAuthorities:authorities},
    infrastructure:{}
  };
}

const healthyReader = buildSdeCanonicalProductionReader(makeSnapshot(
  [workshopRow,dragRow],
  [{vehicleId:"74-07",slot:"7S"},{vehicleId:"70-14",slot:"10S"}],
  {[dragOutcomeKey]:dragAuthority}
));
const healthy = buildSdeCanonicalUnifiedCardPipeline(healthyReader,{
  workshopExitRequests:[workshopRequest],
  manualPlans:[dragRow]
});
assert.equal(healthy.actionableCards.length,2,"both legitimate producers must use one actionable projection");
assert.equal(healthy.reservations.length,2);
assert.equal(healthy.orphanReservations.length,0);
assert.equal(healthy.unresolvedCards.length,0);
assert.equal(new Set(healthy.actionableCards.map(card=>card.vehicleId)).size,2);
for(const reservation of healthy.reservations){
  const card = healthy.actionableCards.find(item=>item.canonicalCardId === reservation.ownerCardId);
  assert.ok(card,"every reservation must identify an active card owner");
  assert.equal(reservation.vehicleId,card.vehicleId);
  assert.equal(reservation.targetSlot,card.targetSlot);
  assert.equal(reservation.planGeneration,card.planGeneration);
  assert.equal(reservation.assessmentRevision,card.assessmentRevision);
}
const linkedRequest = healthy.workshopExitRequests.find(item=>item.exitRequestId === workshopRequest.exitRequestId);
assert.equal(linkedRequest.status,"CARD_CREATED");
assert.ok(linkedRequest.linkedCardId);
assert.equal(healthy.actionableCards.find(card=>card.canonicalCardId === linkedRequest.linkedCardId)?.sourceType,"WORKSHOP_EXIT");
assert.equal(healthy.actionableCards.find(card=>card.sourceType === "MANUAL_DRAG")?.targetSlot,"8N");

const unresolved = buildSdeCanonicalUnifiedCardPipeline(healthyReader,{
  workshopExitRequests:[{
    exitRequestId:"exit-request-unresolved",
    vehicleId:"75-01",
    visitId:"visit-unresolved",
    sourceSlot:"8S",
    placementRevision:"shared-sporplan:242",
    status:"REQUESTED"
  }],
  manualPlans:[]
});
assert.equal(unresolved.workshopExitRequests[0].status,"BLOCKED_UNRESOLVED");
assert.equal(unresolved.workshopExitRequests[0].linkedCardId,null);
assert.equal(unresolved.unresolvedCards.length,1);
assert.equal(unresolved.unresolvedCards[0].vehicleId,"75-01");
assert.equal(unresolved.unresolvedCards[0].targetSlot,"");
assert.match(unresolved.unresolvedCards[0].explanation,/Ingen ledig og fysisk gjennomførbar plass|aktivt canonical kort/i);
assert.equal(unresolved.reservations.some(item=>item.vehicleId === "75-01"),false);

const orphanReader = structuredClone(healthyReader);
orphanReader.reservationProjection.reservations.push({
  reservationId:"orphan-reservation",
  activeOutcomeId:"missing-outcome",
  vehicleId:"69-63",
  targetSlot:"6N"
});
const orphanGuard = buildSdeCanonicalUnifiedCardPipeline(orphanReader,{
  workshopExitRequests:[workshopRequest],
  manualPlans:[dragRow]
});
assert.equal(orphanGuard.reservations.some(item=>item.reservationId === "orphan-reservation"),false);
assert.equal(orphanGuard.orphanReservations.length,1);
assert.ok(orphanGuard.diagnostics.some(item=>item.diagnosticType === "orphan_reservation"));

const staleWorkshopRow = {...workshopRow,recommendedSlot:"6N",toSlot:"6N"};
const staleReader = buildSdeCanonicalProductionReader(makeSnapshot(
  [staleWorkshopRow],
  [{vehicleId:"74-07",slot:"7S"},{vehicleId:"74-41",slot:"6N"}]
));
const stale = buildSdeCanonicalUnifiedCardPipeline(staleReader,{
  workshopExitRequests:[workshopRequest],
  manualPlans:[]
});
assert.equal(stale.workshopExitRequests[0].status,"REPLAN_REQUIRED");
assert.equal(stale.actionableCards.some(card=>card.vehicleId === "74-07"),false);
assert.equal(stale.reservations.some(item=>item.vehicleId === "74-07"),false);
assert.ok(stale.unresolvedCards.some(card=>card.vehicleId === "74-07"));

const previousDragRow = {
  ...dragRow,
  recommendedSlot:"11N",
  toSlot:"11N",
  stableActionKey:"night-placement-drag|7014|10S|11N|request-old",
  sdeNightPlacementGeneratedActionKey:"night-placement-drag|7014|10S|11N|request-old",
  sdeOutcomeActive:false
};
const replanReader = buildSdeCanonicalProductionReader(makeSnapshot(
  [previousDragRow,dragRow],
  [{vehicleId:"70-14",slot:"10S"}],
  {[dragOutcomeKey]:dragAuthority}
));
const replanned = buildSdeCanonicalUnifiedCardPipeline(replanReader,{
  workshopExitRequests:[],
  manualPlans:[previousDragRow,dragRow]
});
assert.equal(replanned.actionableCards.filter(card=>card.vehicleId === "70-14").length,1);
assert.equal(replanned.actionableCards.find(card=>card.vehicleId === "70-14").targetSlot,"8N");
assert.equal(replanned.reservations.some(item=>item.targetSlot === "11N"),false);

const dependencyWorkshopCard = {
  ...healthyReader.cardProjection.actionableCards.find(card=>card.vehicleId === "74-07"),
  status:"blocked_chain_step",
  active:false,
  canComplete:false,
  canCancel:false,
  canDelete:false,
  blockedBy:["release-step"],
  dependencyIds:["release-step"],
  explanation:"Venter på release-step."
};
const dependencyWorkshopReader = structuredClone(healthyReader);
dependencyWorkshopReader.cardProjection.actionableCards = dependencyWorkshopReader.cardProjection.actionableCards.filter(card=>card.vehicleId !== "74-07");
dependencyWorkshopReader.cardProjection.blockedChainCards = [dependencyWorkshopCard];
dependencyWorkshopReader.cardProjection.cardByOutcomeId = {[dependencyWorkshopCard.activeOutcomeId]:dependencyWorkshopCard};
const dependencyWorkshop = buildSdeCanonicalUnifiedCardPipeline(dependencyWorkshopReader,{
  workshopExitRequests:[workshopRequest],
  manualPlans:[]
});
assert.equal(dependencyWorkshop.liveCanonicalCards.filter(card=>card.sourceType === "WORKSHOP_EXIT").length,1);
assert.equal(dependencyWorkshop.workshopExitRequests[0].status,"CHAIN_CREATED");
assert.equal(dependencyWorkshop.workshopExitRequests[0].linkedCardId,dependencyWorkshopCard.canonicalCardId);
assert.equal(dependencyWorkshop.unresolvedCards.length,0);

const dependencyManualCard = {
  ...healthyReader.cardProjection.actionableCards.find(card=>card.vehicleId === "70-14"),
  status:"blocked_chain_step",
  active:false,
  canComplete:false,
  canCancel:false,
  canDelete:false,
  blockedBy:["manual-release-step"],
  dependencyIds:["manual-release-step"],
  explanation:"Venter på manual-release-step."
};
const dependencyManualReader = structuredClone(healthyReader);
dependencyManualReader.cardProjection.actionableCards = dependencyManualReader.cardProjection.actionableCards.filter(card=>card.vehicleId !== "70-14");
dependencyManualReader.cardProjection.blockedChainCards = [dependencyManualCard];
dependencyManualReader.cardProjection.cardByOutcomeId = {[dependencyManualCard.activeOutcomeId]:dependencyManualCard};
const dependencyManual = buildSdeCanonicalUnifiedCardPipeline(dependencyManualReader,{
  workshopExitRequests:[],
  manualPlans:[dragRow]
});
assert.equal(dependencyManual.liveCanonicalCards.filter(card=>card.sourceType === "MANUAL_DRAG").length,1);
assert.equal(dependencyManual.unresolvedCards.length,0);

const unresolvedHtml = buildSdeCanonicalUnresolvedFollowupCardHtml(unresolved.unresolvedCards[0],0);
assert.match(unresolvedHtml,/BLOCKED\/UNRESOLVED/);
assert.match(unresolvedHtml,/75-01/);
assert.match(unresolvedHtml,/sde-shift-unresolved-item/);
assert.doesNotMatch(unresolvedHtml,/class="sde-shift-card/);
assert.doesNotMatch(unresolvedHtml,/data-sde-canonical-action|>Utført<|>Annullert</);

assert.ok(script.includes("const unifiedPipeline = buildSdeCanonicalUnifiedCardPipeline(reader);"));
assert.ok(script.includes("buildSdeCanonicalUnresolvedFollowupCardHtml"));
assert.ok(script.includes("getSdeCanonicalDropTargetReservationState"));

process.stdout.write(JSON.stringify({
  schemaVersion:"sde-unified-card-pipeline-workshop-drag-v1",
  counts:{passed:30,total:30},
  workshop:{
    status:linkedRequest.status,
    linkedCardId:linkedRequest.linkedCardId,
    actionableCards:healthy.actionableCards.filter(card=>card.sourceType === "WORKSHOP_EXIT").length
  },
  manualDrag:{
    target:"8N",
    actionableCards:healthy.actionableCards.filter(card=>card.sourceType === "MANUAL_DRAG").length,
    supersededTarget:"11N"
  },
  integrity:{
    activeCards:healthy.actionableCards.length,
    reservations:healthy.reservations.length,
    orphanReservations:orphanGuard.orphanReservations.length,
    staleStatus:stale.workshopExitRequests[0].status,
    unresolvedVisible:unresolved.unresolvedCards.length,
    dependencyWorkshopStatus:dependencyWorkshop.workshopExitRequests[0].status,
    dependencyManualUnresolved:dependencyManual.unresolvedCards.length
  }
}) + "\n");

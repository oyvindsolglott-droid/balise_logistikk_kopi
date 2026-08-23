"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(process.argv[2], "utf8");
if(html.includes('migrationMode:"CANONICAL_ONLY"')){
  require("./sde-phase-a-canonical-contract-helper.cjs").runScenario("graphic-order",process.argv[2]);
  process.exit(0);
}
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  .map(match=>match[1])
  .find(source=>source.includes("function normalizeSdeCanonicalToken")) || "";
const authorityStart = script.indexOf("function getSdeMoveActionKey");
const authorityEnd = script.indexOf("/*\n  Parallell, skjult SDE read-model", authorityStart);
const canonicalStart = script.indexOf("function normalizeSdeCanonicalToken");
const canonicalEnd = script.indexOf("function getSdeMoveCardDisplayIndex", canonicalStart);
const inspectStart = script.indexOf("function inspectSdeCanonicalGraphicDragOrder");
const inspectEnd = script.indexOf("function stageSdeCanonicalGraphicDragOrder", inspectStart);
const readerStart = script.indexOf("let sdeProductionReaderFallbackError", canonicalEnd);
const readerEnd = script.indexOf("function buildSdeLimitedPlanningData", readerStart);
assert.ok(authorityStart >= 0 && authorityEnd > authorityStart);
assert.ok(canonicalStart >= 0 && canonicalEnd > canonicalStart);
assert.ok(inspectStart >= 0 && inspectEnd > inspectStart);
assert.ok(readerStart > canonicalEnd && readerEnd > readerStart);

global.normalizeSlot = value=>String(value || "").trim().toUpperCase();
global.sanitizeVehicleValue = value=>String(value || "").trim();
global.normalizeVehicleToken = value=>sanitizeVehicleValue(value).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
global.normalizeTimeString = value=>String(value || "").trim();
global.normalizeTognr = value=>String(value || "").trim();
global.haveSameSdeVehicleTokens = (left,right)=>normalizeVehicleToken(left) === normalizeVehicleToken(right);
global.getSdeMoveNeedKey = row=>String(row?.needKey || row?.sdeCancellationNeedKey || row?.sdeNightPlacementGeneratedNeedKey || "").trim();
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
vm.runInThisContext(script.slice(inspectStart, inspectEnd), {filename:"drag-order-inspector.js"});
vm.runInThisContext(script.slice(readerStart, readerEnd), {filename:"canonical-reader.js"});

const obligationKey = "move|manual|6955|5M|6955|5M|direct-1";
const dragActionKey = "night-placement-drag|6955|5M|10N|request-safari";
const staleActionKey = "sde-cancel-replacement|6955|5M|4M";
const common = {
  vehicle:"69-55",
  fromSlot:"5M",
  arrivalSlot:"5M",
  originalFromSlot:"5M",
  canonicalPurpose:"vehicle-relocation",
  sdeCanonicalOutcomeKey:obligationKey,
  sdeOutcomeKey:obligationKey,
  sdeOutcomeActive:true
};
const dragRow = {
  ...common,
  recommendedSlot:"10N",
  toSlot:"10N",
  needKey:`night-placement-drag-need|${dragActionKey}`,
  stableActionKey:dragActionKey,
  sdeNightPlacementGeneratedActionKey:dragActionKey,
  sdeNightPlacementGeneratedNeedKey:`night-placement-drag-need|${dragActionKey}`,
  canonicalProducer:"graphic_drag_generated_move",
  sdeCanonicalGraphicDragOrder:true,
  sdeNightPlacementDragIdentity:"request-safari",
  manualPlanId:"manual-graphic-order|request-safari",
  sdeNightPlacementDragOverrideActive:true,
  isNightPlacementGenerated:true,
  isManualOnly:true,
  source:"night-placement-drag"
};
const stale4M = {
  ...common,
  recommendedSlot:"4M",
  toSlot:"4M",
  needKey:"old-need-4M",
  stableActionKey:staleActionKey,
  isSdeCancellationReplacementMove:true,
  source:"cancelled_replacement"
};
const oldHistory = Object.fromEntries(["4M","11N","12N"].map((target,index)=>[
  `old-cancelled-${index}-${target}`,
  {
    action:"cancelled",
    outcomeKey:`old-outcome-${index}`,
    activeOutcomeId:`old-replacement-${index}`,
    replacementTargetSlot:target,
    rejectedTargetSlot:target,
    vehicle:"69-55",
    physicalFromSlot:"5M",
    snapshot:{vehicle:"69-55",fromSlot:"5M",toSlot:target,stableActionKey:`old-${target}`}
  }
]));

const makeSnapshot = (rows,authorities,actions=oldHistory,actualRows=[{vehicleId:"69-55",slot:"5M"}])=>({
  schemaVersion:"sde-canonical-shadow-runtime-v1",
  actualSources:[{source:"canonical-actual",provenance:"s-harness",selected:true,rows:actualRows}],
  actualStateReconciliation:{diagnostics:[]},
  legacy:{finalCards:rows,activeCards:rows,visibleCards:rows,activeButtonCount:0,activeCount:1,reservations:[],overlays:[],actualSlots:actualRows,unresolvedMarkers:[]},
  runtimeState:{actions,activeAuthorities:authorities},
  infrastructure:{}
});

const authority = {
  outcomeKey:obligationKey,
  activeOutcomeId:dragActionKey,
  legacyActionKey:dragActionKey,
  canonicalActiveOutcomeId:"",
  vehicle:"69-55",
  physicalFromSlot:"5M",
  requestedTarget:"10N",
  obligationId:"",
  stepId:"",
  producer:"graphic_drag_generated_move",
  dragRequestId:"request-safari",
  createdAt:"2026-07-14T12:00:00.000Z",
  updatedAt:"2026-07-14T12:00:00.000Z",
  source:"graphic_drag_generated_move"
};
const namedAuthority = setSdeActiveOutcomeAuthority(obligationKey, dragRow, {
  activeOutcomeId:dragActionKey,
  requestedTarget:"10N",
  producer:"graphic_drag_generated_move",
  dragRequestId:"request-safari"
});
assert.equal(namedAuthority.vehicleId,"69-55");
assert.equal(namedAuthority.canonicalSourceSlot,"5M");
assert.equal(namedAuthority.requestedTarget,"10N");
state.sdeActiveMoveOutcomes = {[obligationKey]:authority};
state.sdeMoveActions = oldHistory;
const authoritativeRows = getSdeAuthoritativeActiveOutcomeRows([dragRow,stale4M]);
assert.equal(authoritativeRows.length,1);
assert.equal(authoritativeRows[0].toSlot,"10N");
assert.equal(authoritativeRows[0].stableActionKey,dragActionKey);

const reader = buildSdeCanonicalProductionReader(makeSnapshot(
  [dragRow,stale4M],
  {[obligationKey]:authority},
  oldHistory
));
const exact = inspectSdeCanonicalGraphicDragOrder(reader,{
  vehicle:"69-55",sourceSlot:"5M",targetSlot:"10N",actionKey:dragActionKey
});
assert.equal(exact.ok,true,exact.reason);
assert.equal(reader.canonicalPlan.activeOutcomes.length,1);
assert.equal(reader.cardProjection.actionableCards.length,1);
assert.equal(reader.cardProjection.handlerBlockedCards.length,0);
assert.equal(reader.reservationProjection.reservations.length,1);
assert.equal(reader.graphicProjection.activeOverlays.length,1);
assert.equal(reader.cardProjection.activeProposalCount,1);
assert.equal(reader.canonicalPlan.activeOutcomes[0].targetSlot,"10N");
assert.equal(reader.canonicalPlan.activeOutcomes.some(item=>item.targetSlot === "4M"),false);
assert.equal(exact.adapter.ready,true);
assert.equal(exact.adapter.canComplete,true);
assert.equal(exact.adapter.canCancel,true);
assert.equal(exact.adapter.canDelete,true);
assert.equal(exact.outcome.obligationId,exact.card.obligationId);
assert.equal(exact.outcome.stepId,exact.card.stepId);
assert.equal(exact.outcome.candidateOutcomeId,exact.reservation.activeOutcomeId);
assert.equal(exact.outcome.candidateOutcomeId,exact.overlay.activeOutcomeId);

const canonicalAuthority = {
  ...authority,
  activeOutcomeId:exact.outcome.candidateOutcomeId,
  canonicalActiveOutcomeId:exact.outcome.candidateOutcomeId,
  obligationId:exact.outcome.obligationId,
  stepId:exact.outcome.stepId
};
state.sdeActiveMoveOutcomes = {[obligationKey]:canonicalAuthority};
const persistedRows = getSdeAuthoritativeActiveOutcomeRows([dragRow,stale4M]);
assert.equal(persistedRows.length,1);
assert.equal(persistedRows[0].toSlot,"10N");
const persistedReader = buildSdeCanonicalProductionReader(makeSnapshot(
  [dragRow,stale4M],
  {[obligationKey]:canonicalAuthority},
  oldHistory
));
const persistedExact = inspectSdeCanonicalGraphicDragOrder(persistedReader,{
  vehicle:"69-55",sourceSlot:"5M",targetSlot:"10N",actionKey:dragActionKey
});
assert.equal(persistedExact.ok,true,persistedExact.reason);

const secondRow = {
  ...dragRow,
  vehicle:"74-11",
  fromSlot:"5N",
  arrivalSlot:"5N",
  originalFromSlot:"5N",
  recommendedSlot:"11S",
  toSlot:"11S",
  stableActionKey:"night-placement-drag|7411|5N|11S|request-b",
  sdeNightPlacementGeneratedActionKey:"night-placement-drag|7411|5N|11S|request-b",
  needKey:"night-placement-drag-need|request-b",
  sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|request-b",
  sdeCanonicalOutcomeKey:"move|manual|7411|5N|7411|5N|direct-1",
  sdeOutcomeKey:"move|manual|7411|5N|7411|5N|direct-1",
  sdeNightPlacementDragIdentity:"request-b",
  manualPlanId:"manual-graphic-order|request-b"
};
const twoReader = buildSdeCanonicalProductionReader(makeSnapshot(
  [dragRow,secondRow],
  {
    [obligationKey]:{...authority,activeOutcomeId:dragActionKey},
    [secondRow.sdeOutcomeKey]:{activeOutcomeId:secondRow.stableActionKey,legacyActionKey:secondRow.stableActionKey,vehicle:"74-11",physicalFromSlot:"5N"}
  },
  oldHistory,
  [{vehicleId:"69-55",slot:"5M"},{vehicleId:"74-11",slot:"5N"}]
));
assert.equal(twoReader.canonicalPlan.activeOutcomes.length,2);
assert.equal(twoReader.cardProjection.actionableCards.length,2);
assert.equal(twoReader.reservationProjection.reservations.length,2);
assert.equal(twoReader.graphicProjection.activeOverlays.length,2);
assert.equal(twoReader.cardProjection.activeProposalCount,2);
assert.deepEqual(twoReader.canonicalPlan.activeOutcomes.map(item=>item.targetSlot).sort(),["10N","11S"]);

assert.ok(script.includes("clearDragClasses();\n    sdeNightPlacementDragPayload = null;\n    const requestedTarget = normalizeSlot(target.dataset.sdeNightPlacementSlot);\n    applySdeNightPlacementDragOverride(payload ? {...payload,requestedTarget} : payload, requestedTarget);"));
assert.ok(script.includes("clearDragClasses();\n    sdeNightPlacementDragPayload = null;\n    if(target){\n      const requestedTarget = normalizeSlot(target.dataset.sdeNightPlacementSlot);\n      applySdeNightPlacementDragOverride({...drag.payload,requestedTarget}, requestedTarget);"));
assert.ok(script.includes("state.sdeNightPlacementManualOverrides = previousOverrides;"));
assert.ok(script.includes("state.sdeActiveMoveOutcomes = previousAuthorities;"));
assert.ok(script.includes("Bestilling avvist som operativ kjede, men plan-intent er beholdt diagnostic-only:"));
assert.ok(script.includes("Bestilling opprettet:"));

const noCandidateInspection = inspectSdeCanonicalGraphicDragOrder(twoReader,{
  vehicle:"69-55",sourceSlot:"5M",targetSlot:"8S",actionKey:"night-placement-drag|69-55|5M|8S|no-such-request"
});
assert.equal(noCandidateInspection.ok,false);
assert.match(noCandidateInspection.reason,/activeOutcome=0/);
assert.match(
  noCandidateInspection.reason,
  /candidateOutcome=0 \(ingen kandidat ble generert for 69-55 5M->8S\)/,
  noCandidateInspection.reason
);

const looseMatchInspection = inspectSdeCanonicalGraphicDragOrder(twoReader,{
  vehicle:"69-55",sourceSlot:"5M",targetSlot:"8S",actionKey:dragActionKey
});
assert.equal(looseMatchInspection.ok,false);
assert.match(
  looseMatchInspection.reason,
  /candidateOutcome=1 men kilde\/mål samsvarer ikke med forespørselen \(forventet 5M->8S\): stated=5M, actual=5M, canonical=5M, target=10N, sourceValidation=canonical_actual/,
  looseMatchInspection.reason,
);

console.log(JSON.stringify({
  ok:true,
  exactSafari:{
    vehicle:"69-55",source:"5M",target:"10N",
    activeOutcomes:reader.canonicalPlan.activeOutcomes.length,
    actionableCards:reader.cardProjection.actionableCards.length,
    reservations:reader.reservationProjection.reservations.length,
    overlays:reader.graphicProjection.activeOverlays.length,
    adapters:Number(exact.adapter.ready),
    activeProposalCount:reader.cardProjection.activeProposalCount,
    stale4MActive:false,
    canComplete:exact.adapter.canComplete,
    canCancel:exact.adapter.canCancel,
    canDelete:exact.adapter.canDelete
  },
  identity:{
    obligationId:exact.outcome.obligationId,
    stepId:exact.outcome.stepId,
    activeOutcomeId:exact.outcome.candidateOutcomeId,
    actionKey:exact.adapter.actionKey,
    producer:exact.outcome.producer,
    dragRequestId:authority.dragRequestId
  },
  historyIsolation:{cancelledRows:Object.keys(oldHistory).length,winningTarget:"10N"},
  reloadAuthority:{legacyActionKey:canonicalAuthority.legacyActionKey,canonicalActiveOutcomeId:canonicalAuthority.activeOutcomeId,target:persistedExact.outcome.targetSlot},
  twoIndependent:{activeOutcomes:2,cards:2,reservations:2,overlays:2,targets:["10N","11S"]},
  atomicRollback:true,
  receivers:["endCoordinateDrag","HTML5 drop"]
},null,2));

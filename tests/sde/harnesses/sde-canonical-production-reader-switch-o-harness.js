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

global.normalizeSlot = value => String(value || "").trim().toUpperCase();
global.sanitizeVehicleValue = value => String(value || "").trim();
global.getSdeShiftSnapshotHash = value => {
  let hash = 0;
  for(const character of String(value || "")) hash = (Math.imul(31, hash) + character.charCodeAt(0)) | 0;
  return `h${(hash >>> 0).toString(16)}`;
};
global.window = {location:{search:"",hostname:"localhost"}};
global.escapeHtml = value => String(value ?? "");
global.getSdeMoveActionKey = row => String(row?.sdeNightPlacementGeneratedActionKey || row?.stableActionKey || row?.actionKey || "").trim();
global.getSdeMoveActionLookupKeys = row => Array.from(new Set([
  global.getSdeMoveActionKey(row),
  String(row?.sdeNightPlacementOriginalActionKey || "").trim()
].filter(Boolean)));
global.getSdeMoveCardDeleteBlockReason = () => "";
global.buildSdeCanonicalPendulumPreviewDiagnostics = () => [];

vm.runInThisContext(script.slice(canonicalStart, canonicalEnd), {filename:"canonical-reader-models.js"});
vm.runInThisContext(script.slice(readerStart, readerEnd), {filename:"canonical-production-reader.js"});

const row = (vehicle, sourceSlot, targetSlot, key, extra={}) => ({
  vehicle,
  fromSlot:sourceSlot,
  arrivalSlot:sourceSlot,
  recommendedSlot:targetSlot,
  toSlot:targetSlot,
  stableActionKey:key,
  actionKey:key,
  needKey:`need-${vehicle}`,
  source:"SDE",
  canonicalPurpose:"night-parking",
  ...extra
});

const snapshot = (rows, placements, options={}) => ({
  schemaVersion:"sde-canonical-shadow-runtime-v1",
  actualSources:[{
    source:"canonical-actual",
    provenance:"reader-o-harness",
    selected:true,
    rows:placements.map(([vehicleId,slot])=>({vehicleId,slot}))
  }],
  actualStateReconciliation:{diagnostics:[]},
  legacy:{
    finalCards:rows,
    activeCards:rows,
    visibleCards:rows,
    activeButtonCount:0,
    activeCount:0,
    reservations:[],
    overlays:[],
    actualSlots:placements.map(([vehicleId,slot])=>({vehicleId,slot})),
    unresolvedMarkers:[]
  },
  runtimeState:{
    actions:options.actions || {},
    activeAuthorities:options.activeAuthorities || {}
  },
  infrastructure:{}
});

assert.equal(getSdeProductionReaderMode({search:""}), "canonical");
assert.equal(getSdeProductionReaderMode({search:"?sdeReader=legacy"}), "legacy_forced");
assert.equal(getSdeProductionReaderMode({search:""},{technicalFailure:true}), "legacy_fallback");
assert.equal(isSdeCanonicalReaderTechnicalFailureTestRequested({hostname:"localhost",search:"?sdeReaderTechnicalFailureTest=1"}), true);
assert.equal(isSdeCanonicalReaderTechnicalFailureTestRequested({hostname:"example.com",search:"?sdeReaderTechnicalFailureTest=1"}), false);

const directRow = row("70-01","5N","11S","direct-1");
const directReader = buildSdeCanonicalProductionReader(snapshot([directRow], [["70-01","5N"]]));
assert.equal(directReader.cardProjection.actionableCards.length, 1);
assert.equal(directReader.cardProjection.activeProposalCount, 1);
assert.equal(directReader.reservationProjection.reservations.length, 1);
assert.equal(directReader.graphicProjection.activeOverlays.length, 1);
assert.equal(directReader.graphicProjection.deferredOverlays.length, 0);
assert.equal(directReader.integrityReport.status, "PASS");
const directCard = directReader.cardProjection.actionableCards[0];
const directAdapter = directReader.handlerAdapters[directCard.canonicalCardId];
assert.equal(directAdapter.ready, true);
assert.equal(directAdapter.canComplete, true);
assert.equal(directAdapter.canCancel, true);
assert.equal(directAdapter.canDelete, false);
assert.equal(directAdapter.actionKey, "direct-1");

const manualRow = row("70-02","6N","12S","manual-1",{
  isNightPlacementGenerated:true,
  sdeNightPlacementGeneratedActionKey:"manual-1",
  source:"night-placement-drag"
});
const manualReader = buildSdeCanonicalProductionReader(snapshot([manualRow], [["70-02","6N"]]));
const manualCard = manualReader.cardProjection.actionableCards[0];
const manualAdapter = manualReader.handlerAdapters[manualCard.canonicalCardId];
assert.equal(manualCard.canDelete, true);
assert.equal(manualAdapter.canDelete, true);

const ambiguousRows = [
  row("70-03","7N","11N","ambiguous-a"),
  row("70-03","7N","12N","ambiguous-b")
];
const diagnosticReader = buildSdeCanonicalProductionReader(snapshot(ambiguousRows, [["70-03","7N"]]));
assert.equal(diagnosticReader.cardProjection.actionableCards.length, 0);
assert.equal(diagnosticReader.cardProjection.activeProposalCount, 0);
assert.equal(diagnosticReader.reservationProjection.reservations.length, 0);
assert.equal(diagnosticReader.graphicProjection.activeOverlays.length, 0);
assert.ok(diagnosticReader.cardProjection.diagnostics.some(item=>item.diagnosticType === "competing_targets"));
assert.equal(getSdeProductionReaderMode({search:""},{technicalFailure:false}), "canonical");

const duplicateBasis = snapshot([directRow,{...directRow}], [["70-01","5N"]]);
const duplicateBasisReader = buildSdeCanonicalProductionReader(duplicateBasis);
if(duplicateBasisReader.cardProjection.actionableCards.length){
  const duplicateCard = duplicateBasisReader.cardProjection.actionableCards[0];
  const duplicateAdapter = duplicateBasisReader.handlerAdapters[duplicateCard.canonicalCardId];
  assert.equal(duplicateAdapter.ready, false);
  assert.ok(duplicateAdapter.reasons.some(reason=>reason.includes("nøyaktig ett legacy handlingsgrunnlag")));
}

assert.throws(()=>assertSdeCanonicalProductionReaderContract({}), /mangler canonicalPlan/);
assert.equal(script.slice(readerStart,readerEnd).includes("persist("), false, "reader adapter must not persist");
assert.equal(script.slice(readerStart,readerEnd).includes("fetch("), false, "reader adapter must not fetch");
assert.equal(script.slice(readerStart,readerEnd).includes("localStorage"), false, "reader adapter must not use localStorage");
assert.ok(script.slice(readerStart,readerEnd).includes("handleSdeShiftMoveAction("), "canonical handler adapter must delegate to existing handler");
assert.ok(script.includes("const SDE_RELEASE_CANCELLED_HOLD_MS = 5000;"), "cancelled hold must remain 5 seconds");
assert.ok(script.includes("const SDE_RELEASE_CANCELLED_EXIT_MS = 2000;"), "cancelled exit must remain 2 seconds");
assert.ok(script.slice(readerStart,readerEnd).includes("buildSdePhysicalReleaseCancelledCardUi("), "canonical exiting cards must reuse existing lifecycle UI");
assert.ok(script.slice(readerStart,readerEnd).includes("scheduleSdePhysicalReleaseCardDismissals(root)"), "canonical renderer must schedule existing 5+2 lifecycle");
assert.ok(script.includes("canonicalCanDelete:adapter.canDelete === true"), "canonical delete permission must reach existing handler");
assert.ok(script.includes("Canonical kortregel tillater ikke Slett kort"), "existing delete dialog must fail closed on canonical canDelete");

console.log(JSON.stringify({
  ok:true,
  modes:["canonical","legacy_forced","legacy_fallback"],
  direct:{
    activeProposalCount:directReader.cardProjection.activeProposalCount,
    reservations:directReader.reservationProjection.reservations.length,
    activeOverlays:directReader.graphicProjection.activeOverlays.length,
    handlerReady:directAdapter.ready,
    canComplete:directAdapter.canComplete,
    canCancel:directAdapter.canCancel
  },
  manual:{canDelete:manualAdapter.canDelete},
  diagnostic:{
    activeProposalCount:diagnosticReader.cardProjection.activeProposalCount,
    diagnostics:diagnosticReader.cardProjection.diagnostics.map(item=>item.diagnosticType),
    readerMode:"canonical"
  },
  lifecycle:"existing-5-plus-2",
  deleteGating:"canonical-canDelete-through-existing-handler",
  sideEffects:"no-persist-no-fetch-no-localStorage"
},null,2));

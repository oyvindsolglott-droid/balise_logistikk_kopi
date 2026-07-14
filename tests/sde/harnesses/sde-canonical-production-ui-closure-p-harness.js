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
global.escapeHtml = value=>String(value ?? "");
global.getSdeMoveActionKey = row=>String(row?.actionKey || row?.stableActionKey || "").trim();
global.getSdeMoveActionLookupKeys = row=>[getSdeMoveActionKey(row)].filter(Boolean);
global.getSdeMoveCardDeleteBlockReason = ()=>"";
global.buildSdeCanonicalPendulumPreviewDiagnostics = ()=>[];
global.window = {location:{search:"",hostname:"localhost"}};

vm.runInThisContext(script.slice(canonicalStart, canonicalEnd), {filename:"canonical-models.js"});
vm.runInThisContext(script.slice(readerStart, readerEnd), {filename:"canonical-reader.js"});

const blockedScore = buildSdeCanonicalProductionScorePresentation(
  {cardProjection:{actionableCards:[]}},
  [{diagnosticType:"missing_actual_source"}],
  100
);
assert.deepEqual(blockedScore, {
  calculated:false,
  label:"Ikke beregnet",
  detail:"Ingen gjennomførbar plan"
});
assert.equal(JSON.stringify(blockedScore).includes("100"), false);

const actionableScore = buildSdeCanonicalProductionScorePresentation(
  {cardProjection:{actionableCards:[{canonicalCardId:"card-1"}]}},
  [{diagnosticType:"unrelated_diagnostic"}],
  87
);
assert.deepEqual(actionableScore, {calculated:true,label:"87",detail:"/ 100"});

global.buildSdeDiagnosticSectionHtml = options=>`${options.title}|${options.count}|${options.bodyHtml}`;
const diagnosticHtml = buildSdeCanonicalDiagnosticsHtml([
  {diagnosticType:"missing_actual_source",vehicleId:"74-39",sourceSlot:"",targetSlots:["4S"],explanation:"Fail closed."}
], "PASS");
assert.match(diagnosticHtml, /Teknisk integritet: PASS/);
assert.doesNotMatch(diagnosticHtml, /· integritet PASS/);
assert.doesNotMatch(diagnosticHtml, /<button\b|Utført|Annullert|Slett kort/);

global.getSdeNightPlacementLayoutRows = ()=>[["2N","4S","5N","10S","5M"]];
global.washMachineSlots = ["VN","VS"];
global.isSdeNightPlacementOrdinarySlot = slot=>!["VN","VS"].includes(normalizeSlot(slot));
const graphicReader = {
  cardProjection:{
    actionableCards:[{canonicalCardId:"card-1",activeOutcomeId:"outcome-1"}]
  },
  reservationProjection:{reservations:[{activeOutcomeId:"outcome-1"}]},
  graphicProjection:{
    actualSlots:[
      {slot:"5N",vehicleId:"74-11"},
      {slot:"10S",vehicleId:"69-63"},
      {slot:"5M",vehicleId:"69-55"}
    ],
    activeOverlays:[{activeOutcomeId:"outcome-1",overlayId:"overlay-1",reservationId:"reservation-1",vehicleId:"70-01",sourceSlot:"5N",targetSlot:"4S"}],
    deferredOverlays:[],
    unresolvedDiagnostics:[
      {diagnosticType:"missing_actual_source",vehicleId:"74-39",sourceSlot:"2N",targetSlots:["4S"]}
    ],
    conflicts:[]
  },
  handlerAdapters:{"card-1":{ready:true,row:{actionKey:"row-1"}}}
};
const graphicOverview = buildSdeCanonicalGraphicOverviewData(graphicReader);
assert.deepEqual(graphicOverview.physicalOccupants,{"5M":"69-55","5N":"74-11","10S":"69-63"});
assert.equal(graphicOverview.slots["2N"].unresolvedRows.length,0);
assert.equal(graphicOverview.slots["4S"].unresolvedRows.length,0);
assert.equal(graphicOverview.counts.unresolved,0);
assert.equal(graphicOverview.slots["4S"].proposals.length,1);
assert.equal(graphicOverview.slots["4S"].proposals[0].overlayId,"overlay-1");
assert.equal(graphicReader.graphicProjection.unresolvedDiagnostics.length,1,"underlying diagnostic must remain intact");

console.log(JSON.stringify({
  ok:true,
  scoreGate:blockedScore,
  actionableScore,
  integrityLabel:"Teknisk integritet: PASS",
  actualSlots:graphicOverview.physicalOccupants,
  diagnosticSlotMarkers:graphicOverview.counts.unresolved,
  actionableOverlays:graphicOverview.slots["4S"].proposals.length,
  sideEffects:"presentation-only"
},null,2));

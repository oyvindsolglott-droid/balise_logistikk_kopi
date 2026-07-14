"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(process.argv[2],"utf8");
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map(match=>match[1])
  .find(source=>source.includes("function normalizeSdeCanonicalToken")) || "";
const start = script.indexOf("function normalizeSdeCanonicalToken");
const end = script.indexOf("function getSdeMoveNeedKey",start);
assert(start >= 0 && end > start,"canonical block missing");
const canonicalSource = script.slice(start,end);

global.normalizeSlot = value=>String(value || "").trim().toUpperCase();
global.normalizeTognr = value=>String(value || "").replace(/\D/g,"");
global.isTursattBratsbergTrain = value=>/^24\d{2}$/.test(normalizeTognr(value)) || /^924\d{2}$/.test(normalizeTognr(value));
global.sanitizeVehicleValue = value=>String(value || "").trim();
global.normalizeTimeString = value=>{
  const match = String(value || "").match(/(?:^|[ T])(\d{1,2}):(\d{2})/);
  return match ? `${String(match[1]).padStart(2,"0")}:${match[2]}` : "";
};
global.getSdeShiftSnapshotHash = value=>{
  let hash = 0;
  for(const character of String(value || "")) hash = (Math.imul(31,hash) + character.charCodeAt(0)) | 0;
  return `h${(hash >>> 0).toString(16)}`;
};
global.escapeHtml = value=>String(value ?? "").replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[character]));
global.getSdeArrivalLatestSequenceMinutes = row=>{
  const explicit = Number(row?.sequenceMinutes ?? row?.sortMinutes);
  if(Number.isFinite(explicit) && explicit >= 0) return explicit;
  const text = String(row?.time || row?.arrivalTime || row?.displayTime || "").replace(/\s*\+1\b/g,"");
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if(!match) return -1;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return /\+1\b/.test(String(row?.displayTime || "")) ? minutes + 1440 : minutes;
};
global.window = {location:{search:""}};
vm.runInThisContext(canonicalSource,{filename:"canonical-pendel-slot-mapping-k.js"});

const resolveMovement = vm.runInThisContext("resolveCanonicalPlatformSlotForTrainMovement");
const selectMovement = vm.runInThisContext("selectSdeCanonicalCurrentPendulumMovement");
const reconcile = vm.runInThisContext("buildSdeCanonicalActualStateReconciliation");
const buildPlan = vm.runInThisContext("buildSdeCanonicalPlan");
const buildCards = vm.runInThisContext("buildSdeCanonicalCardProjection");
const buildReservations = vm.runInThisContext("buildSdeCanonicalReservationProjection");
const buildGraphics = vm.runInThisContext("buildSdeCanonicalGraphicProjection");
const buildIntegrity = vm.runInThisContext("buildSdeCanonicalIntegrityReport");
const buildPreviewModel = vm.runInThisContext("buildSdeCanonicalCardPreviewModel");
const buildPreviewHtml = vm.runInThisContext("buildSdeCanonicalCardPreviewHtml");
const stable = value=>JSON.stringify(value);
const clone = value=>JSON.parse(JSON.stringify(value));
const movement = ({vehicle="70-88",train="92489",arrivalTime="20:51",sequenceMinutes=1251,departureTime="",departureSequenceMinutes=null,platformTrack="2",consistContext="single_set",operationalDate="2026-07-13",extra={}}={})=>({
  occurrenceId:`${operationalDate}|arrival|${train}|${arrivalTime}`,
  operationalDate,
  trainNumber:train,
  displayTrainNumber:train,
  arrivalTime,
  sequenceMinutes,
  departureTime,
  ...(Number.isFinite(departureSequenceMinutes) ? {departureSequenceMinutes} : {}),
  platformTrack,
  plannedArrival:`${operationalDate} ${arrivalTime}:00`,
  actualArrival:`${operationalDate} ${arrivalTime}:00`,
  routeId:`route-${operationalDate}-${train}`,
  stopId:`stop-${operationalDate}-${train}`,
  stationName:"Skien",
  stationRef:"SKN",
  movementStatus:"actual_arrival",
  sourceObservedAt:`${operationalDate}T23:30:00+02:00`,
  sourceUpdatedAt:`${operationalDate}T23:30:00+02:00`,
  rawTrackField:"stop_track",
  rawTrackValue:platformTrack,
  trackProvenance:"balise.no/api/train/stops.stop_track",
  payloadOperationalDate:operationalDate,
  payloadTrainNumber:train,
  sourceVehicleIds:[vehicle],
  sourceConsistContext:consistContext,
  serviceContext:isTursattBratsbergTrain(train) ? "bratsberg_existing_train_mapping" : "other_service",
  consistContext,
  vehicleIds:[vehicle],
  provenance:"balise_skien_train_movement",
  ...extra
});
const move = (vehicle,fromSlot,targetSlot,key,extra={})=>({
  vehicle,fromSlot,recommendedSlot:targetSlot,toSlot:targetSlot,stableActionKey:key,
  needKey:`need-${vehicle}`,source:"SDE",canonicalProducer:"ordinary_base_need",canonicalPhysicalValid:true,...extra
});
const project = (candidateRows,actualPlacements)=>{
  const canonicalPlan = buildPlan({actualSources:[{source:"canonical-actual-reconciled",selected:true,rows:actualPlacements}],candidateRows});
  const cardProjection = buildCards(canonicalPlan);
  const reservationProjection = buildReservations(canonicalPlan,cardProjection);
  const graphicProjection = buildGraphics(canonicalPlan,cardProjection,reservationProjection);
  const integrityReport = buildIntegrity({canonicalPlan,cardProjection,reservationProjection,graphicProjection});
  return {canonicalPlan,cardProjection,reservationProjection,graphicProjection,integrityReport};
};

const shared = [{slot:"10S",mat:"69-63"},{slot:"5N",mat:"74-11"},{slot:"5M",mat:"69-55"}];
const baseInput = (vehicle,computedSlot="2N")=>({
  sharedDraftRows:shared,
  computedActualRows:[...shared,{slot:computedSlot,mat:vehicle}],
  sharedDraftRevision:133,
  sharedDraftActive:true,
  snapshotSequenceMinutes:1300
});

// A: Same pendulum train movement maps another vehicle to 2S.
const otherVehicle = "70-88";
const track2Movements = [
  movement({vehicle:otherVehicle,train:"92478",arrivalTime:"12:02",sequenceMinutes:722,departureTime:"12:03",departureSequenceMinutes:723,platformTrack:"3"}),
  movement({vehicle:otherVehicle,train:"92489",arrivalTime:"20:51",sequenceMinutes:1251,platformTrack:"2"})
];
const track2Resolved = resolveMovement(track2Movements[1]);
assert.equal(track2Resolved.status,"resolved");
assert.equal(track2Resolved.sourceSlot,"2S");
const track2Selection = selectMovement({participantVehicleId:otherVehicle,occurrences:track2Movements,snapshotSequenceMinutes:1300});
assert.equal(track2Selection.status,"resolved");
assert.equal(track2Selection.selectedMovement.displayTrainNumber,"92489");
assert.equal(track2Selection.sourceSlot,"2S");
assert.equal(track2Selection.discardedMovements[0].displayTrainNumber,"92478");
const track2Input = {...baseInput(otherVehicle),pendulumOccurrences:track2Movements};
const track2Untouched = clone(track2Input);
const track2Actual = reconcile(track2Input);
assert.deepEqual(track2Input,track2Untouched,"track 2 reconciliation mutated input");
assert.equal(track2Actual.placementsByVehicle[otherVehicle].slot,"2S");
assert.equal(track2Actual.placementsByVehicle[otherVehicle].provenance,"balise_pendulum_current_train_movement");
assert(!track2Actual.actualPlacements.some(item=>item.vehicleId === otherVehicle && item.slot === "2N"));
assert(track2Actual.conflicts.some(item=>item.classification === "PENDULUM_STALE_NORTH_SOURCE_REJECTED"));

// B: Same pendulum train movement maps another vehicle to 3S.
const track3Movements = [movement({vehicle:otherVehicle,platformTrack:"3"})];
const track3Selection = selectMovement({participantVehicleId:otherVehicle,occurrences:track3Movements,snapshotSequenceMinutes:1300});
assert.equal(track3Selection.status,"resolved");
assert.equal(track3Selection.sourceSlot,"3S");
assert(!["3N","3M"].includes(track3Selection.sourceSlot));
const track3Actual = reconcile({...baseInput(otherVehicle,"3N"),pendulumOccurrences:track3Movements});
assert.equal(track3Actual.placementsByVehicle[otherVehicle].slot,"3S");

// C: The regression vehicle in a different train number does not inherit the pendulum rule.
const nonPendulumMovement = movement({vehicle:"74-39",train:"839",arrivalTime:"21:53",sequenceMinutes:1313,platformTrack:"2"});
assert.equal(resolveMovement(nonPendulumMovement).status,"not_applicable");
const nonPendulumSelection = selectMovement({participantVehicleId:"74-39",occurrences:[nonPendulumMovement],snapshotSequenceMinutes:1320});
assert.equal(nonPendulumSelection.status,"not_applicable");
const nonPendulumActual = reconcile({...baseInput("74-39","2N"),snapshotSequenceMinutes:1320,pendulumOccurrences:[nonPendulumMovement]});
assert.equal(nonPendulumActual.placementsByVehicle["74-39"].slot,"2N");
assert.notEqual(nonPendulumActual.placementsByVehicle["74-39"].provenance,"balise_pendulum_current_train_movement");
const nonPendulumProjection = project([
  move("74-39","2N","4S","non-pendulum-74-39",{arrivalDisplayTrain:"839",arrivalConsistContext:"single_set"})
],nonPendulumActual.actualPlacements);
assert.equal(nonPendulumProjection.canonicalPlan.activeOutcomes.length,1,"vehicle-based pendulum rule leaked to train 839");

// D: Closed earlier movements are rejected and the only active movement is selected.
assert.equal(track2Selection.selectedMovement.displayTrainNumber,"92489");
assert.equal(track2Selection.selectedMovement.arrivalTime,"20:51");
assert.equal(track2Selection.selectedMovement.platformTrack,"2");
assert.equal(track2Selection.discardedMovements.length,1);

// E: Multiple active movements or a missing platform track fail closed.
const ambiguousMovements = [
  movement({vehicle:"70-99",train:"92489",arrivalTime:"20:51",sequenceMinutes:1251,platformTrack:"2"}),
  movement({vehicle:"70-99",train:"92490",arrivalTime:"20:51",sequenceMinutes:1251,platformTrack:"3"})
];
const ambiguousSelection = selectMovement({participantVehicleId:"70-99",occurrences:ambiguousMovements,snapshotSequenceMinutes:1300});
assert.equal(ambiguousSelection.status,"ambiguous");
assert.equal(ambiguousSelection.reason,"multiple_current_train_movements");
const ambiguousActual = reconcile({...baseInput("70-99"),pendulumOccurrences:ambiguousMovements});
assert.equal(ambiguousActual.placementsByVehicle["70-99"],undefined);
assert(ambiguousActual.diagnostics.some(item=>item.classification === "AMBIGUOUS_CURRENT_TRAIN_MOVEMENT"));

const missingTrackMovements = [movement({vehicle:"70-77",platformTrack:""})];
const missingTrackSelection = selectMovement({participantVehicleId:"70-77",occurrences:missingTrackMovements,snapshotSequenceMinutes:1300});
assert.equal(missingTrackSelection.status,"ambiguous");
assert.equal(missingTrackSelection.reason,"current_movement_missing_explicit_platform_track");
assert.equal(missingTrackSelection.sourceSlot,"");
const missingTrackActual = reconcile({...baseInput("70-77"),pendulumOccurrences:missingTrackMovements});
assert.equal(missingTrackActual.placementsByVehicle["70-77"],undefined);

// F: A stale 2N candidate is rejected only when the current train movement proves 2S.
const stalePendulumMove = move(otherVehicle,"2N","4S","stale-pendulum-other-vehicle",{
  arrivalDisplayTrain:"92489",
  arrivalConsistContext:"single_set"
});
const stale7454 = move("74-54","5M","4M","stale-74-54",{canonicalProducer:"graphic_drag_generated_move",payloadFromSlot:"2N",isNightPlacementGenerated:true});
const staleProjection = project([stalePendulumMove,stale7454],track2Actual.actualPlacements);
assert.equal(staleProjection.canonicalPlan.activeOutcomes.filter(item=>item.vehicleId === otherVehicle).length,0);
assert.equal(staleProjection.cardProjection.actionableCards.filter(item=>item.vehicleId === otherVehicle).length,0);
assert.equal(staleProjection.reservationProjection.reservations.filter(item=>item.vehicleId === otherVehicle).length,0);
assert.equal(staleProjection.graphicProjection.activeOverlays.filter(item=>item.vehicleId === otherVehicle).length,0);
assert(staleProjection.canonicalPlan.conflicts.some(item=>item.vehicleId === otherVehicle && item.code === "pendulum_stale_north_source"));
assert.equal(staleProjection.cardProjection.diagnostics.filter(item=>item.vehicleId === "74-54" && item.diagnosticType === "stale_or_inconsistent_override").length,1);
assert.equal(staleProjection.canonicalPlan.activeOutcomes.filter(item=>item.vehicleId === "74-54").length,0);
assert.equal(staleProjection.reservationProjection.reservations.filter(item=>item.vehicleId === "74-54").length,0);
assert.equal(staleProjection.graphicProjection.activeOverlays.filter(item=>item.vehicleId === "74-54").length,0);

const correctedTrack2 = project([
  move(otherVehicle,"2S","4S","corrected-other-vehicle",{arrivalDisplayTrain:"92489",arrivalConsistContext:"single_set"})
],track2Actual.actualPlacements);
assert.equal(correctedTrack2.canonicalPlan.activeOutcomes.length,1);
assert.equal(correctedTrack2.cardProjection.actionableCards[0].sourceSlot,"2S");
const correctedTrack3 = project([
  move(otherVehicle,"3S","4S","corrected-other-vehicle-3",{arrivalDisplayTrain:"92489",arrivalConsistContext:"single_set"})
],track3Actual.actualPlacements);
assert.equal(correctedTrack3.canonicalPlan.activeOutcomes.length,1);
assert.equal(correctedTrack3.cardProjection.actionableCards[0].sourceSlot,"3S");

const ambiguousProjection = project([stalePendulumMove,stale7454],ambiguousActual.actualPlacements);
assert.equal(ambiguousProjection.cardProjection.actionableCards.length,0);
assert.equal(ambiguousProjection.reservationProjection.reservations.length,0);
assert.equal(ambiguousProjection.graphicProjection.activeOverlays.length,0);
const ambiguousPreviewModel = buildPreviewModel({...ambiguousProjection,actualStateReconciliation:ambiguousActual});
const ambiguousPreviewHtml = buildPreviewHtml(ambiguousPreviewModel);
assert(ambiguousPreviewModel.diagnostics.some(item=>item.diagnosticType === "ambiguous_current_train_movement"));
assert(ambiguousPreviewHtml.includes("ambiguous_current_train_movement"));
assert(!/<button\b|<input\b|<form\b|onclick\s*=|draggable\s*=/i.test(ambiguousPreviewHtml));
assert.equal(ambiguousProjection.integrityReport.status,"PASS");

const deterministicInput = {...baseInput(otherVehicle),pendulumOccurrences:track2Movements};
const deterministic = stable(reconcile(deterministicInput));
for(let index=0;index<3;index+=1) assert.equal(stable(reconcile(deterministicInput)),deterministic);
for(let index=0;index<10;index+=1){
  const rotate = (rows,amount)=>rows.slice(amount % rows.length).concat(rows.slice(0,amount % rows.length));
  const sourceInput = baseInput(otherVehicle);
  const permuted = reconcile({...sourceInput,sharedDraftRows:rotate(shared,index),computedActualRows:rotate(sourceInput.computedActualRows,index),pendulumOccurrences:rotate(track2Movements,index)});
  assert.equal(stable(permuted),deterministic,`permutation ${index}`);
}

assert(!/SDE_CANONICAL_SINGLE_SET_PENDULUM_VEHICLE_TOKENS|vehicle_not_locked_single_set_pendulum/.test(canonicalSource));
const canonicalCore = canonicalSource.slice(0,canonicalSource.indexOf("function getSdeMoveCardDisplayIndex"));
for(const forbidden of ["localStorage.","fetch(","document.","setTimeout(","addEventListener(","persist("]){
  assert.equal(canonicalCore.includes(forbidden),false,`canonical core contains ${forbidden}`);
}

console.log(JSON.stringify({
  ok:true,
  scope:"index.html canonical shadow/preview only",
  ruleIdentity:"train movement, operational date, occurrence, time, platform track, consist",
  otherVehicleTrack2:{vehicle:otherVehicle,train:"92489",source:"2S"},
  otherVehicleTrack3:{vehicle:otherVehicle,train:"92489",source:"3S"},
  regressionVehicleOtherTrain:{vehicle:"74-39",train:"839",pendulumRuleApplied:false},
  temporalSelection:{selectedTrain:"92489",selectedTime:"20:51",discardedTrain:"92478"},
  ambiguous:{active:0,actionable:0,reservation:0,overlay:0,diagnostic:"ambiguous_current_train_movement"},
  staleCandidate2N:{active:0,actionable:0,reservation:0,overlay:0},
  vehicle7454:{active:0,actionable:0,reservation:0,overlay:0,diagnostic:"stale_or_inconsistent_override"},
  deterministicRuns:3,
  permutations:10,
  sideEffectPolicy:"pure-shadow-readmodel"
},null,2));

const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const html = fs.readFileSync(process.argv[2], "utf8");
const source = html.split("<script>")[2].split("</script>")[0];

function extractFunction(name) {
  const marker = "function " + name + "(";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("Missing function " + name);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  if (!signatureEnd) throw new Error("Missing body for " + name);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unclosed function " + name);
}

const functionNames = [
  "getSdeCanonicalPendulumPlatformTrack",
  "normalizeSdeCanonicalTrainNumber",
  "isSdeCanonicalExistingPendulumTrainNumber",
  "getSdeCanonicalPendulumOccurrenceSequenceMinutes",
  "getSdeCanonicalPendulumMovementTrainNumber",
  "getSdeCanonicalTrainMovementParticipants",
  "getSdeCanonicalPendulumConsistContext",
  "getSdeCanonicalPendulumDepartureSequenceMinutes",
  "getSdeCanonicalMovementClock",
  "getSdeCanonicalLocalDateTimeStamp",
  "isSdeCanonicalSourceObservedAfterActual",
  "normalizeSdeCanonicalTrainMovement",
  "resolveCanonicalPlatformSlotForTrainMovement",
  "selectSdeCanonicalCurrentPendulumMovement",
  "captureSdeCanonicalPendulumOccurrences",
  "buildSdeCanonicalActualStateReconciliation",
  "normalizeBaliseArrivalMovementContext",
  "normalizeApiArrivalMap",
];

const prelude = `
function normalizeTognr(value){ const m=String(value||"").match(/\\d{2,6}/); return m ? m[0] : ""; }
function sanitizeVehicleValue(value){ return String(value||"").trim(); }
function normalizeSdeCanonicalToken(value){ return String(value||"").trim().toLowerCase(); }
function normalizeSlot(value){ const v=String(value||"").trim().toUpperCase(); return /^(?:[1-6][NSM]|U1)$/.test(v) ? v : ""; }
function normalizeTimeString(value){ const m=String(value||"").match(/(?:^|[ T])(\\d{1,2}):(\\d{2})/); return m ? String(m[1]).padStart(2,"0")+":"+m[2] : ""; }
function getSdeArrivalLatestSequenceMinutes(row){ const t=normalizeTimeString(row.time||row.arrivalTime||row.displayTime); if(!t)return -1; const p=t.split(":").map(Number); return p[0]*60+p[1]+(row.nextDay?1440:0); }
function isTursattBratsbergTrain(value){ return /^924\\d{2}$/.test(normalizeTognr(value)); }
function sortSdeCanonicalStrings(values){ return [...values].sort((a,b)=>String(a).localeCompare(String(b),"nb")); }
function stableStringifySdeCanonicalValue(value){ if(Array.isArray(value))return "["+value.map(stableStringifySdeCanonicalValue).join(",")+"]"; if(value&&typeof value==="object"){return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stableStringifySdeCanonicalValue(value[k])).join(",")+"}";} return JSON.stringify(value); }
function sortSdeCanonicalObjects(values){ return [...values].sort((a,b)=>stableStringifySdeCanonicalValue(a).localeCompare(stableStringifySdeCanonicalValue(b),"nb")); }
function cloneSdeCanonicalValue(value){ return value == null ? value : JSON.parse(JSON.stringify(value)); }
var state={baliseMetaToday:{date:"2026-07-13"},apiBalise:{date:"2026-07-13"}};
var __arrivals={};
var __departures={};
var __vehicles={};
function getArrivalMapByMode(){ return __arrivals; }
function getDepartureMapByMode(){ return __departures; }
function getTursattVehicleCellInfo(train){ return {baseValue:__vehicles[train]||""}; }
function splitVehicleNumbers(value){ return String(value||"").split(",").map(v=>v.trim()).filter(Boolean); }
function getDisplayTrainNumberForOppstilling(train){ return normalizeTognr(train); }
`;

const context = {console};
vm.createContext(context);
vm.runInContext(prelude + functionNames.map(extractFunction).join("\n"), context);

function movement(overrides = {}) {
  const vehicle = overrides.vehicle || "74-39";
  const track = Object.prototype.hasOwnProperty.call(overrides, "track") ? overrides.track : "2";
  const train = overrides.train || "92489";
  const time = overrides.time || "20:51";
  const actualArrival = Object.prototype.hasOwnProperty.call(overrides, "actualArrival")
    ? overrides.actualArrival
    : "2026-07-13 20:48:26";
  return {
    occurrenceId: overrides.occurrenceId || "2026-07-13|arrival|" + train + "|" + time,
    operationalDate: overrides.operationalDate || "2026-07-13",
    trainNumber: train,
    displayTrainNumber: train,
    arrivalTime: time,
    sequenceMinutes: overrides.sequenceMinutes == null ? Number(time.slice(0,2)) * 60 + Number(time.slice(3,5)) : overrides.sequenceMinutes,
    plannedArrival: "2026-07-13 " + time + ":00",
    estimatedArrival: actualArrival || "",
    actualArrival: actualArrival || "",
    platformTrack: track,
    routeId: overrides.routeId || "01KWTF17QKV9A5M4N3WXDYXMCC",
    stopId: overrides.stopId || "01KWTF17QKDTDMA8497FMTYKTF",
    stationName: "Skien",
    stationRef: "SKN",
    movementStatus: actualArrival ? "actual_arrival" : "planned_arrival",
    sourceObservedAt: overrides.sourceObservedAt || "2026-07-13T22:55:31+02:00",
    sourceUpdatedAt: "2026-07-13T22:55:30+02:00",
    rawTrackField: "stop_track",
    rawTrackValue: track,
    trackProvenance: "balise.no/api/train/stops.stop_track",
    payloadOperationalDate: overrides.payloadOperationalDate || "2026-07-13",
    payloadTrainNumber: overrides.payloadTrainNumber || train,
    sourceVehicleIds: [vehicle],
    sourceConsistContext: "single_set",
    consistContext: "single_set",
    vehicleIds: [vehicle],
  };
}

const c = context;

const oldPayload = c.normalizeApiArrivalMap({92489:{time:"20:51",nextDay:false}});
assert.deepStrictEqual(JSON.parse(JSON.stringify(oldPayload)), {92489:{time:"20:51",nextDay:false}});

const normalizedPayload = c.normalizeApiArrivalMap({92489:{
  time:"20:51",
  nextDay:false,
  movementContext:{
    operationalDate:"2026-07-13", trainNumber:"92489", occurrenceId:"2026-07-13|arrival|92489|20:51",
    routeId:"r", stopId:"s", stationName:"Skien", stationRef:"SKN", plannedArrival:"2026-07-13 20:51:00",
    actualArrival:"2026-07-13 20:48:26", platformTrack:"2", rawTrackField:"stop_track", rawTrackValue:"2",
    movementStatus:"actual_arrival", sourceObservedAt:"2026-07-13T22:55:31+02:00",
    trackProvenance:"balise.no/api/train/stops.stop_track", vehicleIds:["74-39"], consistContext:"single_set"
  }
}});
assert.strictEqual(normalizedPayload[92489].time, "20:51");
assert.strictEqual(normalizedPayload[92489].movementContext.platformTrack, "2");
c.__arrivals = normalizedPayload;
c.__vehicles = {92489:"74-39"};
const captured = c.captureSdeCanonicalPendulumOccurrences();
assert.strictEqual(captured.length, 1);
assert.strictEqual(captured[0].occurrenceId, "2026-07-13|arrival|92489|20:51");
assert.strictEqual(captured[0].actualArrival, "2026-07-13 20:48:26");
const capturedReconciliation = c.buildSdeCanonicalActualStateReconciliation({pendulumOccurrences:captured,snapshotSequenceMinutes:1260,computedActualRows:[],sharedDraftActive:false});
assert.strictEqual(capturedReconciliation.actualPlacements[0].slot, "2S");

const track2 = c.resolveCanonicalPlatformSlotForTrainMovement(movement());
assert.strictEqual(track2.status, "resolved");
assert.strictEqual(track2.sourceSlot, "2S");
assert.notStrictEqual(track2.sourceSlot, "2N");

const track3 = c.resolveCanonicalPlatformSlotForTrainMovement(movement({track:"3"}));
assert.strictEqual(track3.status, "resolved");
assert.strictEqual(track3.sourceSlot, "3S");
assert.ok(!["3N","3M"].includes(track3.sourceSlot));

const anotherVehicle = c.resolveCanonicalPlatformSlotForTrainMovement(movement({vehicle:"74-01"}));
assert.strictEqual(anotherVehicle.sourceSlot, "2S");

const otherTrain = c.resolveCanonicalPlatformSlotForTrainMovement(movement({train:"829"}));
assert.strictEqual(otherTrain.status, "not_applicable");

const plannedOnly = c.resolveCanonicalPlatformSlotForTrainMovement(movement({actualArrival:""}));
assert.strictEqual(plannedOnly.status, "ambiguous");
assert.strictEqual(plannedOnly.reason, "movement_planned_not_actual");

const observedTooEarly = c.resolveCanonicalPlatformSlotForTrainMovement(movement({sourceObservedAt:"2026-07-13T20:47:59+02:00"}));
assert.strictEqual(observedTooEarly.status, "ambiguous");
assert.strictEqual(observedTooEarly.reason, "movement_observed_before_actual_arrival");

const missingTrack = c.resolveCanonicalPlatformSlotForTrainMovement(movement({track:""}));
assert.strictEqual(missingTrack.status, "ambiguous");
assert.strictEqual(missingTrack.reason, "current_movement_missing_explicit_platform_track");

const staleDate = c.resolveCanonicalPlatformSlotForTrainMovement(movement({payloadOperationalDate:"2026-07-12"}));
assert.strictEqual(staleDate.status, "ambiguous");
assert.strictEqual(staleDate.reason, "movement_payload_identity_mismatch");

const older = movement({train:"92485",time:"16:55",sequenceMinutes:1015,track:"3",occurrenceId:"2026-07-13|arrival|92485|16:55"});
older.plannedArrival = "2026-07-13 16:55:00";
older.payloadTrainNumber = "92485";
const current = movement();
const future = movement({train:"92492",time:"22:00",sequenceMinutes:1320,track:"3",occurrenceId:"2026-07-13|arrival|92492|22:00"});
future.plannedArrival = "2026-07-13 22:00:00";
future.payloadTrainNumber = "92492";
const selected = c.selectSdeCanonicalCurrentPendulumMovement({participantVehicleId:"74-39", occurrences:[future,older,current], snapshotSequenceMinutes:1260});
assert.strictEqual(selected.status, "resolved");
assert.strictEqual(selected.selectedMovement.occurrenceId, "2026-07-13|arrival|92489|20:51");
assert.strictEqual(selected.sourceSlot, "2S");
assert.ok(selected.discardedMovements.some(row=>row.occurrenceId.includes("92485")));
assert.ok(selected.discardedMovements.some(row=>row.occurrenceId.includes("92492")));

const ambiguousTwin = movement({occurrenceId:"2026-07-13|arrival|92489|20:51-twin"});
const ambiguous = c.selectSdeCanonicalCurrentPendulumMovement({participantVehicleId:"74-39", occurrences:[current,ambiguousTwin], snapshotSequenceMinutes:1260});
assert.strictEqual(ambiguous.status, "ambiguous");
assert.strictEqual(ambiguous.reason, "multiple_current_train_movements");

const reconciliation = c.buildSdeCanonicalActualStateReconciliation({
  computedActualRows:[{vehicleId:"74-39",slot:"2N"}],
  pendulumOccurrences:[current],
  snapshotSequenceMinutes:1260,
  sharedDraftActive:false,
});
assert.strictEqual(reconciliation.actualPlacements.length, 1);
assert.strictEqual(reconciliation.actualPlacements[0].slot, "2S");
assert.ok(reconciliation.conflicts.some(row=>row.classification === "PENDULUM_STALE_NORTH_SOURCE_REJECTED"));

for (const bad of [movement({actualArrival:""}), movement({track:""}), movement({sourceObservedAt:"2026-07-13T20:47:59+02:00"})]) {
  const result = c.buildSdeCanonicalActualStateReconciliation({
    computedActualRows:[{vehicleId:"74-39",slot:"2N"}], pendulumOccurrences:[bad], snapshotSequenceMinutes:1260, sharedDraftActive:false,
  });
  assert.strictEqual(result.actualPlacements.length, 0);
  assert.ok(result.diagnostics.some(row=>row.classification === "AMBIGUOUS_CURRENT_TRAIN_MOVEMENT"));
}

const control7454 = c.buildSdeCanonicalActualStateReconciliation({
  computedActualRows:[], pendulumOccurrences:[current], snapshotSequenceMinutes:1260, sharedDraftActive:false,
});
assert.ok(!control7454.actualPlacements.some(row=>row.vehicleId === "74-54"));

const inputOccurrences = [future,older,current];
const originalInput = JSON.stringify(inputOccurrences);
const runs = [];
for (let i=0;i<3;i+=1) runs.push(c.stableStringifySdeCanonicalValue(c.selectSdeCanonicalCurrentPendulumMovement({participantVehicleId:"74-39",occurrences:inputOccurrences,snapshotSequenceMinutes:1260})));
assert.strictEqual(new Set(runs).size, 1);
assert.strictEqual(JSON.stringify(inputOccurrences), originalInput);

const permutations = [];
for (let i=0;i<10;i+=1) {
  const values = [future,older,current];
  values.unshift(...values.splice(i % values.length, 1));
  permutations.push(c.stableStringifySdeCanonicalValue(c.selectSdeCanonicalCurrentPendulumMovement({participantVehicleId:"74-39",occurrences:values,snapshotSequenceMinutes:1260})));
}
assert.strictEqual(new Set(permutations).size, 1);

console.log("sde-m-js-tests: ok");

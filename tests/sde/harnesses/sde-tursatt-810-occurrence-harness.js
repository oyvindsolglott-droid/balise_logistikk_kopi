"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(process.argv[2] || path.join(root, "index.html"), "utf8");
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, "tests/fixtures/balise_tursatt_810_2026-08-12.json"),
  "utf8",
));

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  for(let index = open; index < source.length; index += 1){
    if(source[index] === "{") depth += 1;
    if(source[index] === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start,index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

const sanitize = value=>{
  const clean = String(value || "").trim();
  return !clean || clean === "-" || clean.toLowerCase() === "ukjent" ? "" : clean;
};
const normalizeTime = value=>{
  const match = String(value || "").match(/\b(\d{1,2}):(\d{2})\b/);
  return match ? `${match[1].padStart(2,"0")}:${match[2]}` : "";
};
const context = vm.createContext({
  state:{
    baliseTodayDepartureOccurrences:{}, baliseTomorrowDepartureOccurrences:{},
    baliseTodayDepartureVehicles:{}, baliseTomorrowDepartureVehicles:{},
    baliseTodayVehicleErrors:{}, baliseTomorrowVehicleErrors:{},
    baliseToday:{}, baliseTomorrow:{},
    baliseMetaToday:{date:fixture.serviceDate}, baliseMetaTomorrow:{date:fixture.serviceDate},
    manualTursattDepartureVehicles:{}, manualTursattArrivalVehicles:{},
    baliseTodayArrivalVehicles:{}, baliseTomorrowArrivalVehicles:{}
  },
  normalizeTognr:value=>String(value || "").trim(),
  normalizeTimeString:normalizeTime,
  sanitizeVehicleValue:sanitize,
  splitVehicleNumbers:value=>{
    const parts=String(value || "").split(",").map(item=>sanitize(item)).filter(Boolean);
    return [parts[0] || "",parts[1] || ""];
  },
  getTursattBratsbergAlternativeTrainNumbers:train=>[String(train || "").trim()],
  getArrivalDisplayTrainNumberMapByMode:()=>({}),
  getVehicleErrorMapByMode:mode=>mode === "idag" ? context.state.baliseTodayVehicleErrors : context.state.baliseTomorrowVehicleErrors,
  getBaliseMapByMode:mode=>mode === "idag" ? context.state.baliseToday : context.state.baliseTomorrow,
  getBaseVehicleForTrain:()=>""
});

vm.runInContext([
  extractFunction("normalizeBaliseDepartureOccurrence"),
  extractFunction("normalizeBaliseDepartureOccurrenceMap"),
  extractFunction("getTursattDepartureServiceDateForMode"),
  extractFunction("getTursattBaseVehicleMapByMode"),
  extractFunction("getTursattDepartureOccurrenceMapByMode"),
  extractFunction("inspectTursattDepartureOccurrence"),
  extractFunction("getTursattVehicleCellInfo"),
  extractFunction("createOppstillingVehicleCells"),
  extractFunction("getTursattVehicleError"),
  "this.api={normalizeBaliseDepartureOccurrenceMap,inspectTursattDepartureOccurrence,createOppstillingVehicleCells,getTursattVehicleError};"
].join("\n"),context);

const rawOccurrence = {
  operationalDate:fixture.serviceDate,
  requestedTrainNumber:fixture.logicalTrain,
  displayTrainNumber:fixture.lookupTrainNumber,
  occurrenceId:`${fixture.serviceDate}|departure|${fixture.lookupTrainNumber}|${fixture.plannedDeparture}`,
  routeId:fixture.routeInfo.routeId,
  origin:fixture.routeInfo.origin,
  destination:fixture.routeInfo.destination,
  station:fixture.station,
  stationRef:fixture.stationRef,
  stopId:fixture.routeStops[0].stop_id,
  direction:fixture.direction,
  eventType:fixture.eventType,
  departureTime:fixture.plannedDeparture,
  plannedDeparture:fixture.plannedDeparture,
  actualDeparture:fixture.actualDeparture,
  vehicleIds:fixture.departureHits,
  vehicleResolutionSource:"skien_occurrence_departure_assignment",
  vehicleError:""
};
const occurrenceMap = context.api.normalizeBaliseDepartureOccurrenceMap({810:rawOccurrence});
context.state.baliseTomorrowDepartureOccurrences = occurrenceMap;
context.state.baliseTomorrowDepartureVehicles = {810:"74-14, 74-38"};
const row = {train:"810",mode:"imorgen",serviceDate:fixture.serviceDate,time:fixture.plannedDeparture,displayTime:fixture.plannedDeparture};
const results = [];
const check = (id,fn)=>{
  try{ fn(); results.push({id,status:"PASS"}); }
  catch(error){ results.push({id,status:"FAIL",detail:error.message}); }
};

check("authoritative-material",()=>{
  const cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",row);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-14","74-38"]);
});
check("no-uavklart",()=>assert.equal(context.api.getTursattVehicleError(row,"departure"),""));
check("explicit-order",()=>{
  context.state.baliseTomorrowDepartureVehicles={810:"74-38, 74-14"};
  assert.equal(context.api.inspectTursattDepartureOccurrence(row).valid,false);
  context.state.baliseTomorrowDepartureVehicles={810:"74-14, 74-38"};
});
check("no-cross-date",()=>assert.equal(context.api.inspectTursattDepartureOccurrence({...row,serviceDate:"2026-08-13"}).valid,false));
check("departure-not-arrival",()=>{
  const saved=context.state.baliseTomorrowDepartureOccurrences;
  context.state.baliseTomorrowDepartureOccurrences={810:{...occurrenceMap[810],direction:"arrival",eventType:"arrival"}};
  assert.equal(context.api.inspectTursattDepartureOccurrence(row).valid,false);
  context.state.baliseTomorrowDepartureOccurrences=saved;
});
check("missing-material-uavklart",()=>{
  context.state.baliseTomorrowDepartureVehicles={};
  assert.match(context.api.getTursattVehicleError(row,"departure"),/Uavklart/);
  context.state.baliseTomorrowDepartureVehicles={810:"74-14, 74-38"};
});
check("planned-actual-separate",()=>{
  assert.equal(occurrenceMap[810].plannedDeparture,"08:09");
  assert.equal(occurrenceMap[810].actualDeparture,"08:20");
  assert.equal(row.time,"08:09");
});

const failed=results.filter(item=>item.status!=="PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-tursatt-810-occurrence-harness-v1",
  counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
  results,
  serviceDate:fixture.serviceDate,
  trainNumber:fixture.logicalTrain,
  plannedDeparture:fixture.plannedDeparture,
  actualDeparture:fixture.actualDeparture,
  vehicles:fixture.departureHits
})}\n`);
process.exitCode=failed.length ? 1 : 0;

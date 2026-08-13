"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(process.argv[2] || path.join(root, "index.html"), "utf8");
const historical = JSON.parse(fs.readFileSync(
  path.join(root, "tests/fixtures/balise_tursatt_810_2026-08-12.json"),
  "utf8",
));
const otherDate = JSON.parse(fs.readFileSync(
  path.join(root, "tests/fixtures/balise_tursatt_810_2026-08-13.json"),
  "utf8",
));
const train24xx = JSON.parse(fs.readFileSync(
  path.join(root, "tests/fixtures/balise_24xx_occurrence_binding.json"),
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
const joinVehicles = (first,second)=>[first,second].map(sanitize).filter(Boolean).join(", ");
const context = vm.createContext({
  state:{
    baliseTodayDepartureOccurrences:{}, baliseTomorrowDepartureOccurrences:{},
    baliseTodayDepartureVehicles:{}, baliseTomorrowDepartureVehicles:{},
    baliseTodayVehicleErrors:{}, baliseTomorrowVehicleErrors:{},
    baliseToday:{}, baliseTomorrow:{},
    baliseTodayDepartures:{}, baliseTomorrowDepartures:{},
    baliseTodayArrivals:{}, baliseTomorrowArrivals:{},
    baliseMetaToday:{date:historical.serviceDate}, baliseMetaTomorrow:{date:historical.serviceDate},
    manualTursattDepartureVehicles:{}, manualTursattArrivalVehicles:{},
    baliseTodayArrivalVehicles:{}, baliseTomorrowArrivalVehicles:{}
  },
  normalizeTognr:value=>String(value || "").trim(),
  normalizeTimeString:normalizeTime,
  sanitizeVehicleValue:sanitize,
  joinVehicleNumbers:joinVehicles,
  splitVehicleNumbers:value=>{
    const parts=String(value || "").split(",").map(item=>sanitize(item)).filter(Boolean);
    return [parts[0] || "",parts[1] || ""];
  },
  getTursattBratsbergAlternativeTrainNumbers:train=>[String(train || "").trim()],
  getArrivalDisplayTrainNumberMapByMode:()=>({}),
  getVehicleErrorMapByMode:mode=>mode === "idag" ? context.state.baliseTodayVehicleErrors : context.state.baliseTomorrowVehicleErrors,
  getBaliseMapByMode:mode=>mode === "idag" ? context.state.baliseToday : context.state.baliseTomorrow,
  getDepartureMapByMode:mode=>mode === "idag" ? context.state.baliseTodayDepartures : context.state.baliseTomorrowDepartures,
  getArrivalMapByMode:mode=>mode === "idag" ? context.state.baliseTodayArrivals : context.state.baliseTomorrowArrivals,
  getBaseVehicleForTrain:()=>""
});

vm.runInContext([
  extractFunction("normalizeBaliseDepartureOccurrence"),
  extractFunction("normalizeBaliseDepartureOccurrenceMap"),
  extractFunction("getTursattDepartureServiceDateForMode"),
  extractFunction("getTursattBaseVehicleMapByMode"),
  extractFunction("getTursattDepartureOccurrenceMapByMode"),
  extractFunction("getTursattOccurrenceSourceRevision"),
  extractFunction("buildTursattCanonicalOccurrenceIdentity"),
  extractFunction("getTursattCanonicalOccurrencePartKey"),
  extractFunction("getTursattDepartureOccurrenceCandidates"),
  extractFunction("inspectTursattDepartureOccurrence"),
  extractFunction("inspectTursattArrivalOccurrence"),
  extractFunction("getTursattOccurrenceBinding"),
  extractFunction("getManualTursattOccurrenceVehicles"),
  extractFunction("setManualTursattVehicleOverride"),
  extractFunction("getTursattVehicleCellInfo"),
  extractFunction("createOppstillingVehicleCells"),
  extractFunction("getTursattVehicleError"),
  "this.api={normalizeBaliseDepartureOccurrenceMap,inspectTursattDepartureOccurrence,createOppstillingVehicleCells,getTursattVehicleError,setManualTursattVehicleOverride,getTursattCanonicalOccurrencePartKey};"
].join("\n"),context);

function makeOccurrence(fixture, overrides={}){
  return {
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
    sourceRevision:fixture.sourceRevision,
    vehicleIds:fixture.departureHits,
    vehicleResolutionSource:"skien_occurrence_departure_assignment",
    vehicleError:"",
    ...overrides
  };
}

const historicalOccurrence = makeOccurrence(historical);
const otherDateOccurrence = makeOccurrence(otherDate);
const setOccurrences = values=>{
  context.state.baliseTomorrowDepartureOccurrences = context.api.normalizeBaliseDepartureOccurrenceMap({810:values});
};
const make24xxOccurrence = fixture=>{
  const skienStop=(fixture.routeStops||[]).find(stop=>stop.station_ref==="SKN"||stop.station_name==="Skien")||{};
  const vehicles=(fixture.vehicleRows||[])
    .filter(row=>row.sv_route===fixture.routeInfo.routeId&&row.station_name==="Skien")
    .sort((left,right)=>Number(left.position)-Number(right.position))
    .map(row=>row.vehicle);
  return {
    operationalDate:fixture.operationalDate,
    requestedTrainNumber:fixture.lookupTrainNumber,
    displayTrainNumber:fixture.lookupTrainNumber,
    occurrenceId:`${fixture.operationalDate}|departure|${fixture.lookupTrainNumber}|${fixture.plannedDeparture}`,
    routeId:fixture.routeInfo.routeId,
    origin:fixture.routeInfo.origin,
    destination:fixture.routeInfo.destination,
    station:"Skien",
    stationRef:"SKN",
    stopId:skienStop.stop_id,
    direction:"departure",
    eventType:"departure",
    departureTime:fixture.plannedDeparture,
    plannedDeparture:fixture.plannedDeparture,
    actualDeparture:"",
    sourceRevision:fixture.sourceRevision,
    vehicleIds:vehicles,
    vehicleResolutionSource:"skien_occurrence_route_vehicles",
    vehicleError:""
  };
};
const occurrences24xx=train24xx.occurrences.map(make24xxOccurrence);
const set24xxOccurrences = values=>{
  context.state.baliseTomorrowDepartureOccurrences = context.api.normalizeBaliseDepartureOccurrenceMap({2473:values});
};
const historicalRow = {
  train:"810", mode:"imorgen", serviceDate:historical.serviceDate,
  station:"Skien", stationRef:"SKN", movement:"departure", direction:"departure",
  time:historical.plannedDeparture, displayTime:historical.plannedDeparture
};
const otherDateRow = {...historicalRow,serviceDate:otherDate.serviceDate};
setOccurrences([historicalOccurrence,otherDateOccurrence]);

const results = [];
const check = (id,fn)=>{
  try{ fn(); results.push({id,status:"PASS"}); }
  catch(error){ results.push({id,status:"FAIL",detail:error.message}); }
};

check("historical-occurrence-fixture-only",()=>{
  assert.equal(historical.fixtureRole,"HISTORICAL_OCCURRENCE_FIXTURE_ONLY");
  const cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",historicalRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-14","74-38"]);
  assert.equal(context.api.getTursattVehicleError(historicalRow,"departure"),"");
});

check("same-train-other-date-own-material",()=>{
  assert.equal(otherDate.fixtureRole,"SYNTHETIC_OCCURRENCE_FIXTURE_ONLY");
  const cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",otherDateRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-21","74-22"]);
  assert.notDeepEqual([cells.vehicle1,cells.vehicle2],["74-14","74-38"]);
});

check("canonical-id-is-derived-when-legacy-source-id-is-absent",()=>{
  const legacy={...historicalOccurrence};
  delete legacy.occurrenceId;
  delete legacy.stopId;
  delete legacy.stationRef;
  delete legacy.sourceRevision;
  setOccurrences([legacy,otherDateOccurrence]);
  const inspected=context.api.inspectTursattDepartureOccurrence(historicalRow);
  assert.equal(inspected.valid,true);
  assert.equal(inspected.identity.sourceOccurrenceId,"2026-08-12|departure|810|08:09");
  const cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",historicalRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-14","74-38"]);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
});

check("cross-date-rejected",()=>{
  assert.equal(context.api.inspectTursattDepartureOccurrence({...historicalRow,serviceDate:"2026-08-14"}).valid,false);
});

check("cross-direction-rejected",()=>{
  setOccurrences([{...historicalOccurrence,direction:"northbound"}]);
  assert.equal(context.api.inspectTursattDepartureOccurrence(historicalRow).valid,false);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
});

check("cross-movement-rejected",()=>{
  setOccurrences([{...historicalOccurrence,eventType:"arrival"}]);
  assert.equal(context.api.inspectTursattDepartureOccurrence(historicalRow).valid,false);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
});

check("cross-station-rejected",()=>{
  setOccurrences([{...historicalOccurrence,station:"Porsgrunn",stationRef:"PG"}]);
  assert.equal(context.api.inspectTursattDepartureOccurrence(historicalRow).valid,false);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
});

check("planned-time-distinguishes-same-day-occurrences",()=>{
  const later=makeOccurrence(historical,{
    occurrenceId:"2026-08-12|departure|810|09:09",
    routeId:"fixture-route-810-20260812-later",
    stopId:"fixture-stop-skien-810-later",
    plannedDeparture:"09:09", departureTime:"09:09", actualDeparture:"09:12",
    sourceRevision:"fixture-later-revision", vehicleIds:["74-23","74-24"]
  });
  setOccurrences([historicalOccurrence,later]);
  const laterRow={...historicalRow,time:"09:09",displayTime:"09:09"};
  const cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",laterRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-23","74-24"]);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
});

check("part-specific-overrides-do-not-cross",()=>{
  context.state.manualTursattDepartureVehicles={};
  context.api.setManualTursattVehicleOverride("810","departure","74-31","74-32","imorgen",historicalRow);
  const binding=context.api.inspectTursattDepartureOccurrence(historicalRow);
  const key1=context.api.getTursattCanonicalOccurrencePartKey(binding.identity,"1");
  const key2=context.api.getTursattCanonicalOccurrencePartKey(binding.identity,"2");
  assert.notEqual(key1,key2);
  delete context.state.manualTursattDepartureVehicles[key2];
  const cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",historicalRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-31","74-38"]);
});

check("ambiguous-occurrence-fails-closed",()=>{
  context.state.manualTursattDepartureVehicles={};
  setOccurrences([
    historicalOccurrence,
    {...historicalOccurrence,occurrenceId:"fixture-ambiguous-twin",routeId:"fixture-twin-route",stopId:"fixture-twin-stop"}
  ]);
  const inspected=context.api.inspectTursattDepartureOccurrence(historicalRow);
  assert.equal(inspected.valid,false);
  assert.match(inspected.error,/Uavklart/);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
});

check("source-refresh-invalidates-stale-cache",()=>{
  context.state.manualTursattDepartureVehicles={};
  context.api.setManualTursattVehicleOverride("810","departure","74-31","74-32","imorgen",historicalRow);
  const refreshed={...historicalOccurrence,sourceRevision:"fixture-balise-revision-refreshed",vehicleIds:["74-33","74-34"]};
  setOccurrences([refreshed,otherDateOccurrence]);
  let cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",historicalRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-33","74-34"]);
  context.api.setManualTursattVehicleOverride("810","departure","74-35","74-36","imorgen",historicalRow);
  cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",historicalRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-35","74-36"]);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
  context.state.manualTursattDepartureVehicles={};
});

check("balise-then-uavklart-fallback",()=>{
  let cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",historicalRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["74-14","74-38"]);
  setOccurrences([{...historicalOccurrence,vehicleIds:[],vehicleError:"fixture missing material"}]);
  cells=context.api.createOppstillingVehicleCells("810","departure","imorgen",historicalRow);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["",""]);
  assert.match(context.api.getTursattVehicleError(historicalRow,"departure"),/Uavklart|fixture missing material/);
  setOccurrences([historicalOccurrence,otherDateOccurrence]);
});

check("planned-and-actual-times-stay-separate",()=>{
  const normalized=context.api.normalizeBaliseDepartureOccurrenceMap({810:historicalOccurrence})[810];
  assert.equal(normalized.plannedDeparture,"08:09");
  assert.equal(normalized.actualDeparture,"08:20");
  assert.equal(historicalRow.time,"08:09");
});

check("no-train-number-only-vehicle-policy",()=>{
  const productionFiles=["index.html","update_static_data.py","config.js"]
    .filter(file=>fs.existsSync(path.join(root,file)));
  const forbidden=/(?:810[^\n]{0,160}(?:74-14|74-38)|(?:74-14|74-38)[^\n]{0,160}810)/;
  productionFiles.forEach(file=>{
    const text=fs.readFileSync(path.join(root,file),"utf8");
    assert.doesNotMatch(text,forbidden,`${file} contains a train-number-only 810 vehicle assignment`);
  });
  assert.ok(source.includes("getTursattCanonicalOccurrencePartKey"));
  assert.ok(source.includes("Manuelle Tursatt-verdier er forekomst- og delbundet"));
});

check("24xx-exact-occurrence-renders-authoritative-material",()=>{
  set24xxOccurrences(occurrences24xx);
  const row={train:"2473",mode:"imorgen",serviceDate:"2026-08-13",station:"Skien",stationRef:"SKN",movement:"departure",direction:"departure",time:"07:31",displayTime:"07:31"};
  const cells=context.api.createOppstillingVehicleCells("2473","departure","imorgen",row);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["69-63","69-70"]);
  assert.equal(context.api.getTursattVehicleError(row,"departure"),"");
});

check("24xx-source-order-and-parts-remain-distinct",()=>{
  set24xxOccurrences(occurrences24xx);
  const row={train:"2473",mode:"imorgen",serviceDate:"2026-08-13",station:"Skien",stationRef:"SKN",movement:"departure",direction:"departure",time:"07:31",displayTime:"07:31"};
  const binding=context.api.inspectTursattDepartureOccurrence(row);
  const cells=context.api.createOppstillingVehicleCells("2473","departure","imorgen",row);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["69-63","69-70"]);
  assert.notEqual(
    context.api.getTursattCanonicalOccurrencePartKey(binding.identity,"1"),
    context.api.getTursattCanonicalOccurrencePartKey(binding.identity,"2"),
  );
});

check("24xx-cross-date-and-same-day-time-do-not-leak",()=>{
  set24xxOccurrences(occurrences24xx);
  const base={train:"2473",mode:"imorgen",station:"Skien",stationRef:"SKN",movement:"departure",direction:"departure"};
  const otherDay={...base,serviceDate:"2026-08-14",time:"07:31",displayTime:"07:31"};
  const later={...base,serviceDate:"2026-08-13",time:"17:31",displayTime:"17:31"};
  assert.deepEqual(Object.values(context.api.createOppstillingVehicleCells("2473","departure","imorgen",otherDay)).slice(0,2),["69-71",""]);
  assert.deepEqual(Object.values(context.api.createOppstillingVehicleCells("2473","departure","imorgen",later)).slice(0,2),["69-72",""]);
});

check("24xx-missing-authoritative-material-remains-uavklart",()=>{
  set24xxOccurrences([{...occurrences24xx[0],vehicleIds:[],vehicleError:"fixture missing 24xx material"}]);
  const row={train:"2473",mode:"imorgen",serviceDate:"2026-08-13",station:"Skien",stationRef:"SKN",movement:"departure",direction:"departure",time:"07:31",displayTime:"07:31"};
  const cells=context.api.createOppstillingVehicleCells("2473","departure","imorgen",row);
  assert.deepEqual([cells.vehicle1,cells.vehicle2],["",""]);
  assert.match(context.api.getTursattVehicleError(row,"departure"),/Uavklart|fixture missing 24xx material/);
});

const failed=results.filter(item=>item.status!=="PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-tursatt-dynamic-occurrence-harness-v2",
  counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
  results,
  historical:{
    serviceDate:historical.serviceDate,
    trainNumber:historical.logicalTrain,
    plannedDeparture:historical.plannedDeparture,
    actualDeparture:historical.actualDeparture,
    vehicles:historical.departureHits
  },
  otherDate:{
    serviceDate:otherDate.serviceDate,
    trainNumber:otherDate.logicalTrain,
    vehicles:otherDate.departureHits
  }
})}\n`);
process.exitCode=failed.length ? 1 : 0;

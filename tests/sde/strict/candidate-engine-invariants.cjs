"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname, "../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));
const results = [];
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

process.argv[2] = indexPath;
globalThis.__candidateEngineResults = results;
globalThis.__candidateEngineRecord = record;

eval(prefix + String.raw`
(()=>{
  const put=globalThis.__candidateEngineRecord;
  const inventory=vm.runInContext("inputSlots.slice()",ctx);
  resetState([]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const ordinary=ctx.getSdeResolutionCandidateSlots("10S","10N");
  const diagnostics=ctx.buildSdeCanonicalCandidateDiagnostics("ENGINE-VEHICLE","10S","10N");
  put(
    "INV-CANDIDATE-001",
    diagnostics.length===inventory.length
      && inventory.every(slot=>diagnostics.some(item=>item.slot===slot))
      && diagnostics.every(item=>["occupancy","reservation","hardEligibility","score","confidence","routeResult","rejectionReason"].every(key=>Object.prototype.hasOwnProperty.call(item,key))),
    "every authorized slot is enumerated with occupancy, reservation, hard eligibility, score, confidence, route result and rejection reason"
  );
  put(
    "INV-CANDIDATE-002",
    ["4S","5S","9"].every(slot=>ordinary.includes(slot))
      && ["2N","3M","6SS","7N","8S","7SS","VS","VN"].every(slot=>!ordinary.includes(slot))
      && diagnostics.filter(item=>["2N","3M","6SS","7N","8S","7SS"].includes(item.slot)).every(item=>item.hardEligibility===false&&item.reasons.includes("wrong_slot_role_for_context")),
    "the full inventory is classified while platform, workshop and access roles are rejected rather than silently omitted from diagnostics"
  );

  const reliefContext={
    temporaryRelief:true,
    reliefPlanning:true,
    conflictKnown:true,
    concreteBlockageKnown:true,
    sourceType:"BLOCKED_TARGET_ACCESS",
    physicalState:{vnOccupied:false,accessSlotFree:true}
  };
  const relief=ctx.getSdeResolutionCandidateSlots("4N","5M",reliefContext);
  put(
    "INV-CANDIDATE-003",
    relief.includes("VN") && relief.some(slot=>slot!=="VN") && relief.indexOf("VN")>=0,
    "VN is an active temporary-relief candidate evaluated in the same search as ordinary relief candidates"
  );

  resetState([["9","ENGINE-VEHICLE"]]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const recommendation=ctx.getSdeCanonicalResolutionRecommendation("ENGINE-VEHICLE","9","");
  put(
    "INV-CANDIDATE-004",
    recommendation.safeCandidateCount>1 && recommendation.slot && recommendation.slot!=="1N" && recommendation.searchedSlots.length===inventory.length,
    "1N is neither a global default nor a short-circuit; the full inventory is searched before selection"
  );

  const staleReservations=vm.runInContext('new Map([["4S",{slot:"4S",status:"STALE"}]])',ctx);
  const activeReservations=vm.runInContext('new Map([["4S",{slot:"4S",status:"ACTIVE"}]])',ctx);
  const staleDiagnostic=ctx.buildSdeCanonicalCandidateDiagnostics("ENGINE-VEHICLE","9","",{activeReservations:staleReservations}).find(item=>item.slot==="4S");
  const activeDiagnostic=ctx.buildSdeCanonicalCandidateDiagnostics("ENGINE-VEHICLE","9","",{activeReservations}).find(item=>item.slot==="4S");
  put(
    "INV-CANDIDATE-005",
    staleDiagnostic?.reservation==="none" && !staleDiagnostic?.reasons.includes("active_reservation")
      && activeDiagnostic?.reservation==="active" && activeDiagnostic?.hardEligibility===false && activeDiagnostic?.reasons.includes("active_reservation"),
    "stale/superseded reservations are removed while active canonical reservations still exclude their target"
  );

  const lowNeed={vehicle:"ENGINE-VEHICLE",arrivalSlot:"2N",nextDepartureTrain:"810",nextDepartureTime:"10:00",nextDeparturePart:"1"};
  const arrivalCandidates=ctx.getSdeArrivalParkingCandidateSlots(lowNeed);
  const firstCandidate=arrivalCandidates.find(slot=>slot!=="9"&&slot!=="10N");
  const closedArrivalPlacements=arrivalCandidates
    .filter(slot=>!["2N","10N","10S"].includes(slot))
    .map((slot,index)=>[slot,"OTHER-VEHICLE-"+index]);
  resetState([["2N","ENGINE-VEHICLE"],...closedArrivalPlacements]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const arrival=vm.runInContext('getSdeArrivalParkingRecommendation({vehicle:"ENGINE-VEHICLE",arrivalSlot:"2N",nextDepartureTrain:"810",nextDepartureTime:"10:00",nextDeparturePart:"1"},new Map([["10S",{need:{vehicle:"PAIR-VEHICLE",nextDepartureTrain:"811",nextDepartureTime:"12:00",nextDeparturePart:"1"},recommendation:{slot:"10S"},status:"ACTIVE"}]]))',ctx);
  const firstDiagnostic=arrival.candidateDiagnostics.find(item=>item.slot===firstCandidate);
  const lowDiagnostic=arrival.candidateDiagnostics.find(item=>item.slot==="10N");
  const rejectedIndex=arrival.candidateDiagnostics.findIndex(item=>item.finalStatus==="rejected");
  const laterCandidateIndex=arrival.candidateDiagnostics.findIndex((item,index)=>index>rejectedIndex&&item.finalStatus==="candidate");
  put(
    "INV-CANDIDATE-006",
    firstDiagnostic?.finalStatus==="rejected" && rejectedIndex>=0 && laterCandidateIndex>rejectedIndex && arrival.slot==="10N",
    "one rejected candidate does not end the authorized search"
  );
  put(
    "INV-CANDIDATE-007",
    arrival.slot==="10N" && lowDiagnostic?.finalStatus==="candidate" && lowDiagnostic?.belowDesirabilityThreshold===true && lowDiagnostic?.score<45,
    "a physically admissible low-score candidate is retained as fallback instead of being discarded by desirability"
  );

  const workshopRequest={vehicleId:"74-14",visitId:"stale-request",exitRequestId:"exit-1"};
  const workshopPlacement={vehicleId:"74-14",slot:"7S",workshopVisitId:"different-stale-id",inWorkshop:false};
  const reconciled=ctx.reconcileSdeWorkshopExitPlacement(workshopRequest,[workshopPlacement],[workshopRequest]);
  const ambiguous=ctx.reconcileSdeWorkshopExitPlacement(workshopRequest,[workshopPlacement],[workshopRequest,{...workshopRequest,exitRequestId:"exit-2"}]);
  put(
    "INV-CANDIDATE-008",
    reconciled.ok===true && reconciled.reconciled===true && reconciled.placement?.slot==="7S" && ambiguous.ok===false && ambiguous.ambiguous===true,
    "one unique actual workshop placement reconciles stale visit metadata while true ambiguity remains fail-closed"
  );

  resetState([["9","REPLAN-VEHICLE"],["4M","BLOCKING-VEHICLE"]]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const blockedRow={
    vehicle:"REPLAN-VEHICLE",
    fromSlot:"9",
    arrivalSlot:"9",
    recommendedSlot:"4M",
    toSlot:"4M",
    originalRequestedTarget:"4M",
    status:"BLOCKED_UNRESOLVED",
    source:"blocked_target"
  };
  const replanned=ctx.buildSdeCanonicalAutomaticReplanRows([blockedRow],{legacy:{reservations:[]}});
  const replacement=replanned.rows[0];
  put(
    "INV-CANDIDATE-009",
    replanned.replans.length===1 && replacement.sdeAutomaticReplan===true
      && replacement.originalRequestedTarget==="4M" && replacement.recommendedSlot && replacement.recommendedSlot!=="4M"
      && replacement.sdeCanonicalCandidateDiagnostics.length===inventory.length,
    "BLOCKED/UNRESOLVED is automatically replanned from fresh state when a safe target exists while original intent is preserved"
  );

  const failed=globalThis.__candidateEngineResults.filter(item=>item.status==="FAIL");
  process.stdout.write(JSON.stringify({schemaVersion:"sde-candidate-engine-invariants-v1",category:"candidate-engine",counts:{total:globalThis.__candidateEngineResults.length,pass:globalThis.__candidateEngineResults.length-failed.length,fail:failed.length},observed:{lowDiagnostic},results:globalThis.__candidateEngineResults})+"\n");
  process.exitCode=globalThis.__candidateEngineResults.some(item=>item.status==="FAIL")?1:0;
})()
`);

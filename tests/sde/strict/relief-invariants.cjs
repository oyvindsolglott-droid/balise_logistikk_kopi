"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname, "../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));
const results = [];
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

process.argv[2] = indexPath;
globalThis.__reliefResults = results;
globalThis.__reliefRecord = record;

eval(prefix + String.raw`
(()=>{
  const put=globalThis.__reliefRecord;
  function direct(vehicle,from,to,id){
    const row=makeMain(from.replace(/[^0-9].*$/,"") || "10",vehicle,to,id);
    return {...row,fromSlot:from,arrivalSlot:from,originalFromSlot:from,recommendedSlot:to,toSlot:to};
  }
  function pool(avoid=[],occupied=[]){
    resetState([["3N","BLOCKER"],...occupied.map((slot,index)=>[slot,"OCC-"+index])]);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    return ctx.getSdePhysicalBlockerAccessReliefCandidateOrder("BLOCKER","3N","1N","north",{avoidSlots:avoid,preferDedicatedVn:true});
  }

  const first4=pool([]);
  const first5=pool(["4M","4N"]);
  const first6=pool(["4M","4N","5M","5N","5S","6N"]);
  put("INV-RELIEF-001",first4[0]==="4M","actual candidate pool ranks safe local 4M before VN");
  put("INV-RELIEF-002",first5[0]==="5M","actual candidate pool ranks safe local 5M before VN when earlier locals are reserved");
  put("INV-RELIEF-003",first6[0]==="6S","actual candidate pool ranks safe local 6S before VN when earlier locals are reserved");
  const excluded=pool(["4M","4N","5M"]);
  put("INV-RELIEF-004",!excluded.includes("4M") && !excluded.includes("5M"),"requested main target/explicit avoid slots are excluded by the real pool");
  put("INV-RELIEF-005",!excluded.includes("3N") && !excluded.includes("1N"),"blocker source and blocked source are excluded by the real pool");
  const occupiedReserved=pool(["5M"],["4M"]);
  put("INV-RELIEF-006",!occupiedReserved.includes("4M") && !occupiedReserved.includes("5M"),"physical occupancy and reservation exclusions both apply");

  // Build a real target-access block state, then prove an impossible return access cannot form a plan.
  const placements=[["5M","MAIN"],["4N","BN"],["4S","BS"]];
  resetState(placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const main=direct("MAIN","5M","4M","relief-main");
  const blockState=ctx.getSdeHardPhysicalBlockStateForMove(main);
  const blocker=blockState.blockers.find(item=>item.slot==="4N");
  const freeing={vehicle:"BN",fromSlot:"4N",arrivalSlot:"4N",recommendedSlot:"6S",toSlot:"6S",stableActionKey:"no-return",sdePhysicalResolutionContext:"target_access_temporary_relief"};
  const impossibleState={...blockState,accessAssessment:{...blockState.accessAssessment,targetAccessOptions:blockState.accessAssessment.targetAccessOptions.map(option=>option.end==="north"?{...option,end:"impossible-end"}:option)}};
  const noReturnPlan=ctx.buildSdeTemporaryAccessReliefChainPlan(main,impossibleState,freeing,"no-return-chain");
  put("INV-RELIEF-007",noReturnPlan===null,"a candidate without a validated return path is rejected by the real chain-plan builder");

  // Full real guard pipeline: with locals unavailable VN remains a complete fallback chain.
  const fallbackMain=direct("FALLBACK-MAIN","9","4M","relief-vn-fallback");
  const fallbackPlacements=vm.runInContext("inputSlots",ctx)
    .filter(slot=>!["4M","VN","VS"].includes(slot))
    .map((slot,index)=>[slot,"FALLBACK-CLOSED-"+index]);
  const replaceFallback=(slot,vehicle)=>{
    const index=fallbackPlacements.findIndex(([candidate])=>candidate===slot);
    if(index>=0) fallbackPlacements[index]=[slot,vehicle];
  };
  replaceFallback("9","FALLBACK-MAIN");
  replaceFallback("4N","FALLBACK-BLOCKER-N");
  replaceFallback("4S","FALLBACK-BLOCKER-S");
  resetState(fallbackPlacements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const fallbackRows=ctx.buildSdePhysicalBlockerGuardMoves([fallbackMain]);
  const release=fallbackRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const recovery=fallbackRows.find(row=>row.sdePhysicalDependencyRole==="return");
  put("INV-RELIEF-008",release?.toSlot==="VN","VN is used when the full guard pipeline rejects/prioritizes all ordinary alternatives");
  put("INV-RELIEF-009",Boolean(recovery) && recovery.fromSlot==="VN" && recovery.toSlot===release?.fromSlot,"VN fallback always materializes mandatory recovery");

  const ordinary=ctx.getSdeResolutionCandidateSlots("4N","5M").filter(slot=>!["4N","4M","5M","VN","VS"].includes(slot));
  const closedPlacements=[...placements,...ordinary.map((slot,index)=>[slot,"CLOSED-"+index])];
  resetState(closedPlacements);
  appState.txpUnavailableInfrastructure={slots:["VN","VS"],tracks:[],washRouteUnavailable:false};
  const closedRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const closedReader=ctx.buildSdeCanonicalProductionReader(snapshot(closedRows,closedPlacements));
  const closedActive=closedReader.canonicalPlan.activeOutcomes.some(item=>item.vehicleId==="MAIN");
  const closedReservation=closedReader.reservationProjection.reservations.some(item=>item.vehicleId==="MAIN");
  const closedOverlay=[...closedReader.graphicProjection.activeOverlays,...closedReader.graphicProjection.deferredOverlays].some(item=>item.vehicleId==="MAIN");
  put("INV-RELIEF-010",!closedActive && !closedReservation && !closedOverlay,"when neither local relief nor VN is safe, the full reader remains diagnostic-only");

  function simultaneous(reverse){
    const p=[...placements,["10N","BUTT-N"],["10S","BUTT-S"]];
    resetState(p);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const butt=makeMain("10","BUTT-S","8N","relief-butt");
    const rows=ctx.buildSdePhysicalBlockerGuardMoves(reverse?[butt,main]:[main,butt]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,p));
    return {
      vnReleases:rows.filter(row=>row.sdePhysicalDependencyRole==="prerequisite" && row.toSlot==="VN").length,
      vnReservations:reader.reservationProjection.reservations.filter(item=>item.targetSlot==="VN").length,
      returns:rows.filter(row=>row.sdePhysicalDependencyRole==="return").length,
      conflicts:reader.reservationProjection.conflicts.filter(item=>["VN_RESOURCE_OVERLAP","VS_RESOURCE_OVERLAP","OVERLAPPING_CHAIN_TARGET"].includes(item.classification)).length
    };
  }
  const forward=simultaneous(false);
  const reverse=simultaneous(true);
  put("INV-RELIEF-011",forward.vnReleases===1 && forward.vnReservations===1 && forward.conflicts===0 && JSON.stringify(forward)===JSON.stringify(reverse),"two chains never double-book VN and input order does not change the winner/resource counts");

  process.stdout.write(JSON.stringify({category:"relief",observed:{first4,first5,first6,forward},results:globalThis.__reliefResults})+"\n");
})()
`);

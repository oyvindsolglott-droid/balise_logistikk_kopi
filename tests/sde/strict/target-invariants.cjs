"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname, "../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));
const results = [];
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

process.argv[2] = indexPath;
globalThis.__targetResults = results;
globalThis.__targetRecord = record;

eval(prefix + String.raw`
(()=>{
  const put=globalThis.__targetRecord;
  const placements=[["4N","75-10"],["11S","74-11"]];
  const candidate=makeMain("11","74-11","4N","occupied-target-strict");

  function run(order){
    const arranged=order ? [...placements].reverse() : [...placements];
    resetState(arranged);
    const guarded=ctx.buildSdePhysicalBlockerGuardMoves([candidate]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(guarded,arranged));
    const cards=[
      ...(reader.cardProjection.actionableCards || []),
      ...(reader.cardProjection.blockedChainCards || []),
      ...(reader.cardProjection.handlerBlockedCards || [])
    ];
    const reservations=reader.reservationProjection.reservations || [];
    const activeOverlays=reader.graphicProjection.activeOverlays || [];
    const deferredOverlays=reader.graphicProjection.deferredOverlays || [];
    const allDiagnostics=[
      ...(reader.canonicalPlan.diagnostics || []),
      ...(reader.cardProjection.diagnostics || []),
      ...(reader.graphicProjection.unresolvedDiagnostics || []),
      ...(reader.reservationProjection.conflicts || [])
    ];
    const releaseCard=cards.find(item=>item.vehicleId==="75-10" && item.sourceSlot==="4N" && item.targetSlot==="4M");
    const mainCard=cards.find(item=>item.vehicleId==="74-11" && item.sourceSlot==="11S" && item.targetSlot==="4N");
    const releaseAdapter=releaseCard ? reader.handlerAdapters?.[releaseCard.canonicalCardId] : null;
    const mainAdapter=mainCard ? reader.handlerAdapters?.[mainCard.canonicalCardId] : null;
    return {
      targetOccupied:reader.graphicProjection.actualSlots.some(item=>item.slot==="4N" && item.vehicleId==="75-10"),
      activeRelease:(reader.canonicalPlan.activeOutcomes || []).filter(item=>item.vehicleId==="75-10" && item.targetSlot==="4M").length,
      actionableRelease:(reader.cardProjection.actionableCards || []).filter(item=>item.vehicleId==="75-10" && item.targetSlot==="4M").length,
      actionableMain:(reader.cardProjection.actionableCards || []).filter(item=>item.vehicleId==="74-11" && item.targetSlot==="4N").length,
      blockedToTarget:cards.filter(item=>item.vehicleId==="74-11" && item.targetSlot==="4N").length,
      releaseStatus:releaseCard?.status || "",
      mainStatus:mainCard?.status || "",
      mainRecursiveState:String(mainAdapter?.row?.sdeRecursiveCardState || ""),
      mainDependencies:[...(mainCard?.dependencyIds || mainCard?.blockedBy || [])],
      releaseActionKey:String(releaseAdapter?.actionKey || ""),
      reservations:reservations.filter(item=>["74-11","75-10"].includes(item.vehicleId)).map(item=>({vehicleId:item.vehicleId,targetSlot:item.targetSlot,status:item.status})),
      activeOverlays:activeOverlays.filter(item=>["74-11","75-10"].includes(item.vehicleId)).map(item=>({vehicleId:item.vehicleId,targetSlot:item.targetSlot})),
      deferredOverlays:deferredOverlays.filter(item=>["74-11","75-10"].includes(item.vehicleId)).map(item=>({vehicleId:item.vehicleId,targetSlot:item.targetSlot})),
      adapterStates:{releaseReady:releaseAdapter?.ready===true,mainReady:mainAdapter?.ready===true},
      chainIds:Array.from(new Set(cards.filter(item=>["74-11","75-10"].includes(item.vehicleId)).map(item=>item.chainId).filter(Boolean))),
      rootRequestIds:Array.from(new Set([releaseAdapter?.row?.sdeRecursiveRootRequestId,mainAdapter?.row?.sdeRecursiveRootRequestId].filter(Boolean))),
      planRevisions:Array.from(new Set([releaseAdapter?.row?.sdeRecursivePlanRevision,mainAdapter?.row?.sdeRecursivePlanRevision].filter(Boolean))),
      diagnosticTypes:allDiagnostics.map(item=>String(item.diagnosticType || item.classification || item.code || "")).filter(Boolean).sort()
    };
  }

  const observed=run(false);
  put("INV-TARGET-001",observed.targetOccupied,"actual 75-10 in 4N is present in the real graphic/canonical reader");
  put("INV-TARGET-002",observed.activeRelease===1 && observed.actionableRelease===1 && observed.releaseStatus==="actionable","the occupying vehicle has exactly one actionable prerequisite release");
  put("INV-TARGET-003",observed.actionableMain===0 && observed.blockedToTarget===1 && observed.mainStatus==="blocked_chain_step" && observed.mainRecursiveState==="DEPENDENCY_BLOCKED","the requested main card exists only as dependency-blocked");
  put("INV-TARGET-004",observed.mainDependencies.length===1 && observed.mainDependencies[0]===observed.releaseActionKey,"the main card depends on the exact prerequisite release");
  put("INV-TARGET-005",observed.reservations.length===2 && observed.reservations.some(item=>item.vehicleId==="75-10" && item.targetSlot==="4M" && item.status==="actionable") && observed.reservations.some(item=>item.vehicleId==="74-11" && item.targetSlot==="4N" && item.status==="blocked_chain_step"),"release and dependency-blocked main retain ordered reservations");
  put("INV-TARGET-006",observed.activeOverlays.length===1 && observed.activeOverlays[0]?.vehicleId==="75-10" && observed.activeOverlays[0]?.targetSlot==="4M" && observed.deferredOverlays.length===1 && observed.deferredOverlays[0]?.vehicleId==="74-11" && observed.deferredOverlays[0]?.targetSlot==="4N","release and main retain active/deferred overlays");
  put("INV-TARGET-007",observed.adapterStates.releaseReady===true && observed.adapterStates.mainReady===false,"only the prerequisite adapter is ready");
  put("INV-TARGET-008",observed.chainIds.length===1 && observed.rootRequestIds.length===1 && observed.planRevisions.length===1 && !observed.diagnosticTypes.includes("IMPOSSIBLE_SHIFT_TO_OR_FROM_BLOCKED_SLOT"),"the complete occupied-target chain survives the production pipeline atomically");
  const normalized=JSON.stringify(observed);
  const permutations=Array.from({length:10},(_,index)=>JSON.stringify(run(index%2===1)));
  put("INV-TARGET-009",permutations.every(value=>value===normalized),"ten actual/input-order permutations yield the same full-pipeline result");
  process.stdout.write(JSON.stringify({category:"target",observed,results:globalThis.__targetResults})+"\n");
})()
`);

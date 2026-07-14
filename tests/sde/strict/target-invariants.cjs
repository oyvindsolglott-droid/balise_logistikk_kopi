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
    const overlays=[...(reader.graphicProjection.activeOverlays || []),...(reader.graphicProjection.deferredOverlays || [])];
    const allDiagnostics=[
      ...(reader.canonicalPlan.diagnostics || []),
      ...(reader.cardProjection.diagnostics || []),
      ...(reader.graphicProjection.unresolvedDiagnostics || []),
      ...(reader.reservationProjection.conflicts || [])
    ];
    return {
      targetOccupied:reader.graphicProjection.actualSlots.some(item=>item.slot==="4N" && item.vehicleId==="75-10"),
      active:(reader.canonicalPlan.activeOutcomes || []).filter(item=>item.vehicleId==="74-11" && item.targetSlot==="4N").length,
      actionable:(reader.cardProjection.actionableCards || []).filter(item=>item.vehicleId==="74-11").length,
      blockedToTarget:cards.filter(item=>item.vehicleId==="74-11" && item.targetSlot==="4N").length,
      reservations:reservations.filter(item=>item.vehicleId==="74-11" || item.targetSlot==="4N").length,
      overlays:overlays.filter(item=>item.vehicleId==="74-11" || item.targetSlot==="4N").length,
      adapters:Object.values(reader.handlerAdapters || {}).filter(item=>item?.row?.vehicle==="74-11" || item?.outcome?.vehicleId==="74-11").length,
      diagnosticTypes:allDiagnostics.map(item=>String(item.diagnosticType || item.classification || item.code || "")).filter(Boolean).sort()
    };
  }

  const observed=run(false);
  put("INV-TARGET-001",observed.targetOccupied,"actual 75-10 in 4N is present in the real graphic/canonical reader");
  put("INV-TARGET-002",observed.active===0,"occupied-target need has zero active canonical outcomes");
  put("INV-TARGET-003",observed.actionable===0,"occupied-target need has zero actionable cards");
  put("INV-TARGET-004",observed.blockedToTarget===0,"no blocked chain card is materialized toward occupied 4N");
  put("INV-TARGET-005",observed.reservations===0,"no reservation is projected for occupied 4N");
  put("INV-TARGET-006",observed.overlays===0,"no active or deferred overlay is projected for occupied 4N");
  put("INV-TARGET-007",observed.adapters===0,"no production handler adapter is projected for the invalid need");
  put("INV-TARGET-008",observed.diagnosticTypes.filter(type=>/target.*occupied|occupied.*target/i.test(type)).length===1,"exactly one target-occupied diagnostic is emitted");
  const normalized=JSON.stringify(observed);
  const permutations=Array.from({length:10},(_,index)=>JSON.stringify(run(index%2===1)));
  put("INV-TARGET-009",permutations.every(value=>value===normalized),"ten actual/input-order permutations yield the same full-pipeline result");
  process.stdout.write(JSON.stringify({category:"target",observed,results:globalThis.__targetResults})+"\n");
})()
`);

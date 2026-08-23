"use strict";

const fs = require("node:fs");
const path = require("node:path");

const baseHarness = fs.readFileSync(path.join(__dirname,"sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = baseHarness.slice(0,baseHarness.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  ctx.persist=()=>{};
  ctx.renderSdeSkiftebevegelser=()=>{};
  const placements = [["4N","74-12"],["4M","74-41"],["4S","70-06"]];
  resetState(placements);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};

  const actionKey="night-placement-drag|74-12|4N|10S|direct-wash-transit";
  const main={
    vehicle:"74-12",
    fromSlot:"4N",
    arrivalSlot:"4N",
    originalFromSlot:"4N",
    recommendedSlot:"10S",
    toSlot:"10S",
    stableActionKey:actionKey,
    sdeNightPlacementGeneratedActionKey:actionKey,
    needKey:"night-placement-drag-need|"+actionKey,
    sdeNightPlacementGeneratedNeedKey:"night-placement-drag-need|"+actionKey,
    source:"night-placement-drag",
    canonicalProducer:"graphic_drag_generated_move",
    canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,
    sdeNightPlacementDragIdentity:"direct-wash-transit",
    manualPlanId:"manual-graphic-order|direct-wash-transit",
    sdeNightPlacementDragOverrideActive:true,
    isNightPlacementGenerated:true,
    isManualOnly:true,
    sdeDirectWashTransit:true,
    sdeTrappedEgressRouteResources:["VN","VS"]
  };

  const routeText=ctx.getSdeRouteAssessmentForPlanSkifte("4N","10S");
  assert.match(routeText,/Nordenden\/vaskesporet ser internt fri/i);
  const direct=ctx.getSdeDirectWashTransitRouteAssessment(main);
  assert.equal(direct.eligible,true,direct.reason);
  assert.deepEqual(Array.from(direct.routeResources),["VN","VS"]);
  assert.equal(direct.sourceOption.end,"north");
  assert.equal(direct.targetOption.end,"north");

  const ordinary=ctx.getSdeHardPhysicalBlockStateForMove(main);
  assert.equal(ordinary.hardBlocked,false);
  const complete=ctx.getSdeCompleteTrappedEgressBlockState(main,ordinary);
  assert.equal(complete.hardBlocked,false,"the direct wash route must win before trapped-egress planning");
  assert.equal(complete.directWashTransit?.eligible,true);

  const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  assert.equal(rows.length,1,"4N to 10S must remain one direct move");
  assert.equal(rows[0].vehicle,"74-12");
  assert.equal(rows[0].fromSlot,"4N");
  assert.equal(rows[0].toSlot,"10S");
  assert.equal(rows[0].sdePhysicalChainId,undefined);
  assert.equal(rows.some(row=>["prerequisite","return"].includes(row.sdePhysicalDependencyRole)),false);

  const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements));
  const inspected=ctx.inspectSdeCanonicalGraphicDragOrder(reader,{
    vehicle:"74-12",sourceSlot:"4N",targetSlot:"10S",actionKey
  });
  assert.equal(inspected.ok,true,inspected.reason);
  assert.equal(reader.integrityReport.status,"PASS");
  assert.equal(reader.cardProjection.actionableCards.length,1);
  assert.equal(reader.cardProjection.blockedChainCards.length,0);
  assert.deepEqual(Array.from(inspected.reservation.routeResources),["VN","VS"]);

  vm.runInContext("sdeShiftLastRenderedData={moves:[]};sdeNightPlacementDropMessage=null;sdeNightPlacementBlockedMoveRequest=null;sdeProductionReaderFallbackError=null;",ctx);
  const payload={vehicle:"74-12",slot:"4N",fromSlot:"4N",sourceKind:"completedLocked"};
  const assessment=ctx.buildSdeNightPlacementDropAssessment(payload,"10S",{moves:[]});
  assert.equal(assessment.ok,true,assessment.message);
  assert.equal(Boolean(assessment.hardPhysicalBlocked),false);
  assert.equal(assessment.directWashTransit?.eligible,true);
  assert.deepEqual(Array.from(assessment.routeResources),["VN","VS"]);
  assert.match(assessment.message,/Ingen frigjøringskjede eller mellomparkering er nødvendig/);
  const applied=ctx.applySdeNightPlacementDragOverride(payload,"10S");
  assert.equal(applied,true,"the browser drop path must accept the direct wash route");
  const dropMessage=vm.runInContext("sdeNightPlacementDropMessage",ctx);
  assert.notEqual(dropMessage?.type,"error");
  assert.match(dropMessage?.text || "",/Canonical kort, reservasjon, planoverlay og handleradapter er entydige/);
  const storedOverrides=vm.runInContext("Object.values(state.sdeNightPlacementManualOverrides)",ctx);
  assert.equal(storedOverrides.length,1);
  assert.equal(storedOverrides[0].sdeDirectWashTransit,true);
  assert.deepEqual(Array.from(storedOverrides[0].sdeTrappedEgressRouteResources),["VN","VS"]);
  const generated=ctx.buildSdeNightPlacementGeneratedMove(storedOverrides[0]);
  assert.equal(generated.sdeDirectWashTransit,true);
  assert.deepEqual(Array.from(generated.sdeTrappedEgressRouteResources),["VN","VS"]);

  const staleBlockedOverride={
    ...storedOverrides[0],
    hardPhysicalBlocked:true,
    noSafeReleaseMove:true,
    timeStatus:"CONFLICT_PHYSICAL_BLOCKED",
    physicalBlockReason:"Hard stopp: 4M og 4S må inngå i en frigjøringskjede.",
    conflicts:["Fysisk blokkert av 4M og 4S."],
    sdeDirectWashTransit:false,
    sdeTrappedEgressRouteResources:[]
  };
  const migrated=ctx.buildSdeNightPlacementGeneratedMove(staleBlockedOverride);
  assert.equal(migrated.sdeDirectWashTransit,true,"a persisted pre-fix order must migrate to the direct corridor");
  assert.equal(migrated.sdeNightPlacementHardPhysicalBlocked,false);
  assert.equal(migrated.sdeNightPlacementNoSafeReleaseMove,false);
  assert.equal(migrated.sdeNightPlacementPhysicalBlockReason,"");
  assert.equal(migrated.timeStatus,"UNKNOWN_TIME_MANUAL_REVIEW");
  assert.deepEqual(Array.from(migrated.sdeNightPlacementOverrideConflicts),[]);
  assert.deepEqual(Array.from(migrated.sdeTrappedEgressRouteResources),["VN","VS"]);
  const migratedCard=ctx.buildSdeNightPlacementCardOverrideMove(main,staleBlockedOverride);
  assert.equal(migratedCard.sdeDirectWashTransit,true,"the visible card adapter must migrate with the canonical row");
  assert.equal(migratedCard.sdeNightPlacementHardPhysicalBlocked,false);
  assert.equal(migratedCard.timeStatus,"UNKNOWN_TIME_MANUAL_REVIEW");
  assert.deepEqual(Array.from(migratedCard.sdeNightPlacementOverrideConflicts),[]);
  assert.deepEqual(Array.from(migratedCard.sdeTrappedEgressRouteResources),["VN","VS"]);

  for(const blockedResource of ["VN","VS"]){
    resetState([...placements,[blockedResource,"WASH-BLOCKER"]]);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const blocked=ctx.getSdeDirectWashTransitRouteAssessment(main);
    assert.equal(blocked.eligible,false,blockedResource+" occupancy must block direct wash transit");
    const guarded=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    assert.equal(
      guarded.some(row=>row.vehicle==="74-12"&&row.fromSlot==="4N"&&row.toSlot==="10S"&&!row.sdePhysicalDependencyRole),
      false,
      blockedResource+" occupancy must not expose the main move as a direct actionable outcome"
    );
  }

  resetState([...placements,["10N","TARGET-ACCESS-BLOCKER"]]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const targetBlocked=ctx.getSdeDirectWashTransitRouteAssessment(main);
  assert.equal(targetBlocked.eligible,false,"10N must be clear before backing into 10S");

  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-direct-wash-transit-route-v1",
    status:"PASS",
    route:"74-12 4N -> VN/VS -> 10S",
    cards:reader.cardProjection.actionableCards.length,
    blockedCards:reader.cardProjection.blockedChainCards.length,
    routeResources:inspected.reservation.routeResources,
    integrity:reader.integrityReport.status
  })+"\n");
})()
`);

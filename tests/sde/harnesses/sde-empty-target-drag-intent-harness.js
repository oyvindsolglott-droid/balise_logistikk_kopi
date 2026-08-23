"use strict";

const fs = require("node:fs");
const path = require("node:path");

const baseHarness = fs.readFileSync(
  path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"),
  "utf8",
);
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const scenarios=[
    {target:"4M",source:"9",blockers:["4N","4S"]},
    {target:"5M",source:"9",blockers:["5N","5S"]},
    {target:"6S",source:"9",blockers:["6N","6SS"]},
    {target:"10S",source:"9",blockers:["10N"]},
    {target:"11S",source:"9",blockers:["11N"]},
    {target:"12S",source:"9",blockers:["12N"]}
  ];
  vm.runInContext("globalThis.__emptyTargetPlannerCalls=0; globalThis.__emptyTargetOriginalStage=stageSdeCanonicalGraphicDragOrder; stageSdeCanonicalGraphicDragOrder=override=>{globalThis.__emptyTargetPlannerCalls+=1; return globalThis.__emptyTargetOriginalStage(override);};",ctx);
  const runScenario=scenario=>{
    const vehicle="DRAG-MAIN-"+scenario.target;
    const placements=[[scenario.source,vehicle],...scenario.blockers.map((slot,index)=>[slot,"DRAG-BLOCKER-"+scenario.target+"-"+(index+1)])];
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null; renderSdeSkiftebevegelser=()=>{};",ctx);
    const payload={vehicle,slot:scenario.source,fromSlot:scenario.source,sourceKind:"standing"};
    const eligibility=ctx.getSdeNightPlacementDragTargetEligibility(payload,scenario.target,{moves:[]});
    const assessment=ctx.buildSdeNightPlacementDropAssessment(payload,scenario.target,{moves:[]});
    const actualBefore=JSON.stringify(appState.grunnoppstilling||{});
    const plannerCallsBefore=vm.runInContext("globalThis.__emptyTargetPlannerCalls",ctx);
    const accepted=ctx.applySdeNightPlacementDragOverride(payload,scenario.target);
    const plannerCallsAfter=vm.runInContext("globalThis.__emptyTargetPlannerCalls",ctx);
    const message=vm.runInContext("sdeNightPlacementDropMessage",ctx);
    const overrides=Object.values(appState.sdeNightPlacementManualOverrides||{});
    const reader=ctx.buildSdeCanonicalProductionReader();
    const cards=[...(reader.cardProjection?.actionableCards||[]),...(reader.cardProjection?.blockedChainCards||[])];
    const statuses=cards.map(card=>card.status);
    const rows=ctx.buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false}).filter(row=>row?.sdePhysicalChainId);
    const release=rows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
    const main=rows.find(row=>row.sdePhysicalDependencyRole==="dependent");
    const recovery=rows.find(row=>row.sdePhysicalDependencyRole==="return");
    const overview=ctx.buildSdeNightPlacementOverviewData({moves:[]});
    const override=overrides[0]||null;
    const completeProjection=Boolean(
      reader.canonicalPlan?.candidateOutcomes?.length===3
      && cards.length===3
      && reader.reservationProjection?.reservations?.length===3
      && (reader.graphicProjection?.activeOverlays?.length||0)+(reader.graphicProjection?.deferredOverlays?.length||0)===3
      && Object.keys(reader.handlerAdapters||{}).length===3
      && reader.integrityReport?.status==="PASS"
    );
    const pass=Boolean(
      eligibility?.droppable===true
      && eligibility?.targetAvailabilityState==="AVAILABLE_WITH_RELIEF_PLANNING"
      && assessment?.ok===true
      && assessment?.hardPhysicalBlocked===true
      && assessment?.plannerInvoked===true
      && assessment?.toSlot===scenario.target
      && accepted===true
      && plannerCallsAfter===plannerCallsBefore+1
      && message?.type!=="error"
      && message?.physicalTargetUnavailable===false
      && overview.rejectedSlot===""
      && overrides.length===1
      && override?.dragIntentAccepted===true
      && override?.canonicalPlannerInvoked===true
      && Boolean(override?.intentIdentity&&override?.actualStateRevision&&override?.planRevision&&override?.direction)
      && rows.length===3&&release&&main&&recovery
      && main.vehicle===vehicle&&main.toSlot===scenario.target
      && recovery.vehicle===release.vehicle
      && recovery.sdeRecoveryUsesPostMainTopology===true
      && main.sdePhysicalDependsOn?.[0]===ctx.getSdeMoveActionKey(release)
      && recovery.sdePhysicalDependsOn?.[0]===ctx.getSdeMoveActionKey(main)
      && cards.length===3
      && statuses.join(",")==="actionable,blocked_chain_step,blocked_chain_step"
      && completeProjection
      && actualBefore===JSON.stringify(appState.grunnoppstilling||{})
    );
    return {
      target:scenario.target,
      eligibility:{droppable:eligibility?.droppable,state:eligibility?.targetAvailabilityState,renderRedUnavailable:eligibility?.renderRedUnavailable},
      assessment:{ok:assessment?.ok,hardPhysicalBlocked:assessment?.hardPhysicalBlocked,target:assessment?.toSlot,noSafeReleaseMove:assessment?.noSafeReleaseMove,plannerInvoked:assessment?.plannerInvoked,accessOptions:assessment?.physicalBlockState?.accessAssessment?.targetAccessOptions?.length||0},
      accepted,plannerCalls:plannerCallsAfter-plannerCallsBefore,message,rejectedSlot:overview.rejectedSlot,
      override:override?{vehicle:override.vehicle,from:override.fromSlot,to:override.toSlot,hardPhysicalBlocked:override.hardPhysicalBlocked,intentIdentity:override.intentIdentity,actualStateRevision:override.actualStateRevision,planRevision:override.planRevision,direction:override.direction}:null,
      rows:rows.map(row=>({vehicle:row.vehicle,from:row.fromSlot,to:row.toSlot,role:row.sdePhysicalDependencyRole,dependsOn:row.sdePhysicalDependsOn||[],postMain:row.sdeRecoveryUsesPostMainTopology===true})),
      cards:cards.map(card=>({vehicle:card.vehicleId,status:card.status,source:card.canonicalSourceSlot,target:card.targetSlot})),
      completeProjection,actualUnchanged:actualBefore===JSON.stringify(appState.grunnoppstilling||{}),pass
    };
  };
  const directReports=scenarios.map(scenario=>{
    const vehicle="DIRECT-MAIN-"+scenario.target;
    resetState([[scenario.source,vehicle]]);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false};",ctx);
    const eligibility=ctx.getSdeNightPlacementDragTargetEligibility(
      {vehicle,slot:scenario.source,fromSlot:scenario.source,sourceKind:"standing"},scenario.target,{moves:[]}
    );
    return {target:scenario.target,state:eligibility?.targetAvailabilityState,droppable:eligibility?.droppable===true,red:eligibility?.renderRedUnavailable===true};
  });
  const reports=scenarios.map(runScenario);
  resetState([["9","RED-SOURCE"],["12S","RED-OCCUPANT"]]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const occupiedEligibility=ctx.getSdeNightPlacementDragTargetEligibility({vehicle:"RED-SOURCE",slot:"9",fromSlot:"9"},"12S",{moves:[]});
  resetState([["9","RED-SOURCE"]]);
  appState.txpUnavailableInfrastructure={slots:["12S"],tracks:[],washRouteUnavailable:false};
  const unavailableEligibility=ctx.getSdeNightPlacementDragTargetEligibility({vehicle:"RED-SOURCE",slot:"9",fromSlot:"9"},"12S",{moves:[]});
  resetState([["9","RESERVATION-OWNER"],["8N","RESERVATION-CONTENDER"]]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null; renderSdeSkiftebevegelser=()=>{};",ctx);
  const reservationCreated=ctx.applySdeNightPlacementDragOverride({vehicle:"RESERVATION-OWNER",slot:"9",fromSlot:"9",sourceKind:"standing"},"12S");
  const reservationEligibility=ctx.getSdeNightPlacementDragTargetEligibility({vehicle:"RESERVATION-CONTENDER",slot:"8N",fromSlot:"8N"},"12S",{moves:[]});
  const availabilityCases={
    occupied:{state:occupiedEligibility?.targetAvailabilityState,red:occupiedEligibility?.renderRedUnavailable,droppable:occupiedEligibility?.droppable},
    outOfService:{state:unavailableEligibility?.targetAvailabilityState,red:unavailableEligibility?.renderRedUnavailable,droppable:unavailableEligibility?.droppable},
    reservation:{created:reservationCreated,state:reservationEligibility?.targetAvailabilityState,red:reservationEligibility?.renderRedUnavailable,droppable:reservationEligibility?.droppable}
  };
  resetState([["11N","74-38"],["11S","74-21"]]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  vm.runInContext("sdeShiftLastRenderedData={moves:[],limitedPlanningMode:false}; sdeNightPlacementDropMessage=null; sdeNightPlacementBlockedMoveRequest=null; renderSdeSkiftebevegelser=()=>{};",ctx);
  const historicalPayload={vehicle:"74-21",slot:"11S",fromSlot:"11S",sourceKind:"standing"};
  const historicalAccepted=ctx.applySdeNightPlacementDragOverride(historicalPayload,"12S");
  const historicalReader=ctx.buildSdeCanonicalProductionReader();
  const historicalCards=[...(historicalReader.cardProjection?.actionableCards||[]),...(historicalReader.cardProjection?.blockedChainCards||[])];
  const historical={tag:"HISTORICAL_RUNTIME_FIXTURE_ONLY",vehicle:"74-21",source:"11S",target:"12S",accepted:historicalAccepted,cards:historicalCards.length,pass:historicalAccepted===true&&historicalCards.length===3};
  const invariant=(id,contract,pass,detail)=>({id,contract,status:pass?"PASS":"FAIL",detail});
  const all=predicate=>reports.every(predicate);
  const results=[
    invariant("INV-EMPTY-DROP-001","EMPTY-PHYSICAL-SLOT-IS-ALWAYS-DROPPABLE-AS-PLAN-INTENT",all(item=>item.eligibility.droppable&&item.accepted)&&directReports.every(item=>item.droppable&&item.state==="DIRECTLY_AVAILABLE"&&!item.red),JSON.stringify({relief:reports.map(item=>[item.target,item.eligibility.state,item.accepted]),direct:directReports})),
    invariant("INV-EMPTY-DROP-002","DIRECT-ROUTE-BLOCKAGE-DOES-NOT-REJECT-EMPTY-TARGET",all(item=>item.assessment.hardPhysicalBlocked&&item.accepted),JSON.stringify(reports.map(item=>[item.target,item.assessment.hardPhysicalBlocked]))),
    invariant("INV-EMPTY-DROP-003","EMPTY-SLOT-DOES-NOT-RENDER-RED-BECAUSE-RELIEF-IS-REQUIRED",all(item=>item.rejectedSlot===""&&!item.eligibility.renderRedUnavailable)&&availabilityCases.occupied.state==="PHYSICALLY_OCCUPIED"&&availabilityCases.occupied.red===true&&availabilityCases.outOfService.state==="INFRASTRUCTURE_OUT_OF_SERVICE"&&availabilityCases.outOfService.red===true&&availabilityCases.reservation.state==="RESERVATION_CONFLICT"&&availabilityCases.reservation.red===false,JSON.stringify({relief:reports.map(item=>[item.target,item.rejectedSlot]),availabilityCases})),
    invariant("INV-EMPTY-DROP-004","DROP-INTENT-REACHES-CANONICAL-PLANNER",all(item=>item.assessment.plannerInvoked&&item.plannerCalls===1),JSON.stringify(reports.map(item=>[item.target,item.plannerCalls]))),
    invariant("INV-EMPTY-DROP-005","RELIEF-PLAN-SEARCHES-BOTH-DIRECTIONS",reports.slice(0,3).every(item=>item.assessment.accessOptions===2),JSON.stringify(reports.slice(0,3).map(item=>[item.target,item.assessment.accessOptions]))),
    invariant("INV-EMPTY-DROP-006","VALID-RELIEF-PRODUCES-THREE-CARD-CHAIN",all(item=>item.rows.length===3&&item.cards.length===3),JSON.stringify(reports.map(item=>[item.target,item.rows.length,item.cards.length]))),
    invariant("INV-EMPTY-DROP-007","RECOVERY-USES-POST-MAIN-TOPOLOGY",all(item=>item.rows.some(row=>row.role==="return"&&row.postMain)),JSON.stringify(reports.map(item=>[item.target,item.rows.find(row=>row.role==="return")?.to]))),
    invariant("INV-EMPTY-DROP-008","RECOVERY-DOES-NOT-CREATE-TRAPPED-EMPTY-SLOT",all(item=>item.rows.filter(row=>row.role==="return").length===1&&item.completeProjection),JSON.stringify(reports.map(item=>[item.target,item.completeProjection]))),
    invariant("INV-EMPTY-DROP-009","NO-PARTIAL-OPERATIVE-PROJECTION",all(item=>item.completeProjection&&item.actualUnchanged),JSON.stringify(reports.map(item=>[item.target,item.completeProjection,item.actualUnchanged])))
  ];
  const output={
    schemaVersion:"sde-empty-target-drag-intent-harness-v1",
    historical,
    directReports,
    availabilityCases,
    results,
    reports,
    pass:reports.every(report=>report.pass)&&historical.pass&&results.every(result=>result.status==="PASS")
  };
  process.stdout.write(JSON.stringify(output)+"\n");
  process.exitCode=output.pass?0:1;
})()
`);

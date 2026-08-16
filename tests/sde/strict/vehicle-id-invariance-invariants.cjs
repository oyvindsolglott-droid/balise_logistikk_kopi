"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname,"../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = base.slice(0,base.indexOf("const chain10"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures/generic-vehicle-id-permutations.json"),"utf8"));
const results = [];
const record = (id,pass,detail)=>results.push({id,status:pass?"PASS":"FAIL",detail:String(detail||"")});
globalThis.__vehicleInvariantRecord = record;
globalThis.__vehicleInvariantResults = results;
globalThis.__vehicleInvariantFixture = fixture;

eval(prefix + String.raw`
(()=>{
  const put=globalThis.__vehicleInvariantRecord;
  const fixture=globalThis.__vehicleInvariantFixture;
  const routeOf=row=>row?.sdeCanonicalRoute||{
    viaSlots:row?.viaSlots||[],reversalPoint:row?.reversalPoint||"",approachSide:row?.approachSide||"",
    routeResourceClaims:row?.sdeCanonicalRouteResourceClaims||[]
  };
  const intent=(vehicle,from,to,id)=>({
    vehicle,fromSlot:from,arrivalSlot:from,originalFromSlot:from,recommendedSlot:to,toSlot:to,
    stableActionKey:["generic-id",id,vehicle,from,to].join("|"),
    needKey:["generic-id-need",id,vehicle].join("|"),source:"generic-id-invariance",
    canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
    sdeCanonicalGraphicDragOrder:true,sdeNightPlacementDragIdentity:id,isNightPlacementGenerated:true,isManualOnly:true
  });
  const role=row=>row?.sdePhysicalDependencyRole||"direct";
  const topology=rows=>(rows||[]).map(row=>{
    const route=routeOf(row);
    return {
      role:role(row),source:row.fromSlot,target:row.toSlot,
      via:[...(route.viaSlots||[])],reversal:route.reversalPoint||"",approach:route.approachSide||"",
      resources:(route.routeResourceClaims||[]).map(item=>({resource:item.resource,state:item.state})),
      dependencyCount:(row.sdePhysicalDependsOn||[]).length,
      score:Number(row.recommendationScore||0),confidence:String(row.recommendationConfidence||"")
    };
  });

  const directRuns=fixture.directMoveIds.map((vehicle,index)=>{
    const placements=[["VN",vehicle]];
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const row=intent(vehicle,"VN","11N","direct-"+index);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([row]);
    return {vehicle,rows,topology:topology(rows)};
  });
  const directReference=JSON.stringify(directRuns[0]?.topology||[]);
  put("INV-VEHICLE-ID-001",directRuns.every(run=>run.rows.length===1&&role(run.rows[0])==="direct"),JSON.stringify(directRuns.map(run=>run.topology)));
  put("INV-VEHICLE-ID-002",directRuns.every(run=>JSON.stringify(run.topology)===directReference),"VN to 11N topology is invariant for three series");
  put("INV-VEHICLE-ID-003",directRuns.every(run=>{const route=routeOf(run.rows[0]);return route.viaSlots?.includes("VS")&&!run.rows.some(row=>row.toSlot==="1N");}),"direct route uses VS and never global 1N fallback");

  const threeStepRuns=fixture.threeStepPermutations.map((ids,index)=>{
    const placements=[["12N",ids.movingVehicle],["6N",ids.blockingVehicle],["6SS",ids.otherVehicle]];
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const main=intent(ids.movingVehicle,"12N","6S","three-"+index);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    return {ids,rows,topology:topology(rows)};
  });
  const threeReference=JSON.stringify(threeStepRuns[0]?.topology||[]);
  put("INV-VEHICLE-ID-004",threeStepRuns.every(run=>run.rows.map(role).join(",")==="prerequisite,dependent,return"),JSON.stringify(threeStepRuns.map(run=>run.topology)));
  put("INV-VEHICLE-ID-005",threeStepRuns.every(run=>JSON.stringify(run.topology)===threeReference),"RELEASE MAIN RECOVERY topology survives three ID permutations");
  put("INV-VEHICLE-ID-006",threeStepRuns.every(run=>{
    const [release,main,recovery]=run.rows;
    return release?.vehicle===run.ids.blockingVehicle&&main?.vehicle===run.ids.movingVehicle&&recovery?.vehicle===run.ids.blockingVehicle&&!run.rows.some(row=>row.vehicle===run.ids.otherVehicle);
  }),"only vehicleId fields are substituted; 6SS occupant never moves");
  put("INV-VEHICLE-ID-007",threeStepRuns.every(run=>{
    const [release,main,recovery]=run.rows;
    return release?.fromSlot==="6N"&&release?.toSlot==="VN"&&routeOf(release).viaSlots?.includes("VS")&&main?.fromSlot==="12N"&&main?.toSlot==="6S"&&routeOf(main).viaSlots?.includes("VS")&&recovery?.fromSlot==="VN"&&recovery?.toSlot==="6N";
  }),"three-card route is derived from slots and physical topology");

  const blockedCases=[
    {source:"4M",target:"9",blockers:["4N","4S"]},
    {source:"5M",target:"9",blockers:["5N","5S"]},
    {source:"6S",target:"9",blockers:["6N","6SS"]},
    {source:"10S",target:"8N",blockers:["10N"]},
    {source:"11S",target:"8N",blockers:["11N"]},
    {source:"12S",target:"8N",blockers:["12N"]}
  ];
  const blockedRuns=blockedCases.map((item,index)=>{
    const ids=fixture.blockedSlotIds;
    const moving=ids[index%ids.length];
    const placements=[[item.source,moving],...item.blockers.map((slot,offset)=>[slot,ids[(index+offset+1)%ids.length]])];
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const main=intent(moving,item.source,item.target,"blocked-"+index);
    const state=ctx.getSdeHardPhysicalBlockStateForMove(main);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    return {...item,state,rows};
  });
  put("INV-VEHICLE-ID-008",blockedRuns.every(run=>run.state?.hardBlocked===true),JSON.stringify(blockedRuns.map(run=>({source:run.source,hardBlocked:run.state?.hardBlocked}))));
  put("INV-VEHICLE-ID-009",blockedRuns.every(run=>run.rows.length===3&&run.rows.map(role).join(",")==="prerequisite,dependent,return"),JSON.stringify(blockedRuns.map(run=>({source:run.source,topology:topology(run.rows)}))));

  const workshopRuns=fixture.workshopExitIds.map((vehicle,index)=>{
    const source=index%2?"8N":"7N";
    resetState([[source,vehicle]]);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const request={vehicleId:vehicle,visitId:"visit-"+index,exitRequestId:"exit-"+index};
    const placement={vehicleId:vehicle,slot:source,workshopVisitId:"visit-"+index,inWorkshop:true};
    const reconciliation=ctx.reconcileSdeWorkshopExitPlacement(request,[placement],[request]);
    ctx.__workshopInvariantNeed={vehicle,arrivalSlot:source,fromSlot:source,finalTarget:"11N",toSlot:"11N",serviceRequired:false,canonicalVehicleStatus:{currentStatus:"DRIFTSKLAR"}};
    const recommendation=vm.runInContext("getSdeWorkshopExitRecommendation(__workshopInvariantNeed,new Map())",ctx);
    return {vehicle,source,reconciliation,recommendation};
  });
  put("INV-VEHICLE-ID-010",workshopRuns.every(run=>run.reconciliation.ok===true&&!run.reconciliation.ambiguous),JSON.stringify(workshopRuns.map(run=>({vehicle:run.vehicle,source:run.source,ok:run.reconciliation.ok,ambiguous:run.reconciliation.ambiguous}))));
  put("INV-VEHICLE-ID-011",workshopRuns.every(run=>run.recommendation.slot==="11N"&&run.recommendation.searchedSlots?.length===vm.runInContext("inputSlots.length",ctx)),JSON.stringify(workshopRuns.map(run=>({vehicle:run.vehicle,slot:run.recommendation.slot,searched:run.recommendation.searchedSlots?.length}))));
  put("INV-VEHICLE-ID-012",new Set(workshopRuns.map(run=>JSON.stringify({slot:run.recommendation.slot,score:run.recommendation.score,confidence:run.recommendation.confidence}))).size===1,"workshop target, score and confidence are ID-independent");

  process.stdout.write(JSON.stringify({schemaVersion:"sde-vehicle-id-invariance-invariants-v1",category:"vehicle-id-invariance",results:globalThis.__vehicleInvariantResults})+"\n");
  process.exitCode=globalThis.__vehicleInvariantResults.some(item=>item.status==="FAIL")?1:0;
})()
`);

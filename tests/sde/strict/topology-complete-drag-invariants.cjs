"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const harness = fs.readFileSync(path.join(__dirname,"../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"),"utf8");
const prefix = harness.slice(0,harness.indexOf("const chain10"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname,"../fixtures/topology-complete-drag-and-relief-v1.json"),"utf8"));
globalThis.__topologyFixture = fixture;
globalThis.__topologyResults = [];

eval(prefix + String.raw`
(()=>{
  const fixture=globalThis.__topologyFixture;
  const results=globalThis.__topologyResults;
  const put=(id,pass,detail)=>results.push({id,status:pass?"PASS":"FAIL",detail:String(detail||"")});
  const makeManual=(vehicle,fromSlot,target,id)=>({
    vehicle,fromSlot,arrivalSlot:fromSlot,originalFromSlot:fromSlot,
    recommendedSlot:target,toSlot:target,stableActionKey:"topology-drag|"+id,
    sdeNightPlacementGeneratedActionKey:"topology-drag|"+id,
    needKey:"topology-drag-need|"+id,sdeNightPlacementGeneratedNeedKey:"topology-drag-need|"+id,
    source:"night-placement-drag",canonicalProducer:"graphic_drag_generated_move",
    canonicalPurpose:"vehicle-relocation",sdeCanonicalGraphicDragOrder:true,
    sdeNightPlacementDragIdentity:id,manualPlanId:"manual-graphic-order|"+id,
    sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true
  });
  const project=(rows,placements,actions={})=>ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements,actions));
  const identitiesMatch=reader=>{
    const cards=[...(reader?.cardProjection?.actionableCards||[]),...(reader?.cardProjection?.blockedChainCards||[])];
    const cardByOutcome=new Map(cards.map(card=>[card.activeOutcomeId,card]));
    const reservationByOutcome=new Map((reader?.reservationProjection?.reservations||[]).map(item=>[item.activeOutcomeId,item]));
    const overlayByOutcome=new Map([...(reader?.graphicProjection?.activeOverlays||[]),...(reader?.graphicProjection?.deferredOverlays||[])].map(item=>[item.activeOutcomeId,item]));
    return (reader?.canonicalPlan?.candidateOutcomes||[]).filter(item=>item.status!=="completed").every(outcome=>{
      const identity=ctx.buildSdeCanonicalPlanIdentity(outcome,reader?.planRevision||"");
      const card=cardByOutcome.get(outcome.candidateOutcomeId);
      const reservation=reservationByOutcome.get(outcome.candidateOutcomeId);
      const overlay=overlayByOutcome.get(outcome.candidateOutcomeId);
      const adapter=card&&reader?.handlerAdapters?.[card.canonicalCardId];
      return Boolean(card&&reservation&&overlay&&adapter
        && card.canonicalCardId===identity.canonicalCardId
        && reservation.reservationId===identity.reservationId
        && overlay.overlayId===identity.overlayId
        && adapter.canonicalCardId===identity.canonicalCardId
        && adapter.activeOutcomeId===identity.activeOutcomeId);
    });
  };
  const summarize=reader=>({
    candidateOutcomes:(reader?.canonicalPlan?.candidateOutcomes||[]).filter(item=>item.status!=="completed").length,
    outcomes:(reader?.canonicalPlan?.activeOutcomes||[]).length,
    cards:(reader?.cardProjection?.actionableCards||[]).length,
    blockedCards:(reader?.cardProjection?.blockedChainCards||[]).length,
    reservations:(reader?.reservationProjection?.reservations||[]).length,
    activeOverlays:(reader?.graphicProjection?.activeOverlays||[]).length,
    deferredOverlays:(reader?.graphicProjection?.deferredOverlays||[]).length,
    adapters:Object.keys(reader?.handlerAdapters||{}).length
  });

  const directRuns=[];
  fixture.vehiclePermutations.forEach((ids,permutationIndex)=>{
    fixture.directTargets.forEach(target=>{
      const placements=[["VN",ids.movingVehicle],...(target==="11N"?[["11S",ids.otherVehicle]]:[])];
      resetState(placements);
      const main=makeManual(ids.movingVehicle,"VN",target,"direct-"+permutationIndex+"-"+target);
      const route=ctx.getSdeDirectWashTransitRouteAssessment(main);
      const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
      const reader=project(rows,placements);
      const summary=summarize(reader);
      const card=(reader.cardProjection.actionableCards||[])[0];
      const adapter=card&&reader.handlerAdapters?.[card.canonicalCardId];
      directRuns.push({target,permutationIndex,routeEligible:route.eligible,topologicalRoutesConsidered:route.topologicalRoutesConsidered?.length||0,firstRejectedCandidate:route.firstRejectedCandidate||null,rows:rows.length,summary,cardTarget:card?.targetSlot||"",adapterReady:Boolean(adapter?.ready),cancelReady:Boolean(card?.canCancel&&adapter?.canCancel),identityMatch:identitiesMatch(reader)});
    });
  });
  put("INV-TOPOLOGY-DIRECT-001",directRuns.every(run=>run.routeEligible),JSON.stringify(directRuns));
  put("INV-TOPOLOGY-DIRECT-002",directRuns.every(run=>run.rows===1&&run.summary.outcomes===1&&run.summary.cards===1),JSON.stringify(directRuns));
  put("INV-TOPOLOGY-DIRECT-003",directRuns.every(run=>run.summary.reservations===1&&run.summary.activeOverlays===1&&run.summary.adapters===1&&run.adapterReady),JSON.stringify(directRuns));
  put("INV-TOPOLOGY-DIRECT-004",directRuns.every(run=>run.cardTarget===run.target),JSON.stringify(directRuns));
  put("INV-TOPOLOGY-DIRECT-005",directRuns.every(run=>run.identityMatch),"one canonical identity factory binds outcome/card/reservation/overlay/adapter");
  put("INV-TOPOLOGY-DIRECT-006",directRuns.every(run=>run.cancelReady),"manual moves from VN are vehicle-relocation obligations with Utført and Annullert controls");

  resetState([]);
  appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
  const fullMatrix=ctx.buildSdeCanonicalManualRouteCoverageMatrix();
  put("INV-TOPOLOGY-MATRIX-001",fullMatrix.pairCount>0&&fullMatrix.directCount===fullMatrix.pairCount&&fullMatrix.unreachableCount===0,JSON.stringify({sourceCount:fullMatrix.sourceCount,targetCount:fullMatrix.targetCount,pairCount:fullMatrix.pairCount,directCount:fullMatrix.directCount,unreachableCount:fullMatrix.unreachableCount,unreachable:fullMatrix.rows.filter((row)=>!row.eligible)}));

  const routeCandidates=[
    {routeKey:"rejected",sourceEnd:"north",targetEnd:"south",valid:false},
    {routeKey:"safe-south",sourceEnd:"south",targetEnd:"north",valid:true},
    {routeKey:"safe-north",sourceEnd:"north",targetEnd:"north",valid:true}
  ];
  const candidateSelections=fixture.candidateOrders.map((_,index)=>{
    const permutations=[routeCandidates,[routeCandidates[2],routeCandidates[0],routeCandidates[1]],[routeCandidates[1],routeCandidates[2],routeCandidates[0]]];
    const selection=ctx.selectSdeCanonicalSafeRouteCandidate(permutations[index]);
    return {selected:selection.selected?.routeKey||"",considered:selection.topologicalRoutesConsidered,rejected:selection.rejectedCandidates.length,exhausted:selection.candidateSearchExhausted};
  });
  put("INV-TOPOLOGY-CANDIDATE-001",candidateSelections.every(item=>item.selected==="safe-south"&&item.considered===3&&item.rejected===1&&item.exhausted),JSON.stringify(candidateSelections));

  const chainRuns=[];
  fixture.vehiclePermutations.forEach((ids,permutationIndex)=>{
    const cases=[
      {name:"11S-10S",from:"11S",target:"10S",placements:[["11S",ids.movingVehicle],["10N",ids.blockingVehicle]]},
      {name:"5M-6S",from:"5M",target:"6S",placements:[["5M",ids.movingVehicle],["6N",ids.blockingVehicle],["6SS",ids.otherVehicle]]}
    ];
    cases.forEach(testCase=>{
      resetState(testCase.placements);
      const main=makeManual(ids.movingVehicle,testCase.from,testCase.target,"chain-"+permutationIndex+"-"+testCase.name);
      const blockState=ctx.getSdeCompleteTrappedEgressBlockState(main,ctx.getSdeHardPhysicalBlockStateForMove(main));
      const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
      const reader=project(rows,testCase.placements);
      const summary=summarize(reader);
      const roles=rows.map(row=>String(row.sdePhysicalDependencyRole||"")).filter(Boolean);
      const release=rows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
      const dependent=rows.find(row=>row.sdePhysicalDependencyRole==="dependent");
      const recovery=rows.find(row=>row.sdePhysicalDependencyRole==="return");
      chainRuns.push({name:testCase.name,permutationIndex,hardBlocked:blockState.hardBlocked,topologicalRoutesConsidered:blockState.canonicalRouteAssessment?.topologicalRoutesConsidered?.length||0,blockers:(blockState.blockers||[]).map(item=>({slot:item.slot,accessEnd:item.accessEnd||""})),roles,summary,releaseTarget:release?.toSlot||"",mainTarget:dependent?.toSlot||"",recoveryTarget:recovery?.toSlot||"",identityMatch:identitiesMatch(reader),actualStillAtSource:(reader.graphicProjection.actualSlots||[]).some(item=>item.vehicleId===ids.movingVehicle&&item.slot===testCase.from)});
    });
  });
  const tenRuns=chainRuns.filter(run=>run.name==="11S-10S");
  const sixRuns=chainRuns.filter(run=>run.name==="5M-6S");
  const complete=run=>run.hardBlocked&&run.roles.join(",")==="prerequisite,dependent,return"&&run.summary.candidateOutcomes===3&&run.summary.outcomes===1&&run.summary.cards===1&&run.summary.blockedCards===2&&run.summary.reservations===3&&run.summary.activeOverlays===1&&run.summary.deferredOverlays===2&&run.summary.adapters===3;
  put("INV-TOPOLOGY-CHAIN-001",tenRuns.every(complete),JSON.stringify(tenRuns));
  put("INV-TOPOLOGY-CHAIN-002",tenRuns.every(run=>run.releaseTarget==="VN"&&run.mainTarget==="10S"&&run.recoveryTarget==="10N"),JSON.stringify(tenRuns));
  put("INV-TOPOLOGY-CHAIN-003",sixRuns.every(complete),JSON.stringify(sixRuns));
  put("INV-TOPOLOGY-CHAIN-004",sixRuns.every(run=>run.releaseTarget==="VN"&&run.mainTarget==="6S"&&run.recoveryTarget==="6N"),JSON.stringify(sixRuns));
  put("INV-TOPOLOGY-CHAIN-005",chainRuns.every(run=>run.identityMatch&&run.actualStillAtSource),"three-step projections share canonical identity and do not mutate actual placement");

  const sequenceRuns=[];
  [
    {name:"11S-10S",from:"11S",target:"10S",blockerFrom:"10N",otherSlot:""},
    {name:"5M-6S",from:"5M",target:"6S",blockerFrom:"6N",otherSlot:"6SS"}
  ].forEach((testCase,index)=>{
    const ids=fixture.vehiclePermutations[index];
    const initialPlacements=[[testCase.from,ids.movingVehicle],[testCase.blockerFrom,ids.blockingVehicle],...(testCase.otherSlot?[[testCase.otherSlot,ids.otherVehicle]]:[])];
    resetState(initialPlacements);
    const initialRows=ctx.buildSdePhysicalBlockerGuardMoves([makeManual(ids.movingVehicle,testCase.from,testCase.target,"sequence-"+testCase.name)]);
    const release=initialRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
    const main=initialRows.find(row=>row.sdePhysicalDependencyRole==="dependent");
    const recovery=initialRows.find(row=>row.sdePhysicalDependencyRole==="return");
    const releaseKey=ctx.getSdeMoveActionKey(release);
    const mainKey=ctx.getSdeMoveActionKey(main);
    const step1Actions={[releaseKey]:{action:"completed"}};
    const step1Placements=[["VN",ids.blockingVehicle],[testCase.from,ids.movingVehicle],...(testCase.otherSlot?[[testCase.otherSlot,ids.otherVehicle]]:[])];
    resetState(step1Placements,{sdeMoveActions:step1Actions});
    const afterStep1=project([main,recovery],step1Placements,step1Actions);
    const step2Actions={...step1Actions,[mainKey]:{action:"completed"}};
    const step2Placements=[["VN",ids.blockingVehicle],[testCase.target,ids.movingVehicle],...(testCase.otherSlot?[[testCase.otherSlot,ids.otherVehicle]]:[])];
    resetState(step2Placements,{sdeMoveActions:step2Actions});
    const afterStep2=project([recovery],step2Placements,step2Actions);
    sequenceRuns.push({
      name:testCase.name,
      step1Ready:(afterStep1.cardProjection.actionableCards||[]).map(card=>card.targetSlot),
      step1Blocked:(afterStep1.cardProjection.blockedChainCards||[]).map(card=>card.targetSlot),
      step1Candidates:(afterStep1.canonicalPlan.candidateOutcomes||[]).filter(item=>item.status!=="completed").length,
      step2Ready:(afterStep2.cardProjection.actionableCards||[]).map(card=>card.targetSlot),
      step2Candidates:(afterStep2.canonicalPlan.candidateOutcomes||[]).filter(item=>item.status!=="completed").length
    });
  });
  put("INV-TOPOLOGY-SEQUENCE-001",sequenceRuns.every(run=>run.step1Ready.length===1&&run.step1Ready[0]===({"11S-10S":"10S","5M-6S":"6S"})[run.name]&&run.step1Blocked.length===1&&run.step1Candidates===2),JSON.stringify(sequenceRuns));
  put("INV-TOPOLOGY-SEQUENCE-002",sequenceRuns.every(run=>run.step2Ready.length===1&&run.step2Candidates===1),JSON.stringify(sequenceRuns));

  const topologySignatures=fixture.vehiclePermutations.map((ids,permutationIndex)=>{
    const placements=[["11S",ids.movingVehicle],["10N",ids.blockingVehicle]];
    resetState(placements);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([makeManual(ids.movingVehicle,"11S","10S","permutation-"+permutationIndex)]);
    return JSON.stringify(rows.map(row=>({role:row.sdePhysicalDependencyRole,from:row.fromSlot,to:row.toSlot,depends:(row.sdePhysicalDependsOn||[]).length,resources:(row.sdeCanonicalRouteResourceClaims||row.sdeTrappedEgressRouteResources||[]).map(item=>typeof item==="string"?item:{resource:item.resource,state:item.state})})));
  });
  put("INV-TOPOLOGY-PERMUTATION-001",topologySignatures.every(value=>value===topologySignatures[0]),JSON.stringify(topologySignatures));

  const directDiagnostic=directRuns.find(run=>run.target==="3N"&&run.permutationIndex===0);
  const chainDiagnostic=sixRuns.find(run=>run.permutationIndex===0);
  const diagnosticContract=[
    {
      sourceSlot:"VN",targetSlot:"3N",planKind:"DIRECT",
      topologicalRoutesConsidered:directDiagnostic?.topologicalRoutesConsidered||0,
      blockers:[],selectedRelief:"",firstRejectedCandidate:directDiagnostic?.firstRejectedCandidate||null,
      firstSafeDivergence:"static source/target allowlist removed; canonical slot topology enumerated",
      outcomeCount:directDiagnostic?.summary?.outcomes||0,cardCount:directDiagnostic?.summary?.cards||0,
      reservationCount:directDiagnostic?.summary?.reservations||0,overlayCount:directDiagnostic?.summary?.activeOverlays||0,
      adapterCount:directDiagnostic?.summary?.adapters||0,identityStatus:directDiagnostic?.identityMatch?"MATCH":"MISMATCH",
      operationalConsequence:"direct route availability"
    },
    {
      sourceSlot:"5M",targetSlot:"6S",planKind:"RELEASE_MAIN_RECOVERY",
      topologicalRoutesConsidered:chainDiagnostic?.topologicalRoutesConsidered||0,
      blockers:chainDiagnostic?.blockers||[],selectedRelief:chainDiagnostic?.releaseTarget||"",
      firstRejectedCandidate:null,firstSafeDivergence:"safe VN relief preferred after complete hard-safety validation",
      outcomeCount:chainDiagnostic?.summary?.candidateOutcomes||0,
      cardCount:(chainDiagnostic?.summary?.cards||0)+(chainDiagnostic?.summary?.blockedCards||0),
      reservationCount:chainDiagnostic?.summary?.reservations||0,
      overlayCount:(chainDiagnostic?.summary?.activeOverlays||0)+(chainDiagnostic?.summary?.deferredOverlays||0),
      adapterCount:chainDiagnostic?.summary?.adapters||0,identityStatus:chainDiagnostic?.identityMatch?"MATCH":"MISMATCH",
      operationalConsequence:"blocked-slot relief and chain compilation"
    }
  ];
  const requiredDiagnosticFields=["sourceSlot","targetSlot","planKind","topologicalRoutesConsidered","blockers","selectedRelief","firstRejectedCandidate","firstSafeDivergence","outcomeCount","cardCount","reservationCount","overlayCount","adapterCount","identityStatus","operationalConsequence"];
  put("INV-TOPOLOGY-DIAGNOSTIC-001",diagnosticContract.every(item=>requiredDiagnosticFields.every(field=>Object.prototype.hasOwnProperty.call(item,field)))&&diagnosticContract[0].outcomeCount===1&&diagnosticContract[1].cardCount===3,JSON.stringify(diagnosticContract));
})();
`);

const results=globalThis.__topologyResults;
process.stdout.write(`${JSON.stringify({schemaVersion:"sde-topology-complete-drag-invariants-v1",counts:{total:results.length,pass:results.filter(item=>item.status==="PASS").length,fail:results.filter(item=>item.status==="FAIL").length},results})}\n`);
process.exitCode=results.some(item=>item.status==="FAIL")?1:0;

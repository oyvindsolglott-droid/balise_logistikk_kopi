"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const baseHarness = fs.readFileSync(
  path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"),
  "utf8",
);
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));
const results = [];

globalThis.__blockedTargetResults = results;

eval(prefix + String.raw`
(()=>{
  const allInputSlots=vm.runInContext("inputSlots",ctx);
  const targetDefinitions = [
    {target:"4M", blockers:["4N","4S"], source:"9"},
    {target:"5M", blockers:["5N","5S"], source:"9"},
    {target:"6S", blockers:["6N","6SS"], source:"9"},
    {target:"10S", blockers:["10N"], source:"9"},
    {target:"11S", blockers:["11N"], source:"9"},
    {target:"12S", blockers:["12N"], source:"9"}
  ];
  const allCards=reader=>[
    ...(reader?.cardProjection?.actionableCards||[]),
    ...(reader?.cardProjection?.blockedChainCards||[]),
    ...(reader?.cardProjection?.handlerBlockedCards||[])
  ];
  const allOverlays=reader=>[
    ...(reader?.graphicProjection?.activeOverlays||[]),
    ...(reader?.graphicProjection?.deferredOverlays||[])
  ];
  const makeTargetMove=definition=>{
    const vehicle="TARGET-MAIN-"+definition.target;
    const actionKey=["night-placement-drag",vehicle,definition.source,definition.target,"blocked-target-"+definition.target].join("|");
    return {
      vehicle,fromSlot:definition.source,arrivalSlot:definition.source,originalFromSlot:definition.source,
      recommendedSlot:definition.target,toSlot:definition.target,stableActionKey:actionKey,
      sdeNightPlacementGeneratedActionKey:actionKey,needKey:"need|"+actionKey,
      sdeNightPlacementGeneratedNeedKey:"need|"+actionKey,source:"night-placement-drag",
      canonicalProducer:"graphic_drag_generated_move",canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,sdeNightPlacementDragIdentity:"blocked-target-"+definition.target,
      manualPlanId:"manual-graphic-order|blocked-target-"+definition.target,
      sdeNightPlacementDragOverrideActive:true,isNightPlacementGenerated:true,isManualOnly:true
    };
  };
  const build=definition=>{
    const main=makeTargetMove(definition);
    const placements=[[definition.source,main.vehicle],...definition.blockers.map((slot,index)=>[slot,"TARGET-BLOCKER-"+definition.target+"-"+(index+1)])];
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const actualBeforePlanning=JSON.stringify(appState.grunnoppstilling||{});
    const assessment=ctx.getSdeHardPhysicalBlockStateForMove(main);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const actualUnchanged=JSON.stringify(appState.grunnoppstilling||{})===actualBeforePlanning;
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements,appState.sdeMoveActions||{}));
    const cards=allCards(reader);
    const releases=rows.filter(row=>row.sdePhysicalDependencyRole==="prerequisite");
    const mains=rows.filter(row=>row.sdePhysicalDependencyRole==="dependent");
    const recoveries=rows.filter(row=>row.sdePhysicalDependencyRole==="return");
    return {definition,main,placements,assessment,rows,reader,cards,releases,mains,recoveries,actualUnchanged};
  };
  const completeProjection=report=>{
    const outcomes=report.reader?.canonicalPlan?.candidateOutcomes||[];
    const reservations=report.reader?.reservationProjection?.reservations||[];
    const overlays=allOverlays(report.reader);
    return report.rows.every(row=>{
      const key=ctx.getSdeMoveActionKey(row);
      const outcome=outcomes.find(item=>item.actionKey===key);
      const card=report.cards.find(item=>item.activeOutcomeId===outcome?.candidateOutcomeId);
      const adapter=card ? report.reader.handlerAdapters?.[card.canonicalCardId] : null;
      return Boolean(outcome&&card&&adapter
        && reservations.some(item=>item.activeOutcomeId===outcome.candidateOutcomeId)
        && overlays.some(item=>item.activeOutcomeId===outcome.candidateOutcomeId)
        && Array.isArray(outcome.routeResources)&&outcome.routeResources.length);
    });
  };
  const movePlacement=(placements,vehicle,fromSlot,toSlot)=>placements
    .filter(([slot,itemVehicle])=>slot!==fromSlot&&itemVehicle!==vehicle)
    .concat([[toSlot,vehicle]]);
  const noOperative=reader=>Boolean(
    (reader?.canonicalPlan?.activeOutcomes||[]).length===0
    && allCards(reader).length===0
    && (reader?.reservationProjection?.reservations||[]).length===0
    && allOverlays(reader).length===0
    && Object.keys(reader?.handlerAdapters||{}).length===0
  );
  const projectionFingerprint=reader=>JSON.stringify({
    outcomes:(reader?.canonicalPlan?.candidateOutcomes||[]).map(item=>[item.actionKey,item.candidateOutcomeId,item.dependencies]),
    cards:allCards(reader).map(item=>[item.canonicalCardId,item.status,item.activeOutcomeId]),
    reservations:(reader?.reservationProjection?.reservations||[]).map(item=>[item.reservationId,item.activeOutcomeId]),
    overlays:allOverlays(reader).map(item=>[item.overlayId,item.activeOutcomeId]),
    adapters:Object.keys(reader?.handlerAdapters||{}).sort()
  });
  const buildSourceBlocked=definition=>{
    const destination="9";
    const vehicle="SOURCE-MAIN-"+definition.target;
    const actionKey=["night-placement-drag",vehicle,definition.target,destination,"blocked-source-"+definition.target].join("|");
    const main={...makeTargetMove({...definition,source:definition.target}),vehicle,
      fromSlot:definition.target,arrivalSlot:definition.target,originalFromSlot:definition.target,
      recommendedSlot:destination,toSlot:destination,stableActionKey:actionKey,
      sdeNightPlacementGeneratedActionKey:actionKey,sdeNightPlacementDragIdentity:"blocked-source-"+definition.target};
    const placements=[[definition.target,vehicle],...definition.blockers.map((slot,index)=>[slot,"SOURCE-BLOCKER-"+definition.target+"-"+(index+1)])];
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements,{}));
    const releases=rows.filter(row=>row.sdePhysicalDependencyRole==="prerequisite");
    const mains=rows.filter(row=>row.sdePhysicalDependencyRole==="dependent");
    const recoveries=rows.filter(row=>row.sdePhysicalDependencyRole==="return");
    return Boolean(rows.length===3&&releases.length===1&&mains.length===1&&recoveries.length===1
      && mains[0].toSlot===destination&&recoveries[0].toSlot===releases[0].fromSlot
      && reader.cardProjection.actionableCards.length===1&&reader.cardProjection.blockedChainCards.length===2
      && reader.integrityReport.status==="PASS");
  };
  const buildNoSafeTemporary=definition=>{
    const main=makeTargetMove(definition);
    const protectedSlots=new Set([definition.target]);
    const placements=allInputSlots.filter(slot=>!protectedSlots.has(slot)).map((slot,index)=>[slot,"NO-SAFE-"+definition.target+"-"+index]);
    const sourceIndex=placements.findIndex(([slot])=>slot===definition.source);
    if(sourceIndex>=0) placements[sourceIndex]=[definition.source,main.vehicle];
    definition.blockers.forEach((slot,index)=>{
      const found=placements.findIndex(([itemSlot])=>itemSlot===slot);
      if(found>=0) placements[found]=[slot,"NO-SAFE-BLOCKER-"+definition.target+"-"+index];
    });
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements,{}));
    return noOperative(reader);
  };
  const buildOneAccessCase=definition=>{
    const main=makeTargetMove(definition);
    const placements=[[definition.source,main.vehicle],[definition.blockers[0],"ONE-BLOCKER-"+definition.target]];
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,placements,{}));
    const dualAccess=definition.blockers.length===2;
    return dualAccess
      ? rows.length===1&&!rows[0].sdePhysicalChainId&&reader.cardProjection.actionableCards.length===1
      : rows.length===3&&reader.cardProjection.actionableCards.length===1&&reader.cardProjection.blockedChainCards.length===2;
  };
  const buildVnFallback=definition=>{
    if(/^(10|11|12)S$/.test(definition.target)) return true;
    const main=makeTargetMove(definition);
    const keepFree=new Set([definition.target,"VN","VS"]);
    const placements=allInputSlots.filter(slot=>!keepFree.has(slot)).map((slot,index)=>[slot,"VN-FALLBACK-"+definition.target+"-"+index]);
    const sourceIndex=placements.findIndex(([slot])=>slot===definition.source);
    if(sourceIndex>=0) placements[sourceIndex]=[definition.source,main.vehicle];
    definition.blockers.forEach((slot,index)=>{
      const found=placements.findIndex(([itemSlot])=>itemSlot===slot);
      if(found>=0) placements[found]=[slot,"VN-FALLBACK-BLOCKER-"+definition.target+"-"+index];
    });
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const release=rows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
    const recovery=rows.find(row=>row.sdePhysicalDependencyRole==="return");
    return Boolean(rows.length===3&&release?.toSlot==="VN"&&recovery?.fromSlot==="VN"&&recovery?.toSlot===release?.fromSlot);
  };
  const reports=[];
  for(const definition of targetDefinitions){
    let report;
    try{ report=build(definition); }
    catch(error){
      reports.push({target:definition.target,pass:false,error:String(error?.stack||error)});
      continue;
    }
    const release=report.releases[0], main=report.mains[0], recovery=report.recoveries[0];
    if(!release||!main||!recovery){
      const invariantFailures=[];
      if(!release) invariantFailures.push("BLOCKER_CARD_PRESENT");
      if(!recovery) invariantFailures.push("RECOVERY_CARD_PRESENT");
      invariantFailures.push("NO_PARTIAL_THREE_CARD_PROJECTION");
      reports.push({
        target:definition.target,pass:false,invariantFailures,
        rows:report.rows.map(row=>({vehicle:row.vehicle,from:row.fromSlot,to:row.toSlot,role:row.sdePhysicalDependencyRole,step:row.sdePhysicalChainStep,dependsOn:row.sdePhysicalDependsOn||[]})),
        cardStatuses:report.cards.map(card=>card.status),
        actualUnchanged:report.actualUnchanged,
        integrity:report.reader?.integrityReport?.status||""
      });
      continue;
    }
    const releaseKey=ctx.getSdeMoveActionKey(release);
    const mainKey=ctx.getSdeMoveActionKey(main);
    const recoveryKey=ctx.getSdeMoveActionKey(recovery);
    const plan=release?.sdePhysicalAccessReliefChain;
    const reloadedReader=ctx.buildSdeCanonicalProductionReader(snapshot(report.rows,report.placements,{}));
    const reloadStable=projectionFingerprint(report.reader)===projectionFingerprint(reloadedReader);
    const afterReleasePlacements=movePlacement(report.placements,release.vehicle,release.fromSlot,release.toSlot);
    const afterReleaseActions={[releaseKey]:{action:"completed",snapshot:release}};
    resetState(afterReleasePlacements,{sdeMoveActions:afterReleaseActions});
    const afterReleaseRows=ctx.buildSdePhysicalBlockerGuardMoves([report.main]);
    const afterReleaseReader=ctx.buildSdeCanonicalProductionReader(snapshot(afterReleaseRows,afterReleasePlacements,afterReleaseActions));
    const step2Ready=afterReleaseReader.cardProjection.actionableCards.length===1
      && afterReleaseReader.cardProjection.actionableCards[0].vehicleId===report.main.vehicle
      && afterReleaseReader.cardProjection.blockedChainCards.length===1;
    const afterMainPlacements=movePlacement(afterReleasePlacements,report.main.vehicle,definition.source,definition.target);
    const afterMainActions={...afterReleaseActions,[mainKey]:{action:"completed",snapshot:main}};
    resetState(afterMainPlacements,{sdeMoveActions:afterMainActions});
    const afterMainReader=ctx.buildSdeCanonicalProductionReader(snapshot([recovery],afterMainPlacements,afterMainActions));
    const step3Ready=afterMainReader.cardProjection.actionableCards.length===1
      && afterMainReader.cardProjection.actionableCards[0].vehicleId===release.vehicle
      && afterMainReader.cardProjection.actionableCards[0].targetSlot===release.fromSlot;
    const cancelledActions={...afterReleaseActions,[mainKey]:{action:"cancelled",snapshot:main}};
    resetState(afterReleasePlacements,{sdeMoveActions:cancelledActions});
    const cancelledRecovery=ctx.buildSdeTemporaryAccessReturnRow(plan);
    const cancelledReader=ctx.buildSdeCanonicalProductionReader(snapshot(cancelledRecovery?[cancelledRecovery]:[],afterReleasePlacements,cancelledActions));
    const cancelReplan=Boolean(cancelledRecovery
      && cancelledRecovery.sdePhysicalDependsOn?.[0]===releaseKey
      && cancelledRecovery.toSlot===release.fromSlot
      && cancelledReader.cardProjection.actionableCards.length===1);
    const closedPlacements=movePlacement(afterMainPlacements,release.vehicle,release.toSlot,release.fromSlot);
    const closedActions={...afterMainActions,[recoveryKey]:{action:"completed",snapshot:recovery}};
    resetState(closedPlacements,{sdeMoveActions:closedActions});
    const closedReader=ctx.buildSdeCanonicalProductionReader(snapshot([],closedPlacements,closedActions));
    const closed=noOperative(closedReader);
    resetState(afterMainPlacements,{sdeMoveActions:afterMainActions});
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const oldRecoveryCard=allCards(afterMainReader).find(card=>card.vehicleId===recovery.vehicle&&card.targetSlot===recovery.toSlot);
    const oldRecoveryAdapter=oldRecoveryCard ? afterMainReader.handlerAdapters?.[oldRecoveryCard.canonicalCardId] : null;
    const authoritativeTarget="8N";
    const authoritativeSet=ctx.setSdeCanonicalRetargetIntent(recovery,{mode:"explicit_target",targetSlot:authoritativeTarget});
    const authoritativeRows=authoritativeSet.ok ? ctx.applySdeCanonicalRetargetIntentsToRows([recovery]) : [];
    const authoritativeReader=authoritativeRows.length
      ? ctx.buildSdeCanonicalProductionReader(snapshot(authoritativeRows,afterMainPlacements,afterMainActions))
      : null;
    const authoritativeCards=allCards(authoritativeReader);
    const authoritativeRecovery=authoritativeRows.find(row=>row.sdePhysicalDependencyRole==="return");
    const newRecoveryCard=authoritativeCards.find(card=>card.vehicleId===recovery.vehicle&&card.targetSlot===authoritativeTarget);
    const newRecoveryAdapter=newRecoveryCard ? authoritativeReader?.handlerAdapters?.[newRecoveryCard.canonicalCardId] : null;
    const staleResolution=ctx.resolveSdeCanonicalRetargetAction({
      renderedDescriptor:oldRecoveryAdapter?.executionDescriptor,
      currentDescriptor:newRecoveryAdapter?.executionDescriptor,
      currentCard:newRecoveryCard,
      currentHandlerDescriptor:newRecoveryAdapter
    });
    const authoritativeRecoveryReplan=Boolean(
      authoritativeSet.ok
      && authoritativeRecovery?.toSlot===authoritativeTarget
      && authoritativeRows.filter(row=>row.sdePhysicalDependencyRole==="return").length===1
      && authoritativeReader?.integrityReport?.status==="PASS"
      && completeProjection({...report,rows:authoritativeRows,reader:authoritativeReader,cards:authoritativeCards})
    );
    const staleHistoryRejected=Boolean(
      oldRecoveryCard?.activeOutcomeId!==newRecoveryCard?.activeOutcomeId
      && staleResolution?.executable===false
      && !authoritativeCards.some(card=>card.activeOutcomeId===oldRecoveryCard?.activeOutcomeId)
    );
    const sourceBlocked=buildSourceBlocked(definition);
    const oneAccess=buildOneAccessCase(definition);
    const vnFallback=buildVnFallback(definition);
    const noSafeTemporary=buildNoSafeTemporary(definition);
    resetState(report.placements);
    const viewportChecks=[1200,390].map(width=>{
      ctx.innerWidth=width;
      try{
        const dragAssessment=ctx.buildSdeNightPlacementDropAssessment({
          vehicle:report.main.vehicle,slot:definition.source,fromSlot:definition.source,sourceKind:"actual"
        },definition.target,{moves:[]});
        return Boolean(dragAssessment?.hardPhysicalBlocked===true&&dragAssessment?.blockedMoveRequest?.recommendedSlot===definition.target);
      }catch(_error){ return false; }
    });
    const pass=Boolean(
      report.assessment?.hardBlocked===true
      && report.assessment?.accessAssessment?.targetAccessBlocked===true
      && report.rows.length===3
      && report.releases.length===1&&report.mains.length===1&&report.recoveries.length===1
      && main?.vehicle===report.main.vehicle&&main?.toSlot===definition.target
      && release?.vehicle===recovery?.vehicle
      && recovery?.fromSlot===release?.toSlot&&recovery?.toSlot===release?.fromSlot
      && (main?.sdePhysicalDependsOn||[]).join("")===ctx.getSdeMoveActionKey(release)
      && (recovery?.sdePhysicalDependsOn||[]).join("")===ctx.getSdeMoveActionKey(main)
      && report.reader?.cardProjection?.actionableCards?.length===1
      && report.reader?.cardProjection?.blockedChainCards?.length===2
      && report.reader?.reservationProjection?.conflicts?.length===0
      && report.reader?.integrityReport?.status==="PASS"
      && completeProjection(report)
      && report.actualUnchanged
      && reloadStable&&step2Ready&&step3Ready&&cancelReplan&&closed
      && authoritativeRecoveryReplan&&staleHistoryRejected
      && sourceBlocked&&oneAccess&&vnFallback&&noSafeTemporary&&viewportChecks.every(Boolean)
    );
    const invariantFailures=[];
    if(report.rows.length!==3||report.releases.length!==1) invariantFailures.push("BLOCKER_CARD_PRESENT");
    if(report.rows.length!==3||report.recoveries.length!==1) invariantFailures.push("RECOVERY_CARD_PRESENT");
    if(report.cards.map(card=>card.status).join(",")!=="actionable,blocked_chain_step,blocked_chain_step") invariantFailures.push("MAIN_BLOCKED_UNTIL_RELEASE");
    if(!completeProjection(report)) invariantFailures.push("NO_PARTIAL_THREE_CARD_PROJECTION");
    if(!authoritativeRecoveryReplan||!staleHistoryRejected) invariantFailures.push("AUTHORITATIVE_RECOVERY_REPLACES_STALE_DESTINATION");
    if(!report.actualUnchanged) invariantFailures.push("ACTUAL_PLACEMENT_UNCHANGED_BEFORE_COMPLETION");
    reports.push({
      target:definition.target,pass,
      hardBlocked:report.assessment?.hardBlocked,
      targetAccessBlocked:report.assessment?.accessAssessment?.targetAccessBlocked,
      blockers:(report.assessment?.blockers||[]).map(blocker=>({slot:blocker.slot,vehicle:blocker.vehicle,accessEnd:blocker.accessEnd,reason:blocker.reason})),
      targetAccessOptions:(report.assessment?.accessAssessment?.targetAccessOptions||[]).map(option=>({end:option.end,clear:option.clear,pathSlots:option.pathSlots,blockers:option.blockers})),
      rows:report.rows.map(row=>({vehicle:row.vehicle,from:row.fromSlot,to:row.toSlot,role:row.sdePhysicalDependencyRole,step:row.sdePhysicalChainStep,dependsOn:row.sdePhysicalDependsOn||[]})),
      cardStatuses:report.cards.map(card=>card.status),
      integrity:report.reader?.integrityReport?.status,
      reservations:report.reader?.reservationProjection?.reservations?.length,
      overlays:allOverlays(report.reader).length,
      adapters:Object.keys(report.reader?.handlerAdapters||{}).length,
      lifecycle:{reloadStable,step2Ready,step3Ready,cancelReplan,closed,authoritativeRecoveryReplan,staleHistoryRejected},
      actualUnchanged:report.actualUnchanged,
      invariantFailures,
      authoritative:{set:authoritativeSet.ok,target:authoritativeRecovery?.toSlot||"",cards:authoritativeCards.length,reservations:authoritativeReader?.reservationProjection?.reservations?.length||0,overlays:allOverlays(authoritativeReader).length,adapters:Object.keys(authoritativeReader?.handlerAdapters||{}).length,integrity:authoritativeReader?.integrityReport?.status||"",diagnostics:[...(authoritativeReader?.canonicalPlan?.diagnostics||[]),...(authoritativeReader?.cardProjection?.diagnostics||[])].map(item=>item.code||item.diagnosticType||item.problemId||"")},
      coverage:{sourceBlocked,oneAccess,vnFallback,noSafeTemporary,desktop:viewportChecks[0],mobile390:viewportChecks[1]},
      diagnostics:[...(report.reader?.canonicalPlan?.diagnostics||[]),...(report.reader?.cardProjection?.diagnostics||[])].map(item=>item.code||item.diagnosticType||item.problemId||"")
    });
  }
  const failures=reports.filter(report=>!report.pass);
  globalThis.__blockedTargetResults.push(...reports);
  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-blocked-target-three-card-harness-v1",
    counts:{total:reports.length,pass:reports.length-failures.length,fail:failures.length},
    reports
  })+"\n");
  process.exitCode=failures.length?1:0;
})()
`);

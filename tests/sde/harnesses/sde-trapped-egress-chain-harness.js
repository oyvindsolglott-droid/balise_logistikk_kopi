"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const root = path.resolve(__dirname, "../../..");
const baseHarness = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/trapped-egress-chains.json"), "utf8")).fixtures;
const results = [];
const scenarios = {};
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

globalThis.__egressFixtures = fixtures;
globalThis.__egressResults = results;
globalThis.__egressScenarios = scenarios;
globalThis.__egressRecord = record;

eval(prefix + String.raw`
(()=>{
  const f=globalThis.__egressFixtures;
  const put=globalThis.__egressRecord;
  const reports=globalThis.__egressScenarios;
  const mainRow=fixture=>{
    const row=makeMain(String(fixture.main.sourceSlot).replace(/[^0-9].*$/,""),fixture.main.vehicle,fixture.main.requestedTarget,fixture.main.requestId);
    return {...row,fromSlot:fixture.main.sourceSlot,arrivalSlot:fixture.main.sourceSlot,originalFromSlot:fixture.main.sourceSlot};
  };
  const allCards=reader=>[
    ...(reader?.cardProjection?.actionableCards||[]),
    ...(reader?.cardProjection?.blockedChainCards||[]),
    ...(reader?.cardProjection?.handlerBlockedCards||[])
  ];
  const allOverlays=reader=>[
    ...(reader?.graphicProjection?.activeOverlays||[]),
    ...(reader?.graphicProjection?.deferredOverlays||[])
  ];
  const role=(rows,name)=>rows.filter(row=>row.sdePhysicalDependencyRole===name);
  const build=(fixture,extraRows=[],extraState={})=>{
    resetState(fixture.placements,extraState);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const main=mainRow(fixture);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([...extraRows,main]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,fixture.placements,appState.sdeMoveActions||{}));
    return {fixture,main,rows,reader,cards:allCards(reader),releases:role(rows,"prerequisite"),mains:role(rows,"dependent"),recoveries:role(rows,"return")};
  };
  const hasPairing=report=>report.releases.every(release=>report.recoveries.some(recovery=>
    recovery.vehicle===release.vehicle
    && recovery.fromSlot===release.toSlot
    && recovery.toSlot===release.fromSlot
  ));
  const projectionComplete=report=>{
    const outcomes=report.reader.canonicalPlan.candidateOutcomes||[];
    const reservations=report.reader.reservationProjection.reservations||[];
    const overlays=allOverlays(report.reader);
    return report.reader?.integrityReport?.status==="PASS" && report.rows.every(row=>{
      const key=ctx.getSdeMoveActionKey(row);
      const outcome=outcomes.find(item=>item.actionKey===key);
      const card=report.cards.find(item=>item.activeOutcomeId===outcome?.candidateOutcomeId);
      const adapter=card ? report.reader.handlerAdapters?.[card.canonicalCardId] : null;
      return Boolean(outcome && card
        && reservations.some(item=>item.activeOutcomeId===outcome.candidateOutcomeId)
        && overlays.some(item=>item.activeOutcomeId===outcome.candidateOutcomeId)
        && adapter
        && Array.isArray(outcome.routeResources)
        && outcome.routeResources.length);
    });
  };
  const complete=report=>Boolean(
    report.releases.length>=1
    && report.mains.length===1
    && report.recoveries.length===report.releases.length
    && hasPairing(report)
    && projectionComplete(report)
    && report.reader.integrityReport.status==="PASS"
    && report.reader.reservationProjection.conflicts.length===0
  );
  const acyclic=rows=>{
    const byKey=new Map(rows.map(row=>[ctx.getSdeMoveActionKey(row),row]));
    const visiting=new Set(),visited=new Set();
    const visit=key=>{
      if(visited.has(key)) return true;
      if(visiting.has(key)) return false;
      visiting.add(key);
      const row=byKey.get(key);
      for(const dependency of row?.sdePhysicalDependsOn||[]){ if(byKey.has(dependency)&&!visit(dependency)) return false; }
      visiting.delete(key); visited.add(key); return true;
    };
    return [...byKey.keys()].every(visit);
  };
  const built={};
  for(const key of ["A","B","C","D","E","F","G","L"]){
    try{ built[key]=build(f[key]); }
    catch(error){ built[key]={fixture:f[key],rows:[],reader:null,cards:[],releases:[],mains:[],recoveries:[],error:String(error?.stack||error)}; }
    reports[key]={
      name:f[key].name,
      physicalRelation:f[key].physicalRelation,
      rows:built[key].rows.map(row=>({vehicle:row.vehicle,from:row.fromSlot,to:row.toSlot,role:row.sdePhysicalDependencyRole,step:row.sdePhysicalChainStep,dependsOn:row.sdePhysicalDependsOn||[]})),
      integrity:built[key].reader?.integrityReport?.status||"ERROR",
      error:built[key].error||""
    };
  }

  const A=built.A;
  put("INV-EGRESS-001",complete(A)&&A.mains[0]?.fromSlot==="4M"&&A.mains[0]?.toSlot==="5M","4M→5M is complete or must fail diagnostic-only; partial release/main materialization is forbidden");
  put("INV-EGRESS-002",["A","B","C","D","E","F"].every(key=>complete(built[key])),"4M, 5M, 6S, 7S and 8S plus the recursive source produce complete safe source-egress plans");
  put("INV-EGRESS-003",complete(built.F)&&built.F.releases.length>=2&&built.F.recoveries.length>=2,"recursive F chain has at least two prerequisites and no one-blocker cap");
  put("INV-EGRESS-004",acyclic(built.F.rows)&&built.F.reader?.cardProjection?.actionableCards?.length===1&&built.F.mains[0]?.sdePhysicalDependsOn?.length>0,"dependency DAG is acyclic and only the first prerequisite is actionable");
  put("INV-EGRESS-005",["A","B","C","D","E","F"].every(key=>projectionComplete(built[key])),"every planned step has outcome/card/reservation/overlay/routes/adapter from one revision");
  put("INV-EGRESS-006",["A","B","C","D","E","F"].every(key=>hasPairing(built[key])&&built[key].recoveries.length===built[key].releases.length),"every temporary release has mandatory recovery");

  let occupiedGate=false;
  try{
    const fixture=JSON.parse(JSON.stringify(f.A));
    fixture.placements.push([fixture.main.requestedTarget,"A-TARGET-OCCUPIED"]);
    const blocked=build(fixture);
    occupiedGate=(blocked.reader?.canonicalPlan?.activeOutcomes||[]).length===0&&blocked.cards.length===0&&(blocked.reader?.reservationProjection?.reservations||[]).length===0;
  }catch(_error){}
  put("INV-EGRESS-007",A.mains[0]?.toSlot===f.A.main.requestedTarget&&occupiedGate,"requested target is exact and occupied target still materializes nothing");

  let tripleRetarget=false;
  try{
    const initial=build(f.A);
    const release=initial.releases.find(row=>(row.sdePhysicalReleaseCandidateOrder||[]).length>1);
    const main=initial.mains[0];
    const recovery=initial.recoveries[0];
    const releaseTarget=(release?.sdePhysicalReleaseCandidateOrder||[]).find(slot=>slot!==release.toSlot);
    const mainTarget="9";
    const recoveryTarget="10N";
    const releaseSet=release&&releaseTarget ? ctx.setSdeCanonicalRetargetIntent(release,{mode:"explicit_target",targetSlot:releaseTarget}) : {ok:false};
    const releasePlan=releaseSet.ok ? build(f.A) : null;
    resetState(f.A.placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const freshMain=mainRow(f.A);
    const freshRows=ctx.buildSdePhysicalBlockerGuardMoves([freshMain]);
    const freshMainRow=freshRows.find(row=>row.sdePhysicalDependencyRole==="dependent");
    const mainSet=freshMainRow ? ctx.setSdeCanonicalRetargetIntent(freshMainRow,{mode:"explicit_target",targetSlot:mainTarget}) : {ok:false};
    const mainPlan=mainSet.ok ? build(f.A) : null;
    resetState(f.A.placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const recoveryBase=build(f.A);
    const recoveryRow=recoveryBase.recoveries[0];
    const recoverySet=recoveryRow ? ctx.setSdeCanonicalRetargetIntent(recoveryRow,{mode:"explicit_target",targetSlot:recoveryTarget}) : {ok:false};
    const recoveryRows=recoverySet.ok ? ctx.applySdeCanonicalRetargetIntentsToRows(recoveryBase.rows) : [];
    const recoveryReader=recoveryRows.length ? ctx.buildSdeCanonicalProductionReader(snapshot(recoveryRows,f.A.placements)) : null;
    tripleRetarget=Boolean(
      releasePlan?.releases.some(row=>row.toSlot===releaseTarget)
      && mainPlan?.mains.some(row=>row.toSlot===mainTarget)
      && recoveryRows.some(row=>row.sdePhysicalDependencyRole==="return"&&row.toSlot===recoveryTarget)
      && recoveryReader?.integrityReport?.status==="PASS"
    );
    reports.H={name:f.H.name,physicalRelation:f.H.physicalRelation,releaseTarget,mainTarget,recoveryTarget,tripleRetarget};
  }catch(error){ reports.H={name:f.H.name,error:String(error)}; }
  const retargetable=A.cards.filter(card=>["actionable","blocked_chain_step"].includes(card.status));
  put("INV-EGRESS-008",tripleRetarget&&retargetable.length===A.rows.length&&retargetable.every(card=>card.canRetarget===true)&&retargetable.filter(card=>card.recoveryRequired).every(card=>card.canCancel===false&&card.canDelete===false),"all qualified unresolved release/main/recovery cards retarget independently of cancel/delete");

  let midChain=false;
  try{
    const initial=built.F;
    const first=initial.releases[0];
    const placements=f.F.placements.filter(([slot])=>slot!==first.fromSlot).concat([[first.toSlot,first.vehicle]]);
    const actions={[ctx.getSdeMoveActionKey(first)]:{action:"completed",completedAt:"2026-07-15T12:00:00.000Z"}};
    const fixture={...f.F,placements};
    const suffix=build(fixture,[],{sdeMoveActions:actions});
    midChain=suffix.rows.every(row=>ctx.getSdeMoveActionKey(row)!==ctx.getSdeMoveActionKey(first))
      && appState.sdeMoveActions[ctx.getSdeMoveActionKey(first)]?.action==="completed"
      && suffix.mains.length===1
      && suffix.mains[0].toSlot===f.F.main.requestedTarget
      && suffix.cards.every(card=>card.canRetarget===true);
    reports.I={name:f.I.name,physicalRelation:f.I.physicalRelation,completedKey:ctx.getSdeMoveActionKey(first),suffixRows:suffix.rows.map(row=>({vehicle:row.vehicle,from:row.fromSlot,to:row.toSlot,role:row.sdePhysicalDependencyRole}))};
  }catch(error){ reports.I={name:f.I.name,error:String(error)}; }
  put("INV-EGRESS-009",midChain,"mid-chain replanning uses fresh actual state, preserves completed history and replaces only unresolved suffix");

  const G=built.G;
  const noSolution=Boolean(G.reader
    && G.cards.length===0
    && (G.reader.canonicalPlan.activeOutcomes||[]).length===0
    && (G.reader.reservationProjection.reservations||[]).length===0
    && allOverlays(G.reader).length===0
    && Object.keys(G.reader.handlerAdapters||{}).length===0
    && [...(G.reader.canonicalPlan.diagnostics||[]),...(G.reader.cardProjection.diagnostics||[])].some(item=>String(item.code||item.diagnosticType||"").includes("trapped_vehicle_no_safe_egress_plan")));
  put("INV-EGRESS-010",noSolution&&complete(A),"no safe full chain is diagnostic-only and omitted/partial state is rejected in solvable cases");

  let stale=false;
  try{
    const initial=built.B;
    const step=initial.releases.find(row=>(row.sdePhysicalReleaseCandidateOrder||[]).length>1);
    const oldCard=initial.cards.find(card=>card.targetSlot===step?.toSlot&&card.vehicleId===step?.vehicle);
    const oldAdapter=oldCard ? initial.reader.handlerAdapters?.[oldCard.canonicalCardId] : null;
    const alternate=(step?.sdePhysicalReleaseCandidateOrder||[]).find(slot=>slot!==step.toSlot);
    if(step&&alternate){
      ctx.setSdeCanonicalRetargetIntent(step,{mode:"explicit_target",targetSlot:alternate});
      const next=build(f.B);
      const newCard=next.cards.find(card=>card.vehicleId===step.vehicle&&card.targetSlot===alternate);
      const newAdapter=newCard ? next.reader.handlerAdapters?.[newCard.canonicalCardId] : null;
      const resolution=ctx.resolveSdeCanonicalRetargetAction({renderedDescriptor:oldAdapter?.executionDescriptor,currentDescriptor:newAdapter?.executionDescriptor,currentCard:newCard,currentHandlerDescriptor:newAdapter});
      stale=Boolean(newCard&&oldCard?.activeOutcomeId!==newCard.activeOutcomeId&&resolution?.executable===false&&projectionComplete(next));
      reports.H.stale={oldTarget:step.toSlot,newTarget:alternate,stale};
    }
  }catch(error){ reports.H={name:f.H.name,error:String(error)}; }
  put("INV-EGRESS-011",stale,"retarget replaces old outcomes/resources/adapters and old handlers fail closed");

  try{
    const fixture={...f.A,placements:[...f.A.placements,[f.J.independent.sourceSlot,f.J.independent.vehicle]]};
    const independent={...makeMain("12",f.J.independent.vehicle,f.J.independent.requestedTarget,f.J.independent.requestId),fromSlot:f.J.independent.sourceSlot,arrivalSlot:f.J.independent.sourceSlot,originalFromSlot:f.J.independent.sourceSlot};
    const before=build(fixture,[independent]);
    const independentOutcome=(before.reader.canonicalPlan.candidateOutcomes||[]).find(item=>item.vehicleId===f.J.independent.vehicle);
    const independentCard=before.cards.find(item=>item.activeOutcomeId===independentOutcome?.candidateOutcomeId);
    const independentReservation=(before.reader.reservationProjection.reservations||[]).find(item=>item.activeOutcomeId===independentOutcome?.candidateOutcomeId);
    const independentOverlay=allOverlays(before.reader).find(item=>item.activeOutcomeId===independentOutcome?.candidateOutcomeId);
    const release=before.releases.find(row=>(row.sdePhysicalReleaseCandidateOrder||[]).length>1);
    const alternate=(release?.sdePhysicalReleaseCandidateOrder||[]).find(slot=>slot!==release.toSlot);
    if(release&&alternate) ctx.setSdeCanonicalRetargetIntent(release,{mode:"explicit_target",targetSlot:alternate});
    const after=build(fixture,[independent]);
    const afterOutcome=(after.reader.canonicalPlan.candidateOutcomes||[]).find(item=>item.vehicleId===f.J.independent.vehicle);
    const afterCard=after.cards.find(item=>item.activeOutcomeId===afterOutcome?.candidateOutcomeId);
    const afterReservation=(after.reader.reservationProjection.reservations||[]).find(item=>item.activeOutcomeId===afterOutcome?.candidateOutcomeId);
    const afterOverlay=allOverlays(after.reader).find(item=>item.activeOutcomeId===afterOutcome?.candidateOutcomeId);
    reports.J={name:f.J.name,physicalRelation:f.J.physicalRelation,unchanged:Boolean(
      independentOutcome?.candidateOutcomeId===afterOutcome?.candidateOutcomeId
      && independentCard?.canonicalCardId===afterCard?.canonicalCardId
      && independentReservation?.reservationId===afterReservation?.reservationId
      && independentOverlay?.overlayId===afterOverlay?.overlayId
    )};
  }catch(error){ reports.J={name:f.J.name,error:String(error)}; }

  const L=built.L;
  let vnRegression=false;
  try{
    const placements=[["10N","K-BLOCKER"],["10S","K-MAIN"]];
    resetState(placements);
    const main=makeMain("10","K-MAIN","8N","egress-k");
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const release=rows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
    if(release){
      ctx.setSdeCanonicalRetargetIntent(release,{mode:"reject_target",rejectedTarget:release.toSlot});
      const changed=ctx.buildSdePhysicalBlockerGuardMoves([main]);
      vnRegression=changed.some(row=>row.sdePhysicalDependencyRole==="prerequisite"&&row.toSlot!==release.toSlot);
    }
    reports.K={name:f.K.name,physicalRelation:f.K.physicalRelation,vnRegression};
  }catch(error){ reports.K={name:f.K.name,error:String(error)}; }
  const direct=Boolean(L.rows.length===1&&!L.rows[0].sdePhysicalChainId&&L.rows[0].toSlot===f.L.main.requestedTarget&&L.reader?.integrityReport?.status==="PASS");
  put("INV-EGRESS-012",direct&&vnRegression,"direct moves and contextual VN rejection remain intact");

  let recursiveGraphicPath=false;
  try{
    resetState(f.F.placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const assessment=ctx.buildSdeNightPlacementDropAssessment({
      vehicle:f.F.main.vehicle,
      slot:f.F.main.sourceSlot,
      fromSlot:f.F.main.sourceSlot,
      sourceKind:"actual"
    },f.F.main.requestedTarget,{moves:[]});
    const override={
      id:"invariant-recursive-"+f.F.main.requestId,
      vehicle:f.F.main.vehicle,
      fromSlot:f.F.main.sourceSlot,
      originalFromSlot:f.F.main.sourceSlot,
      currentFromSlot:f.F.main.sourceSlot,
      toSlot:f.F.main.requestedTarget,
      createdAt:"2026-07-15T12:00:00.000Z",
      updatedAt:"2026-07-15T12:00:00.000Z",
      hardPhysicalBlocked:Boolean(assessment?.hardPhysicalBlocked),
      canonicalProducer:"graphic_drag_generated_move",
      canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,
      dragRequestId:"invariant-recursive-"+f.F.main.requestId,
      sdeNightPlacementDragIdentity:"invariant-recursive-"+f.F.main.requestId,
      manualPlanId:"manual-graphic-order|invariant-recursive-"+f.F.main.requestId
    };
    appState.sdeNightPlacementManualOverrides={[override.id]:override};
    const staged=ctx.stageSdeCanonicalGraphicDragOrder(override);
    const inspected=staged?.chain;
    recursiveGraphicPath=Boolean(
      assessment?.ok===true
      && assessment?.hardPhysicalBlocked===true
      && staged?.adapter?.ready===true
      && inspected?.ok===true
      && inspected?.reliefKind==="trapped_egress"
      && inspected?.outcomes?.all?.length===5
      && inspected?.cards?.all?.length===5
      && inspected?.reservations?.length===5
      && inspected?.overlays?.active?.length===1
      && inspected?.overlays?.deferred?.length===4
      && inspected?.adapters?.all?.length===5
    );
    reports.M={name:"recursive graphical staging",hardPhysicalBlocked:assessment?.hardPhysicalBlocked===true,reason:inspected?.reason||"",steps:inspected?.outcomes?.all?.length||0};
  }catch(error){ reports.M={name:"recursive graphical staging",error:String(error?.stack||error)}; }
  put("INV-EGRESS-013",recursiveGraphicPath,"recursive graphical drag enters the physical-chain branch and materializes the complete five-step canonical projection");

  let actionableMidChainSuffix=false;
  try{
    const initial=build(f.A);
    const first=initial.releases[0];
    const firstKey=ctx.getSdeMoveActionKey(first);
    const placements=f.A.placements.filter(([slot])=>slot!==first.fromSlot).concat([[first.toSlot,first.vehicle]]);
    const actions={[firstKey]:{
      action:"completed",
      completedAt:"2026-07-15T12:00:00.000Z",
      vehicle:first.vehicle,
      fromSlot:first.fromSlot,
      toSlot:first.toSlot,
      snapshot:JSON.parse(JSON.stringify(first))
    }};
    const suffix=build({...f.A,placements},[],{sdeMoveActions:actions});
    const outcomes=suffix.reader?.canonicalPlan?.candidateOutcomes||[];
    const mainOutcome=outcomes.find(item=>item?.raw?.sdePhysicalDependencyRole==="dependent");
    const recoveryOutcome=outcomes.find(item=>item?.raw?.sdePhysicalDependencyRole==="return");
    const mainCard=suffix.cards.find(card=>card.activeOutcomeId===mainOutcome?.candidateOutcomeId);
    const recoveryCard=suffix.cards.find(card=>card.activeOutcomeId===recoveryOutcome?.candidateOutcomeId);
    const reservations=suffix.reader?.reservationProjection?.reservations||[];
    const activeOverlays=suffix.reader?.graphicProjection?.activeOverlays||[];
    const deferredOverlays=suffix.reader?.graphicProjection?.deferredOverlays||[];
    const mainAdapter=mainCard?suffix.reader?.handlerAdapters?.[mainCard.canonicalCardId]:null;
    const recoveryAdapter=recoveryCard?suffix.reader?.handlerAdapters?.[recoveryCard.canonicalCardId]:null;
    actionableMidChainSuffix=Boolean(
      suffix.rows.length===2
      && suffix.rows.every(row=>ctx.getSdeMoveActionKey(row)!==firstKey)
      && suffix.mains.length===1
      && suffix.recoveries.length===1
      && suffix.releases.length===0
      && mainCard?.status==="actionable"
      && mainCard?.canComplete===true
      && mainAdapter?.ready===true
      && reservations.some(item=>item.activeOutcomeId===mainOutcome?.candidateOutcomeId)
      && activeOverlays.some(item=>item.activeOutcomeId===mainOutcome?.candidateOutcomeId)
      && recoveryCard?.status==="blocked_chain_step"
      && recoveryAdapter?.ready===false
      && reservations.some(item=>item.activeOutcomeId===recoveryOutcome?.candidateOutcomeId)
      && deferredOverlays.some(item=>item.activeOutcomeId===recoveryOutcome?.candidateOutcomeId)
      && !(suffix.reader?.canonicalPlan?.diagnostics||[]).some(item=>item.code==="physically_invalid_candidate"&&item.candidateId===mainOutcome?.actionKey)
    );
    reports.N={name:"mid-chain actionable suffix",completedKey:firstKey,rows:suffix.rows.map(row=>({role:row.sdePhysicalDependencyRole,vehicle:row.vehicle,from:row.fromSlot,to:row.toSlot})),mainStatus:mainCard?.status||"missing",recoveryStatus:recoveryCard?.status||"missing"};
  }catch(error){ reports.N={name:"mid-chain actionable suffix",error:String(error?.stack||error)}; }
  put("INV-EGRESS-014",actionableMidChainSuffix,"after the final completed prerequisite, the fresh unresolved main/recovery suffix remains fully projected and the main is actionable");

  let nullSafeReducedMotion=false;
  const originalMatchMedia=ctx.matchMedia;
  try{
    const checks=[];
    ctx.matchMedia=undefined;
    checks.push(ctx.prefersReducedSdeReleaseMotion()===false);
    ctx.matchMedia={};
    checks.push(ctx.prefersReducedSdeReleaseMotion()===false);
    ctx.matchMedia=()=>null;
    checks.push(ctx.prefersReducedSdeReleaseMotion()===false);
    ctx.matchMedia=()=>undefined;
    checks.push(ctx.prefersReducedSdeReleaseMotion()===false);
    ctx.matchMedia=()=>({});
    checks.push(ctx.prefersReducedSdeReleaseMotion()===false);
    ctx.matchMedia=()=>({matches:"true"});
    checks.push(ctx.prefersReducedSdeReleaseMotion()===false);
    ctx.matchMedia=()=>({matches:false});
    checks.push(ctx.prefersReducedSdeReleaseMotion()===false);
    ctx.matchMedia=()=>({matches:true});
    checks.push(ctx.prefersReducedSdeReleaseMotion()===true);
    nullSafeReducedMotion=checks.every(Boolean);
    reports.O={name:"null-safe reduced motion",result:nullSafeReducedMotion};
  }catch(error){ reports.O={name:"null-safe reduced motion",error:String(error?.stack||error)}; }
  finally{ ctx.matchMedia=originalMatchMedia; }
  put("INV-EGRESS-015",nullSafeReducedMotion,"reduced-motion detection is null-safe when a responsive browser exposes matchMedia without a MediaQueryList result");

  let staleReleaseIdentityReplanned=false;
  try{
    resetState(f.B.placements);
    appState.sdeCanonicalRetargetIntents={};
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const assessment=ctx.buildSdeNightPlacementDropAssessment({
      vehicle:f.B.main.vehicle,
      slot:f.B.main.sourceSlot,
      fromSlot:f.B.main.sourceSlot,
      sourceKind:"actual"
    },f.B.main.requestedTarget,{moves:[]});
    const override={
      id:"invariant-stale-release-"+f.B.main.requestId,
      vehicle:f.B.main.vehicle,
      fromSlot:f.B.main.sourceSlot,
      originalFromSlot:f.B.main.sourceSlot,
      currentFromSlot:f.B.main.sourceSlot,
      toSlot:f.B.main.requestedTarget,
      createdAt:"2026-07-16T20:11:00.000Z",
      updatedAt:"2026-07-16T20:11:00.000Z",
      hardPhysicalBlocked:Boolean(assessment?.hardPhysicalBlocked),
      canonicalProducer:"graphic_drag_generated_move",
      canonicalPurpose:"vehicle-relocation",
      sdeCanonicalGraphicDragOrder:true,
      dragRequestId:"invariant-stale-release-"+f.B.main.requestId,
      sdeNightPlacementDragIdentity:"invariant-stale-release-"+f.B.main.requestId,
      manualPlanId:"manual-graphic-order|invariant-stale-release-"+f.B.main.requestId
    };
    appState.sdeNightPlacementManualOverrides={[override.id]:override};
    const generated=ctx.buildSdeNightPlacementGeneratedMove(override);
    const initialRows=ctx.buildSdePhysicalBlockerGuardMoves([generated]);
    const staleRelease=initialRows.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
    const staleReleaseKey=staleRelease ? ctx.getSdeMoveActionKey(staleRelease) : "";
    if(staleReleaseKey){
      appState.sdeMoveActions[staleReleaseKey]={
        action:"cancelled",
        cancelledAt:"2026-07-16T20:11:00.000Z",
        vehicle:staleRelease.vehicle,
        fromSlot:staleRelease.fromSlot,
        toSlot:staleRelease.toSlot,
        snapshot:JSON.parse(JSON.stringify(staleRelease))
      };
    }
    const staged=ctx.stageSdeCanonicalGraphicDragOrder(override);
    const chain=staged?.chain;
    const replacementRelease=chain?.outcomes?.releases?.[0] || null;
    staleReleaseIdentityReplanned=Boolean(
      assessment?.ok===true
      && assessment?.hardPhysicalBlocked===true
      && staleReleaseKey
      && chain?.ok===true
      && chain?.reliefKind==="trapped_egress"
      && chain?.outcomes?.all?.length===3
      && replacementRelease
      && replacementRelease.actionKey!==staleReleaseKey
      && ctx.normalizeSlot(replacementRelease.targetSlot)!==ctx.normalizeSlot(staleRelease?.toSlot)
      && ctx.normalizeSlot(chain?.outcomes?.main?.targetSlot)===ctx.normalizeSlot(f.B.main.requestedTarget)
      && staged?.reader?.integrityReport?.status==="PASS"
      && staged?.adapter?.ready===true
    );
    reports.P={
      name:"stale cancelled release identity is replanned",
      staleReleaseKey,
      staleTarget:staleRelease?.toSlot||"",
      replacementReleaseKey:replacementRelease?.actionKey||"",
      replacementTarget:replacementRelease?.targetSlot||"",
      requestedTarget:chain?.outcomes?.main?.targetSlot||"",
      steps:chain?.outcomes?.all?.length||0,
      reason:chain?.reason||""
    };
  }catch(error){ reports.P={name:"stale cancelled release identity is replanned",error:String(error?.stack||error)}; }
  put("INV-EGRESS-022",staleReleaseIdentityReplanned,"74-10 5M→6S rejects a stale cancelled 74-12 release identity and materializes one complete replacement chain");

  const failed=globalThis.__egressResults.filter(item=>item.status==="FAIL");
  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-trapped-egress-harness-v1",
    ok:failed.length===0,
    counts:{total:globalThis.__egressResults.length,pass:globalThis.__egressResults.length-failed.length,fail:failed.length},
    results:globalThis.__egressResults,
    scenarios:globalThis.__egressScenarios
  })+"\n");
  process.exitCode=failed.length?1:0;
})()
`);

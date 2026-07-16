"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const baseHarness = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/prerequisite-cancel-replan.json"), "utf8")).fixtures;
const results = [];
const scenarios = {};

function record(id, pass, detail) {
  results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});
}

process.argv[2] = indexPath;
globalThis.__prerequisiteFixtures = fixtures;
globalThis.__prerequisiteResults = results;
globalThis.__prerequisiteScenarios = scenarios;
globalThis.__prerequisiteRecord = record;

eval(prefix + String.raw`
(async()=>{
  const fixtureCatalog=globalThis.__prerequisiteFixtures;
  const reports=globalThis.__prerequisiteScenarios;
  const put=globalThis.__prerequisiteRecord;
  const sanitizeVehicleValue=ctx.sanitizeVehicleValue;
  const normalizeSlot=ctx.normalizeSlot;
  const structuredSafetyAlerts=[];
  const failOnUnexpectedAlert=ctx.alert;
  ctx.alert=message=>{
    const text=String(message||"");
    if(text==="Annulleringen ga ikke én komplett canonical planrevision. Gjeldende plan er beholdt uendret."){
      structuredSafetyAlerts.push(text);
      return;
    }
    return failOnUnexpectedAlert(message);
  };

  const clone=value=>JSON.parse(JSON.stringify(value));
  const currentPlacements=()=>Object.entries(appState.grunnoppstilling||{})
    .filter(([,vehicle])=>sanitizeVehicleValue(vehicle))
    .map(([slot,vehicle])=>[normalizeSlot(slot),sanitizeVehicleValue(vehicle)])
    .sort((left,right)=>left[0].localeCompare(right[0]));
  const allCards=reader=>[
    ...(reader?.cardProjection?.actionableCards||[]),
    ...(reader?.cardProjection?.handlerBlockedCards||[]),
    ...(reader?.cardProjection?.blockedChainCards||[])
  ];
  const allOverlays=reader=>[
    ...(reader?.graphicProjection?.activeOverlays||[]),
    ...(reader?.graphicProjection?.deferredOverlays||[])
  ];
  const operativeRows=rows=>(rows||[]).filter(row=>!row?.sdeCancellationDismissalCard&&!row?.sdeTrappedEgressDiagnosticOnly&&!row?.isSdeCancellationFailClosed);
  const role=(rows,name)=>operativeRows(rows).filter(row=>row?.sdePhysicalDependencyRole===name);
  const stable=value=>ctx.stableStringifySdeCanonicalValue(value);

  function createModalElement(){
    const controls=new Map();
    const control=(name,value="")=>({
      name,value,checked:false,disabled:false,listeners:{},
      addEventListener(type,listener){this.listeners[type]=listener;},
      focus(){},click(){return this.listeners.click?.({target:this});}
    });
    const element=fakeElement();
    element.parentNode=null;
    element.listeners={};
    element.addEventListener=function(type,listener){this.listeners[type]=listener;};
    Object.defineProperty(element,"innerHTML",{
      get(){return this._html||"";},
      set(value){
        this._html=String(value); controls.clear();
        for(const match of this._html.matchAll(/<input[^>]*value="([^"]+)"[^>]*>/g)) controls.set("checkbox:"+match[1],control("checkbox",match[1]));
        controls.set("textarea",control("textarea"));
        if(this._html.includes("data-sde-learning-save")) controls.set("save",control("save"));
        if(this._html.includes("data-sde-learning-cancel")) controls.set("cancel",control("cancel"));
        if(this._html.includes("data-sde-learning-delete")) controls.set("delete",control("delete"));
      }
    });
    element.querySelector=selector=>{
      if(selector==='input[type="checkbox"]') return [...controls.values()].find(item=>item.name==="checkbox")||null;
      if(selector===".sde-learning-modal-comment") return controls.get("textarea")||null;
      if(selector.includes("data-sde-learning-save")) return controls.get("save")||null;
      if(selector.includes("data-sde-learning-cancel")) return controls.get("cancel")||null;
      if(selector.includes("data-sde-learning-delete")) return controls.get("delete")||null;
      return null;
    };
    element.querySelectorAll=selector=>selector.includes(":checked")
      ? [...controls.values()].filter(item=>item.name==="checkbox"&&item.checked)
      : [];
    element.controls=controls;
    return element;
  }

  const body=fakeElement();
  body.appendChild=child=>{child.parentNode=body;body.children.push(child);return child;};
  body.removeChild=child=>{body.children=body.children.filter(item=>item!==child);child.parentNode=null;return child;};
  ctx.document.body=body;
  ctx.document.createElement=()=>createModalElement();

  function setRenderedMoves(moves){
    ctx.__prerequisiteRenderedData={moves:Array.isArray(moves)?moves:[]};
    vm.runInContext("sdeShiftLastRenderedData=__prerequisiteRenderedData",ctx);
  }

  function resetRuntime(placements){
    resetState(placements);
    appState.sdeCanonicalRetargetIntents={};
    appState.sdeMoveLearningLog=[];
    appState.sdeDeletedMoveCards={};
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    delete appState.sdeResetSnapshot;
    body.children=[];
    ctx.sdeMoveActionPendingKey="";
    ctx.sdeMoveLearningReasonModal=null;
    ctx.persist=()=>{};
    ctx.refreshSdeAfterMoveAction=()=>{};
    ctx.renderSdeSkiftebevegelser=()=>{};
    setRenderedMoves([]);
    vm.runInContext(
      "sdeNightPlacementBlockedMoveRequest=null;"+
      "sdeNightPlacementDragPayload=null;"+
      "sdeNightPlacementSelectedSlot='';"+
      "sdeNightPlacementDropMessage=null;"+
      "sdeProductionReaderFallbackError=null;",
      ctx
    );
  }

  function runtimeSnapshot(rows){
    const placements=currentPlacements();
    const result=snapshot(rows,placements,clone(appState.sdeMoveActions||{}));
    result.runtimeState.activeAuthorities=clone(appState.sdeActiveMoveOutcomes||{});
    result.runtimeState.physicalReleaseReplans=clone(appState.sdePhysicalReleaseReplans||{});
    result.runtimeState.canonicalRetargetIntents=clone(appState.sdeCanonicalRetargetIntents||{});
    result.runtimeState.nightPlacementManualOverrides=clone(appState.sdeNightPlacementManualOverrides||{});
    result.runtimeState.blockedMoveRequest=vm.runInContext("sdeNightPlacementBlockedMoveRequest",ctx);
    return result;
  }

  function readerFor(rows){
    return ctx.buildSdeCanonicalProductionReader(runtimeSnapshot(rows));
  }

  function finalProjection(){
    const rows=ctx.buildSdeFinalCardRowsForData({moves:[]});
    let reader=null,error="";
    try{reader=readerFor(rows);}catch(caught){error=String(caught?.stack||caught);}
    return {rows,reader,error,cards:reader?allCards(reader):[],overlays:reader?allOverlays(reader):[]};
  }

  function completeProjection(projection){
    const rows=operativeRows(projection.rows);
    const releases=role(rows,"prerequisite");
    const mains=role(rows,"dependent");
    const recoveries=role(rows,"return");
    const outcomes=(projection.reader?.canonicalPlan?.candidateOutcomes||[]).filter(outcome=>outcome.status!=="exiting"&&outcome.status!=="cancelled");
    const reservations=projection.reader?.reservationProjection?.reservations||[];
    const cards=projection.cards||[];
    const overlays=projection.overlays||[];
    const adapters=projection.reader?.handlerAdapters||{};
    return Boolean(
      projection.reader?.integrityReport?.status==="PASS"
      && releases.length>=1
      && mains.length===1
      && recoveries.length===releases.length
      && outcomes.length===rows.length
      && cards.length===rows.length
      && reservations.length===rows.length
      && overlays.length===rows.length
      && Object.keys(adapters).length===rows.length+(projection.reader?.cardProjection?.exitingCards||[]).length
      && outcomes.every(outcome=>Array.isArray(outcome.routeResources)&&outcome.routeResources.length)
      && recoveries.every(recovery=>releases.some(release=>release.vehicle===recovery.vehicle&&release.fromSlot===recovery.toSlot&&release.toSlot===recovery.fromSlot))
    );
  }

  function applyReportedDrag(fixture=fixtureCatalog.A){
    resetRuntime(fixture.placements);
    const payload={vehicle:fixture.main.vehicle,slot:fixture.main.sourceSlot,fromSlot:fixture.main.sourceSlot,sourceKind:"actual"};
    const assessment=ctx.buildSdeNightPlacementDropAssessment(payload,fixture.main.requestedTarget,{moves:[]});
    const applied=ctx.applySdeNightPlacementDragOverride(payload,fixture.main.requestedTarget);
    const rows=ctx.buildSdeShiftCardMoveCandidates({moves:[]},{reconcileActive:false});
    const reader=readerFor(rows);
    const releases=role(rows,"prerequisite");
    const release=releases.find(row=>row.vehicle===fixture.expectedInitialBlocker.vehicle&&row.fromSlot===fixture.expectedInitialBlocker.sourceSlot)||releases[0]||null;
    const main=role(rows,"dependent")[0]||null;
    const recovery=role(rows,"return")[0]||null;
    const releaseCard=allCards(reader).find(card=>card.activeOutcomeId===(reader.canonicalPlan.candidateOutcomes||[]).find(outcome=>outcome.actionKey===ctx.getSdeMoveActionKey(release))?.candidateOutcomeId)||null;
    const adapter=releaseCard?reader.handlerAdapters?.[releaseCard.canonicalCardId]:null;
    setRenderedMoves(rows);
    return {fixture,payload,assessment,applied,rows,reader,release,main,recovery,releaseCard,adapter};
  }

  async function waitForModal(){
    for(let attempt=0;attempt<12;attempt+=1){
      const modal=ctx.sdeMoveLearningReasonModal;
      if(modal?.backdrop?.parentNode) return modal;
      await Promise.resolve();
    }
    return null;
  }

  function adapterContext(initial){
    const card=initial.releaseCard||{};
    const adapter=initial.adapter||{};
    return {
      canonicalCardId:card.canonicalCardId,
      planRevision:initial.reader?.planRevision,
      executionKey:adapter.executionKey,
      relevantRevision:adapter.relevantRevision,
      activeOutcomeId:card.activeOutcomeId,
      obligationId:card.obligationId,
      stepId:card.stepId,
      vehicleId:card.vehicleId,
      sourceSlot:card.sourceSlot,
      targetSlot:card.targetSlot,
      actionKey:adapter.actionKey||ctx.getSdeMoveActionKey(initial.release),
      canonicalCanDelete:adapter.canDelete===true
    };
  }

  function reacquireCancellationAction(initial){
    const release=initial?.release||null;
    const actionKey=release?ctx.getSdeMoveActionKey(release):"";
    const currentReader=initial?.reader||readerFor(initial?.rows||[]);
    const currentOutcome=(currentReader?.canonicalPlan?.candidateOutcomes||[])
      .find(outcome=>String(outcome?.actionKey||"")===actionKey)||null;
    const currentCard=allCards(currentReader)
      .find(card=>card?.activeOutcomeId===currentOutcome?.candidateOutcomeId)||null;
    const currentAdapter=currentCard
      ? currentReader?.handlerAdapters?.[currentCard.canonicalCardId]||null
      : null;
    const renderedCard=initial?.releaseCard||null;
    const renderedAdapter=initial?.adapter||null;
    const renderedActionKeys=(ctx.__prerequisiteRenderedData?.moves||[]).map(ctx.getSdeMoveActionKey);
    const errors=[];
    if(Object.prototype.hasOwnProperty.call(initial||{},"applied")&&initial.applied!==true) errors.push("drag_not_applied");
    if(!release||!actionKey) errors.push("current_action_missing");
    if(!currentOutcome) errors.push("current_outcome_missing");
    if(!currentCard) errors.push("current_card_missing");
    if(!currentAdapter) errors.push("current_adapter_missing");
    if(!renderedActionKeys.includes(actionKey)) errors.push("current_action_not_rendered");
    if(String(currentReader?.planRevision||"")!==String(initial?.reader?.planRevision||"")) errors.push("plan_revision_changed");
    if(String(currentCard?.obligationId||"")!==String(renderedCard?.obligationId||"")) errors.push("obligation_changed");
    if(String(currentCard?.stepId||"")!==String(renderedCard?.stepId||"")) errors.push("step_changed");
    if(String(currentCard?.activeOutcomeId||"")!==String(renderedCard?.activeOutcomeId||"")) errors.push("active_outcome_changed");
    if(String(currentAdapter?.executionKey||"")!==String(renderedAdapter?.executionKey||"")) errors.push("execution_key_changed");
    if(currentCard?.status!=="actionable") errors.push("current_card_not_actionable");
    if(currentAdapter?.ready!==true) errors.push("current_adapter_not_ready");
    if(currentAdapter?.canCancel!==true) errors.push("current_cancel_capability_missing");
    return {
      ok:errors.length===0,
      errors,
      release,
      releaseCard:currentCard,
      adapter:currentAdapter,
      reader:currentReader,
      actionKey,
      identity:{
        planRevision:String(currentReader?.planRevision||""),
        obligationId:String(currentCard?.obligationId||""),
        stepId:String(currentCard?.stepId||""),
        activeOutcomeId:String(currentCard?.activeOutcomeId||""),
        executionKey:String(currentAdapter?.executionKey||""),
        canCancel:currentAdapter?.canCancel===true,
        canRetarget:currentAdapter?.canRetarget===true
      }
    };
  }

  async function cancelInitial(initial,{mode="save",beforeAction=null,comment="prerequisite cancel fixture"}={}){
    const current=reacquireCancellationAction(initial);
    const key=current.actionKey;
    const alertStart=structuredSafetyAlerts.length;
    const before=stable({
      actions:appState.sdeMoveActions,
      replans:appState.sdePhysicalReleaseReplans,
      retarget:appState.sdeCanonicalRetargetIntents,
      overrides:appState.sdeNightPlacementManualOverrides,
      authorities:appState.sdeActiveMoveOutcomes
    });
    if(!current.ok){
      return {
        key,
        modal:null,
        before,
        after:before,
        projection:finalProjection(),
        actionRecord:{},
        structuredSafetyAlerts:[],
        structuredFailure:{
          code:"current_prerequisite_cancel_action_unavailable",
          errors:current.errors,
          identity:current.identity
        }
      };
    }
    const pending=ctx.handleSdeShiftMoveAction(encodeURIComponent(key),"cancelled",adapterContext(current));
    const modal=await waitForModal();
    if(typeof beforeAction==="function") beforeAction(initial,modal);
    if(mode==="abort") modal?.backdrop?.controls.get("cancel")?.click();
    else if(mode==="delete") modal?.backdrop?.controls.get("delete")?.click();
    else{
      const reason=modal?.backdrop?.controls.get("checkbox:wrong_track");
      if(reason) reason.checked=true;
      const textarea=modal?.backdrop?.controls.get("textarea");
      if(textarea) textarea.value=comment;
      modal?.backdrop?.controls.get("save")?.click();
    }
    await pending;
    const after=stable({
      actions:appState.sdeMoveActions,
      replans:appState.sdePhysicalReleaseReplans,
      retarget:appState.sdeCanonicalRetargetIntents,
      overrides:appState.sdeNightPlacementManualOverrides,
      authorities:appState.sdeActiveMoveOutcomes
    });
    return {key,modal,before,after,projection:finalProjection(),actionRecord:ctx.getSdeMoveActionRecord(key)||{},structuredSafetyAlerts:structuredSafetyAlerts.slice(alertStart)};
  }

  function fillEveryEmptySlot(label){
    vm.runInContext("inputSlots",ctx).map(normalizeSlot).filter(Boolean).forEach((slot,index)=>{
      if(slot!=="VN"&&!sanitizeVehicleValue(appState.grunnoppstilling[slot])) appState.grunnoppstilling[slot]=label+"-"+index;
    });
  }

  function projectionSummary(projection){
    const cards=projection.cards||[];
    return {
      integrity:projection.reader?.integrityReport?.status||"ERROR",
      error:projection.error,
      activeOutcomes:projection.reader?.canonicalPlan?.activeOutcomes?.length||0,
      operativeOutcomes:(projection.reader?.canonicalPlan?.candidateOutcomes||[]).filter(outcome=>outcome.status!=="exiting"&&outcome.status!=="cancelled").length,
      cards:cards.map(card=>({vehicle:card.vehicleId,source:card.sourceSlot,target:card.targetSlot,status:card.status,role:card.raw?.sdePhysicalDependencyRole})),
      exiting:(projection.reader?.cardProjection?.exitingCards||[]).map(card=>({vehicle:card.vehicleId,source:card.sourceSlot,target:card.targetSlot,status:card.status})),
      reservations:projection.reader?.reservationProjection?.reservations?.length||0,
      overlays:projection.overlays?.length||0,
      adapters:Object.keys(projection.reader?.handlerAdapters||{}).length,
      diagnostics:[
        ...(projection.reader?.canonicalPlan?.diagnostics||[]),
        ...(projection.reader?.cardProjection?.diagnostics||[]),
        ...(projection.reader?.graphicProjection?.unresolvedDiagnostics||[])
      ]
    };
  }

  const abortInitial=applyReportedDrag();
  const abortResult=await cancelInitial(abortInitial,{mode:"abort"});
  if(abortResult.structuredFailure){
    reports.structuredFailure=abortResult.structuredFailure;
    ["INV-EGRESS-016","INV-EGRESS-017","INV-EGRESS-018","INV-EGRESS-019","INV-EGRESS-020","INV-EGRESS-021"]
      .forEach(id=>put(id,false,"structured prerequisite action precondition failed: "+abortResult.structuredFailure.errors.join(",")));
    reports.contracts={
      "PREREQUISITE-CANCEL-REPLANS-CHAIN":false,
      "PREREQUISITE-CANCEL-ALTERNATE-MAIN-TARGET":false,
      "PREREQUISITE-CANCEL-NO-SOLUTION-IS-SCOPED":false,
      "POST-CANCEL-GRAPHICAL-DRAG-CONTINUITY":false
    };
    return;
  }
  reports.A_ABORT={modal:Boolean(abortResult.modal),unchanged:abortResult.before===abortResult.after,summary:projectionSummary(abortResult.projection)};

  const initialA=applyReportedDrag();
  const oldMainObligation=initialA.reader.canonicalPlan.candidateOutcomes.find(outcome=>outcome.actionKey===ctx.getSdeMoveActionKey(initialA.main))?.obligationId||"";
  const oldReleaseTarget=initialA.release?.toSlot||"";
  const oldReleaseChain=initialA.release?.sdePhysicalChainId||"";
  const oldAdapterDescriptor=clone(initialA.adapter?.executionDescriptor||{});
  const savedA=await cancelInitial(initialA,{comment:"fixture A deterministic cancellation"});
  const operativeA=operativeRows(savedA.projection.rows);
  const replacementMainA=role(operativeA,"dependent")[0]||null;
  const replacementReleaseA=role(operativeA,"prerequisite")[0]||null;
  const replacementOutcomeA=savedA.projection.reader?.canonicalPlan?.candidateOutcomes?.find(outcome=>outcome.actionKey===ctx.getSdeMoveActionKey(replacementMainA))||null;
  const replacementCardA=savedA.projection.cards.find(card=>card.vehicleId===fixtureCatalog.A.main.vehicle&&card.raw?.sdePhysicalDependencyRole==="dependent")||null;
  const replacementAdapterA=replacementCardA?savedA.projection.reader?.handlerAdapters?.[replacementCardA.canonicalCardId]:null;
  const staleResolution=ctx.resolveSdeCanonicalExecutableAction({
    renderedDescriptor:oldAdapterDescriptor,
    currentDescriptor:replacementAdapterA?.executionDescriptor||null,
    currentCard:replacementCardA,
    currentHandlerDescriptor:replacementAdapterA,
    currentCanonicalPlan:savedA.projection.reader?.canonicalPlan,
    currentCardProjection:savedA.projection.reader?.cardProjection,
    currentReservationProjection:savedA.projection.reader?.reservationProjection,
    currentGraphicProjection:savedA.projection.reader?.graphicProjection,
    actionType:"completed"
  });
  const parentOverrideA=Object.values(appState.sdeNightPlacementManualOverrides||{}).find(item=>item?.vehicle===fixtureCatalog.A.main.vehicle)||null;
  const actionUiA=ctx.getSdePhysicalReleaseCancelledUiState({...initialA.release,sdeCancellationDismissalCard:true},Date.parse(savedA.actionRecord.cancelledAt||savedA.actionRecord.time||""));
  reports.A={
    initial:{applied:initialA.applied,assessmentOk:initialA.assessment?.ok===true,releaseVehicle:initialA.release?.vehicle,releaseTarget:oldReleaseTarget,mainTarget:initialA.main?.toSlot,complete:completeProjection({rows:initialA.rows,reader:initialA.reader,cards:allCards(initialA.reader),overlays:allOverlays(initialA.reader)})},
    after:projectionSummary(savedA.projection),
    replacement:{releaseTarget:replacementReleaseA?.toSlot||"",mainTarget:replacementMainA?.toSlot||"",mainObligation:replacementOutcomeA?.obligationId||"",complete:completeProjection(savedA.projection)},
    parentIntent:Boolean(parentOverrideA),
    oldMainObligation,
    staleHandler:staleResolution?.executable===false,
    lifecycle:{managed:actionUiA.managed,holdMs:actionUiA.holdMs,exitMs:actionUiA.exitMs,totalMs:actionUiA.totalMs},
    actionRecord:savedA.actionRecord,
    structuredSafetyAlerts:savedA.structuredSafetyAlerts
  };

  async function alternateMainRun(){
    const initial=applyReportedDrag();
    const result=await cancelInitial(initial,{beforeAction:()=>{
      const [slot,vehicle]=fixtureCatalog.B.occupyOriginalTargetBeforeSave;
      appState.grunnoppstilling[slot]=vehicle;
    },comment:"fixture B alternate main target"});
    const main=role(result.projection.rows,"dependent")[0]||null;
    return {initial,result,main,summary:projectionSummary(result.projection),fingerprint:stable({mainTarget:main?.toSlot||"",roles:operativeRows(result.projection.rows).map(row=>[row.sdePhysicalDependencyRole,row.vehicle,row.fromSlot,row.toSlot])})};
  }
  const b1=await alternateMainRun();
  const b2=await alternateMainRun();
  reports.B={
    originalTarget:fixtureCatalog.A.main.requestedTarget,
    replacementTarget:b1.main?.toSlot||"",
    complete:completeProjection(b1.result.projection),
    visible:Boolean(b1.result.projection.cards.find(card=>card.vehicleId===fixtureCatalog.A.main.vehicle&&card.targetSlot===b1.main?.toSlot)),
    historicalTarget:b1.main?.sdePrerequisiteCancelOriginalRequestedTarget||b1.main?.sdeCanonicalRetargetOriginalTarget||"",
    targetSelectionSource:b1.main?.targetSelectionSource||b1.main?.sdePrerequisiteCancelTargetSelectionSource||"",
    supersedes:b1.main?.sdePrerequisiteCancelSupersedesIntentId||"",
    deterministic:b1.fingerprint===b2.fingerprint,
    fingerprint:b1.fingerprint,
    summary:b1.summary
  };

  const initialC=applyReportedDrag();
  const savedC=await cancelInitial(initialC,{beforeAction:()=>fillEveryEmptySlot("C-FULL"),comment:"fixture C no safe replacement"});
  const summaryC=projectionSummary(savedC.projection);
  const diagnosticC=summaryC.diagnostics.find(item=>String(item?.code||item?.diagnosticType||item?.sdeCanonicalRetargetDiagnostic||"").includes("prerequisite_cancelled_no_safe_replacement"))||null;
  reports.C={summary:summaryC,diagnostic:diagnosticC,scoped:Boolean(diagnosticC&&diagnosticC.mainVehicleId&&diagnosticC.originalRequestedTarget),noOrphanRecovery:role(savedC.projection.rows,"return").length===0,structuredSafetyAlerts:savedC.structuredSafetyAlerts};

  function applyIndependent(independent){
    appState.grunnoppstilling[independent.sourceSlot]=independent.vehicle;
    if(independent.targetSlot==="VN") delete appState.grunnoppstilling.VN;
    const payload={vehicle:independent.vehicle,slot:independent.sourceSlot,fromSlot:independent.sourceSlot,sourceKind:"actual"};
    setRenderedMoves([]);
    const assessment=ctx.buildSdeNightPlacementDropAssessment(payload,independent.targetSlot,{moves:[]});
    const applied=ctx.applySdeNightPlacementDragOverride(payload,independent.targetSlot);
    const fallbackError=vm.runInContext("Boolean(sdeProductionReaderFallbackError)",ctx);
    const canonicalMode=ctx.getSdeProductionReaderMode(ctx.location,{technicalFailure:fallbackError})==="canonical";
    const projection=finalProjection();
    const outcomes=(projection.reader?.canonicalPlan?.activeOutcomes||[]).filter(item=>item?.vehicleId===independent.vehicle);
    const cards=projection.cards.filter(item=>item?.vehicleId===independent.vehicle);
    const reservations=(projection.reader?.reservationProjection?.reservations||[]).filter(item=>item?.vehicleId===independent.vehicle);
    const overlays=projection.overlays.filter(item=>item?.vehicleId===independent.vehicle);
    const adapters=cards.map(card=>projection.reader?.handlerAdapters?.[card.canonicalCardId]).filter(Boolean);
    const complete=Boolean(
      projection.reader?.integrityReport?.status==="PASS"
      && outcomes.length===1
      && cards.length===1
      && reservations.length===1
      && overlays.length===1
      && adapters.length===1
      && adapters[0].ready===true
    );
    return {assessment,applied,canonicalMode,fallbackError,override:Object.values(appState.sdeNightPlacementManualOverrides||{}).find(item=>item?.vehicle===independent.vehicle)||null,projection,complete,projectionIntegrity:projection.reader?.integrityReport?.status||"ERROR",adapterReady:adapters[0]?.ready===true,adapterStatus:String(adapters[0]?.executionResolution?.status||""),counts:{outcomes:outcomes.length,cards:cards.length,reservations:reservations.length,overlays:overlays.length,adapters:adapters.length}};
  }

  function preparePositiveIndependentFixture(fixture){
    const independent=fixture.independent;
    const preconditions=fixture.positivePhysicalPreconditions||{};
    (preconditions.mustBeEmpty||[]).forEach(slot=>{delete appState.grunnoppstilling[normalizeSlot(slot)];});
    appState.grunnoppstilling[normalizeSlot(independent.sourceSlot)]=sanitizeVehicleValue(independent.vehicle);
    const payload={vehicle:independent.vehicle,slot:independent.sourceSlot,fromSlot:independent.sourceSlot,sourceKind:"actual"};
    const row={vehicle:independent.vehicle,fromSlot:independent.sourceSlot,arrivalSlot:independent.sourceSlot,recommendedSlot:independent.targetSlot,toSlot:independent.targetSlot};
    const physical=ctx.getSdeHardPhysicalBlockStateForMove(row);
    const routeSafe=ctx.isSdeSafePhysicalBlockerReleaseMove(independent.vehicle,independent.sourceSlot,independent.targetSlot);
    const assessment=ctx.buildSdeNightPlacementDropAssessment(payload,independent.targetSlot,{moves:[]});
    const projection=finalProjection();
    const mustBeEmpty=(preconditions.mustBeEmpty||[]).map(normalizeSlot).filter(Boolean);
    const occupiedMustBeEmpty=mustBeEmpty.filter(slot=>sanitizeVehicleValue(appState.grunnoppstilling[slot]));
    const requiredResources=(preconditions.requiredRouteResources||[]).map(normalizeSlot).filter(Boolean);
    const occupiedRequiredResources=requiredResources.filter(slot=>sanitizeVehicleValue(appState.grunnoppstilling[slot]));
    const relevantReservations=(projection.reader?.reservationProjection?.reservations||[]).filter(item=>
      normalizeSlot(item?.targetSlot)===normalizeSlot(independent.targetSlot)
      || (item?.routeResources||[]).some(resource=>requiredResources.includes(normalizeSlot(resource)))
    );
    const sourceVehicle=sanitizeVehicleValue(appState.grunnoppstilling[normalizeSlot(independent.sourceSlot)]);
    const targetVehicle=sanitizeVehicleValue(appState.grunnoppstilling[normalizeSlot(independent.targetSlot)]);
    const cancellationVehicles=new Set([
      fixtureCatalog.A.main.vehicle,
      fixtureCatalog.A.expectedInitialBlocker.vehicle,
      ...fixtureCatalog.A.placements.map(([,vehicle])=>vehicle)
    ].map(sanitizeVehicleValue));
    const independentFromCancellation=!cancellationVehicles.has(sanitizeVehicleValue(independent.vehicle));
    const valid=Boolean(
      sourceVehicle===sanitizeVehicleValue(independent.vehicle)
      && !targetVehicle
      && occupiedMustBeEmpty.length===0
      && occupiedRequiredResources.length===0
      && relevantReservations.length===0
      && physical?.hardBlocked===false
      && routeSafe===true
      && assessment?.ok===true
      && assessment?.hardPhysicalBlocked!==true
      && independentFromCancellation
    );
    const report={valid,sourceVehicle,targetVehicle:targetVehicle||"",mustBeEmpty,occupiedMustBeEmpty,occupiedRequiredResources,relevantReservations:relevantReservations.length,physicalHardBlocked:Boolean(physical?.hardBlocked),physicalReason:String(physical?.reason||""),routeSafe,assessmentOk:assessment?.ok===true,assessmentHardBlocked:assessment?.hardPhysicalBlocked===true,independentFromCancellation,sourceSlot:independent.sourceSlot,targetSlot:independent.targetSlot,requiredResources};
    if(!valid) throw new Error("fixture invalid: "+stable(report));
    return report;
  }

  async function runNegativePhysicalConflict(fixture){
    const initial=applyReportedDrag();
    await cancelInitial(initial,{beforeAction:()=>fillEveryEmptySlot("E-NEGATIVE-FULL"),comment:"fixture E negative physical conflict"});
    const independent=fixture.independent;
    appState.grunnoppstilling[independent.sourceSlot]=independent.vehicle;
    delete appState.grunnoppstilling[independent.targetSlot];
    (fixture.negativePhysicalConflict?.occupied||[]).forEach(([slot,vehicle])=>{appState.grunnoppstilling[normalizeSlot(slot)]=sanitizeVehicleValue(vehicle);});
    const payload={vehicle:independent.vehicle,slot:independent.sourceSlot,fromSlot:independent.sourceSlot,sourceKind:"actual"};
    const assessment=ctx.buildSdeNightPlacementDropAssessment(payload,independent.targetSlot,{moves:[]});
    const physical=ctx.getSdeHardPhysicalBlockStateForMove({vehicle:independent.vehicle,fromSlot:independent.sourceSlot,arrivalSlot:independent.sourceSlot,recommendedSlot:independent.targetSlot,toSlot:independent.targetSlot});
    const before=stable({overrides:appState.sdeNightPlacementManualOverrides,authorities:appState.sdeActiveMoveOutcomes,actions:appState.sdeMoveActions});
    let persistCalls=0;
    ctx.persist=()=>{persistCalls+=1;};
    const applyResult=ctx.applySdeNightPlacementDragOverride(payload,independent.targetSlot);
    const after=stable({overrides:appState.sdeNightPlacementManualOverrides,authorities:appState.sdeActiveMoveOutcomes,actions:appState.sdeMoveActions});
    const projection=finalProjection();
    const outcomes=(projection.reader?.canonicalPlan?.activeOutcomes||[]).filter(item=>item?.vehicleId===independent.vehicle);
    const cards=projection.cards.filter(item=>item?.vehicleId===independent.vehicle);
    const reservations=(projection.reader?.reservationProjection?.reservations||[]).filter(item=>item?.vehicleId===independent.vehicle);
    const overlays=projection.overlays.filter(item=>item?.vehicleId===independent.vehicle);
    const adapterCount=cards.map(card=>projection.reader?.handlerAdapters?.[card.canonicalCardId]).filter(Boolean).length;
    const blockerSlots=(physical?.blockers||[]).map(item=>normalizeSlot(item?.slot)).filter(Boolean);
    const noOperativeProjection=outcomes.length===0&&cards.length===0&&reservations.length===0&&overlays.length===0&&adapterCount===0;
    const rejected=applyResult===false||noOperativeProjection;
    const physicalDiagnostic=physical?.hardBlocked===true&&blockerSlots.includes("12N")&&blockerSlots.includes("VS")&&/12N|VS/.test(String(physical?.reason||""));
    const safetyPass=Boolean(
      rejected
      && physicalDiagnostic
      && noOperativeProjection
      && before===after
      && persistCalls===0
    );
    return {safetyPass,rejected,physicalDiagnostic,assessmentOk:assessment?.ok===true,assessmentHardBlocked:assessment?.hardPhysicalBlocked===true,assessmentMessage:String(assessment?.message||""),assessmentConflicts:assessment?.conflicts||[],applyResult,physicalHardBlocked:Boolean(physical?.hardBlocked),physicalReason:String(physical?.reason||assessment?.message||""),blockerSlots,counts:{outcomes:outcomes.length,cards:cards.length,reservations:reservations.length,overlays:overlays.length,adapters:adapterCount},stateUnchanged:before===after,persistCalls};
  }

  const initialD=applyReportedDrag();
  await cancelInitial(initialD,{comment:"fixture D replacement before independent drag"});
  const independentAfterA=applyIndependent(fixtureCatalog.D.independent);
  reports.D={assessmentOk:independentAfterA.assessment?.ok===true,applied:independentAfterA.applied===true,canonicalMode:independentAfterA.canonicalMode,fallbackError:independentAfterA.fallbackError,override:Boolean(independentAfterA.override)};

  const initialE=applyReportedDrag();
  await cancelInitial(initialE,{beforeAction:()=>fillEveryEmptySlot("E-FULL"),comment:"fixture E diagnostic before independent drag"});
  const positivePhysicalPrecondition=preparePositiveIndependentFixture(fixtureCatalog.E);
  const independentAfterC=applyIndependent(fixtureCatalog.E.independent);
  const negativePhysicalConflict=await runNegativePhysicalConflict(fixtureCatalog.E);
  reports.E={positivePhysicalPrecondition,assessmentOk:independentAfterC.assessment?.ok===true,assessmentHardBlocked:independentAfterC.assessment?.hardPhysicalBlocked===true,applied:independentAfterC.applied===true,canonicalMode:independentAfterC.canonicalMode,fallbackError:independentAfterC.fallbackError,override:Boolean(independentAfterC.override),complete:independentAfterC.complete,projectionIntegrity:independentAfterC.projectionIntegrity,adapterReady:independentAfterC.adapterReady,adapterStatus:independentAfterC.adapterStatus,counts:independentAfterC.counts,negativePhysicalConflict};

  const initialF=applyReportedDrag();
  const firstF=await cancelInitial(initialF,{comment:"fixture F first rejection"});
  const firstReplacementRows=operativeRows(firstF.projection.rows);
  const secondRelease=role(firstReplacementRows,"prerequisite")[0]||null;
  let secondF=null;
  if(secondRelease){
    const secondReader=readerFor(firstF.projection.rows);
    const outcome=secondReader.canonicalPlan.candidateOutcomes.find(item=>item.actionKey===ctx.getSdeMoveActionKey(secondRelease));
    const card=allCards(secondReader).find(item=>item.activeOutcomeId===outcome?.candidateOutcomeId)||null;
    const adapter=card?secondReader.handlerAdapters?.[card.canonicalCardId]:null;
    setRenderedMoves(firstF.projection.rows);
    secondF=await cancelInitial({release:secondRelease,releaseCard:card,adapter,reader:secondReader},{comment:"fixture F second rejection"});
  }
  const repeatedTargets=[initialF.release?.toSlot,secondRelease?.toSlot,role(secondF?.projection?.rows||[],"prerequisite")[0]?.toSlot].filter(Boolean);
  reports.F={targets:repeatedTargets,unique:new Set(repeatedTargets).size===repeatedTargets.length,terminated:Boolean(secondF&&(completeProjection(secondF.projection)||projectionSummary(secondF.projection).activeOutcomes===0))};

  const initialG=applyReportedDrag();
  const occupiedG=fixtureCatalog.G.occupyNextTemporaryTargetBeforeSave;
  const savedG=await cancelInitial(initialG,{beforeAction:()=>{appState.grunnoppstilling[occupiedG[0]]=occupiedG[1];},comment:"fixture G fresh actual"});
  const replacementG=role(savedG.projection.rows,"prerequisite")[0]||null;
  reports.G={occupiedTarget:occupiedG[0],replacementTarget:replacementG?.toSlot||"",fresh:Boolean(replacementG&&replacementG.toSlot!==occupiedG[0]&&replacementG.toSlot!==initialG.release?.toSlot)};

  resetRuntime(fixtureCatalog.H.placements);
  const mainH={...makeMain("12",fixtureCatalog.H.main.vehicle,fixtureCatalog.H.main.requestedTarget,fixtureCatalog.H.main.requestId),fromSlot:fixtureCatalog.H.main.sourceSlot,arrivalSlot:fixtureCatalog.H.main.sourceSlot,originalFromSlot:fixtureCatalog.H.main.sourceSlot};
  setRenderedMoves([mainH]);
  const pendingH=ctx.handleSdeShiftMoveAction(encodeURIComponent(ctx.getSdeMoveActionKey(mainH)),"cancelled",{});
  const modalH=await waitForModal();
  modalH?.backdrop?.controls.get("checkbox:wrong_track")&&(modalH.backdrop.controls.get("checkbox:wrong_track").checked=true);
  modalH?.backdrop?.controls.get("save")?.click();
  await pendingH;
  const recordH=ctx.getSdeMoveActionRecord(ctx.getSdeMoveActionKey(mainH))||{};
  reports.H={mainCancelled:recordH.action==="cancelled",prerequisiteReplan:recordH.prerequisiteCancellation===true||Boolean(recordH.rejectedChainFingerprint)};

  resetRuntime(fixtureCatalog.H.placements);
  const deleteRow={...makeMain("12","I-DELETE","9","delete-i"),fromSlot:"12S",arrivalSlot:"12S",originalFromSlot:"12S"};
  appState.grunnoppstilling["12S"]="I-DELETE";
  setRenderedMoves([deleteRow]);
  const beforeReplanI=stable(appState.sdePhysicalReleaseReplans||{});
  const deleteKey=ctx.getSdeMoveActionKey(deleteRow);
  const pendingI=ctx.handleSdeShiftMoveAction(encodeURIComponent(deleteKey),"cancelled",{canonicalCardId:"delete-i",canonicalCanDelete:true});
  const modalI=await waitForModal();
  modalI?.backdrop?.controls.get("delete")?.click();
  await pendingI;
  reports.I={deleted:Object.keys(appState.sdeDeletedMoveCards||{}).length>0,noCancellation:!ctx.getSdeMoveActionRecord(deleteKey),noRejection:beforeReplanI===stable(appState.sdePhysicalReleaseReplans||{})};

  const sameTargetComplete=Boolean(
    reports.A.initial.applied
    && reports.A.initial.releaseVehicle===fixtureCatalog.A.expectedInitialBlocker.vehicle
    && reports.A.replacement.complete
    && reports.A.replacement.mainTarget===fixtureCatalog.A.main.requestedTarget
    && reports.A.replacement.releaseTarget
    && reports.A.replacement.releaseTarget!==oldReleaseTarget
  );
  const parentPreserved=Boolean(
    reports.A.parentIntent
    && reports.A.replacement.mainObligation===reports.A.oldMainObligation
    && reports.A.actionRecord?.prerequisiteCancellation===true
    && reports.A.actionRecord?.mainCancellation!==true
    && reports.B.historicalTarget===fixtureCatalog.A.main.requestedTarget
  );
  const atomic=Boolean(
    reports.A.replacement.complete
    && reports.A.structuredSafetyAlerts.length===0
    && reports.A.after.integrity==="PASS"
    && reports.A.after.operativeOutcomes===3
    && reports.A.after.reservations===3
    && reports.A.after.overlays===3
    && reports.A.after.adapters>=3
    && !reports.A.after.diagnostics.some(item=>String(item?.explanation||item?.message||"").includes("release=0"))
  );
  const stale=Boolean(
    reports.A.staleHandler
    && reports.A.after.exiting.length===1
    && reports.A.lifecycle.managed
    && reports.A.lifecycle.holdMs===5000
    && reports.A.lifecycle.exitMs===2000
    && reports.A.replacement.complete
    && Boolean(reports.A.replacement.releaseTarget)
    && reports.A.replacement.releaseTarget!==oldReleaseTarget
    && reports.A.actionRecord?.replacementTargetSlot===reports.A.replacement.releaseTarget
    && reports.A.actionRecord?.replacementTargetSlot!==reports.A.actionRecord?.rejectedTargetSlot
    && reports.A.actionRecord?.rejectedChainFingerprint
    && reports.A.actionRecord?.cancelledPlanRevision
    && Array.isArray(reports.A.actionRecord?.staleOutcomeIds)
    && reports.A.actionRecord.staleOutcomeIds.length>=3
  );
  const noSolutionScoped=Boolean(
    reports.C.scoped
    && reports.C.structuredSafetyAlerts.length===0
    && reports.C.noOrphanRecovery
    && reports.C.summary.operativeOutcomes===0
    && reports.C.summary.cards.length===0
    && reports.C.summary.reservations===0
    && reports.C.summary.overlays===0
    && reports.C.summary.adapters===0
  );
  const continuity=Boolean(
    reports.D.assessmentOk&&reports.D.applied&&reports.D.override&&reports.D.canonicalMode&&!reports.D.fallbackError
    && reports.E.positivePhysicalPrecondition.valid
    && reports.E.assessmentOk&&!reports.E.assessmentHardBlocked&&reports.E.applied&&reports.E.override&&reports.E.complete&&reports.E.canonicalMode&&!reports.E.fallbackError
    && reports.E.negativePhysicalConflict.safetyPass
    && reports.F.unique&&reports.F.terminated
    && reports.G.fresh
  );

  put("INV-EGRESS-016",parentPreserved&&reports.A_ABORT.unchanged&&reports.H.mainCancelled&&!reports.H.prerequisiteReplan,"prerequisite cancellation preserves parent intent/obligation while Abort, main cancellation and Delete retain their separate contracts");
  put("INV-EGRESS-017",sameTargetComplete&&reports.B.complete&&reports.B.visible&&reports.B.replacementTarget!==reports.B.originalTarget&&reports.B.targetSelectionSource==="prerequisite_cancel_fallback"&&Boolean(reports.B.supersedes)&&reports.B.deterministic,"same target is tried first; deterministic alternate main target is explicit and historically linked when required");
  put("INV-EGRESS-018",atomic,"cancelled prerequisite replacement is one complete integrity-PASS revision with cards, reservations, overlays, resources and adapters");
  put("INV-EGRESS-019",stale,"cancelled revision exits on the 5+2 lifecycle, old handlers/resources are stale, and rejected target/chain cannot return");
  put("INV-EGRESS-020",noSolutionScoped,"no safe replacement is a main-intent-scoped diagnostic with zero operative projection and no orphan recovery");
  put("INV-EGRESS-021",continuity,"replacement and diagnostic remain drag-local: independent orders, repeated cancellation and fresh-actual replanning stay usable");

  reports.contracts={
    "PREREQUISITE-CANCEL-REPLANS-CHAIN":reports.A_ABORT.unchanged&&parentPreserved&&sameTargetComplete&&atomic&&stale,
    "PREREQUISITE-CANCEL-ALTERNATE-MAIN-TARGET":reports.B.complete&&reports.B.visible&&reports.B.historicalTarget===reports.B.originalTarget&&reports.B.targetSelectionSource==="prerequisite_cancel_fallback"&&Boolean(reports.B.supersedes),
    "PREREQUISITE-CANCEL-NO-SOLUTION-IS-SCOPED":noSolutionScoped,
    "POST-CANCEL-GRAPHICAL-DRAG-CONTINUITY":continuity&&reports.A.staleHandler
  };
})().then(()=>{
  const failed=globalThis.__prerequisiteResults.filter(item=>item.status!=="PASS");
  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-prerequisite-cancel-replan-harness-v1",
    counts:{total:globalThis.__prerequisiteResults.length,pass:globalThis.__prerequisiteResults.length-failed.length,fail:failed.length},
    results:globalThis.__prerequisiteResults,
    scenarios:globalThis.__prerequisiteScenarios
  })+"\n");
  process.exitCode=failed.length?1:0;
}).catch(error=>{
  process.stderr.write((error?.stack||String(error))+"\n");
  process.exitCode=2;
});
`);

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname, "../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));
const results = [];

function record(id, pass, detail) {
  results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});
}

process.argv[2] = indexPath;
globalThis.__cancelResults = results;
globalThis.__cancelRecord = record;

eval(prefix + String.raw`
(async()=>{
  const report = globalThis.__cancelResults;
  const put = globalThis.__cancelRecord;

  function createModalElement(){
    const controls = new Map();
    const makeControl = (name,value="")=>({
      name,value,checked:false,disabled:false,listeners:{},
      addEventListener(type,listener){this.listeners[type]=listener;},
      focus(){},
      click(){return this.listeners.click?.({target:this});}
    });
    const element = fakeElement();
    element.parentNode = null;
    element.listeners = {};
    element.addEventListener = function(type,listener){this.listeners[type]=listener;};
    Object.defineProperty(element,"innerHTML",{
      get(){return this._html || "";},
      set(value){
        this._html=String(value);
        controls.clear();
        for(const match of this._html.matchAll(/<input[^>]*value="([^"]+)"[^>]*>/g)) controls.set("checkbox:"+match[1],makeControl("checkbox",match[1]));
        controls.set("textarea",makeControl("textarea"));
        if(this._html.includes("data-sde-learning-save")) controls.set("save",makeControl("save"));
        if(this._html.includes("data-sde-learning-cancel")) controls.set("cancel",makeControl("cancel"));
        if(this._html.includes("data-sde-learning-delete")) controls.set("delete",makeControl("delete"));
      }
    });
    element.querySelector = selector=>{
      if(selector==='input[type="checkbox"]') return [...controls.values()].find(item=>item.name==="checkbox") || null;
      if(selector===".sde-learning-modal-comment") return controls.get("textarea") || null;
      if(selector.includes("data-sde-learning-save")) return controls.get("save") || null;
      if(selector.includes("data-sde-learning-cancel")) return controls.get("cancel") || null;
      if(selector.includes("data-sde-learning-delete")) return controls.get("delete") || null;
      return null;
    };
    element.querySelectorAll = selector=>selector.includes(":checked")
      ? [...controls.values()].filter(item=>item.name==="checkbox" && item.checked)
      : [];
    element.controls=controls;
    return element;
  }

  const body = fakeElement();
  body.appendChild = child=>{child.parentNode=body; body.children.push(child); return child;};
  body.removeChild = child=>{body.children=body.children.filter(item=>item!==child); child.parentNode=null; return child;};
  ctx.document.body=body;
  ctx.document.createElement=()=>createModalElement();

  function setRenderedMoves(moves){
    ctx.__cancelData={moves};
    vm.runInContext("sdeShiftLastRenderedData=__cancelData",ctx);
  }

  function resetCancelScenario(placements,moves){
    resetState(placements);
    appState.sdeMoveLearningLog=[];
    appState.sdeDeletedMoveCards={};
    delete appState.sdeResetSnapshot;
    ctx.sdeMoveActionPendingKey="";
    ctx.sdeMoveLearningReasonModal=null;
    body.children=[];
    setRenderedMoves(moves);
    ctx.persist=()=>{};
    ctx.refreshSdeAfterMoveAction=()=>{};
  }

  function makePhysicalCancelFixture(label){
    const placements=[["10N","BLOCKER"],["10S","MAIN"]];
    resetCancelScenario(placements,[]);
    const main=makeMain("10","MAIN","8N",label);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const row=rows.find(candidate=>candidate.sdePhysicalDependencyRole==="prerequisite");
    setRenderedMoves(rows);
    return {placements,main,rows,row,key:ctx.getSdeMoveActionKey(row)};
  }

  function makeDirectCancelFixture(label,vehicle="DIRECT-"+label){
    const placements=[["10S",vehicle]];
    const row=makeMain("10",vehicle,"8N",label);
    resetCancelScenario(placements,[row]);
    return {placements,rows:[row],row,key:ctx.getSdeMoveActionKey(row)};
  }

  async function waitForLearningModal(){
    for(let attempt=0;attempt<8;attempt+=1){
      const modal=ctx.sdeMoveLearningReasonModal;
      if(modal?.backdrop?.parentNode) return modal;
      await Promise.resolve();
    }
    return null;
  }

  function startCancellation(fixture){
    return ctx.handleSdeShiftMoveAction(
      encodeURIComponent(fixture.key),
      "cancelled",
      {canonicalCardId:"strict-card-"+fixture.key,canonicalCanDelete:true}
    );
  }

  function hasReplacementState(actionRecord={}){
    return Boolean(
      actionRecord.replacedByCardId
      || actionRecord.activeOutcomeId
      || Object.keys(appState.sdeActiveMoveOutcomes || {}).length
    );
  }

  // Scenario A: start the real physical cancellation and inspect state while its real modal promise is pending.
  const beforeSaveFixture=makePhysicalCancelFixture("strict-cancel-before-save");
  const beforeSaveActions=JSON.stringify(appState.sdeMoveActions || {});
  const beforeSavePromise=startCancellation(beforeSaveFixture);
  const beforeSaveModal=await waitForLearningModal();
  const beforeSaveHtml=beforeSaveModal?.backdrop?.innerHTML || "";
  const beforeSaveRecord=ctx.getSdeMoveActionRecord(beforeSaveFixture.key) || {};
  const beforeSaveUnchanged=beforeSaveActions===JSON.stringify(appState.sdeMoveActions || {});
  const beforeSaveLearning=(appState.sdeMoveLearningLog || []).filter(event=>event.key===beforeSaveFixture.key);
  put(
    "INV-CANCEL-001",
    Boolean(beforeSaveModal)
      && beforeSaveHtml.includes("Hvorfor ble SDE-forslaget annullert?")
      && beforeSaveHtml.includes("Feil spor")
      && beforeSaveModal.backdrop.controls.has("save")
      && beforeSaveModal.backdrop.controls.has("cancel"),
    "physical canCancel handler opens the real reason modal with question and choices"
  );
  put(
    "INV-CANCEL-002",
    Boolean(beforeSaveModal)
      && beforeSaveUnchanged
      && !beforeSaveRecord.action
      && !hasReplacementState(beforeSaveRecord)
      && beforeSaveLearning.length===0,
    "physical cancellation state, replacement and learning remain unchanged before Save"
  );
  beforeSaveModal?.backdrop?.controls.get("cancel")?.click();
  await beforeSavePromise;

  // Scenario B: a fresh cancellable card uses the real Cancel button and leaves all cancellation state untouched.
  const cancelFixture=makeDirectCancelFixture("strict-cancel-abort");
  const cancelActionsBefore=JSON.stringify(appState.sdeMoveActions || {});
  const cancelAuthoritiesBefore=JSON.stringify(appState.sdeActiveMoveOutcomes || {});
  const cancelDeletedBefore=JSON.stringify(appState.sdeDeletedMoveCards || {});
  const cancelLearningBefore=JSON.stringify(appState.sdeMoveLearningLog || []);
  const realSetTimeout=ctx.setTimeout;
  const cancelTimers=[];
  ctx.setTimeout=(callback,delay)=>{cancelTimers.push(delay); return 1;};
  const cancelPromise=startCancellation(cancelFixture);
  const cancelModal=await waitForLearningModal();
  cancelModal?.backdrop?.controls.get("cancel")?.click();
  await cancelPromise;
  ctx.setTimeout=realSetTimeout;
  put(
    "INV-CANCEL-003",
    Boolean(cancelModal)
      && ctx.sdeMoveLearningReasonModal===null
      && cancelActionsBefore===JSON.stringify(appState.sdeMoveActions || {})
      && cancelAuthoritiesBefore===JSON.stringify(appState.sdeActiveMoveOutcomes || {})
      && cancelDeletedBefore===JSON.stringify(appState.sdeDeletedMoveCards || {})
      && cancelLearningBefore===JSON.stringify(appState.sdeMoveLearningLog || [])
      && cancelTimers.length===0,
    "real Cancel closes the modal without cancellation, replacement, learning or timers"
  );

  // Scenario C: select the real wrong-track reason, enter a comment, click Save, then await the handler.
  const saveFixture=makePhysicalCancelFixture("strict-cancel-save");
  const savePromise=startCancellation(saveFixture);
  const saveModal=await waitForLearningModal();
  const wrongTrack=saveModal?.backdrop?.controls.get("checkbox:wrong_track");
  if(wrongTrack) wrongTrack.checked=true;
  const saveComment=saveModal?.backdrop?.controls.get("textarea");
  if(saveComment) saveComment.value="Kontrollert kommentar";
  const saveButton=saveModal?.backdrop?.controls.get("save");
  saveButton?.click();
  await savePromise;
  const actionRecord=ctx.getSdeMoveActionRecord(saveFixture.key) || {};
  const learning=(appState.sdeMoveLearningLog || []).find(event=>event.key===saveFixture.key && event.action==="cancelled") || {};
  put(
    "INV-CANCEL-004",
    Boolean(saveModal && saveButton)
      && learning.key===saveFixture.key
      && learning.reasonCode==="wrong_track"
      && learning.commentText==="Kontrollert kommentar"
      && learning.snapshot?.vehicle===saveFixture.row.vehicle
      && learning.snapshot?.fromSlot===saveFixture.row.fromSlot
      && learning.snapshot?.toSlot===saveFixture.row.toSlot,
    "real wrong_track and comment reach the physical cancellation learning record through event.key"
  );
  put(
    "INV-CANCEL-006",
    Boolean(saveModal && saveButton)
      && actionRecord.dismissalState==="annulled_and_replaced"
      && Boolean(actionRecord.replacedByCardId)
      && actionRecord.activeOutcomeId===actionRecord.replacedByCardId
      && actionRecord.authorityPending===false,
    "after Save the old card exits while one replacement owns active authority"
  );
  put(
    "INV-CANCEL-016",
    Boolean(saveModal && saveButton)
      && learning.key===saveFixture.key
      && learning.reasonCodes?.includes("wrong_track")
      && learning.commentText==="Kontrollert kommentar",
    "existing learning metadata receives real modal reason fields through event.key"
  );

  // Run the 5+2 clock assertions only after a separate real Save path has completed.
  const clockFixture=makeDirectCancelFixture("strict-cancel-clock","CLOCK");
  const clockPromise=startCancellation(clockFixture);
  const clockModal=await waitForLearningModal();
  clockModal?.backdrop?.controls.get("checkbox:wrong_track") && (clockModal.backdrop.controls.get("checkbox:wrong_track").checked=true);
  const clockComment=clockModal?.backdrop?.controls.get("textarea");
  if(clockComment) clockComment.value="Klokkekontroll";
  const clockSave=clockModal?.backdrop?.controls.get("save");
  clockSave?.click();
  await clockPromise;
  const clockRecord=ctx.getSdeMoveActionRecord(clockFixture.key) || {};
  put(
    "INV-CANCEL-005",
    Boolean(clockModal && clockSave)
      && clockRecord.action==="cancelled"
      && clockRecord.status==="dismissing"
      && actionRecord.action==="cancelled"
      && actionRecord.status==="dismissing",
    "a completed real Save path and the physical old card both receive cancelled/dismissing lifecycle"
  );
  const cancelledAt=Date.parse(clockRecord.cancelledAt || clockRecord.time || "");
  const uiRow={...clockFixture.row,sdePhysicalRejectedReleaseMove:true};
  const hold=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+4999);
  const exit=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+5000);
  const beforeRemoval=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+6999);
  const removed=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+7000);
  put("INV-CANCEL-007",Boolean(clockModal && clockSave) && hold.phase==="hold" && !hold.hidden && exit.phase==="exit","real fake clock observes the 5000ms hold boundary after Save");
  put("INV-CANCEL-008",Boolean(clockModal && clockSave) && beforeRemoval.phase==="exit" && !beforeRemoval.hidden && removed.hidden,"real fake clock observes the 2000ms exit boundary after Save");

  // Scenario D: a fresh deletable card uses the real Delete button and its separate deletion contract.
  const deleteFixture=makeDirectCancelFixture("strict-cancel-delete","DELETE");
  const deleteActionsBefore=JSON.stringify(appState.sdeMoveActions || {});
  const deleteLearningBefore=JSON.stringify(appState.sdeMoveLearningLog || []);
  const deleteTimers=[];
  ctx.setTimeout=(callback,delay)=>{deleteTimers.push(delay); return 1;};
  const deletePromise=startCancellation(deleteFixture);
  const deleteModal=await waitForLearningModal();
  const deleteHtml=deleteModal?.backdrop?.innerHTML || "";
  const saveIndex=deleteHtml.indexOf("data-sde-learning-save");
  const deleteIndex=deleteHtml.indexOf("data-sde-learning-delete");
  const cancelIndex=deleteHtml.indexOf("data-sde-learning-cancel");
  const deleteButton=deleteModal?.backdrop?.controls.get("delete");
  deleteButton?.click();
  await deletePromise;
  ctx.setTimeout=realSetTimeout;
  const deletedKeys=Object.keys(appState.sdeDeletedMoveCards || {});
  put("INV-CANCEL-014",saveIndex>=0 && saveIndex<deleteIndex && deleteIndex<cancelIndex,"real modal action order is Save/Delete/Cancel");
  put("INV-CANCEL-015",/\.sde-learning-modal-actions\.has-delete\s*\{[\s\S]*?grid-template-columns\s*:\s*minmax\(0,\s*2fr\)\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*2fr\)/.test(html),"production CSS has 2:1:2 action columns");
  put(
    "INV-CANCEL-017",
    Boolean(deleteModal && deleteButton)
      && ctx.sdeMoveLearningReasonModal===null
      && deletedKeys.includes(deleteFixture.key)
      && deleteActionsBefore===JSON.stringify(appState.sdeMoveActions || {})
      && deleteLearningBefore===JSON.stringify(appState.sdeMoveLearningLog || [])
      && deleteTimers.length===0,
    "real Delete uses deletion markers without cancellation learning or 5+2 lifecycle"
  );

  // Exercise the real renderer with a production reader fixture. Only external data/render dependencies are fixtures.
  const now=Date.now();
  const card=(id,status,vehicle)=>({canonicalCardId:id,activeOutcomeId:"out-"+id,obligationId:"obl",stepId:"step-"+id,status,vehicleId:vehicle,sourceSlot:"10N",targetSlot:"5S",sequenceStep:1,explanation:id});
  const replacement=card("replacement","actionable","NEW");
  const blocked={...card("blocked","blocked_chain_step","BLOCKED"),sequenceStep:2,blockedBy:["replacement"]};
  const oldA=card("old-a","exiting","OLD-A");
  const oldB=card("old-b","exiting","OLD-B");
  function makeReader(exitingCards){
    const all=[replacement,blocked,...exitingCards];
    const handlerAdapters={};
    for(const item of all){
      const row={stableActionKey:item.canonicalCardId,sdeCancellationDismissalCard:item.status==="exiting",vehicle:item.vehicleId,fromSlot:item.sourceSlot,toSlot:item.targetSlot};
      handlerAdapters[item.canonicalCardId]={row,actionKey:item.canonicalCardId,canComplete:item.status==="actionable",canCancel:item.status==="actionable",ready:item.status==="actionable"};
    }
    return {planRevision:"strict-r",canonicalPlan:{candidateOutcomes:[]},cardProjection:{activeProposalCount:1,actionableCards:[replacement],handlerBlockedCards:[],blockedChainCards:[blocked],exitingCards},handlerAdapters,integrityReport:{status:"FAIL"},reservationProjection:{reservations:[]},graphicProjection:{activeOverlays:[],deferredOverlays:[]}};
  }
  appState.sdeMoveActions={
    "old-a":{action:"cancelled",cancelledAt:new Date(now-1000).toISOString(),exitStartedAt:new Date(now+4000).toISOString(),removeAt:new Date(now+6000).toISOString(),exitDurationMs:2000},
    "old-b":{action:"cancelled",cancelledAt:new Date(now-900).toISOString(),exitStartedAt:new Date(now+4100).toISOString(),removeAt:new Date(now+6100).toISOString(),exitDurationMs:2000}
  };
  const root=fakeElement();
  ctx.document.getElementById=id=>id==="sdeSkiftebevegelserDashboard"?root:null;
  ctx.document.querySelector=()=>null;
  ctx.document.querySelectorAll=()=>[];
  ctx.getSdeTomorrowJsonReadinessForScore=()=>({ready:true});
  ctx.getSdeShiftShowcaseData=()=>({score:0,moves:[]});
  ctx.buildSdeCanonicalProductionDiagnostics=()=>[];
  ctx.buildSdeCanonicalGraphicOverviewData=()=>({});
  ctx.isSdeGraphicPlanViewMode=()=>false;
  ctx.buildSdeCanonicalProductionScorePresentation=()=>({calculated:false,label:"—",detail:"strict"});
  ctx.buildSdeMoveActionHistoryHtml=()=>"";
  ctx.buildSdeProductionReaderStatusHtml=()=>"";
  ctx.buildSdeCanonicalDiagnosticsHtml=()=>"";
  ctx.scheduleSdePhysicalReleaseCardDismissals=()=>{};
  ctx.renderSdeNightPlacementOperationalStatePayloadPreview=()=>{};
  let currentReader=makeReader([oldB,oldA]);
  ctx.buildSdeCanonicalProductionReader=()=>currentReader;
  ctx.renderSdeCanonicalProductionReader();
  const firstHtml=root.innerHTML;
  const positions={replacement:firstHtml.indexOf('data-sde-canonical-card-id="replacement"'),blocked:firstHtml.indexOf('data-sde-canonical-card-id="blocked"'),oldA:firstHtml.indexOf('data-sde-canonical-card-id="old-a"'),oldB:firstHtml.indexOf('data-sde-canonical-card-id="old-b"')};
  const blockedStart=positions.blocked;
  const blockedEnd=firstHtml.indexOf("</article>",blockedStart);
  const blockedHtml=blockedStart>=0 && blockedEnd>=0 ? firstHtml.slice(blockedStart,blockedEnd) : "";
  put(
    "INV-CANCEL-010",
    positions.oldA>=0
      && positions.oldB>=0
      && positions.replacement>=0
      && positions.blocked>=0
      && firstHtml.includes('data-sde-release-cancelled-card="1"')
      && firstHtml.includes("sde-release-cancelled")
      && !blockedHtml.includes("sde-shift-action-btn"),
    "real canonical renderer keeps exiting red lifecycle cards and ordered blocked steps visible without exposing blocked actions"
  );
  const firstVisibleOrder=[...firstHtml.matchAll(/data-sde-canonical-card-id="([^"]+)"/g)].map(match=>match[1]).join(",");
  ctx.innerWidth=390;
  currentReader=makeReader([oldA,oldB]);
  ctx.renderSdeCanonicalProductionReader();
  const secondVisibleOrder=[...root.innerHTML.matchAll(/data-sde-canonical-card-id="([^"]+)"/g)].map(match=>match[1]).join(",");
  put("INV-CANCEL-011",firstVisibleOrder==="old-a,old-b,replacement,blocked" && secondVisibleOrder==="old-a,old-b,replacement,blocked","exiting cards, replacement and future ordered steps keep deterministic reading order, including 390px");

  appState.sdeMoveActions["old-a"].removedFromActiveLayout=true;
  appState.sdeMoveActions["old-b"].removedFromActiveLayout=true;
  ctx.innerWidth=390;
  currentReader=makeReader([oldA,oldB]);
  ctx.renderSdeCanonicalProductionReader();
  const removedHtml=root.innerHTML;
  put("INV-CANCEL-012",!removedHtml.includes('data-sde-canonical-card-id="old-a"') && !removedHtml.includes('data-sde-canonical-card-id="old-b"'),"removeAt leaves no exiting article/placeholder in real rendered card grid");
  const firstCard=[...removedHtml.matchAll(/data-sde-canonical-card-id="([^"]+)"/g)].map(match=>match[1])[0];
  put("INV-CANCEL-013",firstCard==="replacement","replacement shifts left after exiting cards are removed");

  // No safe replacement remains fail-closed and non-actionable.
  const closedPlacements=[["10N","BLOCKER"],["10S","MAIN"]];
  resetCancelScenario(closedPlacements,[]);
  const closedMain=makeMain("10","MAIN","8N","strict-cancel-closed");
  const all=vm.runInContext("inputSlots",ctx).filter(slot=>!["10N","10S","8N"].includes(slot));
  all.forEach((slot,index)=>{appState.grunnoppstilling[slot]="FULL-"+index;});
  const closedRows=ctx.buildSdePhysicalBlockerGuardMoves([closedMain]);
  const closedReader=ctx.buildSdeCanonicalProductionReader(snapshot(closedRows,Object.entries(appState.grunnoppstilling).map(([slot,vehicle])=>[slot,vehicle])));
  const closedActionable=closedReader.cardProjection.actionableCards.filter(item=>item.vehicleId==="BLOCKER");
  const closedReservations=closedReader.reservationProjection.reservations.filter(item=>item.vehicleId==="BLOCKER");
  const closedOverlays=[...closedReader.graphicProjection.activeOverlays,...closedReader.graphicProjection.deferredOverlays].filter(item=>item.vehicleId==="BLOCKER");
  put("INV-CANCEL-009",closedActionable.length===0 && closedReservations.length===0 && closedOverlays.length===0,"no safe replacement is diagnostic-only without card, reservation or overlay");
})().then(()=>{
  process.stdout.write(JSON.stringify({category:"cancel",results:globalThis.__cancelResults})+"\n");
}).catch(error=>{
  process.stderr.write((error.stack || String(error))+"\n");
  process.exitCode=2;
});
`);

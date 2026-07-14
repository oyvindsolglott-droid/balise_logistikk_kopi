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

  // Call the real modal implementation and prove its form data and presentation contract.
  const savePromise=ctx.openSdeMoveLearningReasonModal("cancelled",{row:{vehicle:"TEST"},activeRows:[],canonicalCanDelete:true});
  const saveBackdrop=ctx.sdeMoveLearningReasonModal?.backdrop;
  const saveHtml=saveBackdrop?.innerHTML || "";
  const wrong=saveBackdrop?.controls.get("checkbox:wrong_track");
  if(wrong) wrong.checked=true;
  const comment=saveBackdrop?.controls.get("textarea");
  if(comment) comment.value="Kontrollert kommentar";
  saveBackdrop?.controls.get("save")?.click();
  const modalReason=await savePromise;
  const saveIndex=saveHtml.indexOf("data-sde-learning-save");
  const deleteIndex=saveHtml.indexOf("data-sde-learning-delete");
  const cancelIndex=saveHtml.indexOf("data-sde-learning-cancel");
  put("INV-CANCEL-014",saveIndex>=0 && saveIndex<deleteIndex && deleteIndex<cancelIndex,"real modal action order is Save/Delete/Cancel");
  put("INV-CANCEL-015",/\.sde-learning-modal-actions\.has-delete\s*\{[\s\S]*?grid-template-columns\s*:\s*minmax\(0,\s*2fr\)\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*2fr\)/.test(html),"production CSS has 2:1:2 action columns");

  const cancelPromise=ctx.openSdeMoveLearningReasonModal("cancelled",{row:{vehicle:"TEST"},activeRows:[],canonicalCanDelete:true});
  const cancelBackdrop=ctx.sdeMoveLearningReasonModal?.backdrop;
  cancelBackdrop?.controls.get("cancel")?.click();
  const cancelledModalValue=await cancelPromise;

  // Exercise the real physical-release cancellation handler. The current regression bypasses the modal.
  const placements=[["10N","BLOCKER"],["10S","MAIN"]];
  resetState(placements);
  const main=makeMain("10","MAIN","8N","strict-cancel");
  const guarded=ctx.buildSdePhysicalBlockerGuardMoves([main]);
  const release=guarded.find(row=>row.sdePhysicalDependencyRole==="prerequisite");
  const releaseKey=ctx.getSdeMoveActionKey(release);
  ctx.__cancelData={moves:guarded};
  vm.runInContext("sdeShiftLastRenderedData=__cancelData",ctx);
  ctx.persist=()=>{};
  ctx.refreshSdeAfterMoveAction=()=>{};
  let modalCalls=0;
  const realLearning=ctx.getSdeMoveLearningReason;
  ctx.getSdeMoveLearningReason=async(...args)=>{modalCalls+=1; return realLearning(...args);};
  const before=JSON.stringify(appState.sdeMoveActions || {});
  await ctx.handleSdeShiftMoveAction(encodeURIComponent(releaseKey),"cancelled",{canonicalCanDelete:true});
  const after=JSON.stringify(appState.sdeMoveActions || {});
  const actionRecord=ctx.getSdeMoveActionRecord(releaseKey) || {};
  const learning=(appState.sdeMoveLearningLog || []).find(event=>event.actionKey===releaseKey) || {};
  put("INV-CANCEL-001",modalCalls===1,"physical canCancel handler must call the real learning modal");
  put("INV-CANCEL-002",modalCalls===1 && before===after && cancelledModalValue===null,"no cancellation before Save; direct modal Cancel returns null");
  put("INV-CANCEL-004",modalCalls===1 && learning.reasonCode===modalReason?.reasonCode && learning.commentText===modalReason?.commentText,"wrong_track and comment must reach the physical cancellation learning event");
  put("INV-CANCEL-005",actionRecord.action==="cancelled" && actionRecord.status==="dismissing","old card receives cancelled/dismissing lifecycle");
  put("INV-CANCEL-006",actionRecord.dismissalState==="annulled_and_replaced" && Boolean(actionRecord.replacedByCardId),"old card exits while replacement is active");
  const cancelledAt=Date.parse(actionRecord.cancelledAt || actionRecord.time || "");
  const uiRow={...release,sdePhysicalRejectedReleaseMove:true};
  const hold=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+4999);
  const exit=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+5000);
  const beforeRemoval=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+6999);
  const removed=ctx.getSdePhysicalReleaseCancelledUiState(uiRow,cancelledAt+7000);
  put("INV-CANCEL-007",hold.phase==="hold" && !hold.hidden && exit.phase==="exit","real fake clock observes the 5000ms hold boundary");
  put("INV-CANCEL-008",beforeRemoval.phase==="exit" && !beforeRemoval.hidden && removed.hidden,"real fake clock observes the 2000ms exit boundary");
  put("INV-CANCEL-016",modalCalls===1 && learning.reasonCodes?.includes("wrong_track") && learning.commentText==="Kontrollert kommentar","existing learning metadata receives modal reason fields");

  // Exercise the real renderer with a production reader fixture. Only external data/render dependencies are fixtures.
  const now=Date.now();
  const card=(id,status,vehicle)=>({canonicalCardId:id,activeOutcomeId:"out-"+id,obligationId:"obl",stepId:"step-"+id,status,vehicleId:vehicle,sourceSlot:"10N",targetSlot:"5S",sequenceStep:1,explanation:id});
  const replacement=card("replacement","actionable","NEW");
  const oldA=card("old-a","exiting","OLD-A");
  const oldB=card("old-b","exiting","OLD-B");
  function makeReader(exitingCards){
    const all=[replacement,...exitingCards];
    const handlerAdapters={};
    for(const item of all){
      const row={stableActionKey:item.canonicalCardId,sdeCancellationDismissalCard:item.status==="exiting",vehicle:item.vehicleId,fromSlot:item.sourceSlot,toSlot:item.targetSlot};
      handlerAdapters[item.canonicalCardId]={row,actionKey:item.canonicalCardId,canComplete:item.status==="actionable",canCancel:item.status==="actionable",ready:true};
    }
    return {planRevision:"strict-r",canonicalPlan:{candidateOutcomes:[]},cardProjection:{activeProposalCount:1,actionableCards:[replacement],handlerBlockedCards:[],blockedChainCards:[],exitingCards},handlerAdapters,integrityReport:{status:"FAIL"},reservationProjection:{reservations:[]},graphicProjection:{activeOverlays:[],deferredOverlays:[]}};
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
  const positions={replacement:firstHtml.indexOf('data-sde-canonical-card-id="replacement"'),oldA:firstHtml.indexOf('data-sde-canonical-card-id="old-a"'),oldB:firstHtml.indexOf('data-sde-canonical-card-id="old-b"')};
  put("INV-CANCEL-010",positions.oldA>=0 && positions.oldA<positions.replacement,"real canonical renderer places exiting left of replacement");
  const firstExitingOrder=[...firstHtml.matchAll(/data-sde-canonical-card-id="(old-[ab])"/g)].map(match=>match[1]).join(",");
  currentReader=makeReader([oldA,oldB]);
  ctx.renderSdeCanonicalProductionReader();
  const secondOrder=[...root.innerHTML.matchAll(/data-sde-canonical-card-id="(old-[ab])"/g)].map(match=>match[1]).join(",");
  put("INV-CANCEL-011",firstExitingOrder==="old-a,old-b" && secondOrder==="old-a,old-b","multiple exiting cards sort deterministically before replacement, including 390px reading direction");

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
  resetState(placements);
  const all=vm.runInContext("inputSlots",ctx).filter(slot=>!["10N","10S","8N"].includes(slot));
  all.forEach((slot,index)=>{appState.grunnoppstilling[slot]="FULL-"+index;});
  const closedRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
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

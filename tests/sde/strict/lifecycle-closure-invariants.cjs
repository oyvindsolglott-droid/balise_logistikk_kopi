"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const indexPath = path.resolve(process.argv[2]);
const root = path.resolve(__dirname,"../../..");
const source = fs.readFileSync(indexPath,"utf8");
const fixture = JSON.parse(fs.readFileSync(path.join(root,"tests/sde/fixtures/canonical-plan-lifecycle-closure-20260815.json"),"utf8"));
const asset = fs.readFileSync(path.join(root,"assets/registrer-plan-i-sde-button.png"));
const results = [];
const put = (id,pass,detail)=>results.push({id,status:pass?"PASS":"FAIL",detail});

function functionSource(name){
  const start = source.indexOf(`function ${name}(`);
  if(start < 0) return "";
  const paramsStart = source.indexOf("(",start);
  let paramsDepth = 0;
  let paramsEnd = -1;
  for(let index=paramsStart; index<source.length; index+=1){
    if(source[index] === "(") paramsDepth += 1;
    else if(source[index] === ")"){
      paramsDepth -= 1;
      if(paramsDepth === 0){
        paramsEnd = index;
        break;
      }
    }
  }
  const brace = source.indexOf("{",paramsEnd);
  let depth = 0;
  for(let index=brace; index<source.length; index+=1){
    if(source[index] === "{") depth += 1;
    else if(source[index] === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start,index+1);
    }
  }
  return "";
}

const controlsSource = functionSource("buildSdeCanonicalCardActionControlsHtml");
let controls = null;
try{
  const context = {encodeURIComponent,JSON,escapeHtml:value=>String(value??"")};
  vm.createContext(context);
  vm.runInContext(`${controlsSource};globalThis.controls=buildSdeCanonicalCardActionControlsHtml;`,context);
  controls = context.controls;
}catch(_error){}
const htmlFor = (card,adapter)=>controls ? controls(card,adapter,{}) : "";
const actionableHtml = htmlFor({canonicalCardId:"local",status:"actionable"},{ready:true,canComplete:true,canCancel:true,canDelete:true,executionDescriptor:{executionKey:"e"}});
const dependencyHtml = htmlFor({canonicalCardId:"dependency",status:"blocked_chain_step",blockedBy:["release"],explanation:"Venter på release"},{ready:false,canComplete:false,canCancel:false,canDelete:false,executionDescriptor:{executionKey:"d"}});
const handlerBlockedHtml = htmlFor({canonicalCardId:"handler",status:"handler_adapter_blocked",handlerBlockReasons:["adapter mangler"]},{ready:false,canComplete:false,canCancel:true,canDelete:false,executionDescriptor:{executionKey:"h"}});
const recoveryHtml = htmlFor({canonicalCardId:"recovery",status:"actionable",recoveryRequired:true},{ready:true,canComplete:true,canCancel:false,canDelete:false,executionDescriptor:{executionKey:"r"}});

const css = source.match(/\.segmented button\.seg-sde-plan-graphic\{([^}]*)\}/)?.[1] || "";
const unified = functionSource("buildSdeCanonicalUnifiedCardPipeline");
const stage = functionSource("stageSdeCanonicalGraphicDragOrder");
const unresolved = functionSource("buildSdeCanonicalUnresolvedFollowupCardHtml");
const render = functionSource("renderSdeCanonicalProductionReader");
const workshopRecommendation = functionSource("getSdeWorkshopExitRecommendation");
const atomicGate = functionSource("applySdePassiveBlockedSlotAtomicProjectionGate");
const identityFactory = functionSource("buildSdeCanonicalPlanIdentity");
const cardProjection = functionSource("buildSdeCanonicalCardProjection");
const reservationProjection = functionSource("buildSdeCanonicalReservationProjection");
const graphicProjection = functionSource("buildSdeCanonicalGraphicProjection");
const productionReader = functionSource("buildSdeCanonicalProductionReader");

put("INV-LIFECYCLE-001",!/width\s*:\s*160px/.test(css),"plan button has no fixed 160px desktop width");
put("INV-LIFECYCLE-002",!/min-width\s*:\s*160px/.test(css),"plan button has no fixed 160px minimum width");
put("INV-LIFECYCLE-003",/width\s*:\s*100%/.test(css)&&/min-width\s*:\s*0/.test(css),"plan button uses the common wide sizing contract");
put("INV-LIFECYCLE-004",/aspect-ratio\s*:\s*1810\s*\/\s*530/.test(css),"plan button uses the peer row aspect ratio");
put("INV-LIFECYCLE-005",crypto.createHash("sha256").update(asset).digest("hex")==="f74058d3cc40f47c4049f962f3a299f7fed725babf685f7e6b9daa16a2761fad","approved graphic remains byte-identical");
put("INV-LIFECYCLE-006",/object-fit\s*:\s*contain/.test(source)&&/overflow\s*:\s*hidden/.test(css),"graphic keeps the complete gold frame inside the focus/hit surface");
put("INV-LIFECYCLE-007",/SDE_NIGHT_PLAN_ALLOWED_LEVELS\s*=\s*Object\.freeze\(\["0","2"\]\)/.test(source),"menu remains limited to levels 0 and 2");
put("INV-LIFECYCLE-008",/SDE_CANONICAL_SHADOW_VALIDATE_ATOMIC_COMMIT/.test(source)&&/runSdeCanonicalGraphicDragShadowTransaction/.test(stage),"drag staging uses the named two-phase transaction");
put("INV-LIFECYCLE-009",/const shadowAuthorities = cloneSdeCanonicalValue\(liveAuthorities\)/.test(source)&&/shadowReplans = cloneSdeCanonicalValue\(liveReplans\)/.test(source)&&/catch/.test(functionSource("runSdeCanonicalGraphicDragShadowTransaction")),"failed shadow validation restores the prior authority object");
put("INV-LIFECYCLE-010",/commit/.test(functionSource("runSdeCanonicalGraphicDragShadowTransaction"))&&/buildSdeCanonicalProductionReader/.test(stage),"green shadow state is atomically committed and read back");
put("INV-LIFECYCLE-011",/buildSdeCanonicalPlanIdentity/.test(source),"one canonical plan identity factory owns projection identities");
put("INV-LIFECYCLE-012",/canonicalCardId/.test(identityFactory)&&/reservationId/.test(identityFactory)&&/overlayId/.test(identityFactory)&&/canonicalCardId:identity\.canonicalCardId/.test(cardProjection)&&/reservationId:identity\.reservationId/.test(reservationProjection)&&/overlayId:identity\.overlayId/.test(graphicProjection),"card reservation and overlay ids come from the same identity object");
put("INV-LIFECYCLE-013",/>Utført</.test(actionableHtml)&&/>Annullert</.test(actionableHtml),"ACTIONABLE exposes Utført and Annullert");
put("INV-LIFECYCLE-014",/>Fjern</.test(actionableHtml)&&!/>Fjern</.test(recoveryHtml),"Fjern is separate and obeys canDelete");
put("INV-LIFECYCLE-015",/>Utført</.test(dependencyHtml)&&/disabled/.test(dependencyHtml)&&/Venter på release|release/.test(dependencyHtml),"DEPENDENCY_BLOCKED exposes disabled Utført with a concrete reason");
put("INV-LIFECYCLE-016",/>Utført</.test(handlerBlockedHtml)&&/disabled/.test(handlerBlockedHtml)&&/adapter mangler/.test(handlerBlockedHtml),"HANDLER_ADAPTER_BLOCKED exposes disabled Utført and reason");
put("INV-LIFECYCLE-017",/>Annullert</.test(handlerBlockedHtml),"safe blocked cancellation remains visible when the adapter permits it");
put("INV-LIFECYCLE-018",/>Utført</.test(recoveryHtml)&&!/>Annullert</.test(recoveryHtml)&&!/>Fjern</.test(recoveryHtml),"mandatory recovery cannot be cancelled or deleted");
put("INV-LIFECYCLE-019",Boolean(dependencyHtml)&&Boolean(handlerBlockedHtml),"no valid non-terminal card returns an empty controls container");
put("INV-LIFECYCLE-020",/liveCanonicalCards/.test(unified),"unified pipeline defines all live canonical cards");
put("INV-LIFECYCLE-021",/blockedChainCards/.test(unified)&&/handlerBlockedCards/.test(unified),"dependency and handler-blocked cards join the live card set");
put("INV-LIFECYCLE-022",/const linkedCard = liveCanonicalCards\.find/.test(unified)&&/if\(linkedCard\)/.test(unified)&&/CHAIN_CREATED/.test(unified),"workshop requests linked to future chain steps are classified as chain-created");
put("INV-LIFECYCLE-023",/const liveManualActionKeys = new Set\(liveCanonicalCards/.test(unified)&&/liveManualActionKeys\.has\(actionKey\)/.test(unified),"manual intent linking uses every live canonical card");
put("INV-LIFECYCLE-024",!/unresolvedCardsHtml/.test(render),"unresolved needs are not appended to the normal shift-card row");
put("INV-LIFECYCLE-025",!/class="sde-shift-card/.test(unresolved)&&/sde-shift-unresolved-item/.test(unresolved),"unresolved presentation is diagnostic rather than a normal card");
put("INV-LIFECYCLE-026",/getSdeCanonicalPlanCandidateRecommendation/.test(workshopRecommendation)&&!/return getSdeArrivalParkingRecommendation/.test(workshopRecommendation),"workshop exits use the canonical candidate engine");
put("INV-LIFECYCLE-027",/searchedSlots/.test(functionSource("getSdeCanonicalPlanCandidateRecommendation")),"canonical candidate result records the full searched inventory");
put("INV-LIFECYCLE-028",/temporaryRelief/.test(functionSource("getSdeCanonicalPlanCandidateRecommendation"))&&/VN/.test(functionSource("getSdeCanonicalPlanCandidateRecommendation")),"VN is considered only in temporary-relief context");
put("INV-LIFECYCLE-029",/if\(cards\.length !== outcomes\.length/.test(atomicGate)&&/if\(reservations\.length !== outcomes\.length/.test(atomicGate)&&/if\(overlays\.length !== outcomes\.length/.test(atomicGate),"atomic gate requires a full chain projection");
put("INV-LIFECYCLE-030",/adapter\.ready === true/.test(atomicGate)&&/adapter\.ready === false/.test(atomicGate)&&/initialAdapterCards = getSdeCanonicalProductionProjectedCards\(reader\)\.filter\(needsHandlerAdapter\)/.test(productionReader),"atomic gate differentiates ready active adapters from deferred adapters");
put("INV-LIFECYCLE-031",fixture.intents.some(item=>item.vehicleId==="74-47"&&item.sourceSlot==="5M"&&item.targetSlot==="6S"&&item.sourceType==="MANUAL_DRAG"),"fixture binds the requested manual drag");
put("INV-LIFECYCLE-032",["74-23|8N","74-38|7N"].every(key=>fixture.intents.some(item=>`${item.vehicleId}|${item.sourceSlot}`===key&&item.sourceType==="WORKSHOP_EXIT")),"fixture binds both workshop exits");
put("INV-LIFECYCLE-033",fixture.intents.some(item=>item.vehicleId==="75-76"&&item.sourceSlot==="6N"&&item.targetSlot==="10N"&&item.status==="DEPENDENCY_BLOCKED"),"fixture binds the live dependency step");
put("INV-LIFECYCLE-034",fixture.emptySlots.includes("VN")&&fixture.emptySlots.includes("VS")&&fixture.emptySlots.length>20,"fixture supplies many empty slots with VN and VS available");
put("INV-LIFECYCLE-035",/buildSdeCanonicalAutomaticReplanRows/.test(source)&&/originalRequestedTarget/.test(functionSource("buildSdeCanonicalAutomaticReplanRows")),"automatic replan preserves original intent");
put("INV-LIFECYCLE-036",/rejectedTargets/.test(source),"candidate rejection is tracked without ending the search");
put("INV-LIFECYCLE-037",/Siste revisjon:\s*19\. august 2026/.test(source),"visible revision date is 19 August 2026");
put("INV-LIFECYCLE-038",/actionType === "deleted"/.test(functionSource("handleSdeCanonicalCardAction"))&&/deleteSdeLocalMoveCard/.test(functionSource("handleSdeCanonicalCardAction")),"separate canonical Fjern action reaches safe local deletion only");

const failed = results.filter(item=>item.status==="FAIL");
process.stdout.write(JSON.stringify({schemaVersion:"sde-canonical-plan-lifecycle-closure-invariants-v1",category:"lifecycle-closure",counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},results})+"\n");
process.exitCode = failed.length ? 1 : 0;

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const base = fs.readFileSync(path.join(__dirname, "../harnesses/sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/user-reroute-vn.json"), "utf8")).fixtures;
const results = [];
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

process.argv[2] = indexPath;
globalThis.__rerouteResults = results;
globalThis.__rerouteRecord = record;
globalThis.__rerouteFixtures = fixtures;

eval(prefix + String.raw`
(()=>{
  const put=globalThis.__rerouteRecord;
  const f=globalThis.__rerouteFixtures;
  const hasApi=()=>[
    "setSdeCanonicalRetargetIntent",
    "applySdeCanonicalRetargetIntentsToRows",
    "getSdeCanonicalRetargetContextKey",
    "resolveSdeCanonicalRetargetAction"
  ].every(name=>typeof ctx[name]==="function");
  const role=(rows,name)=>rows.find(row=>row.sdePhysicalDependencyRole===name);
  const cards=reader=>[
    ...(reader.cardProjection.actionableCards||[]),
    ...(reader.cardProjection.blockedChainCards||[]),
    ...(reader.cardProjection.handlerBlockedCards||[])
  ];
  const resources=reader=>({
    reservations:(reader.reservationProjection.reservations||[]),
    overlays:[...(reader.graphicProjection.activeOverlays||[]),...(reader.graphicProjection.deferredOverlays||[])],
    adapters:Object.values(reader.handlerAdapters||{})
  });
  const makeFixtureMain=fixture=>makeMain(
    fixture.main.sourceSlot.replace(/[^0-9].*$/,""),
    fixture.main.vehicle,
    fixture.main.requestedTarget,
    fixture.main.requestId
  );
  const buildPending=(fixture=f.A)=>{
    resetState(fixture.placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const main=makeFixtureMain(fixture);
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,fixture.placements));
    return {main,rows,reader,release:role(rows,"prerequisite"),dependent:role(rows,"dependent"),recovery:role(rows,"return")};
  };
  const initial=buildPending();
  const initialCards=cards(initial.reader);
  const releaseCard=initialCards.find(card=>card.sequenceStep==="physical-1");
  const recoveryCard=initialCards.find(card=>card.sequenceStep==="physical-3");
  put(
    "INV-REROUTE-001",
    hasApi() && releaseCard?.canRetarget===true && recoveryCard?.canCancel===false && recoveryCard?.canDelete===false && recoveryCard?.canRetarget===true,
    "canRetarget is explicit and remains true for mandatory recovery while canCancel/canDelete remain false"
  );

  let rerouted=null;
  if(hasApi() && initial.release){
    ctx.setSdeCanonicalRetargetIntent(initial.release,{mode:"reject_target",rejectedTarget:"VN"});
    const rows=ctx.buildSdePhysicalBlockerGuardMoves([initial.main]);
    rerouted={rows,reader:ctx.buildSdeCanonicalProductionReader(snapshot(rows,f.A.placements)),release:role(rows,"prerequisite"),dependent:role(rows,"dependent"),recovery:role(rows,"return")};
  }
  put(
    "INV-REROUTE-002",
    Boolean(rerouted?.release && rerouted.release.toSlot!=="VN" && rerouted.recovery?.fromSlot===rerouted.release.toSlot && rerouted.dependent?.toSlot===f.A.main.requestedTarget && rerouted.rows.length===3),
    "rejecting pending VN reranks to a complete safe non-VN three-step chain and preserves the requested main target"
  );

  let explicit=null;
  let invalidRejected=false;
  if(hasApi()){
    const fresh=buildPending();
    const intentsBefore=JSON.stringify(appState.sdeCanonicalRetargetIntents||{});
    const invalid=ctx.setSdeCanonicalRetargetIntent(fresh.release,{mode:"explicit_target",targetSlot:f.A.expected.invalidTarget});
    invalidRejected=invalid?.ok===false && JSON.stringify(appState.sdeCanonicalRetargetIntents||{})===intentsBefore;
    const requested=(fresh.release?.sdePhysicalReleaseCandidateOrder||[]).find(slot=>slot!=="VN" && slot!==f.A.expected.invalidTarget);
    if(requested){
      ctx.setSdeCanonicalRetargetIntent(fresh.release,{mode:"explicit_target",targetSlot:requested});
      const rows=ctx.buildSdePhysicalBlockerGuardMoves([fresh.main]);
      const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,f.A.placements));
      explicit={requested,rows,reader,release:role(rows,"prerequisite")};
    }
  }
  put(
    "INV-REROUTE-003",
    Boolean(invalidRejected && explicit?.requested && explicit.release?.toSlot===explicit.requested && resources(explicit.reader).reservations.some(item=>item.targetSlot===explicit.requested) && resources(explicit.reader).overlays.some(item=>item.targetSlot===explicit.requested)),
    "invalid manual targets are rejected without state mutation and a valid explicit target is preserved exactly"
  );

  let recoveryRetarget=null;
  if(hasApi() && initial.recovery){
    const actions={
      [ctx.getSdeMoveActionKey(initial.release)]:{action:"completed"},
      [ctx.getSdeMoveActionKey(initial.dependent)]:{action:"completed"}
    };
    const actual=[["VN",f.A.blocker.vehicle],[f.A.main.requestedTarget,f.A.main.vehicle]];
    resetState(actual,{sdeMoveActions:actions});
    const before=ctx.buildSdeCanonicalProductionReader(snapshot([initial.recovery],actual,actions));
    const beforeCard=cards(before)[0];
    ctx.setSdeCanonicalRetargetIntent(initial.recovery,{mode:"explicit_target",targetSlot:f.B.recovery.alternateTarget});
    const changedRows=ctx.applySdeCanonicalRetargetIntentsToRows([initial.recovery]);
    const after=ctx.buildSdeCanonicalProductionReader(snapshot(changedRows,actual,actions));
    recoveryRetarget={beforeCard,after,changed:changedRows[0]};
  }
  put(
    "INV-REROUTE-004",
    Boolean(releaseCard?.canRetarget && initialCards.find(card=>card.sequenceStep==="physical-2")?.canRetarget && recoveryRetarget?.beforeCard?.canRetarget && recoveryRetarget.changed?.toSlot===f.B.recovery.alternateTarget && recoveryRetarget.changed?.sdePhysicalDependsOn?.length && recoveryRetarget.changed?.isSdePhysicalBlockerReturnMove),
    "dependency-blocked steps and mandatory recovery can retarget without dropping dependencies or recovery semantics"
  );

  let atomic=false;
  if(rerouted){
    const oldIds=new Set(initial.reader.canonicalPlan.candidateOutcomes.map(item=>item.candidateOutcomeId));
    const newIds=new Set(rerouted.reader.canonicalPlan.candidateOutcomes.map(item=>item.candidateOutcomeId));
    const oldReservationIds=new Set(initial.reader.reservationProjection.reservations.map(item=>item.reservationId));
    const oldOverlayIds=new Set([...initial.reader.graphicProjection.activeOverlays,...initial.reader.graphicProjection.deferredOverlays].map(item=>item.overlayId));
    const oldAdapter=initial.reader.handlerAdapters[releaseCard?.canonicalCardId];
    const currentCard=cards(rerouted.reader).find(card=>card.obligationId===releaseCard?.obligationId && card.stepId===releaseCard?.stepId);
    const currentAdapter=currentCard ? rerouted.reader.handlerAdapters[currentCard.canonicalCardId] : null;
    const stale=ctx.resolveSdeCanonicalRetargetAction({renderedDescriptor:oldAdapter?.executionDescriptor,currentDescriptor:currentAdapter?.executionDescriptor,currentCard,currentHandlerDescriptor:currentAdapter});
    const nextResources=resources(rerouted.reader);
    atomic=
      [...oldIds].some(id=>!newIds.has(id))
      && nextResources.reservations.every(item=>!oldReservationIds.has(item.reservationId))
      && nextResources.overlays.every(item=>!oldOverlayIds.has(item.overlayId))
      && stale?.executable===false;
  }
  put("INV-REROUTE-005",atomic,"retarget atomically replaces outcomes/resources/adapters and makes the rendered old handler stale");

  let closed=null;
  if(hasApi()){
    const fixture=f.C;
    resetState(fixture.placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const main=makeFixtureMain(fixture);
    const ordinary=ctx.getSdeResolutionCandidateSlots("10N","10S").filter(slot=>!["VN","VS","10N","10S",fixture.main.requestedTarget].includes(slot));
    const occupied=[...fixture.placements,...ordinary.map((slot,index)=>[slot,"CLOSED-"+index])];
    resetState(occupied);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const initialRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
    const release=role(initialRows,"prerequisite");
    if(release){
      ctx.setSdeCanonicalRetargetIntent(release,{mode:"reject_target",rejectedTarget:"VN"});
      const rows=ctx.buildSdePhysicalBlockerGuardMoves([main]);
      const reader=ctx.buildSdeCanonicalProductionReader(snapshot(rows,occupied));
      closed={rows,reader};
    }
  }
  put(
    "INV-REROUTE-006",
    Boolean(closed && !role(closed.rows,"prerequisite") && cards(closed.reader).length===0 && resources(closed.reader).reservations.length===0 && resources(closed.reader).overlays.length===0 && resources(closed.reader).adapters.length===0 && (closed.reader.cardProjection.diagnostics||[]).length),
    "rejecting VN with no complete safe alternative is diagnostic-only with zero operative materialization"
  );

  let contextual=false;
  if(hasApi()){
    const fresh=buildPending();
    ctx.setSdeCanonicalRetargetIntent(fresh.release,{mode:"reject_target",rejectedTarget:"VN"});
    const rejectedRows=ctx.buildSdePhysicalBlockerGuardMoves([fresh.main]);
    const rejectedRelease=role(rejectedRows,"prerequisite");
    ctx.setSdeCanonicalRetargetIntent(rejectedRelease||fresh.release,{mode:"explicit_target",targetSlot:"VN"});
    const selectedRows=ctx.buildSdePhysicalBlockerGuardMoves([fresh.main]);
    contextual=rejectedRelease?.toSlot!=="VN" && role(selectedRows,"prerequisite")?.toSlot==="VN";
  }
  put("INV-REROUTE-007",contextual,"VN rejection is contextual and a later explicit user intent can select VN again");

  const normal=buildPending();
  const normalResources=resources(normal.reader);
  put(
    "INV-REROUTE-008",
    normal.release?.toSlot==="VN" && normal.rows.length===3 && normal.reader.cardProjection.actionableCards.length===1 && normal.reader.cardProjection.blockedChainCards.length===2 && normalResources.reservations.length===3 && normalResources.overlays.length===3 && cards(normal.reader).every(card=>card.canRetarget===true),
    "without user rejection the existing successful VN chain remains complete and retarget-capable"
  );

  process.stdout.write(JSON.stringify({category:"reroute",results:globalThis.__rerouteResults})+"\n");
})()
`);

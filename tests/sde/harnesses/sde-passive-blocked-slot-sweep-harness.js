"use strict";

const fs = require("node:fs");
const path = require("node:path");

const indexPath = path.resolve(process.argv[2]);
const root = path.resolve(__dirname, "../../..");
const baseHarness = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = baseHarness.slice(0, baseHarness.indexOf("const chain10"));
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/passive-blocked-slot-sweep.json"), "utf8"));
const egress = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/trapped-egress-chains.json"), "utf8")).fixtures;
const results = [];
const scenarios = [];
const record = (id, pass, detail) => results.push({id, status: pass ? "PASS" : "FAIL", detail: String(detail || "")});

globalThis.__blockedFixture = fixture;
globalThis.__blockedEgress = egress;
globalThis.__blockedResults = results;
globalThis.__blockedScenarios = scenarios;
globalThis.__blockedRecord = record;

eval(prefix + String.raw`
(()=>{
  const matrix=globalThis.__blockedFixture;
  const existing=globalThis.__blockedEgress;
  const put=globalThis.__blockedRecord;
  const reports=globalThis.__blockedScenarios;
  const protectedSlots=new Set(matrix.slots.map(item=>item.slot));
  const allCards=reader=>[
    ...(reader?.cardProjection?.actionableCards||[]),
    ...(reader?.cardProjection?.blockedChainCards||[]),
    ...(reader?.cardProjection?.handlerBlockedCards||[])
  ];
  const allOverlays=reader=>[
    ...(reader?.graphicProjection?.activeOverlays||[]),
    ...(reader?.graphicProjection?.deferredOverlays||[])
  ];
  const noOperative=reader=>Boolean(reader
    && (reader.canonicalPlan?.activeOutcomes||[]).length===0
    && allCards(reader).length===0
    && (reader.reservationProjection?.reservations||[]).length===0
    && allOverlays(reader).length===0
    && Object.keys(reader.handlerAdapters||{}).length===0
    && Number(reader.cardProjection?.activeProposalCount||0)===0);
  const blockedFinding=reader=>(reader?.canonicalPlan?.diagnostics||[]).find(item=>
    ["ORPHANED_BLOCKED_SLOT_CHAIN","IMPOSSIBLE_SHIFT_TO_OR_FROM_BLOCKED_SLOT","TARGET_PHYSICALLY_OCCUPIED"].includes(String(item?.problemId||item?.code||item?.diagnosticType||""))
  )||null;
  const richFinding=finding=>Boolean(finding
    && finding.findingId
    && finding.problemId
    && protectedSlots.has(finding.affectedSlot)
    && ["TO","FROM"].includes(finding.direction)
    && Object.hasOwn(finding,"activeIntentPresent")
    && Array.isArray(finding.missingPlanParts)
    && finding.firstSafeDivergence
    && finding.repairBoundary
    && finding.rootCauseStatus
    && finding.confidence);
  const mainFromDefinition=definition=>{
    if(definition.baseFixture){
      const base=existing[definition.baseFixture];
      const track=String(base.main.sourceSlot).replace(/[^0-9].*$/,"");
      return {...makeMain(track,base.main.vehicle,base.main.requestedTarget,base.main.requestId),fromSlot:base.main.sourceSlot,arrivalSlot:base.main.sourceSlot,originalFromSlot:base.main.sourceSlot};
    }
    const track=definition.slot.replace(/[^0-9].*$/,"");
    return makeMain(track,"MAIN-"+definition.slot,definition.fromTarget,"blocked-"+definition.slot);
  };
  const placementsFromDefinition=definition=>{
    if(definition.baseFixture) return existing[definition.baseFixture].placements.map(pair=>[...pair]);
    return [[definition.accessSlots[0],"BLOCKER-"+definition.slot],[definition.slot,"MAIN-"+definition.slot]];
  };
  const explicitSnapshot=(rows,placements,overrideRecords={},actions={})=>{
    const value=snapshot(rows,placements,actions);
    value.runtimeState.nightPlacementManualOverrides=overrideRecords;
    value.runtimeState.manualOverrides={};
    value.runtimeState.physicalReleaseReplans={};
    value.runtimeState.canonicalRetargetIntents={};
    value.runtimeState.blockedMoveRequest=null;
    return value;
  };
  const activeOverride=(main,slot)=>({
    id:"active-"+slot,
    vehicle:main.vehicle,
    originalFromSlot:main.fromSlot||main.arrivalSlot,
    fromSlot:main.fromSlot||main.arrivalSlot,
    toSlot:main.recommendedSlot||main.toSlot,
    stableActionKey:main.stableActionKey,
    needKey:main.needKey,
    moveKey:main.stableActionKey,
    dragRequestId:main.sdeNightPlacementDragIdentity,
    sdeNightPlacementDragIdentity:main.sdeNightPlacementDragIdentity,
    manualPlanId:main.manualPlanId,
    canonicalProducer:"graphic_drag_generated_move",
    sdeCanonicalGraphicDragOrder:true,
    createdAt:"2026-08-12T06:00:00.000Z",
    updatedAt:"2026-08-12T06:00:00.000Z"
  });
  const permute=(rows,name)=>{
    if(name==="reverse") return [...rows].reverse();
    if(name==="step_rotated"&&rows.length>1) return [...rows.slice(1),rows[0]];
    return [...rows];
  };
  const normalized=reader=>({
    active:(reader?.canonicalPlan?.activeOutcomes||[]).map(item=>[item.vehicleId,item.canonicalSourceSlot,item.targetSlot]).sort(),
    cards:allCards(reader).map(item=>[item.vehicleId,item.sourceSlot,item.targetSlot,item.status]).sort(),
    reservations:(reader?.reservationProjection?.reservations||[]).map(item=>[item.vehicleId,item.sourceSlot,item.targetSlot,item.status]).sort(),
    overlays:allOverlays(reader).map(item=>[item.vehicleId,item.sourceSlot,item.targetSlot,item.status]).sort(),
    diagnostics:(reader?.canonicalPlan?.diagnostics||[]).filter(item=>item.problemId).map(item=>[item.problemId,item.affectedSlot,item.direction]).sort()
  });
  const projectionComplete=(reader,rows)=>{
    const candidates=reader?.canonicalPlan?.candidateOutcomes||[];
    const cards=allCards(reader);
    const reservations=reader?.reservationProjection?.reservations||[];
    const overlays=allOverlays(reader);
    return Boolean(reader?.integrityReport?.status==="PASS"
      && rows.length>=3
      && rows.filter(row=>row.sdePhysicalDependencyRole==="dependent").length===1
      && rows.filter(row=>row.sdePhysicalDependencyRole==="prerequisite").length>=1
      && rows.filter(row=>row.sdePhysicalDependencyRole==="return").length===rows.filter(row=>row.sdePhysicalDependencyRole==="prerequisite").length
      && candidates.length===rows.length
      && cards.length===rows.length
      && reservations.length===rows.length
      && overlays.length===rows.length
      && Object.keys(reader.handlerAdapters||{}).length===rows.length
      && cards.filter(card=>card.status==="actionable").length===1
      && cards.filter(card=>card.status==="blocked_chain_step").length===rows.length-1
      && candidates.every(item=>Array.isArray(item.routeResources)&&item.routeResources.length));
  };

  const matrixReports=[];
  const replayFingerprints={local:[],buttspor:[]};
  const browserChecks=[];
  for(const definition of matrix.slots){
    const placements=placementsFromDefinition(definition);
    resetState(placements);
    appState.txpUnavailableInfrastructure={slots:[],tracks:[],washRouteUnavailable:false};
    const main=mainFromDefinition(definition);
    const completeRows=ctx.buildSdePhysicalBlockerGuardMoves([main]);

    const fromReader=ctx.buildSdeCanonicalProductionReader(explicitSnapshot(completeRows,placements,{}));
    const fromFinding=blockedFinding(fromReader);
    matrixReports.push({slot:definition.slot,direction:"FROM",situation:"FROM_BLOCKED",pass:noOperative(fromReader)&&fromFinding?.problemId==="ORPHANED_BLOCKED_SLOT_CHAIN"&&richFinding(fromFinding)});

    const targetOccupant="OCCUPANT-"+definition.slot;
    const toVehicle="TO-"+definition.slot;
    const toSource="9";
    const occupiedPlacements=[[toSource,toVehicle],[definition.slot,targetOccupant]];
    resetState(occupiedPlacements);
    const toMain={...makeMain("9",toVehicle,definition.slot,"occupied-"+definition.slot),fromSlot:toSource,arrivalSlot:toSource,originalFromSlot:toSource};
    const toOverride=activeOverride(toMain,definition.slot);
    const toReader=ctx.buildSdeCanonicalProductionReader(explicitSnapshot([toMain],occupiedPlacements,{[toOverride.id]:toOverride}));
    const toFinding=blockedFinding(toReader);
    matrixReports.push({slot:definition.slot,direction:"TO",situation:"TO_OCCUPIED",pass:noOperative(toReader)&&toFinding?.occupyingVehicleId===targetOccupant&&richFinding(toFinding)});

    const inaccessibleVehicle="INACCESSIBLE-"+definition.slot;
    const inaccessibleSource="9";
    const inaccessiblePlacements=[[inaccessibleSource,inaccessibleVehicle],...definition.accessSlots.map(slot=>[slot,"ACCESS-BLOCKER-"+slot])];
    const inaccessibleMain={...makeMain("9",inaccessibleVehicle,definition.slot,"inaccessible-"+definition.slot),fromSlot:inaccessibleSource,arrivalSlot:inaccessibleSource,originalFromSlot:inaccessibleSource};
    const partialChainId="passive-inaccessible-chain|"+definition.slot;
    const releaseKey="passive-inaccessible-release|"+definition.slot;
    const inaccessibleRelease={
      vehicle:"ACCESS-BLOCKER-"+definition.accessSlots[0],
      fromSlot:definition.accessSlots[0],arrivalSlot:definition.accessSlots[0],recommendedSlot:"VN",toSlot:"VN",
      stableActionKey:releaseKey,actionKey:releaseKey,source:"passive blocked-slot fixture",
      sdePhysicalChainId:partialChainId,sdePhysicalChainStep:1,sdePhysicalChainStepCount:3,
      sdePhysicalDependencyRole:"prerequisite",sdePhysicalDependsOn:[],canonicalChainStepActive:true,
      isSdePhysicalBlockerFreeingMove:true,sdeTrappedEgressRouteResources:["VN","VS","target-access|"+definition.slot]
    };
    const inaccessibleDependent={
      ...inaccessibleMain,
      sdePhysicalChainId:partialChainId,sdePhysicalChainStep:2,sdePhysicalChainStepCount:3,
      sdePhysicalDependencyRole:"dependent",sdePhysicalDependsOn:[releaseKey],sdePhysicalHardBlocked:true,
      sdePhysicalHardBlockState:{
        vehicle:inaccessibleVehicle,fromSlot:inaccessibleSource,toSlot:definition.slot,hardBlocked:true,
        blockers:definition.accessSlots.map(slot=>({slot,vehicle:"ACCESS-BLOCKER-"+slot,accessEnd:slot.endsWith("N")?"north":"south"})),
        accessAssessment:{sourceAccessBlocked:false,targetAccessBlocked:true}
      },
      sdeTrappedEgressRouteResources:["VN","VS","target-access|"+definition.slot]
    };
    const partialRows=[inaccessibleRelease,inaccessibleDependent];
    const partialOverride=activeOverride(inaccessibleMain,definition.slot);
    resetState(inaccessiblePlacements);
    const inaccessibleReader=ctx.buildSdeCanonicalProductionReader(explicitSnapshot(partialRows,inaccessiblePlacements,{[partialOverride.id]:partialOverride}));
    const inaccessibleFinding=blockedFinding(inaccessibleReader);
    matrixReports.push({slot:definition.slot,direction:"TO",situation:"TO_EMPTY_INACCESSIBLE",pass:noOperative(inaccessibleReader)&&inaccessibleFinding?.problemId==="IMPOSSIBLE_SHIFT_TO_OR_FROM_BLOCKED_SLOT"&&inaccessibleFinding?.direction==="TO"&&inaccessibleFinding?.affectedSlot===definition.slot&&inaccessibleFinding?.missingPlanParts?.includes("recovery")&&richFinding(inaccessibleFinding)});

    const replay=[];
    for(const permutation of matrix.permutations){
      resetState(placements);
      const reader=ctx.buildSdeCanonicalProductionReader(explicitSnapshot(permute(completeRows,permutation),placements,{}));
      replay.push(JSON.stringify(normalized(reader)));
    }
    replayFingerprints[definition.family].push({slot:definition.slot,identical:new Set(replay).size===1,fingerprint:replay[0]});

    const validOverride=activeOverride(main,definition.slot);
    resetState(placements);
    const validReader=ctx.buildSdeCanonicalProductionReader(explicitSnapshot(completeRows,placements,{[validOverride.id]:validOverride}));
    const complete=projectionComplete(validReader,completeRows);
    reports.push({
      slot:definition.slot,
      direction:"FROM",
      situation:"VALID_COMPLETE_PLAN",
      complete,
      rowCount:completeRows.length,
      candidateCount:(validReader.canonicalPlan?.candidateOutcomes||[]).length,
      cardCount:allCards(validReader).length,
      reservationCount:(validReader.reservationProjection?.reservations||[]).length,
      overlayCount:allOverlays(validReader).length,
      adapterCount:Object.keys(validReader.handlerAdapters||{}).length,
      routeResourceCounts:(validReader.canonicalPlan?.candidateOutcomes||[]).map(item=>(item.routeResources||[]).length),
      statuses:allCards(validReader).map(item=>item.status),
      blockedFindings:(validReader.canonicalPlan?.diagnostics||[]).filter(item=>item.problemId).map(item=>({problemId:item.problemId,missingPlanParts:item.missingPlanParts,observed:item.observed}))
    });

    for(const width of matrix.viewports){
      ctx.innerWidth=width;
      for(const trigger of matrix.passiveTriggers){
        resetState(placements);
        let reader=null,html="",error="";
        try{
          reader=ctx.buildSdeCanonicalProductionReader(explicitSnapshot(completeRows,placements,{}));
          const diagnostics=ctx.buildSdeCanonicalProductionDiagnostics(reader);
          html=ctx.buildSdeCanonicalDiagnosticsHtml(diagnostics,reader.integrityReport.status);
        }catch(caught){ error=String(caught?.stack||caught); }
        browserChecks.push({
          slot:definition.slot,width,trigger,
          pass:!error&&noOperative(reader)&&html.includes("ORPHANED_BLOCKED_SLOT_CHAIN")&&!/data-sde-canonical-action=/.test(html),
          diagnosticTypes:reader?ctx.buildSdeCanonicalProductionDiagnostics(reader).map(item=>item.diagnosticType):[],
          htmlHasOrphan:html.includes("ORPHANED_BLOCKED_SLOT_CHAIN"),
          noOperative:noOperative(reader),
          error
        });
      }
    }
  }

  const bySituation=name=>matrixReports.filter(item=>item.situation===name);
  const completeReports=reports.filter(item=>item.situation==="VALID_COMPLETE_PLAN");
  const allMatrix=matrixReports.length===18&&matrixReports.every(item=>item.pass);
  const passiveFrom=bySituation("FROM_BLOCKED");
  const occupied=bySituation("TO_OCCUPIED");
  const inaccessible=bySituation("TO_EMPTY_INACCESSIBLE");
  put("INV-BLOCKED-SLOT-001",matrix.slots.length===6&&matrix.slots.every(item=>passiveFrom.some(report=>report.slot===item.slot&&report.pass)),"PASSIVE-BLOCKED-SLOT-SWEEP-COVERS-ALL-SIX-SLOTS");
  put("INV-BLOCKED-SLOT-002",passiveFrom.length===6&&passiveFrom.every(item=>item.pass),"NO-VALID-INTENT-MEANS-NO-OPERATIVE-PROJECTION");
  put("INV-BLOCKED-SLOT-003",allMatrix&&completeReports.length===6&&completeReports.every(item=>item.complete),"COMPLETE-PLAN-OR-DIAGNOSTIC-ONLY");
  put("INV-BLOCKED-SLOT-004",passiveFrom.every(item=>item.pass)&&occupied.every(item=>item.pass)&&inaccessible.every(item=>item.pass),"BLOCKED-SOURCE-AND-BLOCKED-TARGET-ARE-BOTH-COVERED");
  put("INV-BLOCKED-SLOT-005",occupied.length===6&&occupied.every(item=>item.pass),"FRESH-ACTUAL-STATE-OVERRIDES-HISTORY");
  put("INV-BLOCKED-SLOT-006",Object.values(replayFingerprints).flat().length===6&&Object.values(replayFingerprints).flat().every(item=>item.identical)&&browserChecks.every(item=>item.pass),"RELOAD-AND-HYDRATION-ARE-IDEMPOTENT");
  put("INV-BLOCKED-SLOT-007",completeReports.filter(item=>["4M","5M","6S"].includes(item.slot)).every(item=>item.complete),"LOCAL-RELIEF-REMAINS-COMPLETE-FOR-4M-5M-6S");
  put("INV-BLOCKED-SLOT-008",completeReports.filter(item=>["10S","11S","12S"].includes(item.slot)).every(item=>item.complete),"VN-BUTTSPOR-CHAIN-REMAINS-COMPLETE-FOR-10S-11S-12S");
  put("INV-BLOCKED-SLOT-009",matrixReports.every(item=>item.pass)&&completeReports.every(item=>item.complete)&&browserChecks.every(item=>item.pass),"NO-PARTIAL-CARD-RESERVATION-OVERLAY-RESOURCE-OR-ADAPTER");

  const failed=globalThis.__blockedResults.filter(item=>item.status==="FAIL");
  process.stdout.write(JSON.stringify({
    schemaVersion:"sde-passive-blocked-slot-sweep-harness-v1",
    reproduction:passiveFrom.some(item=>!item.pass)?"SEMANTIC_EQUIVALENT":"PROTECTED",
    counts:{total:globalThis.__blockedResults.length,pass:globalThis.__blockedResults.length-failed.length,fail:failed.length},
    matrix:{total:matrixReports.length,pass:matrixReports.filter(item=>item.pass).length,fail:matrixReports.filter(item=>!item.pass).length,scenarios:matrixReports},
    replayFingerprints,
    browser:{total:browserChecks.length,pass:browserChecks.filter(item=>item.pass).length,fail:browserChecks.filter(item=>!item.pass).length,checks:browserChecks},
    results:globalThis.__blockedResults,
    scenarios:globalThis.__blockedScenarios
  })+"\n");
  process.exitCode=failed.length?1:0;
})()
`);

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const base = fs.readFileSync(path.join(__dirname, "sde-canonical-buttspor-vn-chain-t-harness.js"), "utf8");
const prefix = base.slice(0, base.indexOf("const chain10"));

eval(prefix + String.raw`
(()=>{
  const results = [];
  const scenarios = [];
  const put = (id,condition,detail)=>results.push({id,status:condition ? "PASS" : "FAIL",detail});
  const plain = value=>JSON.parse(JSON.stringify(value));
  const root = (id,vehicle,target,source="SDE_TEST")=>({
    rootRequestId:id,
    requestedVehicleId:vehicle,
    requestedTarget:target,
    requestSource:source,
    actor:{actorId:"recursive-test",capabilities:["SDE_SHIFT_ORDER"]},
    createdAt:"2026-08-10T06:00:00.000Z",
    requestRevision:"request-revision-1",
    status:"ACTIVE"
  });
  const placement = (slot,vehicle)=>({slot,vehicleId:vehicle,source:"canonical-actual",provenance:"recursive-fixture"});
  const call = input=>{
    if(typeof ctx.buildSdeRecursivePrerequisiteShiftPlan !== "function"){
      return {status:"PRODUCT_API_MISSING",rootRequest:input.rootRequest,cards:[],diagnostics:[{code:"recursive_planner_missing"}],search:{}};
    }
    try{
      return plain(ctx.buildSdeRecursivePrerequisiteShiftPlan(input));
    }catch(error){
      return {status:"PRODUCT_API_ERROR",rootRequest:input.rootRequest,cards:[],diagnostics:[{code:"recursive_planner_error",message:String(error?.message || error)}],search:{}};
    }
  };
  const physical = plan=>(plan.cards || []).filter(card=>card.nonMovement !== true);
  const roles = (plan,role)=>physical(plan).filter(card=>card.role === role);
  const firstReadyOnly = plan=>{
    const cards = physical(plan);
    return cards.length > 0 && cards.filter(card=>card.state === "READY").length === 1 && cards[0].state === "READY"
      && cards.slice(1).every(card=>card.state === "DEPENDENCY_BLOCKED");
  };
  const dependencyLinear = plan=>physical(plan).every((card,index,cards)=>index === 0
    ? Array.isArray(card.dependsOn) && card.dependsOn.length === 0
    : Array.isArray(card.dependsOn) && card.dependsOn.length === 1 && card.dependsOn[0] === cards[index-1].cardId);
  const make = (name,vehicle,target,actualPlacements,extra={})=>{
    const input = {
      rootRequest:root("root-"+name,vehicle,target),
      candidateSource:extra.candidateSource,
      actualPlacements,
      temporaryTargets:extra.temporaryTargets || ["VN","9","1N","1S","4N","4S","5N","5S","6N","6SS"],
      reservations:extra.reservations || [],
      routeResourceBlocks:extra.routeResourceBlocks || [],
      movementCandidates:extra.movementCandidates || {},
      previousPlan:extra.previousPlan,
      completedCardIds:extra.completedCardIds || [],
      searchBudget:extra.searchBudget
    };
    const plan = call(input);
    scenarios.push({name,input:plain(input),plan});
    return plan;
  };

  const sourceDefinitions = [
    {slot:"4M",vehicle:"ROOT-4M",target:"8N",blockers:[["4N","BLOCK-4N"],["4S","BLOCK-4S"]]},
    {slot:"5M",vehicle:"ROOT-5M",target:"8N",blockers:[["5N","BLOCK-5N"],["5S","BLOCK-5S"]]},
    {slot:"6S",vehicle:"ROOT-6S",target:"8N",blockers:[["6N","BLOCK-6N"],["6SS","BLOCK-6SS"]]},
    {slot:"10S",vehicle:"ROOT-10S",target:"8N",blockers:[["10N","BLOCK-10N"]]},
    {slot:"11S",vehicle:"ROOT-11S",target:"8N",blockers:[["11N","BLOCK-11N"]]},
    {slot:"12S",vehicle:"ROOT-12S",target:"8N",blockers:[["12N","BLOCK-12N"]]}
  ];
  const sourcePlans = sourceDefinitions.map(definition=>make(
    "source-"+definition.slot,
    definition.vehicle,
    definition.target,
    [placement(definition.slot,definition.vehicle),...definition.blockers.map(([slot,vehicle])=>placement(slot,vehicle))],
    {candidateSource:definition.slot,temporaryTargets:["VN","9","1N","1S","4N","4S","5N","5S","6N","6SS"]}
  ));

  const occupiedTarget = make("occupied-target","ROOT-TARGET","5M",[
    placement("8N","ROOT-TARGET"),placement("5M","TARGET-OCCUPANT")
  ],{candidateSource:"8N",temporaryTargets:["VN","9","1N","1S","4N","4S"]});
  const occupiedTargetNested = make("occupied-target-nested","ROOT-TARGET-NESTED","5M",[
    placement("8N","ROOT-TARGET-NESTED"),placement("5M","TARGET-OCCUPANT-NESTED"),
    placement("5N","TARGET-NORTH"),placement("5S","TARGET-SOUTH"),placement("4M","CORRIDOR-4M")
  ],{candidateSource:"8N",temporaryTargets:["VN","9","1N","1S","4N","4S","6N"]});
  const sourceAndTarget = make("source-and-target","ROOT-BOTH","5M",[
    placement("4M","ROOT-BOTH"),placement("4N","SOURCE-NORTH"),placement("4S","SOURCE-SOUTH"),
    placement("5M","TARGET-BODY"),placement("5N","TARGET-NORTH-BOTH"),placement("5S","TARGET-SOUTH-BOTH")
  ],{candidateSource:"4M",temporaryTargets:["VN","9","1N","1S","6N","6SS"]});
  const routeResource = make("route-resource","ROOT-ROUTE","8N",[
    placement("10S","ROOT-ROUTE")
  ],{candidateSource:"10S",routeResourceBlocks:[{resourceId:"route|10|north",reason:"route locked"}]});
  const reservation = make("reservation","ROOT-RESERVATION","5M",[
    placement("8N","ROOT-RESERVATION")
  ],{candidateSource:"8N",reservations:[{reservationId:"reservation-5M",targetSlot:"5M",vehicleId:"OTHER"}]});
  const sourceConflict = make("source-conflict","ROOT-CONFLICT","8N",[
    placement("10S","ROOT-CONFLICT"),placement("10N","CONFLICT-BLOCKER")
  ],{candidateSource:"4M",temporaryTargets:["VN"]});
  const missingDerived = make("missing-derived","ROOT-MISSING","8N",[
    placement("10S","ROOT-MISSING"),placement("10N","MISSING-BLOCKER")
  ],{candidateSource:"",temporaryTargets:["VN"]});
  const unknownSource = make("unknown-source","ROOT-UNKNOWN","8N",[
    placement("10N","UNRELATED")
  ],{candidateSource:"10S",temporaryTargets:["VN"]});
  const exhausted = make("exhausted","ROOT-EXHAUSTED","8N",[
    placement("10S","ROOT-EXHAUSTED"),placement("10N","EXHAUSTED-BLOCKER"),placement("VN","NO-TEMPORARY-CAPACITY")
  ],{candidateSource:"10S",temporaryTargets:["VN"],movementCandidates:{"EXHAUSTED-BLOCKER":["VN"],"NO-TEMPORARY-CAPACITY":[]}});
  const cycleAlternative = make("cycle-alternative","ROOT-CYCLE","8N",[
    placement("10S","ROOT-CYCLE"),placement("10N","CYCLE-BLOCKER"),placement("4N","CYCLE-SECONDARY")
  ],{
    candidateSource:"10S",
    temporaryTargets:["4N","5N"],
    movementCandidates:{"CYCLE-BLOCKER":["4N"],"CYCLE-SECONDARY":["4N","5N"]}
  });
  const cycleNoAlternative = make("cycle-no-alternative","ROOT-CYCLE-NONE","8N",[
    placement("10S","ROOT-CYCLE-NONE"),placement("10N","CYCLE-NONE-BLOCKER"),placement("4N","CYCLE-NONE-SECONDARY")
  ],{
    candidateSource:"10S",
    temporaryTargets:["4N","10N"],
    movementCandidates:{"CYCLE-NONE-BLOCKER":["4N"],"CYCLE-NONE-SECONDARY":["10N"]}
  });
  const incomplete = make("search-incomplete","ROOT-INCOMPLETE","5M",[
    placement("4M","ROOT-INCOMPLETE"),placement("4N","INCOMPLETE-SOURCE-N"),placement("4S","INCOMPLETE-SOURCE-S"),
    placement("5M","INCOMPLETE-TARGET"),placement("5N","INCOMPLETE-TARGET-N"),placement("5S","INCOMPLETE-TARGET-S")
  ],{candidateSource:"4M",temporaryTargets:["VN","9","1N"],searchBudget:1});

  const initialReplan = make("replan-initial","ROOT-REPLAN","8N",[
    placement("10S","ROOT-REPLAN"),placement("10N","REPLAN-BLOCKER")
  ],{candidateSource:"10S",temporaryTargets:["VN"]});
  const completedRelease = roles(initialReplan,"PREREQUISITE_RELEASE")[0];
  const replanned = make("replan-after-first","ROOT-REPLAN","8N",[
    placement("10S","ROOT-REPLAN"),placement("VN","REPLAN-BLOCKER")
  ],{
    candidateSource:"10S",
    temporaryTargets:["VN"],
    previousPlan:initialReplan,
    completedCardIds:completedRelease ? [completedRelease.cardId] : []
  });

  const deterministicInput = scenarios.find(item=>item.name === "source-10S")?.input;
  const replayPlans = deterministicInput ? [
    call(deterministicInput),
    call({...deterministicInput,actualPlacements:[...deterministicInput.actualPlacements].reverse()}),
    call({...deterministicInput,actualPlacements:[...deterministicInput.actualPlacements].sort((a,b)=>b.vehicleId.localeCompare(a.vehicleId))})
  ] : [];
  const replayFingerprints = replayPlans.map(plan=>JSON.stringify({
    rootRequestId:plan.rootRequest?.rootRequestId,
    planId:plan.planId,
    cards:(plan.cards || []).map(card=>({cardId:card.cardId,role:card.role,vehicleId:card.vehicleId,source:card.source,target:card.target,dependsOn:card.dependsOn,state:card.state})),
    diagnostics:plan.diagnostics
  }));

  const allPhysicalPlans = [...sourcePlans,occupiedTarget,occupiedTargetNested,sourceAndTarget];
  const safePlans = allPhysicalPlans.filter(plan=>plan.status === "PLANNED");
  const sourceChain = sourcePlans.find(plan=>roles(plan,"PREREQUISITE_RELEASE").length && roles(plan,"MAIN_MOVE").length && roles(plan,"MANDATORY_RECOVERY").length);
  const targetCards = physical(occupiedTarget);
  const targetReleaseIndex = targetCards.findIndex(card=>card.role === "PREREQUISITE_RELEASE" && card.vehicleId === "TARGET-OCCUPANT");
  const targetMainIndex = targetCards.findIndex(card=>card.role === "MAIN_MOVE");
  const multilevelPlans = [occupiedTargetNested,sourceAndTarget].filter(plan=>roles(plan,"PREREQUISITE_RELEASE").length >= 2);
  const sourceConflictMain = roles(sourceConflict,"MAIN_MOVE")[0];
  const missingDerivedMain = roles(missingDerived,"MAIN_MOVE")[0];
  const reconciliationCard = (unknownSource.cards || []).find(card=>card.role === "STATE_RECONCILIATION_REQUIRED");
  const resourceCard = (exhausted.cards || []).find(card=>card.role === "RESOURCE_RELEASE_REQUIRED");
  const routeCard = (routeResource.cards || []).find(card=>card.role === "PREREQUISITE_ROUTE_CLEARANCE");
  const reservationCard = (reservation.cards || []).find(card=>card.role === "RESOURCE_RELEASE_REQUIRED");
  const allPlanIdsStable = replayFingerprints.length === 3 && new Set(replayFingerprints).size === 1;
  const atomic = safePlans.length === allPhysicalPlans.length && safePlans.every(plan=>
    roles(plan,"MAIN_MOVE").length === 1 && dependencyLinear(plan) && firstReadyOnly(plan)
    && (plan.cards || []).every(card=>card.rootRequestId === plan.rootRequest.rootRequestId && card.planId === plan.planId && card.planRevision === plan.planRevision)
  );
  const html = typeof ctx.buildSdeRecursivePrerequisitePlanHtml === "function" && sourceAndTarget.status === "PLANNED"
    ? String(ctx.buildSdeRecursivePrerequisitePlanHtml(sourceAndTarget))
    : "";
  const viewportChecks = [1200,390].map(width=>({
    width,
    prerequisiteVisible:html.includes("PREREQUISITE_RELEASE"),
    mainVisible:html.includes("MAIN_MOVE"),
    recoveryVisible:html.includes("MANDATORY_RECOVERY"),
    dependencyVisible:html.includes("DEPENDENCY_BLOCKED"),
    noDeadEndText:!html.includes("behovet kan ikke bli handlingskort"),
    noFixedOverflow:!/(?:min-width|width):\s*(?:[4-9]\d\d|\d{4,})px/.test(html)
  }));

  put("INV-EGRESS-032",sourcePlans.every(plan=>plan.status === "PLANNED" && roles(plan,"MAIN_MOVE").length === 1),"a valid request with a modeled legal sequence always produces a plan");
  put("INV-EGRESS-033",sourcePlans.every(plan=>roles(plan,"PREREQUISITE_RELEASE").length >= 1),"a direct physical block triggers prerequisite planning instead of diagnostic-only");
  put("INV-EGRESS-034",Boolean(sourceChain) && roles(sourceChain,"PREREQUISITE_RELEASE").length >= 1 && roles(sourceChain,"MAIN_MOVE").length === 1 && roles(sourceChain,"MANDATORY_RECOVERY").length >= 1,"blocked source produces release, main and mandatory recovery");
  put("INV-EGRESS-035",occupiedTarget.status === "PLANNED" && targetReleaseIndex >= 0 && targetMainIndex > targetReleaseIndex && targetCards[targetMainIndex]?.state === "DEPENDENCY_BLOCKED","occupied target is released before the visible dependency-blocked main move");
  put("INV-EGRESS-036",multilevelPlans.length === 2 && roles(sourceAndTarget,"PREREQUISITE_RELEASE").length >= 3,"multi-level and combined source/target blockers are expanded recursively");
  put("INV-EGRESS-037",sourceConflict.status === "PLANNED" && sourceConflict.sourceReconciliation?.status === "CANONICAL_SOURCE_RECONCILED" && sourceConflictMain?.source === "10S","canonical actual source overrides a conflicting candidate source");
  put("INV-EGRESS-038",missingDerived.status === "PLANNED" && missingDerived.sourceReconciliation?.status === "CANONICAL_SOURCE_RECONCILED" && missingDerivedMain?.source === "10S","unique canonical actual repairs a missing derived source");
  put("INV-EGRESS-039",unknownSource.status === "STATE_RECONCILIATION_REQUIRED" && reconciliationCard?.nonMovement === true && unknownSource.rootRequest?.status === "STATE_RECONCILIATION_REQUIRED","unknown actual produces a non-movement reconciliation card and preserves the request");
  put("INV-EGRESS-040",cycleNoAlternative.status === "RESOURCE_RELEASE_REQUIRED" && exhausted.status === "RESOURCE_RELEASE_REQUIRED" && resourceCard?.nonMovement === true,"exhausted no-solution produces a resource-release card without a partial physical chain");
  put("INV-EGRESS-041",initialReplan.rootRequest?.rootRequestId === replanned.rootRequest?.rootRequestId && replanned.rootRequest?.requestedTarget === "8N" && replanned.planRevision !== initialReplan.planRevision && roles(replanned,"MANDATORY_RECOVERY").length >= 1,"replan after completed prerequisite preserves the root request and recovery obligation");
  put("INV-EGRESS-042",safePlans.every(firstReadyOnly) && physical(routeResource)[0]?.state !== "READY","only the first executable physical card is READY");
  put("INV-EGRESS-043",atomic,"the complete card chain materializes atomically with stable plan identity and linear dependencies");
  put("INV-EGRESS-044",allPlanIdsStable,"polling, hydration and input-order permutations do not duplicate or reorder cards");
  put("INV-EGRESS-045",allPhysicalPlans.every(plan=>roles(plan,"MAIN_MOVE")[0]?.target === plan.rootRequest?.requestedTarget),"the requested main target is preserved exactly");
  put("INV-EGRESS-046",cycleAlternative.status === "PLANNED" && Number(cycleAlternative.search?.cycleSkips || 0) > 0,"a visited-state cycle does not hide a legal alternative");
  put("INV-EGRESS-047",incomplete.status === "SEARCH_INCOMPLETE" && !(incomplete.cards || []).some(card=>card.role === "RESOURCE_RELEASE_REQUIRED"),"search incomplete is distinct from exhausted no-solution");
  put("INV-EGRESS-048",reconciliationCard?.nonMovement === true && resourceCard?.nonMovement === true && routeCard?.nonMovement === true && reservationCard?.nonMovement === true,"reconciliation, route-clearance and resource-release cards are non-movement actions");
  put("INV-EGRESS-049",safePlans.length === allPhysicalPlans.length && safePlans.every(plan=>!(plan.diagnostics || []).some(item=>item.disposition === "DIAGNOSTIC_ONLY")) && viewportChecks.every(item=>item.prerequisiteVisible && item.mainVisible && item.recoveryVisible && item.dependencyVisible && item.noDeadEndText && item.noFixedOverflow),"a safe sequence forbids dead-end diagnostic-only and renders the complete responsive chain");

  const failed = results.filter(item=>item.status === "FAIL");
  console.log(JSON.stringify({
    schemaVersion:"sde-recursive-prerequisite-planning-harness-v1",
    counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},
    failIds:failed.map(item=>item.id),
    results,
    scenarioCounts:{total:scenarios.length,planned:scenarios.filter(item=>item.plan.status === "PLANNED").length},
    scenarios:scenarios.map(item=>({name:item.name,status:item.plan.status,cardCount:(item.plan.cards || []).length,roles:(item.plan.cards || []).map(card=>card.role),search:item.plan.search})),
    deterministicReplay:{runs:replayPlans.length,stable:allPlanIdsStable},
    viewportChecks,
    routeResourceStatus:routeResource.status,
    reservationStatus:reservation.status
  }));
  process.exitCode = failed.length ? 1 : 0;
})();
`);

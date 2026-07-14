"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {performance} = require("node:perf_hooks");

const indexPath = process.argv[2] || path.resolve(__dirname,"../../..","index.html");
const html = fs.readFileSync(indexPath, "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match=>match[1]).filter(Boolean);
assert.ok(scripts.length > 0);
scripts.forEach((source,index)=>new vm.Script(source, {filename:`index-inline-${index + 1}.js`}));

const start = html.indexOf("function normalizeSdeCanonicalToken");
const end = html.indexOf("function getSdeMoveCardDisplayIndex", start);
assert.ok(start >= 0 && end > start);
const canonicalSource = html.slice(start, end);
["localStorage.", "fetch(", "document.", "renderSde", "setTimeout(", "persist("]
  .forEach(text=>assert.equal(canonicalSource.includes(text), false, `canonical block contains ${text}`));

const context = vm.createContext({
  console,
  Map,
  Set,
  JSON,
  Number,
  String,
  Array,
  Object,
  Math,
  normalizeSlot:value=>String(value || "").toUpperCase().replace(/\s+/g, ""),
  sanitizeVehicleValue:value=>{
    const text = String(value || "").trim();
    return !text || text === "-" || text.toLowerCase() === "ukjent" ? "" : text;
  },
  localStorage:new Proxy({}, {get(){ throw new Error("localStorage access is forbidden"); }}),
  fetch(){ throw new Error("fetch is forbidden"); },
  document:new Proxy({}, {get(){ throw new Error("DOM access is forbidden"); }}),
  setTimeout(){ throw new Error("timer creation is forbidden"); }
});
vm.runInContext(canonicalSource, context, {filename:"sde-canonical-identity-v2.js"});

const build = input=>context.buildSdeCanonicalPlan(input);
const compare = (plan,legacy)=>context.compareSdeCanonicalPlanWithLegacy(plan,legacy);
const clone = value=>JSON.parse(JSON.stringify(value));
const actual = (rows, source="grunnoppstilling", selected=true)=>({source, selected, provenance:`test:${source}`, rows});
const row = (vehicle, fromSlot, targetSlot, cardId, extra={})=>({
  vehicle,
  fromSlot,
  targetSlot,
  cardId,
  actionKey:cardId,
  source:"Ankomstbasert parkeringsbehov",
  canonicalPurpose:"night-parking",
  ...extra
});
const codes = plan=>new Set(plan.conflicts.map(item=>item.code));

function duplicateInput(vehicle, sourceSlot, firstTarget, secondTarget){
  return {
    actualSources:[actual([{vehicleId:vehicle, slot:sourceSlot}])],
    candidateRows:[
      row(vehicle, sourceSlot, firstTarget, `${vehicle}-ordinary`, {needKey:`ordinary|${vehicle}`, canonicalProducer:"ordinary_base_need"}),
      row(vehicle, sourceSlot, secondTarget, `${vehicle}-graphic`, {needKey:`graphic|${vehicle}`, canonicalProducer:"graphic_drag_generated_move"})
    ]
  };
}

const duplicate69 = build(duplicateInput("69-63", "10S", "12N", "9"));
assert.equal(duplicate69.obligations.length, 1);
assert.equal(duplicate69.outcomesByObligationStep.length, 1);
assert.equal(duplicate69.candidateOutcomes.length, 2);
assert.equal(duplicate69.activeOutcomes.length, 0);
assert.equal(new Set(duplicate69.candidateOutcomes.map(item=>item.obligationId)).size, 1);
assert.equal(new Set(duplicate69.candidateOutcomes.map(item=>item.stepId)).size, 1);
assert.equal(new Set(duplicate69.candidateOutcomes.map(item=>item.candidateOutcomeId)).size, 2);
assert.ok(codes(duplicate69).has("competing_targets"));
assert.ok(codes(duplicate69).has("legacy_identity_split"));

const duplicate74 = build(duplicateInput("74-11", "5N", "5S", "4N"));
assert.equal(duplicate74.obligations.length, 1);
assert.equal(duplicate74.outcomesByObligationStep.length, 1);
assert.equal(duplicate74.activeOutcomes.length, 0);
assert.ok(codes(duplicate74).has("competing_targets"));

const cancelled = build({
  actualSources:[actual([{vehicleId:"74-11", slot:"5N"}])],
  candidateRows:[
    row("74-11", "5N", "4S", "cancel-old", {
      needKey:"legacy-old-need",
      status:"dismissing",
      sdeCancellationDismissalCard:true
    }),
    row("74-11", "5N", "4N", "cancel-new", {
      needKey:"replacement-new-need",
      isSdeCancellationReplacementMove:true
    })
  ]
});
assert.equal(cancelled.obligations.length, 1);
assert.equal(cancelled.outcomesByObligationStep.length, 1);
assert.equal(cancelled.exitingCards.length, 1);
assert.equal(cancelled.activeOutcomes.length, 1);
assert.equal(cancelled.activeOutcomes[0].legacyCardId, "cancel-new");
assert.deepEqual([...cancelled.outcomesByObligationStep[0].rejectionMetadata.rejectedTargets], ["4S"]);
assert.equal(cancelled.candidateOutcomes[0].obligationId, cancelled.candidateOutcomes[1].obligationId);
assert.equal(cancelled.candidateOutcomes[0].stepId, cancelled.candidateOutcomes[1].stepId);

const manualOrdinary = build({
  actualSources:[actual([{vehicleId:"70-01", slot:"7N"}])],
  candidateRows:[
    row("70-01", "7N", "8", "ordinary-card", {needKey:"ordinary-need", canonicalProducer:"ordinary_base_need"}),
    row("70-01", "7N", "8", "manual-card", {needKey:"manual-need", canonicalProducer:"manual_override", manualOverrideActive:true})
  ]
});
assert.equal(manualOrdinary.obligations.length, 1);
assert.equal(manualOrdinary.outcomesByObligationStep.length, 1);
assert.deepEqual([...manualOrdinary.obligations[0].producerSet], ["manual_override","ordinary_base_need"]);
assert.equal(manualOrdinary.obligations[0].legacyAliases.filter(alias=>alias.type === "needKey").length, 2);
assert.equal(manualOrdinary.activeOutcomes.length, 1);
assert.equal(manualOrdinary.activeOutcomes[0].selectionReason, "equivalent_target_merge");

const distinctNeeds = build({
  actualSources:[actual([{vehicleId:"70-02", slot:"6N"}])],
  candidateRows:[
    row("70-02", "6N", "7", "parking-card", {canonicalPurpose:"night-parking", canonicalTimeContext:"night-window"}),
    row("70-02", "6N", "VS", "workshop-card", {canonicalPurpose:"workshop-service", canonicalTimeContext:"maintenance-window"})
  ]
});
assert.equal(distinctNeeds.obligations.length, 2);
assert.equal(new Set(distinctNeeds.obligations.map(item=>item.identityComponents.purpose)).size, 2);
assert.equal(new Set(distinctNeeds.obligations.map(item=>item.identityComponents.operationalContext[0].token)).size, 2);

const vnChain = build({
  actualSources:[actual([{vehicleId:"A", slot:"11N"},{vehicleId:"B", slot:"11S"}])],
  candidateRows:[
    row("A", "11N", "VN", "chain-1", {canonicalPurpose:"vn-chain", sdePhysicalChainId:"chain-vn", sdePhysicalChainStep:1, canonicalChainStepActive:true}),
    row("B", "11S", "9", "chain-2", {canonicalPurpose:"vn-chain", sdePhysicalChainId:"chain-vn", sdePhysicalChainStep:2, sdePhysicalDependsOn:["chain-1"]}),
    row("A", "VN", "11S", "chain-3", {canonicalPurpose:"vn-chain", sdePhysicalChainId:"chain-vn", sdePhysicalChainStep:3, sdePhysicalDependsOn:["chain-2"]})
  ]
});
assert.equal(vnChain.activeChains.length, 1);
assert.equal(vnChain.activeChains[0].steps.length, 3);
assert.equal(new Set(vnChain.activeChains[0].steps.map(item=>item.stepId)).size, 3);
assert.equal(vnChain.activeOutcomes.length, 1);
assert.equal(vnChain.activeOutcomes[0].legacyCardId, "chain-1");
assert.deepEqual([...vnChain.activeChains[0].steps.find(item=>item.candidateId === "chain-2").dependencies], ["chain-1"]);

const vnRecovery = build({
  actualSources:[actual([{vehicleId:"A", slot:"VN"}])],
  candidateRows:[
    row("A", "VN", "11S", "recovery-concrete", {
      canonicalPurpose:"vn-recovery",
      sdeVnRecoveryRequired:true,
      sdeVnRecoveryObligationId:"vn-recovery-a"
    }),
    row("A", "VN", "", "recovery-fallback", {
      canonicalPurpose:"vn-recovery",
      sdeVnRecoveryStatus:"ambiguous_recovery_target",
      sdeVnRecoveryObligationId:"vn-recovery-a"
    })
  ]
});
assert.equal(vnRecovery.obligations.length, 1);
assert.equal(vnRecovery.outcomesByObligationStep.length, 1);
assert.equal(vnRecovery.activeOutcomes.length, 1);
assert.equal(vnRecovery.activeOutcomes[0].legacyCardId, "recovery-concrete");
assert.ok(vnRecovery.diagnostics.some(item=>item.code === "targetless_candidate"));

const collision = build({
  actualSources:[actual([{vehicleId:"C", slot:"3"}])],
  candidateRows:[
    row("C", "3", "4", "collision-a", {needKey:"shared-legacy-alias", canonicalPurpose:"parking"}),
    row("C", "3", "VS", "collision-b", {needKey:"shared-legacy-alias", canonicalPurpose:"workshop"})
  ]
});
assert.equal(collision.obligations.length, 2);
assert.ok(codes(collision).has("legacy_identity_collision"));

const multipleAuthorities = build({
  actualSources:[actual([{vehicleId:"D", slot:"4N"}])],
  candidateRows:[
    row("D", "4N", "5N", "authority-a", {sdeActiveOutcomeId:"authority-a"}),
    row("D", "4N", "5S", "authority-b", {sdeActiveOutcomeId:"authority-b"})
  ]
});
assert.equal(multipleAuthorities.activeOutcomes.length, 0);
assert.ok(codes(multipleAuthorities).has("multiple_authorities"));

const missingAuthoritySeed = duplicateInput("E", "2N", "2S", "3");
const missingAuthorityStep = build(missingAuthoritySeed).outcomesByObligationStep[0].stepId;
const missingAuthority = build({...missingAuthoritySeed, activeAuthorities:{[missingAuthorityStep]:"does-not-exist"}});
assert.equal(missingAuthority.activeOutcomes.length, 0);
assert.ok(codes(missingAuthority).has("authority_target_missing"));

const invalidAuthority = build({
  actualSources:[actual([{vehicleId:"F", slot:"8N"}])],
  activeAuthorities:{"invalid-authority-step":"invalid-card"},
  candidateRows:[
    row("F", "8N", "8S", "invalid-card", {
      sdeOutcomeKey:"invalid-authority-step",
      canonicalPhysicalValid:false,
      canonicalPhysicalInvalidReason:"test-invalid"
    })
  ]
});
assert.equal(invalidAuthority.activeOutcomes.length, 0);
assert.ok(codes(invalidAuthority).has("physically_invalid_authority"));

const staleActual = build({
  actualSources:[actual([{vehicleId:"G", slot:"9N"}])],
  candidateRows:[row("G", "8N", "9S", "stale-source")]
});
assert.ok(codes(staleActual).has("stale_actual_source"));

const deterministicInput = {
  actualSources:[
    actual([{vehicleId:"P", slot:"10S"},{vehicleId:"Q", slot:"11N"}], "grunnoppstilling", true),
    actual([{vehicleId:"P", slot:"10S"},{vehicleId:"Q", slot:"11N"}], "beregnet", false)
  ],
  activeAuthorities:{"permutation-outcome":"perm-manual"},
  candidateRows:[
    row("P", "10S", "12N", "perm-ordinary", {needKey:"perm-ordinary-need", sdeOutcomeKey:"permutation-outcome", canonicalProducer:"ordinary_base_need"}),
    row("P", "10S", "9", "perm-manual", {needKey:"perm-manual-need", sdeOutcomeKey:"permutation-outcome", canonicalProducer:"manual_override"}),
    row("Q", "11N", "VN", "perm-chain-1", {canonicalPurpose:"vn-chain", sdePhysicalChainId:"perm-chain", sdePhysicalChainStep:1}),
    row("Q", "VN", "11S", "perm-chain-2", {canonicalPurpose:"vn-chain", sdePhysicalChainId:"perm-chain", sdePhysicalChainStep:2, sdePhysicalDependsOn:["perm-chain-1"]})
  ]
};
const deterministicBefore = JSON.stringify(deterministicInput);
const deterministicBaseline = JSON.stringify(build(deterministicInput));
for(let index=0; index<3; index++) assert.equal(JSON.stringify(build(deterministicInput)), deterministicBaseline);

function seededShuffle(values, seed){
  const copy = [...values];
  let state = seed;
  for(let index=copy.length - 1; index>0; index--){
    state = (state * 1664525 + 1013904223) >>> 0;
    const target = state % (index + 1);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}
for(let seed=1; seed<=10; seed++){
  const permuted = {
    ...deterministicInput,
    actualSources:seededShuffle(deterministicInput.actualSources, seed + 100),
    candidateRows:seededShuffle(deterministicInput.candidateRows, seed)
  };
  assert.equal(JSON.stringify(build(permuted)), deterministicBaseline, `permutation ${seed} changed canonical output`);
}
assert.equal(JSON.stringify(deterministicInput), deterministicBefore, "input mutated");

const legacyComparison = compare(duplicate69, {
  finalCards:[
    {vehicle:"69-63", fromSlot:"10S", targetSlot:"12N", needKey:"legacy-a"},
    {vehicle:"69-63", fromSlot:"10S", targetSlot:"9", needKey:"legacy-b"}
  ],
  reservations:[{targetSlot:"12N"},{targetSlot:"12N"}],
  overlays:[{targetSlot:"12N"},{targetSlot:"12N"}]
});
["legacy_obligation_split","canonical_multi_producer_merge","canonical_ambiguity","legacy_duplicate","legacy_duplicate_reservations","legacy_duplicate_overlays"]
  .forEach(code=>assert.ok(legacyComparison.classifications.includes(code), `missing comparison ${code}`));

const representativeRows = Array.from({length:120}, (_,index)=>row(
  `R-${String(index + 1).padStart(3,"0")}`,
  `${index + 1}N`,
  `${index + 1}S`,
  `representative-${index + 1}`,
  {needKey:`representative-need-${index + 1}`}
));
const representativeActual = representativeRows.map(item=>({vehicleId:item.vehicle, slot:item.fromSlot}));
const startedAt = performance.now();
const representative = build({actualSources:[actual(representativeActual)], candidateRows:representativeRows});
const runtimeMs = performance.now() - startedAt;
assert.equal(representative.obligations.length, 120);
assert.equal(representative.activeOutcomes.length, 120);
assert.ok(runtimeMs < 1000, `representative runtime too high: ${runtimeMs}`);

console.log(JSON.stringify({
  ok:true,
  inlineScriptsParsed:scripts.length,
  identityVersion:duplicate69.metadata.identityVersion,
  duplicate69:{obligations:duplicate69.obligations.length,steps:duplicate69.outcomesByObligationStep.length,candidates:duplicate69.candidateOutcomes.length,active:duplicate69.activeOutcomes.length},
  duplicate74:{obligations:duplicate74.obligations.length,steps:duplicate74.outcomesByObligationStep.length,candidates:duplicate74.candidateOutcomes.length,active:duplicate74.activeOutcomes.length},
  cancelled:{obligationId:cancelled.obligations[0].obligationId,stepId:cancelled.outcomesByObligationStep[0].stepId,rejectedTargets:cancelled.outcomesByObligationStep[0].rejectedTargets},
  manualOrdinary:{producerSet:manualOrdinary.obligations[0].producerSet,aliases:manualOrdinary.obligations[0].legacyAliases.length},
  distinctNeeds:distinctNeeds.obligations.map(item=>item.identityComponents),
  vnChain:{chains:vnChain.activeChains.length,steps:vnChain.activeChains[0].steps.length,active:vnChain.activeOutcomes.length},
  vnRecovery:{active:vnRecovery.activeOutcomes[0].legacyCardId,diagnostics:vnRecovery.diagnostics.map(item=>item.code)},
  permutations:10,
  legacyComparison:legacyComparison.classifications,
  representative:{rawCandidates:representativeRows.length,obligations:representative.obligations.length,conflicts:representative.conflicts.length,runtimeMs:Number(runtimeMs.toFixed(3))}
}, null, 2));

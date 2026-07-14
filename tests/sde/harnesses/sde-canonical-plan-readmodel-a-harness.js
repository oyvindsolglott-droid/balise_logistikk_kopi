"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {performance} = require("node:perf_hooks");

const indexPath = process.argv[2] || path.resolve(__dirname,"../../..","index.html");
const html = fs.readFileSync(indexPath, "utf8");

const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match=>match[1]).filter(Boolean);
assert.ok(scripts.length > 0, "index.html must contain inline JavaScript");
scripts.forEach((source,index)=>new vm.Script(source, {filename:`index-inline-${index + 1}.js`}));

const start = html.indexOf("function normalizeSdeCanonicalToken");
const end = html.indexOf("function getSdeMoveCardDisplayIndex", start);
assert.ok(start >= 0 && end > start, "canonical read-model block must be extractable");
const canonicalSource = html.slice(start, end);
const forbiddenCalls = ["localStorage.", "fetch(", "document.", "renderSde", "setTimeout(", "persist("];
forbiddenCalls.forEach(text=>assert.equal(canonicalSource.includes(text), false, `canonical block must not contain ${text}`));

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
vm.runInContext(canonicalSource, context, {filename:"sde-canonical-readmodel.js"});

const build = input=>context.buildSdeCanonicalPlan(input);
const compare = (plan, legacy)=>context.compareSdeCanonicalPlanWithLegacy(plan, legacy);
const actual = (vehicle, slot, source="grunnoppstilling")=>[{source, selected:true, provenance:`test:${source}`, rows:[{vehicleId:vehicle, slot}]}];
const candidate = (vehicle, fromSlot, targetSlot, cardId, extra={})=>({
  vehicle,
  fromSlot,
  targetSlot,
  cardId,
  actionKey:cardId,
  source:"Ankomstbasert parkeringsbehov",
  ...extra
});

function duplicateScenario(vehicle, fromSlot, firstTarget, secondTarget){
  return {
    actualSources:actual(vehicle, fromSlot),
    candidateRows:[
      candidate(vehicle, fromSlot, firstTarget, `${vehicle}-ordinary`, {needKey:`arrival|${vehicle}|${fromSlot}`, canonicalProducer:"ordinary_base_need"}),
      candidate(vehicle, fromSlot, secondTarget, `${vehicle}-graphic`, {needKey:`night-placement-drag-need|${vehicle}`, canonicalProducer:"graphic_drag_generated_move"})
    ]
  };
}

const duplicate69Input = duplicateScenario("69-63", "10S", "12N", "9");
const duplicate69 = build(duplicate69Input);
assert.equal(duplicate69.obligations.length, 1);
assert.equal(duplicate69.candidateOutcomes.length, 2);
assert.equal(duplicate69.activeOutcomes.length, 0);
assert.ok(duplicate69.conflicts.some(item=>item.code === "competing_targets"));
assert.ok(duplicate69.conflicts.some(item=>item.code === "legacy_identity_ambiguity"));

const duplicate74 = build(duplicateScenario("74-11", "5N", "5S", "4N"));
assert.equal(duplicate74.obligations.length, 1);
assert.equal(duplicate74.candidateOutcomes.length, 2);
assert.equal(duplicate74.activeOutcomes.length, 0);
assert.ok(duplicate74.conflicts.some(item=>item.code === "competing_targets"));

const authoritySelection = build({
  actualSources:actual("74-11", "5N"),
  activeAuthorities:{"legacy-outcome-74-11":"authority-b"},
  candidateRows:[
    candidate("74-11", "5N", "5S", "authority-a", {sdeOutcomeKey:"legacy-outcome-74-11"}),
    candidate("74-11", "5N", "4N", "authority-b", {sdeOutcomeKey:"legacy-outcome-74-11"})
  ]
});
assert.equal(authoritySelection.activeOutcomes.length, 1);
assert.equal(authoritySelection.activeOutcomes[0].candidateId, "authority-b");
assert.equal(authoritySelection.activeOutcomes[0].selectionReason, "unambiguous_existing_authority");

const failClosedInput = {
  actualSources:actual("74-20", "3N"),
  candidateRows:[candidate("74-20", "3N", "", "failclosed-1", {isSdeCancellationFailClosed:true, canonicalProducer:"fail_closed"})]
};
const failClosed = build(failClosedInput);
assert.equal(failClosed.activeOutcomes.length, 0);
assert.equal(failClosed.reservationsPreview.length, 0);
assert.equal(failClosed.overlaysPreview.length, 0);
assert.ok(failClosed.diagnostics.some(item=>item.code === "active_fail_closed_targetless"));

const physicallyInvalid = build({
  actualSources:actual("69-58", "6N"),
  candidateRows:[candidate("69-58", "6N", "9", "invalid-physical", {canonicalPhysicalValid:false, canonicalPhysicalInvalidReason:"Test: fysisk rute ugyldig."})]
});
assert.equal(physicallyInvalid.activeOutcomes.length, 0);
assert.ok(physicallyInvalid.diagnostics.some(item=>item.code === "physically_invalid_candidate"));

const cancelled = build({
  actualSources:actual("69-55", "4N"),
  candidateRows:[
    candidate("69-55", "4N", "4S", "old-card", {status:"dismissing", sdeCancellationDismissalCard:true}),
    candidate("69-55", "4N", "6S", "replacement-card", {isSdeCancellationReplacementMove:true, canonicalProducer:"cancelled_replacement"})
  ]
});
assert.equal(cancelled.exitingCards.length, 1);
assert.equal(cancelled.exitingCards[0].candidateId, "old-card");
assert.equal(cancelled.activeOutcomes.length, 1);
assert.equal(cancelled.activeOutcomes[0].candidateId, "replacement-card");
assert.equal(cancelled.reservationsPreview.length, 1);
assert.equal(cancelled.overlaysPreview.length, 1);

const chainRows = [
  candidate("74-01", "11N", "VN", "chain-step-1", {sdePhysicalChainId:"chain-a", sdePhysicalChainStep:1, sdePhysicalDependencyRole:"prerequisite", canonicalProducer:"temporary_vn_relief"}),
  candidate("69-40", "10S", "12N", "chain-step-2", {sdePhysicalChainId:"chain-a", sdePhysicalChainStep:2, sdePhysicalDependencyRole:"dependent", sdePhysicalDependsOn:["chain-step-1"], canonicalProducer:"physical_blocker_guard"}),
  candidate("74-01", "VN", "11S", "chain-step-3", {sdePhysicalChainId:"chain-a", sdePhysicalChainStep:3, sdePhysicalDependencyRole:"return", sdePhysicalDependsOn:["chain-step-2"], canonicalProducer:"persistent_vn_recovery"})
];
const chain = build({
  actualSources:[{source:"grunnoppstilling", selected:true, rows:[{vehicleId:"74-01", slot:"11N"}, {vehicleId:"69-40", slot:"10S"}]}],
  candidateRows:chainRows
});
assert.equal(chain.activeChains.length, 1);
assert.equal(chain.activeChains[0].steps.length, 3);
assert.equal(chain.activeOutcomes.length, 1);
assert.equal(chain.activeOutcomes[0].candidateId, "chain-step-1");
assert.equal(chain.candidateOutcomes.filter(item=>item.status === "future").length, 2);

const vnRecovery = build({
  actualSources:actual("74-02", "VN"),
  candidateRows:[
    candidate("74-02", "VN", "11S", "vn-concrete", {sdePhysicalChainStep:3, sdePhysicalDependencyRole:"return", sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-obligation-a", canonicalProducer:"persistent_vn_recovery"}),
    candidate("74-02", "VN", "", "vn-fallback", {sdePhysicalChainStep:3, sdePhysicalDependencyRole:"return", sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-obligation-a", sdeVnRecoveryStatus:"ambiguous_recovery_target", canonicalProducer:"orphan_fallback_vn_recovery"})
  ]
});
assert.equal(vnRecovery.obligations.length, 1);
assert.equal(vnRecovery.activeOutcomes.length, 1);
assert.equal(vnRecovery.activeOutcomes[0].candidateId, "vn-concrete");
assert.equal(vnRecovery.reservationsPreview.length, 1);
assert.equal(vnRecovery.overlaysPreview.length, 1);
assert.ok(vnRecovery.diagnostics.some(item=>item.code === "targetless_candidate"));

const actualMismatch = build({
  actualSources:[
    {source:"grunnoppstilling", selected:true, rows:[{vehicleId:"74-11", slot:"5N"}]},
    {source:"computeInndata", rows:[{vehicleId:"74-11", slot:"5N"}, {vehicleId:"74-20", slot:"VN"}]}
  ],
  candidateRows:[]
});
assert.equal(actualMismatch.actualPlacements.length, 1);
assert.ok(actualMismatch.diagnostics.some(item=>item.code === "actual_source_mismatch" && item.vehicleId === "74-20"));

const overlap = build({
  actualSources:[{source:"grunnoppstilling", selected:true, rows:[{vehicleId:"69-41", slot:"1N"}, {vehicleId:"69-42", slot:"2N"}]}],
  candidateRows:[candidate("69-41", "1N", "9", "overlap-a"), candidate("69-42", "2N", "9", "overlap-b")]
});
assert.ok(overlap.conflicts.some(item=>item.code === "overlapping_target_reservation"));
assert.equal(overlap.activeOutcomes.length, 0);
assert.equal(overlap.reservationsPreview.length, 0);

const sequentialReuse = build({
  actualSources:[{source:"grunnoppstilling", selected:true, rows:[{vehicleId:"69-41", slot:"2S"}, {vehicleId:"69-42", slot:"3N"}]}],
  completedActionKeys:["reuse-step-1", "reuse-step-2"],
  candidateRows:[
    candidate("69-41", "1N", "9", "reuse-step-1", {actionStatus:"completed", sdePhysicalChainId:"reuse-chain", sdePhysicalChainStep:1}),
    candidate("69-41", "9", "2S", "reuse-step-2", {actionStatus:"completed", sdePhysicalChainId:"reuse-chain", sdePhysicalChainStep:2, sdePhysicalDependsOn:["reuse-step-1"]}),
    candidate("69-42", "3N", "9", "reuse-step-3", {sdePhysicalChainId:"reuse-chain", sdePhysicalChainStep:3, sdePhysicalDependsOn:["reuse-step-2"]})
  ]
});
assert.equal(sequentialReuse.activeChains.length, 1);
assert.equal(sequentialReuse.activeChains[0].steps.length, 3);
assert.equal(sequentialReuse.activeOutcomes.length, 1);
assert.equal(sequentialReuse.activeOutcomes[0].candidateId, "reuse-step-3");
assert.equal(sequentialReuse.reservationsPreview[0].targetSlot, "9");
assert.equal(sequentialReuse.conflicts.some(item=>item.code === "overlapping_target_reservation"), false);

const legacyComparison = compare(duplicate69, {
  finalCards:duplicate69Input.candidateRows,
  activeCount:2,
  reservations:[{slot:"12N"}, {slot:"9"}],
  overlays:[{slot:"12N"}]
});
assert.ok(legacyComparison.classifications.includes("legacy_duplicate"));
assert.ok(legacyComparison.classifications.includes("canonical_ambiguity"));
assert.ok(legacyComparison.classifications.includes("legacy_missing_overlay"));

const integratedComparison = build({
  ...duplicate69Input,
  legacySnapshot:{
    finalCards:duplicate69Input.candidateRows,
    activeCount:2,
    reservations:[{slot:"12N"}, {slot:"9"}],
    overlays:[{slot:"12N"}]
  }
});
assert.ok(integratedComparison.legacyComparison.classifications.includes("legacy_duplicate"));
assert.ok(integratedComparison.conflicts.some(item=>item.type === "legacy_comparison"));

const serializedInputBefore = JSON.stringify(duplicate69Input);
const serializedRuns = [build(duplicate69Input), build(duplicate69Input), build(duplicate69Input)].map(JSON.stringify);
assert.equal(serializedRuns[0], serializedRuns[1]);
assert.equal(serializedRuns[1], serializedRuns[2]);
assert.equal(JSON.stringify(duplicate69Input), serializedInputBefore);

const representativeInput = {
  actualSources:[{source:"grunnoppstilling", selected:true, rows:Array.from({length:120}, (_,index)=>({vehicleId:`T-${index + 1}`, slot:`S-${index + 1}`}))}],
  candidateRows:Array.from({length:120}, (_,index)=>candidate(`T-${index + 1}`, `S-${index + 1}`, `M-${index + 1}`, `perf-${index + 1}`, {recommendationScore:80}))
};
const startTime = performance.now();
const representative = build(representativeInput);
const runtimeMs = performance.now() - startTime;
assert.equal(representative.metadata.rawCandidateCount, 120);
assert.equal(representative.metadata.obligationCount, 120);
assert.equal(representative.metadata.conflictCount, 0);
assert.ok(runtimeMs < 1000, `representative runtime ${runtimeMs.toFixed(2)} ms is unexpectedly high`);

console.log(JSON.stringify({
  ok:true,
  inlineScriptsParsed:scripts.length,
  scenarios:{
    duplicate69:{candidates:duplicate69.candidateOutcomes.length, obligations:duplicate69.obligations.length, active:duplicate69.activeOutcomes.length, conflicts:duplicate69.conflicts.map(item=>item.code)},
    duplicate74:{candidates:duplicate74.candidateOutcomes.length, obligations:duplicate74.obligations.length, active:duplicate74.activeOutcomes.length, conflicts:duplicate74.conflicts.map(item=>item.code)},
    authoritySelection:{active:authoritySelection.activeOutcomes.length, candidateId:authoritySelection.activeOutcomes[0].candidateId, reason:authoritySelection.activeOutcomes[0].selectionReason},
    failClosed:{active:failClosed.activeOutcomes.length, diagnostics:failClosed.diagnostics.map(item=>item.code)},
    physicallyInvalid:{active:physicallyInvalid.activeOutcomes.length, diagnostics:physicallyInvalid.diagnostics.map(item=>item.code)},
    cancelled:{active:cancelled.activeOutcomes.length, exiting:cancelled.exitingCards.length},
    chain:{active:chain.activeOutcomes.length, steps:chain.activeChains[0].steps.length},
    vnRecovery:{active:vnRecovery.activeOutcomes.length, diagnostics:vnRecovery.diagnostics.map(item=>item.code)},
    actualMismatch:{diagnostics:actualMismatch.diagnostics.map(item=>item.code)},
    overlap:{active:overlap.activeOutcomes.length, conflicts:overlap.conflicts.map(item=>item.code)},
    sequentialReuse:{active:sequentialReuse.activeOutcomes.length, target:sequentialReuse.reservationsPreview[0].targetSlot},
    legacyComparison:legacyComparison.classifications
  },
  representative:{rawCandidates:representative.metadata.rawCandidateCount, obligations:representative.metadata.obligationCount, conflicts:representative.metadata.conflictCount, runtimeMs:Number(runtimeMs.toFixed(3))}
}, null, 2));

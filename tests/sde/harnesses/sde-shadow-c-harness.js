const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const indexPath = process.argv[2];
const html = fs.readFileSync(indexPath, "utf8");
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  .map(match=>match[1])
  .find(source=>source.includes("function normalizeSdeCanonicalToken")) || "";
const start = script.indexOf("function normalizeSdeCanonicalToken");
const end = script.indexOf("function getSdeMoveCardDisplayIndex");
assert(start >= 0 && end > start, "canonical/shadow block not found");
const block = script.slice(start, end);

global.normalizeSlot = value => String(value || "").trim().toUpperCase();
global.sanitizeVehicleValue = value => String(value || "").trim();
global.getSdeShiftSnapshotHash = value => {
  let hash = 0;
  for(const character of String(value || "")) hash = (Math.imul(31, hash) + character.charCodeAt(0)) | 0;
  return `h${(hash >>> 0).toString(16)}`;
};
global.window = {};
vm.runInThisContext(block, {filename:"canonical-shadow-block.js"});

const buildSnapshot = vm.runInThisContext("buildSdeCanonicalShadowRuntimeSnapshot");
const buildReport = vm.runInThisContext("buildSdeCanonicalShadowReport");
assert.strictEqual(window.__sdeCanonicalShadowReport, undefined, "shadow must be default-off");
assert.strictEqual(typeof window.runSdeCanonicalShadowAnalysis, "function");
window.location = {search:""};
assert.strictEqual(vm.runInThisContext("isSdeCanonicalShadowAnalysisRequested()"), false);
window.location = {search:"?sdeCanonicalShadow=1"};
assert.strictEqual(vm.runInThisContext("isSdeCanonicalShadowAnalysisRequested()"), true);

const actual = (vehicle, slot, alternatives=[]) => [
  {source:"canonical-actual", selected:true, rows:vehicle ? [{slot, mat:vehicle}] : []},
  {source:"computed-input", rows:alternatives.length ? alternatives : vehicle ? [{slot, mat:vehicle}] : []}
];
const row = (vehicle, fromSlot, targetSlot, key, extra={}) => ({
  vehicle,
  fromSlot,
  recommendedSlot:targetSlot,
  toSlot:targetSlot,
  stableActionKey:key,
  needKey:`need-${vehicle}`,
  source:"SDE",
  ...extra
});
const reservation = item => ({slot:item.recommendedSlot, vehicle:item.vehicle, activeOutcomeId:item.stableActionKey});
const overlay = item => ({targetSlot:item.recommendedSlot, sourceSlot:item.fromSlot, vehicle:item.vehicle, activeOutcomeId:item.stableActionKey});
const fixture = ({actualSources, finalCards, activeCards=finalCards, reservations=[], overlays=[], runtimeState={}}) => buildSnapshot({
  actualSources,
  rawMoves:finalCards,
  finalCards,
  activeCards,
  activeCount:activeCards.length,
  legacyReservations:reservations,
  legacyOverlays:overlays,
  runtimeState
});
const normalized = report => {
  const copy = JSON.parse(JSON.stringify(report));
  delete copy.generatedAt;
  delete copy.performance;
  return JSON.stringify(copy);
};
const reportFor = input => buildReport(input, {generatedAt:"2026-07-13T00:00:00.000Z", snapshotMs:0});
const has = (report, code) => report.classifications.includes(code);

function duplicateScenario(vehicle, source, firstTarget, secondTarget){
  const first = row(vehicle, source, firstTarget, `${vehicle}-a`, {needKey:`need-${vehicle}-a`});
  const second = row(vehicle, source, secondTarget, `${vehicle}-b`, {needKey:`need-${vehicle}-b`});
  const report = reportFor(fixture({
    actualSources:actual(vehicle, source),
    finalCards:[first, second],
    reservations:[reservation(first), reservation(second)],
    overlays:[overlay(first), overlay(second)]
  }));
  assert.strictEqual(report.canonicalSummary.obligationCount, 1);
  assert.strictEqual(report.canonicalSummary.stepCount, 1);
  assert.strictEqual(report.canonicalSummary.candidateCount, 2);
  assert.strictEqual(report.canonicalSummary.activeOutcomeCount, 0);
  ["LEGACY_DUPLICATE_CARD","LEGACY_DUPLICATE_TARGET","LEGACY_DUPLICATE_RESERVATION","LEGACY_DUPLICATE_OVERLAY","CANONICAL_AMBIGUITY","LEGACY_ONLY"]
    .forEach(code=>assert(has(report, code), `${vehicle} missing ${code}`));
  return report;
}

const report6963 = duplicateScenario("69-63", "10S", "12N", "9");
const report7411 = duplicateScenario("74-11", "5N", "5S", "4N");

const matchCard = row("68-01", "6", "8", "match");
const matchReport = reportFor(fixture({
  actualSources:actual("68-01", "6"),
  finalCards:[matchCard],
  reservations:[reservation(matchCard)],
  overlays:[overlay(matchCard)]
}));
assert.deepStrictEqual(matchReport.classifications, ["MATCH"]);
const missingOverlayReport = reportFor(fixture({actualSources:actual("68-01", "6"), finalCards:[matchCard]}));
assert(has(missingOverlayReport, "LEGACY_CARD_MISSING_OVERLAY"));
const orphanOverlayReport = reportFor(fixture({
  actualSources:actual("", ""),
  finalCards:[],
  activeCards:[],
  overlays:[{targetSlot:"8", sourceSlot:"6", vehicle:"orphan", activeOutcomeId:"orphan-overlay"}]
}));
assert(has(orphanOverlayReport, "LEGACY_OVERLAY_WITHOUT_CARD"));
const invalidCard = row("68-02", "6", "9", "invalid", {canonicalPhysicalValid:false, canonicalPhysicalInvalidReason:"Fixture-invalid"});
const invalidReport = reportFor(fixture({actualSources:actual("68-02", "6"), finalCards:[invalidCard]}));
assert(has(invalidReport, "LEGACY_PHYSICALLY_INVALID_CARD"));
const canonicalOnlyReport = reportFor(fixture({actualSources:actual("68-01", "6"), finalCards:[matchCard], activeCards:[]}));
assert(has(canonicalOnlyReport, "CANONICAL_ONLY"));

const targetless = row("70-01", "8", "", "targetless", {isSdeCancellationFailClosed:true, recommendationReason:"Ingen trygg løsning"});
const targetlessReport = reportFor(fixture({actualSources:actual("70-01", "8"), finalCards:[targetless]}));
assert(has(targetlessReport, "LEGACY_TARGETLESS_ACTION_CARD"));
assert.strictEqual(targetlessReport.canonicalSummary.activeOutcomeCount, 0);
assert.strictEqual(targetlessReport.canonicalSummary.reservationCount, 0);
assert.strictEqual(targetlessReport.canonicalSummary.overlayCount, 0);
assert(targetlessReport.diagnostics.some(item=>item.code === "active_fail_closed_targetless"));

const exiting = row("71-02", "7", "11", "old", {status:"dismissing", sdeCancellationDismissalCard:true});
const replacement = row("71-02", "7", "12N", "new", {isSdeCancellationReplacementMove:true});
const exitingReport = reportFor(fixture({
  actualSources:actual("71-02", "7"),
  finalCards:[exiting, replacement],
  activeCards:[replacement],
  reservations:[reservation(replacement)],
  overlays:[overlay(replacement)]
}));
assert(has(exitingReport, "EXITING_CARD_ONLY"));
assert(!has(exitingReport, "LEGACY_DUPLICATE_CARD"));
assert.strictEqual(exitingReport.canonicalSummary.activeOutcomeCount, 1);

const chain = [
  row("72-03", "VN", "VS", "chain-1", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-chain", sdePhysicalChainId:"vn-chain", sdePhysicalChainStep:1, canonicalChainStepActive:true}),
  row("72-03", "VS", "9", "chain-2", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-chain", sdePhysicalChainId:"vn-chain", sdePhysicalChainStep:2, sdePhysicalDependsOn:["chain-1"]}),
  row("72-03", "9", "10S", "chain-3", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-chain", sdePhysicalChainId:"vn-chain", sdePhysicalChainStep:3, sdePhysicalDependsOn:["chain-2"]})
];
const chainReport = reportFor(fixture({
  actualSources:actual("72-03", "VN"),
  finalCards:chain,
  activeCards:[chain[0]],
  reservations:[reservation(chain[0])],
  overlays:[overlay(chain[0])]
}));
assert.strictEqual(chainReport.canonicalSummary.obligationCount, 1);
assert.strictEqual(chainReport.canonicalSummary.stepCount, 3);
assert(has(chainReport, "LEGITIMATE_CHAIN_DIFFERENCE"));
assert(!has(chainReport, "LEGACY_DUPLICATE_CARD"));
assert(chainReport.obligationComparisons.some(item=>item.canonical.candidateOutcomes.some(candidate=>candidate.dependencies.length)));

const recovery = row("73-04", "VN", "VS", "vn-concrete", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-recovery-73"});
const fallback = row("73-04", "VN", "", "vn-fallback", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-recovery-73", sdeVnRecoveryStatus:"missing_recovery_metadata"});
const vnReport = reportFor(fixture({
  actualSources:actual("73-04", "VN"),
  finalCards:[recovery, fallback],
  activeCards:[recovery, fallback],
  reservations:[reservation(recovery)],
  overlays:[overlay(recovery)]
}));
assert.strictEqual(vnReport.canonicalSummary.activeOutcomeCount, 1);
assert(has(vnReport, "LEGACY_DUPLICATE_CARD"));
assert(has(vnReport, "LEGACY_TARGETLESS_ACTION_CARD"));
assert(vnReport.diagnostics.some(item=>item.code === "targetless_candidate"));

const mismatchRow = row("74-05", "VN", "VS", "actual-mismatch", {sdeVnRecoveryRequired:true, sdeVnRecoveryObligationId:"vn-recovery-74"});
const mismatchReport = reportFor(fixture({
  actualSources:actual("", "", [{slot:"VN", mat:"74-05"}]),
  finalCards:[mismatchRow]
}));
assert(has(mismatchReport, "ACTUAL_SOURCE_MISMATCH"));
assert(mismatchReport.actualStateDifferences.some(item=>item.code === "actual_source_mismatch"));

const deterministicFixture = fixture({
  actualSources:actual("69-63", "10S"),
  finalCards:[
    row("69-63", "10S", "12N", "det-a", {needKey:"det-a"}),
    row("69-63", "10S", "9", "det-b", {needKey:"det-b"})
  ]
});
const before = JSON.stringify(deterministicFixture);
const baseline = normalized(reportFor(deterministicFixture));
for(let index = 0; index < 3; index += 1) assert.strictEqual(normalized(reportFor(deterministicFixture)), baseline);
assert.strictEqual(JSON.stringify(deterministicFixture), before, "shadow mutated input");
for(let index = 0; index < 10; index += 1){
  const permuted = JSON.parse(JSON.stringify(deterministicFixture));
  if(index % 2) permuted.rawMoves.reverse();
  if(index % 3) permuted.legacy.finalCards.reverse();
  if(index % 4) permuted.legacy.activeCards.reverse();
  permuted.runtimeState.actions = index % 2 ? {b:{action:"cancelled"},a:{action:"completed"}} : {a:{action:"completed"},b:{action:"cancelled"}};
  const rebuilt = buildSnapshot({
    actualSources:permuted.actualSources,
    rawMoves:permuted.rawMoves,
    finalCards:permuted.legacy.finalCards,
    activeCards:permuted.legacy.activeCards,
    activeCount:permuted.legacy.activeCount,
    legacyReservations:permuted.legacy.reservations,
    legacyOverlays:permuted.legacy.overlays,
    runtimeState:permuted.runtimeState
  });
  if(index === 0) continue;
  const reference = buildSnapshot({
    actualSources:deterministicFixture.actualSources,
    rawMoves:deterministicFixture.rawMoves,
    finalCards:deterministicFixture.legacy.finalCards,
    activeCards:deterministicFixture.legacy.activeCards,
    activeCount:deterministicFixture.legacy.activeCount,
    runtimeState:{actions:{a:{action:"completed"},b:{action:"cancelled"}}}
  });
  assert.strictEqual(normalized(reportFor(rebuilt)), normalized(reportFor(reference)), `permutation ${index}`);
}

const scaleCards = Array.from({length:200}, (_,index)=>row(`scale-${index}`, `S${index}`, `T${index}`, `scale-${index}`));
const scaleSnapshot = fixture({
  actualSources:[{source:"canonical-actual", selected:true, rows:scaleCards.map((item,index)=>({slot:`S${index}`, mat:item.vehicle}))}],
  finalCards:scaleCards,
  activeCards:scaleCards
});
const scaleReport = window.runSdeCanonicalShadowAnalysis({snapshot:scaleSnapshot, publish:false, generatedAt:"2026-07-13T00:00:00.000Z"});
assert.strictEqual(window.__sdeCanonicalShadowReport, undefined, "publish:false must not publish report");
assert.strictEqual(scaleReport.canonicalSummary.candidateCount, 200);
assert(scaleReport.performance.totalMs < 5000, `scale runtime ${scaleReport.performance.totalMs}ms`);

const forbidden = ["document.","innerHTML","localStorage","fetch(","XMLHttpRequest","setTimeout(","setInterval(","addEventListener("];
for(const token of forbidden) assert(!block.slice(block.indexOf("const SDE_CANONICAL_SHADOW_CLASSIFICATIONS")).includes(token), `forbidden shadow token ${token}`);

console.log(JSON.stringify({
  ok:true,
  scenarios:["match","69-63","74-11","targetless","physical-invalid","exiting","legitimate-chain","vn-recovery","actual-source","missing-overlay","orphan-overlay","canonical-only"],
  deterministicRuns:3,
  permutations:10,
  scaleCandidates:200,
  performance:scaleReport.performance,
  reportClassifications:report6963.classifications,
  secondDuplicateClassifications:report7411.classifications
}, null, 2));

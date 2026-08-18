"use strict";

const fs = require("node:fs");
const path = require("node:path");
const engine = require("../../sde_tursatt_post_arrival.js");

const root = path.resolve(__dirname, "../..");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

function arrival(train, time, sortMinutes, vehicles, revision = "gate-rev-1") {
  return {
    role: "arrival",
    operationalDate: "2026-08-18",
    stationRef: "SKN",
    train,
    time,
    sortMinutes,
    occurrenceId: `gate-arrival-${train}`,
    sourceRevision: revision,
    slot: "1N",
    vehicles: vehicles.map((vehicle, index) => ({vehicle, part: String(index + 1), slot: index ? "1S" : "1N"})),
  };
}

function departure(train, time, sortMinutes, vehicles) {
  return {
    role: "departure",
    operationalDate: "2026-08-19",
    stationRef: "SKN",
    train,
    time,
    sortMinutes,
    occurrenceId: `gate-departure-${train}`,
    sourceRevision: "gate-rev-1",
    vehicles: vehicles.map((vehicle, index) => ({vehicle, part: String(index + 1)})),
  };
}

const arrivals = [
  arrival("835", "23:53", 1433, ["GATE-A", "GATE-B"]),
  arrival("837", "00:50 +1", 1490, ["GATE-C"]),
  arrival("839", "01:45 +1", 1545, ["GATE-D"]),
];
const departures = [
  departure("808", "01:00 +1", 1500, ["GATE-A", "GATE-B"]),
  departure("810", "02:00 +1", 1560, ["GATE-C"]),
  departure("812", "02:55 +1", 1615, ["GATE-D"]),
];

function createPlan(currentArrivals = arrivals, currentDepartures = departures) {
  return engine.createTursattPostArrivalPlan({
    arrivals: currentArrivals,
    departures: currentDepartures,
    selectTarget: need => ({safe: true, slot: need.part === "2" ? "11S" : "10S", searchedSlots: ["10S", "11S", "VN", "VS"]}),
    resolveRoute: () => ({planKind: "DIRECT", routeResources: [engine.TURSATT_SHIFT_WINDOW_CONTRACT.resourceId]}),
  });
}

const plan = createPlan();
const mainCards = plan.cards.filter(card => card.cardRole === "MAIN");
const chronology = mainCards.map(card => card.arrivalTrainNumber);
const overlaps = mainCards.slice(1).filter((card, index) => card.plannedWindowStartMinutes < mainCards[index].plannedWindowEndMinutes);
const duplicateCardIds = mainCards.length - new Set(mainCards.map(card => card.cardId)).size;
const completedLifecycleKey = mainCards[0]?.lifecycleKey || "";
const completedReplay = engine.createTursattPostArrivalPlan({
  arrivals,
  departures,
  completedLifecycleKeys: [completedLifecycleKey],
  selectTarget: need => ({safe: true, slot: need.part === "2" ? "11S" : "10S"}),
  resolveRoute: () => ({planKind: "DIRECT"}),
});

const permutationPlans = [
  ["GATE-A", "GATE-B", "GATE-C", "GATE-D"],
  ["PERM-1", "PERM-2", "PERM-3", "PERM-4"],
  ["ALT-A", "ALT-B", "ALT-C", "ALT-D"],
].map(ids => createPlan(
  [
    arrival("835", "23:53", 1433, [ids[0], ids[1]]),
    arrival("837", "00:50 +1", 1490, [ids[2]]),
    arrival("839", "01:45 +1", 1545, [ids[3]]),
  ],
  [
    departure("808", "01:00 +1", 1500, [ids[0], ids[1]]),
    departure("810", "02:00 +1", 1560, [ids[2]]),
    departure("812", "02:55 +1", 1615, [ids[3]]),
  ],
));
const permutationSignatures = permutationPlans.map(engine.planStructureSignature);

const integrationAssertions = {
  moduleLoadedBeforeInlineApp: /<script src="sde_tursatt_post_arrival\.js\?v=[a-f0-9]{64}"><\/script>\s*<script>/.test(indexSource),
  productBuildsOccurrenceNeeds: /function buildSdeTursattPostArrivalShiftNeeds\(/.test(indexSource),
  productUsesCanonicalCandidateEngine: /getSdeArrivalParkingRecommendation\(need, reservedForNeed\)/.test(indexSource),
  productUsesCanonicalTopologyCompiler: /buildSdePhysicalBlockerGuardMoves\(/.test(indexSource),
  productRendersTimeWindow: /data-sde-tursatt-post-arrival-window="1"/.test(indexSource),
  nonTursattCardsNeverReceiveTursattRole: /function getSdeTursattPostArrivalCardRole\(row\)\{\s*if\(!row\?\.isTursattPostArrivalShiftNeed\) return "";/.test(indexSource),
  lifecycleKeyOwnsNeed: /tursattPostArrivalLifecycleKey/.test(indexSource),
  emptyDraftUsesTombstone: /empty-draft-tombstone/.test(indexSource) && /sharedReset:isEffectiveReset/.test(indexSource),
};

const assertions = {
  requiredAndGeneratedCountsMatch: plan.requiredMainObligationCount === plan.generatedMainObligationCount,
  everyRequiredVehicleHasMain: plan.requiredMainObligationCount === 4 && mainCards.length === 4,
  forcedTrainCounts: ["835", "837", "839"].every(train =>
    mainCards.filter(card => card.arrivalTrainNumber === train).length === (train === "835" ? 2 : 1)
  ),
  chronologicalOrder: JSON.stringify(chronology) === JSON.stringify(["835", "835", "837", "839"]),
  everyMainHasWindow: mainCards.every(card => card.plannedWindowStart && card.plannedWindowEnd && card.windowStatus === "ASSIGNED"),
  overlappingTimeWindows: overlaps.length === 0,
  pollingDuplicates: duplicateCardIds === 0,
  completedCardRecreated: completedReplay.cards.some(card => card.lifecycleKey === completedLifecycleKey) === false,
  vehicleIdPermutationInvariant: permutationSignatures.every(signature => signature === permutationSignatures[0]),
  actualPlacementBeforeCompletion: plan.sideEffectPolicy === "READ_ONLY_UNTIL_AUTHORIZED_COMPLETION",
  ...integrationAssertions,
};

const diagnostics = mainCards.map(card => ({
  operationalDate: card.operationalDate,
  tursattOccurrence: card.sourceOccurrenceId,
  arrivalTrain: card.arrivalTrainNumber,
  arrivalTime: card.arrivalTime,
  vehicleId: card.vehicleId,
  shiftNeedReason: card.reason,
  mainObligationExists: true,
  cardId: card.cardId,
  target: card.targetSlot,
  timeWindow: `${card.plannedWindowStart}–${card.plannedWindowEnd}`,
  dependency: card.dependency,
  planKind: card.planKind,
  missingPlanObjects: [],
}));

const failedAssertions = Object.entries(assertions).filter(([, passed]) => passed !== true).map(([name]) => name);
const report = {
  schemaVersion: "sde-tursatt-post-arrival-shift-cards-gate-v1",
  gateId: "TURSATT-POST-ARRIVAL-SHIFT-CARDS",
  status: failedAssertions.length ? "RED" : "GREEN",
  requiredMainObligationCount: plan.requiredMainObligationCount,
  generatedMainObligationCount: plan.generatedMainObligationCount,
  overlappingTimeWindows: overlaps.length,
  pollingDuplicateCards: duplicateCardIds,
  assertions,
  failedAssertions,
  diagnostics,
};

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = failedAssertions.length ? 1 : 0;

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const MODULE_PATH = process.env.SDE_TURSATT_POST_ARRIVAL_MODULE
  ? path.resolve(process.env.SDE_TURSATT_POST_ARRIVAL_MODULE)
  : path.join(ROOT, "sde_tursatt_post_arrival.js");

function subject() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

function arrival(train, time, vehicles, options = {}) {
  return {
    role: "arrival",
    operationalDate: options.operationalDate || "2026-08-18",
    station: "Skien",
    stationRef: "SKN",
    train: String(train),
    displayTrain: String(train),
    time,
    displayTime: time,
    sortMinutes: options.sortMinutes,
    actualArrival: options.actualArrival || "",
    occurrenceId: options.occurrenceId || `arrival-${train}-${time}`,
    sourceRevision: options.sourceRevision || "rev-1",
    slot: options.slot || "1N",
    movement: "arrival",
    direction: "arrival",
    vehicles: vehicles.map((vehicle, index) => ({vehicle, part: String(index + 1)})),
  };
}

function departure(train, time, vehicles, options = {}) {
  return {
    role: "departure",
    operationalDate: options.operationalDate || "2026-08-19",
    station: "Skien",
    stationRef: "SKN",
    train: String(train),
    displayTrain: String(train),
    time,
    displayTime: time,
    sortMinutes: options.sortMinutes,
    occurrenceId: options.occurrenceId || `departure-${train}-${time}`,
    sourceRevision: options.sourceRevision || "rev-1",
    movement: "departure",
    direction: "departure",
    vehicles: vehicles.map((vehicle, index) => ({vehicle, part: String(index + 1)})),
  };
}

function directOptions(overrides = {}) {
  return {
    selectTarget: need => ({safe: true, slot: need.part === "2" ? "11S" : "10S", searchedSlots: ["10S", "11S", "VN"]}),
    resolveRoute: () => ({planKind: "DIRECT", routeResources: ["SDE-SHUNT-RESOURCE"]}),
    ...overrides,
  };
}

function plan(arrivals, departures = [], options = {}) {
  return subject().createTursattPostArrivalPlan({arrivals, departures, ...directOptions(options)});
}

function mainCards(result) {
  return result.cards.filter(card => card.cardRole === "MAIN");
}

test("01 split removal creates exactly one MAIN obligation", () => {
  const result = plan(
    [arrival("821", "20:00", ["74-01", "74-02"], {sortMinutes: 1200})],
    [departure("840", "20:30", ["74-01"], {sortMinutes: 1230})],
  );
  assert.deepEqual(mainCards(result).map(card => card.vehicleId), ["74-02"]);
});

test("02 two removed vehicles create two distinct MAIN obligations", () => {
  const result = plan(
    [arrival("821", "20:00", ["74-01", "74-02"], {sortMinutes: 1200})],
    [departure("840", "20:30", ["74-03"], {sortMinutes: 1230})],
  );
  assert.equal(mainCards(result).length, 2);
  assert.equal(new Set(mainCards(result).map(card => card.obligationId)).size, 2);
});

test("03 no later departure still creates a shift need for every unambiguous vehicle", () => {
  const result = plan([arrival("851", "21:00", ["74-08", "74-09"], {sortMinutes: 1260})]);
  assert.equal(result.needs.length, 2);
  assert.equal(mainCards(result).length, 2);
});

test("04 later non-immediate use constrains but never cancels immediate shunting", () => {
  const result = plan(
    [arrival("851", "21:00", ["74-08"], {sortMinutes: 1260})],
    [departure("862", "01:10 +1", ["74-08"], {sortMinutes: 1510})],
  );
  assert.equal(result.needs.length, 1);
  assert.equal(result.needs[0].nextUseOccurrence.train, "862");
  assert.equal(result.needs[0].requiresPostArrivalShunt, true);
});

test("05 train 835 with one vehicle creates one MAIN card", () => {
  assert.equal(mainCards(plan(
    [arrival("835", "23:53", ["74-20"], {sortMinutes: 1433})],
    [departure("808", "00:20 +1", ["74-20"], {sortMinutes: 1460})],
  )).length, 1);
});

test("06 train 835 with two vehicles creates separate MAIN cards", () => {
  const cards = mainCards(plan(
    [arrival("835", "23:53", ["74-20", "74-47"], {sortMinutes: 1433})],
    [departure("808", "00:20 +1", ["74-20", "74-47"], {sortMinutes: 1460})],
  ));
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].obligationId, cards[1].obligationId);
});

test("07 train 837 applies to its dynamic consist", () => {
  const cards = mainCards(plan(
    [arrival("837", "00:50 +1", ["69-63", "75-76"], {sortMinutes: 1490})],
    [departure("810", "01:10 +1", ["69-63", "75-76"], {sortMinutes: 1510})],
  ));
  assert.deepEqual(cards.map(card => card.vehicleId).sort(), ["69-63", "75-76"]);
});

test("08 train 839 creates a card even when the vehicle is used later", () => {
  const result = plan(
    [arrival("839", "01:45 +1", ["74-06"], {sortMinutes: 1545})],
    [departure("808", "02:10 +1", ["74-06"], {sortMinutes: 1570})],
  );
  assert.equal(mainCards(result).length, 1);
  assert.equal(result.needs[0].nextUseOccurrence.train, "808");
});

test("09 forced train rules contain no fixed vehicle binding", () => {
  const api = subject();
  const source = fs.readFileSync(MODULE_PATH, "utf8");
  assert.deepEqual(
    [...api.TURSATT_FORCE_POST_ARRIVAL_SHUNT_TRAINS],
    ["835", "837", "839", "851", "853", "855", "861", "863"],
  );
  assert.doesNotMatch(source, /(?:69|70|72|74|75)-\d{2}/);
});

test("10 post-midnight cards are ordered 835 then 837 then 839", () => {
  const result = plan([
    arrival("839", "01:45 +1", ["74-03"], {sortMinutes: 1545}),
    arrival("835", "23:53", ["74-01"], {sortMinutes: 1433}),
    arrival("837", "00:50 +1", ["74-02"], {sortMinutes: 1490}),
  ]);
  assert.deepEqual(mainCards(result).map(card => card.arrivalTrainNumber), ["835", "837", "839"]);
});

test("11 every MAIN card has a complete assigned time window", () => {
  const cards = mainCards(plan([
    arrival("835", "23:53", ["74-01"], {sortMinutes: 1433}),
    arrival("837", "00:50 +1", ["74-02"], {sortMinutes: 1490}),
  ]));
  for (const card of cards) {
    assert.match(card.plannedWindowStart, /^\d{2}:\d{2}(?: \+\d+)?$/);
    assert.match(card.plannedWindowEnd, /^\d{2}:\d{2}(?: \+\d+)?$/);
    assert.equal(card.windowStatus, "ASSIGNED");
    assert.ok(card.windowReason);
    assert.ok(card.arrivalReadyAt);
    assert.ok(Number.isInteger(card.sequenceIndex));
  }
});

test("12 serialized Tursatt windows do not overlap", () => {
  const cards = mainCards(plan([
    arrival("835", "23:53", ["74-01", "74-02"], {sortMinutes: 1433}),
    arrival("837", "00:02 +1", ["74-03"], {sortMinutes: 1442}),
  ]));
  for (let index = 1; index < cards.length; index += 1) {
    assert.ok(cards[index].plannedWindowStartMinutes >= cards[index - 1].plannedWindowEndMinutes);
  }
});

test("13 delayed actual arrival deterministically shifts this and later windows", () => {
  const baseArrivals = [
    arrival("835", "23:53", ["74-01"], {sortMinutes: 1433}),
    arrival("837", "00:50 +1", ["74-02"], {sortMinutes: 1490}),
    arrival("839", "01:45 +1", ["74-03"], {sortMinutes: 1545}),
  ];
  const baseline = mainCards(plan(baseArrivals));
  const delayedInput = baseArrivals.map(item => item.train === "837" ? {...item, actualArrival: "01:42 +1"} : item);
  const delayed = mainCards(plan(delayedInput));
  const replay = mainCards(plan(delayedInput));
  assert.ok(delayed[1].plannedWindowStartMinutes > baseline[1].plannedWindowStartMinutes);
  assert.ok(delayed[2].plannedWindowStartMinutes >= delayed[1].plannedWindowEndMinutes);
  assert.deepEqual(delayed.map(card => [card.plannedWindowStart, card.plannedWindowEnd]), replay.map(card => [card.plannedWindowStart, card.plannedWindowEnd]));
});

test("14 safe direct target compiles one MAIN card", () => {
  const result = plan([arrival("835", "23:53", ["74-01"], {sortMinutes: 1433})]);
  assert.deepEqual(result.cards.map(card => card.cardRole), ["MAIN"]);
  assert.equal(result.cards[0].planKind, "DIRECT");
});

test("15 blocked access compiles RELEASE then MAIN then RECOVERY", () => {
  const result = plan(
    [arrival("835", "23:53", ["74-01"], {sortMinutes: 1433})],
    [],
    {
      resolveRoute: () => ({
        planKind: "RELEASE_MAIN_RECOVERY",
        release: {vehicleId: "74-99", sourceSlot: "10N", targetSlot: "VN"},
        recovery: {vehicleId: "74-99", sourceSlot: "VN", targetSlot: "10N"},
        routeResources: ["SDE-SHUNT-RESOURCE"],
      }),
    },
  );
  assert.deepEqual(result.cards.map(card => card.cardRole), ["RELEASE", "MAIN", "RECOVERY"]);
  assert.equal(result.cards[1].dependencyIds.length, 1);
  assert.equal(result.cards[2].dependencyIds.length, 1);
});

test("16 required vehicle count equals MAIN obligation count", () => {
  const result = plan([
    arrival("835", "23:53", ["74-01", "74-02"], {sortMinutes: 1433}),
    arrival("837", "00:50 +1", ["74-03", "74-04"], {sortMinutes: 1490}),
  ]);
  assert.equal(result.requiredMainObligationCount, 4);
  assert.equal(result.generatedMainObligationCount, 4);
});

test("17 remaining chain cards survive completion of RELEASE", () => {
  const api = subject();
  const initial = plan(
    [arrival("835", "23:53", ["74-01"], {sortMinutes: 1433})], [],
    {resolveRoute: () => ({planKind: "RELEASE_MAIN_RECOVERY", release: {vehicleId: "74-99", sourceSlot: "10N", targetSlot: "VN"}, recovery: {vehicleId: "74-99", sourceSlot: "VN", targetSlot: "10N"}})},
  );
  const release = initial.cards[0];
  const reconciled = api.reconcileShiftCards(initial.cards.slice(1), initial.cards, {completedCardIds: [release.cardId]});
  assert.deepEqual(reconciled.cards.map(card => card.cardRole), ["MAIN", "RECOVERY"]);
});

test("18 planning never mutates actual placement", () => {
  const actual = Object.freeze({"74-01": "1N", "74-99": "10N"});
  const before = JSON.stringify(actual);
  const result = plan([arrival("835", "23:53", ["74-01"], {sortMinutes: 1433})], [], {actualPlacement: actual});
  assert.equal(JSON.stringify(actual), before);
  assert.equal(result.sideEffectPolicy, "READ_ONLY_UNTIL_AUTHORIZED_COMPLETION");
});

test("19 reload reconciliation creates no duplicate cards", () => {
  const api = subject();
  const first = plan([arrival("835", "23:53", ["74-01"], {sortMinutes: 1433})]);
  const second = plan([arrival("835", "23:53", ["74-01"], {sortMinutes: 1433})]);
  const reconciled = api.reconcileShiftCards(second.cards, first.cards);
  assert.equal(reconciled.cards.length, 1);
  assert.equal(reconciled.duplicateCount, 0);
});

test("20 repeated polling creates no duplicate cards", () => {
  const api = subject();
  const generated = plan([arrival("837", "00:50 +1", ["74-01", "74-02"], {sortMinutes: 1490})]);
  let cards = [];
  for (let poll = 0; poll < 5; poll += 1) cards = api.reconcileShiftCards(generated.cards, cards).cards;
  assert.equal(cards.length, generated.cards.length);
  assert.equal(new Set(cards.map(card => card.cardId)).size, cards.length);
});

test("21 source revision updates the logical plan without a second card", () => {
  const api = subject();
  const first = plan([arrival("835", "23:53", ["74-01"], {sortMinutes: 1433, sourceRevision: "rev-1"})]);
  const updated = plan([arrival("835", "23:53", ["74-01"], {sortMinutes: 1433, sourceRevision: "rev-2"})]);
  const reconciled = api.reconcileShiftCards(updated.cards, first.cards);
  assert.equal(reconciled.cards.length, 1);
  assert.equal(reconciled.cards[0].sourceRevision, "rev-2");
});

test("22 a completed logical MAIN obligation is never recreated", () => {
  const first = plan([arrival("839", "01:45 +1", ["74-01"], {sortMinutes: 1545})]);
  const completedLifecycleKeys = [mainCards(first)[0].lifecycleKey];
  const refreshed = plan([arrival("839", "01:45 +1", ["74-01"], {sortMinutes: 1545, sourceRevision: "rev-2"})], [], {completedLifecycleKeys});
  assert.equal(mainCards(refreshed).length, 0);
  assert.equal(refreshed.completedObligationCount, 1);
});

test("23 vehicle identity permutations preserve policy for three distinct mappings", () => {
  const mappings = [
    ["74-01", "74-02", "74-03"],
    ["69-63", "75-76", "70-11"],
    ["72-01", "74-47", "75-53"],
  ];
  const signatures = mappings.map(ids => subject().planStructureSignature(plan([
    arrival("835", "23:53", [ids[0]], {sortMinutes: 1433}),
    arrival("837", "00:50 +1", [ids[1]], {sortMinutes: 1490}),
    arrival("839", "01:45 +1", [ids[2]], {sortMinutes: 1545}),
  ])));
  assert.ok(signatures.every(signature => signature === signatures[0]));
});

test("24 plan structure, order, target and windows differ only by vehicleId", () => {
  const left = plan([arrival("835", "23:53", ["74-01", "74-02"], {sortMinutes: 1433})]);
  const right = plan([arrival("835", "23:53", ["75-76", "69-63"], {sortMinutes: 1433})]);
  assert.equal(subject().planStructureSignature(left), subject().planStructureSignature(right));
  assert.notDeepEqual(mainCards(left).map(card => card.vehicleId), mainCards(right).map(card => card.vehicleId));
});

test("25 train 851 with immediate continuation still creates one MAIN card", () => {
  assert.equal(mainCards(plan(
    [arrival("851", "18:09", ["74-40"], {sortMinutes: 1089})],
    [departure("852", "18:30", ["74-40"], {sortMinutes: 1110})],
  )).length, 1);
});

test("26 train 853 with immediate continuation still creates one MAIN card", () => {
  assert.equal(mainCards(plan(
    [arrival("853", "19:09", ["74-41"], {sortMinutes: 1149})],
    [departure("854", "19:30", ["74-41"], {sortMinutes: 1170})],
  )).length, 1);
});

test("27 train 855 with immediate continuation still creates one MAIN card", () => {
  assert.equal(mainCards(plan(
    [arrival("855", "20:09", ["74-42"], {sortMinutes: 1209})],
    [departure("10855", "20:14", ["74-42"], {sortMinutes: 1214})],
  )).length, 1);
});

test("28 train 861 with immediate continuation still creates one MAIN card", () => {
  assert.equal(mainCards(plan(
    [arrival("861", "21:09", ["74-43"], {sortMinutes: 1269})],
    [departure("862", "21:30", ["74-43"], {sortMinutes: 1290})],
  )).length, 1);
});

test("29 train 863 with immediate continuation still creates one MAIN card", () => {
  assert.equal(mainCards(plan(
    [arrival("863", "22:09", ["74-44"], {sortMinutes: 1329})],
    [departure("864", "22:30", ["74-44"], {sortMinutes: 1350})],
  )).length, 1);
});

test("30 forced-train reason text names the specific arriving train", () => {
  const result = plan([arrival("851", "18:09", ["74-40"], {sortMinutes: 1089})]);
  assert.equal(result.needs.length, 1);
  assert.match(result.needs[0].reason, /Fast post-arrival-shunt-regel for tog 851\./);
});

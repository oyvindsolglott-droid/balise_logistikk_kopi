"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const modulePath = path.join(root, "sde_tursatt_post_arrival.js");
const testPath = path.join(root, "tests/sde/tursatt-post-arrival-shift.test.cjs");
const source = fs.readFileSync(modulePath, "utf8");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-tursatt-post-arrival-mutations-"));

function replaceOnce(input, before, after, label) {
  const index = input.indexOf(before);
  if (index < 0) throw new Error(`${label}: mutation anchor not found`);
  if (input.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0, index) + after + input.slice(index + before.length);
}

function run(candidatePath, label) {
  const execution = childProcess.spawnSync(process.execPath, ["--test", testPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {...process.env, SDE_TURSATT_POST_ARRIVAL_MODULE: candidatePath},
  });
  if (execution.error || execution.signal || ![0, 1].includes(execution.status)) {
    throw new Error(`${label}: mutation infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  return execution;
}

const mutations = [
  {
    id: "NO_DEPARTURE_RETURNS_WITHOUT_SHIFT_NEED", expected: /03 no later departure/,
    apply: input => replaceOnce(input,
      "const requiresPostArrivalShunt = forced || explicit || !immediate || !immediateContainsVehicle;",
      "const requiresPostArrivalShunt = forced || explicit || (Boolean(immediate) && !immediateContainsVehicle);",
      "drop no-departure needs"),
  },
  {
    id: "SPLIT_REMOVAL_REMAINS_DIAGNOSTIC_ONLY", expected: /01 split removal/,
    apply: input => replaceOnce(input,
      "const requiresPostArrivalShunt = forced || explicit || !immediate || !immediateContainsVehicle;",
      "const requiresPostArrivalShunt = forced || explicit || !immediate;",
      "drop split removal needs"),
  },
  {
    id: "TURSATT_CARD_COMPILATION_DISABLED", expected: /14 safe direct target/,
    apply: input => replaceOnce(input,
      "cards.push(baseCard(need, \"MAIN\", {",
      "false && cards.push(baseCard(need, \"MAIN\", {",
      "disable direct compilation"),
  },
  {
    id: "835_POST_ARRIVAL_SHUNT_DISABLED", expected: /05 train 835/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"837", "839", "851", "853", "855", "861", "863",',
      "disable 835"),
  },
  {
    id: "837_POST_ARRIVAL_SHUNT_DISABLED", expected: /07 train 837/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"835", "839", "851", "853", "855", "861", "863",',
      "disable 837"),
  },
  {
    id: "839_POST_ARRIVAL_SHUNT_DISABLED", expected: /08 train 839/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"835", "837", "851", "853", "855", "861", "863",',
      "disable 839"),
  },
  {
    id: "851_POST_ARRIVAL_SHUNT_DISABLED", expected: /25 train 851/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"835", "837", "839", "853", "855", "861", "863",',
      "disable 851"),
  },
  {
    id: "853_POST_ARRIVAL_SHUNT_DISABLED", expected: /26 train 853/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"835", "837", "839", "851", "855", "861", "863",',
      "disable 853"),
  },
  {
    id: "855_POST_ARRIVAL_SHUNT_DISABLED", expected: /27 train 855/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"835", "837", "839", "851", "853", "861", "863",',
      "disable 855"),
  },
  {
    id: "861_POST_ARRIVAL_SHUNT_DISABLED", expected: /28 train 861/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"835", "837", "839", "851", "853", "855", "863",',
      "disable 861"),
  },
  {
    id: "863_POST_ARRIVAL_SHUNT_DISABLED", expected: /29 train 863/,
    apply: input => replaceOnce(input,
      '"835", "837", "839", "851", "853", "855", "861", "863",',
      '"835", "837", "839", "851", "853", "855", "861",',
      "disable 863"),
  },
  {
    id: "ONLY_ONE_CARD_CREATED_FOR_TWO_VEHICLES", expected: /06 train 835 with two/,
    apply: input => replaceOnce(input,
      "for (const vehicleRow of arrival.vehicles) {",
      "for (const vehicleRow of arrival.vehicles.slice(0, 1)) {",
      "single vehicle only"),
  },
  {
    id: "LATER_DEPARTURE_CANCELS_IMMEDIATE_SHUNT", expected: /04 later non-immediate use/,
    apply: input => replaceOnce(input,
      "const laterUse = laterUses[0] || null;",
      "const laterUse = laterUses[0] || null;\n        if (laterUse) continue;",
      "later use suppresses shift"),
  },
  {
    id: "CARDS_SORTED_BY_PRIORITY_NOT_TIME", expected: /10 post-midnight cards/,
    apply: input => replaceOnce(input,
      "if (timeDiff) return timeDiff;\n    const partDiff",
      "if (timeDiff) return -timeDiff;\n    const partDiff",
      "reverse need chronology"),
  },
  {
    id: "POST_MIDNIGHT_ORDER_BROKEN", expected: /10 post-midnight cards/,
    apply: input => replaceOnce(input,
      'sequenceMinutes: eventSequenceMinutes(event, role === "arrival"),',
      'sequenceMinutes: eventSequenceMinutes(event, role === "arrival") % 1440,',
      "drop post-midnight offset"),
  },
  {
    id: "TIME_WINDOW_MISSING", expected: /11 every MAIN card/,
    apply: input => replaceOnce(input,
      "plannedWindowStart: formatClockMinutes(plannedWindowStartMinutes),",
      'plannedWindowStart: "",',
      "remove window start"),
  },
  {
    id: "TIME_WINDOWS_OVERLAP", expected: /12 serialized Tursatt windows/,
    apply: input => replaceOnce(input,
      "resourceCursor = plannedWindowEndMinutes + config.interCardGapMinutes;",
      "resourceCursor = Number.NEGATIVE_INFINITY;",
      "disable serialization"),
  },
  {
    id: "POLLING_DUPLICATES_CARDS", expected: /19 reload reconciliation|20 repeated polling/,
    apply: input => replaceOnce(input,
      "byId.set(clean(card.cardId), card);\n    }\n    for (const card of Array.isArray(generatedCards)",
      "byId.set(`${clean(card.cardId)}|existing`, card);\n    }\n    for (const card of Array.isArray(generatedCards)",
      "retain duplicate existing cards"),
  },
  {
    id: "COMPLETED_CARD_RECREATED", expected: /22 a completed logical MAIN/,
    apply: input => replaceOnce(input,
      "if (completedLifecycleKeys.has(need.lifecycleKey)) {",
      "if (false && completedLifecycleKeys.has(need.lifecycleKey)) {",
      "ignore completion"),
  },
  {
    id: "VEHICLE_ID_CHANGES_PLAN_STRUCTURE", expected: /23 vehicle identity permutations|24 plan structure/,
    apply: input => replaceOnce(input,
      "const plannedWindowEndMinutes = plannedWindowStartMinutes + config.mainDurationMinutes;",
      "const plannedWindowEndMinutes = plannedWindowStartMinutes + config.mainDurationMinutes + (need.vehicleId.charCodeAt(0) % 2);",
      "vehicle identity controls duration"),
  },
];

const results = [];
try {
  const baseline = run(modulePath, "baseline");
  if (baseline.status !== 0) throw new Error(`Tursatt mutation baseline is not green:\n${baseline.stdout}\n${baseline.stderr}`);
  for (const mutation of mutations) {
    const candidatePath = path.join(temporary, `${mutation.id}.js`);
    fs.writeFileSync(candidatePath, mutation.apply(source));
    const execution = run(candidatePath, mutation.id);
    const output = `${execution.stdout || ""}\n${execution.stderr || ""}`;
    const killed = execution.status === 1 && mutation.expected.test(output);
    results.push({
      id: mutation.id,
      status: killed ? "PASS" : "FAIL",
      mutantExitCode: execution.status,
      expectedFailure: String(mutation.expected),
      timeoutKill: false,
    });
  }
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = results.filter(result => result.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "sde-tursatt-post-arrival-mutation-audit-v1",
  counts: {total: results.length, pass: results.length - failed.length, fail: failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;

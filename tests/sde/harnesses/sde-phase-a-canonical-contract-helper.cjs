"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const {
  createShiftEngine,
  createShiftIntent,
  projectCanonicalPlan,
} = require(path.join(root, "sde_canonical_shift_engine.js"));
const {
  buildCanonicalSlotCatalog,
  planCanonicalShiftNeeds,
  buildCanonicalProductProjection,
  revalidateCanonicalProductAction,
} = require(path.join(root, "sde_canonical_shift_adapter.js"));

const SLOT_IDS = [
  "1N", "1S", "2N", "2S", "3N", "3M", "3S", "4N", "4M", "4S",
  "5N", "5M", "5S", "6N", "6S", "6SS", "7N", "7S", "7SS", "8N",
  "8S", "8SS", "9", "10N", "10S", "11N", "11S", "12N", "12S", "VN", "VS",
];

function catalog() {
  return buildCanonicalSlotCatalog({
    slotIds: SLOT_IDS,
    getTrack: slot => slot.startsWith("V") ? "V" : (slot.match(/^\d+/)?.[0] || slot),
    getTrackOrder: track => ({
      V: ["VS", "VN"], 3: ["3S", "3M", "3N"], 4: ["4S", "4M", "4N"],
      5: ["5S", "5M", "5N"], 6: ["6SS", "6S", "6N"], 7: ["7SS", "7S", "7N"],
      8: ["8SS", "8S", "8N"], 10: ["10S", "10N"], 11: ["11S", "11N"],
      12: ["12S", "12N"],
    }[track] || [track]),
    getOpenEnds: track => track === "V" || ["10", "11", "12"].includes(track)
      ? ["north"]
      : ["south", "north"],
    getRole: slot => slot === "VS"
      ? "route_resource"
      : slot === "VN"
        ? "temporary_relief"
        : ["7N", "7S", "8N", "8S"].includes(slot)
          ? "workshop"
          : "ordinary",
  });
}

function engine() {
  return createShiftEngine({
    slotCatalog: catalog(),
    boundary: {
      maxStates: 250000,
      maxWallTimeMs: 1800,
      maxConnectedVehicles: 16,
      maxConnectedSlots: 31,
      maxPlanSteps: null,
      maxBranchingFactor: 31,
    },
  });
}

function actual(occupancy, revision = "phase-a-actual-r1", extra = {}) {
  return { actualStateRevision: revision, actualStateFresh: true, occupancy, ...extra };
}

function intent(vehicleId, sourceSlot, targetSlot, intentId, extra = {}) {
  return createShiftIntent({
    intentId,
    sourceType: "MANUAL",
    authority: "HUMAN_MANUAL",
    priorityClass: "P1_MANUAL",
    vehicleId,
    requestedSource: sourceSlot,
    requestedTarget: targetSlot,
    requestedAt: "2026-08-23T00:00:00.000Z",
    ...extra,
  });
}

function batch(occupancy, needs, options = {}) {
  return planCanonicalShiftNeeds({
    engine: engine(),
    actualState: actual(occupancy, options.revision || "phase-a-product-r1", options.actualExtra),
    needs,
    previousPlan: options.previousPlan || null,
    events: options.events || [],
    authorizeManualIntent: () => true,
  });
}

function product(result) {
  return buildCanonicalProductProjection(result, {
    capability: { canCreateManualIntent: true, canComplete: true, canCancel: true },
  });
}

function assertCanonicalOnlySource(source) {
  const serverSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
  assert.match(source, /migrationMode:\s*"CANONICAL_ONLY"/);
  assert.match(source, /operationalWriteOwner:\s*"SDE_CANONICAL_SHIFT_ENGINE"/);
  assert.match(source, /legacyOperationalWritesEnabled:\s*false/);
  assert.match(source, /migrationMode:\s*"SHADOW_READ_ONLY"/);
  assert.match(source, /operationalWriteOwner:\s*"LEGACY_SHIFT_ENGINE"/);
  assert.match(source, /legacyOperationalWritesEnabled:\s*true/);
  assert.match(source, /machineLearningScoreActive:\s*false/);
  assert.match(source, /function buildSdeCanonicalUnifiedAllProducerProduct\s*\(/);
  assert.match(source, /async function handleSdeCanonicalCardAction\s*\(/);
  assert.match(source, /return \{mode:"canonical_fail_closed",error:reason,legacyOperationalWritesEnabled:false\}/);
  assert.match(source, /if\(requestedReader === "legacy" && disposableRollbackDrill\) return "legacy_rollback_drill";/);
  assert.match(source, /getSdeProductionRuntimeContract\(options\)\.canonicalOperationalAuthority === true/);
  assert.match(source, /:\s*"legacy_shadow";/);
  assert.match(source, /CANONICAL_PRODUCTION_GATE_DISABLED/);
  assert.match(source, /if\(requestedMode !== "canonical"\) return renderSdeLegacyProductionReader\(requestedMode\);/);
  assert.doesNotMatch(source, /requestedReader === "canonical"/);
  assert.match(serverSource, /process\.env\.SDE_CANONICAL_SHIFT_PRODUCTION_ENABLED === "1"/);
  assert.match(serverSource, /canonicalShiftRuntime:\s*CANONICAL_SHIFT_RUNTIME_CONFIG/);
  assert.match(serverSource, /Object\.defineProperty\(window,"__SDE_SERVER_RUNTIME_CONFIG__"/);

  const modeStart = source.indexOf("function getSdeProductionReaderMode(");
  const modeEnd = source.indexOf("function isSdeCanonicalReaderTechnicalFailureTestRequested", modeStart);
  assert.ok(modeStart >= 0 && modeEnd > modeStart, "production reader gate source must be extractable");
  const context = vm.createContext({URLSearchParams, Object});
  vm.runInContext(source.slice(modeStart, modeEnd), context, {filename:"sde-production-reader-gate.js"});
  const validServerConfig = {
    schemaVersion:"sde-canonical-shift-runtime-gate-v1",
    activationSource:"SERVER_ENVIRONMENT",
    canonicalShiftProductionEnabled:true,
    canonicalOperationalAuthority:true,
    migrationMode:"CANONICAL_ONLY",
    operationalWriteOwner:"SDE_CANONICAL_SHIFT_ENGINE",
    legacyOperationalWritesEnabled:false
  };
  assert.equal(context.getSdeProductionReaderMode({hostname:"sde.oyvind-solglott.no",search:""}), "legacy_shadow");
  assert.equal(context.getSdeProductionReaderMode({hostname:"sde.oyvind-solglott.no",search:"?sdeReader=canonical"}), "legacy_shadow");
  assert.equal(context.getSdeProductionReaderMode(
    {hostname:"sde.oyvind-solglott.no",search:""},
    {runtimeConfig:{...validServerConfig,legacyOperationalWritesEnabled:true}}
  ), "legacy_shadow");
  assert.equal(context.getSdeProductionReaderMode(
    {hostname:"sde.oyvind-solglott.no",search:""},
    {runtimeConfig:validServerConfig}
  ), "canonical");
  assert.equal(context.getSdeProductionReaderMode(
    {hostname:"localhost",search:"?sdeReader=legacy&sdeRollbackDrill=1"},
    {runtimeConfig:validServerConfig}
  ), "legacy_rollback_drill");
}

function directProduct(vehicleId, sourceSlot, targetSlot, id, occupancy = null) {
  const current = occupancy || { [sourceSlot]: vehicleId };
  const result = batch(current, [{
    producerId: "MANUAL_DRAG",
    payload: { intentId: id, actorId: "phase-a-harness", vehicleId, sourceSlot, targetSlot },
  }]);
  assert.equal(result.status, "PLANNED");
  const projected = product(result);
  assert.equal(projected.status, "ACTIVE");
  assert.equal(projected.integrity.status, "PASS");
  assert.equal(projected.operationalWriteOwner, "SDE_CANONICAL_SHIFT_ENGINE");
  assert.equal(projected.legacyOperationalWritesEnabled, false);
  assert.ok(projected.cards.every(card => card.canDelete === false));
  return { result, projected, current };
}

function runScenario(name, sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  assertCanonicalOnlySource(source);

  if (name === "reader-switch") {
    assert.doesNotMatch(source, /return "legacy_forced"/);
    assert.doesNotMatch(source, /return "legacy_fallback"/);
    const direct = directProduct("70-01", "5N", "11S", "reader-direct");
    assert.equal(direct.projected.cards.length, 1);
    assert.equal(direct.projected.reservations.length, 1);
    assert.equal(direct.projected.overlays.length, 1);
  } else if (name === "replacement-adapter" || name === "repeated-reroute") {
    const first = directProduct("69-63", "8N", "8S", "reroute-a");
    const second = batch({ "8N": "69-63", "8S": "74-20" }, [{
      producerId: "MANUAL_DRAG",
      payload: { intentId: "reroute-b", actorId: "phase-a-harness", vehicleId: "69-63", sourceSlot: "8N", targetSlot: "9" },
    }], { previousPlan: first.result.plan, events: [{ type: "TARGET_OCCUPIED", slot: "8S", vehicleId: "74-20" }] });
    assert.equal(second.status, "REPLANNED");
    assert.equal(second.plan.originalIntents.length, 1);
    assert.equal(second.plan.originalIntents[0].originalTargetSlot, "9");
    assert.ok(second.plan.steps.some(step => step.vehicleId === "69-63" && step.targetSlot === "9"));
    assert.deepEqual(projectCanonicalPlan(first.result.plan, { activePlanRevision: second.plan.planRevision }).cards, []);
    const replacement = product(second);
    assert.equal(replacement.integrity.status, "PASS");
    assert.ok(replacement.cards.every(card => card.executionDescriptor?.planRevision === second.plan.planRevision));
  } else if (name === "graphic-order") {
    const result = batch({ "5M": "69-55", "5N": "74-11" }, [
      { producerId: "MANUAL_DRAG", payload: { intentId: "drag-a", actorId: "phase-a-harness", vehicleId: "69-55", sourceSlot: "5M", targetSlot: "10N" } },
      { producerId: "MANUAL_DRAG", payload: { intentId: "drag-b", actorId: "phase-a-harness", vehicleId: "74-11", sourceSlot: "5N", targetSlot: "11S" } },
    ]);
    assert.equal(result.status, "PLANNED");
    assert.equal(result.plan.originalIntents.length, 2);
    const projected = product(result);
    assert.equal(projected.integrity.status, "PASS");
    assert.equal(new Set(projected.cards.map(card => card.intentId)).size, 2);
    assert.equal(projected.cards.length, result.plan.steps.length);
    assert.equal(projected.overlays.length, result.plan.steps.length);
    assert.match(source, /Bestilling beholdt som canonical intent:/);
    assert.match(source, /Bestilling opprettet:/);
  } else if (name === "fresh-order") {
    const first = directProduct("74-10", "5M", "8S", "fresh-a");
    const second = batch({ "5M": "74-10" }, [{
      producerId: "MANUAL_DRAG",
      payload: { intentId: "fresh-b", actorId: "phase-a-harness", vehicleId: "74-10", sourceSlot: "5M", targetSlot: "9" },
    }], { previousPlan: first.result.plan, events: [{ type: "MANUAL_TARGET_CHANGED" }] });
    assert.equal(second.status, "REPLANNED");
    assert.equal(second.plan.originalIntents[0].intentId.includes("fresh-b"), true);
    assert.notEqual(second.plan.originalIntents[0].intentId, first.result.plan.originalIntents[0].intentId);
    assert.equal(product(second).integrity.status, "PASS");
  } else if (name === "manual-return") {
    const returned = directProduct("74-12", "4M", "5M", "manual-return");
    assert.deepEqual(returned.result.plan.steps.map(step => [step.role, step.vehicleId, step.sourceSlot, step.targetSlot]), [
      ["MAIN", "74-12", "4M", "5M"],
    ]);
    const descriptor = returned.projected.cards[0].executionDescriptor;
    const validation = revalidateCanonicalProductAction({
      batchResult: returned.result,
      descriptor,
      freshActualState: actual({ "4M": "74-12" }, descriptor.actualStateRevision),
      actionType: "UTFORT",
    });
    assert.equal(validation.ok, true);
  } else if (name === "mid-chain") {
    const planner = engine();
    const parent = intent("74-41", "10S", "8S", "mid-chain", { preferredSourceEnd: "north" });
    const first = planner.plan({ state: actual({ "10S": "74-41", "10N": "74-12" }), intents: [parent] });
    assert.equal(first.status, "PLANNED");
    const release = first.plan.steps.find(step => step.role === "RELEASE");
    assert.ok(release);
    const progressed = actual({ "10S": "74-41", [release.targetSlot]: "74-12" }, "phase-a-mid-r2", {
      completedStepIds: [release.stepId],
      currentOperationalTime: release.plannedWindowEnd,
    });
    const second = planner.plan({
      state: progressed,
      intents: [parent],
      previousPlan: first.plan,
      events: [{ type: "UTFORT", stepId: release.stepId }],
    });
    assert.equal(second.plan.steps[0].stepId, release.stepId);
    assert.equal(second.plan.steps[0].status, "COMPLETED");
    const projection = projectCanonicalPlan(second.plan);
    assert.equal(projection.status, "PROJECTED");
    assert.ok(projection.cards.length >= 1);
    assert.equal(projection.cards[0].status, "READY");
  } else if (name === "direct-wash") {
    const direct = directProduct("74-12", "4N", "10S", "wash-direct");
    assert.deepEqual(direct.result.plan.steps.map(step => step.role), ["MAIN"]);
    assert.match(source, /Hele canonical kjeden er atomisk materialisert; bare READY-steg kan utføres\./);
  } else if (name === "multi-plan-lifecycle") {
    const result = batch({ "10S": "75-01", "11S": "75-02" }, [
      { producerId: "MANUAL_DRAG", payload: { intentId: "multi-a", actorId: "phase-a-harness", vehicleId: "75-01", sourceSlot: "10S", targetSlot: "8S" } },
      { producerId: "MANUAL_DRAG", payload: { intentId: "multi-b", actorId: "phase-a-harness", vehicleId: "75-02", sourceSlot: "11S", targetSlot: "12S" } },
    ]);
    const projected = product(result);
    assert.equal(projected.integrity.status, "PASS");
    assert.equal(result.plan.originalIntents.length, 2);
    assert.equal(projected.cards.length, result.plan.steps.length);
    assert.equal(projected.overlays.length, result.plan.steps.length);
    const ready = projected.cards.find(card => card.status === "READY");
    assert.ok(ready);
    assert.equal(revalidateCanonicalProductAction({
      batchResult: result,
      descriptor: ready.executionDescriptor,
      freshActualState: actual({ "10S": "75-01", "11S": "75-02" }, ready.executionDescriptor.actualStateRevision),
      actionType: "UTFORT",
    }).ok, true);
  } else if (name === "stable-execution") {
    const planner = engine();
    const parent = intent("75-01", "10S", "8S", "stable-execution", { preferredSourceEnd: "north" });
    const current = actual({ "10S": "75-01", "10N": "75-09" });
    const first = planner.plan({ state: current, intents: [parent] });
    const second = planner.plan({ state: current, intents: [parent], previousPlan: first.plan });
    assert.equal(second.status, "NO_OP");
    assert.equal(second.plan.planRevision, first.plan.planRevision);
    assert.deepEqual(second.plan.steps.map(step => step.stepId), first.plan.steps.map(step => step.stepId));
    assert.deepEqual(second.plan.steps.map(step => step.role), ["RELEASE", "MAIN", "RECOVERY"]);
    assert.equal(first.diagnostics.vnComparedWithOrdinaryRelief, true);
  } else if (name === "inbound-history") {
    const direct = directProduct("75-31", "7N", "6N", "fresh-inbound");
    assert.deepEqual(direct.result.plan.steps.map(step => [step.role, step.sourceSlot, step.targetSlot]), [["MAIN", "7N", "6N"]]);
    assert.equal(direct.projected.integrity.status, "PASS");
  } else if (name === "workshop-direct") {
    const direct = directProduct("74-54", "7N", "6N", "workshop-direct");
    assert.deepEqual(direct.result.plan.steps.map(step => [step.role, step.sourceSlot, step.targetSlot]), [["MAIN", "7N", "6N"]]);
    assert.equal(direct.projected.cards.length, 1);
    assert.equal(direct.projected.cards[0].status, "READY");
  } else {
    throw new Error(`Unknown Phase A contract scenario: ${name}`);
  }

  process.stdout.write(`${JSON.stringify({ schemaVersion: "sde-phase-a-canonical-contract-v1", scenario: name, status: "PASS" })}\n`);
}

module.exports = { runScenario };

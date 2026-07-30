#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(text, name, required = true) {
  const marker = `function ${name}(`;
  const functionStart = text.indexOf(marker);
  if (functionStart < 0) {
    if (!required) return "";
    throw new Error(`missing production function ${name}`);
  }
  const asyncPrefix = text.slice(Math.max(0, functionStart - 6), functionStart) === "async ";
  const start = asyncPrefix ? functionStart - 6 : functionStart;
  const signatureEnd = text.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing production body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed production function ${name}`);
}

function makeReadback({
  revision = 8,
  items = [],
  faults = [],
  repairRequests = [],
  notifications = [],
  writeEnabled = true,
} = {}) {
  return {
    ok: true,
    schemaVersion: "vehicle-status-read-model-v2",
    revision,
    writeEnabled,
    productionPilotWriteEnabled: true,
    registerFaultCommandAvailable: true,
    vehicleStatusLifecycleCommandsAvailable: true,
    allowedVehicleIds: ["74-04"],
    items,
    faults,
    repairRequests,
    notifications,
  };
}

function response(readback) {
  return {
    ok: true,
    async json() {
      return structuredClone(readback);
    },
  };
}

async function main() {
  const descriptions = [
    "Fokusprøve æøå: kontinuerlig beskrivelse med mellomrom, komma og punktum som må stå helt urørt gjennom polling.",
    "Rad to beholder norsk tekst og markør uten at nettleseren mister det aktive feltet.",
    "Rad tre er en usendt lokal kladd og må aldri lekke til et annet kjøretøy.",
    "Rad fire overlever tre uendrede GET-readbacks uten ny DOM-node.",
    "Rad fem bekrefter at alle fem standardrader har samme stabile kontrakt.",
  ];
  assert.ok(descriptions[0].length >= 100, "the focused draft must exercise at least 100 characters");

  const body = { nodeName: "BODY" };
  let textareas = descriptions.map((value, index) => ({
    nodeName: "TEXTAREA",
    value,
    dataset: { sdeDropsFaultDescription: String(index + 1) },
    selectionStart: value.length,
    selectionEnd: value.length,
  }));
  const originalTextareas = [...textareas];
  let fullRegistryRenders = 0;
  let workshopRenders = 0;
  let sporplanRenders = 0;
  let notificationRenders = 0;
  let focusoutCount = 0;
  const document = {
    visibilityState: "visible",
    activeElement: textareas[0],
  };

  const optionalFunctionNames = [
    "serializeDropsVehicleRenderValue",
    "getDropsVehicleAuthoritativeRenderSignature",
    "shouldRenderDropsVehicleRegistryForReadback",
    "getWorkshopVehicleRegistryReadbackSignature",
    "shouldRenderWorkshopVehicleRegistryForReadback",
    "getWorkshopExitPlanningReadbackSignature",
    "reconcileVehicleStatusNotifications",
    "acceptVehicleStatusReadback",
  ];
  const optionalFunctions = optionalFunctionNames
    .map(name => extractFunction(source, name, false))
    .filter(Boolean);
  const refreshFunction = extractFunction(source, "refreshVehicleStatusReadback");
  const initialReadback = makeReadback();
  const context = {
    console,
    structuredClone,
    document,
  };
  vm.createContext(context);
  vm.runInContext(`
    let dropsVehicleRegistrySelectedVehicle = "74-04";
    let dropsVehicleStatusReadback = ${JSON.stringify(initialReadback)};
    const vehicleStatusNotificationKnownIds = new Set();
    const vehicleStatusNotificationPending = [];
    let vehicleStatusNotificationBaselineInitialized = false;
    function renderDropsVehicleRegistry(){
      fullRegistryRenders += 1;
      textareas = textareas.map(field => ({
        nodeName:"TEXTAREA",
        value:field.value,
        dataset:{...field.dataset},
        selectionStart:0,
        selectionEnd:0
      }));
      if(document.activeElement?.nodeName === "TEXTAREA"){
        focusoutCount += 1;
        document.activeElement = body;
      }
    }
    function renderWorkshopVehicleRegistry(){ workshopRenders += 1; }
    function renderSporplanVehicleStatusBadges(){ sporplanRenders += 1; }
    function renderOperationalMessageThreads(){}
    function updateOperationalMessageComposerStatus(){}
    function renderVehicleStatusNotificationPopup(){ notificationRenders += 1; }
    ${optionalFunctions.join("\n")}
    ${refreshFunction}
    this.api = {
      refreshVehicleStatusReadback,
      getReadback:()=>dropsVehicleStatusReadback,
      getRenderCounts:()=>({
        notificationRenders,
        workshopRenders,
        sporplanRenders
      }),
      setVisibility:value=>{ document.visibilityState=value; },
      setSelectedVehicle:value=>{ dropsVehicleRegistrySelectedVehicle=value; }
    };
  `, context);
  Object.assign(context, {
    body,
    textareas,
    fullRegistryRenders,
    workshopRenders,
    sporplanRenders,
    notificationRenders,
    focusoutCount,
  });

  async function poll(readback) {
    await context.api.refreshVehicleStatusReadback(async (url, options) => {
      assert.equal(url, "/api/vehicle-status");
      assert.equal(options.method, "GET");
      return response(readback);
    });
  }

  for (let tick = 1; tick <= 3; tick += 1) {
    await poll(makeReadback({ revision: 8 + tick }));
    assert.equal(context.document.activeElement, originalTextareas[0], `tick ${tick} must preserve the focused DOM node`);
    assert.equal(context.document.activeElement.selectionStart, descriptions[0].length, `tick ${tick} must preserve the caret`);
    assert.equal(context.document.activeElement.selectionEnd, descriptions[0].length, `tick ${tick} must preserve the selection`);
    assert.equal(context.focusoutCount, 0, `tick ${tick} must not dispatch focusout`);
    for (let index = 0; index < 5; index += 1) {
      assert.equal(context.textareas[index], originalTextareas[index], `tick ${tick}, row ${index + 1} must retain DOM identity`);
      assert.equal(context.textareas[index].value, descriptions[index], `tick ${tick}, row ${index + 1} must retain its exact draft`);
    }
  }

  await poll(makeReadback({
    revision: 20,
    items: [{ vehicleId: "74-10", currentStatus: "IKKE_DRIFTSKLAR", statusRevision: 4 }],
    notifications: [{ notificationId: "other-vehicle", vehicleId: "74-10", kind: "REPAIR_REQUESTED" }],
  }));
  assert.equal(context.fullRegistryRenders, 0, "other-vehicle readback and notifications must not replace the selected editor");
  const renderCounts = context.api.getRenderCounts();
  assert.equal(renderCounts.notificationRenders, 4, "notification readback must still update independently");
  assert.equal(renderCounts.workshopRenders, 4, "workshop readback must still update independently");
  assert.equal(renderCounts.sporplanRenders, 4, "Sporplan badges must still update independently");

  const authoritativeSelectedVehicle = makeReadback({
    revision: 21,
    items: [{
      vehicleId: "74-04",
      currentStatus: "IKKE_DRIFTSKLAR",
      statusRevision: 1,
      registeredAt: "2026-07-24T10:00:00.000Z",
      activeFaults: [{
        faultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        slot: 1,
        category: "A1",
        description: descriptions[0],
        status: "ACTIVE",
        registeredAt: "2026-07-24T10:00:00.000Z",
      }],
    }],
  });
  await poll(authoritativeSelectedVehicle);
  assert.equal(context.fullRegistryRenders, 1, "selected authoritative status change must perform one full render");
  assert.notEqual(context.textareas[0], originalTextareas[0], "authoritative confirmation may replace the local editor");

  const rendersBeforeFailure = context.fullRegistryRenders;
  await context.api.refreshVehicleStatusReadback(async () => {
    throw new Error("simulated network failure");
  });
  assert.equal(context.fullRegistryRenders, rendersBeforeFailure, "network failure must preserve the last confirmed editor");
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.api.getReadback())),
    authoritativeSelectedVehicle,
    "network failure must preserve the last confirmed readback",
  );

  context.api.setVisibility("hidden");
  let hiddenFetches = 0;
  await context.api.refreshVehicleStatusReadback(async () => {
    hiddenFetches += 1;
    return response(makeReadback({ revision: 22 }));
  });
  assert.equal(hiddenFetches, 0, "hidden documents must not poll");

  assert.match(
    source,
    /const nextVehicle\s*=\s*vehicles\.includes\(vehicleSelect\.value\)[\s\S]*?dropsVehicleRegistrySelectedVehicle\s*=\s*nextVehicle/,
    "vehicle switching must remain explicit and scoped",
  );
  assert.match(
    source,
    /dropsStandardSheetCollapsed\s*=\s*!dropsStandardSheetCollapsed;\s*renderDropsVehicleRegistry\(\)/,
    "collapse and expand must remain explicit user-triggered full renders",
  );
  assert.match(
    source,
    /@media\s*\(max-width:600px\)[\s\S]*?\.drops-not-operational-fault-row\{\s*grid-template-columns:minmax\(0,1fr\)/,
    "the five-row editor must remain single-column on narrow screens",
  );
  assert.match(
    source,
    /@media\s*\(max-width:390px\)[\s\S]*?\.drops-standard-sheet-toolbar/,
    "the standard sheet must retain its explicit 390px responsive contract",
  );

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "sde-drops-focus-stability-harness-v1",
    counts: {
      pollTicks: 3,
      rows: 5,
      fullRendersDuringUnchangedReadback: 0,
      authoritativeRenders: context.fullRegistryRenders,
      focusouts: context.focusoutCount,
    },
    checks: {
      exactDraft: true,
      norwegianCharacters: true,
      domIdentity: true,
      focusAndCaret: true,
      otherVehicleIsolation: true,
      networkFailureFailClosed: true,
      collapseExpandContract: true,
      mobile390Contract: true,
    },
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

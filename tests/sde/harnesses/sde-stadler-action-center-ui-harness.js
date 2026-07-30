"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sourcePath = process.argv[2] || path.resolve(__dirname, "../../..", "index.html");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index = open; index < source.length; index += 1){
    const char = source[index];
    if(quote){
      if(escaped) escaped = false;
      else if(char === "\\") escaped = true;
      else if(char === quote) quote = "";
      continue;
    }
    if(char === "'" || char === '"' || char === "`"){
      quote = char;
      continue;
    }
    if(char === "{") depth += 1;
    if(char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

const safety = extractFunction("getSdeTargetSlotSafety");
assert.match(
  safety,
  /return\s+evaluateSdeAbsoluteTargetSlotSafety\(vehicle,\s*targetSlot,\s*context\)/
);
const absoluteSafety = extractFunction("evaluateSdeAbsoluteTargetSlotSafety");
assert.match(absoluteSafety, /if\s*\(targetVehicle\)\s*\{[\s\S]*status:\s*"blocked"/);
assert.doesNotMatch(absoluteSafety, /if\s*\(targetVehicle\s*&&\s*!haveSameSdeVehicleTokens/);

const actionValidation = extractFunction("getSdeShiftMoveActionBlockReason");
for(const token of ["revalidateSdeAbsoluteTargetBeforeAction", "!targetValidation.ok"]){
  assert.ok(actionValidation.includes(token), `stale-action gate misses ${token}`);
}
const absoluteRevalidation = extractFunction("revalidateSdeAbsoluteTargetBeforeAction");
for(const token of ["REPLAN_REQUIRED", "PLACEMENT_REVISION_CHANGED", "releaseReservation:true"]){
  assert.ok(absoluteRevalidation.includes(token), `absolute target revalidation misses ${token}`);
}

const workshop = extractFunction("buildWorkshopVehicleRegistryHtml");
for(const token of [
  "buildWorkshopHallOverviewHtml",
  "buildWorkshopActionCenterHtml",
  "8N",
  "7N",
  "8S",
  "7S",
  "Meld Driftsklart",
  "Bestill utkjøring",
  "Bestill innkjøring",
  "Send beskjed",
  "AVVIK – KONTROLLER SPORPLAN",
]){
  assert.ok(workshop.includes(token), `workshop UI misses ${token}`);
}
assert.match(source, /data-sde-workshop-single-context/);
assert.doesNotMatch(
  workshop,
  /buildWorkshopSlotStatusCardsHtml/,
  "the four parallel workshop status cards must not be rendered beside the hall"
);
assert.doesNotMatch(workshop, /Arbeid påbegynt|data-sde-workshop-work-started/);
assert.doesNotMatch(workshop, /record\?\.currentStatus\s*===\s*"IKKE_DRIFTSKLAR"/);

const refresh = extractFunction("refreshPageKeepingActiveTab");
for(const token of [
  "captureGlobalUpdateContext",
  "refreshGlobalAuthoritativeData",
  "restoreGlobalUpdateContext",
]){
  assert.ok(refresh.includes(token), `global refresh misses ${token}`);
}
assert.doesNotMatch(refresh, /window\.location\.(href|reload)/);

const captureContext = extractFunction("captureGlobalUpdateContext");
for(const token of [
  "activeTab",
  "accessLevel",
  "workshopActionCenterSelectedSlot",
  "workshopVehicleRegistrySelectedVehicle",
  "workshopStandardSheetCollapsed",
  "workshopIngressDraft",
  "operationalMessageDrafts",
  "operationalMessageEditorContext",
  "scrollX",
  "scrollY",
]){
  assert.ok(captureContext.includes(token), `captured update context misses ${token}`);
}

const restoreContext = extractFunction("restoreGlobalUpdateContext");
for(const token of [
  "workshopActionCenterSelectedSlot",
  "workshopVehicleRegistrySelectedVehicle",
  "workshopStandardSheetCollapsed",
  "workshopIngressDraft",
  "operationalMessageDrafts",
  "restoreOperationalMessageEditorContext",
  "scrollTo",
]){
  assert.ok(restoreContext.includes(token), `restored update context misses ${token}`);
}

const authoritativeRefresh = extractFunction("refreshGlobalAuthoritativeData");
for(const token of [
  "fetchBaliseStaticJson",
  "loadDropsVehicleStatusContext",
  "Promise.allSettled",
]){
  assert.ok(authoritativeRefresh.includes(token), `authoritative refresh misses ${token}`);
}

const hall = extractFunction("buildWorkshopHallOverviewHtml");
for(const slot of ["8N", "7N", "8S", "7S"]){
  assert.ok(hall.includes(`"${slot}"`), `3D hall selector misses ${slot}`);
}
for(const token of [
  "data-sde-workshop-overview-slot",
  "aria-pressed",
  "workshop-hall-overview-slot",
]){
  assert.ok(hall.includes(token), `3D hall selector misses ${token}`);
}

const slotCards = extractFunction("buildWorkshopSlotStatusCardsHtml");
assert.doesNotMatch(slotCards, /data-sde-workshop-select-slot/);

const actionCenter = extractFunction("buildWorkshopActionCenterHtml");
assert.doesNotMatch(actionCenter, /data-sde-workshop-slot-select/);
assert.doesNotMatch(actionCenter, />Målspor</);
for(const token of [
  "getWorkshopExitRequestAvailability",
  "data-sde-workshop-open-prebooking",
  "data-sde-workshop-prebooking-type",
  "data-sde-workshop-prebooking-individual",
  "data-sde-workshop-prebooking-slot",
  "data-sde-workshop-prebooking-summary",
  "data-sde-workshop-queue-add",
  "workshopIngressDraft",
  "Bestilling av innkjøring (ASAP)",
  "Legg i kø, innkjøring",
  "Type 69",
  "Type 70",
  "Type 74",
  "Type 75",
  "Individnr.",
  'requestType:"ASAP"',
  'priority:"HIGH"',
  'requestType:"PREBOOKED"',
  'priority:"NORMAL"',
]){
  assert.ok(actionCenter.includes(token), `action center misses ${token}`);
}
for(const cssClass of [
  "workshop-action-3d--operational",
  "workshop-action-3d--exit",
  "workshop-action-3d--status",
  "workshop-action-3d--prebooking",
  "workshop-action-3d--message",
]){
  assert.ok(source.includes(cssClass), `3D action system misses ${cssClass}`);
}
assert.match(actionCenter, /data-sde-workshop-request-exit[^>]*(disabled|aria-disabled)/);
assert.doesNotMatch(actionCenter, /allVehicles[\s\S]*<option/);

const workshopRenderer = extractFunction("renderWorkshopVehicleRegistry");
assert.ok(
  workshopRenderer.includes("shouldDeferWorkshopRegistryRender"),
  "workshop renderer must preserve an active Type/Individ selector"
);
const readbackRefresh = extractFunction("refreshVehicleStatusReadback");
assert.ok(
  readbackRefresh.includes("shouldRenderWorkshopVehicleRegistryForReadback"),
  "unchanged polling must not rebuild the workshop registry"
);
assert.doesNotMatch(
  readbackRefresh,
  /acceptVehicleStatusReadback\(readback\);\s*renderWorkshopVehicleRegistry\(\);/
);
for(const token of [
  "workshopIngressDraft.incomingVehicleType",
  "data-sde-workshop-prebooking-type",
  "data-sde-workshop-prebooking-individual",
]){
  assert.ok(source.includes(token), `stable Type/Individ flow misses ${token}`);
}

const popup = extractFunction("buildWorkshopNotificationPopupHtml");
assert.ok(source.includes('label:"Åpne statusark"'));
assert.ok(popup.includes("operationalDeepLink.label"));
assert.ok(popup.includes("data-sde-acknowledge-operational-message"));
assert.ok(popup.includes("OPERATIONAL_MESSAGE"));
assert.ok(popup.includes("aria-label"));
assert.ok(popup.includes("escapeHtml") || popup.includes("esc("));

const visibility = extractFunction("isVehicleStatusNotificationVisibleInCurrentSurface");
for(const token of ["OPERATIONAL_MESSAGE", "OPERATIONAL_MESSAGE_ROLE_SURFACES"]){
  assert.ok(visibility.includes(token), `message routing misses ${token}`);
}
for(const role of ["drops", "txp", "sde_skiftere", "verksted", "agila"]){
  assert.ok(source.includes(`${role}:`), `message surface map misses ${role}`);
}

const globalComposer = extractFunction("renderOperationalMessageComposers");
for(const token of [
  "data-sde-operational-message-host",
  "data-sde-operational-message-target",
  "data-sde-operational-message-text",
  "data-sde-operational-message-send",
  "maxlength=\"250\"",
]){
  assert.ok(globalComposer.includes(token) || source.includes(token), `global message composer misses ${token}`);
}
assert.ok((source.match(/data-sde-operational-message-host/g) || []).length >= 5);
assert.ok(source.includes("operationalMessageReceipts"));
assert.ok(source.includes("Direktemeldinger fra Agilia"));
assert.ok(source.includes("Bestilling av sporplass til hovedrenhold"));
assert.doesNotMatch(actionCenter, /data-sde-operational-message-(?:target|text|send)/);
assert.ok(source.includes("@media (max-width: 520px)"));
assert.ok(source.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));

console.log(JSON.stringify({
  schemaVersion: "sde-global-update-stadler-action-center-ui-harness-v2",
  tests: 72,
}));

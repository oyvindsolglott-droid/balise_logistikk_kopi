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
assert.match(safety, /if\s*\(targetVehicle\)\s*\{[\s\S]*status:\s*"blocked"/);
assert.doesNotMatch(safety, /if\s*\(targetVehicle\s*&&\s*!haveSameSdeVehicleTokens/);

const actionValidation = extractFunction("getSdeShiftMoveActionBlockReason");
for(const token of ["getSdeTargetSlotSafety", "REPLAN_REQUIRED", "target_occupancy_changed"]){
  assert.ok(actionValidation.includes(token), `stale-action gate misses ${token}`);
}

const workshop = extractFunction("buildWorkshopVehicleRegistryHtml");
for(const token of [
  "buildWorkshopSlotStatusCardsHtml",
  "buildWorkshopActionCenterHtml",
  "8N",
  "7N",
  "8S",
  "7S",
  "Meld Driftsklart",
  "Bestill utkjøring",
  "Forhåndsbestill innkjøring",
  "Send beskjed",
  "AVVIK – KONTROLLER SPORPLAN",
]){
  assert.ok(workshop.includes(token), `workshop UI misses ${token}`);
}
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
  "workshopMessageDraft",
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
  "workshopMessageDraft",
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
  "data-sde-workshop-prebooking-vehicle",
  "data-sde-workshop-prebooking-slot",
  "data-sde-workshop-prebooking-summary",
  "data-sde-workshop-queue-add",
  "workshopIngressDraft",
  "data-sde-workshop-message-target",
  "data-sde-workshop-message-text",
  "workshopMessageDraft",
  "selectedSlotId",
  "selectedVehicleId",
  "DROPS",
  "TXP",
  "Skiftere",
  "Agilia",
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

const popup = extractFunction("buildWorkshopNotificationPopupHtml");
assert.ok(popup.includes("Åpne statusark"));
assert.ok(popup.includes("WORKSHOP_MESSAGE"));
assert.ok(popup.includes("aria-label"));
assert.ok(popup.includes("escapeHtml") || popup.includes("esc("));

const visibility = extractFunction("isVehicleStatusNotificationVisibleInCurrentSurface");
for(const token of ["WORKSHOP_MESSAGE", "drops", "txp", "sde_skiftere", "agila"]){
  assert.ok(visibility.includes(token), `message routing misses ${token}`);
}

for(const token of [
  "data-sde-workshop-prebooking-vehicle",
  "data-sde-workshop-prebooking-slot",
  "data-sde-workshop-queue-add",
  "data-sde-workshop-message-target",
  "data-sde-workshop-message-text",
  "maxlength=\"250\"",
  "workshopIngressQueue",
  "workshopMessages",
]){
  assert.ok(source.includes(token), `action center misses ${token}`);
}
assert.ok(source.includes("@media (max-width: 520px)"));
assert.ok(source.includes("grid-template-columns:repeat(2,minmax(0,1fr))"));

console.log(JSON.stringify({
  schemaVersion: "sde-global-update-stadler-action-center-ui-harness-v2",
  tests: 68,
}));

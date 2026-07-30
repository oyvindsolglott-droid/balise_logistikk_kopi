"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = process.argv[2] || path.resolve(__dirname, "../../../index.html");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
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
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

const notificationRecord = extractFunction("getOperationalMessageNotificationRecord");
for (const token of [
  "messageId",
  "threadId",
  "rootMessageId",
  "sourceRole",
  "targetRole",
  "parentMessageId",
]) {
  assert.ok(notificationRecord.includes(token), `notification-to-thread mapping is missing ${token}`);
}
assert.match(
  notificationRecord,
  /OPERATIONAL_MESSAGE|WORKSHOP_MESSAGE/,
  "only operational message notification kinds may become reply threads",
);

const replyContext = extractFunction("getOperationalMessagePopupReplyContext");
assert.match(replyContext, /thread:/, "popup reply must use the canonical thread draft key");
assert.match(
  replyContext,
  /getOperationalMessageDraft/,
  "popup reply must share the canonical draft store with the regular composer",
);
assert.match(
  replyContext,
  /hasOperationalMessageReplyCapability/,
  "popup reply must be absent when the active level lacks the reply capability",
);

const replyCapability = extractFunction("hasOperationalMessageReplyCapability");
for (const token of [
  "getActiveOperationalMessageRole",
  "roleResolved",
  "roles.includes",
  "vehicle_status.send_operational_message",
  "ALLOW",
]) {
  assert.ok(replyCapability.includes(token), `reply capability guard is missing ${token}`);
}

const protectedActivity = extractFunction("hasProtectedOperationalMessageActivity");
for (const token of [
  "operationalMessageActiveThreadByRole",
  "document.activeElement",
  "message",
]) {
  assert.ok(protectedActivity.includes(token), `protected user activity guard is missing ${token}`);
}

const activation = extractFunction("activateOperationalMessageThreadFromNotification");
assert.match(
  activation,
  /hasProtectedOperationalMessageActivity/,
  "incoming thread activation must preserve protected user activity",
);
assert.match(
  activation,
  /operationalMessageActiveThreadByRole\.set/,
  "incoming thread must become the active regular conversation when safe",
);

const activeThread = extractFunction("getActiveOperationalMessageThreadId");
assert.match(
  activeThread,
  /hasProtectedOperationalMessageActivity/,
  "newest received thread must replace an unprotected empty New conversation",
);

const popup = extractFunction("buildWorkshopNotificationPopupHtml");
for (const token of [
  "data-sde-notification-id",
  "data-sde-operational-message-popup-reply",
  "data-sde-operational-message-text",
  "data-sde-operational-message-send",
  "Send svar",
  "Kvitter mottatt",
]) {
  assert.ok(popup.includes(token), `popup reply UI is missing ${token}`);
}
assert.match(
  popup,
  /getOperationalMessagePopupReplyContext/,
  "popup must only render a reply editor for a valid operational thread",
);

const popupSync = extractFunction("syncOperationalMessagePopupReplyUi");
for (const token of [
  "getOperationalMessagePopupReplyContext",
  "getOperationalMessageAvailability",
  "tabindex",
  "disabled",
  "data-sde-operational-message-popup-reply",
]) {
  assert.ok(popupSync.includes(token), `popup/background composer synchronisation is missing ${token}`);
}

const popupRender = extractFunction("renderVehicleStatusNotificationPopup");
assert.match(
  popupRender,
  /sdeNotificationId/,
  "polling must preserve a mounted popup for the same notification",
);
assert.match(
  popupRender,
  /sdePopupReplyAuthorized/,
  "the popup may rebuild once when reply authorization becomes available",
);
assert.match(
  popupRender,
  /syncOperationalMessagePopupReplyUi/,
  "polling must synchronise the mounted popup without replacing its textarea",
);

const selectNotification = extractFunction("selectVehicleStatusNotificationVehicle");
assert.match(
  selectNotification,
  /activateOperationalMessageThreadFromNotification/,
  "opening a received message must surface its canonical thread in the regular module",
);

const statusUpdate = extractFunction("updateOperationalMessageComposerStatus");
assert.match(
  statusUpdate,
  /syncOperationalMessagePopupReplyUi/,
  "popup and regular composer must share availability, draft and send state",
);

const submit = extractFunction("submitOperationalMessageFromUi");
assert.match(submit, /threadId/, "reply submission must preserve the existing threadId");
assert.match(submit, /rootMessageId/, "reply submission must preserve the existing rootMessageId");
assert.match(submit, /parentMessageId/, "reply submission must preserve the existing parentMessageId");
assert.doesNotMatch(
  submit,
  /acknowledgeOperationalMessageFromUi|acknowledge-operational-message/,
  "sending a reply must not acknowledge the received message",
);

const refresh = extractFunction("refreshVehicleStatusReadback");
assert.doesNotMatch(
  refresh,
  /renderOperationalMessageComposers/,
  "polling must not rebuild message composers",
);

class FakeHTMLElement {}
const popupTextarea = new FakeHTMLElement();
popupTextarea.value = "Svarutkast med markør";
popupTextarea.selectionStart = 7;
popupTextarea.selectionEnd = 14;
popupTextarea.closest = () => null;
let mountedPopup = null;
let popupReplacements = 0;
const popupHost = {
  classList:{remove(){}},
  querySelector(selector){
    if(selector === "[data-sde-notification-id]") return mountedPopup;
    return null;
  },
  set innerHTML(value){
    popupReplacements += 1;
    mountedPopup = {
      dataset:{
        sdeNotificationId:"notification-1",
        sdePopupReplyAuthorized:"true",
      },
    };
    this.html = value;
  },
  get innerHTML(){ return this.html || ""; },
};
const popupNotification = {
  notificationId:"notification-1",
  kind:"OPERATIONAL_MESSAGE",
  targetRole:"drops",
};
const popupDocument = {
  activeElement:popupTextarea,
  body:{appendChild(){}},
  getElementById(id){
    return id === "vehicleStatusNotificationHost" ? popupHost : null;
  },
  createElement(){ return popupHost; },
};
const popupContext = {
  document:popupDocument,
  window:{requestAnimationFrame(callback){ callback(); }},
  HTMLElement:FakeHTMLElement,
  getNextVehicleStatusNotification:()=>popupNotification,
  getOperationalMessagePopupReplyContext:()=>({role:"drops"}),
  activateOperationalMessageThreadFromNotification:()=>false,
  renderOperationalMessageThreads(){},
  updateOperationalMessageComposerStatus(){},
  vehicleStatusNotificationReturnFocusElement:null,
  vehicleStatusNotificationAutoSelections:new Set(),
  selectWorkshopNotificationVehicle(){},
  buildWorkshopNotificationPopupHtml:()=>"<section>popup</section>",
  syncOperationalMessagePopupReplyUi(){},
  attemptVehicleStatusNotificationAudio(){},
  recordVehicleStatusNotificationPresented(){},
};
vm.createContext(popupContext);
vm.runInContext(`${popupRender}; this.renderPopup=renderVehicleStatusNotificationPopup;`, popupContext);
popupContext.renderPopup();
const popupNodeAfterFirstRender = mountedPopup;
for(let tick = 0; tick < 10; tick += 1){
  popupContext.renderPopup();
  assert.equal(mountedPopup,popupNodeAfterFirstRender,`poll tick ${tick + 1} replaced the popup node`);
  assert.equal(popupDocument.activeElement,popupTextarea,`poll tick ${tick + 1} lost focus`);
  assert.equal(popupTextarea.selectionStart,7,`poll tick ${tick + 1} moved the caret start`);
  assert.equal(popupTextarea.selectionEnd,14,`poll tick ${tick + 1} moved the caret end`);
}
assert.equal(popupReplacements,1,"the same notification must render exactly once across ten poll ticks");

process.stdout.write(JSON.stringify({
  schemaVersion: "sde-popup-reply-thread-surfacing-harness-v1",
  contracts: {
    popupReplyUsesExistingThread: true,
    oneCanonicalDraftPerThread: true,
    stablePopupAcrossPolling: true,
    stablePopupPollTicks: 10,
    noDuplicateActiveEditor: true,
    safeAutomaticThreadSurfacing: true,
    replyDoesNotAcknowledge: true,
  },
}) + "\n");

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(text, name) {
  const marker = `function ${name}(`;
  const functionStart = text.indexOf(marker);
  assert.ok(functionStart >= 0, `missing production function ${name}`);
  const start = text.slice(Math.max(0, functionStart - 6), functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const signatureEnd = text.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing production body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for(let index = open; index < text.length; index += 1){
    const character = text[index];
    const next = text[index + 1];
    if(lineComment){
      if(character === "\n") lineComment = false;
      continue;
    }
    if(blockComment){
      if(character === "*" && next === "/"){
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if(quote){
      if(escaped) escaped = false;
      else if(character === "\\") escaped = true;
      else if(character === quote) quote = "";
      continue;
    }
    if(character === "/" && next === "/"){
      lineComment = true;
      index += 1;
      continue;
    }
    if(character === "/" && next === "*"){
      blockComment = true;
      index += 1;
      continue;
    }
    if(character === "'" || character === '"' || character === "`"){
      quote = character;
      continue;
    }
    if(character === "{") depth += 1;
    if(character === "}"){
      depth -= 1;
      if(depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed production function ${name}`);
}

const audioControl = extractFunction(source, "buildVehicleStatusAudioControlHtml");
const activateAudio = extractFunction(source, "activateVehicleStatusNotificationAudio");
const attemptAudio = extractFunction(source, "attemptVehicleStatusNotificationAudio");
const reconcileNotifications = extractFunction(source, "reconcileVehicleStatusNotifications");
const notificationVisibility = extractFunction(source, "isVehicleStatusNotificationVisibleInCurrentSurface");
const nextNotification = extractFunction(source, "getNextVehicleStatusNotification");
const popupHtml = extractFunction(source, "buildWorkshopNotificationPopupHtml");
const popup = extractFunction(source, "renderVehicleStatusNotificationPopup");

assert.match(audioControl, /data-sde-activate-vehicle-status-audio/);
assert.match(audioControl, /Aktiver lydvarsling/);
assert.match(audioControl, /Lydvarsling aktiv/);
assert.match(activateAudio, /\.resume\(\)/, "user gesture must resume AudioContext");
assert.match(activateAudio, /playVehicleStatusNotificationTone/, "activation must play a confirmation tone");
assert.match(attemptAudio, /vehicleStatusNotificationAudioEnabled/, "notification sound must require explicit activation");
assert.match(attemptAudio, /notificationId/, "sound deduplication must be notification-bound");
assert.match(attemptAudio, /vehicleStatusNotificationAudioAttempts/, "one sound attempt per notificationId");
assert.match(reconcileNotifications, /vehicleStatusNotificationKnownIds/);
assert.match(reconcileNotifications, /vehicleStatusNotificationPending/);
assert.match(reconcileNotifications, /REPAIR_REQUESTED/);
assert.match(nextNotification, /vehicleStatusNotificationPending/);
assert.match(popupHtml, /Bestilling av reparasjon/);
assert.match(popupHtml, /Kjøretøy:/);
assert.match(popupHtml, /Feiltype:/);
assert.match(popupHtml, /Beskrivelse:/);
assert.match(popupHtml, /Bestilt:/);
assert.match(popupHtml, /Ny intern utbedringsbestilling fra DROPS/);
assert.match(popupHtml, /requestedAt/);
assert.match(popup, /getNextVehicleStatusNotification\(\)/);
assert.match(notificationVisibility, /getActiveAccessLevel\(\)/);
assert.doesNotMatch(
  notificationVisibility,
  /getActiveTabName\(\)/,
  "notification visibility must follow the complete target level, not one tab",
);
assert.match(notificationVisibility, /OPERATIONAL_MESSAGE_ROLE_SURFACES/);
assert.match(notificationVisibility, /level === target\.level/);
assert.match(popup, /selectWorkshopNotificationVehicle\(next\)/);
assert.match(popup, /host\.innerHTML = buildWorkshopNotificationPopupHtml\(next\)/);
assert.match(popup, /if\(next\) attemptVehicleStatusNotificationAudio\(next\)/);
assert.ok(
  popup.indexOf("host.innerHTML = buildWorkshopNotificationPopupHtml(next)") <
    popup.indexOf("attemptVehicleStatusNotificationAudio(next)"),
  "popup must render before the optional sound attempt",
);
assert.ok(
  (source.match(/buildVehicleStatusAudioControlHtml\(\)/g) || []).length >= 3,
  "the shared audio control must be rendered in both DROPS and Verksted",
);

for(const functionSource of [audioControl, activateAudio, attemptAudio, popup]){
  assert.doesNotMatch(functionSource, /localStorage\./);
  assert.doesNotMatch(functionSource, /sessionStorage\.(?:setItem|removeItem)\([^)]*(?:status|fault|repair|vehicleId)/i);
  assert.doesNotMatch(functionSource, /\/api\/shared-sporplan-draft/);
  assert.doesNotMatch(functionSource, /method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
}

assert.match(
  extractFunction(source, "handleDropsNotOperationalRegistryClick"),
  /data-sde-activate-vehicle-status-audio/,
  "the shared click path must treat audio activation as a user gesture",
);

async function main(){
  const counters = { resumes: 0, starts: 0 };
  const control = {
    classList: { toggle(){} },
    setAttribute(){},
    textContent: ""
  };
  const notificationHost = { classList: { add(){} } };
  class FakeAudioContext {
    constructor(){
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
    }
    async resume(){
      counters.resumes += 1;
      this.state = "running";
    }
    createOscillator(){
      let ended = null;
      return {
        frequency: { value: 0 },
        connect(){ return this; },
        addEventListener(name, callback){ if(name === "ended") ended = callback; },
        start(){ counters.starts += 1; },
        stop(){ ended?.(); }
      };
    }
    createGain(){
      return {
        gain: { value: 0 },
        connect(){ return this; }
      };
    }
  }
  const context = {
    Promise,
    Set,
    window: {
      AudioContext: FakeAudioContext,
      webkitAudioContext: null,
      setTimeout(callback){ callback(); }
    },
    document: {
      querySelectorAll(){ return [control]; },
      getElementById(){ return notificationHost; }
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    let vehicleStatusNotificationAudioContext = null;
    let vehicleStatusNotificationAudioEnabled = false;
    let activeVehicleStatusNotification = null;
    const vehicleStatusNotificationAudioAttempts = new Set();
    ${extractFunction(source, "updateVehicleStatusAudioControls")}
    ${extractFunction(source, "playVehicleStatusNotificationTone")}
    ${activateAudio}
    ${attemptAudio}
    this.api = {
      activateVehicleStatusNotificationAudio,
      attemptVehicleStatusNotificationAudio,
      snapshot(){
        return {
          enabled: vehicleStatusNotificationAudioEnabled,
          attempts: [...vehicleStatusNotificationAudioAttempts]
        };
      }
    };
  `, context);

  assert.equal(await context.api.activateVehicleStatusNotificationAudio(), true);
  assert.equal(counters.resumes, 1);
  assert.equal(counters.starts, 1, "activation must attempt one confirmation tone");
  assert.equal(context.api.snapshot().enabled, true);
  assert.equal(control.textContent, "Lydvarsling aktiv");

  context.api.attemptVehicleStatusNotificationAudio({
    notificationId: "notification-1",
    priority: "HIGH"
  });
  await Promise.resolve();
  assert.equal(counters.starts, 2);
  context.api.attemptVehicleStatusNotificationAudio({
    notificationId: "notification-1",
    priority: "HIGH"
  });
  await Promise.resolve();
  assert.equal(counters.starts, 2, "polling must not replay the same notification sound");
  context.api.attemptVehicleStatusNotificationAudio({
    notificationId: "notification-2",
    priority: "NORMAL"
  });
  await Promise.resolve();
  assert.equal(counters.starts, 3);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.api.snapshot().attempts)),
    ["notification-1", "notification-2"]
  );

  const popupNotificationHost = {
    classList: { add(){}, remove(){} },
    innerHTML: "",
  };
  const notificationSelections = [];
  const notificationAudioAttempts = [];
  let activeLevel = "1";
  const notificationContext = {
    console,
    Date,
    Set,
    escapeHtml(value){
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    },
    formatDropsVehicleStatusTimestamp(value){
      return `nb:${value}`;
    },
    getActiveAccessLevel(){
      return activeLevel;
    },
    getActiveTabName(){
      return activeLevel === "4" ? "verkstedBestillinger" : "grunnoppstilling";
    },
    OPERATIONAL_MESSAGE_ROLE_LABELS: Object.freeze({
      drops: "DROPS",
      txp: "TXP",
      sde_skiftere: "Skiftere",
      verksted: "Verksted",
      agila: "Agilia",
    }),
    OPERATIONAL_MESSAGE_ROLE_SURFACES: Object.freeze({
      drops: Object.freeze({ level: "1" }),
      txp: Object.freeze({ level: "2" }),
      sde_skiftere: Object.freeze({ level: "3" }),
      verksted: Object.freeze({ level: "4" }),
      agila: Object.freeze({ level: "5" }),
    }),
    setActiveAccessLevel(value){
      activeLevel = String(value);
    },
    document: {
      body: { appendChild(){} },
      createElement(){ return popupNotificationHost; },
      getElementById(){ return popupNotificationHost; },
    },
  };
  vm.createContext(notificationContext);
  vm.runInContext(`
    let activeVehicleStatusNotification = null;
    const dismissedVehicleStatusNotifications = new Set();
    const vehicleStatusNotificationKnownIds = new Set();
    const vehicleStatusNotificationPending = [];
    const vehicleStatusNotificationAutoSelections = new Set();
    let vehicleStatusNotificationBaselineInitialized = false;
    let dropsVehicleStatusReadback = null;
    function selectWorkshopNotificationVehicle(notification){
      notificationSelections.push({
        notificationId:notification.notificationId,
        vehicleId:notification.vehicleId,
        faultId:notification.faultId
      });
    }
    function attemptVehicleStatusNotificationAudio(notification){
      if(notificationAudioAttempts.includes(notification.notificationId)) return;
      notificationAudioAttempts.push(notification.notificationId);
    }
    ${reconcileNotifications}
    ${notificationVisibility}
    ${nextNotification}
    ${popupHtml}
    ${popup}
    this.api = {
      reconcileVehicleStatusNotifications,
      renderVehicleStatusNotificationPopup,
      setReadback(value){ dropsVehicleStatusReadback = value; },
      setLevel(value){ setActiveAccessLevel(value); },
      snapshot(){
        return {
          active:activeVehicleStatusNotification,
          pending:[...vehicleStatusNotificationPending],
          known:[...vehicleStatusNotificationKnownIds],
          selections:[...notificationSelections],
          audio:[...notificationAudioAttempts],
          html:document.getElementById("vehicleStatusNotificationHost").innerHTML
        };
      }
    };
  `, notificationContext);
  Object.assign(notificationContext, {
    notificationSelections,
    notificationAudioAttempts,
  });

  const historicalRepair = {
    notificationId: "historical-repair",
    targetRole: "verksted",
    kind: "REPAIR_REQUESTED",
    priority: "HIGH",
    vehicleId: "74-04",
    faultId: "historical-fault",
    createdAt: "2026-07-24T07:00:00.000Z",
    payload: { category: "A1", description: "Historisk", requestedAt: "2026-07-24T07:00:00.000Z" },
  };
  notificationContext.api.reconcileVehicleStatusNotifications({ ok: true, notifications: [historicalRepair] });
  notificationContext.api.setReadback({ ok: true, notifications: [historicalRepair] });
  notificationContext.api.renderVehicleStatusNotificationPopup();
  assert.equal(notificationContext.api.snapshot().active, null, "initial history must establish a silent presentation baseline");
  assert.deepEqual(JSON.parse(JSON.stringify(notificationContext.api.snapshot().selections)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(notificationContext.api.snapshot().audio)), []);

  notificationContext.api.reconcileVehicleStatusNotifications({ ok: true, notifications: [historicalRepair] });
  notificationContext.api.renderVehicleStatusNotificationPopup();
  assert.deepEqual(
    JSON.parse(JSON.stringify(notificationContext.api.snapshot().selections)),
    [],
    "report-not-operational readback without a new notification must stay silent",
  );

  const repairNotification = {
    notificationId: "repair-request-2",
    targetRole: "verksted",
    kind: "REPAIR_REQUESTED",
    priority: "HIGH",
    vehicleId: "74-41",
    faultId: "fault-74-41-new",
    createdAt: "2026-07-25T11:12:13.000Z",
    payload: {
      category: "A3",
      description: "Ny serverbekreftet feil",
      requestedAt: "2026-07-25T11:12:13.000Z",
    },
  };
  const repairReadback = { ok: true, notifications: [historicalRepair, repairNotification] };
  notificationContext.api.reconcileVehicleStatusNotifications(repairReadback);
  notificationContext.api.setReadback(repairReadback);
  notificationContext.api.renderVehicleStatusNotificationPopup();
  let notificationSnapshot = notificationContext.api.snapshot();
  assert.equal(notificationSnapshot.active, null, "repair notification must stay hidden outside Nivå 4");
  assert.deepEqual(JSON.parse(JSON.stringify(notificationSnapshot.selections)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(notificationSnapshot.audio)), []);
  assert.equal(notificationSnapshot.html, "");

  for(const level of ["0", "1", "2", "3", "5"]){
    notificationContext.api.setLevel(level);
    notificationContext.api.renderVehicleStatusNotificationPopup();
    notificationSnapshot = notificationContext.api.snapshot();
    assert.deepEqual(JSON.parse(JSON.stringify(notificationSnapshot.selections)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(notificationSnapshot.audio)), []);
    assert.equal(notificationSnapshot.html, "");
  }

  notificationContext.api.setLevel("4");
  notificationContext.api.renderVehicleStatusNotificationPopup();
  notificationSnapshot = notificationContext.api.snapshot();
  assert.equal(notificationSnapshot.active.notificationId, repairNotification.notificationId);
  assert.deepEqual(JSON.parse(JSON.stringify(notificationSnapshot.selections)), [{
    notificationId: "repair-request-2",
    vehicleId: "74-41",
    faultId: "fault-74-41-new",
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(notificationSnapshot.audio)), ["repair-request-2"]);
  assert.match(notificationSnapshot.html, /Bestilling av reparasjon/);
  assert.match(notificationSnapshot.html, /Ny intern utbedringsbestilling fra DROPS/);
  assert.match(notificationSnapshot.html, /74-41/);
  assert.match(notificationSnapshot.html, /Feiltype: A3/);
  assert.match(notificationSnapshot.html, /Beskrivelse: Ny serverbekreftet feil/);
  assert.match(notificationSnapshot.html, /nb:2026-07-25T11:12:13.000Z/);

  notificationContext.api.reconcileVehicleStatusNotifications(repairReadback);
  notificationContext.api.renderVehicleStatusNotificationPopup();
  notificationSnapshot = notificationContext.api.snapshot();
  assert.equal(notificationSnapshot.selections.length, 1, "polling and rerender must not repeat auto-selection");
  assert.equal(notificationSnapshot.audio.length, 1, "polling and rerender must not repeat the sound attempt");

  console.log(JSON.stringify({
    schemaVersion: "sde-drops-operational-rollout-harness-v1",
    status: "PASS",
    soundActivationControls: ["drops", "verksted"],
    confirmationToneAttempts: 1,
    notificationToneAttempts: 2,
    popupIndependentOfAudio: true,
    notificationDeduplication: "notificationId",
    reportNotOperationalNotificationAttempts: 0,
    repairAutoSelectionAttempts: notificationSnapshot.selections.length,
    businessWrite: false,
  }));
}

main().catch((error)=>{
  console.error(error.stack || error);
  process.exitCode = 1;
});

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
const popup = extractFunction(source, "renderVehicleStatusNotificationPopup");

assert.match(audioControl, /data-sde-activate-vehicle-status-audio/);
assert.match(audioControl, /Aktiver lydvarsling/);
assert.match(audioControl, /Lydvarsling aktiv/);
assert.match(activateAudio, /\.resume\(\)/, "user gesture must resume AudioContext");
assert.match(activateAudio, /playVehicleStatusNotificationTone/, "activation must play a confirmation tone");
assert.match(attemptAudio, /vehicleStatusNotificationAudioEnabled/, "notification sound must require explicit activation");
assert.match(attemptAudio, /notificationId/, "sound deduplication must be notification-bound");
assert.match(attemptAudio, /vehicleStatusNotificationAudioAttempts/, "one sound attempt per notificationId");
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

  console.log(JSON.stringify({
    schemaVersion: "sde-drops-operational-rollout-harness-v1",
    status: "PASS",
    soundActivationControls: ["drops", "verksted"],
    confirmationToneAttempts: 1,
    notificationToneAttempts: 2,
    popupIndependentOfAudio: true,
    notificationDeduplication: "notificationId",
    businessWrite: false,
  }));
}

main().catch((error)=>{
  console.error(error.stack || error);
  process.exitCode = 1;
});

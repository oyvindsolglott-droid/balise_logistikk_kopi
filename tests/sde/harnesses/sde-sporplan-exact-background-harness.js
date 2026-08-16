#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
const assetPath = path.join(root, "assets", "NY_SPORPLAN.png");
const asset = fs.readFileSync(assetPath);

function sha256(value){
  return crypto.createHash("sha256").update(value).digest("hex");
}

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for(let index = bodyStart; index < source.length; index += 1){
    const character = source[index];
    if(quote){
      if(escaped) escaped = false;
      else if(character === "\\") escaped = true;
      else if(character === quote) quote = "";
      continue;
    }
    if(character === "'" || character === '"' || character === "`"){
      quote = character;
      continue;
    }
    if(character === "{") depth += 1;
    if(character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

assert.equal(
  sha256(asset),
  "9510e11fea79600ef2354d68db5304bacb3a1551b09ccd2db3cb2ce3b7f8461c",
  "the exact supplied RGBA PNG must remain byte-identical"
);
assert.deepEqual([...asset.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
assert.equal(asset.readUInt32BE(16), 1448);
assert.equal(asset.readUInt32BE(20), 1086);
assert.equal(asset[25], 6, "PNG color type must remain RGBA");

const mainButtonParts = [
  /<button class="seg seg-sporplan-graphic"[^>]*data-tab="sporplan"[^>]*>[\s\S]*?<\/button>/,
  /\.segmented button\.seg-sporplan-graphic\{[^}]*\}/,
  /\.seg-sporplan-graphic__image\{[^}]*\}/,
  /\.segmented button\.seg-sporplan-graphic\.active\{[^}]*\}/,
  /\.segmented button\.seg-sporplan-graphic:focus-visible\{[^}]*\}/,
  /@media \(min-width:901px\)\{[\s\S]*?\n\}/
].map(pattern=>{
  const match = source.match(pattern);
  assert.ok(match, `missing locked main-button fragment ${pattern}`);
  return match[0];
});
assert.equal(
  sha256(mainButtonParts.join("\n---\n")),
  "ef3d73e5dbfdf4f7c1628f755ac1f0306075fe7d6f6997ede6204bba451627bf",
  "the main Sporplan button DOM, CSS, asset reference and routing must not change"
);
assert.equal(
  sha256(fs.readFileSync(path.join(root, "assets", "sporplan-skien-stasjon.png"))),
  "8a544aa9192817b1f9f7973c25167a9e3e87c52dc034062fe0d112cde286a010"
);

assert.match(
  source,
  /<img class="sporplan-yard-background" src="assets\/NY_SPORPLAN\.png\?v=9510e11f" alt="" aria-hidden="true">/
);
assert.match(source, /\.sporplan-yard-background\{[\s\S]*?object-fit:contain;/);
assert.doesNotMatch(source, /\.sporplan-yard-background\{[\s\S]*?object-fit:cover;/);
assert.match(source, /\.sporplan-yard-surface\{[\s\S]*?width:1448px;[\s\S]*?height:1086px;/);
assert.match(
  serverSource,
  /\["NY_SPORPLAN\.png", path\.join\(REPO_ROOT, "assets", "NY_SPORPLAN\.png"\)\]/
);

const inputSlotsMatch = source.match(/const inputSlots=(\[[^;]+\]);/);
assert.ok(inputSlotsMatch, "missing inputSlots");
const inputSlots = JSON.parse(inputSlotsMatch[1]);
assert.equal(inputSlots.length, 31);
const anchorsMatch = source.match(/const SPORPLAN_SLOT_ANCHORS=Object\.freeze\((\{[^;]+\})\);/);
assert.ok(anchorsMatch, "missing exact Sporplan anchor contract");
const anchors = JSON.parse(anchorsMatch[1]);
assert.deepEqual(Object.keys(anchors).sort(), [...inputSlots].sort());

for(const [slot, [x,y,width,height]] of Object.entries(anchors)){
  assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0, `${slot} has invalid geometry`);
  assert.ok(x + width <= 1448, `${slot} exceeds design width`);
  assert.ok(y + height <= 1086, `${slot} exceeds design height`);
}
for(let leftIndex = 0; leftIndex < inputSlots.length; leftIndex += 1){
  const leftSlot = inputSlots[leftIndex];
  const [leftX,leftY,leftWidth,leftHeight] = anchors[leftSlot];
  for(let rightIndex = leftIndex + 1; rightIndex < inputSlots.length; rightIndex += 1){
    const rightSlot = inputSlots[rightIndex];
    const [rightX,rightY,rightWidth,rightHeight] = anchors[rightSlot];
    const overlaps =
      leftX < rightX + rightWidth &&
      leftX + leftWidth > rightX &&
      leftY < rightY + rightHeight &&
      leftY + leftHeight > rightY;
    assert.equal(overlaps, false, `${leftSlot} overlaps ${rightSlot}`);
  }
}

const overlayModelSource = extractFunction("buildSporplanSlotOverlayModel");
const context = { Object, Array, Set, String, Boolean };
vm.createContext(context);
vm.runInContext(`
  const inputSlots=${JSON.stringify(inputSlots)};
  const SPORPLAN_SLOT_ANCHORS=Object.freeze(${JSON.stringify(anchors)});
  function normalizeSlot(value){ return String(value || "").trim().toUpperCase(); }
  ${overlayModelSource}
  this.buildSporplanSlotOverlayModel=buildSporplanSlotOverlayModel;
`, context);
const overlayModel = context.buildSporplanSlotOverlayModel([
  { slot:"5N", mat:"74-04", tog:"" },
  { slot:"10S", mat:"74-10", tog:"" },
  { slot:"VN", mat:"74-12", tog:"", wash:true }
], {
  repSlots:new Set(["5N"]),
  dreiSlots:new Set(["10S"]),
  planSkifteMarkers:{}
});
assert.equal(overlayModel.length, 31);
assert.equal(new Set(overlayModel.map(item=>item.slot)).size, 31);
assert.equal(overlayModel.find(item=>item.slot === "5N").vehicleId, "74-04");
assert.equal(overlayModel.find(item=>item.slot === "10S").vehicleId, "74-10");
assert.equal(overlayModel.find(item=>item.slot === "VN").vehicleId, "74-12");
assert.equal(overlayModel.find(item=>item.slot === "5N").isRepair, true);
assert.equal(overlayModel.find(item=>item.slot === "10S").isTurn, true);
assert.equal(overlayModel.find(item=>item.slot === "12N").filled, false);

const buildSporplanSource = extractFunction("buildSporplan");
assert.match(buildSporplanSource, /buildSporplanSlotOverlayModel/);
assert.match(buildSporplanSource, /inputSlots/);
assert.doesNotMatch(buildSporplanSource, /appendRow|yard-wash-machine-title|hall-frame/);
assert.doesNotMatch(
  `${overlayModelSource}\n${buildSporplanSource}`,
  /fetch\(|localStorage|sessionStorage|method\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/
);
assert.match(source, /Siste revisjon: 16\. august 2026/);

process.stdout.write(JSON.stringify({
  schemaVersion:"sde-sporplan-exact-background-harness-v1",
  status:"PASS",
  assetSha256:sha256(asset),
  anchors:Object.keys(anchors).length,
  occupiedSamples:["5N=74-04","10S=74-10","VN=74-12"],
  mainButtonLocked:true,
  businessWrite:false
}) + "\n");

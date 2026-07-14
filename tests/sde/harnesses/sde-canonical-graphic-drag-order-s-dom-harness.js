"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(process.argv[2],"utf8");
assert.equal((html.match(/function inspectSdeCanonicalGraphicDragOrder\s*\(/g) || []).length,1);
assert.equal((html.match(/function stageSdeCanonicalGraphicDragOrder\s*\(/g) || []).length,1);
assert.ok(html.includes("stageSdeCanonicalGraphicDragOrder(override)"));
assert.ok(html.includes("sdeCanonicalGraphicDragOrder:true"));
assert.ok(html.includes("dragRequestId:generatedId"));
const script = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map(match=>match[1]).find(source=>source.includes("function setupSdeNightPlacementDragAndDrop")) || "";
const start = script.indexOf("function setupSdeNightPlacementDragAndDrop");
const end = script.indexOf("\n\nlet sdeProductionReaderFallbackError",start);
assert.ok(start >= 0 && end > start);

const handlers = {};
const classSet = target=>({
  add:(...names)=>names.forEach(name=>target.classes.add(name)),
  remove:(...names)=>names.forEach(name=>target.classes.delete(name))
});
const source = {
  dataset:{
    sdeNightPlacementVehicle:"69-55",
    sdeNightPlacementCurrentSlot:"5M",
    sdeNightPlacementSlot:"5M",
    sdeNightPlacementFromSlot:"5M",
    sdeNightPlacementNeedKey:"need-69-55",
    sdeNightPlacementMoveKey:"move-69-55",
    sdeNightPlacementSourceKind:"standing"
  },
  classes:new Set(),
  closest(selector){return selector === "[data-sde-night-placement-draggable]" ? this : selector === "[data-sde-night-placement-slot]" ? this : null;},
  setPointerCapture(){},
  releasePointerCapture(){}
};
source.classList = classSet(source);
const target = {
  dataset:{sdeNightPlacementSlot:"10N"},
  classes:new Set(),
  closest(selector){return selector === "[data-sde-night-placement-slot]" ? this : null;},
  contains(){return false;}
};
target.classList = classSet(target);
const panel = {
  dataset:{},
  contains(node){return node === source || node === target;},
  addEventListener(type,handler){handlers[type]=handler;},
  querySelectorAll(){return [source,target];},
  querySelector(){return null;}
};
global.document = {
  getElementById(id){return id === "sdeNightPlacementPanel" ? panel : null;},
  elementFromPoint(){return target;}
};
global.sdeNightPlacementDragPayload = null;
const applied = [];
global.applySdeNightPlacementDragOverride = (payload,toSlot)=>{applied.push({payload:{...payload},toSlot});return true;};
global.clearSdeNightPlacementDragOverrides = ()=>{};
global.normalizeSlot = value=>String(value || "").trim().toUpperCase();
global.renderSdeSkiftebevegelser = ()=>{};
global.sdeNightPlacementSelectedSlot = "";

vm.runInThisContext(script.slice(start,end),{filename:"drag-dom.js"});
setupSdeNightPlacementDragAndDrop();
assert.equal(panel.dataset.sdeNightPlacementDragReady,"1");

const serialized = {value:""};
const dataTransfer = {
  effectAllowed:"",
  dropEffect:"",
  setData(type,value){assert.equal(type,"text/plain");serialized.value=value;},
  getData(type){assert.equal(type,"text/plain");return serialized.value;}
};
handlers.dragstart({target:source,dataTransfer});
assert.equal(dataTransfer.effectAllowed,"move");
sdeNightPlacementDragPayload = null;
handlers.dragover({target,preventDefault(){},dataTransfer});
handlers.drop({target,preventDefault(){},dataTransfer});
assert.deepEqual(applied[0],{
  payload:{vehicle:"69-55",slot:"5M",fromSlot:"5M",needKey:"need-69-55",moveKey:"move-69-55",sourceKind:"standing"},
  toSlot:"10N"
});
assert.equal(target.classes.has("drag-over"),false);
assert.equal(source.classes.has("dragging"),false);

const pointerBase = {target:source,pointerId:7,button:0,clientX:100,clientY:100,preventDefault(){}};
handlers.pointerdown(pointerBase);
handlers.pointermove({...pointerBase,clientX:130,clientY:130});
assert.equal(target.classes.has("drag-over"),true);
handlers.pointerup({...pointerBase,target,clientX:140,clientY:140});
assert.deepEqual(applied[1],{
  payload:{vehicle:"69-55",slot:"5M",fromSlot:"5M",needKey:"need-69-55",moveKey:"move-69-55",sourceKind:"standing"},
  toSlot:"10N"
});
assert.equal(target.classes.has("drag-over"),false);
assert.equal(source.classes.has("dragging"),false);

console.log(JSON.stringify({ok:true,html5DataTransfer:true,nativePointer:true,receiverCalls:applied.length,dragClassesCleared:true},null,2));

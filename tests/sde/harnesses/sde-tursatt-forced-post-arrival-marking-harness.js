"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const indexPath = process.argv[2];
const html = fs.readFileSync(indexPath, "utf8");
const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
  .filter(match=>!/\bsrc\s*=/.test(match[1]) && !/type=["'](?:application\/json|application\/ld\+json|text\/plain)["']/i.test(match[1]))
  .map(match=>match[2]);
const tursattPostArrivalModuleSource = fs.readFileSync(
  path.join(__dirname, "../../../sde_tursatt_post_arrival.js"),
  "utf8",
);

const storage = () => ({getItem(){return null;},setItem(){},removeItem(){},clear(){}});

function makeClassList(){
  const set = new Set();
  return {
    add(...names){names.forEach(name=>set.add(name));},
    remove(...names){names.forEach(name=>set.delete(name));},
    toggle(name){set.has(name) ? set.delete(name) : set.add(name);},
    contains(name){return set.has(name);},
    _set:set
  };
}

const fakeElement = () => ({
  style:{setProperty(){},removeProperty(){}},
  children:[],childNodes:[],classList:makeClassList(),dataset:{},
  addEventListener(){},removeEventListener(){},
  appendChild(child){this.children.push(child); return child;},
  replaceChildren(...items){this.children=items;},
  querySelector(){return null;},querySelectorAll(){return [];},closest(){return null;},contains(){return false;},
  setAttribute(){},removeAttribute(){},getAttribute(){return null;},
  getBoundingClientRect(){return {left:0,top:0,width:0,height:0};},
  innerHTML:"",textContent:"",value:"",checked:false
});
const document = {
  addEventListener(){},removeEventListener(){},createElement(){return fakeElement();},getElementById(){return fakeElement();},
  querySelector(){return null;},querySelectorAll(){return [];},body:fakeElement(),documentElement:fakeElement()
};
const ctx = {
  console,
  setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},
  requestAnimationFrame(){return 1;},cancelAnimationFrame(){},
  location:{origin:"http://localhost",href:"http://localhost/",pathname:"/",search:"",hostname:"localhost"},
  addEventListener(){},removeEventListener(){},dispatchEvent(){},matchMedia(){return {matches:false,addEventListener(){},removeEventListener(){}};},
  innerWidth:1200,scrollTo(){},localStorage:storage(),sessionStorage:storage(),document,
  navigator:{userAgent:"node"},URL,URLSearchParams,Blob:function(){},FileReader:function(){},
  fetch:async()=>({ok:false,json:async()=>({}),text:async()=>""}),
  alert(message){throw new Error(`unexpected alert: ${message}`);}
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.module = undefined;
vm.createContext(ctx);
vm.runInContext(tursattPostArrivalModuleSource, ctx, {filename:"sde_tursatt_post_arrival.js"});
vm.runInContext(scripts.join("\n;\n"), ctx, {filename:"index-inline.js"});

const forcedTrains = ctx.window.SdeTursattPostArrival.TURSATT_FORCE_POST_ARRIVAL_SHUNT_TRAINS;
assert.deepEqual(
  [...forcedTrains],
  ["835", "837", "839", "851", "853", "855", "861", "863"],
);

for (const train of forcedTrains) {
  assert.equal(
    ctx.isSdeTursattForcedPostArrivalShuntTrain(train), true,
    `expected ${train} to be a forced post-arrival-shunt train`,
  );
}
for (const train of ["820", "840", "852", "862", "808", ""]) {
  assert.equal(
    ctx.isSdeTursattForcedPostArrivalShuntTrain(train), false,
    `expected ${train} to not be a forced post-arrival-shunt train`,
  );
}

function appendSide(train, side){
  const tr = fakeElement();
  const rowData = train ? {train, displayTime:"20:00", mode:""} : null;
  ctx.appendOppstillingSideCells(tr, rowData, side);
  return tr;
}

for (const train of forcedTrains) {
  const arrivalRow = appendSide(train, "arrival");
  assert.equal(
    arrivalRow.classList.contains("opp-forced-post-arrival-shunt"), true,
    `arrival row for forced train ${train} should get the red-border marker class`,
  );
  const departureRow = appendSide(train, "departure");
  assert.equal(
    departureRow.classList.contains("opp-forced-post-arrival-shunt"), false,
    `departure row for train ${train} should not get the arrival-only marker class`,
  );
}

const ordinaryArrivalRow = appendSide("820", "arrival");
assert.equal(
  ordinaryArrivalRow.classList.contains("opp-forced-post-arrival-shunt"), false,
  "arrival row for a non-forced train should not get the marker class",
);

const emptyRow = appendSide("", "arrival");
assert.equal(emptyRow.classList.contains("opp-forced-post-arrival-shunt"), false);

assert.match(
  html,
  /#oppstillingTable tr\.opp-forced-post-arrival-shunt td:nth-child\(-n\+7\)\{[^}]*border-top:2px solid #dc2626;[^}]*border-bottom:2px solid #dc2626;/s,
);
assert.match(
  html,
  /#oppstillingTable tr\.opp-forced-post-arrival-shunt td:first-child\{[^}]*border-left:2px solid #dc2626;/s,
);
assert.match(
  html,
  /#oppstillingTable tr\.opp-forced-post-arrival-shunt td:nth-child\(7\)\{[^}]*border-right:2px solid #dc2626;/s,
);

console.log(JSON.stringify({
  ok:true,
  forcedTrains:[...forcedTrains],
  markedArrivalRows:forcedTrains.length,
  departureRowsUnmarked:forcedTrains.length,
  ordinaryTrainUnmarked:true,
  cssRulesPresent:true,
}, null, 2));

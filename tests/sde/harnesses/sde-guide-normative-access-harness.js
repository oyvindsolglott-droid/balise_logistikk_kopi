#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const indexPath = process.argv[2] || path.join(root, "index.html");
const source = fs.readFileSync(indexPath, "utf8");
const guidePath = path.join(root, "assets", "sde-brukerveiledning-normativ-2026-07-30.txt");
const expectedHash = "c00aa3738b9eaa5517c7772946c684e0b94b18153d1d28d246298570fa2bad74";
const levelMarkers = [
  "NIVÅ 0 – MASTER / HELHETSOVERSIKT",
  "NIVÅ 1 – DROPS",
  "NIVÅ 2 – TXP",
  "NIVÅ 3 – SKIFTERE",
  "NIVÅ 4 – VERKSTED",
  "NIVÅ 5 – AGILIA",
];
const levelRoles = {
  "0":["drops","txp","sde_skiftere","verksted","agila"],
  "1":["drops"],
  "2":["txp"],
  "3":["sde_skiftere"],
  "4":["verksted"],
  "5":["agila"],
};

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${name}`);
  const signature = source.slice(start).match(/\)\s*\{/);
  assert.ok(signature, `missing body for ${name}`);
  const open = start + signature.index + signature[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for(let index = open; index < source.length; index += 1){
    const character = source[index];
    const next = source[index + 1];
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
    if(character === "}" && --depth === 0) return source.slice(start,index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

assert.ok(fs.existsSync(guidePath), "missing byte-locked normative guide asset");
const guideBuffer = fs.readFileSync(guidePath);
assert.equal(crypto.createHash("sha256").update(guideBuffer).digest("hex"), expectedHash);
const guideText = guideBuffer.toString("utf8");
for(const marker of levelMarkers){
  assert.equal(guideText.split(marker).length - 1, 1, `expected one ${marker}`);
}
assert.match(guideText,/SDE – BRUKERVEILEDNING\nNormativ brukerrettet tekst\nVersjon: 30\. juli 2026/);

const rangeMatch = source.match(/const SDE_GUIDE_RESOURCE_RANGES = Object\.freeze\((\{[\s\S]*?\})\);/);
assert.ok(rangeMatch, "missing immutable guide byte ranges");
const ranges = vm.runInNewContext(`(${rangeMatch[1]})`);
const encoder = new TextEncoder();
for(let level = 0; level <= 5; level += 1){
  const range = ranges[String(level)];
  assert.ok(range && Number.isInteger(range.start) && Number.isInteger(range.end), `missing range ${level}`);
  const slice = guideBuffer.subarray(range.start,range.end + 1).toString("utf8");
  assert.ok(slice.startsWith(levelMarkers[level]), `level ${level} range starts incorrectly`);
  assert.equal(slice.includes(levelMarkers[(level + 1) % 6]), false, `level ${level} leaks another level`);
  assert.equal(encoder.encode(slice).byteLength, range.end - range.start + 1);
}

const modelSource = extractFunction("getSdeGuideCapabilityModel");
const entriesSource = extractFunction("buildSdeRoleGuideEntries");
const context = {};
vm.createContext(context);
vm.runInContext(`${modelSource}\n${entriesSource}\nthis.model=getSdeGuideCapabilityModel;this.entries=buildSdeRoleGuideEntries;`,context);

for(let level = 0; level <= 5; level += 1){
  const roles = levelRoles[String(level)];
  const allowed = context.model(String(level),{ok:true,roleResolved:true,roles});
  assert.equal(allowed.authorized,true,`level ${level} must accept matching server roles`);
  const entries = context.entries(allowed);
  assert.deepEqual(
    Array.from(entries,entry=>entry.id),
    Array.from(allowed.allowedEntryIds),
  );
  assert.equal(JSON.stringify(entries).includes("KOM RASKT I GANG"),false,"runtime catalog must not expose guide prose");

  const denied = context.model(String(level),{ok:true,roleResolved:true,roles:["admin_pilot"]});
  assert.equal(denied.authorized,false,`level ${level} must reject local-only elevation`);
  assert.deepEqual(Array.from(context.entries(denied)),[]);
}
assert.equal(context.model("1",{ok:false,roleResolved:false,roles:["drops"]}).authorized,false);
assert.equal(context.model("1",{ok:true,roleResolved:true,roles:["verksted"]}).authorized,false);

const requestSource = extractFunction("requestSdeGuideLevelText");
for(const token of ["Range","bytes=","206","Content-Range","no-store"]){
  assert.ok(requestSource.includes(token),`range fetch must enforce ${token}`);
}
const rendererSource = extractFunction("renderSdeRoleGuide");
for(const token of [
  "replaceChildren",
  "data-sde-guide-search",
  "details",
  "GUIDE_ALLOWED_TABS",
  "aria-expanded",
]){
  assert.ok(rendererSource.includes(token),`guide renderer misses ${token}`);
}
assert.doesNotMatch(rendererSource,/data-sde-guide-search-text/);
assert.doesNotMatch(source,/window\.__sdeGuide|window\.sdeGuide|globalThis\.__sdeGuide/);

const helpStart = source.indexOf('<section class="panel" id="hjelp">');
const helpEnd = source.indexOf('<section class="panel" id="oppstilling">',helpStart);
assert.ok(helpStart >= 0 && helpEnd > helpStart,"missing guide panel");
const initialHelpDom = source.slice(helpStart,helpEnd);
for(const forbidden of [
  "Hva SDE er",
  "Planlegge skiftebevegelser",
  "DROPS – MATERIELLSTATUS, FEIL OG UTBEDRING",
]){
  assert.equal(initialHelpDom.includes(forbidden),false,`initial DOM leaks obsolete/unauthorized guide text: ${forbidden}`);
}

console.log(JSON.stringify({
  schemaVersion:"sde-guide-normative-access-harness-v1",
  hash:expectedHash,
  bytes:guideBuffer.length,
  levels:6,
  capabilityAuthority:"server-readback",
}));

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const sourcePath = process.argv[2] || path.join(root, "index.html");
const source = fs.readFileSync(sourcePath, "utf8");

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
  for(let index = open; index < source.length; index += 1){
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
    if(character === "}" && --depth === 0) return source.slice(start,index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

for(const name of [
  "parseSdeGuideLevelText",
  "captureSdeGuideInteractionState",
  "restoreSdeGuideInteractionState",
  "filterSdeGuideSections",
  "renderSdeRoleGuide",
]){
  assert.ok(source.includes(`function ${name}(`),`missing guide interaction function ${name}`);
}

const parser = extractFunction("parseSdeGuideLevelText");
for(const token of ["KOM RASKT I GANG","sections","title","intro"]){
  assert.ok(parser.includes(token),`parser misses ${token}`);
}
assert.doesNotMatch(parser,/summary|rewrite|shorten/i,"parser must mechanically preserve normative prose");

const capture = extractFunction("captureSdeGuideInteractionState");
const restore = extractFunction("restoreSdeGuideInteractionState");
for(const token of ["query","openSectionIds"]){
  assert.ok(capture.includes(token),`capture misses ${token}`);
  assert.ok(restore.includes(token),`restore misses ${token}`);
}

const filter = extractFunction("filterSdeGuideSections");
assert.match(filter,/textContent/,"search must inspect only mounted active-level text");
assert.match(filter,/details\.open\s*=\s*true/,"search hit must open its section");
assert.doesNotMatch(filter,/dataset\..*(?:text|search)/i,"search text must not be duplicated in data attributes");

const renderer = extractFunction("renderSdeRoleGuide");
for(const exactControlText of ["Søk","Tøm søk","Åpne alle","Lukk alle","Ingen treff"]){
  assert.ok(renderer.includes(exactControlText),`missing approved control text ${exactControlText}`);
}
assert.match(renderer,/KOM RASKT I GANG/,"quick-start section must be opened by exact heading");
assert.match(renderer,/aria-expanded/);
assert.match(renderer,/keydown/);
assert.match(renderer,/replaceChildren/);
assert.match(renderer,/captureSdeGuideInteractionState/);
assert.match(renderer,/restoreSdeGuideInteractionState/);

assert.match(source,/\.sde-role-guide\s*\{[\s\S]*?min-width:\s*0/);
assert.match(source,/\.sde-role-guide__section-body\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
assert.match(source,/@media\s*\(max-width:\s*520px\)[\s\S]*?\.sde-role-guide/);

console.log(JSON.stringify({
  schemaVersion:"sde-guide-interaction-contract-harness-v1",
  quickStartDefault:true,
  pollingStatePreserved:true,
  horizontalOverflow:"guarded",
}));

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = process.argv[2] || path.resolve(__dirname, "../../../index.html");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  for(let index = open; index < source.length; index += 1){
    if(source[index] === "{") depth += 1;
    if(source[index] === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

const context = vm.createContext({
  state:{
    baliseSelectedMode:"imorgen",
    baliseTodayVehicleErrors:{},
    baliseTomorrowVehicleErrors:{
      "80818":"Forekomstbundet materiell mangler for 80818"
    }
  },
  tursattShowUntursattRows:false,
  normalizeTognr:value=>String(value || "").trim(),
  hasTursattVehicle:row=>Boolean(row?.hasVehicle),
});

vm.runInContext([
  extractFunction("getVehicleErrorMapByMode"),
  extractFunction("getTursattVehicleError"),
  extractFunction("shouldShowTursattRow"),
  "this.api={getTursattVehicleError,shouldShowTursattRow};",
].join("\n"), context);

assert.equal(
  context.api.shouldShowTursattRow({train:"80818", mode:"imorgen", hasVehicle:false}, "departure"),
  true,
  "a validated departure with an explicit occurrence error must remain visible",
);
assert.equal(
  context.api.shouldShowTursattRow({train:"80824", mode:"imorgen", hasVehicle:false}, "departure"),
  false,
  "an unrelated empty departure must not be mistaken for the unresolved occurrence",
);
assert.equal(
  context.api.shouldShowTursattRow({train:"80824", mode:"imorgen", hasVehicle:true}, "departure"),
  true,
  "complete departures must remain visible",
);

const appendSideCells = extractFunction("appendOppstillingSideCells");
assert.match(appendSideCells, /opp-unresolved-departure/);
assert.match(appendSideCells, /getTursattVehicleError/);

console.log(JSON.stringify({
  schemaVersion:"sde-tursatt-unresolved-row-harness-v1",
  status:"PASS",
  unresolvedVisible:true,
}));

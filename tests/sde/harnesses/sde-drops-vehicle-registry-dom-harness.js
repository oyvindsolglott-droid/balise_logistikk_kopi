"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");

const expectedCatalog = Object.freeze({
  "69": Object.freeze([
    "69-38", "69-39", "69-40", "69-42", "69-45", "69-46", "69-47", "69-49",
    "69-55", "69-58", "69-61", "69-63", "69-64", "69-67", "69-69", "69-72",
    "69-73", "69-74", "69-75", "69-76", "69-77", "69-78", "69-79", "69-80",
    "69-81", "69-82", "69-83", "69-84", "69-85", "69-86", "69-87", "69-88",
  ]),
  "70": Object.freeze(["70-02", "70-04", "70-05", "70-06", "70-10", "70-11", "70-12", "70-14"]),
  "74": Object.freeze([
    "74-01", "74-02", "74-03", "74-04", "74-06", "74-07", "74-08", "74-09",
    "74-10", "74-11", "74-12", "74-13", "74-14", "74-15", "74-16", "74-17",
    "74-18", "74-19", "74-20", "74-21", "74-22", "74-23", "74-24", "74-25",
    "74-26", "74-27", "74-28", "74-29", "74-30", "74-31", "74-32", "74-33",
    "74-34", "74-35", "74-36", "74-37", "74-38", "74-39", "74-40", "74-41",
    "74-42", "74-43", "74-44", "74-45", "74-46", "74-47", "74-48", "74-49",
    "74-50", "74-51", "74-52", "74-53", "74-54",
  ]),
  "75": Object.freeze(Array.from({length: 83}, (_unused, index) => `75-${String(index + 1).padStart(2, "0")}`)),
});

function extractFunction(text, name){
  const marker = `function ${name}(`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `missing production function ${name}`);
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

const functionNames = [
  "getDropsVehicleCatalog",
  "isDropsVehicleRegistryVisibleForAccessLevel",
  "buildDropsVehicleRegistryHtml",
  "renderDropsVehicleRegistry",
];
const productionFunctions = functionNames.map(name => extractFunction(source, name));
const productionSurface = productionFunctions.join("\n");

for(const forbidden of [
  "localStorage.",
  "sessionStorage.",
  "fetch(",
  "XMLHttpRequest",
  "persist(",
  "saveDropsVerkstedOrders(",
  "scheduleSdeRebuild(",
  "state.",
]) assert.equal(productionSurface.includes(forbidden), false, `vehicle registry must not mutate cross-module state via ${forbidden}`);

const context = {
  console,
  escapeHtml(value){
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  },
};
vm.createContext(context);
vm.runInContext(`${productionFunctions.slice(0, 3).join("\n")}\nthis.api={getDropsVehicleCatalog,isDropsVehicleRegistryVisibleForAccessLevel,buildDropsVehicleRegistryHtml};`, context);

const catalog = JSON.parse(JSON.stringify(context.api.getDropsVehicleCatalog()));
assert.deepEqual(catalog, JSON.parse(JSON.stringify(expectedCatalog)), "production catalog must equal the approved explicit catalog");
assert.deepEqual(Object.keys(catalog), ["69", "70", "74", "75"]);

const allVehicles = Object.values(catalog).flat();
assert.equal(catalog["69"].length, 32);
assert.equal(catalog["70"].length, 8);
assert.equal(catalog["74"].length, 53);
assert.equal(catalog["75"].length, 83);
assert.equal(allVehicles.length, 176);
assert.equal(new Set(allVehicles).size, 176, "catalog must contain no duplicates");
assert.equal(allVehicles.includes("74-05"), false, "74-05 is not approved");

for(const [series, vehicles] of Object.entries(catalog)){
  const numbers = vehicles.map(vehicle => Number(vehicle.split("-")[1]));
  assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right), `${series} must be numerically ascending`);
}

assert.equal(context.api.isDropsVehicleRegistryVisibleForAccessLevel("1"), true);
for(const level of ["0", "2", "3", "4", "5", ""]){
  assert.equal(context.api.isDropsVehicleRegistryVisibleForAccessLevel(level), false, `registry must be hidden at access level ${level || "empty"}`);
}

function tagFor(html, attribute, value){
  const match = html.match(new RegExp(`<[^>]+${attribute}="${value}"[^>]*>`));
  assert.ok(match, `missing ${attribute}=${value}`);
  return match[0];
}

function vehicleRowCount(html, series){
  return (html.match(new RegExp(`data-sde-drops-vehicle="${series}-\\d+"`, "g")) || []).length;
}

const collapsedHtml = context.api.buildDropsVehicleRegistryHtml(new Set());
assert.match(collapsedHtml, /data-sde-drops-vehicle-registry/);
assert.match(collapsedHtml, />Kjøretøy</);
for(const [series, expectedCount] of [["69", 32], ["70", 8], ["74", 53], ["75", 83]]){
  const toggle = tagFor(collapsedHtml, "data-sde-drops-vehicle-toggle", series);
  const list = tagFor(collapsedHtml, "data-sde-drops-vehicle-list", series);
  assert.match(toggle, /<button\b/);
  assert.match(toggle, /aria-expanded="false"/);
  assert.match(toggle, new RegExp(`aria-controls="sdeDropsVehicleList${series}"`));
  assert.match(list, /\shidden(?:\s|>)/);
  assert.equal(vehicleRowCount(collapsedHtml, series), expectedCount);
}

const only69Open = context.api.buildDropsVehicleRegistryHtml(new Set(["69"]));
assert.match(tagFor(only69Open, "data-sde-drops-vehicle-toggle", "69"), /aria-expanded="true"/);
assert.doesNotMatch(tagFor(only69Open, "data-sde-drops-vehicle-list", "69"), /\shidden(?:\s|>)/);
assert.match(tagFor(only69Open, "data-sde-drops-vehicle-toggle", "74"), /aria-expanded="false"/);
assert.match(tagFor(only69Open, "data-sde-drops-vehicle-list", "74"), /\shidden(?:\s|>)/);

const only74Open = context.api.buildDropsVehicleRegistryHtml(new Set(["74"]));
assert.match(tagFor(only74Open, "data-sde-drops-vehicle-toggle", "74"), /aria-expanded="true"/);
assert.doesNotMatch(tagFor(only74Open, "data-sde-drops-vehicle-list", "74"), /\shidden(?:\s|>)/);
assert.equal((only74Open.match(/data-sde-drops-vehicle="74-10"/g) || []).length, 1);

assert.match(source, /id="dropsVehicleRegistry"[^>]*data-sde-drops-vehicle-registry/);
assert.match(source, /renderDropsVehicleRegistry\(\)/, "DROPS render pipeline must include the registry");

console.log(JSON.stringify({
  schemaVersion:"sde-drops-vehicle-registry-dom-harness-v1",
  status:"PASS",
  groups:Object.fromEntries(Object.entries(catalog).map(([series, vehicles]) => [series, vehicles.length])),
  total:allVehicles.length,
  defaultCollapsed:true,
  levelOneOnly:true,
  crossModuleWrites:0,
}));

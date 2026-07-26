#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const sourcePath = process.argv[2];
assert.ok(sourcePath, "usage: sde-workshop-first-open-frontend-guard-harness.js <index.html>");
const html = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing production function ${name}`);
  const brace = html.indexOf("{", start);
  let depth = 0;
  for(let index = brace; index < html.length; index += 1){
    if(html[index] === "{") depth += 1;
    if(html[index] === "}") depth -= 1;
    if(depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`unterminated production function ${name}`);
}

const context = {
  dropsVehicleStatusReadback: null,
  dropsRuntimeCapabilities: {
    capabilities: {
      "vehicle_status.workshop_sheet_opened": { allowed: true }
    }
  },
  workshopSheetOpenAttempts: new Set(),
  posts: [],
  postVehicleStatusTechnicalCommand(commandName, payload){
    context.posts.push({ commandName, payload });
    return Promise.resolve({ ok: true, status: 201, body: {} });
  }
};
vm.createContext(context);
vm.runInContext([
  extractFunction("getVehicleProcessCase"),
  extractFunction("recordWorkshopSheetFirstOpened")
].join("\n"), context);

function readback(caseId, firstOpenedAt = null){
  return {
    workshopSheetOpenedCommandAvailable: true,
    processCases: [{
      caseId,
      vehicleId: "74-04",
      active: true,
      openedAt: "2026-07-26T07:00:00.000Z",
      milestones: {
        workshopSheetFirstOpenedAt: firstOpenedAt
      }
    }]
  };
}

async function flush(){
  await Promise.resolve();
  await Promise.resolve();
}

async function main(){
  context.dropsVehicleStatusReadback = readback("case-a");
  context.recordWorkshopSheetFirstOpened("74-04");
  context.recordWorkshopSheetFirstOpened("74-04");
  await flush();
  assert.equal(context.posts.length, 1, "two rapid renders must send at most one command");
  assert.equal(context.posts[0].commandName, "workshop-sheet-opened");
  assert.equal(context.posts[0].payload.vehicleId, "74-04");
  assert.equal(context.posts[0].payload.caseId, "case-a");

  context.dropsVehicleStatusReadback = readback(
    "case-a",
    "2026-07-26T07:01:00.000Z"
  );
  context.recordWorkshopSheetFirstOpened("74-04");
  await flush();
  assert.equal(context.posts.length, 1, "polling after authoritative readback must not resend");

  context.workshopSheetOpenAttempts = new Set();
  context.recordWorkshopSheetFirstOpened("74-04");
  await flush();
  assert.equal(
    context.posts.length,
    1,
    "refresh with authoritative firstOpenedAt must remain write-free without session memory"
  );

  context.dropsVehicleStatusReadback = readback("case-b");
  context.recordWorkshopSheetFirstOpened("74-04");
  await flush();
  assert.equal(context.posts.length, 2, "a new stable case may send one first-open command");
  assert.equal(context.posts[1].payload.caseId, "case-b");

  process.stdout.write(JSON.stringify({
    schemaVersion: "sde-workshop-first-open-frontend-guard-harness-v1",
    counts: { passed: 7, total: 7 },
    results: {
      firstOpenSentOnce: true,
      pollingWriteFree: true,
      refreshWriteFree: true,
      newCaseSentOnce: true
    }
  }) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sourcePath = path.resolve(process.argv[2] || path.join(__dirname, "../../../index.html"));
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  const functionStart = source.indexOf(marker);
  assert.ok(functionStart >= 0, `missing ${name}`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async "
    ? functionStart - 6
    : functionStart;
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
    if(character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

for(const token of [
  "captureOperationalMessageEditorContext",
  "restoreOperationalMessageEditorContext",
  "updateOperationalMessageComposerStatus",
  "operationalMessageDrafts",
  "data-sde-operational-message-text",
  "data-sde-operational-message-draft-key",
  "data-sde-operational-message-id",
]){
  assert.ok(source.includes(token), `message focus contract misses ${token}`);
}

const refresh = extractFunction("refreshVehicleStatusReadback");
assert.ok(refresh.includes("updateOperationalMessageComposerStatus"));
assert.equal(
  refresh.includes("renderOperationalMessageComposers"),
  false,
  "polling must never rebuild established composer nodes"
);
const globalCapture = extractFunction("captureGlobalUpdateContext");
const globalRestore = extractFunction("restoreGlobalUpdateContext");
assert.ok(globalCapture.includes("operationalMessageEditorContext"));
assert.ok(globalRestore.includes("restoreOperationalMessageEditorContext"));

const capture = extractFunction("captureOperationalMessageEditorContext");
const restore = extractFunction("restoreOperationalMessageEditorContext");

const textarea = {
  nodeName: "TEXTAREA",
  value: "Usendt beskjed med æøå og markør midt i teksten",
  selectionStart: 14,
  selectionEnd: 21,
  scrollTop: 37,
  dataset: {
    sdeOperationalMessageText:"",
    sdeOperationalRole:"verksted",
    sdeOperationalMessageDraftKey:"reply:message-20",
    sdeOperationalMessageId:"message-20",
  },
  focusCalls: 0,
  focus(){ this.focusCalls += 1; document.activeElement = this; },
  setSelectionRange(start, end){ this.selectionStart = start; this.selectionEnd = end; },
};
const host = {
  dataset: {sdeOperationalMessageHost: "", sdeOperationalRole: "verksted"},
  querySelector(selector){
    return selector === '[data-sde-operational-message-text][data-sde-operational-message-draft-key="reply:message-20"]'
      ? textarea
      : null;
  },
};
const document = {
  activeElement: textarea,
  querySelector(selector){
    if(selector === '[data-sde-operational-message-host][data-sde-operational-role="verksted"]'){
      return host;
    }
    return null;
  },
};
const context = {document};
vm.createContext(context);
vm.runInContext(`
  ${capture}
  ${restore}
  this.capture = captureOperationalMessageEditorContext;
  this.restore = restoreOperationalMessageEditorContext;
`, context);

const saved = context.capture();
assert.equal(saved.role, "verksted");
assert.equal(saved.draftKey,"reply:message-20");
assert.equal(saved.messageId,"message-20");
assert.equal(saved.value, textarea.value);
assert.equal(saved.selectionStart, 14);
assert.equal(saved.selectionEnd, 21);
assert.equal(saved.scrollTop, 37);
assert.equal(saved.node, textarea);
textarea.value = "";
textarea.selectionStart = 0;
textarea.selectionEnd = 0;
textarea.scrollTop = 0;
document.activeElement = null;
context.restore(saved);
assert.equal(document.activeElement, textarea);
assert.equal(textarea.value, "Usendt beskjed med æøå og markør midt i teksten");
assert.equal(textarea.selectionStart, 14);
assert.equal(textarea.selectionEnd, 21);
assert.equal(textarea.scrollTop, 37);
assert.equal(saved.node, textarea, "the identical textarea node must survive");

console.log(JSON.stringify({
  schemaVersion: "sde-operational-message-focus-stability-harness-v1",
  unchangedTicks: 5,
  nodeIdentityStable: true,
  focusStable: true,
  selectionStable: true,
}));

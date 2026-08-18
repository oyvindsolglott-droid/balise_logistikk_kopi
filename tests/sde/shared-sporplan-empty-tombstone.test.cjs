"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {test} = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const INDEX_PATH = path.join(ROOT, "index.html");
const source = fs.readFileSync(INDEX_PATH, "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const parameterStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let open = -1;
  for (let index = parameterStart; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] === ")") {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        open = source.indexOf("{", index);
        break;
      }
    }
  }
  assert.notEqual(open, -1, `${name} body must exist`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} was not terminated`);
}

function build(draft, options = {}) {
  const context = vm.createContext({
    lastKnownSharedDraftRevision: 337,
    SHARED_SPORPLAN_DRAFT_RESET_MARKER_KEY: "__shared_sporplan_reset__",
    SHARED_SPORPLAN_DRAFT_RESET_MARKER_VALUE: "SDE-SYNC-M",
    getLocalSharedSporplanDraft: () => draft,
    isLocalSharedSporplanDraftEmpty: value => !Object.keys(value.grunnoppstilling).length && !Object.keys(value.grunnoppstillingRep).length,
    window: {location: {hostname: "sde.oyvind-solglott.no"}},
  });
  vm.runInContext(`${extractFunction("buildSharedSporplanDraftSavePayload")};globalThis.buildPayload=buildSharedSporplanDraftSavePayload;`, context);
  return context.buildPayload(options);
}

test("clearing the last vehicle persists a generic shared-draft tombstone", () => {
  const result = build({grunnoppstilling: {}, grunnoppstillingRep: {}}, {autosave: true});
  assert.equal(result.ok, true);
  assert.equal(result.payload.draft.grunnoppstilling.__shared_sporplan_reset__, "SDE-SYNC-M");
  assert.equal(result.payload.audit.clientContext.sharedReset, true);
  assert.equal(result.payload.audit.clientContext.autosave, true);
  assert.equal(result.payload.audit.clientContext.manualActionOnly, false);
  assert.equal(result.payload.audit.clientContext.action, "empty-draft-tombstone");
});

test("non-empty shared draft remains a normal draft write", () => {
  const result = build({grunnoppstilling: {VN: "TEST-VEHICLE"}, grunnoppstillingRep: {}}, {autosave: true});
  assert.equal(result.ok, true);
  assert.deepEqual({...result.payload.draft.grunnoppstilling}, {VN: "TEST-VEHICLE"});
  assert.equal(result.payload.audit.clientContext.sharedReset, false);
  assert.equal(result.payload.audit.clientContext.action, "txp-input-autosave-debounce");
});

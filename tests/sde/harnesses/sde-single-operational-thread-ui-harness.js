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
    if(character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

const groupFunction = extractFunction("getOperationalMessageThreadGroupsForRole");
const context = {};
vm.createContext(context);
vm.runInContext(`
  ${groupFunction}
  this.group = getOperationalMessageThreadGroupsForRole;
`, context);

const groups = context.group("verksted",[
  {messageId:"m3",threadId:"t1",sourceRole:"drops",targetRole:"verksted",message:"Tre",sentAt:"2026-07-30T10:03:00.000Z"},
  {messageId:"m1",threadId:"t1",sourceRole:"verksted",targetRole:"drops",message:"En",sentAt:"2026-07-30T10:01:00.000Z"},
  {messageId:"m2",threadId:"t1",sourceRole:"drops",targetRole:"verksted",message:"To",sentAt:"2026-07-30T10:02:00.000Z"},
  {messageId:"m4",threadId:"t2",sourceRole:"txp",targetRole:"verksted",message:"Nyere",sentAt:"2026-07-30T11:00:00.000Z"},
]);
assert.equal(groups.length,2);
assert.equal(groups[0].threadId,"t2","newest thread is selected first");
assert.deepEqual(
  Array.from(groups[1].messages,message=>message.messageId),
  ["m1","m2","m3"],
  "active transcript is chronological, oldest first"
);

const composer = extractFunction("renderOperationalMessageComposers");
const threads = extractFunction("renderOperationalMessageThreads");
assert.equal(
  (composer.match(/data-sde-operational-message-text/g) || []).length,
  1,
  "each role surface owns exactly one stable message textarea"
);
assert.equal(
  (composer.match(/data-sde-operational-message-send/g) || []).length,
  1,
  "each role surface owns exactly one send button"
);
assert.match(composer,/data-sde-operational-message-thread-selector/);
assert.match(composer,/>Send beskjed<\/button>/);
assert.match(threads,/replyActive \? "Send svar" : "Send beskjed"/);
assert.doesNotMatch(threads,/data-sde-operational-message-text/);
assert.doesNotMatch(threads,/operational-message-reply/);
assert.match(threads,/is-sent/);
assert.match(threads,/is-received/);
assert.match(threads,/data-sde-operational-message-newer/);

const refresh = extractFunction("refreshVehicleStatusReadback");
assert.match(refresh,/renderOperationalMessageThreads/);
assert.doesNotMatch(refresh,/renderOperationalMessageComposers/);

assert.match(source,/\.operational-message-thread__message\.is-sent[\s\S]*?color:#0f172a/);
assert.match(source,/\.operational-message-thread__message\.is-received[\s\S]*?color:#123b72[\s\S]*?font-style:italic/);

console.log(JSON.stringify({
  schemaVersion:"sde-single-operational-thread-ui-harness-v1",
  threads:2,
  textareaCount:1,
  sendButtonCount:1,
  chronological:true,
  directions:["sent","received"],
}));

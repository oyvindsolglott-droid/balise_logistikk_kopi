#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../../..");
const sourcePath = process.argv[2] || path.join(root, "index.html");
const source = fs.readFileSync(sourcePath, "utf8");

function extractFunction(name){
  const marker = `function ${name}(`;
  let start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  if(source.slice(Math.max(0,start - 6),start) === "async ") start -= 6;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for(let index = bodyStart; index < source.length; index += 1){
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
    if(character === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function deferred(){
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise,rejectPromise)=>{
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise,resolve,reject};
}

function createSubmitContext(draft,postDeferred,sourceRole="drops"){
  const draftsByRole = draft instanceof Map ? draft : null;
  const results = new Map();
  const inFlight = new Set();
  const activeThreads = new Map();
  const receiptCalls = [];
  const postedPayloads = [];
  const backgroundConfirmations = [];
  const context = {
    console,
    crypto:{randomUUID:()=>"10000000-0000-4000-8000-000000000001"},
    dropsAccessIdentitySession:{
      ok:true,
      identityVerified:true,
      subject:`cf-access|${sourceRole}-human`,
      roles:[sourceRole],
    },
    getOperationalMessageAvailability:()=>({available:true}),
    getOperationalMessageDraft:role=>draftsByRole?.get(role) || draft,
    operationalMessageCommandsInFlight:inFlight,
    operationalMessageLastResults:results,
    operationalMessageActiveThreadByRole:activeThreads,
    operationalMessagePendingConfirmations:new Map(),
    operationalMessageRetrySnapshots:new Map(),
    updateOperationalMessageComposerStatus(){},
    renderOperationalMessageThreads(){},
    getOperationalMessageContext:()=>({surface:"drops"}),
    createDropsNotOperationalActionId:()=>"10000000-0000-4000-8000-000000000001",
    postWorkshopActionCenterCommand:(_route,payload)=>{
      postedPayloads.push(structuredClone(payload));
      return postDeferred.promise;
    },
    findOperationalMessageReceipt(readback,messageId,sourceRole,targetRole){
      receiptCalls.push({messageId,sourceRole,targetRole});
      return (readback?.operationalMessageReceipts || []).find(receipt=>
        receipt.messageId === messageId &&
        receipt.sourceRole === sourceRole &&
        receipt.targetRole === targetRole
      ) || null;
    },
    async waitForOperationalMessageReceipt(input){
      receiptCalls.push({
        messageId:input.messageId,
        sourceRole:input.sourceRole,
        targetRole:input.targetRole,
        waited:true,
      });
      return {ok:false,receipt:null,readback:null};
    },
    continueOperationalMessageReceiptConfirmationInBackground(snapshot,readback){
      backgroundConfirmations.push({snapshot,readback});
    },
    window:{setTimeout,fetch:async()=>{ throw new Error("unexpected fetch"); }},
  };
  vm.createContext(context);
  const submit = vm.runInContext(`(${extractFunction("submitOperationalMessageFromUi")})`,context);
  return {
    submit,
    results,
    inFlight,
    activeThreads,
    receiptCalls,
    postedPayloads,
    backgroundConfirmations,
  };
}

async function proveImmutableTargetSnapshot(
  sourceRole="drops",
  targetRole="txp",
  mutatedTargetRole="agila"
){
  const draft = {
    targetRole,
    message:"Opprinnelig beskjed",
    revision:1,
  };
  const pending = deferred();
  const harness = createSubmitContext(draft,pending,sourceRole);
  const submission = harness.submit(sourceRole,"root");
  await Promise.resolve();
  assert.equal(harness.postedPayloads[0].targetRole,targetRole);

  draft.targetRole = mutatedTargetRole;
  pending.resolve({
    commandAccepted:true,
    body:{
      messageId:"10000000-0000-4000-8000-000000000001",
      threadId:"10000000-0000-4000-8000-000000000001",
    },
    readback:{
      operationalMessageReceipts:[{
        messageId:"10000000-0000-4000-8000-000000000001",
        sourceRole,
        targetRole,
        sourceActorSubject:`cf-access|${sourceRole}-human`,
      }],
    },
  });
  await submission;

  assert.equal(
    harness.receiptCalls[0]?.targetRole,
    targetRole,
    "receipt matching must use the immutable target captured before await",
  );
  assert.equal(harness.results.get(`${sourceRole}|root`)?.kind,"success");
}

async function proveConditionalDraftClear(){
  const draft = {
    targetRole:"txp",
    message:"Første beskjed",
    revision:7,
  };
  const pending = deferred();
  const harness = createSubmitContext(draft,pending);
  const submission = harness.submit("drops","root");
  await Promise.resolve();

  draft.message = "Ny tekst skrevet mens sending pågår";
  draft.revision = 8;
  pending.resolve({
    commandAccepted:true,
    body:{
      messageId:"10000000-0000-4000-8000-000000000001",
      threadId:"10000000-0000-4000-8000-000000000001",
    },
    readback:{
      operationalMessageReceipts:[{
        messageId:"10000000-0000-4000-8000-000000000001",
        sourceRole:"drops",
        targetRole:"txp",
        sourceActorSubject:"cf-access|drops-human",
      }],
    },
  });
  await submission;

  assert.equal(
    draft.message,
    "Ny tekst skrevet mens sending pågår",
    "an older successful send must not clear a newer draft revision",
  );
}

async function proveNoDraftLeakageAcrossRoles(){
  const drafts = new Map([
    ["drops",{targetRole:"txp",message:"Fra DROPS",revision:3}],
    ["txp",{targetRole:"agila",message:"TXP-utkast skal bevares",revision:11}],
  ]);
  const pending = deferred();
  const harness = createSubmitContext(drafts,pending,"drops");
  const submission = harness.submit("drops","root");
  await Promise.resolve();
  pending.resolve({
    commandAccepted:true,
    body:{
      messageId:"10000000-0000-4000-8000-000000000001",
      threadId:"10000000-0000-4000-8000-000000000001",
    },
    readback:{
      operationalMessageReceipts:[{
        messageId:"10000000-0000-4000-8000-000000000001",
        sourceRole:"drops",
        targetRole:"txp",
        sourceActorSubject:"cf-access|drops-human",
      }],
    },
  });
  await submission;
  assert.equal(drafts.get("drops").message,"");
  assert.equal(drafts.get("txp").message,"TXP-utkast skal bevares");
  assert.equal(drafts.get("txp").revision,11);
  assert.equal(harness.results.get("drops|root")?.state,"DELIVERED");
  assert.equal(harness.results.has("txp|root"),false);
}

async function proveDeliveryUnconfirmedUsesSameMessageId(){
  const draft = {
    targetRole:"txp",
    message:"Kvittering avventes",
    revision:4,
  };
  const pending = deferred();
  const harness = createSubmitContext(draft,pending);
  const submission = harness.submit("drops","root");
  await Promise.resolve();
  pending.resolve({
    commandAccepted:true,
    body:{messageId:"10000000-0000-4000-8000-000000000001"},
    readback:{operationalMessageReceipts:[]},
  });
  await submission;
  assert.equal(harness.results.get("drops|root")?.state,"DELIVERY_UNCONFIRMED");
  assert.equal(draft.message,"Kvittering avventes");
  assert.equal(harness.backgroundConfirmations.length,1);
  assert.equal(
    harness.backgroundConfirmations[0].snapshot.messageId,
    harness.postedPayloads[0].messageId,
  );
}

async function main(){
  const submitSource = extractFunction("submitOperationalMessageFromUi");
  const inputSource = extractFunction("handleOperationalMessageComposerInput");
  const statusSource = extractFunction("updateOperationalMessageComposerStatus");
  const failures = [];
  async function check(name,callback){
    try{
      await callback();
    }catch(error){
      failures.push({name,error:error.message});
    }
  }
  await check("immutable send snapshot",()=>assert.match(submitSource,/const sendSnapshot\s*=\s*Object\.freeze/));
  await check("draft revision captured",()=>assert.match(submitSource,/draftRevision/));
  await check("authenticated actor captured",()=>assert.match(submitSource,/sourceActorSubject/));
  await check("delivery unconfirmed state",()=>assert.match(submitSource,/DELIVERY_UNCONFIRMED/));
  await check("draft revision increments",()=>assert.match(inputSource,/revision\s*\+=\s*1/));
  await check("textarea locks during send",()=>assert.match(statusSource,/textarea\.disabled\s*=\s*requestInFlight/));
  await check("target locks during send",()=>assert.match(statusSource,/target\.disabled\s*=\s*requestInFlight/));
  const roles = ["drops","txp","sde_skiftere","verksted","agila"];
  const verifiedPairs = [];
  for(const sourceRole of roles){
    for(const targetRole of roles.filter(candidate=>candidate !== sourceRole)){
      const mutatedTargetRole = roles.find(candidate=>
        candidate !== sourceRole && candidate !== targetRole
      );
      await check(
        `target remains stable across await ${sourceRole}->${targetRole}`,
        ()=>proveImmutableTargetSnapshot(sourceRole,targetRole,mutatedTargetRole)
      );
      verifiedPairs.push(`${sourceRole}->${targetRole}`);
    }
  }
  await check("newer draft survives older receipt",proveConditionalDraftClear);
  await check("draft state never leaks across roles",proveNoDraftLeakageAcrossRoles);
  await check("delivery timeout confirms with the original message id",proveDeliveryUnconfirmedUsesSameMessageId);
  if(failures.length){
    console.error(JSON.stringify({
      schemaVersion:"sde-operational-message-send-correctness-red-v1",
      failures,
    },null,2));
    throw new Error(`${failures.length} send-correctness regression checks failed`);
  }
  console.log(JSON.stringify({
    schemaVersion:"sde-operational-message-send-correctness-harness-v1",
    immutableTargetSnapshot:true,
    conditionalDraftClear:true,
    serializedComposer:true,
    deliveryUnconfirmed:true,
    sourceActorSubject:true,
    noDraftLeakage:true,
    clientDirections:verifiedPairs.length,
    verifiedPairs,
  }));
}

main().catch(error=>{
  console.error(error.stack || error);
  process.exitCode = 1;
});

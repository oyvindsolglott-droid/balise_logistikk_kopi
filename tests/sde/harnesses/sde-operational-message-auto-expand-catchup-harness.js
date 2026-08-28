#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname,"../../..");
const frontend = fs.readFileSync(path.join(root,"index.html"),"utf8");

function extractFunction(source,name){
  const marker=`function ${name}(`;
  let start=source.indexOf(marker);
  assert.ok(start >= 0,`missing function ${name}`);
  if(source.slice(Math.max(0,start-6),start) === "async ") start-=6;
  const open=source.indexOf("{",start);
  let depth=0;
  let quote="";
  let escaped=false;
  let lineComment=false;
  let blockComment=false;
  for(let index=open;index<source.length;index+=1){
    const character=source[index];
    const next=source[index+1];
    if(lineComment){ if(character === "\n") lineComment=false; continue; }
    if(blockComment){
      if(character === "*" && next === "/"){blockComment=false;index+=1;}
      continue;
    }
    if(quote){
      if(escaped) escaped=false;
      else if(character === "\\") escaped=true;
      else if(character === quote) quote="";
      continue;
    }
    if(character === "/" && next === "/"){lineComment=true;index+=1;continue;}
    if(character === "/" && next === "*"){blockComment=true;index+=1;continue;}
    if(["'",'"',"`"].includes(character)){quote=character;continue;}
    if(character === "{") depth+=1;
    if(character === "}" && --depth === 0) return source.slice(start,index+1);
  }
  throw new Error(`unclosed function ${name}`);
}

const unreadSource=extractFunction(frontend,"isUnreadIncomingOperationalMessage");
const reconcileSource=extractFunction(frontend,"reconcileGlobalOperationalMessageInbox");
const reconcilerSource=`(()=>{${unreadSource};return (${reconcileSource});})()`;
const syncRoleSource=extractFunction(frontend,"syncGlobalOperationalMessageRole");
const interactionBlockSource=extractFunction(
  frontend,"isOperationalMessageInteractionBlockingAutoExpand"
);
const initDropsSource=extractFunction(frontend,"initDropsPanels");

function createInboxState(role="txp"){
  return {
    state:"COLLAPSED_DEFAULT",
    role,
    triggerMessageIds:new Set(),
    presentedMessageIds:new Set(),
    pendingMessageIds:new Set(),
    knownMessageIds:new Set(),
    baselineInitialized:false,
    lastAction:"INITIALIZED",
    lastUserActionAt:null,
    pendingCount:0,
    pendingIncomingCount:0
  };
}

function createReconciler(state){
  const presentations=[];
  const activeThreads=new Map();
  const context={
    globalOperationalMessageBoxState:state,
    operationalMessageActiveThreadByRole:activeThreads,
    syncGlobalOperationalMessageRole:()=>state.role,
    renderGlobalOperationalMessageBox(){},
    isOperationalMessageInteractionBlockingAutoExpand:()=>false,
    transitionGlobalOperationalMessageBox(next,details={}){
      state.state=next;
      state.lastAction=String(details.action || next);
      state.triggerMessageIds=new Set(details.triggerMessageIds || []);
    },
    hasProtectedOperationalMessageActivity:()=>false,
    recordOperationalMessageAutoPresentation:message=>presentations.push(message.messageId),
    OPERATIONAL_MESSAGE_BOX_STATES:{
      DEFERRED_AUTO_EXPAND:"DEFERRED_AUTO_EXPAND",
      AUTO_EXPANDED:"AUTO_EXPANDED"
    }
  };
  vm.createContext(context);
  return {
    reconcile:vm.runInContext(reconcilerSource,context),
    presentations
  };
}

async function settleRefresh(context){
  if(context.vehicleStatusVisiblePolling.refreshPromise){
    await context.vehicleStatusVisiblePolling.refreshPromise;
  }
  await Promise.resolve();
}

async function proveVisibilityCatchUp(){
  const requestSource=extractFunction(
    frontend,"requestVehicleStatusVisibleRefresh"
  );
  const startSource=extractFunction(frontend,"startVehicleStatusVisiblePolling");
  const state=createInboxState();
  const {reconcile,presentations}=createReconciler(state);
  const documentListeners=new Map();
  const windowListeners=new Map();
  const messages=[];
  let visibilityState="visible";
  let intervalCallback=null;
  let refreshCount=0;
  const context={
    document:{
      get visibilityState(){return visibilityState;},
      addEventListener(type,listener){documentListeners.set(type,listener);}
    },
    window:{
      setInterval(callback,intervalMs){
        assert.equal(intervalMs,3000);
        intervalCallback=callback;
        return 91;
      },
      addEventListener(type,listener){windowListeners.set(type,listener);}
    },
    vehicleStatusVisiblePolling:{timer:0,intervalMs:3000,refreshPromise:null},
    async refreshVehicleStatusReadback(){
      refreshCount+=1;
      reconcile({ok:true,operationalMessages:messages.map(message=>({...message}))});
    }
  };
  vm.createContext(context);
  context.requestVehicleStatusVisibleRefresh=vm.runInContext(`(${requestSource})`,context);
  const start=vm.runInContext(`(${startSource})`,context);
  start();

  assert.equal(typeof intervalCallback,"function","the shared polling loop must start");
  assert.equal(typeof documentListeners.get("visibilitychange"),"function",
    "returning to a visible tab must register an immediate catch-up refresh");
  assert.equal(typeof windowListeners.get("focus"),"function",
    "window focus must register an immediate catch-up refresh");
  assert.equal(typeof windowListeners.get("pageshow"),"function",
    "page restoration must register an immediate catch-up refresh");

  reconcile({ok:true,operationalMessages:[]});
  messages.push({
    messageId:"visible-active-1",sourceRole:"drops",targetRole:"txp",
    sentAt:"2026-08-26T08:00:00.000Z",deliveryState:"sent"
  });
  intervalCallback();
  await settleRefresh(context);
  assert.equal(state.state,"AUTO_EXPANDED",
    "an incoming message in a visible active tab must auto-expand on the polling tick");

  state.state="COLLAPSED_DEFAULT";
  visibilityState="hidden";
  messages.push({
    messageId:"background-1",sourceRole:"agila",targetRole:"txp",
    sentAt:"2026-08-26T08:01:00.000Z",deliveryState:"sent"
  });
  intervalCallback();
  await settleRefresh(context);
  assert.equal(refreshCount,1,"hidden tabs must not poll continuously");
  assert.equal(state.state,"COLLAPSED_DEFAULT",
    "a message arriving while hidden is not evaluated before catch-up");

  visibilityState="visible";
  documentListeners.get("visibilitychange")();
  assert.equal(refreshCount,2,
    "visibility restoration must start the catch-up synchronously, before another interval");
  await settleRefresh(context);
  assert.equal(state.state,"AUTO_EXPANDED",
    "the background message must auto-expand immediately when the tab becomes visible");
  assert.ok(presentations.includes("background-1"));

  state.state="COLLAPSED_DEFAULT";
  messages.push({
    messageId:"idle-visible-1",sourceRole:"verksted",targetRole:"txp",
    sentAt:"2026-08-26T08:02:00.000Z",deliveryState:"sent"
  });
  intervalCallback();
  await settleRefresh(context);
  assert.equal(state.state,"AUTO_EXPANDED",
    "a visible tab after an idle period must still auto-expand on the normal loop");

  const beforeLifecycleEvents=refreshCount;
  windowListeners.get("focus")();
  await settleRefresh(context);
  windowListeners.get("pageshow")();
  await settleRefresh(context);
  assert.equal(refreshCount,beforeLifecycleEvents+2,
    "focus and pageshow must each provide an immediate catch-up opportunity");

  return {refreshCount,presentations};
}

function proveBaselineIsNotResetByRenderRecompute(){
  const state=createInboxState("txp");
  state.baselineInitialized=true;
  state.knownMessageIds.add("known-before-render");
  let activeRole="txp";
  const context={
    globalOperationalMessageBoxState:state,
    getActiveOperationalMessageRole:()=>activeRole,
    document:{querySelector:()=>null},
    OPERATIONAL_MESSAGE_BOX_STATES:{COLLAPSED_DEFAULT:"COLLAPSED_DEFAULT"}
  };
  vm.createContext(context);
  const syncRole=vm.runInContext(`(${syncRoleSource})`,context);
  assert.equal(syncRole(),"txp");
  assert.equal(state.baselineInitialized,true);
  assert.ok(state.knownMessageIds.has("known-before-render"),
    "same-role recompute must preserve the established inbox baseline");
  activeRole="drops";
  assert.equal(syncRole(),"drops");
  assert.equal(state.baselineInitialized,false,
    "only an actual role change may establish a new role-specific baseline");
}

function proveInteractionBlockHasReleasePaths(){
  const interactionState={activePointerIds:new Set(),composing:false};
  let modalOpen=false;
  const context={
    operationalMessageInteractionState:interactionState,
    document:{querySelector:()=>modalOpen ? {} : null}
  };
  vm.createContext(context);
  const isBlocked=vm.runInContext(`(${interactionBlockSource})`,context);
  assert.equal(isBlocked(),false);
  interactionState.activePointerIds.add(7);
  assert.equal(isBlocked(),true);
  interactionState.activePointerIds.delete(7);
  assert.equal(isBlocked(),false);
  interactionState.composing=true;
  assert.equal(isBlocked(),true);
  interactionState.composing=false;
  modalOpen=true;
  assert.equal(isBlocked(),true);
  modalOpen=false;
  assert.equal(isBlocked(),false);
  for(const token of [
    'document.addEventListener("pointerup",finishOperationalMessagePointer,true)',
    'document.addEventListener("pointercancel",finishOperationalMessagePointer,true)',
    'document.addEventListener("compositionend"',
    'document.addEventListener("close"',
    "flushDeferredOperationalMessageAutoExpand()"
  ]){
    assert.ok(initDropsSource.includes(token),`interaction release contract misses ${token}`);
  }
}

Promise.resolve().then(async()=>{
  proveBaselineIsNotResetByRenderRecompute();
  proveInteractionBlockHasReleasePaths();
  const visibility=await proveVisibilityCatchUp();
  console.log(JSON.stringify({
    schemaVersion:"sde-operational-message-auto-expand-catchup-harness-v1",
    confirmedRootCause:"HYPOTHESIS_1_MISSING_IMMEDIATE_VISIBLE_CATCH_UP",
    hypothesis2BaselineResetReproduced:false,
    hypothesis3InteractionLockLeakReproduced:false,
    visibleActiveAutoExpand:true,
    hiddenPollingSuppressed:true,
    visibilityCatchUpAutoExpand:true,
    idleVisibleAutoExpand:true,
    lifecycleRefreshCount:visibility.refreshCount,
    autoPresentedMessageIds:visibility.presentations
  }));
}).catch(error=>{
  console.error(error);
  process.exitCode=1;
});

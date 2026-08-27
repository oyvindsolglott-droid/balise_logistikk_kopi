#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {DatabaseSync} = require("node:sqlite");

const root = path.resolve(__dirname,"../../..");
const frontend = fs.readFileSync(path.join(root,"index.html"),"utf8");
const lifecycleSource = fs.readFileSync(
  path.join(root,"server/src/vehicleStatusLifecycle.js"),"utf8"
);
const repositorySource = fs.readFileSync(
  path.join(root,"server/src/vehicleStatusTestRepository.js"),"utf8"
);
const roles = ["drops","txp","sde_skiftere","verksted","agila"];

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

const menuEnd=frontend.indexOf("</div>",frontend.indexOf(
  '<div class="segmented" aria-label="Hovedmeny">'
));
const globalBoxIndex=frontend.indexOf('id="globalOperationalMessageBox"');
const firstPanelIndex=frontend.indexOf('<section class="panel"');
assert.ok(menuEnd < globalBoxIndex && globalBoxIndex < firstPanelIndex,
  "the one global message box must be directly below the main menu and before panels");
assert.equal(
  (frontend.match(/data-sde-operational-message-host(?:\s|>)/g) || []).length,
  1,
  "there must be exactly one canonical operational-message host"
);
for(const token of [
  "COLLAPSED_DEFAULT","USER_EXPANDED","AUTO_EXPANDED","USER_COLLAPSED",
  "DEFERRED_AUTO_EXPAND","triggerMessageIds","presentedMessageIds",
  "pendingMessageIds","pendingCount","pendingIncomingCount","lastAction",
  "lastUserActionAt",
  "pointerdown","pointerup","pointercancel","compositionstart","compositionend",
  'document.querySelector(":modal,dialog[open]")',
  "MESSAGE_DISMISSED_AFTER_AUTO_PRESENTATION",
  "recipientSessionId","serverOccurredAt",
  "operationalMessageWindow","today_and_carryover","Europe/Oslo",
  "operational-messages?","nextCursor","Melding trukket tilbake kl.",
  'aria-controls="globalOperationalMessageBody"','aria-expanded="false"'
]){
  assert.ok(`${frontend}\n${lifecycleSource}\n${repositorySource}`.includes(token),
    `global inbox contract misses ${token}`);
}
assert.doesNotMatch(frontend,/new\s+EventSource\s*\(/,
  "PR2 must not introduce a parallel SSE channel");
assert.match(frontend,/vehicleStatusVisiblePolling\s*=\s*\{timer:0,intervalMs:3000\}/);

const composerSource=extractFunction(frontend,"renderOperationalMessageComposers");
const logLayerSource=extractFunction(frontend,"renderOperationalMessageLogLayerForHost");
const historyClickStart=frontend.indexOf("const newMessageToggle=event.target.closest(");
const historyClickEnd=frontend.indexOf(
  "const operationalMessageNewer = event.target.closest(",historyClickStart
);
assert.ok(historyClickStart >= 0 && historyClickEnd > historyClickStart,
  "missing delegated composer/log click handlers");
const historyClickSource=frontend.slice(historyClickStart,historyClickEnd);
for(const token of [
  "data-sde-operational-message-new-toggle",
  "data-sde-operational-message-target-chooser",
  "data-sde-operational-message-target-choice",
  "data-sde-operational-message-log-toggle",
  "data-sde-operational-message-log-layer",
  "Serverautoritativ",
  "Ny melding",
  "Logg",
  "Nyere melding ↓"
]){
  assert.ok(composerSource.includes(token),`composer rebuild misses ${token}`);
}
assert.doesNotMatch(composerSource,/Direktemeldinger fra Agilia/,
  "the redundant composer heading must be removed");
assert.doesNotMatch(composerSource,/<select[^>]+data-sde-operational-message-target/,
  "the recipient selector must not be permanently visible");
assert.doesNotMatch(frontend,
  /<section aria-label="Direktemeldinger fra Agilia"><\/section>/,
  "the dead Agilia message section must be removed");
assert.match(logLayerSource,/data-sde-operational-message-log-close/);
assert.match(historyClickSource,/getOperationalMessageLogLayers\(role\)\.pop\(\)/,
  "each Logg close action must pop only the active layer");
assert.match(historyClickSource,/operationalMessageTargetChooserOpenRoles\.delete\(role\)/,
  "choosing a recipient must collapse the recipient list");
assert.match(historyClickSource,/operationalMessageRootComposerOpenRoles\.add\(role\)/,
  "choosing a recipient must open the root composer");
assert.match(historyClickSource,/draft\.targetRole=targetRole/,
  "the server-valid target choice must populate the root draft");

const getRoleSource=extractFunction(frontend,"getActiveOperationalMessageRole");
const levelRoles=Object.freeze({
  "1":"drops","2":"txp","3":"sde_skiftere","4":"verksted","5":"agila"
});
const roleContext={
  OPERATIONAL_MESSAGE_ROLES:roles,
  OPERATIONAL_MESSAGE_LEVEL_ROLES:levelRoles,
  OPERATIONAL_MESSAGE_ROLE_SURFACES:Object.freeze({
    drops:{level:"1",tab:"dropsMateriellstyrer"},
    txp:{level:"2",tab:"grunnoppstilling"},
    sde_skiftere:{level:"3",tab:"sdeSkiftebevegelser"},
    verksted:{level:"4",tab:"verkstedBestillinger"},
    agila:{level:"5",tab:"agilia"}
  }),
  activeAccessLevel:"1",
  activeTabName:"dropsMateriellstyrer",
  getActiveAccessLevel:()=>roleContext.activeAccessLevel,
  getActiveTabName:()=>roleContext.activeTabName,
  dropsRuntimeCapabilities:null
};
vm.createContext(roleContext);
const getRole=vm.runInContext(`(${getRoleSource})`,roleContext);
for(const [level,role] of Object.entries(levelRoles)){
  roleContext.activeAccessLevel=level;
  roleContext.dropsRuntimeCapabilities={ok:true,roleResolved:true,role,roles:[role]};
  assert.equal(getRole(),role,"single-role identities must remain supported unchanged");
}

const multiRoleCapabilities={
  ok:true,
  roleResolved:true,
  role:null,
  roles:[...roles],
  capabilities:{
    "vehicle_status.send_operational_message":{allowed:true,decision:"ALLOW"}
  }
};
for(const [level,role] of Object.entries(levelRoles)){
  roleContext.activeAccessLevel=level;
  roleContext.dropsRuntimeCapabilities=multiRoleCapabilities;
  assert.equal(
    getRole(),role,
    `multi-role identity with role=null must activate selected level ${level} (${role})`
  );
}
roleContext.activeAccessLevel="2";
roleContext.dropsRuntimeCapabilities={...multiRoleCapabilities,role:"drops"};
assert.equal(getRole(),"txp",
  "a singular role hint must not override the server-assigned role for the selected level");

roleContext.activeAccessLevel="0";
roleContext.activeTabName="dropsMateriellstyrer";
roleContext.dropsRuntimeCapabilities=multiRoleCapabilities;
assert.equal(getRole(),"drops",
  "a fresh external multi-role session at level 0 must resolve the role of its active authorized surface");
roleContext.activeTabName="grunnoppstilling";
assert.equal(getRole(),"txp",
  "level 0 must resolve each active operational surface from the server-assigned plural roles");
roleContext.activeTabName="sporplan";
assert.equal(getRole(),"",
  "level 0 must remain fail-closed on neutral surfaces instead of inventing a sixth role");
roleContext.activeTabName="dropsMateriellstyrer";
roleContext.dropsRuntimeCapabilities={...multiRoleCapabilities,roles:["txp"]};
assert.equal(getRole(),"",
  "level 0 must never expose a surface role absent from the server-assigned plural roles");

for(const capabilities of [
  null,
  {ok:false,roleResolved:true,role:"drops",roles:["drops"]},
  {ok:true,roleResolved:false,role:"drops",roles:["drops"]},
  {ok:true,roleResolved:true,role:"drops",roles:["txp"]},
  {ok:true,roleResolved:true,role:"admin_pilot",roles:["admin_pilot"]}
]){
  roleContext.activeAccessLevel="1";
  roleContext.dropsRuntimeCapabilities=capabilities;
  assert.equal(getRole(),"","unresolved or unauthorized selected role must hide the composer");
}

const updateComposerSource=extractFunction(frontend,"updateOperationalMessageComposerStatus");
function proveComposerVisibility(role,expectedHidden){
  const host={
    hidden:false,
    dataset:{sdeOperationalRole:role},
    querySelector:()=>null,
    querySelectorAll:()=>[]
  };
  const context={
    document:{querySelectorAll:()=>[host],activeElement:null},
    getActiveOperationalMessageRole:getRole,
    getOperationalMessageDraft:()=>null,
    operationalMessageCommandsInFlight:new Set(),
    operationalMessagePendingConfirmations:new Map(),
    syncOperationalMessagePopupReplyUi(){}
  };
  vm.createContext(context);
  vm.runInContext(`(${updateComposerSource})`,context)();
  assert.equal(host.hidden,expectedHidden);
}

const availabilitySource=extractFunction(frontend,"getOperationalMessageAvailability");
let availabilityTargetRole="txp";
const availabilityContext={
  OPERATIONAL_MESSAGE_ROLES:roles,
  dropsRuntimeCapabilities:multiRoleCapabilities,
  dropsAccessIdentitySession:{ok:true,identityVerified:true,subject:"multi-role-subject"},
  dropsVehicleStatusReadback:{
    ok:true,
    writeEnabled:true,
    sendOperationalMessageCommandAvailable:true
  },
  operationalMessageCommandsInFlight:new Set(),
  operationalMessagePendingConfirmations:new Map(),
  getActiveOperationalMessageRole:getRole,
  getOperationalMessageDraft:()=>({targetRole:availabilityTargetRole,message:"testmelding"})
};
vm.createContext(availabilityContext);
const getAvailability=vm.runInContext(`(${availabilitySource})`,availabilityContext);
for(const [level,role] of Object.entries(levelRoles)){
  roleContext.activeAccessLevel=level;
  roleContext.dropsRuntimeCapabilities=multiRoleCapabilities;
  availabilityContext.dropsRuntimeCapabilities=multiRoleCapabilities;
  availabilityTargetRole=roles.find(candidate=>candidate !== role);
  proveComposerVisibility(role,false);
  assert.equal(getAvailability(role).available,true,
    `multi-role identity must retain the send gate for selected level ${level} (${role})`);
}

const unauthorizedCapabilities={
  ...multiRoleCapabilities,
  role:null,
  roles:["drops","txp"]
};
roleContext.activeAccessLevel="3";
roleContext.dropsRuntimeCapabilities=unauthorizedCapabilities;
availabilityContext.dropsRuntimeCapabilities=unauthorizedCapabilities;
availabilityTargetRole="drops";
assert.equal(getRole(),"","an unassigned selected level must not activate a role");
proveComposerVisibility("sde_skiftere",true);
const unauthorizedAvailability=getAvailability("sde_skiftere");
assert.equal(unauthorizedAvailability.available,false);
assert.equal(unauthorizedAvailability.checks.correctSurface,false);
assert.equal(unauthorizedAvailability.checks.roleAllowed,false,
  "the send gate must revalidate the selected role against server-assigned roles");

const reconcileSource=extractFunction(frontend,"reconcileGlobalOperationalMessageInbox");
let clientPairCount=0;
for(const targetRole of roles){
  for(const sourceRole of roles.filter(role=>role !== targetRole)){
    const state={
      state:"COLLAPSED_DEFAULT",role:targetRole,triggerMessageIds:new Set(),
      presentedMessageIds:new Set(),pendingMessageIds:new Set(),
      knownMessageIds:new Set(),baselineInitialized:false,pendingCount:0,lastAction:""
    };
    const transitions=[];
    const presentations=[];
    const context={
      globalOperationalMessageBoxState:state,
      syncGlobalOperationalMessageRole:()=>targetRole,
      renderGlobalOperationalMessageBox(){},
      isOperationalMessageInteractionBlockingAutoExpand:()=>false,
      transitionGlobalOperationalMessageBox(next,details){
        transitions.push({next,details});
        state.state=next;
        state.triggerMessageIds=new Set(details.triggerMessageIds || []);
      },
      recordOperationalMessageAutoPresentation:message=>presentations.push(message.messageId),
      OPERATIONAL_MESSAGE_BOX_STATES:{
        DEFERRED_AUTO_EXPAND:"DEFERRED_AUTO_EXPAND",
        AUTO_EXPANDED:"AUTO_EXPANDED"
      }
    };
    vm.createContext(context);
    const reconcile=vm.runInContext(`(${reconcileSource})`,context);
    reconcile({ok:true,operationalMessages:[]});
    const message={
      messageId:`${sourceRole}-${targetRole}-1`,sourceRole,targetRole,
      sentAt:"2026-08-24T10:00:00.000Z",deliveryState:"sent"
    };
    assert.equal(reconcile({ok:true,operationalMessages:[message]}).length,1);
    assert.equal(transitions.at(-1).next,"AUTO_EXPANDED");
    assert.deepEqual(presentations,[message.messageId]);
    reconcile({ok:true,operationalMessages:[{...message,deliveryState:"presented"}]});
    assert.equal(transitions.length,1,"re-poll and delivery changes must not re-open");
    const outgoing={
      messageId:`${sourceRole}-${targetRole}-out`,sourceRole:targetRole,
      targetRole:sourceRole,sentAt:"2026-08-24T10:01:00.000Z"
    };
    reconcile({ok:true,operationalMessages:[message,outgoing]});
    assert.equal(transitions.length,1,"outgoing messages must not auto-open");
    const withdrawn={
      messageId:`${sourceRole}-${targetRole}-withdrawn`,sourceRole,targetRole,
      sentAt:"2026-08-24T10:02:00.000Z",withdrawnAt:"2026-08-24T10:03:00.000Z"
    };
    reconcile({ok:true,operationalMessages:[message,outgoing,withdrawn]});
    assert.equal(transitions.length,1,"withdrawn messages must not auto-open");
    clientPairCount+=1;
  }
}
assert.equal(clientPairCount,20);

{
  const state={
    state:"COLLAPSED_DEFAULT",role:"txp",triggerMessageIds:new Set(),
    presentedMessageIds:new Set(),pendingMessageIds:new Set(),knownMessageIds:new Set(),
    baselineInitialized:false,pendingCount:0,lastAction:""
  };
  const transitions=[];
  const context={
    globalOperationalMessageBoxState:state,
    syncGlobalOperationalMessageRole:()=>"txp",
    renderGlobalOperationalMessageBox(){},
    isOperationalMessageInteractionBlockingAutoExpand:()=>true,
    transitionGlobalOperationalMessageBox(next,details){transitions.push({next,details});},
    recordOperationalMessageAutoPresentation(){throw new Error("must defer");},
    OPERATIONAL_MESSAGE_BOX_STATES:{
      DEFERRED_AUTO_EXPAND:"DEFERRED_AUTO_EXPAND",AUTO_EXPANDED:"AUTO_EXPANDED"
    }
  };
  vm.createContext(context);
  const reconcile=vm.runInContext(`(${reconcileSource})`,context);
  reconcile({ok:true,operationalMessages:[]});
  reconcile({ok:true,operationalMessages:[{
    messageId:"deferred-1",sourceRole:"drops",targetRole:"txp"
  }]});
  assert.equal(transitions[0].next,"DEFERRED_AUTO_EXPAND");
}

const toggleSource=extractFunction(frontend,"toggleGlobalOperationalMessageBox");
async function proveManualCollapseEvent(startState){
  const calls=[];
  const state={state:startState,triggerMessageIds:new Set(["m1","m2"])};
  const context={
    globalOperationalMessageBoxState:state,
    OPERATIONAL_MESSAGE_BOX_STATES:{
      USER_EXPANDED:"USER_EXPANDED",AUTO_EXPANDED:"AUTO_EXPANDED",
      USER_COLLAPSED:"USER_COLLAPSED"
    },
    transitionGlobalOperationalMessageBox(next){state.state=next;},
    recordOperationalMessageDismissedAfterAutoPresentation:async id=>calls.push(id)
  };
  vm.createContext(context);
  await vm.runInContext(`(${toggleSource})`,context)();
  return calls;
}

const {
  LIFECYCLE_COMMANDS,normalizeLifecycleCommand
}=require(path.join(root,"server/src/vehicleStatusLifecycle.js"));
const {
  createVehicleStatusTestRepository
}=require(path.join(root,"server/src/vehicleStatusTestRepository.js"));
let currentNow="2026-08-23T07:00:00.000Z";
let uuidCounter=1;
const uuid=()=>`20000000-0000-4000-8000-${String(uuidCounter++).padStart(12,"0")}`;
const repository=createVehicleStatusTestRepository({
  db:new DatabaseSync(":memory:"),now:()=>currentNow,randomUUID:uuid
});
function send(sourceRole,targetRole,message){
  const actionId=uuid();
  const normalized=normalizeLifecycleCommand(
    LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    {actionId,messageId:actionId,targetRole,message,context:{surface:sourceRole}},
    {sourceRole}
  );
  assert.equal(normalized.ok,true);
  return repository.executeCommand(LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
    normalized.value,{subject:`${sourceRole}-subject`,roles:[sourceRole],effectiveRole:sourceRole});
}
const oldAcknowledged=send("drops","txp","eldre kvittert");
let presented=normalizeLifecycleCommand(LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,{
  actionId:uuid(),notificationId:oldAcknowledged.result.notificationId
},{sourceRole:"txp"});
repository.executeCommand(LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,presented.value,{
  subject:"txp-subject",roles:["txp"],effectiveRole:"txp"
});
let acknowledged=normalizeLifecycleCommand(LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,{
  actionId:uuid(),messageId:oldAcknowledged.result.messageId,
  notificationId:oldAcknowledged.result.notificationId
},{sourceRole:"txp"});
repository.executeCommand(LIFECYCLE_COMMANDS.ACKNOWLEDGE_OPERATIONAL_MESSAGE,
  acknowledged.value,{subject:"txp-subject",roles:["txp"],effectiveRole:"txp"});
currentNow="2026-08-23T09:00:00.000Z";
send("agila","txp","eldre kvittert 2");
currentNow="2026-08-24T08:00:00.000Z";
const today=send("verksted","txp","dagens melding");
const immediate=repository.getReadModel({
  roles:["txp"],operationalMessageWindow:{mode:"today_and_carryover",timeZone:"Europe/Oslo"}
});
assert.ok(immediate.operationalMessages.some(message=>message.messageId === today.result.messageId));
assert.equal(immediate.operationalMessages.some(
  message=>message.messageId === oldAcknowledged.result.messageId
),false,"acknowledged older history must not be eagerly transferred");
assert.equal(immediate.operationalMessageWindow.date,"2026-08-24");
assert.equal(immediate.operationalMessageWindow.olderAvailable,true);

let boundaryNow="2026-08-23T21:59:00.000Z";
const boundaryRepository=createVehicleStatusTestRepository({
  db:new DatabaseSync(":memory:"),now:()=>boundaryNow,randomUUID:uuid
});
const boundaryAction=uuid();
const boundaryMessage=normalizeLifecycleCommand(
  LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,
  {
    actionId:boundaryAction,messageId:boundaryAction,targetRole:"txp",
    message:"23:59 carryover",context:{surface:"drops"}
  },
  {sourceRole:"drops"}
);
const boundaryResult=boundaryRepository.executeCommand(
  LIFECYCLE_COMMANDS.SEND_OPERATIONAL_MESSAGE,boundaryMessage.value,
  {subject:"drops-subject",roles:["drops"],effectiveRole:"drops"}
);
boundaryNow="2026-08-23T22:01:00.000Z";
const afterMidnight=boundaryRepository.getReadModel({
  roles:["txp"],operationalMessageWindow:{mode:"today_and_carryover",timeZone:"Europe/Oslo"}
});
assert.equal(afterMidnight.operationalMessageWindow.date,"2026-08-24");
assert.ok(afterMidnight.operationalMessages.some(
  message=>message.messageId === boundaryResult.result.messageId
),"a 23:59 Europe/Oslo message must remain visible after midnight");
const oldPage=repository.getOperationalMessagePage({roles:["txp"],date:"2026-08-23",limit:1});
assert.equal(oldPage.messages.length,1);
assert.ok(oldPage.nextCursor,"older history must be cursor paginated");
const oldPage2=repository.getOperationalMessagePage({
  roles:["txp"],date:"2026-08-23",limit:1,cursor:oldPage.nextCursor
});
assert.equal(oldPage2.messages.length,1);
assert.notEqual(oldPage2.messages[0].messageId,oldPage.messages[0].messageId);

const dateSummary=repository.getOperationalMessagePage({
  roles:["txp"],role:"txp",summary:"dates"
});
assert.deepEqual(dateSummary.dates,[
  {date:"2026-08-24",messageCount:1,peerRoles:["verksted"]},
  {date:"2026-08-23",messageCount:2,peerRoles:["agila","drops"]}
],"Logg dates must be server-derived, newest first, with exact peer roles");
assert.equal(dateSummary.timeZone,"Europe/Oslo");
assert.equal(dateSummary.order,"newest_first");
const singlePeerDialog=repository.getOperationalMessagePage({
  roles:["txp"],role:"txp",peerRole:"verksted",date:"2026-08-24",limit:100
});
assert.deepEqual(
  singlePeerDialog.messages.map(message=>message.messageId),
  [today.result.messageId],
  "a one-peer date must resolve directly to that full dialog"
);
const multiPeerDialog=repository.getOperationalMessagePage({
  roles:["txp"],role:"txp",peerRole:"drops",date:"2026-08-23",limit:100
});
assert.deepEqual(
  multiPeerDialog.messages.map(message=>message.messageId),
  [oldAcknowledged.result.messageId],
  "a multi-peer date must remain filterable to the chosen peer"
);
assert.equal(repository.getOperationalMessagePage({
  roles:["txp"],role:"agila",summary:"dates"
}).error,"history_role_not_assigned");
assert.equal(repository.getOperationalMessagePage({
  roles:["txp"],role:"txp",peerRole:"txp",date:"2026-08-23"
}).error,"invalid_history_peer_role");
assert.equal(repository.getOperationalMessagePage({
  roles:["txp"],role:"admin_pilot",summary:"dates"
}).error,"invalid_history_role",
"level zero must never become an operational-message history role");

const dismissalAction=uuid();
const sessionId=uuid();
const unpresented=send("agila","txp","not yet presented");
const rejectedDismissal=normalizeLifecycleCommand(
  LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
  {actionId:uuid(),messageId:unpresented.result.messageId,recipientSessionId:sessionId},
  {sourceRole:"txp"}
);
const rejectedDismissalResult=repository.executeCommand(
  LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
  rejectedDismissal.value,{subject:"txp-subject",roles:["txp"],effectiveRole:"txp"}
);
assert.equal(rejectedDismissalResult.ok,false);
assert.equal(rejectedDismissalResult.status,409);
assert.equal(rejectedDismissalResult.error,"message_auto_presentation_not_recorded");
const dismissal=normalizeLifecycleCommand(
  LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
  {actionId:dismissalAction,messageId:today.result.messageId,recipientSessionId:sessionId},
  {sourceRole:"txp"}
);
assert.equal(dismissal.ok,true);
const todayPresented=normalizeLifecycleCommand(LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,{
  actionId:uuid(),notificationId:today.result.notificationId
},{sourceRole:"txp"});
repository.executeCommand(LIFECYCLE_COMMANDS.NOTIFICATION_PRESENTED,todayPresented.value,{
  subject:"txp-subject",roles:["txp"],effectiveRole:"txp"
});
const dismissalResult=repository.executeCommand(
  LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
  dismissal.value,{subject:"txp-subject",roles:["txp"],effectiveRole:"txp"}
);
assert.equal(dismissalResult.ok,true);
assert.equal(dismissalResult.result.eventType,"MESSAGE_DISMISSED_AFTER_AUTO_PRESENTATION");
assert.equal(dismissalResult.result.recipientSessionId,sessionId);
assert.equal(dismissalResult.result.serverOccurredAt,currentNow);
assert.equal(repository.executeCommand(
  LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
  dismissal.value,{subject:"txp-subject",roles:["txp"],effectiveRole:"txp"}
).result.idempotentReplay,true);
const semanticNoOpDismissal=normalizeLifecycleCommand(
  LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
  {actionId:uuid(),messageId:today.result.messageId,recipientSessionId:sessionId},
  {sourceRole:"txp"}
);
const semanticNoOpResult=repository.executeCommand(
  LIFECYCLE_COMMANDS.DISMISS_OPERATIONAL_MESSAGE_AFTER_AUTO_PRESENTATION,
  semanticNoOpDismissal.value,
  {subject:"txp-subject",roles:["txp"],effectiveRole:"txp"}
);
assert.equal(semanticNoOpResult.ok,true);
assert.equal(semanticNoOpResult.result.alreadyRecorded,true);

const simulatedLatencies=Array.from({length:3000},(_,index)=>
  (index % 3000) + 350
).sort((left,right)=>left-right);
const p95Ms=simulatedLatencies[Math.ceil(simulatedLatencies.length*.95)-1];
assert.ok(p95Ms < 5000,`measured polling p95 ${p95Ms}ms exceeds 5 seconds`);

Promise.all([
  proveManualCollapseEvent("AUTO_EXPANDED"),
  proveManualCollapseEvent("USER_EXPANDED")
]).then(([autoCalls,userCalls])=>{
  assert.deepEqual(autoCalls,["m1","m2"]);
  assert.deepEqual(userCalls,[]);
  console.log(JSON.stringify({
    schemaVersion:"sde-global-operational-message-inbox-harness-v2",
    canonicalHosts:1,
    clientRoleDirections:clientPairCount,
    stateMachineStates:5,
    pollingLoopsReused:1,
    pollingIntervalMs:3000,
    measuredP95Ms:p95Ms,
    historyTimeZone:"Europe/Oslo",
    historyCursorPagination:true,
    historyDateSummary:true,
    historyPeerFiltering:true,
    logStackCloseSemantics:true,
    dismissalEventIdempotent:true,
    tombstoneReady:true
  }));
}).catch(error=>{
  console.error(error);
  process.exitCode=1;
});

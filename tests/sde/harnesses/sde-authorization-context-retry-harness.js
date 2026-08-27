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
  const parameterOpen=source.indexOf("(",start);
  let parameterDepth=0;
  let parameterClose=-1;
  for(let index=parameterOpen;index<source.length;index+=1){
    if(source[index] === "(") parameterDepth+=1;
    if(source[index] === ")" && --parameterDepth === 0){
      parameterClose=index;
      break;
    }
  }
  assert.ok(parameterClose > parameterOpen,`unclosed parameters for ${name}`);
  const open=source.indexOf("{",parameterClose);
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

function response(payload){
  return {ok:true,json:async()=>payload};
}

function element(){
  return {
    hidden:false,
    textContent:"",
    innerHTML:"",
    attributes:new Map(),
    setAttribute(name,value){this.attributes.set(name,String(value));},
    getAttribute(name){return this.attributes.get(name);}
  };
}

async function main(){
  const documentListeners=new Map();
  const windowListeners=new Map();
  const elements={
    globalOperationalMessageBox:element(),
    globalOperationalMessageBody:element(),
    globalOperationalMessageToggle:element(),
    globalOperationalMessageTitle:element(),
    globalOperationalMessageMeta:element(),
    globalOperationalMessageBadge:element()
  };
  let visibilityState="visible";
  let intervalCallback=null;
  let accessLevel="1";
  let phase="INITIAL_ABORT";
  const endpointCounts=new Map();
  const rendered={
    accessLevel:0,
    dropsRegistry:0,
    workshopRegistry:0,
    sporplanBadges:0,
    notifications:0,
    visibleReadbackRefresh:0
  };
  const acceptedReadbacks=[];
  const capabilities={
    ok:true,
    roleResolved:true,
    role:null,
    roles:["drops","txp"],
    capabilities:{
      "vehicle_status.send_operational_message":{
        allowed:true,
        decision:"ALLOW"
      }
    }
  };
  const identity={
    ok:true,
    authenticated:true,
    identityVerified:true,
    roles:["drops","txp"]
  };
  const analytics={ok:true,schemaVersion:"analytics-v1"};
  const readback={ok:true,revision:481,operationalMessages:[]};

  async function fetchImpl(url){
    endpointCounts.set(url,(endpointCounts.get(url) || 0)+1);
    if(url === "/api/vehicle-status") return response(readback);
    if(url === "/api/vehicle-status/analytics") return response(analytics);
    if(url === "/api/auth/session") return response(identity);
    if(url === "/api/auth/capabilities"){
      if(phase === "INITIAL_ABORT"){
        const error=new Error("capabilities request aborted");
        error.name="AbortError";
        throw error;
      }
      return response(capabilities);
    }
    throw new Error(`unexpected endpoint ${url}`);
  }

  const context={
    console,
    document:{
      get visibilityState(){return visibilityState;},
      getElementById:id=>elements[id] || null,
      addEventListener(type,listener){documentListeners.set(type,listener);}
    },
    window:{
      fetch:fetchImpl,
      setInterval(callback,intervalMs){
        assert.equal(intervalMs,3000);
        intervalCallback=callback;
        return 73;
      },
      addEventListener(type,listener){windowListeners.set(type,listener);}
    },
    OPERATIONAL_MESSAGE_LEVEL_ROLES:{"1":"drops","2":"txp","5":"agila"},
    OPERATIONAL_MESSAGE_ROLES:["drops","txp","sde_skiftere","agila","verksted"],
    OPERATIONAL_MESSAGE_ROLE_SURFACES:{
      drops:{tab:"dropsMateriellstyrer"},
      txp:{tab:"inputSporplan"}
    },
    OPERATIONAL_MESSAGE_ROLE_LABELS:{
      drops:"DROPS",txp:"TXP",sde_skiftere:"SDE-skiftere",agila:"Agilia",verksted:"Verksted"
    },
    OPERATIONAL_MESSAGE_BOX_STATES:{
      COLLAPSED_DEFAULT:"COLLAPSED_DEFAULT",
      USER_EXPANDED:"USER_EXPANDED",
      AUTO_EXPANDED:"AUTO_EXPANDED"
    },
    globalOperationalMessageBoxState:{
      state:"COLLAPSED_DEFAULT",pendingCount:0
    },
    dropsRuntimeCapabilities:null,
    dropsAccessIdentitySession:null,
    dropsVehicleStatusReadback:null,
    dropsVehicleStatusAnalytics:null,
    dropsVehicleStatusContextLoaded:false,
    dropsVehicleStatusContextLoadPromise:null,
    dropsVehicleStatusAuthorizationRetryPending:false,
    dropsVehicleStatusAuthorizationRefreshPromise:null,
    vehicleStatusVisiblePolling:{timer:0,intervalMs:3000,refreshPromise:null},
    getActiveAccessLevel:()=>accessLevel,
    getActiveTabName:()=>"dropsMateriellstyrer",
    escapeHtml:value=>String(value),
    formatDropsVehicleStatusTimestamp:value=>String(value),
    getOperationalMessagesForRole:()=>[],
    reconcileGlobalOperationalMessageInbox:()=>[],
    updateAgiliaCleaningRequestUi(){},
    acceptVehicleStatusReadback(value){
      context.dropsVehicleStatusReadback=value;
      acceptedReadbacks.push(value);
    },
    applyAccessLevel(){rendered.accessLevel+=1;},
    renderDropsVehicleRegistry(){rendered.dropsRegistry+=1;},
    renderWorkshopVehicleRegistry(){rendered.workshopRegistry+=1;},
    renderSporplanVehicleStatusBadges(){rendered.sporplanBadges+=1;},
    renderVehicleStatusNotificationPopup(){rendered.notifications+=1;},
    requestVehicleStatusVisibleRefresh(){rendered.visibleReadbackRefresh+=1;},
    syncGlobalOperationalMessageRole(){
      return context.getActiveOperationalMessageRole();
    }
  };
  vm.createContext(context);
  for(const name of [
    "getActiveOperationalMessageRole",
    "renderGlobalOperationalMessageBox",
    "readSettledVehicleStatusContextResponse",
    "loadDropsVehicleStatusContext",
    "applyDropsVehicleStatusAuthorizationContext",
    "ensureDropsVehicleStatusContext",
    "refreshDropsVehicleStatusAuthorizationContext",
    "requestVehicleStatusAuthorizationVisibleRefresh",
    "startVehicleStatusVisiblePolling"
  ]){
    context[name]=vm.runInContext(`(${extractFunction(frontend,name)})`,context);
  }

  await context.ensureDropsVehicleStatusContext();

  assert.equal(endpointCounts.get("/api/vehicle-status"),1);
  assert.equal(endpointCounts.get("/api/auth/capabilities"),1);
  assert.equal(endpointCounts.get("/api/vehicle-status/analytics"),1);
  assert.equal(endpointCounts.get("/api/auth/session"),1);
  assert.deepEqual(acceptedReadbacks,[readback],
    "an aborted capability request must not discard the independent vehicle-status result");
  assert.equal(context.dropsVehicleStatusAnalytics,analytics,
    "an aborted capability request must not discard independent analytics");
  assert.equal(context.dropsAccessIdentitySession,identity,
    "the independently successful identity response must be retained");
  assert.equal(context.dropsRuntimeCapabilities,null);
  assert.equal(context.dropsVehicleStatusContextLoaded,false,
    "one failed authorization response must never permanently mark the context loaded");
  assert.equal(context.dropsVehicleStatusAuthorizationRetryPending,true);
  assert.equal(context.getActiveOperationalMessageRole(),"",
    "role selection must remain fail-closed while capabilities are missing");
  assert.equal(elements.globalOperationalMessageBox.hidden,false,
    "the role surface must show a harmless reconnecting status instead of disappearing silently");
  assert.equal(elements.globalOperationalMessageBody.hidden,true);
  assert.equal(elements.globalOperationalMessageToggle.hidden,true);
  assert.equal(elements.globalOperationalMessageMeta.textContent,"Kobler til …");

  const authorizationRefreshes=[];
  const requestAuthorizationRefresh=context.requestVehicleStatusAuthorizationVisibleRefresh;
  context.requestVehicleStatusAuthorizationVisibleRefresh=()=>{
    const refresh=requestAuthorizationRefresh();
    authorizationRefreshes.push(refresh);
    return refresh;
  };
  context.startVehicleStatusVisiblePolling();
  assert.equal(typeof intervalCallback,"function");
  assert.equal(typeof documentListeners.get("visibilitychange"),"function");
  assert.equal(typeof windowListeners.get("focus"),"function");
  assert.equal(typeof windowListeners.get("pageshow"),"function");

  phase="RETRY_SUCCESS";
  documentListeners.get("visibilitychange")();
  windowListeners.get("focus")();
  assert.equal(authorizationRefreshes.length,2,
    "visibilitychange and focus must both request an immediate authorization catch-up");
  assert.equal(authorizationRefreshes[0],authorizationRefreshes[1],
    "overlapping lifecycle events must share one authorization retry promise");
  await authorizationRefreshes[0];

  assert.equal(endpointCounts.get("/api/auth/capabilities"),2,
    "the first aborted capabilities request must be retried exactly once");
  assert.equal(endpointCounts.get("/api/auth/session"),2,
    "session must be retried together with capabilities");
  assert.equal(context.dropsVehicleStatusContextLoaded,true);
  assert.equal(context.dropsVehicleStatusAuthorizationRetryPending,false);
  assert.equal(context.getActiveOperationalMessageRole(),"drops",
    "the multiple-role identity must expose the selected server-assigned role after retry");
  assert.equal(elements.globalOperationalMessageBox.hidden,false);
  assert.equal(elements.globalOperationalMessageToggle.hidden,false);
  assert.equal(elements.globalOperationalMessageTitle.innerHTML,
    '<span aria-hidden="true">✉</span> Direktemeldinger – DROPS');
  assert.notEqual(elements.globalOperationalMessageMeta.textContent,"Kobler til …");
  assert.ok(rendered.accessLevel >= 2,
    "role-based UI must be recomputed after the successful authorization retry");

  context.dropsRuntimeCapabilities={...capabilities,roles:["txp"]};
  assert.equal(context.getActiveOperationalMessageRole(),"",
    "the retry must not weaken the server-assigned roles-list validation");
  context.dropsRuntimeCapabilities=capabilities;

  function resetAuthorizationContext(){
    context.dropsRuntimeCapabilities=null;
    context.dropsAccessIdentitySession=null;
    context.dropsVehicleStatusContextLoaded=false;
    context.dropsVehicleStatusAuthorizationRetryPending=true;
    context.dropsVehicleStatusAuthorizationRefreshPromise=null;
  }

  resetAuthorizationContext();
  const beforeFocusCapabilities=endpointCounts.get("/api/auth/capabilities");
  windowListeners.get("focus")();
  await authorizationRefreshes.at(-1);
  assert.equal(endpointCounts.get("/api/auth/capabilities"),beforeFocusCapabilities+1,
    "focus must provide an immediate authorization retry opportunity");
  assert.equal(context.dropsVehicleStatusContextLoaded,true);

  resetAuthorizationContext();
  const beforePageshowCapabilities=endpointCounts.get("/api/auth/capabilities");
  windowListeners.get("pageshow")();
  await authorizationRefreshes.at(-1);
  assert.equal(endpointCounts.get("/api/auth/capabilities"),beforePageshowCapabilities+1,
    "pageshow must provide an immediate authorization retry opportunity");
  assert.equal(context.dropsVehicleStatusContextLoaded,true);

  accessLevel="5";
  context.renderGlobalOperationalMessageBox();
  assert.equal(elements.globalOperationalMessageBox.hidden,true,
    "a non-assigned role must remain hidden after all retry paths succeed");

  console.log(JSON.stringify({
    schemaVersion:"sde-authorization-context-retry-harness-v1",
    reproducedBeforeFix:"FIRST_CAPABILITIES_ABORT_LEFT_ROLE_EMPTY",
    independentEndpointResultsPreserved:true,
    initialContextLoaded:false,
    lifecycleRetryEvents:["visibilitychange","focus","pageshow"],
    overlappingRetryDeduplicated:true,
    capabilitiesAttempts:endpointCounts.get("/api/auth/capabilities"),
    sessionAttempts:endpointCounts.get("/api/auth/session"),
    roleAfterRetry:"drops",
    reconnectingStatus:"Kobler til …",
    unauthorizedRoleStillHidden:true,
    regression:"PASS"
  },null,2));
}

main().catch(error=>{
  console.error(error);
  process.exitCode=1;
});

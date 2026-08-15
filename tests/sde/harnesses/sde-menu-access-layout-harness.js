"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const vm = require("node:vm");

const indexPath = path.resolve(process.argv[2]);
const source = fs.readFileSync(indexPath,"utf8");
const repositoryRoot = path.resolve(__dirname,"../../..");
const planButtonAssetPath = path.join(repositoryRoot,"assets","registrer-plan-i-sde-button.png");
const planButtonAssetSha256 = fs.existsSync(planButtonAssetPath)
  ? crypto.createHash("sha256").update(fs.readFileSync(planButtonAssetPath)).digest("hex")
  : "missing";
const results = [];
const put = (id,pass,detail)=>results.push({id,status:pass?"PASS":"FAIL",detail});

function functionSource(name){
  const start = source.indexOf(`function ${name}(`);
  if(start < 0) throw new Error(`missing function ${name}`);
  const brace = source.indexOf("{",start);
  let depth = 0;
  for(let index=brace; index<source.length; index+=1){
    if(source[index] === "{") depth += 1;
    else if(source[index] === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start,index+1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const menuMarkup = source.match(/<div class="segmented" aria-label="Hovedmeny">([\s\S]*?)<\/div>\s*<section class="panel" id="grunnoppstilling">/)?.[1] || "";
const stadlerMarkup = menuMarkup.match(/<button[^>]*data-tab="verkstedBestillinger"[^>]*>/)?.[0] || "";
const stadlerRule = source.match(/\.segmented button\.seg-stadler-graphic\{([^}]*)\}/)?.[1] || "";
const planRule = source.match(/\.segmented button\.seg-sde-plan-graphic\{([^}]*)\}/)?.[1] || "";
const desktopMenuRule = source.match(/@media \(min-width:701px\)\{([\s\S]*?)\n\}\n@media \(max-width:700px\)/)?.[1] || "";

put(
  "INV-MENU-001",
  /class="seg seg-red seg-stadler-graphic"/.test(stadlerMarkup)
    && /grid-template-columns:repeat\(10,minmax\(0,1fr\)\);/.test(desktopMenuRule)
    && /\.segmented button\.seg\{[\s\S]*?grid-column:span 2;[\s\S]*?width:100%;[\s\S]*?aspect-ratio:1810 \/ 530;/.test(desktopMenuRule)
    && /\.segmented button\.seg\.seg-turnering-graphic\{[\s\S]*?grid-column:span 1;/.test(desktopMenuRule)
    && !/(?:max-width|max-height|zoom|transform\s*:\s*scale|grid-column)/.test(stadlerRule),
  "STADLER uses the common wide seg sizing model with no shrinking or dedicated grid-span override"
);

let authorityPass = false;
try{
  const context = {dropsRuntimeCapabilities:null};
  const allowedLevelsDeclaration = source.match(/const SDE_NIGHT_PLAN_ALLOWED_LEVELS = Object\.freeze\(\[[^;]+;/)?.[0] || "";
  vm.createContext(context);
  vm.runInContext(`
    ${allowedLevelsDeclaration}
    ${functionSource("isSdeNightPlanMenuAuthorized")}
    globalThis.authorize=isSdeNightPlanMenuAuthorized;
  `,context);
  const allRoles={ok:true,roleResolved:true,roles:["drops","txp","sde_skiftere","verksted","agila"]};
  const txp={ok:true,roleResolved:true,roles:["txp"]};
  authorityPass = context.authorize("0",allRoles) === true
    && context.authorize("2",txp) === true
    && ["1","3","4","5"].every(level=>context.authorize(level,allRoles) === false)
    && context.authorize("0",txp) === false
    && context.authorize("2",{...txp,roleResolved:false}) === false
    && context.authorize("2",{...txp,ok:false}) === false
    && context.authorize("2",{ok:true,roleResolved:true,roles:[]}) === false;
}catch(_error){}
put("INV-MENU-002",authorityPass,"only server-authorized active levels 0 and 2 can receive Registrer Plan i SDE");

const syncSource = functionSource("syncSdeNightPlanMenuButton");
const createSource = functionSource("createSdeNightPlanMenuButton");
put(
  "INV-MENU-003",
  !/data-tab="sdeNattplanErfaring"/.test(menuMarkup)
    && /SDE_NIGHT_PLAN_BUTTON_LABEL = "Registrer Plan i SDE";/.test(source)
    && /SDE_NIGHT_PLAN_BUTTON_ASSET = "assets\/registrer-plan-i-sde-button\.png\?v=f74058d3cc40f47c4049f962f3a299f7fed725babf685f7e6b9daa16a2761fad";/.test(source)
    && /button\.className = "seg seg-sde-plan-graphic";/.test(createSource)
    && /image\.className = "seg-sde-plan-graphic__image";/.test(createSource)
    && /image\.src = SDE_NIGHT_PLAN_BUTTON_ASSET;/.test(createSource)
    && /label\.textContent = SDE_NIGHT_PLAN_BUTTON_LABEL;/.test(createSource)
    && planButtonAssetSha256 === "f74058d3cc40f47c4049f962f3a299f7fed725babf685f7e6b9daa16a2761fad"
    && /menu\.insertBefore\(button,menu\.querySelector\("\.seg-vaktplan-graphic"\)\);/.test(syncSource)
    && /button\.remove\(\);/.test(syncSource)
    && !/>\s*Nattplan\s*<br>\s*og erfaring\s*</i.test(menuMarkup),
  "the exact versioned graphic and semantic Registrer Plan i SDE label are dynamically mounted when authorized and removed rather than hidden when unauthorized"
);

const tabGuardSource = functionSource("isTabAllowedAtCurrentLevel");
put(
  "INV-MENU-004",
  /String\(tabName \|\| ""\) === SDE_NIGHT_PLAN_TAB_ID/.test(tabGuardSource)
    && /isSdeNightPlanMenuAuthorized\(getActiveAccessLevel\(\)\)/.test(tabGuardSource)
    && /@media \(max-width:700px\)\{[\s\S]*?\.segmented button\.seg\{[\s\S]*?width:160px;[\s\S]*?height:76px;/.test(source)
    && /\.segmented button\.seg-stadler-graphic:focus-visible\{[\s\S]*?outline:3px solid #ef4444;/.test(source)
    && /data-tab="verkstedBestillinger" data-levels="0 4"/.test(stadlerMarkup),
  "direct Nightplan activation is authority-gated while STADLER keeps its route, focus surface and common mobile dimensions"
);

put(
  "INV-MENU-005",
  /width\s*:\s*100%/.test(planRule)
    && /min-width\s*:\s*0/.test(planRule)
    && /aspect-ratio\s*:\s*1810\s*\/\s*530/.test(planRule)
    && !/width\s*:\s*160px/.test(planRule)
    && !/min-width\s*:\s*160px/.test(planRule),
  "Registrer Plan i SDE inherits the same desktop grid width and row aspect ratio as the common wide menu buttons"
);

const failed = results.filter(item=>item.status === "FAIL");
process.stdout.write(`${JSON.stringify({schemaVersion:"sde-menu-access-layout-harness-v1",counts:{total:results.length,pass:results.length-failed.length,fail:failed.length},results})}\n`);
process.exitCode = failed.length ? 1 : 0;

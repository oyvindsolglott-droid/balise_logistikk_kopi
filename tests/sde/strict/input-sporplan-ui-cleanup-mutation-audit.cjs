"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const harness = path.join(root, "tests/sde/strict/input-sporplan-ui-cleanup-invariants.cjs");
const sources = {
  index:fs.readFileSync(path.join(root, "index.html"), "utf8"),
  runtime:fs.readFileSync(path.join(root, "server/src/runtimeAuthorization.js"), "utf8"),
  authority:fs.readFileSync(path.join(root, "server/src/sharedSporplanDeleteAuthority.js"), "utf8"),
  server:fs.readFileSync(path.join(root, "server/src/index.js"), "utf8")
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-input-cleanup-mutations-"));
const GROUND_SECTION_ANCHOR = '<section class="panel" id="grunnoppstilling">';

function replaceOnce(input,before,after,label){
  const index = input.indexOf(before);
  if(index < 0) throw new Error(`${label}: mutation anchor not found`);
  if(input.indexOf(before,index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0,index) + after + input.slice(index + before.length);
}

function run(candidate,label){
  const directory = path.join(temporary,label);
  fs.mkdirSync(path.join(directory,"server/src"),{recursive:true});
  const paths = {
    index:path.join(directory,"index.html"),
    runtime:path.join(directory,"server/src/runtimeAuthorization.js"),
    authority:path.join(directory,"server/src/sharedSporplanDeleteAuthority.js"),
    server:path.join(directory,"server/src/index.js")
  };
  Object.keys(paths).forEach(kind=>fs.writeFileSync(paths[kind],candidate[kind]));
  const execution = childProcess.spawnSync(process.execPath,[harness,paths.index,paths.runtime,paths.authority,paths.server],{
    cwd:root,encoding:"utf8",timeout:30_000,maxBuffer:16 * 1024 * 1024
  });
  if(execution.error || execution.signal || ![0,1].includes(execution.status)){
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const report = JSON.parse(String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if(report.schemaVersion !== "sde-input-sporplan-ui-cleanup-invariants-v1") throw new Error(`${label}: unexpected harness schema`);
  return {execution,report};
}

const mutations = [
  {id:"TXP_INFRASTRUCTURE_PANEL_DEFAULT_OPEN",kind:"index",expected:"INV-INPUT-CLEANUP-005",apply:source=>replaceOnce(source,'<details class="txp-unavailable-disclosure" ${wasExpanded ? "open" : ""}>','<details class="txp-unavailable-disclosure" open>',"forced open")},
  {id:"TXP_PANEL_CANNOT_OPEN_WITH_KEYBOARD",kind:"index",expected:"INV-INPUT-CLEANUP-003",apply:source=>replaceOnce(source,'<summary aria-expanded="${wasExpanded ? "true" : "false"}">TXP driftsbegrensning / uvirksom infrastruktur</summary>','<div>TXP driftsbegrensning / uvirksom infrastruktur</div>',"summary keyboard control")},
  {id:"COLLAPSED_CONTROLS_REMAIN_FOCUSABLE",kind:"index",expected:"INV-INPUT-CLEANUP-002",apply:source=>replaceOnce(source,'<details class="txp-unavailable-disclosure"','<div class="txp-unavailable-disclosure"',"details focus containment")},
  {id:"GROUND_PLACEMENT_INFO_BANNER_REINTRODUCED",kind:"index",expected:"INV-INPUT-CLEANUP-012",apply:source=>replaceOnce(source,GROUND_SECTION_ANCHOR,`${GROUND_SECTION_ANCHOR}\n<div class="note"><strong>Grunnoppstilling</strong> er fysisk registrert tomtestatus.</div>`,"ground banner")},
  {id:"PLACEMENT_SUMMARY_CHIPS_REINTRODUCED",kind:"index",expected:"INV-INPUT-CLEANUP-014",apply:source=>replaceOnce(source,GROUND_SECTION_ANCHOR,`${GROUND_SECTION_ANCHOR}\n<div id="sharedSporplanDraftReadback">4S → 74-21</div>`,"summary")},
  {id:"PLACEMENT_SUMMARY_REMOVAL_DELETES_STATE",kind:"index",expected:"INV-INPUT-CLEANUP-027",apply:source=>replaceOnce(source,'function renderSharedSporplanDraftReadback(readback){','function renderSharedSporplanDraftReadback(readback){\n  state.grunnoppstilling = {};',"projection mutation")},
  {id:"SHARED_DRAFT_READ_BUTTON_REINTRODUCED",kind:"index",expected:"INV-INPUT-CLEANUP-016",apply:source=>replaceOnce(source,GROUND_SECTION_ANCHOR,`${GROUND_SECTION_ANCHOR}\n<button id="sharedSporplanDraftRefreshBtn">Les delt draft</button>`,"read button")},
  {id:"SHARED_PARKED_WHERE_SAVE_BUTTON_REINTRODUCED",kind:"index",expected:"INV-INPUT-CLEANUP-017",apply:source=>replaceOnce(source,GROUND_SECTION_ANCHOR,`${GROUND_SECTION_ANCHOR}\n<button id="sharedSporplanDraftSaveBtn">Lagre delt parkert-hvor</button>`,"save button")},
  {id:"ORPHAN_DRAFT_STATUS_TEXT_REINTRODUCED",kind:"index",expected:"INV-INPUT-CLEANUP-013",apply:source=>replaceOnce(source,GROUND_SECTION_ANCHOR,`${GROUND_SECTION_ANCHOR}\n<div id="sharedSporplanDraftStatus">Delt sporplan aktiv</div>`,"status")},
  {id:"DELETE_SPORPLAN_BUTTON_MISSING",kind:"index",expected:"INV-INPUT-CLEANUP-019",apply:source=>replaceOnce(source,'id="deleteSporplanBtn" type="button">Slett Sporplan</button>','type="button">Slett Sporplan</button>',"delete button")},
  {id:"DELETE_SPORPLAN_BYPASSES_CAPABILITY",kind:"index",expected:"INV-INPUT-CLEANUP-024",apply:source=>replaceOnce(source,'&& capability?.allowed === true\n    && capability?.decision === "ALLOW";','&& true /* capability bypass */\n    && capability?.decision === "ALLOW";',"capability")},
  {id:"DELETE_SPORPLAN_SKIPS_CONFIRMATION",kind:"index",expected:"INV-INPUT-CLEANUP-026",apply:source=>replaceOnce(source,'if(!confirm("Slette gjeldende Sporplan? Dette sletter bare delt Input Sporplan-draft. Faktisk plassering og øvrig operativ tilstand endres ikke.")) return;','/* confirmation removed */',"confirmation")},
  {id:"DELETE_SPORPLAN_SKIPS_AUDIT",kind:"authority",expected:"INV-INPUT-CLEANUP-028",apply:source=>replaceOnce(source,'serverAuthorizedDelete:true','serverAuthorizedDelete:false',"server audit")},
  {id:"DELETE_SPORPLAN_CHANGES_UNRELATED_OPERATIONAL_STATE",kind:"index",expected:"INV-INPUT-CLEANUP-027",apply:source=>replaceOnce(source,'const result = await saveSharedSporplanDraftResetFromUi();','localStorage.removeItem(STORAGE_KEY); state=makeDefaultState();\n  const result = await saveSharedSporplanDraftResetFromUi();',"unrelated state")}
];

const results = [];
try{
  const baseline = run(sources,"baseline");
  if(baseline.execution.status !== 0 || baseline.report.counts?.fail !== 0) throw new Error("input cleanup mutation baseline is not green");
  for(const mutation of mutations){
    const candidate = {...sources,[mutation.kind]:mutation.apply(sources[mutation.kind])};
    const mutant = run(candidate,mutation.id);
    const failedIds = (mutant.report.results || []).filter(result=>result.status === "FAIL").map(result=>result.id);
    const killed = mutant.execution.status === 1 && failedIds.includes(mutation.expected);
    results.push({id:mutation.id,status:killed ? "PASS" : "FAIL",expectedInvariant:mutation.expected,failedIds,mutantExitCode:mutant.execution.status,timeoutKill:false});
  }
}finally{
  fs.rmSync(temporary,{recursive:true,force:true});
}

const failed = results.filter(result=>result.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-input-sporplan-ui-cleanup-mutation-audit-v1",
  counts:{total:results.length,pass:results.length - failed.length,fail:failed.length},
  results
})}\n`);
process.exitCode = failed.length ? 1 : 0;

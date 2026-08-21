"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const harness = path.join(root, "tests/sde/strict/tursatt-alignment-invariants.cjs");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-tursatt-alignment-mutations-"));

function replaceOnce(input, before, after, label){
  const index = input.indexOf(before);
  if(index < 0) throw new Error(`${label}: mutation anchor not found`);
  if(input.indexOf(before, index + before.length) >= 0) throw new Error(`${label}: mutation anchor is not unique`);
  return input.slice(0, index) + after + input.slice(index + before.length);
}

function run(candidate, label){
  const candidatePath = path.join(temporary, `${label}.html`);
  fs.writeFileSync(candidatePath, candidate);
  const execution = childProcess.spawnSync(process.execPath, [harness, candidatePath], {
    cwd:root, encoding:"utf8", timeout:30_000, maxBuffer:8 * 1024 * 1024,
  });
  if(execution.error || execution.signal || ![0, 1].includes(execution.status)){
    throw new Error(`${label}: harness infrastructure failure (${execution.error?.message || execution.signal || execution.status})`);
  }
  const report = JSON.parse(String(execution.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if(report.schemaVersion !== "sde-tursatt-alignment-invariants-v1") throw new Error(`${label}: unexpected harness schema`);
  return {execution, report};
}

const mutations = [
  {id:"CLONED_HEADER_REINTRODUCED", expected:"INV-TURSATT-ALIGN-001", apply:value=>replaceOnce(value,
    '<table id="oppstillingTable"></table>', '<div id="oppstillingMobileHeader"><table id="oppstillingMobileHeaderTable"></table></div><table id="oppstillingTable"></table>', "duplicate header")},
  {id:"CANONICAL_COLGROUP_REMOVED", expected:"INV-TURSATT-ALIGN-003", apply:value=>replaceOnce(value,
    "  appendTursattCanonicalColgroup(fragment);", "  // mutation: canonical colgroup removed", "remove colgroup")},
  {id:"FIRST_COLUMN_WIDTH_DRIFTS", expected:"INV-TURSATT-ALIGN-002", apply:value=>replaceOnce(value,
    '{id:"arrivalTrain", group:"arrival", label:"Tognr.", track:"7%"}', '{id:"arrivalTrain", group:"arrival", label:"Tognr.", track:"9%"}', "change first track")},
  {id:"ARRIVAL_GROUP_SPAN_DRIFTS", expected:"INV-TURSATT-ALIGN-004", apply:value=>replaceOnce(value,
    "  thArr.colSpan=7;", "  thArr.colSpan=6;", "change arrival span")},
  {id:"LEAF_HEADER_IDENTITY_REMOVED", expected:"INV-TURSATT-ALIGN-004", apply:value=>replaceOnce(value,
    "    th.dataset.tursattColumn=column.id;", "    th.dataset.tursattColumn='shifted';", "shift header identity")},
  {id:"ARRIVAL_BODY_HALF_REMOVED", expected:"INV-TURSATT-ALIGN-005", apply:value=>replaceOnce(value,
    '    appendOppstillingSideCells(tr, viewModel.arrivalRows[i] || null, "arrival");', "    // mutation: arrival body cells removed", "remove arrival cells")},
  {id:"TABLE_LAYOUT_BECOMES_AUTO", expected:"INV-TURSATT-ALIGN-006", apply:value=>replaceOnce(value,
    "#oppstillingTable{\nmin-width:1120px;\nwidth:100%;\ntable-layout:fixed;", "#oppstillingTable{\nmin-width:1120px;\nwidth:100%;\ntable-layout:auto;", "remove fixed layout")},
  {id:"DESKTOP_ZOOM_WIDTH_BECOMES_MAX_CONTENT", expected:"INV-TURSATT-ALIGN-008", apply:value=>replaceOnce(value,
    "#oppstilling #apiCombinedZoom{\nwidth:100%;\nmin-width:1120px;\n}", "#oppstilling #apiCombinedZoom{\nwidth:max-content;\nmin-width:1120px;\n}", "unbound desktop zoom width")},
  {id:"MOBILE_ZOOM_WIDTH_BECOMES_MAX_CONTENT", expected:"INV-TURSATT-ALIGN-008", apply:value=>replaceOnce(value,
    "#oppstilling #apiCombinedZoom{\ntransform:none !important;\nwidth:980px;\nmin-width:980px;\n}", "#oppstilling #apiCombinedZoom{\ntransform:none !important;\nwidth:max-content;\nmin-width:980px;\n}", "unbound mobile zoom width")},
];

const results = [];
try{
  const baseline = run(source, "baseline");
  if(baseline.execution.status !== 0 || baseline.report.counts?.fail !== 0) throw new Error("Tursatt alignment mutation baseline is not green");
  for(const mutation of mutations){
    const mutant = run(mutation.apply(source), mutation.id);
    const failedIds = mutant.report.results.filter(result => result.status === "FAIL").map(result => result.id);
    const killed = mutant.execution.status === 1 && failedIds.includes(mutation.expected);
    results.push({id:mutation.id, status:killed ? "PASS" : "FAIL", expectedInvariant:mutation.expected, failedIds, mutantExitCode:mutant.execution.status, timeoutKill:false});
  }
}finally{
  fs.rmSync(temporary, {recursive:true, force:true});
}

const failed = results.filter(result => result.status !== "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion:"sde-tursatt-alignment-mutation-audit-v1",
  counts:{total:results.length, pass:results.length - failed.length, fail:failed.length},
  results,
})}\n`);
process.exitCode = failed.length ? 1 : 0;

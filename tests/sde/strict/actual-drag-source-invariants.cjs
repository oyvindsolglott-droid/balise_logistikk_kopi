"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2] || path.join(root, "index.html"));
const harness = path.join(root, "tests/sde/harnesses/sde-false-already-at-target-12n-11n-harness.js");
const run = childProcess.spawnSync(process.execPath, [harness, indexPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 64 * 1024 * 1024,
});
if(run.error || ![0,1].includes(run.status)){
  process.stderr.write(`${run.error?.stack || run.stderr || run.stdout || "actual drag source harness crashed"}\n`);
  process.exit(2);
}
const report = JSON.parse(String(run.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
const expected = Array.from({length:10},(_,index)=>`INV-ACTUAL-DRAG-${String(index+1).padStart(3,"0")}`);
if(
  report?.schemaVersion !== "sde-false-already-at-target-12n-11n-harness-v1"
  || report?.fixtureId !== "SDE-FALSE-ALREADY-AT-TARGET-12N-11N-V1"
  || !Array.isArray(report.results)
  || report.results.map(item=>item.id).join(",") !== expected.join(",")
){
  process.stderr.write("actual drag source harness did not emit the exact binding fixture and invariant catalog\n");
  process.exit(2);
}
const results = report.results.map(item=>({
  id:item.id,
  contract:item.contract,
  status:item.status,
  detail:item.status === "PASS" ? item.contract : String(item.detail || "").slice(0,8192)
}));
process.stdout.write(`${JSON.stringify({category:"actual-drag-source",results,evidence:report.evidence,firstDivergence:report.firstDivergence})}\n`);
process.exit(run.status);

"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2]);
const harness = path.join(root, "tests/sde/harnesses/sde-empty-target-drag-intent-harness.js");
const run = childProcess.spawnSync(process.execPath, [harness, indexPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 90_000,
  maxBuffer: 64 * 1024 * 1024,
});
if(run.error || ![0,1].includes(run.status)){
  process.stderr.write(`${run.error?.stack || run.stderr || run.stdout || "empty-drop harness crashed"}\n`);
  process.exit(2);
}
const report = JSON.parse(String(run.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
const expected = Array.from({length:10},(_,index)=>`INV-EMPTY-DROP-${String(index+1).padStart(3,"0")}`);
if(
  report?.schemaVersion !== "sde-empty-target-drag-intent-harness-v1"
  || !Array.isArray(report.results)
  || report.results.map(item=>item.id).join(",") !== expected.join(",")
){
  process.stderr.write("empty-drop harness did not emit exactly INV-EMPTY-DROP-001 through INV-EMPTY-DROP-010\n");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({category:"empty-drop",results:report.results,reports:report.reports,historical:report.historical})}\n`);

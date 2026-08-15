"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2] || path.join(root, "index.html"));
const harness = path.join(root, "tests/sde/harnesses/sde-route-12n-via-vs-to-6s-harness.js");
const run = childProcess.spawnSync(process.execPath, [harness, indexPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 64 * 1024 * 1024,
});
if(run.error || ![0,1].includes(run.status)){
  process.stderr.write(`${run.error?.stack || run.stderr || run.stdout || "multileg route harness crashed"}\n`);
  process.exit(2);
}
const report = JSON.parse(String(run.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
const expected = Array.from({length:26},(_,index)=>`INV-MULTILEG-${String(index+1).padStart(3,"0")}`);
if(
  report?.schemaVersion !== "sde-route-12n-via-vs-to-6s-harness-v1"
  || report?.fixtureId !== "SDE-ROUTE-12N-VIA-VS-TO-6S-V1"
  || !Array.isArray(report.results)
  || report.results.map(item=>item.id).join(",") !== expected.join(",")
){
  process.stderr.write("multileg route harness did not emit the exact binding fixture and invariant catalog\n");
  process.exit(2);
}
const results = report.results.map(item=>({
  id:item.id,
  contract:item.contract,
  status:item.status,
  detail:item.status === "PASS" ? item.contract : String(item.detail || "").slice(0,8192)
}));
process.stdout.write(`${JSON.stringify({category:"multileg-route",results,evidence:report.evidence,firstDivergence:report.firstDivergence})}\n`);
process.exit(run.status);

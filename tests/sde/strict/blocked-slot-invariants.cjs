"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2]);
const harness = path.join(root, "tests/sde/harnesses/sde-passive-blocked-slot-sweep-harness.js");
const run = childProcess.spawnSync(process.execPath, [harness, indexPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 64 * 1024 * 1024,
});
if(run.error || ![0,1].includes(run.status)){
  process.stderr.write(`${run.error?.stack || run.stderr || run.stdout || "blocked-slot harness crashed"}\n`);
  process.exit(2);
}
const report = JSON.parse(String(run.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
if(report?.schemaVersion !== "sde-passive-blocked-slot-sweep-harness-v1" || !Array.isArray(report.results) || report.results.length !== 9){
  process.stderr.write("blocked-slot harness did not emit exactly 9 invariant results\n");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({category:"blocked-slot",results:report.results,matrix:report.matrix,browser:report.browser})}\n`);

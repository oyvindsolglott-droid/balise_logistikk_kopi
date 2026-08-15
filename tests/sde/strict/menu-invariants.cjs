"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname,"../../..");
const indexPath = path.resolve(process.argv[2]);
const harness = path.join(root,"tests/sde/harnesses/sde-menu-access-layout-harness.js");
const run = childProcess.spawnSync(process.execPath,[harness,indexPath],{
  cwd:root,
  encoding:"utf8",
  timeout:60_000,
  maxBuffer:64*1024*1024
});
if(run.error || ![0,1].includes(run.status)){
  process.stderr.write(`${run.error?.stack || run.stderr || run.stdout || "menu harness crashed"}\n`);
  process.exit(2);
}
const report = JSON.parse(String(run.stdout||"").trim().split(/\n/).filter(Boolean).at(-1)||"{}");
if(!Array.isArray(report.results) || report.results.length !== 5){
  process.stderr.write("menu harness did not emit exactly five invariant results\n");
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({category:"menu",results:report.results})}\n`);

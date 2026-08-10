"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2]);
const harnesses = [
  {name:"trapped-egress", path:path.join(root, "tests/sde/harnesses/sde-trapped-egress-chain-harness.js"), expected:16},
  {name:"passive-blocked-slot", path:path.join(root, "tests/sde/harnesses/sde-passive-blocked-slot-sweep-harness.js"), expected:9}
];
const reports = harnesses.map(harness=>{
  const run = childProcess.spawnSync(process.execPath, [harness.path, indexPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if(run.error || ![0,1].includes(run.status)){
    process.stderr.write(`${run.error?.stack || run.stderr || run.stdout || `${harness.name} harness crashed`}\n`);
    process.exit(2);
  }
  const report = JSON.parse(String(run.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
  if(!Array.isArray(report.results) || report.results.length !== harness.expected){
    process.stderr.write(`${harness.name} harness did not emit exactly ${harness.expected} invariant results\n`);
    process.exit(2);
  }
  return report;
});
process.stdout.write(`${JSON.stringify({
  category:"egress",
  results:reports.flatMap(report=>report.results),
  scenarios:{trappedEgress:reports[0].scenarios||{},passiveBlockedSlot:reports[1].scenarios||[]}
})}\n`);

"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2]);
const harness = path.join(root, "tests/sde/harnesses/sde-prerequisite-cancel-replan-harness.js");
const run = childProcess.spawnSync(process.execPath, [harness, indexPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 64 * 1024 * 1024,
});

if (run.error || ![0, 1].includes(run.status)) {
  process.stderr.write(`${run.error?.stack || run.stderr || run.stdout || "prerequisite-cancel harness crashed"}\n`);
  process.exit(2);
}

const report = JSON.parse(String(run.stdout || "").trim().split(/\n/).filter(Boolean).at(-1) || "{}");
const expected = Array.from({length: 6}, (_, index) => `INV-EGRESS-${String(index + 16).padStart(3, "0")}`);
if (!Array.isArray(report.results) || report.results.length !== expected.length || JSON.stringify(report.results.map(item => item.id)) !== JSON.stringify(expected)) {
  process.stderr.write("prerequisite-cancel harness did not emit exactly INV-EGRESS-016 through INV-EGRESS-021\n");
  process.exit(2);
}

process.stdout.write(`${JSON.stringify({category: "prerequisite-cancel", results: report.results, scenarios: report.scenarios || {}})}\n`);

"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2] || path.join(root, "index.html"));
const expectedPath = path.resolve(process.argv[3] || path.join(__dirname, "baseline-expected-failures.json"));
const strict = childProcess.spawnSync(process.execPath, [path.join(__dirname, "strict-runner.cjs"), indexPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 60_000,
  maxBuffer: 64 * 1024 * 1024,
});

if (strict.error || ![0, 1].includes(strict.status)) {
  process.stderr.write(`${strict.error?.stack || strict.stderr || strict.stdout}\n`);
  process.exit(2);
}

const actual = JSON.parse(String(strict.stdout || "").trim().split(/\n/).filter(Boolean).at(-1));
const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
const expectedIds = [...expected.expectedFailIds].sort();
const actualIds = [...actual.failIds].sort();
const missing = expectedIds.filter(id => !actualIds.includes(id));
const extra = actualIds.filter(id => !expectedIds.includes(id));
const ok = missing.length === 0 && extra.length === 0;
const report = {
  schemaVersion: "sde-baseline-audit-report-v1",
  mode: "baseline-audit",
  strictExitCode: strict.status,
  indexSha256: actual.indexSha256,
  expectedFailIds: expectedIds,
  actualFailIds: actualIds,
  missingExpectedFailIds: missing,
  extraFailIds: extra,
  status: ok ? "PASS" : "FAIL",
};
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(ok ? 0 : 1);

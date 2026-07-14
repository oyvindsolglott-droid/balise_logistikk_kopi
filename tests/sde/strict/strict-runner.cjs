"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const indexPath = path.resolve(process.argv[2] || path.join(root, "index.html"));
const drivers = [
  "cancel-invariants.cjs",
  "target-invariants.cjs",
  "relief-invariants.cjs",
];

function runDriver(driver) {
  const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, driver), indexPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${driver} crashed with exit ${result.status}:\n${result.stderr || result.stdout}`);
  }
  const line = String(result.stdout || "").trim().split(/\n/).filter(Boolean).at(-1);
  const parsed = JSON.parse(line || "{}");
  if (!Array.isArray(parsed.results)) throw new Error(`${driver} did not emit invariant results`);
  return parsed.results;
}

const html = fs.readFileSync(indexPath);
let results;
try {
  results = drivers.flatMap(runDriver).sort((left, right) => left.id.localeCompare(right.id));
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(2);
}

const failIds = results.filter(item => item.status === "FAIL").map(item => item.id);
const report = {
  schemaVersion: "sde-strict-report-v1",
  mode: "strict",
  indexPath,
  indexSha256: crypto.createHash("sha256").update(html).digest("hex"),
  counts: {
    total: results.length,
    pass: results.length - failIds.length,
    fail: failIds.length,
  },
  failIds,
  results,
};

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(failIds.length ? 1 : 0);

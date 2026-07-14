"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const commands = [
  {name: "strict", file: "strict-runner.cjs", expectedExitCode: 1},
  {name: "baseline-audit", file: "baseline-audit.cjs", expectedExitCode: 0},
];
const reports = [];

for (const command of commands) {
  const runs = Array.from({length: 3}, () => childProcess.spawnSync(process.execPath, [path.join(__dirname, command.file)], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  }));
  const exitCodes = runs.map(run => run.status);
  const outputs = runs.map(run => String(run.stdout || "").trim());
  const hashes = outputs.map(output => crypto.createHash("sha256").update(output).digest("hex"));
  const ok = runs.every(run => !run.error)
    && exitCodes.every(code => code === command.expectedExitCode)
    && new Set(hashes).size === 1;
  reports.push({name: command.name, status: ok ? "PASS" : "FAIL", expectedExitCode: command.expectedExitCode, exitCodes, normalizedOutputSha256: hashes});
}

const failed = reports.filter(item => item.status === "FAIL");
process.stdout.write(`${JSON.stringify({schemaVersion: "sde-determinism-audit-v1", reports})}\n`);
process.exit(failed.length ? 1 : 0);

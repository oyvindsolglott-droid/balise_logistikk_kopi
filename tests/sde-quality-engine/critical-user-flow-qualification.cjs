#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  evaluateCriticalUserFlow,
  validateCriticalUserFlowEvidence
} = require("./lib/critical-user-flow.cjs");

const ROOT = path.resolve(__dirname, "../..");
const REPORT_RELATIVE = "tests/sde-quality-engine/reports/critical-user-flow-black-box.json";
const LOG_RELATIVE = "tests/sde-quality-engine/reports/critical-user-flow-probe.log";

function run(command, args, options = {}) {
  const child = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    timeout: options.timeoutMs || 5 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: child.status,
    signal: child.signal,
    error: child.error ? String(child.error.message || child.error) : null,
    stdout: child.stdout || "",
    stderr: child.stderr || "",
    ok: child.status === 0 && !child.error
  };
}

function git(args, cwd = ROOT) {
  const observed = run("git", args, { cwd, timeoutMs: 60_000 });
  if (!observed.ok) throw new Error(`${observed.command}: ${observed.stderr || observed.error}`);
  return observed.stdout.trim();
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function resolvePython() {
  const candidates = [process.env.SDE_QE_PYTHON, "python3.11", "python3"].filter(Boolean);
  for (const candidate of candidates) {
    if (run(candidate, ["--version"], { timeoutMs: 10_000 }).ok) return candidate;
  }
  throw new Error("No Python runtime available for critical user flow qualification");
}

function parseProbe(stdout) {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("Critical user flow probe produced no JSON evidence");
  return JSON.parse(line);
}

function sourceHashes(root) {
  const files = [
    "tests/sde-quality-engine/contracts/sde-critical-user-flow-v1.schema.json",
    "tests/sde-quality-engine/fixtures/critical-user-flow-scenarios.json",
    "tests/sde-quality-engine/lib/critical-user-flow.cjs",
    "tests/sde-quality-engine/critical-user-flow/probe.py",
    "tests/sde-quality-engine/unit/critical-user-flow.test.cjs"
  ];
  return Object.fromEntries(files.map((file) => [file, sha256File(path.join(root, file))]));
}

function currentQualification(root = ROOT) {
  const python = resolvePython();
  const externalNodeModules = process.env.SDE_QE_SERVER_NODE_PATH ||
    path.join(ROOT, "server", "node_modules");
  const nodePath = [...new Set([
    path.join(root, "server", "node_modules"),
    externalNodeModules,
    ...String(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean)
  ])].join(path.delimiter);
  const unit = run("node", ["--test", "tests/sde-quality-engine/unit/critical-user-flow.test.cjs"], {
    cwd: root,
    env: { NODE_PATH: nodePath }
  });
  const asset = run("node", ["server/scripts/test-static-asset-delivery.js"], {
    cwd: root,
    env: { NODE_PATH: nodePath }
  });
  const probe = run(python, ["-B", "tests/sde-quality-engine/critical-user-flow/probe.py"], {
    cwd: root,
    env: { NODE_PATH: nodePath },
    timeoutMs: 3 * 60 * 1000
  });
  if (!probe.ok) {
    throw new Error(`Critical user flow probe failed (${probe.exitCode}): ${probe.stderr || probe.stdout}`);
  }
  const probeValue = parseProbe(probe.stdout);
  const schemaProblems = validateCriticalUserFlowEvidence(probeValue.evidence);
  if (schemaProblems.length) throw new Error(`Probe schema failed: ${schemaProblems.join("; ")}`);
  if (!asset.ok) {
    probeValue.evidence.observations.asset.downloadComplete = false;
  }
  const gateResults = evaluateCriticalUserFlow(probeValue.evidence);
  const log = [
    `PROBE_COMMAND=${probe.command}`,
    `PROBE_EXIT=${probe.exitCode}`,
    `UNIT_COMMAND=${unit.command}`,
    `UNIT_EXIT=${unit.exitCode}`,
    `ASSET_COMMAND=${asset.command}`,
    `ASSET_EXIT=${asset.exitCode}`,
    probe.stdout.trim()
  ].join("\n") + "\n";
  const logHash = sha256Buffer(log);
  for (const gate of gateResults) {
    for (const finding of gate.details?.findings || []) {
      finding.fullLogPath = LOG_RELATIVE;
      finding.fullLogSha256 = logHash;
    }
  }
  const candidateSha = process.env.SDE_QE_CANDIDATE_SHA || git(["rev-parse", "HEAD"], root);
  const candidateTree = process.env.SDE_QE_CANDIDATE_TREE || git(["rev-parse", "HEAD^{tree}"], root);
  const baseSha = process.env.SDE_QE_BASE_SHA || git(["rev-parse", "HEAD^"], root);
  const worktreeStatus = fs.existsSync(path.join(root, ".git"))
    ? git(["status", "--porcelain"], root)
    : "ARCHIVED_EXACT_TREE";
  const checks = {
    schema: schemaProblems.length === 0,
    negativeReplay: unit.ok,
    determinism: unit.ok,
    mutations: unit.ok,
    falseGreenFixtures: unit.ok,
    staticAssetDelivery: asset.ok,
    browserProbe: probe.ok,
    noProductionWrite: probeValue.productionWrites === 0,
    noUserData: probeValue.userDataUsed === false,
    skipsZero: probeValue.skips === 0,
    lazyLoad: probeValue.htrLazyAtBoot === true && probeValue.htrLazyAfterSelection === true,
    cleanWorktree: worktreeStatus === "" || worktreeStatus === "ARCHIVED_EXACT_TREE"
  };
  const report = {
    schemaVersion: "sde-critical-user-flow-black-box/v1",
    baseSha,
    candidateSha,
    candidateTree,
    worktree: root,
    worktreeStatus: worktreeStatus || "CLEAN",
    sourceHashes: sourceHashes(root),
    artifactHashes: { [LOG_RELATIVE]: logHash },
    checks,
    gateResults,
    commands: [unit.command, asset.command, probe.command],
    productionWrites: probeValue.productionWrites,
    userDataUsed: probeValue.userDataUsed,
    skips: probeValue.skips,
    evidence: probeValue.evidence
  };
  const aggregate = gateResults.find((item) => item.id === "CRITICAL-USER-FLOW-AGGREGATE");
  report.status = aggregate?.status === "GREEN" && Object.values(checks).every(Boolean)
    ? "GREEN"
    : "RED";
  const reportDirectory = path.join(root, "tests/sde-quality-engine/reports");
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, LOG_RELATIVE), log);
  fs.writeFileSync(path.join(root, REPORT_RELATIVE), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function disposableQualification() {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) throw new Error("Disposable qualification requires a clean committed candidate");
  const candidateSha = git(["rev-parse", "HEAD"]);
  const candidateTree = git(["rev-parse", "HEAD^{tree}"]);
  const baseSha = git(["rev-parse", "HEAD^"]);
  const diffCheck = run("git", ["diff", "--check", baseSha, candidateSha], { cwd: ROOT });
  if (!diffCheck.ok) throw new Error(`git diff --check failed: ${diffCheck.stdout}${diffCheck.stderr}`);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sde-critical-user-flow-"));
  const disposable = path.join(temporaryRoot, "candidate");
  const add = run("git", ["worktree", "add", "--detach", disposable, candidateSha], {
    cwd: ROOT,
    timeoutMs: 60_000
  });
  if (!add.ok) throw new Error(`Could not create disposable worktree: ${add.stderr}`);
  try {
    const child = run("node", ["tests/sde-quality-engine/critical-user-flow-qualification.cjs", "--child"], {
      cwd: disposable,
      env: {
        SDE_QE_BASE_SHA: baseSha,
        SDE_QE_CANDIDATE_SHA: candidateSha,
        SDE_QE_CANDIDATE_TREE: candidateTree,
        SDE_QE_SERVER_NODE_PATH: path.join(ROOT, "server", "node_modules")
      },
      timeoutMs: 4 * 60 * 1000
    });
    if (!child.ok) throw new Error(`Disposable child failed: ${child.stderr || child.stdout}`);
    const report = JSON.parse(child.stdout.trim().split("\n").filter(Boolean).at(-1));
    report.qualificationWorktree = "DISPOSABLE_DETACHED_WORKTREE";
    report.gitDiffCheck = "GREEN";
    const reportDirectory = path.join(ROOT, "tests/sde-quality-engine/reports");
    fs.mkdirSync(reportDirectory, { recursive: true });
    fs.writeFileSync(path.join(ROOT, REPORT_RELATIVE), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    run("git", ["worktree", "remove", "--force", disposable], { cwd: ROOT, timeoutMs: 60_000 });
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function printReport(report) {
  for (const gate of report.gateResults) {
    console.log(`${gate.id}: ${gate.status}`);
  }
  console.log(`BLACK_BOX_QUALIFICATION: ${report.status}`);
  console.log(`BASE_SHA: ${report.baseSha}`);
  console.log(`CANDIDATE_SHA: ${report.candidateSha}`);
  console.log(`CANDIDATE_TREE: ${report.candidateTree}`);
  console.log(`SKIPS: ${report.skips}`);
  console.log(`PRODUCTION_WRITES: ${report.productionWrites}`);
  console.log(JSON.stringify(report));
}

try {
  const report = process.argv.includes("--disposable")
    ? disposableQualification()
    : currentQualification();
  printReport(report);
  if (report.status !== "GREEN") process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

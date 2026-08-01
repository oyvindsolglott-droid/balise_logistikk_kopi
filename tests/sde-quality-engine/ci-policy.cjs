#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { evaluateCiPolicy, renderCiSummary } = require("./lib/ci-policy.cjs");

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const reportFile = path.resolve(option("--report", "tests/sde-quality-engine/reports/latest.json"));
const expectedCommit = option("--expected-commit");
const upstreamQualificationOutcome = option("--upstream-qualification", "success");
const runnerExitText = option("--runner-exit");
const runnerExitCode = /^\d+$/.test(String(runnerExitText || "")) ? Number(runnerExitText) : null;
let report = null;
let reportLoadError = null;

try {
  report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
} catch (error) {
  reportLoadError = error.message;
}

const decision = evaluateCiPolicy({
  report,
  expectedCommit,
  runnerExitCode,
  upstreamQualificationOutcome,
  reportLoadError
});
const reportDirectory = path.dirname(reportFile);
fs.mkdirSync(reportDirectory, { recursive: true });
const decisionJson = path.join(reportDirectory, "ci-policy.json");
const decisionMarkdown = path.join(reportDirectory, "ci-policy.md");
const markdown = renderCiSummary(decision, report);
fs.writeFileSync(decisionJson, `${JSON.stringify(decision, null, 2)}\n`);
fs.writeFileSync(decisionMarkdown, markdown);

if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `workflow_decision=${decision.workflowDecision}\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `workflow_conclusion=${decision.workflowConclusion}\n`);
}

process.stdout.write(markdown);
process.stdout.write(`Policy reports: ${decisionJson}, ${decisionMarkdown}\n`);
if (decision.workflowConclusion !== "SUCCESS") process.exitCode = 1;

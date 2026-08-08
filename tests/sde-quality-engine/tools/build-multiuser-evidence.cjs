#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildEvidenceManifest } = require("../lib/multiuser-evidence.cjs");

function option(argv, name, required = false) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : null;
  if (required && (!value || value.startsWith("--"))) throw new Error(`${name} må oppgis eksplisitt.`);
  return value;
}

function main(argv = process.argv.slice(2)) {
  const livePath = option(argv, "--live");
  const isolatedPath = option(argv, "--isolated");
  const outputPath = option(argv, "--output", true);
  const approvedSha = option(argv, "--approved-sha", true);
  const approvedTree = option(argv, "--approved-tree", true);
  const subjectRepository = option(argv, "--subject-repository", true);
  const runtimeSha = option(argv, "--runtime-sha") || approvedSha;
  if (!livePath && !isolatedPath) throw new Error("Minst ett av --live eller --isolated må oppgis.");
  const resolvedOutput = path.resolve(outputPath);
  if (fs.existsSync(resolvedOutput) && fs.lstatSync(resolvedOutput).isSymbolicLink()) {
    throw new Error("--output kan ikke være en symlink.");
  }
  const evidenceDirectory = path.dirname(resolvedOutput);
  for (const source of [livePath, isolatedPath].filter(Boolean)) {
    if (path.dirname(path.resolve(source)) !== evidenceDirectory) {
      throw new Error("Kildeartefakter og manifest må ligge direkte i samme evidensmappe.");
    }
  }
  if (livePath && isolatedPath && path.basename(livePath) === path.basename(isolatedPath)) {
    throw new Error("Live- og isolated-write-artefakter må ha ulike filnavn.");
  }
  const manifest = buildEvidenceManifest({
    livePath,
    isolatedPath,
    outputPath: resolvedOutput,
    approvedSha,
    approvedTree,
    subjectRepository,
    runtimeSha
  });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${resolvedOutput}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Evidence builder avviste input: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };

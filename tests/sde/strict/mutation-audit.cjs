"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const sourcePath = path.join(root, "index.html");
const source = fs.readFileSync(sourcePath, "utf8");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sde-firewall-mutations-"));

function replaceOnce(value, search, replacement, name) {
  const index = value.indexOf(search);
  if (index < 0) throw new Error(`${name}: mutation anchor not found`);
  return value.slice(0, index) + replacement + value.slice(index + search.length);
}

function strictReport(html, name) {
  const target = path.join(temporary, `${name}.html`);
  fs.writeFileSync(target, html);
  const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, "strict-runner.cjs"), target], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || ![0, 1].includes(run.status)) throw new Error(`${name} crashed: ${run.error || run.stderr || run.stdout}`);
  return JSON.parse(String(run.stdout).trim().split(/\n/).filter(Boolean).at(-1));
}

const mutations = [
  {
    id: "A-bypass-cancellation-modal",
    apply: html => replaceOnce(html, 'const learningReason = await getSdeMoveLearningReason("cancelled", {', 'const learningReason = getSdeNoMoveLearningReason("modal bypass"); /* mutation */ void ({', "modal bypass"),
    catches: ["INV-CANCEL-001"],
  },
  {
    id: "B-mutate-cancellation-state-before-save",
    apply: html => replaceOnce(
      html,
      'const learningReason = await getSdeMoveLearningReason("cancelled", {',
      'state.sdeMoveActions.__mutation_before_save={action:"cancelled"}; /* mutation */ const learningReason = await getSdeMoveLearningReason("cancelled", {',
      "before-save state",
    ),
    catches: ["INV-CANCEL-002"],
  },
  {
    id: "C-mutate-state-on-modal-cancel",
    apply: html => replaceOnce(
      html,
      "const cancel = () => finish(null);",
      'const cancel = () => { state.sdeMoveActions.__mutation_cancel={action:"cancelled"}; finish(null); };',
      "modal Cancel state",
    ),
    catches: ["INV-CANCEL-003"],
  },
  {
    id: "D-remove-learning-reason-and-comment",
    apply: html => replaceOnce(
      replaceOnce(html, "reasonCode:primaryReason.code,", 'reasonCode:"no_reason",', "learning reason"),
      "commentText,\n      reasonCatalogVersion:1",
      'commentText:"",\n      reasonCatalogVersion:1',
      "learning comment",
    ),
    catches: ["INV-CANCEL-004"],
  },
  {
    id: "E-remove-exiting-status",
    apply: html => replaceOnce(html, 'status:"dismissing",', 'status:"removed",', "exiting status"),
    catches: ["INV-CANCEL-005"],
  },
  {
    id: "F-remove-replacement-authority",
    apply: html => replaceOnce(
      html,
      "cancellationRecord.replacedByCardId = replacementKey;",
      'cancellationRecord.replacedByCardId = ""; /* mutation */',
      "replacement authority",
    ),
    catches: ["INV-CANCEL-006"],
  },
  {
    id: "G-change-5-plus-2",
    apply: html => replaceOnce(replaceOnce(html, "const SDE_RELEASE_CANCELLED_HOLD_MS = 5000;", "const SDE_RELEASE_CANCELLED_HOLD_MS = 4000;", "hold time"), "const SDE_RELEASE_CANCELLED_EXIT_MS = 2000;", "const SDE_RELEASE_CANCELLED_EXIT_MS = 1000;", "exit time"),
    catches: ["INV-CANCEL-007", "INV-CANCEL-008"],
  },
  {
    id: "H-reverse-card-order",
    apply: html => replaceOnce(html, "...(reader.cardProjection.actionableCards || []),\n    ...(reader.cardProjection.handlerBlockedCards || []),\n    ...(reader.cardProjection.blockedChainCards || []),\n    ...(reader.cardProjection.exitingCards || [])", "...(reader.cardProjection.actionableCards || []).reverse(),\n    ...(reader.cardProjection.handlerBlockedCards || []),\n    ...(reader.cardProjection.blockedChainCards || []),\n    ...(reader.cardProjection.exitingCards || []).reverse()", "card order"),
    catches: ["INV-CANCEL-010", "INV-CANCEL-011"],
  },
  {
    id: "I-keep-placeholder-after-removeAt",
    apply: html => {
      let changed = replaceOnce(html, "...(reader.cardProjection.actionableCards || []),\n    ...(reader.cardProjection.handlerBlockedCards || []),\n    ...(reader.cardProjection.blockedChainCards || []),\n    ...(reader.cardProjection.exitingCards || [])", "...(reader.cardProjection.exitingCards || []),\n    ...(reader.cardProjection.actionableCards || []),\n    ...(reader.cardProjection.handlerBlockedCards || []),\n    ...(reader.cardProjection.blockedChainCards || [])", "placeholder order");
      changed = replaceOnce(changed, 'if(cancelledUiState.hidden) return "";', 'if(cancelledUiState.hidden) return `<article data-sde-canonical-card-id="${card.canonicalCardId}" data-sde-placeholder="true"></article>`;', "placeholder");
      return replaceOnce(changed, "const cardsHtml = projectedCards.map((card,index)=>", "const cardsHtml = projectedCards.reverse().map((card,index)=>", "placeholder render order");
    },
    catches: ["INV-CANCEL-012", "INV-CANCEL-013"],
  },
  {
    id: "G-allow-occupied-target-card",
    apply: html => replaceOnce(html, "if(getSdeVehicleInSlot(mainTargetSlot)) return null;", "if(false && getSdeVehicleInSlot(mainTargetSlot)) return null;", "occupied target guard"),
    catches: ["INV-TARGET-004", "INV-TARGET-007", "INV-TARGET-008"],
  },
  {
    id: "H-rank-VN-before-local-south",
    apply: html => replaceOnce(
      replaceOnce(html, "Array.from(new Set([...(preferDedicatedVn ? [\"VN\"] : []),...ordinaryCandidates]))", "Array.from(new Set([...(preferDedicatedVn ? [\"VN\"] : []),...ordinaryCandidates])) /* explicit VN-first mutation */", "VN rank"),
      "if(!returnAccessOption) return null;",
      "if(false && !returnAccessOption) return null; /* mutation also bypasses mandatory local return validation */",
      "local return validation",
    ),
    catches: ["INV-RELIEF-001", "INV-RELIEF-002", "INV-RELIEF-003", "INV-RELIEF-007"],
  },
  {
    id: "I-remove-mandatory-recovery",
    apply: html => replaceOnce(html, "function buildSdeTemporaryAccessReturnRow(plan){\n  if(", "function buildSdeTemporaryAccessReturnRow(plan){\n  return null;\n  if(", "mandatory recovery"),
    catches: ["INV-RELIEF-009"],
  },
];

const reports = [];
try {
  for (const mutation of mutations) {
    const report = strictReport(mutation.apply(source), mutation.id);
    const caught = mutation.any
      ? mutation.catches.some(id => report.failIds.includes(id))
      : mutation.catches.every(id => report.failIds.includes(id));
    reports.push({id: mutation.id, status: caught ? "PASS" : "FAIL", expectedRedIds: mutation.catches, actualFailIds: report.failIds});
  }

  const expectedPath = path.join(__dirname, "baseline-expected-failures.json");
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const baselineVariants = [
    {name: "remove-one", ids: expected.expectedFailIds.slice(1)},
    {name: "add-false", ids: [...expected.expectedFailIds, "INV-FALSE-999"]},
  ];
  for (const variant of baselineVariants) {
    const target = path.join(temporary, `${variant.name}.json`);
    fs.writeFileSync(target, `${JSON.stringify({schemaVersion: expected.schemaVersion, expectedFailIds: variant.ids}, null, 2)}\n`);
    const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, "baseline-audit.cjs"), sourcePath, target], {cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024});
    reports.push({id: `baseline-${variant.name}`, status: run.status === 1 ? "PASS" : "FAIL", expectedExitCode: 1, actualExitCode: run.status});
  }
} finally {
  fs.rmSync(temporary, {recursive: true, force: true});
}

const failed = reports.filter(item => item.status === "FAIL");
process.stdout.write(`${JSON.stringify({schemaVersion: "sde-mutation-audit-v1", counts: {total: reports.length, pass: reports.length - failed.length, fail: failed.length}, reports})}\n`);
process.exit(failed.length ? 1 : 0);

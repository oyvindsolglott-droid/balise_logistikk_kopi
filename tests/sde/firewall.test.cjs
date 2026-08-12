"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {after, test} = require("node:test");

const root = path.resolve(__dirname, "../..");
const indexPath = path.join(root, "index.html");
const serverIndexPath = path.join(root, "server", "src", "index.js");
const harnessDirectory = path.join(__dirname, "harnesses");
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-regression-firewall-"));
const historicalRecovery = JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "historical-contract-recovery.json"),
  "utf8",
));
const currentHtml = fs.readFileSync(indexPath, "utf8");
const currentServerIndex = fs.readFileSync(serverIndexPath, "utf8");
const normativeGuide = fs.readFileSync(
  path.join(root, "assets", "sde-brukerveiledning-normativ-2026-07-30.txt"),
  "utf8",
);

after(() => fs.rmSync(fixtureDirectory, {recursive: true, force: true}));

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function failureDetails(result) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return output.length > 6000 ? output.slice(-6000) : output;
}

function assertPassed(result, label) {
  assert.equal(result.error, undefined, `${label} could not start: ${result.error?.message || "unknown error"}`);
  assert.equal(result.status, 0, `${label} failed:\n${failureDetails(result)}`);
}

function gitFile(commit, file) {
  const result = run("git", ["show", `${commit}:${file}`]);
  assertPassed(result, `git show ${commit}:${file}`);
  return result.stdout;
}

function materialize(commit, file) {
  const safeName = `${commit.slice(0, 12)}-${file.replaceAll("/", "-")}`;
  const target = path.join(fixtureDirectory, safeName);
  fs.writeFileSync(target, gitFile(commit, file));
  return target;
}

function runHarness(file, sourcePath = indexPath) {
  return run(process.execPath, [path.join(harnessDirectory, file), sourcePath]);
}

function resolveRecoveredHistoricalBaseline(recoveryId, {phase, name, harness}) {
  assert.equal(historicalRecovery?.schemaVersion, "sde-historical-contract-recovery-v1");
  const contract = historicalRecovery?.contracts?.[recoveryId];
  assert.ok(contract, `${phase} historical recovery ${recoveryId} is not registered`);
  assert.equal(contract.sourceHistoricalSha, "UNAVAILABLE_HISTORICAL_REFERENCE");
  assert.match(contract.unavailableHistoricalReference, /^[0-9a-f]{40}$/);
  assert.match(contract.baselineCommit, /^[0-9a-f]{40}$/);
  assert.match(contract.repairCommit, /^[0-9a-f]{40}$/);
  assert.equal(contract.historicalInput, "index.html");
  assert.equal(contract.harness, harness);
  assert.equal(contract.testName, `${phase} — ${name}`);
  assert.equal(contract.evidenceKind, "OLD_CODE");
  assert.ok(String(contract.regressionPurpose || "").trim());
  assert.ok(Array.isArray(contract.capturedSymbols) && contract.capturedSymbols.length > 0);
  assert.ok(String(contract.expectedHistoricalFailure || "").trim());

  const parent = run("git", ["rev-parse", `${contract.repairCommit}^`]);
  assertPassed(parent, `${phase} repair-commit parent`);
  assert.equal(
    parent.stdout.trim(),
    contract.baselineCommit,
    `${phase} recovered baseline must be the exact first parent of its repair commit`,
  );
  assertPassed(
    run("git", ["merge-base", "--is-ancestor", contract.repairCommit, "HEAD"]),
    `${phase} repair commit ancestry`,
  );
  const changed = run("git", ["diff", "--name-only", contract.baselineCommit, contract.repairCommit]);
  assertPassed(changed, `${phase} repair diff inventory`);
  const changedFiles = new Set(changed.stdout.trim().split(/\r?\n/).filter(Boolean));
  assert.ok(changedFiles.has("index.html"), `${phase} repair commit must change production index.html`);
  assert.ok(changedFiles.has("tests/sde/firewall.test.cjs"), `${phase} repair commit must register its contract`);
  assert.ok(changedFiles.has(`tests/sde/harnesses/${harness}`), `${phase} repair commit must add or update its harness`);

  const historicalSource = gitFile(contract.baselineCommit, contract.historicalInput);
  assert.equal(
    crypto.createHash("sha256").update(historicalSource).digest("hex"),
    contract.historicalInputSha256,
    `${phase} recovered historical input must remain byte-bound`,
  );
  return contract.baselineCommit;
}

let prerequisiteCancelReport = null;
function getPrerequisiteCancelReport() {
  if (prerequisiteCancelReport) return prerequisiteCancelReport;
  const result = runHarness("sde-prerequisite-cancel-replan-harness.js");
  assert.equal(result.error, undefined, `prerequisite-cancel harness could not start: ${result.error?.message || "unknown error"}`);
  assert.ok([0, 1].includes(result.status), `prerequisite-cancel harness crashed:\n${failureDetails(result)}`);
  prerequisiteCancelReport = JSON.parse(String(result.stdout || "").trim().split(/\n/).filter(Boolean).at(-1));
  assert.equal(prerequisiteCancelReport?.schemaVersion, "sde-prerequisite-cancel-replan-harness-v1");
  assert.equal(prerequisiteCancelReport?.counts?.total, 6);
  return prerequisiteCancelReport;
}

function registerHarnessTest({phase, name, harness, baseline, recoveryId}) {
  test(`${phase} — ${name}`, () => {
    assert.equal(Boolean(baseline) && Boolean(recoveryId), false, `${phase} cannot mix legacy and recovered historical inputs`);
    const historicalBaseline = recoveryId
      ? resolveRecoveredHistoricalBaseline(recoveryId, {phase, name, harness})
      : baseline;
    assert.ok(historicalBaseline, `${phase} historical baseline is required`);
    assertPassed(runHarness(harness), `${phase} current contract`);
    const oldResult = runHarness(harness, materialize(historicalBaseline, "index.html"));
    assert.notEqual(
      oldResult.status,
      0,
      `${phase} permanent test did not detect its historical production baseline ${historicalBaseline}`,
    );
  });
}

function countFunction(source, name) {
  return [...source.matchAll(new RegExp(`function\\s+${name}\\s*\\(`, "g"))].length;
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing function ${name}`);
  const signatureEnd = source.slice(start).match(/\)\s*\{/);
  assert.ok(signatureEnd, `missing body for ${name}`);
  const open = start + signatureEnd.index + signatureEnd[0].lastIndexOf("{");
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for(let index = open; index < source.length; index += 1){
    const character = source[index];
    const next = source[index + 1];
    if(lineComment){
      if(character === "\n") lineComment = false;
      continue;
    }
    if(blockComment){
      if(character === "*" && next === "/"){
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if(quote){
      if(escaped) escaped = false;
      else if(character === "\\") escaped = true;
      else if(character === quote) quote = "";
      continue;
    }
    if(character === "/" && next === "/"){
      lineComment = true;
      index += 1;
      continue;
    }
    if(character === "/" && next === "*"){
      blockComment = true;
      index += 1;
      continue;
    }
    if(character === "'" || character === '"' || character === "`"){
      quote = character;
      continue;
    }
    if(character === "{") depth += 1;
    if(character === "}"){
      depth -= 1;
      if(depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function assertPureReadModel(source, label) {
  for(const token of ["document.", "localStorage.", "sessionStorage.", "fetch(", "XMLHttpRequest", "setTimeout(", "setInterval(", "persist("]){
    assert.equal(source.includes(token), false, `${label} contains forbidden side effect token ${token}`);
  }
}

function assertHistoricalContractFailure(name, currentSource, baselineCommit, contract, file = "index.html") {
  contract(currentSource);
  assert.throws(
    () => contract(gitFile(baselineCommit, file)),
    undefined,
    `${name} did not reject historical baseline ${baselineCommit}`,
  );
}

registerHarnessTest({
  phase: "A",
  name: "canonical plan read-model remains deterministic and side-effect free",
  harness: "sde-canonical-plan-readmodel-a-harness.js",
  baseline: "c1bfe7632e9b1c058203334324a6f6b95bbaab8b",
});

registerHarnessTest({
  phase: "B",
  name: "obligationId and stepId remain stable across producers and permutations",
  harness: "sde-canonical-obligation-identitet-b-harness.js",
  baseline: "aad73b13fecee1421b8164f38bc1ce6a56f3f848",
});

registerHarnessTest({
  phase: "C",
  name: "shadow comparison stays opt-in, deterministic and read-only",
  harness: "sde-shadow-c-harness.js",
  baseline: "c1c463e4d98c2087312d771fc7f95db2ebe421b3",
});

registerHarnessTest({
  phase: "D",
  name: "card projection exposes only actionable canonical outcomes",
  harness: "sde-card-projection-d-harness.js",
  baseline: "9da9144e713f9e01009e1d05a2cfab64794e110a",
});

registerHarnessTest({
  phase: "E",
  name: "reservation projection prevents overlap and preserves sequential reuse",
  harness: "sde-reservation-projection-e-harness.js",
  baseline: "b077fd5c89dec335a2c7fcb551c28e5b35c1d8e3",
});

registerHarnessTest({
  phase: "F",
  name: "graphic projection separates actual occupancy from plan overlays",
  harness: "sde-graphic-projection-f-harness.js",
  baseline: "ddc0eddb989f7a1fedffb894fbda78ab105569e1",
});

test("DROPS hotfix — lifecycle UI is fail-closed and graphic actual state matches Sporplan", () => {
  assertPassed(
    runHarness("sde-drops-lifecycle-ui-sporplan-sync-hotfix-harness.js"),
    "DROPS lifecycle UI and Sporplan sync hotfix",
  );
});

test("VERKSTED hotfix — active faults and open repairs stay visible independently of vehicle status", () => {
  assertPassed(
    runHarness("sde-workshop-active-presentation-hotfix-harness.js"),
    "Verksted active-fault presentation hotfix",
  );
});

test("Guide Port E — Appendix A stays byte-exact and server-authorized without cross-level DOM/runtime leakage", () => {
  assertPassed(
    runHarness("sde-guide-normative-access-harness.js"),
    "Guide normative wording and capability isolation",
  );
});

test("Guide Port E — active-level search, accordions, keyboard and polling state remain stable and responsive", () => {
  assertPassed(
    runHarness("sde-guide-interaction-contract-harness.js"),
    "Guide interaction and responsive contract",
  );
});

test("DROPS operational rollout — registered scope and user-activated notification audio stay fail-closed", () => {
  assertPassed(
    runHarness("sde-drops-operational-rollout-harness.js"),
    "DROPS registered scope and notification audio",
  );
});

test("SPORPLAN exact background — byte-locked artwork and 31 dynamic slot anchors stay isolated from the menu button", () => {
  assertPassed(
    runHarness("sde-sporplan-exact-background-harness.js"),
    "Sporplan exact background and dynamic overlay contract",
  );
});

test("NIVÅ 4 — Stadler handlingssenter, verkstedkø, meldinger og Driftsklar-port er autoritative", () => {
  assertPassed(
    runHarness("sde-stadler-action-center-server-harness.js"),
    "Stadler action-center server contract",
  );
  assertPassed(
    runHarness("sde-stadler-action-center-ui-harness.js"),
    "Stadler action-center UI contract",
  );
});

test("GLOBAL instantmelding — alle 20 rolle-retninger er serverautoritative, målfiltrerte og idempotente", () => {
  assertPassed(
    runHarness("sde-global-operational-messaging-harness.js"),
    "global operational messaging contract",
  );
});

registerHarnessTest({
  phase:"SDE statusparitet",
  name:"Sporplan, Verksted og DROPS følger samme ferske statusmodell ved polling",
  harness:"sde-status-parity-polling-harness.js",
  baseline:"ec0fe9f6fadfda191c34221aa4bf627829f62b12",
});

registerHarnessTest({
  phase:"SDE direktemelding",
  name:"popup-svar og normal modul deler én stabil serverautoritativ tråd",
  harness:"sde-popup-reply-thread-surfacing-harness.js",
  baseline:"ec0fe9f6fadfda191c34221aa4bf627829f62b12",
});

test("NIVÅ 4 innkjøring — fysisk tomt spor kan ha nøyaktig én autoritativ kort-/reservasjonseier", () => {
  assertPassed(
    runHarness("sde-ingress-card-authority-harness.js"),
    "workshop ingress card authority",
  );
});

test("NIVÅ 5 Agilia — hovedrenholdsbestilling er rolleavgrenset, tidsvalidert og serverautoritativ", () => {
  assertPassed(
    runHarness("sde-agilia-cleaning-request-harness.js"),
    "Agilia cleaning track-space request",
  );
});

test("DROPS register-feil — alle 176 registrerte kjøretøy bruker scope, revisjon og ledig aktiv feilplass", () => {
  assertPassed(
    runHarness("sde-drops-register-fault-generalization-harness.js"),
    "DROPS registered-vehicle fault generalization",
  );
});

test("GLOBAL instantmelding — uendret polling og Oppdater bevarer textarea-node, fokus, markør og usendt tekst", () => {
  assertPassed(
    runHarness("sde-operational-message-focus-stability-harness.js"),
    "operational message focus stability",
  );
});

test("DROPS/SPORPLAN — bare eksplisitt Ikke Driftsklar er rød, og bare Dreies er synlig statusbadge", () => {
  assertPassed(
    runHarness("sde-default-status-sporplan-simplification-harness.js"),
    "default status and simplified Sporplan presentation",
  );
});

test("GLOBAL meldingstråd — én aktiv kronologisk tråd har nøyaktig ett stabilt svarfelt", () => {
  assertPassed(
    runHarness("sde-single-operational-thread-ui-harness.js"),
    "single operational message thread UI",
  );
});

test("SIKKERHETSINVARIANTER — målspor, default Driftsklar og rollefiltrert veiledning er sentralisert", () => {
  assertPassed(
    runHarness("sde-absolute-target-default-status-guide-harness.js"),
    "absolute target, default status and role guide contract",
  );
});

test("EIERIDENTITET — seks eksplisitte roller gir ingen override og popupen følger hele målnivået", () => {
  assertPassed(
    runHarness("sde-owner-global-popup-harness.js"),
    "owner identity and global level popup",
  );
});

test("VERKSTED innkjøring — status er irrelevant og fysisk utfall klassifiseres fail-closed", () => {
  assertPassed(
    runHarness("sde-status-independent-ingress-harness.js"),
    "status-independent workshop ingress",
  );
});

test("GLOBAL direktemelding — eksplisitt serverkvittering er idempotent og dypkoblingen er allowlistet", () => {
  assertPassed(
    runHarness("sde-operational-message-acknowledgement-harness.js"),
    "operational message acknowledgement",
  );
});

test("NIVÅ 4/TURSATT/STATUS — enkeltkontekst, kollaps og felles presentasjon er permanente kontrakter", () => {
  assertPassed(
    runHarness("sde-single-context-collapse-status-harness.js"),
    "single context, diagnostics collapse and unified status",
  );
});

test("SDE common card pipeline — workshop exit and manual drag keep cards, reservations and unresolved follow-up consistent", () => {
  assertPassed(
    runHarness("sde-unified-card-pipeline-workshop-drag-harness.js"),
    "SDE unified workshop/drag card pipeline",
  );
});

test("G — end-to-end integrity gate is complete and side-effect free", () => {
  const contract = source => {
    assert.equal(countFunction(source, "buildSdeCanonicalIntegrityReport"), 1);
    assert.equal(countFunction(source, "buildSdeCanonicalLegacyMigrationReadiness"), 1);
    const integrity = extractFunction(source, "buildSdeCanonicalIntegrityReport");
    for(const token of ["invariantResults", "obligationResults", "chainResults", "conflicts", "metadata"]){
      assert.ok(integrity.includes(token), `integrity report misses ${token}`);
    }
    assertPureReadModel(integrity, "integrity report");
    const shadowReport = extractFunction(source, "buildSdeCanonicalShadowReport");
    assert.ok(shadowReport.includes("integrityReport"));
    assert.ok(shadowReport.includes("legacyMigrationReadiness"));
  };
  assertHistoricalContractFailure(
    "G integrity gate",
    currentHtml,
    "bc7688bf25019de76df7513050f6c400f9b18173",
    contract,
  );
});

test("H — card preview stays explicit, fail-closed and non-interactive", () => {
  const contract = source => {
    for(const name of [
      "isSdeCanonicalCardPreviewRequested",
      "buildSdeCanonicalCardPreviewModel",
      "buildSdeCanonicalCardPreviewHtml",
      "renderSdeCanonicalCardPreview",
    ]) assert.equal(countFunction(source, name), 1, `${name} must exist exactly once`);
    assert.ok(extractFunction(source, "isSdeCanonicalCardPreviewRequested").includes("sdeCanonicalCardPreview"));
    const previewHtml = extractFunction(source, "buildSdeCanonicalCardPreviewHtml");
    assert.doesNotMatch(previewHtml, /<button\b|<input\b|<form\b|onclick\s*=|draggable\s*=/i);
    const previewModel = extractFunction(source, "buildSdeCanonicalCardPreviewModel");
    assert.ok(previewModel.includes("gateOpen"));
    assert.ok(previewModel.includes("integrityStatus"));
    assertPureReadModel(previewModel, "preview model");
  };
  assertHistoricalContractFailure(
    "H card preview",
    currentHtml,
    "32d69d65938c532b09260ef627749dceccdb944d",
    contract,
  );
});

test("Production UI — shows ordered cards, exposes actions only when executable, and has no retarget menu", () => {
  const contract = source => {
    const visibleCards = extractFunction(source, "getSdeCanonicalProductionVisibleCards");
    assert.ok(visibleCards.includes("reader.cardProjection.actionableCards"));
    assert.ok(visibleCards.includes("reader.cardProjection.blockedChainCards"));
    assert.ok(visibleCards.includes("reader.cardProjection.exitingCards"));
    assert.ok(visibleCards.includes("adapter?.ready === true"));
    assert.ok(visibleCards.includes("adapter.canComplete === true || adapter.canCancel === true"));
    for(const forbidden of ["handlerBlockedCards"]){
      assert.equal(visibleCards.includes(forbidden), false, `production visible cards include ${forbidden}`);
    }

    const controls = extractFunction(source, "buildSdeCanonicalCardActionControlsHtml");
    assert.ok(controls.includes('card.status !== "actionable" || adapter?.ready !== true'));
    for(const forbidden of ["Velg annet spor", "Avslå VN og velg annet spor", "data-sde-canonical-retarget-action", "beginSdeCanonicalRetarget"]){
      assert.equal(controls.includes(forbidden), false, `production card controls expose ${forbidden}`);
    }

    const render = extractFunction(source, "renderSdeCanonicalProductionReader");
    assert.ok(render.includes("const projectedCards = getSdeCanonicalProductionVisibleCards(reader);"));

    const graphic = extractFunction(source, "renderSdeNightPlacementOverview");
    for(const forbidden of ["sdeCanonicalRetargetSelection", "retargetPair", "retargetHtml", "data-sde-canonical-retarget"]){
      assert.equal(graphic.includes(forbidden), false, `production graphic view exposes ${forbidden}`);
    }
  };
  assertHistoricalContractFailure(
    "production executable-only UI",
    currentHtml,
    "a9a68b4a4eb20fbef9b556d839a73dd0b3aacef4",
    contract,
  );
});

test("Cancellation UI — cancelled card stays red, crumbles, and yields its place to the replacement", () => {
  const contract = source => {
    const visibleCards = extractFunction(source, "getSdeCanonicalProductionVisibleCards");
    assert.ok(visibleCards.includes("reader.cardProjection.exitingCards"));
    const cardHtml = extractFunction(source, "buildSdeCanonicalProductionCardHtml");
    assert.ok(cardHtml.includes("getSdePhysicalReleaseCancelledUiState"));
    assert.ok(cardHtml.includes("buildSdePhysicalReleaseCancelledCardUi"));
    assert.ok(cardHtml.includes('if(cancelledUiState.hidden) return "";'));
    const render = extractFunction(source, "renderSdeCanonicalProductionReader");
    assert.ok(render.includes("scheduleSdePhysicalReleaseCardDismissals(root)"));
    assert.ok(source.includes("@keyframes sdeReleaseCardCrumble"));
  };
  assertHistoricalContractFailure(
    "cancelled card crumble lifecycle visibility",
    currentHtml,
    "34d66488bf597252610d327ba240e52a3d066fcc",
    contract,
  );
});

test("Ordered chain UI — every booked step has a card while future steps have no action controls", () => {
  const contract = source => {
    const visibleCards = extractFunction(source, "getSdeCanonicalProductionVisibleCards");
    assert.ok(visibleCards.includes("reader.cardProjection.blockedChainCards"));
    assert.equal(visibleCards.includes("reader.cardProjection.handlerBlockedCards"), false);
    const controls = extractFunction(source, "buildSdeCanonicalCardActionControlsHtml");
    assert.ok(controls.includes('card.status !== "actionable" || adapter?.ready !== true'));
    assert.equal(controls.includes("blocked_chain_step"), false);
    const cardHtml = extractFunction(source, "buildSdeCanonicalProductionCardHtml");
    assert.ok(cardHtml.includes("Fremtidig kjedesteg"));
    assert.ok(cardHtml.includes("blockedBy"));
  };
  assertHistoricalContractFailure(
    "booked chain card visibility without blocked actions",
    currentHtml,
    "34d66488bf597252610d327ba240e52a3d066fcc",
    contract,
  );
});

registerHarnessTest({
  phase: "Route availability",
  name: "one free egress keeps offered completion and every free manual target available",
  harness: "sde-partial-egress-route-availability-harness.js",
  baseline: "7516f82b6320266a735df4eb1d661a40ba61762c",
});

registerHarnessTest({
  phase: "Chain route continuity",
  name: "a prerequisite holding slot cannot block the following ordered move",
  harness: "sde-chain-route-continuity-harness.js",
  recoveryId: "chain-route-continuity",
});

registerHarnessTest({
  phase: "Completed-chain lifecycle",
  name: "a completed historical chain cannot poison a fresh order from current actual-state",
  harness: "sde-completed-chain-new-order-harness.js",
  recoveryId: "completed-chain-lifecycle",
});

registerHarnessTest({
  phase: "Fresh graphical order identity",
  name: "a unique browser drag cannot bind to an older row only by vehicle and source",
  harness: "sde-fresh-graphic-order-base-row-harness.js",
  recoveryId: "fresh-graphical-order-identity",
});

registerHarnessTest({
  phase: "Completed-chain manual return",
  name: "a valid local return remains quittable when canonical authority uses a separate outcome id",
  harness: "sde-completed-chain-manual-return-harness.js",
  recoveryId: "completed-chain-manual-return",
});

registerHarnessTest({
  phase: "Mid-chain restaging",
  name: "a completed release validates the remaining main and return suffix without creating a false error",
  harness: "sde-mid-chain-restage-harness.js",
  baseline: "c90d3dd584bd342a1860b9acd697024d2da0919a",
});

registerHarnessTest({
  phase: "Direct wash transit",
  name: "4N to 10S uses the free wash corridor as one move instead of a trapped-egress chain",
  harness: "sde-direct-wash-transit-route-harness.js",
  recoveryId: "direct-wash-transit",
});

test("I/L audits and executable R/X/Y/Z coverage cannot disappear silently", () => {
  const coverage = JSON.parse(fs.readFileSync(path.join(__dirname, "phase-coverage.json"), "utf8"));
  assert.deepEqual(Object.keys(coverage), "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
  assert.equal(coverage.I.status, "audit-only");
  assert.equal(coverage.L.status, "audit-only");
  assert.equal(coverage.R.status, "implemented");
  assert.deepEqual(coverage.R.invariants, ["INV-CANCEL-010", "INV-CANCEL-011", "INV-CANCEL-012", "INV-CANCEL-013"]);
  assert.equal(coverage.X.status, "implemented");
  assert.deepEqual(coverage.X.invariants, ["INV-REROUTE-001", "INV-REROUTE-002", "INV-REROUTE-003", "INV-REROUTE-004", "INV-REROUTE-005", "INV-REROUTE-006", "INV-REROUTE-007", "INV-REROUTE-008"]);
  assert.equal(coverage.Y.status, "implemented");
  assert.deepEqual(coverage.Y.invariants, ["INV-EGRESS-001", "INV-EGRESS-002", "INV-EGRESS-003", "INV-EGRESS-004", "INV-EGRESS-005", "INV-EGRESS-006", "INV-EGRESS-007", "INV-EGRESS-008", "INV-EGRESS-009", "INV-EGRESS-010", "INV-EGRESS-011", "INV-EGRESS-012", "INV-EGRESS-013", "INV-EGRESS-014", "INV-EGRESS-015"]);
  assert.equal(coverage.Z.status, "implemented");
  assert.deepEqual(coverage.Z.invariants, ["INV-EGRESS-016", "INV-EGRESS-017", "INV-EGRESS-018", "INV-EGRESS-019", "INV-EGRESS-020", "INV-EGRESS-021"]);
  for(const phase of Object.keys(coverage).filter(letter => !["I", "L"].includes(letter))){
    assert.equal(coverage[phase].status, "implemented", `${phase} must remain implemented`);
  }
});

test("J — partial actual-state reconciliation supplements only trustworthy sources", () => {
  const contract = source => {
    assert.equal(countFunction(source, "buildSdeCanonicalActualStateReconciliation"), 1);
    const reconciliation = extractFunction(source, "buildSdeCanonicalActualStateReconciliation");
    for(const token of ["sharedDraftRows", "computedActualRows", "actualPlacements", "diagnostics", "conflicts"]){
      assert.ok(reconciliation.includes(token), `actual-state reconciliation misses ${token}`);
    }
    assertPureReadModel(reconciliation, "actual-state reconciliation");
    assert.ok(source.includes("canonical-actual-reconciled"));
    assert.ok(source.includes("stale_or_inconsistent_override"));
    assert.ok(source.includes("candidate_source_not_canonical"));
  };
  assertHistoricalContractFailure(
    "J actual-state reconciliation",
    currentHtml,
    "e4217b5dddcd659436cdb0759dfb07361b46c8ce",
    contract,
  );
});

registerHarnessTest({
  phase: "K",
  name: "pendulum source uses the time-bound train movement and maps platform 2/3 to S",
  harness: "sde-canonical-pendel-slot-mapping-k-harness.js",
  baseline: "3495bcfffb38012a94bcfd315b211650884a278e",
});

test("Y — complete trapped-egress chains and unresolved-step retarget stay atomic", () => {
  const result = runHarness("sde-trapped-egress-chain-harness.js");
  assert.equal(result.error,undefined,`Y trapped-egress harness could not start: ${result.error?.message||"unknown error"}`);
  assert.ok([0,1].includes(result.status),`Y trapped-egress harness crashed:\n${failureDetails(result)}`);
  const report = JSON.parse(String(result.stdout || "").trim().split(/\n/).filter(Boolean).at(-1));
  assert.equal(report?.schemaVersion, "sde-trapped-egress-harness-v1");
  assert.equal(report?.counts?.total,16);
  assert.deepEqual(report?.results?.map(item=>item.id), [
    ...Array.from({length:15},(_,index)=>`INV-EGRESS-${String(index+1).padStart(3,"0")}`),
    "INV-EGRESS-022"
  ]);
  assert.equal(report?.results?.slice(0,12).every(item=>item.status==="PASS"),true,"the pre-existing 12 Y invariants must remain green");
  for(const fixture of "ABCDEFGHIJKL") assert.ok(report?.scenarios?.[fixture] || ["H","I","J","K"].includes(fixture), `missing fixture ${fixture}`);
  assert.ok(report?.scenarios?.P,"missing stale-release identity fixture P");
});

test("BLOCKED-SLOT — passive six-slot TO/FROM sweep is complete-plan-or-diagnostic-only", () => {
  const result = runHarness("sde-passive-blocked-slot-sweep-harness.js");
  assertPassed(result, "blocked-slot passive sweep harness");
  const report = JSON.parse(String(result.stdout || "").trim().split(/\n/).filter(Boolean).at(-1));
  assert.equal(report?.schemaVersion, "sde-passive-blocked-slot-sweep-harness-v1");
  assert.equal(report?.reproduction, "PROTECTED");
  assert.deepEqual(report?.counts, {total: 9, pass: 9, fail: 0});
  assert.equal(report?.matrix?.total, 18);
  assert.equal(report?.matrix?.pass, 18);
  assert.equal(report?.matrix?.fail, 0);
  assert.equal(report?.browser?.total, 36);
  assert.equal(report?.browser?.pass, 36);
  assert.equal(report?.browser?.fail, 0);
  assert.deepEqual(
    [...new Set(report.matrix.scenarios.map(item => item.slot))].sort(),
    ["10S", "11S", "12S", "4M", "5M", "6S"],
  );
  assert.deepEqual(
    [...new Set(report.matrix.scenarios.map(item => item.direction))].sort(),
    ["FROM", "TO"],
  );
});

for(const [id,name] of [
  ["INV-EGRESS-013","recursive graphical drag selects the complete physical-chain staging path"],
  ["INV-EGRESS-014","completed prerequisite preserves a fully projected actionable mid-chain suffix"],
  ["INV-EGRESS-015","responsive reduced-motion detection tolerates a null MediaQueryList"],
  ["INV-EGRESS-022","stale cancelled release identity is replaced before graphical staging"],
]) test(`${id} — ${name}`,()=>{
  const result=runHarness("sde-trapped-egress-chain-harness.js");
  assert.equal(result.error,undefined,`${id} harness could not start: ${result.error?.message||"unknown error"}`);
  assert.ok([0,1].includes(result.status),`${id} harness crashed:\n${failureDetails(result)}`);
  const report=JSON.parse(String(result.stdout||"").trim().split(/\n/).filter(Boolean).at(-1));
  const invariant=report?.results?.find(item=>item.id===id);
  assert.equal(invariant?.status,"PASS",invariant?.detail||`${id} missing`);
});

for (const contractName of [
  "PREREQUISITE-CANCEL-REPLANS-CHAIN",
  "PREREQUISITE-CANCEL-ALTERNATE-MAIN-TARGET",
  "PREREQUISITE-CANCEL-NO-SOLUTION-IS-SCOPED",
  "POST-CANCEL-GRAPHICAL-DRAG-CONTINUITY",
]) {
  test(`CONTRACT ${contractName}`, () => {
    const report = getPrerequisiteCancelReport();
    assert.equal(report?.scenarios?.contracts?.[contractName], true, `${contractName} failed in the production-code harness`);
  });
}

registerHarnessTest({
  phase: "M1",
  name: "runtime preserves occurrence-bound Balise platform context",
  harness: "sde_m_js_tests.js",
  baseline: "50bb0dbeb5120758956211795dcc1a77cdb3667e",
});

registerHarnessTest({
  phase: "TURSATT-80818",
  name: "validated departures with unresolved occurrence material remain visible",
  harness: "sde-tursatt-unresolved-row-harness.js",
  baseline: "ecba507a6ec033fee9f3af4160e60bc23e07c1c3",
});

test("TURSATT-80824-PORSGRUNN — same occurrence at Porsgrunn determines actual departure consist from Skien", () => {
  const harness = "sde-tursatt-porsgrunn-consist-harness.js";
  const baseline = "8b7f729773e7d3c939bd83f9e6e00ec7fd97679b";
  assertPassed(
    runHarness(harness, path.join(root, "update_static_data.py")),
    "TURSATT-80824-PORSGRUNN current contract",
  );
  const oldResult = runHarness(harness, materialize(baseline, "update_static_data.py"));
  assert.notEqual(
    oldResult.status,
    0,
    `TURSATT-80824-PORSGRUNN permanent test did not detect its historical production baseline ${baseline}`,
  );
});

test("TURSATT-810 — exact Skien departure occurrence resolves ordered material without cross-binding", () => {
  const result = runHarness("sde-tursatt-810-occurrence-harness.js");
  assertPassed(result, "TURSATT-810 occurrence harness");
  const report = JSON.parse(String(result.stdout || "").trim().split(/\n/).filter(Boolean).at(-1));
  assert.equal(report?.schemaVersion, "sde-tursatt-dynamic-occurrence-harness-v2");
  assert.deepEqual(report?.counts, {total:14,pass:14,fail:0});
  assert.deepEqual(report?.historical?.vehicles, ["74-14","74-38"]);
  assert.equal(report?.historical?.plannedDeparture, "08:09");
  assert.equal(report?.historical?.actualDeparture, "08:20");
  assert.deepEqual(report?.otherDate?.vehicles, ["74-21","74-22"]);
});

test("M2 — generator propagates actual platform provenance without vehicle hardcoding", () => {
  const contract = source => {
    for(const name of [
      "normalize_balise_platform_track",
      "extract_balise_route_info",
      "fetch_balise_route_stops",
      "build_skien_movement_context",
    ]) assert.match(source, new RegExp(`def ${name}\\(`), `missing ${name}`);
    for(const token of ["movementContext", "stop_track", "platformTrack", "occurrenceId", "trackProvenance", "vehicleIds", "consistContext"]){
      assert.ok(source.includes(token), `generator propagation misses ${token}`);
    }
    assert.equal(source.includes("74-39"), false, "generator must not hardcode the pendulum vehicle");
  };
  const currentGenerator = fs.readFileSync(path.join(root, "update_static_data.py"), "utf8");
  assertHistoricalContractFailure(
    "M generator propagation",
    currentGenerator,
    "50bb0dbeb5120758956211795dcc1a77cdb3667e",
    contract,
    "update_static_data.py",
  );
  assertPassed(
    run("python3", ["-m", "unittest", "tests/sde/test_balise_actual_platform.py"]),
    "M Python generator tests",
  );
});

test("N — post-arrival schedule retains guarded 21:xx refresh attempts", () => {
  const contract = source => {
    const expectedSchedules = [
      "17 * * * *",
      "7 4,7,15,21 * * *",
      "22 4,7,15,21 * * *",
      "37 4,7,15,21 * * *",
      "52 4,7,15,21 * * *",
    ];
    const oldSchedules = [
      "17 * * * *",
      "7,22,37,52 4,7,15,21 * * *",
    ];
    const scheduleExpressions = [...source.matchAll(/-\s+cron:\s*["']([^"']+)["']/g)]
      .map(match => match[1]);

    const expandLeapYear = expressions => {
      const slots = [];
      for(let day = new Date(Date.UTC(2024, 0, 1)); day.getUTCFullYear() === 2024; day.setUTCDate(day.getUTCDate() + 1)){
        const date = day.toISOString().slice(0, 10);
        for(const expression of expressions){
          const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = expression.split(" ");
          assert.deepEqual([dayOfMonth, month, dayOfWeek], ["*", "*", "*"], `unsupported calendar fields in ${expression}`);
          const minutes = minuteField.split(",").map(Number);
          const hours = hourField === "*"
            ? Array.from({length: 24}, (_, hour) => hour)
            : hourField.split(",").map(Number);
          for(const hour of hours){
            for(const minute of minutes){
              slots.push(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
            }
          }
        }
      }
      return slots;
    };

    assert.deepEqual(scheduleExpressions, expectedSchedules, "workflow schedule must contain only the control expression and four split critical expressions");
    assert.equal(new Set(scheduleExpressions).size, expectedSchedules.length, "workflow schedule expressions must be unique");
    assert.equal(source.includes('cron: "7,22,37,52 4,7,15,21 * * *"'), false, "obsolete grouped critical expression must be absent");

    const oldFullSlots = expandLeapYear(oldSchedules);
    const newFullSlots = expandLeapYear(scheduleExpressions);
    assert.equal(oldFullSlots.length, 14640, "historical full workflow must define 14,640 Oslo wall-clock events in leap year 2024");
    assert.equal(newFullSlots.length, 14640, "split full workflow must define 14,640 Oslo wall-clock events in leap year 2024");
    assert.deepEqual(new Set(newFullSlots), new Set(oldFullSlots), "control plus critical schedule must retain exact calendar coverage");
    assert.equal(new Set(newFullSlots).size, newFullSlots.length, "full workflow schedule must contain no duplicate wall-clock events");

    const oldCriticalSlots = expandLeapYear(oldSchedules.slice(1));
    const newCriticalSlots = expandLeapYear(scheduleExpressions.slice(1));
    assert.equal(oldCriticalSlots.length, 5856, "historical critical schedule must define 5,856 Oslo wall-clock events in leap year 2024");
    assert.equal(newCriticalSlots.length, 5856, "split critical schedule must define 5,856 Oslo wall-clock events in leap year 2024");
    assert.deepEqual(new Set(newCriticalSlots), new Set(oldCriticalSlots), "split critical expressions must retain exact month, leap-day and DST-boundary calendar coverage");
    for(const transitionDate of ["2024-02-29", "2024-03-31", "2024-10-27", "2024-12-31"]){
      assert.ok(newCriticalSlots.some(slot => slot.startsWith(transitionDate)), `critical schedule misses calendar boundary ${transitionDate}`);
    }

    assert.match(source, /on:\s*\n\s+workflow_dispatch:\s*\n\s+schedule:/);
    assert.match(source, /\{"04",\s*"07",\s*"15",\s*"21"\}/);
    assert.equal((source.match(/timezone:\s*["']Europe\/Oslo["']/g) || []).length, 5, "every schedule expression must retain explicit Europe/Oslo semantics");
    assert.match(source, /concurrency:\s*\n\s+group:\s*update-static-balise-data\s*\n\s+cancel-in-progress:\s*false/);
    assert.equal(
      source.match(/^permissions:\n((?:  [^\n]+\n)+)/m)?.[1],
      "  contents: write\n  actions: read\n",
      "workflow permissions must remain limited to existing contents-write and actions-read authority",
    );
    assert.equal((source.match(/run:\s*python update_static_data\.py/g) || []).length, 1, "generator invocation must remain singular and unchanged");
    assert.match(source, /git add data\/api_idag\.json data\/api_imorgen\.json data\/sde-data-provenance\.json/);
    assert.match(source, /git diff --cached --quiet/);
    assert.match(source, /git rebase ["']origin\/\$branch["']/);
    assert.equal((source.match(/name:\s*sde-data-release-attestation-\$\{\{ steps\.data-push\.outputs\.commit \}\}/g) || []).length, 1);
    assert.equal((source.match(/name:\s*sde-schedule-observability-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g) || []).length, 1);
    assert.match(source, /name:\s*Upload schedule observability record\s*\n\s+if:\s*always\(\)\s*\n\s+uses:\s*actions\/upload-artifact@v4/);
    assert.match(source, /if event_name == "workflow_dispatch":\s*\n\s+trigger_class = "MANUAL"/);
    assert.match(source, /"naturalScheduleCandidate": False/);
    assert.match(source, /"rerun": None if attempt is None else attempt > 1/);
  };
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/update-static-data.yml"), "utf8");
  assertHistoricalContractFailure(
    "N post-arrival workflow",
    workflow,
    "d774883a7a4a2765cfa225f464d7d86b8c6f334f",
    contract,
    ".github/workflows/update-static-data.yml",
  );
});

registerHarnessTest({
  phase: "O",
  name: "canonical reader is default with explicit and automatic legacy fallback",
  harness: "sde-canonical-production-reader-switch-o-harness.js",
  baseline: "f646736a308703965086b46ab59a419e2f43d1b6",
});

registerHarnessTest({
  phase: "P",
  name: "production UI keeps score, diagnostics and actual graphics consistent",
  harness: "sde-canonical-production-ui-closure-p-harness.js",
  baseline: "52a38ae7368c85ecd0d00c306df10a6dfa98f022",
});

registerHarnessTest({
  phase: "Q",
  name: "replacement cards retain one unambiguous existing handler adapter",
  harness: "sde-canonical-replacement-handler-adapter-q-harness.js",
  baseline: "67b45e4575acfb12831591d34eedffbee2840e46",
});

registerHarnessTest({
  phase: "S1",
  name: "graphic drag creates one complete canonical order and preserves independent plans",
  harness: "sde-canonical-graphic-drag-order-s-harness.js",
  baseline: "ee0a2ae8c267f50c1e1d54b1bd8b9395fe848d9e",
});

registerHarnessTest({
  phase: "S2",
  name: "native pointer and HTML5 drop receivers forward the same drag request",
  harness: "sde-canonical-graphic-drag-order-s-dom-harness.js",
  baseline: "ee0a2ae8c267f50c1e1d54b1bd8b9395fe848d9e",
});

registerHarnessTest({
  phase: "T",
  name: "butt-track release produces a complete three-step VN chain with recovery",
  harness: "sde-canonical-buttspor-vn-chain-t-harness.js",
  baseline: "205c96b23a55eebeb569b66c6039b0a769d95563",
});

test("U — all three live VN outcomes survive every projection and integrity check", () => {
  const contract = source => {
    assert.match(source, /candidates\s*\.filter\(candidate=>candidate\.activeEligible\)\s*\.map\(candidate=>candidate\.activeAuthorityId\)/);
    const integrity = extractFunction(source, "buildSdeCanonicalIntegrityReport");
    assert.ok(integrity.includes("CHAIN_INCONSISTENT_DECLARED_STEP_COUNT"));
    assert.ok(integrity.includes("CHAIN_INCOMPLETE_DECLARED_SEQUENCE"));
  };
  assertHistoricalContractFailure(
    "U complete VN projection",
    currentHtml,
    "4863f2499f17b229af73915dee353c84208ce21d",
    contract,
  );
  assertPassed(
    runHarness("sde-canonical-buttspor-vn-chain-t-harness.js"),
    "U three-step projection harness",
  );
});

registerHarnessTest({
  phase: "V",
  name: "multiple plans, execution revalidation and temporary access relief remain isolated",
  harness: "sde-canonical-operative-planlifecycle-v-harness.js",
  baseline: "854a5caafad032fea1e4d2b836bc492c0f513b69",
});

registerHarnessTest({
  phase: "W",
  name: "execution remains stable across rerenders and valid 4M relief prefers VN",
  harness: "sde-canonical-stable-execution-vn-preference-w-harness.js",
  baseline: "6711cb06cea777234fc6e5179550b0525ddb0599",
});

registerHarnessTest({
  phase: "X",
  name: "trapped middle vehicles automatically produce one ordered VN release, main and recovery chain",
  harness: "sde-automatic-trapped-readiness-harness.js",
  baseline: "a8609c965967e8bc5c7bb5e43d2f0109f923c7eb",
});

registerHarnessTest({
  phase: "X2",
  name: "completed history cannot reject a new inbound order through a newly opened north end",
  harness: "sde-inbound-trapped-target-history-harness.js",
  recoveryId: "inbound-trapped-target-history",
});

registerHarnessTest({
  phase: "X3",
  name: "no tursatt assignments cannot resurrect automatic physical-chain cards",
  harness: "sde-no-tursatt-no-automatic-cards-harness.js",
  baseline: "b3521243b0e3fb5d680c1e41d2d34c63445f4331",
});

registerHarnessTest({
  phase: "DROPS-UI-2A",
  name: "level-one vehicle registry uses compact selectors and one five-row standard sheet",
  harness: "sde-drops-vehicle-registry-dom-harness.js",
  baseline: "8ae6a3c4717be55a711fc21ff75f63ab47fc9a98",
});

registerHarnessTest({
  phase: "DROPS-1E",
  name: "not-operational submission stays server-authoritative through confirmed GET readback",
  harness: "sde-drops-ui-server-readback-harness.js",
  baseline: "c51d588ffeabca933a2646fa52d001de02e6eb7d",
});

registerHarnessTest({
  phase: "DROPS-74-04",
  name: "visible polling preserves the active five-row draft, DOM identity, focus and caret",
  harness: "sde-drops-focus-stability-harness.js",
  baseline: "700648df6219a61cb7b750dfde31e9f2e49c1ed2",
});

test("DROPS-VERKSTED-2B — full authoritative vehicle lifecycle remains atomic and role-bound", () => {
  assertPassed(
    run(process.execPath, [
      path.join(root, "server", "scripts", "test-vehicle-status-lifecycle-v2.js"),
    ]),
    "DROPS-VERKSTED-2B server lifecycle contract",
  );
});

test("DROPS-PROCESS — repair independence, immutable process events and privacy remain enforced", () => {
  assertPassed(
    run(process.execPath, [
      path.join(root, "server", "scripts", "test-vehicle-status-process-v3.js"),
    ]),
    "DROPS process server contract",
  );
});

test("VERKSTED first-open — semantic repeats stay write-free across actionIds and races", () => {
  assertPassed(
    run(process.execPath, [
      path.join(root, "server", "scripts", "test-workshop-first-open-semantic-idempotency.js"),
    ], { timeout: 90_000 }),
    "VERKSTED first-open semantic idempotency contract",
  );
});

test("VERKSTED first-open UI — authoritative readback prevents repeat technical commands", () => {
  assertPassed(
    runHarness("sde-workshop-first-open-frontend-guard-harness.js"),
    "VERKSTED first-open frontend guard contract",
  );
});

test("VERKSTED exit — one authoritative request is idempotent, role-notified and visit-bound", () => {
  assertPassed(
    run(process.execPath, [
      path.join(root, "server", "scripts", "test-workshop-exit-request.js"),
    ], { timeout: 90_000 }),
    "VERKSTED workshop-exit request contract",
  );
});

test("SDE repeated reroute — stale completed history and superseded plans never become permanent locks", () => {
  assertPassed(
    runHarness("sde-repeated-reroute-harness.js"),
    "SDE repeated reroute contract",
  );
});

test("SDE workshop drag — independent workshop bays accept direct canonical reroutes", () => {
  assertPassed(
    runHarness("sde-workshop-slot-direct-drag-harness.js"),
    "SDE workshop direct drag contract",
  );
});

test("Nivå 4 workshop overview — exact four bays expose canonical read-only vehicle selectors", () => {
  assertPassed(
    runHarness("sde-workshop-hall-overview-harness.js"),
    "Nivå 4 workshop hall overview contract",
  );
});

test("DROPS-PROCESS-UI — every operational status can request repair without surveillance UI", () => {
  assertPassed(
    runHarness("sde-drops-repair-process-ui-harness.js"),
    "DROPS process UI contract",
  );
});

test("TURSATT-UI — baked label remains seamless without an obscuring CSS backplate", () => {
  const buttonRule = currentHtml.match(/\.segmented button\.seg-tursatt-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-tursatt-graphic__image\{([^}]*)\}/)?.[1] || "";
  const desktopRule = currentHtml.match(/@media \(min-width:901px\)\{([\s\S]*?)\n\}\n\.segmented button\.seg-drops-graphic/)?.[1] || "";
  const mobileRule = currentHtml.match(/@media \(max-width:900px\)\{([\s\S]*?)\n\}\n\.seg-green/)?.[1] || "";
  const semanticLabelRule = currentHtml.match(/\.seg-tursatt-graphic \.seg-main\{([^}]*)\}/)?.[1] || "";

  assert.match(buttonRule, /padding:0;/, "Tursatt button must not add an inner frame around the graphic");
  assert.match(buttonRule, /overflow:hidden;/, "full-bleed graphic must remain clipped by the button radius");
  assert.match(imageRule, /position:absolute;/, "graphic must fill independently of semantic label layout");
  assert.match(imageRule, /inset:0;/, "graphic must be anchored to every inner edge");
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.match(imageRule, /object-fit:cover;/, "the established mobile crop must remain unchanged");
  assert.match(imageRule, /object-position:center 60%;/, "the full-bleed crop must keep the Tursatt label visible");
  assert.match(
    currentHtml,
    /\.segmented button\.seg-tursatt-graphic\{min-width:160px\}/,
    "narrow viewports must preserve a usable full-bleed aspect ratio",
  );
  assert.match(currentHtml, /<source media="\(min-width:901px\)" srcset="assets\/tursatt-button-wide\.png\?v=572cee6a">/, "the production image URL must bypass a cached pre-route 404");
  assert.match(currentHtml, /<button class="seg seg-green seg-tursatt-graphic active" type="button" data-tab="oppstilling" data-levels="0 1 2 3 4 5"/, "Tursatt must remain available to every operational level, including level 4");
  assert.match(currentHtml, /<img class="seg-tursatt-graphic__image" src="assets\/tursatt-button\.png" alt="" aria-hidden="true"><\/picture><span class="seg-main"><span class="seg-primary">Tursatt<\/span><\/span>/);
  assert.match(desktopRule, /\.segmented button\.seg-tursatt-graphic\{[\s\S]*?background:#03181d;[\s\S]*?isolation:isolate;/);
  assert.match(desktopRule, /\.seg-tursatt-graphic__image\{[\s\S]*?object-position:center 40%;/);
  assert.match(semanticLabelRule, /width:1px;[\s\S]*?height:1px;[\s\S]*?overflow:hidden;[\s\S]*?clip:rect\(0,0,0,0\);/, "the semantic label must remain available without duplicating the baked Tursatt artwork");
  assert.doesNotMatch(currentHtml, /\.segmented button\.seg-tursatt-graphic::after\{/, "no CSS backplate may obscure the train behind the baked Tursatt label");
  assert.doesNotMatch(desktopRule, /\.seg-tursatt-graphic \.seg-main\{/, "desktop must not render a duplicate Tursatt label");
  assert.doesNotMatch(mobileRule, /\.seg-tursatt-graphic \.seg-main(?:\s|\{|,)/, "mobile must not render a duplicate Tursatt label");
  assert.doesNotMatch(desktopRule, /seg-tursatt-graphic::before/, "desktop must not synthesize side-fill behind the wide image");
  assert.match(currentServerIndex, /\["tursatt-button-wide\.png", path\.join\(REPO_ROOT, "assets", "tursatt-button-wide\.png"\)\]/, "production appserver must serve the desktop asset instead of returning 404");
});

test("GRAPHIC MENU TYPOGRAPHY — DROPS retains its responsive label contract", () => {
  const sharedDesktopRule = currentHtml.match(/@media \(min-width:901px\)\{\n\.segmented button\.seg-drops-graphic([\s\S]*?)\n\}\n@media \(max-width:900px\)/)?.[1] || "";
  const sharedMobileRule = currentHtml.match(/@media \(max-width:900px\)\{\n\.segmented button\.seg-drops-graphic([\s\S]*?)\n\}\n\.seg-green/)?.[1] || "";
  assert.match(sharedDesktopRule, /--graphic-menu-label-size:clamp\(18px,1\.65vw,25px\);/);
  assert.match(sharedDesktopRule, /--graphic-menu-label-weight:900;/);
  assert.match(sharedDesktopRule, /--graphic-menu-label-spacing:-\.02em;/);
  assert.match(sharedDesktopRule, /\.seg-drops-graphic \.seg-main::before\{[\s\S]*?font-family:inherit;[\s\S]*?font-size:var\(--graphic-menu-label-size\);[\s\S]*?font-weight:var\(--graphic-menu-label-weight\);[\s\S]*?letter-spacing:var\(--graphic-menu-label-spacing\);/);
  assert.match(sharedDesktopRule, /\.seg-drops-graphic \.seg-main::before\{[\s\S]*?content:"DROPS";[\s\S]*?text-shadow:0 2px 5px rgba\(0,0,0,\.95\);/);
  assert.match(sharedDesktopRule, /\.segmented button\.seg-drops-graphic::after\{[\s\S]*?width:34%;[\s\S]*?height:50%;[\s\S]*?z-index:1;/, "the compact DROPS backplate must cover the baked label without obscuring excess artwork");
  assert.match(sharedMobileRule, /--graphic-menu-label-size:15px;/);
  assert.match(sharedMobileRule, /--graphic-menu-label-weight:900;/);
  assert.match(sharedMobileRule, /--graphic-menu-label-spacing:-\.02em;/);
  assert.match(sharedMobileRule, /\.seg-drops-graphic \.seg-main::before\{[\s\S]*?font-family:inherit;[\s\S]*?font-size:var\(--graphic-menu-label-size\);[\s\S]*?font-weight:var\(--graphic-menu-label-weight\);[\s\S]*?letter-spacing:var\(--graphic-menu-label-spacing\);/);
  assert.match(sharedMobileRule, /\.segmented button\.seg-drops-graphic::after\{[\s\S]*?width:44%;[\s\S]*?height:62%;/, "the mobile DROPS backplate must stay compact while preserving label contrast");
});

test("GRAPHIC MENU DIMENSIONS — six TXP controls stay ordered on one equal-height row", () => {
  const uniformDesktopRule = currentHtml.match(/@media \(min-width:701px\)\{([\s\S]*?)\n\}\n@media \(max-width:700px\)/)?.[1] || "";
  const mobileRule = currentHtml.match(/@media \(max-width:700px\)\{([\s\S]*?)\.view-tools\{/)?.[1] || "";
  const menuMarkup = currentHtml.match(/<div class="segmented" aria-label="Hovedmeny">([\s\S]*?)<\/div>\n\n\n<section class="panel" id="grunnoppstilling">/)?.[1] || "";
  const menuOrder = [...menuMarkup.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);

  assert.match(uniformDesktopRule, /\.segmented\{[\s\S]*?grid-template-columns:[\s\S]*?repeat\(4,minmax\(211\.698114px,3\.41509434fr\)\)[\s\S]*?repeat\(2,minmax\(62px,1fr\)\);/, "the first four wide controls and the two square controls must form one height-matched row");
  assert.match(uniformDesktopRule, /\.segmented button\.seg\{[\s\S]*?grid-column:auto;[\s\S]*?width:100%;[\s\S]*?min-height:0;[\s\S]*?aspect-ratio:1810 \/ 530;/, "wide desktop controls must inherit Tursatt's exact box dimensions before explicit square-control overrides");
  assert.match(uniformDesktopRule, /\.segmented button\.seg\.seg-turnering-graphic\{[\s\S]*?width:100%;[\s\S]*?min-width:0;[\s\S]*?aspect-ratio:1 \/ 1;/, "the square controls must use the same computed row height as the wide controls");
  assert.match(mobileRule, /\.segmented button\.seg\{[\s\S]*?flex:0 0 160px;[\s\S]*?width:160px;[\s\S]*?min-width:160px;[\s\S]*?height:76px;[\s\S]*?min-height:76px;[\s\S]*?max-height:76px;[\s\S]*?aspect-ratio:auto;/, "wide mobile controls must use the same 160 by 76 pixel slot before explicit square-control overrides");
  assert.deepEqual(
    menuOrder.slice(0, 6),
    ["grunnoppstilling", "sporplan", "sdeSkiftebevegelser", "oppstilling", "turneringKveld", "turneringNatt"],
    "the TXP menu must start with the exact approved six-button order",
  );
  assert.doesNotMatch(currentHtml, /@media \(min-width:701px\) and \(max-width:1100px\)\{[\s\S]*?grid-template-columns:repeat\(3/, "tablet must not force the approved six-button row into a three-column wrap");
  assert.doesNotMatch(currentHtml, /\.segmented button:nth-child\(-n\+4\)\{grid-column:span 5;\}/, "the former first-row size exception must never return");
});

test("TURNERING GRAPHIC BUTTONS — transparent square Kveld and Natt controls preserve routing", () => {
  const assets = [
    ["turnering-kveld-button.png", "1a5b642eceb7c50b0c67e0cf617bc95c6a13a88e29185147f57b303188dafe10"],
    ["turnering-natt-button.png", "5a4bc8d7edbab70a7a82737bc067268e41f4968a408b239a564dd9835bac9134"],
  ];
  for (const [file, expectedHash] of assets) {
    const bytes = fs.readFileSync(path.join(root, "assets", file));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} must remain a PNG`);
    assert.equal(bytes[25], 6, `${file} must retain its RGBA transparency channel`);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), expectedHash, `${file} must retain the approved transparent artwork`);
    assert.ok(
      currentServerIndex.includes(`["${file}", path.join(REPO_ROOT, "assets", "${file}")]`),
      `production appserver must serve ${file} instead of returning 404`,
    );
  }

  assert.match(
    currentHtml,
    /<button class="seg seg-turnering-graphic seg-turnering-kveld-graphic" type="button" data-tab="turneringKveld" data-levels="0 2" aria-label="Åpne Turnering Kveld"[^>]*><img class="seg-turnering-graphic__image" src="assets\/turnering-kveld-button\.png\?v=[a-f0-9]+" alt="" aria-hidden="true"><\/button>/,
    "Kveld must preserve its existing route and access levels while rendering only the approved image",
  );
  assert.match(
    currentHtml,
    /<button class="seg seg-turnering-graphic seg-turnering-natt-graphic" type="button" data-tab="turneringNatt" data-levels="0 2" aria-label="Åpne Turnering Natt"[^>]*><img class="seg-turnering-graphic__image" src="assets\/turnering-natt-button\.png\?v=[a-f0-9]+" alt="" aria-hidden="true"><\/button>/,
    "Natt must preserve its existing route and access levels while rendering only the approved image",
  );
  assert.equal((currentHtml.match(/<img class="seg-turnering-graphic__image"/g) || []).length, 2, "only the two Turnering buttons may use these graphics");

  const buttonRule = currentHtml.match(/\.segmented button\.seg-turnering-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-turnering-graphic__image\{([^}]*)\}/)?.[1] || "";
  const mobileRule = currentHtml.match(/@media \(max-width:700px\)\{([\s\S]*?)\.view-tools\{/)?.[1] || "";

  assert.match(buttonRule, /padding:0;/);
  assert.match(buttonRule, /border:0;/);
  assert.match(buttonRule, /background:transparent;/, "the wrapper must not recreate the removed black rectangle");
  assert.match(buttonRule, /overflow:visible;/, "the transparent exterior and complete metallic frame must remain visible");
  assert.match(buttonRule, /box-shadow:none;/, "only the supplied 3D frame may be visible");
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.match(imageRule, /object-fit:contain;/);
  assert.match(currentHtml, /@media \(min-width:701px\)\{[\s\S]*?\.segmented button\.seg\.seg-turnering-graphic\{[\s\S]*?width:100%;[\s\S]*?min-width:0;[\s\S]*?aspect-ratio:1 \/ 1;[\s\S]*?\n\}/, "desktop and tablet buttons must be square and exactly as high as the wide controls");
  assert.match(mobileRule, /\.segmented button\.seg\.seg-turnering-graphic\{[\s\S]*?flex:0 0 76px;[\s\S]*?width:76px;[\s\S]*?min-width:76px;[\s\S]*?height:76px;[\s\S]*?max-height:76px;[\s\S]*?aspect-ratio:1 \/ 1;/, "mobile buttons must stay square and no taller than their row");
  assert.match(currentHtml, /\.segmented button\.seg-turnering-graphic:focus-visible\{[\s\S]*?outline:3px solid #22d3ee;/, "keyboard focus must remain visible");
});

test("DROPS-UI — Materiellstyrer graphic fills only its complete menu button", () => {
  const buttonRule = currentHtml.match(/\.segmented button\.seg-drops-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-drops-graphic__image\{([^}]*)\}/)?.[1] || "";

  assert.match(buttonRule, /position:relative;/);
  assert.match(buttonRule, /padding:0;/, "DROPS button must not add content padding around the graphic");
  assert.match(buttonRule, /overflow:hidden;/, "the graphic must remain clipped by the existing button radius");
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /inset:2px;/);
  assert.match(imageRule, /width:calc\(100% - 4px\);/);
  assert.match(imageRule, /height:calc\(100% - 4px\);/);
  assert.match(imageRule, /object-fit:cover;/, "the supplied graphic must fill the button without deformation");
  assert.match(
    currentHtml,
    /<button class="seg seg-drops-graphic"[^>]*data-tab="dropsMateriellstyrer"[^>]*><img class="seg-drops-graphic__image" src="data:image\/jpeg;base64,[A-Za-z0-9+/=]+" alt="" aria-hidden="true"><span class="seg-main">DROPS<br>Materiellstyrer<\/span><\/button>/,
    "DROPS routing and semantic label must be preserved while the production-routable inline graphic replaces duplicate visible text",
  );
  assert.equal(
    (currentHtml.match(/<img class="seg-drops-graphic__image"/g) || []).length,
    1,
    "only the DROPS menu button may render the supplied graphic",
  );
  assert.match(
    currentHtml,
    /\.segmented button\.seg-drops-graphic\{min-width:160px\}/,
    "narrow viewports must preserve a usable graphic button",
  );
});

test("DROPS ACCESSIBILITY — graphic menu control keeps keyboard focus and an explicit screen-reader name", () => {
  const openingTag = currentHtml.match(
    /<button class="seg seg-drops-graphic"[^>]*data-tab="dropsMateriellstyrer"[^>]*>/,
  )?.[0] || "";

  assert.ok(openingTag, "the DROPS Materiellstyrer navigation button must exist");
  assert.match(openingTag, /type="button"/, "native button keyboard semantics must be preserved");
  assert.match(openingTag, /data-levels="0 1"/, "level 0 and DROPS level 1 capability must be preserved");
  assert.match(
    openingTag,
    /aria-label="Åpne DROPS Materiellstyrer"/,
    "the graphic control must expose an explicit, stable screen-reader name",
  );
  assert.doesNotMatch(openingTag, /\b(?:disabled|tabindex="-1")\b/, "the control must remain keyboard reachable");
  assert.match(
    currentHtml,
    /\.segmented button\.seg-drops-graphic:focus-visible\{[^}]*outline:3px solid #22d3ee;[^}]*outline-offset:4px;[^}]*\}/,
    "keyboard focus must remain visibly distinct on the graphic control",
  );
  assert.match(
    currentHtml,
    /<span class="seg-main">DROPS<br>Materiellstyrer<\/span>/,
    "the existing visible label must remain unchanged",
  );
});

test("DROPS 3D FRAME — dark-blue edge and recessed fill remain visible around the graphic", () => {
  const buttonRule = currentHtml.match(/\.segmented button\.seg-drops-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-drops-graphic__image\{([^}]*)\}/)?.[1] || "";
  const activeRule = currentHtml.match(/\.segmented button\.seg-drops-graphic\.active\{([^}]*)\}/)?.[1] || "";

  assert.match(buttonRule, /border:2px solid #123b63;/, "DROPS must use a thin dark-blue outer frame");
  assert.match(buttonRule, /background:linear-gradient\(180deg,#174f80 0%,#0b3357 48%,#041a31 100%\);/, "unfilled button area must use a dark-blue depth gradient");
  assert.match(buttonRule, /box-shadow:[\s\S]*?inset 0 1px 0 rgba\(164,216,255,\.72\),[\s\S]*?inset 0 -3px 0 rgba\(0,10,26,\.76\),[\s\S]*?0 7px 0 #082744,[\s\S]*?0 13px 20px rgba\(2,13,28,\.34\);/, "the frame must retain a restrained bevel and outer depth edge");
  assert.match(imageRule, /inset:2px;/, "the graphic must reveal a narrow, even dark-blue inner edge");
  assert.match(imageRule, /width:calc\(100% - 4px\);/);
  assert.match(imageRule, /height:calc\(100% - 4px\);/);
  assert.match(imageRule, /border-radius:14px;/, "the inset graphic must follow the button corners without clipping the frame");
  assert.doesNotMatch(currentHtml, /\.seg-drops-graphic__image\{height:100%;\}/, "mobile rules must not erase the lower dark-blue edge");
  assert.match(activeRule, /transform:translateY\(5px\);/);
  assert.match(activeRule, /box-shadow:[\s\S]*?0 2px 0 #081d34,/, "the selected state must compress rather than lose the 3D edge");
});

test("SPORPLAN-UI — supplied Skien station graphic replaces only the existing Sporplan button", () => {
  const assetPath = path.join(root, "assets", "sporplan-skien-stasjon.png");
  const asset = fs.readFileSync(assetPath);
  const assetHash = crypto.createHash("sha256").update(asset).digest("hex");
  const buttonRule = currentHtml.match(/\.segmented button\.seg-sporplan-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-sporplan-graphic__image\{([^}]*)\}/)?.[1] || "";
  const activeRule = currentHtml.match(/\.segmented button\.seg-sporplan-graphic\.active\{([^}]*)\}/)?.[1] || "";
  const desktopRule = currentHtml.match(/@media \(min-width:901px\)\{([\s\S]*?)\.segmented button\.seg-tursatt-graphic\{/)?.[1] || "";
  const buttonMarkup = currentHtml.match(/<button class="seg seg-sporplan-graphic"[^>]*data-tab="sporplan"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";

  assert.equal(assetHash, "8a544aa9192817b1f9f7973c25167a9e3e87c52dc034062fe0d112cde286a010", "the supplied PNG must remain byte-identical");
  assert.equal(asset.readUInt32BE(16), 1774, "the supplied width must remain unchanged");
  assert.equal(asset.readUInt32BE(20), 887, "the supplied height must remain unchanged");
  assert.match(buttonRule, /display:block;/);
  assert.match(buttonRule, /width:100%;/);
  assert.match(buttonRule, /padding:0;/);
  assert.match(buttonRule, /border:2px solid #62d7ff;/);
  assert.match(buttonRule, /border-radius:18px;/);
  assert.match(buttonRule, /background:#061828;/);
  assert.match(buttonRule, /overflow:hidden;/);
  assert.match(buttonRule, /cursor:pointer;/);
  assert.match(buttonRule, /isolation:isolate;/);
  assert.match(buttonRule, /inset 0 2px 0 rgba\(255,255,255,\.88\)/, "Sporplan must retain the same raised top highlight as the other graphic buttons");
  assert.match(buttonRule, /0 8px 0 rgba\(20,62,88,\.42\)/, "Sporplan must retain a visible 3D depth edge");
  assert.match(activeRule, /inset 0 5px 12px rgba\(2,12,24,\.48\)/, "the active state must visibly press the 3D button");
  assert.match(activeRule, /0 2px 0 rgba\(20,62,88,\.32\)/, "the pressed state must shorten the outer depth without changing its action");
  assert.match(imageRule, /display:block;/);
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /inset:0;/);
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.match(imageRule, /object-fit:cover;/);
  assert.match(imageRule, /object-position:center 48%;/);
  assert.match(currentHtml, /\.segmented button\.seg-sporplan-graphic\{width:160px;min-width:160px\}/, "mobile must retain the established graphic-menu slot width");
  assert.match(desktopRule, /\.segmented button\.seg-sporplan-graphic\{[\s\S]*?aspect-ratio:1810 \/ 530;[\s\S]*?overflow:hidden;/, "desktop must retain the established menu slot while clipping only the pixels that fall outside the button frame");
  assert.doesNotMatch(desktopRule, /\.seg-sporplan-graphic__image\{/, "desktop must not introduce a viewport-specific crop");
  assert.match(currentHtml, /\.segmented button\.seg-sporplan-graphic:focus-visible\{[\s\S]*?outline:3px solid #22d3ee;[\s\S]*?outline-offset:4px;/);
  assert.match(
    currentHtml,
    /<button class="seg seg-sporplan-graphic" type="button" data-tab="sporplan" data-levels="0 1 2 3 4 5" aria-label="Åpne Sporplan"[^>]*><img class="seg-sporplan-graphic__image" src="assets\/sporplan-skien-stasjon\.png\?v=8a544aa9" alt=""><\/button>/,
    "routing, all-level access and semantic identity must remain unchanged",
  );
  assert.equal((currentHtml.match(/<img class="seg-sporplan-graphic__image"/g) || []).length, 1, "only the Sporplan menu button may use this graphic");
  assert.doesNotMatch(buttonMarkup, /<span class="seg-icon">▦<\/span>/, "the old icon must not remain inside the Sporplan button");
  assert.match(currentServerIndex, /\["sporplan-skien-stasjon\.png", path\.join\(REPO_ROOT, "assets", "sporplan-skien-stasjon\.png"\)\]/, "the production appserver must serve the exact supplied asset");
});

test("MOBILE-SPORPLAN-OVERFLOW — graphic stays inside its own mobile button and cannot cover TXP", () => {
  const buttonRule = currentHtml.match(/\.segmented button\.seg-sporplan-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-sporplan-graphic__image\{([^}]*)\}/)?.[1] || "";
  const mobileRule = currentHtml.match(/@media \(max-width:700px\)\{([\s\S]*?)\.view-tools\{/)?.[1] || "";
  const sporplanMarkup = currentHtml.match(/<button class="seg seg-sporplan-graphic"[^>]*data-tab="sporplan"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";
  const txpMarkup = currentHtml.match(/<button class="seg seg-txp-input-graphic"[^>]*data-tab="grunnoppstilling"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";

  assert.match(
    buttonRule,
    /position:relative;/,
    "the absolutely positioned Sporplan image must use its own button as containing block at every viewport",
  );
  assert.match(buttonRule, /overflow:hidden;/, "the graphic must remain clipped by the button radius");
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /inset:0;/);
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.doesNotMatch(imageRule, /transform:/, "the image must not scale beyond its 160 by 76 pixel mobile containing block");
  assert.match(
    mobileRule,
    /\.segmented button\.seg\{[\s\S]*?flex:0 0 160px;[\s\S]*?width:160px;[\s\S]*?height:76px;/,
    "the established mobile button rectangle must remain 160 by 76 pixels",
  );
  assert.match(sporplanMarkup, /aria-label="Åpne Sporplan"/, "Sporplan routing and keyboard identity must remain available");
  assert.match(txpMarkup, /aria-label="Åpne TXP Input Sporplan"/, "TXP Input must remain a separate visible and clickable button");
  assert.notEqual(sporplanMarkup, txpMarkup, "Sporplan and TXP Input must remain separate click targets");
  assert.doesNotMatch(currentHtml, /body\{overflow-x:hidden\}[\s\S]*?\.segmented\{overflow:hidden\}/, "the hotfix must not hide the horizontal menu globally");
});

test("TXP-INPUT-UI — supplied TXP graphic replaces only the existing Input Sporplan button", () => {
  const assetPath = path.join(root, "assets", "txp-input-sporplan.png");
  const asset = fs.readFileSync(assetPath);
  const assetHash = crypto.createHash("sha256").update(asset).digest("hex");
  const buttonRule = currentHtml.match(/\.segmented button\.seg-txp-input-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-txp-input-graphic__image\{([^}]*)\}/)?.[1] || "";
  const activeRule = currentHtml.match(/\.segmented button\.seg-txp-input-graphic\.active\{([^}]*)\}/)?.[1] || "";

  assert.equal(assetHash, "b2debef98c0d66d705f61f35c820d805306082c31c04f3eaece141fe099d48d0", "the supplied PNG must remain byte-identical");
  assert.equal(asset.readUInt32BE(16), 1893, "the supplied width must remain unchanged");
  assert.equal(asset.readUInt32BE(20), 831, "the supplied height must remain unchanged");
  assert.match(buttonRule, /position:relative;/);
  assert.match(buttonRule, /display:block;/);
  assert.match(buttonRule, /width:100%;/);
  assert.match(buttonRule, /padding:0;/);
  assert.match(buttonRule, /border:2px solid #62d7ff;/);
  assert.match(buttonRule, /border-radius:18px;/);
  assert.match(buttonRule, /background:#061828;/);
  assert.match(buttonRule, /overflow:hidden;/);
  assert.match(buttonRule, /cursor:pointer;/);
  assert.match(buttonRule, /isolation:isolate;/);
  assert.match(buttonRule, /aspect-ratio:1893 \/ 720;/, "narrow layouts must crop only the supplied exterior canvas");
  assert.match(buttonRule, /inset 0 2px 0 rgba\(255,255,255,\.88\)/, "TXP must use the established raised 3D highlight");
  assert.match(buttonRule, /0 8px 0 rgba\(20,62,88,\.42\)/, "TXP must retain a visible 3D depth edge");
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /inset:0;/);
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.match(imageRule, /object-fit:cover;/, "the supplied image must fill the button without deformation");
  assert.match(imageRule, /object-position:center 46%;/);
  assert.match(activeRule, /inset 0 5px 12px rgba\(2,12,24,\.48\)/, "the active state must visibly press the 3D button");
  assert.match(activeRule, /0 2px 0 rgba\(20,62,88,\.32\)/, "the pressed state must shorten its outer depth");
  assert.match(currentHtml, /@media \(min-width:901px\)\{[\s\S]*?\.segmented button\.seg-txp-input-graphic\{[\s\S]*?aspect-ratio:1810 \/ 530;/, "desktop must retain the established menu-row proportions");
  assert.match(currentHtml, /\.segmented button\.seg-txp-input-graphic\{width:160px;min-width:160px\}/, "mobile must retain the established graphic-menu slot width");
  assert.match(currentHtml, /\.segmented button\.seg-txp-input-graphic:focus-visible\{[\s\S]*?outline:3px solid #22d3ee;[\s\S]*?outline-offset:4px;/);
  assert.match(
    currentHtml,
    /<button class="seg seg-txp-input-graphic" type="button" data-tab="grunnoppstilling" data-levels="0 2" aria-label="Åpne TXP Input Sporplan"[^>]*><img class="seg-txp-input-graphic__image" src="assets\/txp-input-sporplan\.png\?v=b2debef9" alt=""><\/button>/,
    "routing, access levels and semantic identity must remain unchanged",
  );
  assert.equal((currentHtml.match(/<img class="seg-txp-input-graphic__image"/g) || []).length, 1, "only the TXP Input Sporplan menu button may use this graphic");
  assert.doesNotMatch(currentHtml, /data-tab="grunnoppstilling"[^>]*>[\s\S]*?<span class="seg-icon">TXP<\/span>/, "the old icon and visible duplicate label must not remain");
  assert.match(currentServerIndex, /\["txp-input-sporplan\.png", path\.join\(REPO_ROOT, "assets", "txp-input-sporplan\.png"\)\]/, "the production appserver must serve the exact supplied asset");
});

test("SDE-SHIFT-UI — supplied SDE graphic replaces only the existing Skiftebevegelser button", () => {
  const assetPath = path.join(root, "assets", "sde-skiftebevegelser.png");
  const asset = fs.readFileSync(assetPath);
  const assetHash = crypto.createHash("sha256").update(asset).digest("hex");
  const buttonRule = currentHtml.match(/\.segmented button\.seg-sde-shift-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-sde-shift-graphic__image\{([^}]*)\}/)?.[1] || "";
  const activeRule = currentHtml.match(/\.segmented button\.seg-sde-shift-graphic\.active\{([^}]*)\}/)?.[1] || "";

  assert.equal(assetHash, "e2de04bbf183c233cdded3217e89e9f19d5b8f6e364d09682abcec2ffd82715f", "the supplied PNG must remain byte-identical");
  assert.equal(asset.readUInt32BE(16), 1916, "the supplied width must remain unchanged");
  assert.equal(asset.readUInt32BE(20), 821, "the supplied height must remain unchanged");
  assert.match(buttonRule, /position:relative;/);
  assert.match(buttonRule, /display:block;/);
  assert.match(buttonRule, /width:100%;/);
  assert.match(buttonRule, /padding:0;/);
  assert.match(buttonRule, /border:2px solid #62d7ff;/);
  assert.match(buttonRule, /border-radius:18px;/);
  assert.match(buttonRule, /background:#061828;/);
  assert.match(buttonRule, /overflow:hidden;/);
  assert.match(buttonRule, /cursor:pointer;/);
  assert.match(buttonRule, /isolation:isolate;/);
  assert.match(buttonRule, /aspect-ratio:1916 \/ 640;/, "narrow layouts must crop only the exterior black canvas");
  assert.match(buttonRule, /inset 0 2px 0 rgba\(255,255,255,\.88\)/, "SDE must use the established raised 3D highlight");
  assert.match(buttonRule, /0 8px 0 rgba\(20,62,88,\.42\)/, "SDE must retain a visible 3D depth edge");
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /inset:0;/);
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.match(imageRule, /object-fit:cover;/, "the supplied image must fill the button without deformation");
  assert.match(imageRule, /object-position:center 47%;/);
  assert.match(activeRule, /inset 0 5px 12px rgba\(2,12,24,\.48\)/, "the active state must visibly press the 3D button");
  assert.match(activeRule, /0 2px 0 rgba\(20,62,88,\.32\)/, "the pressed state must shorten its outer depth");
  assert.match(currentHtml, /@media \(min-width:901px\)\{[\s\S]*?\.segmented button\.seg-sde-shift-graphic\{[\s\S]*?aspect-ratio:1810 \/ 530;/, "desktop must retain the established menu-row proportions");
  assert.match(currentHtml, /\.segmented button\.seg-sde-shift-graphic\{width:160px;min-width:160px\}/, "mobile must retain the established graphic-menu slot width");
  assert.match(currentHtml, /\.segmented button\.seg-sde-shift-graphic:focus-visible\{[\s\S]*?outline:3px solid #22d3ee;[\s\S]*?outline-offset:4px;/);
  assert.match(
    currentHtml,
    /<button class="seg seg-sde-shift-graphic" type="button" data-tab="sdeSkiftebevegelser" data-levels="0 2 3" aria-label="Åpne SDE Skiftebevegelser"[^>]*><img class="seg-sde-shift-graphic__image" src="assets\/sde-skiftebevegelser\.png\?v=e2de04bb" alt=""><\/button>/,
    "routing, access levels and semantic identity must remain unchanged",
  );
  assert.equal((currentHtml.match(/<img class="seg-sde-shift-graphic__image"/g) || []).length, 1, "only the SDE Skiftebevegelser menu button may use this graphic");
  assert.doesNotMatch(currentHtml, /data-tab="sdeSkiftebevegelser"[^>]*>[\s\S]*?<span class="seg-icon">⇄<\/span>/, "the old icon and visible duplicate label must not remain");
  assert.match(currentServerIndex, /\["sde-skiftebevegelser\.png", path\.join\(REPO_ROOT, "assets", "sde-skiftebevegelser\.png"\)\]/, "the production appserver must serve the exact supplied asset");
});

test("SDE-VAKTPLAN-UI — supplied graphic replaces only the existing Vaktplan button", () => {
  const assetPath = path.join(root, "assets", "sde-vaktplan.png");
  const asset = fs.readFileSync(assetPath);
  const assetHash = crypto.createHash("sha256").update(asset).digest("hex");
  const buttonRule = currentHtml.match(/\.segmented button\.seg-vaktplan-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-vaktplan-graphic__image\{([^}]*)\}/)?.[1] || "";
  const activeRule = currentHtml.match(/\.segmented button\.seg-vaktplan-graphic\.active\{([^}]*)\}/)?.[1] || "";

  assert.equal(assetHash, "a705bd2b4538f794f5195177b90e3998ee168b2dfe3ced34391957441ec42112", "the supplied PNG must remain byte-identical");
  assert.equal(asset.readUInt32BE(16), 1942, "the supplied width must remain unchanged");
  assert.equal(asset.readUInt32BE(20), 809, "the supplied height must remain unchanged");
  assert.match(buttonRule, /position:relative;/);
  assert.match(buttonRule, /display:block;/);
  assert.match(buttonRule, /width:100%;/);
  assert.match(buttonRule, /padding:0;/);
  assert.match(buttonRule, /border:2px solid #62d7ff;/);
  assert.match(buttonRule, /border-radius:18px;/);
  assert.match(buttonRule, /background:#061828;/);
  assert.match(buttonRule, /overflow:hidden;/);
  assert.match(buttonRule, /cursor:pointer;/);
  assert.match(buttonRule, /isolation:isolate;/);
  assert.match(buttonRule, /aspect-ratio:1942 \/ 640;/, "the Vaktplan artwork must fill the established menu-button geometry");
  assert.match(buttonRule, /inset 0 2px 0 rgba\(255,255,255,\.88\)/, "Vaktplan must use the established raised 3D highlight");
  assert.match(buttonRule, /0 8px 0 rgba\(20,62,88,\.42\)/, "Vaktplan must retain a visible 3D depth edge");
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /inset:0;/);
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.match(imageRule, /object-fit:cover;/, "the supplied image must fill the button without deformation");
  assert.match(imageRule, /object-position:center 44%;/);
  assert.match(activeRule, /inset 0 5px 12px rgba\(2,12,24,\.48\)/, "the active state must visibly press the 3D button");
  assert.match(activeRule, /0 2px 0 rgba\(20,62,88,\.32\)/, "the pressed state must shorten its outer depth");
  assert.match(currentHtml, /@media \(min-width:901px\)\{[\s\S]*?\.segmented button\.seg-vaktplan-graphic\{[\s\S]*?aspect-ratio:1810 \/ 530;/, "desktop must retain the established menu-row proportions");
  assert.match(currentHtml, /\.segmented button\.seg-vaktplan-graphic\{width:160px;min-width:160px\}/, "mobile must retain the established graphic-menu slot width");
  assert.match(currentHtml, /\.segmented button\.seg-vaktplan-graphic:focus-visible\{[\s\S]*?outline:3px solid #22d3ee;[\s\S]*?outline-offset:4px;/);
  assert.match(
    currentHtml,
    /<button class="seg seg-vaktplan-graphic" type="button" data-tab="sdeVaktplan" data-levels="0 1" aria-label="Åpne SDE Vaktplan"[^>]*><img class="seg-vaktplan-graphic__image" src="assets\/sde-vaktplan\.png\?v=a705bd2b" alt=""><\/button>/,
    "routing, access levels and semantic identity must remain unchanged",
  );
  assert.equal((currentHtml.match(/<img class="seg-vaktplan-graphic__image"/g) || []).length, 1, "only the SDE Vaktplan menu button may use this graphic");
  assert.doesNotMatch(currentHtml.match(/<button class="seg seg-vaktplan-graphic"[\s\S]*?<\/button>/)?.[0] || "", /<span class="seg-icon">▦<\/span>|<span class="seg-main">SDE<br>Vaktplan<\/span>/, "the old icon and duplicate visible label must not remain");
  assert.match(currentServerIndex, /\["sde-vaktplan\.png", path\.join\(REPO_ROOT, "assets", "sde-vaktplan\.png"\)\]/, "the production appserver must serve the exact supplied asset");
});

test("STADLER-UI — supplied STADLER graphic replaces only Input verksted", () => {
  const assetPath = path.join(root, "assets", "stadler-button.png");
  const asset = fs.readFileSync(assetPath);
  const assetHash = crypto.createHash("sha256").update(asset).digest("hex");
  const buttonRule = currentHtml.match(/\.segmented button\.seg-stadler-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-stadler-graphic__image\{([^}]*)\}/)?.[1] || "";
  const activeRule = currentHtml.match(/\.segmented button\.seg-stadler-graphic\.active\{([^}]*)\}/)?.[1] || "";

  assert.equal(assetHash, "e54c0284d0a638fcafeb978512d15ebade2185c17bd070e600c32e6ac47b4fb6", "the supplied STADLER PNG must remain byte-identical");
  assert.equal(asset.readUInt32BE(16), 1916, "the supplied width must remain unchanged");
  assert.equal(asset.readUInt32BE(20), 821, "the supplied height must remain unchanged");
  assert.match(buttonRule, /position:relative;/);
  assert.match(buttonRule, /display:block;/);
  assert.match(buttonRule, /width:100%;/);
  assert.match(buttonRule, /padding:0;/);
  assert.match(buttonRule, /border:2px solid #aeb8c4;/);
  assert.match(buttonRule, /border-radius:18px;/);
  assert.match(buttonRule, /background:#07090c;/);
  assert.match(buttonRule, /overflow:hidden;/, "the exterior black canvas must be clipped outside the rounded button");
  assert.match(buttonRule, /cursor:pointer;/);
  assert.match(buttonRule, /isolation:isolate;/);
  assert.match(buttonRule, /aspect-ratio:1916 \/ 640;/, "narrow layouts must crop only the supplied exterior canvas");
  assert.match(buttonRule, /inset 0 2px 0 rgba\(255,255,255,\.88\)/, "STADLER must use a raised 3D highlight");
  assert.match(buttonRule, /0 8px 0 rgba\(74,18,24,\.52\)/, "STADLER must retain a visible 3D depth edge");
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /inset:0;/);
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:100%;/);
  assert.match(imageRule, /object-fit:cover;/, "the supplied image must fill the button without deformation");
  assert.match(imageRule, /object-position:center 57%;/);
  assert.match(activeRule, /inset 0 5px 12px rgba\(10,12,16,\.58\)/, "the active state must visibly press the 3D button");
  assert.match(activeRule, /0 2px 0 rgba\(74,18,24,\.38\)/, "the pressed state must shorten its outer depth");
  assert.match(currentHtml, /@media \(min-width:901px\)\{[\s\S]*?\.segmented button\.seg-stadler-graphic\{[\s\S]*?aspect-ratio:1810 \/ 530;/, "desktop must retain the established menu-row proportions");
  assert.match(currentHtml, /\.segmented button\.seg-stadler-graphic\{width:160px;min-width:160px\}/, "mobile must retain the established graphic-menu slot width");
  assert.match(currentHtml, /\.segmented button\.seg-stadler-graphic:focus-visible\{[\s\S]*?outline:3px solid #ef4444;[\s\S]*?outline-offset:4px;/);
  assert.match(
    currentHtml,
    /<button class="seg seg-red seg-stadler-graphic" type="button" data-tab="verkstedBestillinger" data-levels="0 4" aria-label="Åpne STADLER"[^>]*><img class="seg-stadler-graphic__image" src="assets\/stadler-button\.png\?v=e54c0284" alt=""><\/button>/,
    "Input verksted routing and access levels must remain unchanged while the button identity becomes STADLER",
  );
  assert.equal((currentHtml.match(/<img class="seg-stadler-graphic__image"/g) || []).length, 1, "only Input verksted may use the STADLER graphic");
  assert.doesNotMatch(currentHtml, /data-tab="verkstedBestillinger"[^>]*>[\s\S]*?<span class="seg-icon">🔧<\/span>/, "the old icon and visible Input verksted label must not remain");
  assert.match(currentServerIndex, /\["stadler-button\.png", path\.join\(REPO_ROOT, "assets", "stadler-button\.png"\)\]/, "the production appserver must serve the exact supplied STADLER asset");
});

test("AGILIA-UI — corrected level identity and dedicated graphic menu are permanent", () => {
  const assetPath = path.join(root, "assets", "agilia-button.png");
  const asset = fs.readFileSync(assetPath);
  const assetHash = crypto.createHash("sha256").update(asset).digest("hex");
  const buttonRule = currentHtml.match(/\.segmented button\.seg-agilia-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-agilia-graphic__image\{([^}]*)\}/)?.[1] || "";
  const activeRule = currentHtml.match(/\.segmented button\.seg-agilia-graphic\.active\{([^}]*)\}/)?.[1] || "";

  assert.equal(assetHash, "37f6dd17b0f42510cd5714c473486934619414234f56be026cfea5e663183ed4", "the supplied Agilia PNG must remain byte-identical");
  assert.equal(asset.readUInt32BE(16), 1672, "the supplied Agilia width must remain unchanged");
  assert.equal(asset.readUInt32BE(20), 941, "the supplied Agilia height must remain unchanged");
  assert.match(buttonRule, /position:relative;/);
  assert.match(buttonRule, /display:block;/);
  assert.match(buttonRule, /width:100%;/);
  assert.match(buttonRule, /padding:0;/);
  assert.match(buttonRule, /border:2px solid #facc15;/, "Agilia must have a thin yellow perimeter line");
  assert.match(buttonRule, /border-radius:18px;/);
  assert.match(buttonRule, /background:#081426;/, "masked exterior must resolve to the dark button surface, never grey");
  assert.match(buttonRule, /overflow:hidden;/, "the supplied grey canvas must be clipped outside the visible button");
  assert.match(buttonRule, /aspect-ratio:1916 \/ 640;/);
  assert.match(buttonRule, /inset 0 2px 0 rgba\(255,255,255,\.88\)/, "Agilia must retain the raised 3D highlight");
  assert.match(buttonRule, /0 8px 0 rgba\(113,63,18,\.52\)/, "Agilia must retain a visible 3D depth edge");
  assert.match(imageRule, /position:absolute;/);
  assert.match(imageRule, /left:50%;/);
  assert.match(imageRule, /top:54%;/);
  assert.match(imageRule, /width:126%;/);
  assert.match(imageRule, /height:auto;/, "the supplied image must never be deformed");
  assert.match(imageRule, /transform:translate\(-50%,-50%\);/, "the grey exterior must be cropped symmetrically");
  assert.match(activeRule, /inset 0 5px 12px rgba\(66,32,6,\.52\)/, "the active state must visibly press the 3D button");
  assert.match(activeRule, /0 2px 0 rgba\(113,63,18,\.38\)/, "the pressed state must shorten its outer depth");
  assert.match(currentHtml, /@media \(min-width:901px\)\{[\s\S]*?\.segmented button\.seg-agilia-graphic\{[\s\S]*?aspect-ratio:1810 \/ 530;[\s\S]*?\.seg-agilia-graphic__image\{[\s\S]*?top:53%;[\s\S]*?width:116%;/, "desktop must use a wider crop that removes the grey source canvas");
  assert.match(currentHtml, /\.segmented button\.seg-agilia-graphic\{width:160px;min-width:160px\}/, "mobile must retain the established graphic-menu slot width");
  assert.match(currentHtml, /\.segmented button\.seg-agilia-graphic:focus-visible\{[\s\S]*?outline:3px solid #facc15;[\s\S]*?outline-offset:4px;/);
  assert.match(
    currentHtml,
    /<button class="seg seg-agilia-graphic" type="button" data-tab="agilia" data-levels="0 5" aria-label="Åpne Agilia"[^>]*><img class="seg-agilia-graphic__image" src="assets\/agilia-button\.png\?v=37f6dd17" alt=""><\/button>/,
    "Agilia must be exposed only at levels 0 and 5",
  );
  assert.equal((currentHtml.match(/<img class="seg-agilia-graphic__image"/g) || []).length, 1, "there must be exactly one Agilia menu button");
  assert.match(currentHtml, /<section class="panel" id="agilia">/, "Agilia must open a dedicated panel");
  assert.match(currentHtml, /<option value="5">Nivå 5 – Agilia<\/option>/, "level 5 must use the corrected Agilia spelling");
  assert.match(normativeGuide, /^NIVÅ 5 – AGILIA$/m, "the normative level-5 guide must use the corrected Agilia spelling");
  assert.match(currentHtml, /\{level:"Agilia", functions:\["Sporplan", "Agilia"\]\}/, "the shared access readmodel must use the corrected Agilia identity");
  assert.doesNotMatch(currentHtml, /\bAgila\b/, "the misspelled Agila identity must not remain");
  assert.match(currentServerIndex, /\["agilia-button\.png", path\.join\(REPO_ROOT, "assets", "agilia-button\.png"\)\]/, "the production appserver must serve the exact supplied Agilia asset");
});

test("LEVEL-4-MENU — workshop keeps Tursatt and Sporplan without Agilia", () => {
  assert.match(currentHtml, /data-tab="oppstilling" data-levels="0 1 2 3 4 5"/, "level 4 must retain Tursatt");
  assert.match(currentHtml, /data-tab="sporplan" data-levels="0 1 2 3 4 5"/, "level 4 must retain Sporplan");
  assert.match(currentHtml, /\{level:"Verksted", functions:\["Tursatt", "Sporplan", "DROPS-relevante behov", "verksted\/materiellstatus"\]\}/, "the shared access readmodel must include both level-4 overview surfaces");
  assert.match(normativeGuide, /^NIVÅ 4 – VERKSTED$/m, "the normative guide must retain the level-4 workshop identity");
  assert.match(currentHtml, /data-tab="agilia" data-levels="0 5"/, "Agilia must remain excluded from level 4");
});

test("Existing generator regressions — all previously tracked data tests stay green", () => {
  assertPassed(
    run("python3", ["-m", "unittest", "test_update_static_data.py"]),
    "existing generator regression suite",
  );
});

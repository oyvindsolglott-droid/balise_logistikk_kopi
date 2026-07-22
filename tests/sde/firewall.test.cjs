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
const currentHtml = fs.readFileSync(indexPath, "utf8");
const currentServerIndex = fs.readFileSync(serverIndexPath, "utf8");

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

function registerHarnessTest({phase, name, harness, baseline}) {
  test(`${phase} — ${name}`, () => {
    assertPassed(runHarness(harness), `${phase} current contract`);
    const oldResult = runHarness(harness, materialize(baseline, "index.html"));
    assert.notEqual(
      oldResult.status,
      0,
      `${phase} permanent test did not detect its historical production baseline ${baseline}`,
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
  baseline: "b125418d22a4124c60e5cb8c36e76da70165669b",
});

registerHarnessTest({
  phase: "Completed-chain lifecycle",
  name: "a completed historical chain cannot poison a fresh order from current actual-state",
  harness: "sde-completed-chain-new-order-harness.js",
  baseline: "4ef126fbb280360c7ad243d0a3f6ce1668c066f1",
});

registerHarnessTest({
  phase: "Fresh graphical order identity",
  name: "a unique browser drag cannot bind to an older row only by vehicle and source",
  harness: "sde-fresh-graphic-order-base-row-harness.js",
  baseline: "4aba2d32b1b99d8f01037f8330899791648036fb",
});

registerHarnessTest({
  phase: "Completed-chain manual return",
  name: "a valid local return remains quittable when canonical authority uses a separate outcome id",
  harness: "sde-completed-chain-manual-return-harness.js",
  baseline: "93e3ab9d83ddd1e7003c15e675c06ed759685cf8",
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
  baseline: "15f430b8978c43cdcd60a8876105e079fb9e9818",
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
    assert.match(source, /workflow_dispatch:/);
    assert.match(source, /cron:\s*["']7,22,37,52 4,7,15,21 \* \* \*["']/);
    assert.match(source, /\{"04",\s*"07",\s*"15",\s*"21"\}/);
    assert.ok((source.match(/timezone:\s*["']Europe\/Oslo["']/g) || []).length >= 2);
    assert.match(source, /concurrency:/);
    assert.match(source, /git add data\/api_idag\.json data\/api_imorgen\.json/);
    assert.match(source, /git diff --cached --quiet/);
    assert.match(source, /git rebase ["']origin\/\$branch["']/);
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
  baseline: "090fabb343a6a75d4ac4480cf1740d7b0a22e4e8",
});

registerHarnessTest({
  phase: "X3",
  name: "no tursatt assignments cannot resurrect automatic physical-chain cards",
  harness: "sde-no-tursatt-no-automatic-cards-harness.js",
  baseline: "b3521243b0e3fb5d680c1e41d2d34c63445f4331",
});

registerHarnessTest({
  phase: "DROPS-1A",
  name: "level-one vehicle registry keeps the exact catalog and independent collapsed DOM groups",
  harness: "sde-drops-vehicle-registry-dom-harness.js",
  baseline: "f84986fb348a10572fb6e4b5ee86c45ce40335f5",
});

test("TURSATT-UI — desktop uses one seamless wide image while mobile keeps its established crop", () => {
  const buttonRule = currentHtml.match(/\.segmented button\.seg-tursatt-graphic\{([^}]*)\}/)?.[1] || "";
  const imageRule = currentHtml.match(/\.seg-tursatt-graphic__image\{([^}]*)\}/)?.[1] || "";
  const desktopRule = currentHtml.match(/@media \(min-width:901px\)\{([\s\S]*?)\n\}\n\.segmented button\.seg-drops-graphic/)?.[1] || "";

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
  assert.match(currentHtml, /<img class="seg-tursatt-graphic__image" src="assets\/tursatt-button\.png" alt="" aria-hidden="true"><\/picture><span class="seg-main"><span class="seg-primary">Tursatt<\/span><\/span>/);
  assert.match(desktopRule, /\.segmented button\.seg-tursatt-graphic\{[\s\S]*?background:#03181d;[\s\S]*?isolation:isolate;/);
  assert.match(desktopRule, /\.segmented button\.seg-tursatt-graphic::after\{[\s\S]*?right:0;[\s\S]*?bottom:0;[\s\S]*?width:48%;[\s\S]*?height:45%;[\s\S]*?linear-gradient\(90deg,transparent,rgba\(1,18,24,\.99\) 24%,#011218 45%\);[\s\S]*?z-index:1;/);
  assert.match(desktopRule, /\.seg-tursatt-graphic__image\{[\s\S]*?object-position:center 40%;/);
  assert.match(desktopRule, /\.seg-tursatt-graphic \.seg-main\{[\s\S]*?right:12px;[\s\S]*?bottom:10px;[\s\S]*?overflow:visible;[\s\S]*?clip:auto;[\s\S]*?color:#fff;[\s\S]*?z-index:2;/);
  assert.doesNotMatch(desktopRule, /seg-tursatt-graphic::before/, "desktop must not synthesize side-fill behind the wide image");
  assert.match(currentServerIndex, /\["tursatt-button-wide\.png", path\.join\(REPO_ROOT, "assets", "tursatt-button-wide\.png"\)\]/, "production appserver must serve the desktop asset instead of returning 404");
});

test("GRAPHIC MENU TYPOGRAPHY — Tursatt and DROPS share one responsive label contract", () => {
  const sharedDesktopRule = currentHtml.match(/@media \(min-width:901px\)\{\n\.segmented button\.seg-tursatt-graphic,([\s\S]*?)\n\}\n\.seg-green/)?.[1] || "";
  const sharedMobileRule = currentHtml.match(/@media \(max-width:900px\)\{\n\.segmented button\.seg-tursatt-graphic,([\s\S]*?)\n\}\n\.seg-green/)?.[1] || "";
  assert.match(sharedDesktopRule, /--graphic-menu-label-size:clamp\(18px,1\.65vw,25px\);/);
  assert.match(sharedDesktopRule, /--graphic-menu-label-weight:900;/);
  assert.match(sharedDesktopRule, /--graphic-menu-label-spacing:-\.02em;/);
  assert.match(sharedDesktopRule, /\.seg-tursatt-graphic \.seg-main,\n\.seg-drops-graphic \.seg-main::before\{[\s\S]*?font-family:inherit;[\s\S]*?font-size:var\(--graphic-menu-label-size\);[\s\S]*?font-weight:var\(--graphic-menu-label-weight\);[\s\S]*?letter-spacing:var\(--graphic-menu-label-spacing\);/);
  assert.match(sharedDesktopRule, /\.seg-drops-graphic \.seg-main::before\{[\s\S]*?content:"DROPS";[\s\S]*?text-shadow:0 2px 5px rgba\(0,0,0,\.95\);/);
  assert.match(sharedDesktopRule, /\.segmented button\.seg-drops-graphic::after\{[\s\S]*?width:34%;[\s\S]*?height:50%;[\s\S]*?z-index:1;/, "the compact DROPS backplate must cover the baked label without obscuring excess artwork");
  assert.match(sharedMobileRule, /--graphic-menu-label-size:15px;/);
  assert.match(sharedMobileRule, /--graphic-menu-label-weight:900;/);
  assert.match(sharedMobileRule, /--graphic-menu-label-spacing:-\.02em;/);
  assert.match(sharedMobileRule, /\.seg-tursatt-graphic \.seg-main \.seg-primary,\n\.seg-drops-graphic \.seg-main::before\{[\s\S]*?font-family:inherit;[\s\S]*?font-size:var\(--graphic-menu-label-size\);[\s\S]*?font-weight:var\(--graphic-menu-label-weight\);[\s\S]*?letter-spacing:var\(--graphic-menu-label-spacing\);/);
  assert.match(sharedMobileRule, /\.segmented button\.seg-tursatt-graphic::after,\n\.segmented button\.seg-drops-graphic::after\{[\s\S]*?z-index:1;/, "both baked mobile labels must be covered before the shared typography is rendered");
  assert.match(sharedMobileRule, /\.segmented button\.seg-drops-graphic::after\{[\s\S]*?width:44%;[\s\S]*?height:62%;/, "the mobile DROPS backplate must stay compact while preserving label contrast");
});

test("GRAPHIC MENU DIMENSIONS — wide menu controls match Tursatt on desktop, tablet and mobile", () => {
  const uniformDesktopRule = currentHtml.match(/@media \(min-width:701px\)\{([\s\S]*?)\n\}/)?.[1] || "";
  const tabletRule = currentHtml.match(/@media \(min-width:701px\) and \(max-width:1100px\)\{([\s\S]*?)\n\}/)?.[1] || "";
  const mobileRule = currentHtml.match(/@media \(max-width:700px\)\{([\s\S]*?)\.view-tools\{/)?.[1] || "";

  assert.match(uniformDesktopRule, /\.segmented\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/, "desktop must use four equal menu columns");
  assert.match(uniformDesktopRule, /\.segmented button\.seg\{[\s\S]*?grid-column:auto;[\s\S]*?width:100%;[\s\S]*?min-height:0;[\s\S]*?aspect-ratio:1810 \/ 530;/, "wide desktop controls must inherit Tursatt's exact box dimensions before explicit square-control overrides");
  assert.match(tabletRule, /\.segmented\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/, "tablet must keep every menu cell equally wide");
  assert.match(mobileRule, /\.segmented button\.seg\{[\s\S]*?flex:0 0 160px;[\s\S]*?width:160px;[\s\S]*?min-width:160px;[\s\S]*?height:76px;[\s\S]*?min-height:76px;[\s\S]*?max-height:76px;[\s\S]*?aspect-ratio:auto;/, "wide mobile controls must use the same 160 by 76 pixel slot before explicit square-control overrides");
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
  assert.match(currentHtml, /@media \(min-width:701px\)\{[\s\S]*?\.segmented button\.seg\.seg-turnering-graphic\{[\s\S]*?width:29\.2817679558%;[\s\S]*?aspect-ratio:1 \/ 1;[\s\S]*?\n\}/, "desktop and tablet buttons must be square and exactly as high as the wide controls");
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

  assert.equal(assetHash, "148a1db129266c37efa6c43f2831bd852535c67a34f886d2cbc3289940bb5439", "the supplied PNG must remain byte-identical");
  assert.equal(asset.readUInt32BE(16), 1916, "the supplied width must remain unchanged");
  assert.equal(asset.readUInt32BE(20), 821, "the supplied height must remain unchanged");
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
  assert.match(imageRule, /width:100%;/);
  assert.match(imageRule, /height:auto;/);
  assert.match(imageRule, /aspect-ratio:1916 \/ 821;/);
  assert.match(imageRule, /object-fit:contain;/);
  assert.match(currentHtml, /\.segmented button\.seg-sporplan-graphic\{width:160px;min-width:160px\}/, "mobile must retain the established graphic-menu slot width");
  assert.match(desktopRule, /\.segmented button\.seg-sporplan-graphic\{[\s\S]*?aspect-ratio:1810 \/ 530;[\s\S]*?overflow:hidden;/, "desktop must crop only the source pixels outside the supplied finished frame");
  assert.match(desktopRule, /\.seg-sporplan-graphic__image\{[\s\S]*?left:-2\.818%;[\s\S]*?top:-24\.151%;[\s\S]*?width:105\.856%;[\s\S]*?height:154\.906%;[\s\S]*?max-width:none;/, "desktop crop must preserve the complete in-frame artwork without deformation");
  assert.match(currentHtml, /\.segmented button\.seg-sporplan-graphic:focus-visible\{[\s\S]*?outline:3px solid #22d3ee;[\s\S]*?outline-offset:4px;/);
  assert.match(
    currentHtml,
    /<button class="seg seg-sporplan-graphic" type="button" data-tab="sporplan" data-levels="0 1 2 3 5" aria-label="Åpne Sporplan"[^>]*><img class="seg-sporplan-graphic__image" src="assets\/sporplan-skien-stasjon\.png\?v=148a1db1" alt=""><\/button>/,
    "routing, access levels and semantic identity must remain unchanged",
  );
  assert.equal((currentHtml.match(/<img class="seg-sporplan-graphic__image"/g) || []).length, 1, "only the Sporplan menu button may use this graphic");
  assert.doesNotMatch(currentHtml, /data-tab="sporplan"[^>]*>[\s\S]*?<span class="seg-icon">▦<\/span>/, "the old icon must not remain");
  assert.match(currentServerIndex, /\["sporplan-skien-stasjon\.png", path\.join\(REPO_ROOT, "assets", "sporplan-skien-stasjon\.png"\)\]/, "the production appserver must serve the exact supplied asset");
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

test("Existing generator regressions — all previously tracked data tests stay green", () => {
  assertPassed(
    run("python3", ["-m", "unittest", "test_update_static_data.py"]),
    "existing generator regression suite",
  );
});

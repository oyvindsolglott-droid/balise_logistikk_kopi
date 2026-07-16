"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {after, test} = require("node:test");

const root = path.resolve(__dirname, "../..");
const indexPath = path.join(root, "index.html");
const harnessDirectory = path.join(__dirname, "harnesses");
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-regression-firewall-"));
const currentHtml = fs.readFileSync(indexPath, "utf8");

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

test("Production UI — shows only executable shift cards and no retarget menu", () => {
  const contract = source => {
    const visibleCards = extractFunction(source, "getSdeCanonicalProductionVisibleCards");
    assert.ok(visibleCards.includes("reader.cardProjection.actionableCards"));
    assert.ok(visibleCards.includes("adapter?.ready === true"));
    assert.ok(visibleCards.includes("adapter.canComplete === true || adapter.canCancel === true"));
    for(const forbidden of ["blockedChainCards", "handlerBlockedCards", "exitingCards"]){
      assert.equal(visibleCards.includes(forbidden), false, `production visible cards include ${forbidden}`);
    }

    const controls = extractFunction(source, "buildSdeCanonicalCardActionControlsHtml");
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

test("Existing generator regressions — all previously tracked data tests stay green", () => {
  assertPassed(
    run("python3", ["-m", "unittest", "test_update_static_data.py"]),
    "existing generator regression suite",
  );
});

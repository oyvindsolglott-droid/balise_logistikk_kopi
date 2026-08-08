"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  buildEvidenceManifest,
  evaluateMultiuserEvidence,
  manifestHash
} = require("../lib/multiuser-evidence.cjs");
const { result, summarize } = require("../lib/core.cjs");
const { renderHtml, renderJUnit } = require("../lib/reporters.cjs");

const ROOT = path.resolve(__dirname, "../../..");
const FIXED_NOW = new Date("2026-08-08T18:30:00.000Z");

function git(repository, args, expected = 0) {
  const child = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  });
  assert.equal(child.status, expected, `git ${args.join(" ")} returned ${child.status}`);
  return child.stdout.trim();
}

function writeFile(repository, relativePath, value) {
  const file = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function commit(repository, message) {
  git(repository, ["add", "--all"]);
  git(repository, ["commit", "-q", "-m", message]);
  return { sha: git(repository, ["rev-parse", "HEAD"]), tree: git(repository, ["rev-parse", "HEAD^{tree}"]) };
}

function subjectRepository() {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-r3-git-"));
  git(repository, ["init", "-q"]);
  git(repository, ["config", "user.name", "SDE QE R3 Fixture"]);
  git(repository, ["config", "user.email", "sde-qe-r3@example.invalid"]);
  writeFile(repository, "data/api_idag.json", '{"date":"2026-08-08"}\n');
  writeFile(repository, "data/api_imorgen.json", '{"date":"2026-08-09"}\n');
  writeFile(repository, "data/sde-data-provenance.json", '{"schema":"synthetic-r3"}\n');
  writeFile(repository, "src/subject.js", "export const subject = 1;\n");
  const approved = commit(repository, "R3 approved subject");

  writeFile(repository, "data/api_idag.json", '{"date":"2026-08-08","revision":1}\n');
  const dataOne = commit(repository, "R3 data-only one");
  writeFile(repository, "data/api_imorgen.json", '{"date":"2026-08-09","revision":2}\n');
  const dataTwo = commit(repository, "R3 data-only two");

  git(repository, ["checkout", "-q", "--detach", approved.sha]);
  writeFile(repository, "src/subject.js", "export const subject = 2;\n");
  const code = commit(repository, "R3 code change");

  git(repository, ["checkout", "-q", "--detach", approved.sha]);
  writeFile(repository, "README.md", "independent R3 branch\n");
  const nonAncestor = commit(repository, "R3 non-ancestor");

  git(repository, ["checkout", "-q", "--detach", dataTwo.sha]);
  git(repository, ["merge", "-q", "--no-ff", "-m", "R3 ambiguous merge", code.sha]);
  const merge = { sha: git(repository, ["rev-parse", "HEAD"]), tree: git(repository, ["rev-parse", "HEAD^{tree}"]) };
  git(repository, ["checkout", "-q", "--detach", approved.sha]);
  return { repository, approved, dataOne, dataTwo, code, nonAncestor, merge };
}

const SUBJECT = subjectRepository();
process.on("exit", () => fs.rmSync(SUBJECT.repository, { recursive: true, force: true }));

function writeJson(file, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, raw);
  return raw;
}

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function validLive(runId) {
  const source = path.join(ROOT, "tests/sde-quality-engine/fixtures/multiuser/live-observations.json");
  const live = JSON.parse(fs.readFileSync(source, "utf8"));
  live.collectionRunId = runId;
  live.observedAt = FIXED_NOW.toISOString();
  return live;
}

function validIsolated(runId) {
  const source = path.join(ROOT, "tests/sde-quality-engine/fixtures/multiuser/isolated-write-results.json");
  const isolated = JSON.parse(fs.readFileSync(source, "utf8"));
  isolated.collectionRunId = runId;
  isolated.environment.codeSha = SUBJECT.approved.sha;
  isolated.environment.codeTree = SUBJECT.approved.tree;
  return isolated;
}

function evidenceFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-r3-evidence-"));
  const runId = options.runId || `r3-${crypto.randomUUID()}`;
  const live = validLive(runId);
  const isolated = validIsolated(runId);
  const livePath = path.join(directory, "live-observations.json");
  const isolatedPath = path.join(directory, "isolated-write-results.json");
  const manifestPath = path.join(directory, "evidence-package.json");
  writeJson(livePath, live);
  writeJson(isolatedPath, isolated);
  const manifest = buildEvidenceManifest({
    livePath,
    isolatedPath,
    outputPath: manifestPath,
    approvedSha: SUBJECT.approved.sha,
    approvedTree: SUBJECT.approved.tree,
    subjectRepository: options.subjectRepository || SUBJECT.repository,
    runtimeSha: options.runtimeSha || SUBJECT.approved.sha,
    now: FIXED_NOW,
    collectionRunId: runId
  });
  if (options.mutateManifest) options.mutateManifest(manifest);
  manifest.manifest.payloadSha256 = manifestHash(manifest);
  writeJson(manifestPath, manifest);
  const rewriteLive = () => {
    const raw = writeJson(livePath, live);
    const reference = manifest.artifacts.find((item) => item.kind === "live-observations");
    reference.sha256 = sha256(raw);
    reference.bytes = Buffer.byteLength(raw);
    manifest.manifest.payloadSha256 = manifestHash(manifest);
    writeJson(manifestPath, manifest);
  };
  const rewriteManifest = () => {
    manifest.manifest.payloadSha256 = manifestHash(manifest);
    writeJson(manifestPath, manifest);
  };
  const evaluate = (overrides = {}) => evaluateMultiuserEvidence({
    inputPath: manifestPath,
    approvedSha: overrides.approvedSha || SUBJECT.approved.sha,
    approvedTree: overrides.approvedTree || SUBJECT.approved.tree,
    subjectRepository: Object.hasOwn(overrides, "subjectRepository") ? overrides.subjectRepository : SUBJECT.repository,
    now: FIXED_NOW
  });
  return { directory, live, isolated, manifest, manifestPath, rewriteLive, rewriteManifest, evaluate };
}

function cleanup(value) {
  fs.rmSync(value.directory, { recursive: true, force: true });
}

function secretValue(category) {
  const material = crypto.createHash("sha256").update(`r3-${category}`).digest("hex").slice(0, 28);
  const values = {
    password: `password=PW_${material}`,
    one_time_code: `oneTimeCode=OTP_${material}`,
    credential_login_link: `https://login.example.invalid/continue?credential=${material}`,
    cookie: `cookie=SID_${material}`,
    cookie_hash: `cookieHash=${material}`,
    session_cookie: `sessionCookie=SESSION_${material}`,
    access_token: `access_token=ACCESS_${material}`,
    token_hash: `tokenHash=${material}`,
    jwt: `eyJ${material}.eyJ${material}.sig${material}`,
    authorization_header: `Authorization: Basic ${material}`,
    raw_har_credentials: `rawHAR={headers:[{name:Authorization,value:Basic_${material}}]}`,
    cloudflared_token: `cloudflared-token=${material}`,
    generic_api_secret: `api_secret=API_${material}`
  };
  return values[category];
}

const secretCases = [
  ["S-01", "password"],
  ["S-02", "one_time_code"],
  ["S-03", "credential_login_link"],
  ["S-04", "cookie"],
  ["S-05", "cookie_hash"],
  ["S-06", "session_cookie"],
  ["S-07", "access_token"],
  ["S-08", "token_hash"],
  ["S-09", "jwt"],
  ["S-10", "authorization_header"],
  ["S-11", "raw_har_credentials"],
  ["S-12", "cloudflared_token"],
  ["S-13", "generic_api_secret"]
];

function rejectionReport(gate) {
  const evaluatorSha = git(ROOT, ["rev-parse", "HEAD"]);
  const evaluatorTree = git(ROOT, ["rev-parse", "HEAD^{tree}"]);
  return {
    schemaVersion: "1.0.0",
    runId: "r3-secret-rejection",
    generatedAt: FIXED_NOW.toISOString(),
    suite: "multiuser",
    git: { commit: evaluatorSha, branch: "test", baseline: evaluatorSha, clean: true, changedFiles: [] },
    identityBindings: {
      evaluator: { candidateSha: evaluatorSha, candidateTree: evaluatorTree, parentSha: git(ROOT, ["rev-parse", "HEAD^"]), repository: ROOT, worktreeStatus: "CLEAN" },
      evidenceProducer: null,
      subject: { mode: "SYNTHETIC_GIT_FIXTURE", repository: SUBJECT.repository, approvedSha: SUBJECT.approved.sha, approvedTree: SUBJECT.approved.tree },
      contractQualification: gate.status,
      productionMultiuserLiveStatus: "NOT_EVALUATED"
    },
    results: [gate],
    summary: summarize([gate]),
    functionMatrix: [],
    commands: [],
    productionSafety: { allowedMethods: ["GET", "HEAD"], ledger: [], guardVerified: true },
    recommendations: []
  };
}

for (const [id, category] of secretCases) {
  test(`${id} ${category} avvises uten verdi i gateoutput`, () => {
    const value = evidenceFixture({ runId: `secret-${id}` });
    const secret = secretValue(category);
    value.live.networkSummaryRef = secret;
    value.rewriteLive();
    const gate = value.evaluate();
    assert.equal(gate.status, "RED");
    assert.equal(gate.reasonCode, "MULTIUSER_SECRET_FOUND");
    const report = rejectionReport(gate);
    for (const output of [JSON.stringify(report), renderHtml(report), renderJUnit(report), fs.readFileSync(value.manifestPath, "utf8")]) {
      assert.equal(output.includes(secret), false);
    }
    const cliOutput = path.join(value.directory, `cli-${id}.json`);
    const cli = spawnSync(process.execPath, [
      path.join(ROOT, "tests/sde-quality-engine/tools/build-multiuser-evidence.cjs"),
      "--live", path.join(value.directory, "live-observations.json"),
      "--isolated", path.join(value.directory, "isolated-write-results.json"),
      "--output", cliOutput,
      "--approved-sha", SUBJECT.approved.sha,
      "--approved-tree", SUBJECT.approved.tree,
      "--subject-repository", SUBJECT.repository
    ], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: os.tmpdir(), LC_ALL: "C" }
    });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout.includes(secret), false);
    assert.equal(cli.stderr.includes(secret), false);
    assert.equal(fs.existsSync(cliOutput), false);
    cleanup(value);
  });
}

test("S-15 HAR-lignende name/value-struktur avvises kontekstsensitivt", () => {
  const value = evidenceFixture({ runId: "structured-har-secret" });
  const secret = `Basic ${crypto.randomBytes(24).toString("hex")}`;
  value.live.harProbe = {
    log: {
      entries: [{ request: { headers: [{ name: "Authorization", value: secret }] } }]
    }
  };
  value.rewriteLive();
  const gate = value.evaluate();
  assert.equal(gate.status, "RED");
  assert.equal(gate.reasonCode, "MULTIUSER_SECRET_FOUND");
  assert.equal(JSON.stringify(gate).includes(secret), false);
  cleanup(value);
});

test("S-14 legitime artifact-, commit- og tree-hasher passerer", () => {
  const value = evidenceFixture({ runId: "legitimate-hashes" });
  const gate = value.evaluate();
  assert.equal(gate.status, "GREEN");
  assert.match(value.manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(value.manifest.codeIdentity.approvedSha, SUBJECT.approved.sha);
  assert.equal(value.manifest.codeIdentity.approvedTree, SUBJECT.approved.tree);
  cleanup(value);
});

test("G-01 oppdiktet approved commit blir BLOCKED", () => {
  const fake = "f".repeat(40);
  const value = evidenceFixture({ mutateManifest: (manifest) => { manifest.codeIdentity.approvedSha = fake; } });
  const gate = value.evaluate({ approvedSha: fake });
  assert.notEqual(gate.status, "GREEN");
  assert.equal(gate.reasonCode, "MULTIUSER_GIT_OBJECT_MISSING");
  cleanup(value);
});

test("G-02 oppdiktet runtime commit blir BLOCKED", () => {
  const value = evidenceFixture({ mutateManifest: (manifest) => { manifest.codeIdentity.runtimeHead = "e".repeat(40); } });
  const gate = value.evaluate();
  assert.notEqual(gate.status, "GREEN");
  assert.equal(gate.reasonCode, "MULTIUSER_GIT_OBJECT_MISSING");
  cleanup(value);
});

test("G-03 faktisk commit med feil rapportert tree blir BLOCKED", () => {
  const value = evidenceFixture({ mutateManifest: (manifest) => { manifest.codeIdentity.runtimeTree = "9".repeat(40); } });
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_CODE_TREE_MISMATCH");
  cleanup(value);
});

test("G-04 to reelle commits uten ancestry blir BLOCKED", () => {
  const value = evidenceFixture({ mutateManifest: (manifest) => {
    manifest.codeIdentity.approvedSha = SUBJECT.dataTwo.sha;
    manifest.codeIdentity.approvedTree = SUBJECT.dataTwo.tree;
    manifest.codeIdentity.runtimeHead = SUBJECT.nonAncestor.sha;
    manifest.codeIdentity.runtimeTree = SUBJECT.nonAncestor.tree;
    manifest.codeIdentity.ancestry = [];
  } });
  assert.equal(value.evaluate({ approvedSha: SUBJECT.dataTwo.sha, approvedTree: SUBJECT.dataTwo.tree }).reasonCode, "MULTIUSER_ANCESTRY_UNPROVEN");
  cleanup(value);
});

test("G-05 reell descendant med kodeendring blir BLOCKED", () => {
  const value = evidenceFixture({ mutateManifest: (manifest) => {
    manifest.codeIdentity.runtimeHead = SUBJECT.code.sha;
    manifest.codeIdentity.runtimeTree = SUBJECT.code.tree;
    manifest.codeIdentity.ancestry = [{ sha: SUBJECT.code.sha, changedFiles: ["src/subject.js"] }];
  } });
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_DESCENDANT_NOT_DATA_ONLY");
  cleanup(value);
});

test("G-06 reell to-commit data-only descendant blir GREEN", () => {
  const value = evidenceFixture({ runtimeSha: SUBJECT.dataTwo.sha });
  const gate = value.evaluate();
  assert.equal(gate.status, "GREEN");
  assert.equal(gate.details.subjectIdentity.ancestryVerified, true);
  assert.equal(gate.details.subjectIdentity.dataOnlyScopeVerified, true);
  cleanup(value);
});

test("G-07 reell approved commit som runtime blir GREEN", () => {
  const value = evidenceFixture();
  assert.equal(value.evaluate().status, "GREEN");
  cleanup(value);
});

test("G-08 selvdeklarert code/asset-hash uten objektbevis blir BLOCKED", () => {
  const value = evidenceFixture();
  value.manifest.codeIdentity.codeAssetHashes.runtime = "7".repeat(64);
  value.rewriteManifest();
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_CODE_ASSET_HASH_MISMATCH");
  cleanup(value);
});

test("G-09 manglende trusted repository input blir BLOCKED", () => {
  const value = evidenceFixture();
  assert.equal(value.evaluate({ subjectRepository: null }).reasonCode, "MULTIUSER_SUBJECT_REPOSITORY_MISSING");
  cleanup(value);
});

test("G-10 evidens kan ikke velge trusted repository", () => {
  const value = evidenceFixture();
  value.manifest.subjectRepository = SUBJECT.repository;
  value.rewriteManifest();
  assert.equal(value.evaluate().reasonCode, "MULTIUSER_SCHEMA_UNKNOWN_FIELD");
  cleanup(value);
});

test("G-11 shallow trusted repository feiler lukket", () => {
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "sde-qe-r3-shallow-"));
  fs.rmSync(shallow, { recursive: true, force: true });
  const sourceUrl = `file://${SUBJECT.repository}`;
  const child = spawnSync("git", ["clone", "-q", "--depth", "1", sourceUrl, shallow], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0);
  const value = evidenceFixture();
  assert.equal(value.evaluate({ subjectRepository: shallow }).reasonCode, "MULTIUSER_GIT_HISTORY_INCOMPLETE");
  cleanup(value);
  fs.rmSync(shallow, { recursive: true, force: true });
});

test("G-12 tvetydig mergehistorikk feiler lukket", () => {
  assert.throws(() => evidenceFixture({ runtimeSha: SUBJECT.merge.sha }), (error) => error.reasonCode === "MULTIUSER_GIT_HISTORY_AMBIGUOUS");
});

function sampleBoundReport(gate) {
  const evaluatorSha = git(ROOT, ["rev-parse", "HEAD"]);
  const evaluatorTree = git(ROOT, ["rev-parse", "HEAD^{tree}"]);
  const evaluatorParent = git(ROOT, ["rev-parse", "HEAD^"]);
  return {
    schemaVersion: "1.0.0",
    runId: "r3-binding-unit",
    generatedAt: FIXED_NOW.toISOString(),
    suite: "multiuser",
    git: { commit: evaluatorSha, branch: "test", baseline: evaluatorSha, clean: true, changedFiles: [] },
    identityBindings: {
      evaluator: { candidateSha: evaluatorSha, candidateTree: evaluatorTree, parentSha: evaluatorParent, repository: ROOT, worktreeStatus: "CLEAN" },
      evidenceProducer: gate.details.producerIdentity,
      subject: {
        mode: "SYNTHETIC_GIT_FIXTURE",
        repository: gate.details.subjectIdentity.subjectRepository,
        approvedSha: gate.details.subjectIdentity.approvedSha,
        approvedTree: gate.details.subjectIdentity.approvedTree,
        runtimeSha: gate.details.subjectIdentity.runtimeSha,
        runtimeTree: gate.details.subjectIdentity.runtimeTree,
        ancestryVerified: true,
        dataOnlyScopeVerified: true
      },
      contractQualification: "GREEN",
      productionMultiuserLiveStatus: "NOT_EVALUATED"
    },
    results: [gate],
    summary: summarize([gate]),
    functionMatrix: [],
    commands: [],
    productionSafety: { allowedMethods: ["GET", "HEAD"], ledger: [], guardVerified: true },
    recommendations: []
  };
}

test("B-01 evaluator, subject og producer har eksplisitt separate identiteter", () => {
  const value = evidenceFixture();
  const report = sampleBoundReport(value.evaluate());
  assert.equal(report.identityBindings.evaluator.candidateSha, git(ROOT, ["rev-parse", "HEAD"]));
  assert.equal(report.identityBindings.subject.approvedSha, SUBJECT.approved.sha);
  assert.equal(report.identityBindings.evidenceProducer.id, "sde-qe-multiuser-evidence-pack-builder");
  cleanup(value);
});

test("B-02 synthetic subject er merket og production live er NOT_EVALUATED", () => {
  const value = evidenceFixture();
  const bindings = sampleBoundReport(value.evaluate()).identityBindings;
  assert.equal(bindings.subject.mode, "SYNTHETIC_GIT_FIXTURE");
  assert.equal(bindings.contractQualification, "GREEN");
  assert.equal(bindings.productionMultiuserLiveStatus, "NOT_EVALUATED");
  cleanup(value);
});

test("B-03 JSON HTML og JUnit eksponerer samme evaluator SHA/tree", () => {
  const value = evidenceFixture();
  const report = sampleBoundReport(value.evaluate());
  const html = renderHtml(report);
  const junit = renderJUnit(report);
  const embedded = JSON.parse(html.match(/<script id="sde-identity-bindings" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(embedded.evaluator.candidateSha, report.identityBindings.evaluator.candidateSha);
  assert.equal(embedded.evaluator.candidateTree, report.identityBindings.evaluator.candidateTree);
  assert.match(junit, new RegExp(`evaluatorCandidateSha" value="${report.identityBindings.evaluator.candidateSha}`));
  assert.match(junit, new RegExp(`evaluatorCandidateTree" value="${report.identityBindings.evaluator.candidateTree}`));
  cleanup(value);
});

test("B-04 kandidatbinding bruker ingen placeholderidentitet", () => {
  const value = evidenceFixture();
  const rendered = JSON.stringify(sampleBoundReport(value.evaluate()).identityBindings);
  assert.doesNotMatch(rendered, /a{40}|b{40}/);
  cleanup(value);
});

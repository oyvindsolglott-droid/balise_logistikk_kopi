"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { expectedOperationalDates } = require("../lib/core.cjs");

let dataRoot = {};
try {
  dataRoot = require("../lib/data-root.cjs");
} catch (_error) {
  // The first RED run deliberately records missing contract functions as named tests.
}

const MANIFEST_FILE = ".sde-qe-data-fixture.json";
const NOW = new Date("2026-08-11T08:00:00.000Z");
const CONTRACT = require("../fixtures/balise-freshness-contract.json");
const EXPECTED = expectedOperationalDates(NOW, CONTRACT);
const temporaryRoots = [];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function temporary(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function git(repository, args, options = {}) {
  const result = childProcess.spawnSync("git", args, {
    cwd: repository,
    encoding: options.binary ? null : "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "SDE QE fixture",
      GIT_AUTHOR_EMAIL: "sde-qe@example.invalid",
      GIT_COMMITTER_NAME: "SDE QE fixture",
      GIT_COMMITTER_EMAIL: "sde-qe@example.invalid"
    }
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.error || "failed"}`);
  return options.binary ? result.stdout : result.stdout.trim();
}

function payload(mode, date, updatedAt) {
  return Buffer.from(JSON.stringify({
    ok: true,
    updatedAt,
    mode,
    date,
    arrivals: {},
    departures: {},
    departureOccurrences: {}
  }, null, 2));
}

function writeGeneration(repository, {fresh = true, invalidProvenance = false, generationId = "11111111-2222-4333-8444-555555555555"} = {}) {
  const idag = payload("idag", fresh ? EXPECTED.idag : "2026-08-10", fresh ? "11.08.2026 07:30:00" : "10.08.2026 07:30:00");
  const imorgen = payload("imorgen", fresh ? EXPECTED.imorgen : "2026-08-10", fresh ? "11.08.2026 07:31:00" : "10.08.2026 07:31:00");
  fs.writeFileSync(path.join(repository, "data/api_idag.json"), idag);
  fs.writeFileSync(path.join(repository, "data/api_imorgen.json"), imorgen);
  const manifest = {
    schema: "sde-data-provenance/v1",
    generationId,
    timeZone: "Europe/Oslo",
    intendedCycle: {
      id: "2026-08-11T07:00@Europe/Oslo",
      date: "2026-08-11",
      hour: "7"
    },
    source: {snapshotStable: true},
    datasets: {
      idag: {
        path: "data/api_idag.json",
        operationalDate: fresh ? EXPECTED.idag : "2026-08-10",
        sha256: invalidProvenance ? "0".repeat(64) : sha256(idag),
        bytes: idag.length
      },
      imorgen: {
        path: "data/api_imorgen.json",
        operationalDate: fresh ? EXPECTED.imorgen : "2026-08-10",
        sha256: sha256(imorgen),
        bytes: imorgen.length
      }
    }
  };
  fs.writeFileSync(path.join(repository, "data/sde-data-provenance.json"), JSON.stringify(manifest, null, 2));
}

function makeRepository(options = {}) {
  const repository = temporary("sde-qe-data-source.");
  fs.mkdirSync(path.join(repository, "data"), {recursive: true});
  fs.mkdirSync(path.join(repository, "tests/sde-quality-engine/fixtures"), {recursive: true});
  fs.writeFileSync(
    path.join(repository, "tests/sde-quality-engine/fixtures/balise-freshness-contract.json"),
    `${JSON.stringify(CONTRACT, null, 2)}\n`
  );
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  writeGeneration(repository, {fresh: false, generationId: "00000000-1111-4222-8333-444444444444"});
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "candidate baseline"]);
  const candidateSha = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["branch", "candidate", candidateSha]);
  writeGeneration(repository, {
    fresh: options.fresh !== false,
    invalidProvenance: options.invalidProvenance,
    generationId: "11111111-2222-4333-8444-555555555555"
  });
  git(repository, ["add", "data/api_idag.json", "data/api_imorgen.json", "data/sde-data-provenance.json"]);
  git(repository, ["commit", "-m", "fresh data"]);
  if (options.nonDataCommit) {
    fs.writeFileSync(path.join(repository, "README.md"), "unexpected\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "non-data change"]);
  }
  return {repository, candidateSha, sourceCommit: git(repository, ["rev-parse", "main"])};
}

function api(name) {
  assert.equal(typeof dataRoot[name], "function", `data-root contract must export ${name}`);
  return dataRoot[name];
}

function materialize(source = makeRepository(), now = NOW) {
  const outputRoot = path.join(temporary("sde-qe-data-output."), "fixture");
  const result = api("materializeDataFixture")({
    sourceRepository: source.repository,
    sourceRef: "refs/heads/main",
    consumerCandidateSha: source.candidateSha,
    outputRoot,
    now
  });
  return {...source, outputRoot, result};
}

function fixtureCopy(fixture) {
  const destination = path.join(temporary("sde-qe-data-copy."), "fixture");
  api("materializeDataFixture")({
    sourceRepository: fixture.repository,
    sourceRef: "refs/heads/main",
    consumerCandidateSha: fixture.candidateSha,
    outputRoot: destination,
    now: NOW
  });
  fs.chmodSync(destination, 0o700);
  for (const file of [MANIFEST_FILE, "api_idag.json", "api_imorgen.json", "sde-data-provenance.json"]) {
    fs.chmodSync(path.join(destination, file), 0o600);
  }
  return destination;
}

function rewriteManifest(root, mutate) {
  const file = path.join(root, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(manifest);
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

test.after(() => {
  const restore = (root) => {
    if (!fs.existsSync(root)) return;
    fs.chmodSync(root, 0o700);
    for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
      const target = path.join(root, entry.name);
      if (entry.isDirectory()) restore(target);
      else if (!entry.isSymbolicLink()) fs.chmodSync(target, 0o600);
    }
  };
  for (const root of temporaryRoots.reverse()) {
    restore(root);
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("default mode preserves repository data semantics when SDE_QE_DATA_ROOT is absent", () => {
  const repository = temporary("sde-qe-default.");
  const observed = api("resolveDataRoot")({repositoryRoot: repository, env: {}});
  assert.deepEqual(observed, {mode: "DEFAULT", root: path.join(repository, "data"), fixtureId: null, manifest: null});
});

test("materializer copies the exact three source-ref blobs without mutating tracked data", () => {
  const source = makeRepository();
  const before = git(source.repository, ["status", "--porcelain=v1"]);
  const blobsBefore = ["api_idag.json", "api_imorgen.json", "sde-data-provenance.json"]
    .map((file) => git(source.repository, ["rev-parse", `${source.candidateSha}:data/${file}`]));
  const fixture = materialize(source);
  assert.equal(git(source.repository, ["status", "--porcelain=v1"]), before);
  assert.deepEqual(
    ["api_idag.json", "api_imorgen.json", "sde-data-provenance.json"]
      .map((file) => git(source.repository, ["rev-parse", `${source.candidateSha}:data/${file}`])),
    blobsBefore
  );
  assert.equal(fs.statSync(fixture.outputRoot).mode & 0o777, 0o500);
  assert.equal(fixture.result.manifest.sourceCommit, source.sourceCommit);
  assert.equal(fixture.result.manifest.consumerCandidateSha, source.candidateSha);
  assert.deepEqual(fixture.result.manifest.files.map((entry) => entry.sourcePath), [
    "data/api_idag.json",
    "data/api_imorgen.json",
    "data/sde-data-provenance.json"
  ]);
  for (const entry of fixture.result.manifest.files) {
    const expected = git(source.repository, ["show", `${source.sourceCommit}:${entry.sourcePath}`], {binary: true});
    assert.deepEqual(fs.readFileSync(path.join(fixture.outputRoot, entry.logicalName)), expected);
  }
});

test("explicit root validates manifest identity and reads only allowlisted logical files", () => {
  const fixture = materialize();
  const observed = api("resolveDataRoot")({
    repositoryRoot: fixture.repository,
    dataRoot: fixture.outputRoot,
    candidateSha: fixture.candidateSha,
    now: NOW
  });
  assert.equal(observed.mode, "ISOLATED_FRESH_DATA");
  assert.equal(observed.fixtureId, fixture.result.fixtureId);
  assert.equal(api("readDataJson")("api_idag.json", {resolved: observed}).date, EXPECTED.idag);
  assert.throws(() => api("readDataJson")("../README.md", {resolved: observed}), /allowlist|logical/i);
});

test("baseline and candidate use one fixture ID, hashes and root propagated unchanged to child processes", () => {
  const fixture = materialize();
  const first = api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: fixture.outputRoot, candidateSha: fixture.candidateSha, now: NOW});
  const second = api("resolveDataRoot")({repositoryRoot: fixture.repository, env: api("dataRootEnvironment")(first), candidateSha: fixture.candidateSha, now: new Date(NOW.getTime() + 1_000)});
  assert.equal(second.root, first.root);
  assert.equal(second.fixtureId, first.fixtureId);
  assert.deepEqual(second.manifest.files, first.manifest.files);
  const child = childProcess.spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.SDE_QE_DATA_ROOT||'')"], {
    encoding: "utf8",
    env: {...process.env, ...api("dataRootEnvironment")(first)}
  });
  assert.equal(child.stdout, first.root);
});

test("explicit mode fails closed for missing or invalid manifests", () => {
  const fixture = materialize();
  const missing = fixtureCopy(fixture);
  fs.unlinkSync(path.join(missing, MANIFEST_FILE));
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: missing, candidateSha: fixture.candidateSha, now: NOW}), /manifest/i);
  const invalid = fixtureCopy(fixture);
  fs.writeFileSync(path.join(invalid, MANIFEST_FILE), "not-json");
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: invalid, candidateSha: fixture.candidateSha, now: NOW}), /JSON|manifest/i);
  const missingData = fixtureCopy(fixture);
  fs.unlinkSync(path.join(missingData, "api_imorgen.json"));
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: missingData, candidateSha: fixture.candidateSha, now: NOW}), /file|regular|missing|unsafe/i);
  const unknownSchema = fixtureCopy(fixture);
  rewriteManifest(unknownSchema, (manifest) => { manifest.schema = "unknown/v1"; });
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: unknownSchema, candidateSha: fixture.candidateSha, now: NOW}), /schema/i);
});

test("explicit mode rejects source commit, tree and consumer identity mismatches", () => {
  const fixture = materialize();
  for (const [field, value] of [["sourceCommit", "a".repeat(40)], ["sourceTree", "b".repeat(40)], ["consumerCandidateSha", "c".repeat(40)]]) {
    const root = fixtureCopy(fixture);
    rewriteManifest(root, (manifest) => { manifest[field] = value; });
    assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: root, candidateSha: fixture.candidateSha, now: NOW}), new RegExp(field, "i"));
  }
});

test("explicit mode rejects byte-hash and Git-blob mismatches", () => {
  const fixture = materialize();
  const root = fixtureCopy(fixture);
  fs.appendFileSync(path.join(root, "api_idag.json"), " ");
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: root, candidateSha: fixture.candidateSha, now: NOW}), /hash|byte|blob/i);
  const hashRoot = fixtureCopy(fixture);
  rewriteManifest(hashRoot, (manifest) => { manifest.files[0].sha256 = "0".repeat(64); });
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: hashRoot, candidateSha: fixture.candidateSha, now: NOW}), /hash|byte|blob/i);
  const blobRoot = fixtureCopy(fixture);
  rewriteManifest(blobRoot, (manifest) => { manifest.files[0].blobObjectId = "a".repeat(40); });
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: blobRoot, candidateSha: fixture.candidateSha, now: NOW}), /hash|byte|blob/i);
});

test("explicit mode rejects symlink escapes and non-normalized root paths", () => {
  const fixture = materialize();
  const root = fixtureCopy(fixture);
  fs.unlinkSync(path.join(root, "api_idag.json"));
  fs.symlinkSync(path.join(fixture.repository, "data/api_idag.json"), path.join(root, "api_idag.json"));
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: root, candidateSha: fixture.candidateSha, now: NOW}), /symlink|regular|escape/i);
  assert.throws(() => api("resolveDataRoot")({repositoryRoot: fixture.repository, dataRoot: `${fixture.outputRoot}/../${path.basename(fixture.outputRoot)}`, candidateSha: fixture.candidateSha, now: NOW}), /normal|canonical|path/i);
});

test("materializer rejects source-only history containing non-data changes", () => {
  const source = makeRepository({nonDataCommit: true});
  assert.throws(() => materialize(source), /data-only|non-data|allowlist/i);
});

test("materializer rejects stale operational dates at the current Europe/Oslo boundary", () => {
  const source = makeRepository({fresh: false});
  assert.throws(() => materialize(source), /stale|operational date|fresh/i);
});

test("materializer rejects provenance whose dataset identity differs from exact bytes", () => {
  const source = makeRepository({invalidProvenance: true});
  assert.throws(() => materialize(source), /provenance|hash/i);
});

test("the three QE readers share the data-root boundary instead of hardcoded data paths", () => {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  for (const file of ["checks.cjs", "balise-parity.cjs", "provenance.cjs"]) {
    const source = fs.readFileSync(path.join(repositoryRoot, "tests/sde-quality-engine/lib", file), "utf8");
    assert.match(source, /require\(["']\.\/data-root\.cjs["']\)/, file);
    assert.doesNotMatch(source, /path\.join\(root, ["']data\/(?:api_idag|api_imorgen|sde-data-provenance)\.json["']\)/, file);
  }
});

test("pre-push materializes origin/main once and exports the root through the shared child environment", () => {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const source = fs.readFileSync(path.join(repositoryRoot, "scripts/sde-prepush-gate.cjs"), "utf8");
  assert.match(source, /materializeDataFixture\(\{/);
  assert.match(source, /sourceRef:\s*["']refs\/remotes\/origin\/main["']/);
  assert.match(source, /SDE_QE_DATA_ROOT:\s*dataRoot/);
  assert.match(source, /executeFullProfile\([^\n]+dataFixture\)/);
  assert.match(source, /run\(command, args, \{cwd: candidateRoot, env, timeoutMs\}\)/);
  assert.match(source, /\["mutation-audit", "npm", \["run", "test:sde:mutations"\]/);
  const helper = fs.readFileSync(path.join(repositoryRoot, "tests/sde-quality-engine/lib/data-root.cjs"), "utf8");
  assert.doesNotMatch(helper, /readdir(?:Sync)?\(/, "data-root must not enumerate arbitrary directory entries");
});

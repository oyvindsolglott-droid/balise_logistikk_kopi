"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../..");
const RUNNER = path.join(ROOT, "scripts/sde-prepush-gate.cjs");
const HOOK = path.join(ROOT, ".githooks/pre-push");
const REPORT_SCHEMA = path.join(ROOT, "tests/sde-quality-engine/contracts/sde-prepush-gate-report-v1.schema.json");
const gate = require(RUNNER);

const BASE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "SDE Gate Test",
  GIT_AUTHOR_EMAIL: "sde-gate@example.invalid",
  GIT_COMMITTER_NAME: "SDE Gate Test",
  GIT_COMMITTER_EMAIL: "sde-gate@example.invalid"
};

function command(commandName, args, options = {}) {
  const result = childProcess.spawnSync(commandName, args, {
    cwd: options.cwd,
    env: {...BASE_ENV, ...(options.env || {})},
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout || 120_000,
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    ...result,
    output: `${result.stdout || ""}${result.stderr || ""}`
  };
}

function must(commandName, args, options = {}) {
  const result = command(commandName, args, options);
  assert.equal(result.status, 0, `${commandName} ${args.join(" ")}\n${result.output}`);
  return String(result.stdout || "").trim();
}

function git(cwd, ...args) {
  return must("git", args, {cwd});
}

function write(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, value, {mode});
  fs.chmodSync(file, mode);
}

function commitFile(repository, name, value, message) {
  write(path.join(repository, name), value);
  git(repository, "add", name);
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function fixture(options = {}) {
  const directory = fs.mkdtempSync("/private/tmp/sde-prepush-contract.");
  const repository = path.join(directory, "repository");
  const remote = path.join(directory, "remote.git");
  fs.mkdirSync(repository);
  must("git", ["init", "--bare", remote], {cwd: directory});
  must("git", ["init", "-b", "main"], {cwd: repository});
  git(repository, "config", "user.name", "SDE Gate Test");
  git(repository, "config", "user.email", "sde-gate@example.invalid");
  fs.mkdirSync(path.join(repository, ".githooks"));
  fs.mkdirSync(path.join(repository, "scripts"));
  fs.copyFileSync(HOOK, path.join(repository, ".githooks/pre-push"));
  fs.copyFileSync(RUNNER, path.join(repository, "scripts/sde-prepush-gate.cjs"));
  fs.chmodSync(path.join(repository, ".githooks/pre-push"), 0o755);
  fs.chmodSync(path.join(repository, "scripts/sde-prepush-gate.cjs"), 0o755);
  write(path.join(repository, "README.md"), "# disposable SDE pre-push fixture\n");
  git(repository, "add", ".githooks/pre-push", "scripts/sde-prepush-gate.cjs", "README.md");
  git(repository, "commit", "-m", "fixture baseline");
  const baseline = git(repository, "rev-parse", "HEAD");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "origin", "refs/heads/main:refs/heads/main");
  if (options.unknownHook) {
    const defaultHook = path.join(repository, ".git/hooks/pre-push");
    write(defaultHook, "#!/bin/sh\nprintf '%s\\n' unknown-hook >&2\nexit 1\n", 0o700);
  }
  return {directory, repository, remote, baseline};
}

function install(repository) {
  return command(process.execPath, ["scripts/sde-prepush-gate.cjs", "install"], {cwd: repository});
}

function testEnvironment(profile) {
  return {SDE_PREPUSH_TESTING: "1", SDE_PREPUSH_TEST_PROFILE: profile};
}

function push(repository, refspecs, profile = "GREEN") {
  return command("git", ["push", "origin", ...refspecs], {cwd: repository, env: testEnvironment(profile), timeout: 120_000});
}

function requestId(output) {
  return output.match(/APPROVAL_REQUEST_ID:\s*([0-9a-f-]{36})/i)?.[1] || null;
}

function commonDirectory(repository) {
  return git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

function statePaths(repository) {
  const root = path.join(commonDirectory(repository), "sde-qe-prepush");
  return {
    root,
    runner: path.join(root, "runner.cjs"),
    hook: path.join(root, "hooks/pre-push"),
    manifest: path.join(root, "manifest.json"),
    pending: path.join(root, "state/pending"),
    approvals: path.join(root, "state/approvals"),
    consumed: path.join(root, "state/consumed"),
    reports: path.join(root, "reports")
  };
}

function approve(repository, id, candidate) {
  const paths = statePaths(repository);
  return command(process.execPath, [paths.runner, "approve", "--request-id", id, "--candidate", candidate], {cwd: repository});
}

function remoteSha(remote, ref) {
  const result = command("git", [`--git-dir=${remote}`, "rev-parse", "--verify", ref], {cwd: path.dirname(remote)});
  return result.status === 0 ? String(result.stdout).trim() : null;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function selfHash(value, excluded) {
  const copy = {...value};
  delete copy[excluded];
  return crypto.createHash("sha256").update(JSON.stringify(stable(copy))).digest("hex");
}

test("pre-push input, canonical remote and P0 approval authority fail closed", () => {
  const parsed = gate.parsePrePushInput(`refs/heads/topic ${"a".repeat(40)} refs/heads/topic ${"0".repeat(40)}\n`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].localRef, "refs/heads/topic");
  assert.equal(gate.canonicalRemoteUrl("https://user:pass@example.com/acme/repo.git?token=hidden", ROOT), "https://example.com/acme/repo.git");
  assert.equal(gate.p0Ready({status: "GREEN"}), true);
  assert.equal(gate.p0Ready({status: "BLOCKED", reasonCode: "LIVE_DATA_EVIDENCE_MISSING", details: {subgates: []}}), true);
  assert.equal(gate.p0Ready({status: "RED", reasonCode: "LIVE_DATA_OPERATIVE_DATE_MISMATCH", details: {subgates: []}}), false);
  assert.throws(() => gate.parsePrePushInput("malformed"), /Malformed/);
});

test("installer is idempotent, shared by worktrees, executable and cryptographically bound", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.directory, {recursive: true, force: true}));
  const first = install(item.repository);
  assert.equal(first.status, 0, first.output);
  const second = install(item.repository);
  assert.equal(second.status, 0, second.output);
  assert.equal(JSON.parse(second.stdout).idempotent, true);
  const paths = statePaths(item.repository);
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, "utf8"));
  assert.equal(manifest.gateId, gate.GATE_ID);
  assert.equal(manifest.gateVersion, gate.GATE_VERSION);
  assert.equal(manifest.testProfileVersion, gate.PROFILE_VERSION);
  assert.equal(fs.statSync(paths.hook).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.runner).mode & 0o777, 0o700);
  assert.equal(git(item.repository, "config", "--local", "--get", "core.hooksPath"), path.join(paths.root, "hooks"));

  const linked = path.join(item.directory, "linked-worktree");
  git(item.repository, "worktree", "add", "-b", "linked-check", linked, "main");
  const doctor = command(process.execPath, [paths.runner, "doctor"], {cwd: linked});
  assert.equal(doctor.status, 0, doctor.output);
  assert.equal(JSON.parse(doctor.stdout).status, "GREEN");
  commitFile(linked, "linked.txt", "linked candidate\n", "linked candidate");
  const linkedPush = push(linked, ["refs/heads/linked-check:refs/heads/linked-check"]);
  assert.notEqual(linkedPush.status, 0);
  assert.match(linkedPush.output, /FIRST_PUSH_ALWAYS_BLOCKED_PENDING_APPROVAL/);
  assert.equal(remoteSha(item.remote, "refs/heads/linked-check"), null);
});

test("unknown existing pre-push hook is preserved and installation holds", (t) => {
  const item = fixture({unknownHook: true});
  t.after(() => fs.rmSync(item.directory, {recursive: true, force: true}));
  const hookFile = path.join(item.repository, ".git/hooks/pre-push");
  const before = fs.readFileSync(hookFile, "utf8");
  const result = install(item.repository);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /EXISTING_PRE_PUSH_HOOK_CANNOT_BE_SAFELY_PRESERVED/);
  assert.equal(fs.readFileSync(hookFile, "utf8"), before);
  assert.equal(command("git", ["config", "--local", "--get", "core.hooksPath"], {cwd: item.repository}).status, 1);
});

test("candidate mutation check ignores only expected read-only mode bits", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.directory, {recursive: true, force: true}));
  const tracked = path.join(item.repository, "README.md");
  const dependencies = path.join(item.directory, "server-node-modules");
  fs.mkdirSync(dependencies);
  fs.mkdirSync(path.join(item.repository, "server"));
  fs.symlinkSync(dependencies, path.join(item.repository, "server", "node_modules"));
  fs.chmodSync(tracked, 0o400);
  assert.equal(gate.candidateMutationStatus(item.repository, item.baseline, dependencies).mutated, false);
  fs.unlinkSync(path.join(item.repository, "server", "node_modules"));
  fs.symlinkSync(path.join(item.directory, "wrong-dependencies"), path.join(item.repository, "server", "node_modules"));
  assert.equal(gate.candidateMutationStatus(item.repository, item.baseline, dependencies).mutated, true);
  fs.unlinkSync(path.join(item.repository, "server", "node_modules"));
  fs.symlinkSync(dependencies, path.join(item.repository, "server", "node_modules"));
  fs.chmodSync(tracked, 0o600);
  fs.appendFileSync(tracked, "content mutation\n");
  assert.equal(gate.candidateMutationStatus(item.repository, item.baseline, dependencies).mutated, true);
});

test("black-box push, one-time approval, invalidation and policy scenarios A-T", (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.directory, {recursive: true, force: true}));
  assert.equal(install(item.repository).status, 0);
  git(item.repository, "switch", "-c", "feature");
  const firstCandidate = commitFile(item.repository, "candidate.txt", "candidate one\n", "candidate one");
  const candidateSnapshot = git(item.repository, "status", "--porcelain=v1", "--untracked-files=all");

  const first = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  assert.notEqual(first.status, 0, first.output);
  assert.match(first.output, /PUSHED: FALSE/);
  const firstRequest = requestId(first.output);
  assert.ok(firstRequest, first.output);
  assert.equal(remoteSha(item.remote, "refs/heads/feature"), null);
  assert.equal(git(item.repository, "status", "--porcelain=v1", "--untracked-files=all"), candidateSnapshot);

  const approved = approve(item.repository, firstRequest, firstCandidate);
  assert.equal(approved.status, 0, approved.output);
  const second = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /ONE_TIME_APPROVAL_CONSUMED/);
  assert.equal(remoteSha(item.remote, "refs/heads/feature"), firstCandidate);

  const reuse = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  assert.notEqual(reuse.status, 0);
  assert.match(reuse.output, /NO_REFS_IN_PUSH/);

  const secondCandidate = commitFile(item.repository, "candidate.txt", "candidate two\n", "candidate two");
  const beforeChange = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  const changedRequest = requestId(beforeChange.output);
  assert.ok(changedRequest, beforeChange.output);
  assert.equal(approve(item.repository, changedRequest, secondCandidate).status, 0);
  const thirdCandidate = commitFile(item.repository, "candidate.txt", "candidate three\n", "candidate three");
  const changedAfterApproval = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  assert.notEqual(changedAfterApproval.status, 0);
  const remoteChangeRequest = requestId(changedAfterApproval.output);
  assert.ok(remoteChangeRequest, changedAfterApproval.output);
  assert.equal(remoteSha(item.remote, "refs/heads/feature"), firstCandidate);

  assert.equal(approve(item.repository, remoteChangeRequest, thirdCandidate).status, 0);
  git(item.repository, "branch", "remote-advance", secondCandidate);
  must("git", [`--git-dir=${item.remote}`, "fetch", item.repository, "refs/heads/remote-advance:refs/heads/feature"], {cwd: item.directory});
  assert.equal(remoteSha(item.remote, "refs/heads/feature"), secondCandidate);
  const remoteOldChanged = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  assert.notEqual(remoteOldChanged.status, 0);
  const expiryRequest = requestId(remoteOldChanged.output);
  assert.ok(expiryRequest, remoteOldChanged.output);

  assert.equal(approve(item.repository, expiryRequest, thirdCandidate).status, 0);
  const paths = statePaths(item.repository);
  const approvalFile = path.join(paths.approvals, `${expiryRequest}.json`);
  const expired = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  expired.approvalSha256 = selfHash(expired, "approvalSha256");
  write(approvalFile, `${JSON.stringify(expired, null, 2)}\n`, 0o600);
  const expiredPush = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  assert.notEqual(expiredPush.status, 0);
  assert.ok(requestId(expiredPush.output), expiredPush.output);

  const failingCandidate = commitFile(item.repository, "candidate.txt", "known failure\n", "known failure candidate");
  const knownFailure = push(item.repository, ["refs/heads/feature:refs/heads/feature"], "FAIL");
  assert.notEqual(knownFailure.status, 0);
  assert.equal(requestId(knownFailure.output), null);
  assert.equal(remoteSha(item.remote, "refs/heads/feature"), secondCandidate);

  const stale = push(item.repository, ["refs/heads/feature:refs/heads/feature"], "P0_STALE");
  assert.notEqual(stale.status, 0);
  assert.match(stale.output, /LIVE_DATA_OPERATIVE_DATE_MISMATCH/);
  assert.equal(requestId(stale.output), null);

  const external = push(item.repository, ["refs/heads/feature:refs/heads/feature"], "EXTERNAL_BLOCKED");
  assert.notEqual(external.status, 0);
  const externalRequest = requestId(external.output);
  assert.ok(externalRequest, external.output);

  const directMain = push(item.repository, ["refs/heads/feature:refs/heads/main"]);
  assert.notEqual(directMain.status, 0);
  assert.match(directMain.output, /DIRECT_MAIN_PUSH_BLOCKED/);
  assert.equal(remoteSha(item.remote, "refs/heads/main"), item.baseline);

  git(item.repository, "branch", "second-ref", failingCandidate);
  const multi = push(item.repository, ["refs/heads/feature:refs/heads/feature", "refs/heads/second-ref:refs/heads/second-ref"]);
  assert.notEqual(multi.status, 0);
  assert.match(multi.output, /MULTIPLE_REFS_BLOCKED/);
  assert.equal(remoteSha(item.remote, "refs/heads/second-ref"), null);

  fs.unlinkSync(path.join(paths.pending, `${externalRequest}.json`));
  const missingRuntime = push(item.repository, ["refs/heads/feature:refs/heads/feature"], "MISSING_RUNTIME");
  assert.notEqual(missingRuntime.status, 0);
  assert.match(missingRuntime.output, /TEST_FAILED:disposable-profile/);
  assert.equal(requestId(missingRuntime.output), null);

  const bypassText = ["#!/bin/sh", "git push " + "--no-" + "verify origin feature", ""].join("\n");
  write(path.join(item.repository, "unsafe-push.sh"), bypassText, 0o700);
  git(item.repository, "add", "unsafe-push.sh");
  git(item.repository, "commit", "-m", "known bypass policy failure");
  const bypass = push(item.repository, ["refs/heads/feature:refs/heads/feature"]);
  assert.notEqual(bypass.status, 0);
  assert.match(bypass.output, /TEST_FAILED:security-policy/);
  assert.equal(requestId(bypass.output), null);
  assert.equal(remoteSha(item.remote, "refs/heads/feature"), secondCandidate);

  const reports = fs.readdirSync(paths.reports).filter((name) => name.endsWith(".json"));
  assert.ok(reports.length >= 10);
  const machineReports = reports.map((name) => JSON.parse(fs.readFileSync(path.join(paths.reports, name), "utf8")));
  const firstReport = machineReports.find((report) => report.approvalRequestId === firstRequest && report.PUSHED === false);
  assert.ok(firstReport);
  assert.equal(firstReport.READY_FOR_BRANCH_PUSH_APPROVAL, true);
  assert.equal(firstReport.PUSHED, false);
  assert.equal(firstReport.autoFix, false);
  assert.equal(firstReport.activeSkips, 0);
  assert.equal(selfHash(firstReport, "reportSha256"), firstReport.reportSha256);
  assert.ok(machineReports.some((report) => report.PUSHED === true));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(REPORT_SCHEMA, "utf8")));

  for (const directory of [paths.pending, paths.approvals, paths.consumed, paths.reports]) {
    assert.equal(fs.statSync(directory).mode & 0o077, 0, directory);
    for (const name of fs.readdirSync(directory)) {
      assert.equal(fs.statSync(path.join(directory, name)).mode & 0o077, 0, `${directory}/${name}`);
    }
  }
});

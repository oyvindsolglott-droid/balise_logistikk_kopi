#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const GATE_ID = "SDE-QE-MANDATORY-PRE-PUSH";
const GATE_VERSION = "1.0.0";
const PROFILE_VERSION = "sde-qe-prepush-profile-v1";
const REPORT_SCHEMA = "sde-qe-prepush-report/v1";
const MANIFEST_SCHEMA = "sde-qe-prepush-install/v1";
const STATE_SCHEMA = "sde-qe-prepush-approval/v1";
const NULL_SHA = "0".repeat(40);
const MAX_APPROVAL_MS = 60 * 60 * 1000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const SOURCE_HOOK = ".githooks/pre-push";
const SOURCE_RUNNER = "scripts/sde-prepush-gate.cjs";
const MANAGED_MARKER = "SDE_QE_MANAGED_PRE_PUSH_GATE_V1";
const BYPASS_FLAG = "--no-" + "verify";

class GateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GateError";
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function canonicalHash(value, excludedKey) {
  const copy = {...value};
  if (excludedKey) delete copy[excludedKey];
  return sha256(stableJson(copy));
}

function scrub(value) {
  return String(value ?? "")
    .replace(/(authorization|cookie|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/:\/\/[^/@\s]+@/g, "://[REDACTED]@")
    .slice(0, 32 * 1024);
}

function displayCommand(command, args) {
  return [command, ...args].map((item) => /[^A-Za-z0-9_./:@=-]/.test(item)
    ? `'${String(item).replaceAll("'", "'\\''")}'`
    : item).join(" ");
}

function run(command, args = [], options = {}) {
  const started = Date.now();
  const result = childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: {...process.env, ...(options.env || {})},
    encoding: options.encoding === null ? null : "utf8",
    input: options.input,
    timeout: options.timeoutMs || 20 * 60 * 1000,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    stdio: options.stdio
  });
  return {
    command: displayCommand(command, args),
    status: result.status,
    signal: result.signal,
    stdout: options.encoding === null ? result.stdout : scrub(result.stdout),
    stderr: options.encoding === null ? result.stderr : scrub(result.stderr),
    error: result.error ? scrub(result.error.message) : null,
    durationMs: Date.now() - started,
    ok: result.status === 0 && !result.error && !result.signal
  };
}

function git(args, options = {}) {
  return run("git", args, options);
}

function gitText(args, cwd, code = "GIT_COMMAND_FAILED") {
  const result = git(args, {cwd});
  if (!result.ok) throw new GateError(code, `${result.command}: ${result.stderr || result.error || "failed"}`);
  return String(result.stdout).trim();
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const next = argv[index + 1];
    values[value.slice(2)] = next && !next.startsWith("--") ? (index += 1, next) : true;
  }
  return values;
}

function repoRoot(cwd = process.cwd()) {
  return gitText(["rev-parse", "--show-toplevel"], cwd, "REPOSITORY_ROOT_UNAVAILABLE");
}

function commonDirectory(cwd = process.cwd()) {
  const value = gitText(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, "GIT_COMMON_DIR_UNAVAILABLE");
  return path.resolve(cwd, value);
}

function managedPaths(common) {
  const root = path.join(common, "sde-qe-prepush");
  return {
    root,
    hooks: path.join(root, "hooks"),
    hook: path.join(root, "hooks", "pre-push"),
    runner: path.join(root, "runner.cjs"),
    manifest: path.join(root, "manifest.json"),
    pending: path.join(root, "state", "pending"),
    approvals: path.join(root, "state", "approvals"),
    consumed: path.join(root, "state", "consumed"),
    reports: path.join(root, "reports"),
    temp: path.join(root, "tmp")
  };
}

function mkdirPrivate(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.chmodSync(directory, 0o700);
}

function atomicWrite(file, bytes, mode = 0o600) {
  mkdirPrivate(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(12).toString("hex")}.tmp`);
  const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
}

function safeJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
    throw new GateError("UNSAFE_STATE_FILE", `Unsafe state file: ${file}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new GateError("STATE_OWNER_MISMATCH", `State file is not owned by the current user: ${file}`);
  }
  if ((stat.mode & 0o077) !== 0) throw new GateError("STATE_MODE_UNSAFE", `State file is not owner-only: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sourceAtCommit(root, commit, file) {
  const result = run("git", ["show", `${commit}:${file}`], {cwd: root, encoding: null});
  if (!result.ok || !Buffer.isBuffer(result.stdout)) {
    throw new GateError("INSTALL_SOURCE_NOT_IN_COMMIT", `${file} is not available at ${commit}.`);
  }
  return result.stdout;
}

function configuredHooksPath(root) {
  const result = git(["config", "--local", "--get", "core.hooksPath"], {cwd: root});
  if (result.status === 1) return null;
  if (!result.ok) throw new GateError("HOOKS_PATH_READ_FAILED", result.stderr || result.error || "Cannot read core.hooksPath.");
  return String(result.stdout).trim() || null;
}

function installMode() {
  const root = repoRoot();
  const common = commonDirectory(root);
  const paths = managedPaths(common);
  const before = configuredHooksPath(root);
  const existingManifest = fs.existsSync(paths.manifest) ? safeJson(paths.manifest) : null;
  const managedBefore = before && path.resolve(root, before) === paths.hooks;
  if (before && !managedBefore) {
    throw new GateError("EXISTING_PRE_PUSH_HOOK_CANNOT_BE_SAFELY_PRESERVED", `core.hooksPath already points to ${before}.`);
  }
  const defaultHook = path.join(common, "hooks", "pre-push");
  if (!before && fs.existsSync(defaultHook)) {
    const source = fs.readFileSync(defaultHook, "utf8");
    if (!source.includes(MANAGED_MARKER)) {
      throw new GateError("EXISTING_PRE_PUSH_HOOK_CANNOT_BE_SAFELY_PRESERVED", `Existing hook was not overwritten: ${defaultHook}.`);
    }
  }
  if (fs.existsSync(paths.root) && !existingManifest) {
    const entries = fs.readdirSync(paths.root);
    if (entries.length) throw new GateError("MANAGED_AREA_OWNERSHIP_UNPROVEN", `${paths.root} exists without a valid manifest.`);
  }
  if (existingManifest && existingManifest.gateId !== GATE_ID) {
    throw new GateError("MANAGED_AREA_OWNERSHIP_UNPROVEN", `${paths.root} belongs to an unknown gate.`);
  }

  const status = gitText(["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (status) throw new GateError("INSTALL_SOURCE_WORKTREE_DIRTY", "Install only from a clean committed source worktree.");
  const sourceCommit = gitText(["rev-parse", "HEAD"], root);
  const sourceTree = gitText(["rev-parse", "HEAD^{tree}"], root);
  const hookBytes = sourceAtCommit(root, sourceCommit, SOURCE_HOOK);
  const runnerBytes = sourceAtCommit(root, sourceCommit, SOURCE_RUNNER);
  if (!fs.readFileSync(path.join(root, SOURCE_HOOK)).equals(hookBytes) ||
      !fs.readFileSync(path.join(root, SOURCE_RUNNER)).equals(runnerBytes)) {
    throw new GateError("INSTALL_SOURCE_DIFFERS_FROM_COMMIT", "Tracked gate sources differ from HEAD.");
  }

  for (const directory of [paths.root, paths.hooks, paths.pending, paths.approvals, paths.consumed, paths.reports, paths.temp]) {
    mkdirPrivate(directory);
  }
  atomicWrite(paths.hook, hookBytes, 0o700);
  atomicWrite(paths.runner, runnerBytes, 0o700);
  const installedAt = existingManifest?.sourceCommit === sourceCommit
    ? existingManifest.installedAt
    : new Date().toISOString();
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    gateId: GATE_ID,
    gateVersion: GATE_VERSION,
    testProfileVersion: PROFILE_VERSION,
    installedAt,
    sourceCommit,
    sourceTree,
    sourceFiles: {
      hook: {path: SOURCE_HOOK, sha256: sha256(hookBytes)},
      runner: {path: SOURCE_RUNNER, sha256: sha256(runnerBytes)}
    },
    installedFiles: {
      hook: {path: paths.hook, sha256: sha256(fs.readFileSync(paths.hook)), mode: "0700"},
      runner: {path: paths.runner, sha256: sha256(fs.readFileSync(paths.runner)), mode: "0700"}
    },
    hooksPath: paths.hooks,
    originalHooksPath: existingManifest ? existingManifest.originalHooksPath : before
  };
  atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  const configured = git(["config", "--local", "core.hooksPath", paths.hooks], {cwd: root});
  if (!configured.ok) throw new GateError("HOOKS_PATH_WRITE_FAILED", configured.stderr || configured.error || "Cannot set core.hooksPath.");
  const doctor = doctorStatus(root);
  if (doctor.status !== "GREEN") throw new GateError("INSTALL_DOCTOR_FAILED", doctor.reasonCodes.join(", "), doctor);
  process.stdout.write(`${JSON.stringify({status: "GREEN", idempotent: Boolean(existingManifest), coreHooksPathBefore: before, ...doctor}, null, 2)}\n`);
}

function verifyManifest(root, options = {}) {
  const common = commonDirectory(root);
  const paths = managedPaths(common);
  const manifest = safeJson(paths.manifest);
  const reasons = [];
  if (manifest.schemaVersion !== MANIFEST_SCHEMA || manifest.gateId !== GATE_ID ||
      manifest.gateVersion !== GATE_VERSION || manifest.testProfileVersion !== PROFILE_VERSION) {
    reasons.push("INSTALL_MANIFEST_VERSION_MISMATCH");
  }
  const configured = configuredHooksPath(root);
  if (!configured || path.resolve(root, configured) !== paths.hooks) reasons.push("HOOKS_PATH_NOT_ACTIVE");
  for (const [name, expectedPath] of [["hook", paths.hook], ["runner", paths.runner]]) {
    if (!fs.existsSync(expectedPath)) {
      reasons.push(`INSTALLED_${name.toUpperCase()}_MISSING`);
      continue;
    }
    const stat = fs.statSync(expectedPath);
    if ((stat.mode & 0o777) !== 0o700) reasons.push(`INSTALLED_${name.toUpperCase()}_MODE_INVALID`);
    if (sha256(fs.readFileSync(expectedPath)) !== manifest.installedFiles?.[name]?.sha256) {
      reasons.push(`INSTALLED_${name.toUpperCase()}_HASH_MISMATCH`);
    }
  }
  try {
    for (const name of ["hook", "runner"]) {
      const entry = manifest.sourceFiles?.[name];
      if (!entry || sha256(sourceAtCommit(root, manifest.sourceCommit, entry.path)) !== entry.sha256) {
        reasons.push(`SOURCE_${name.toUpperCase()}_HASH_MISMATCH`);
      }
    }
  } catch (_error) {
    reasons.push("INSTALL_SOURCE_COMMIT_UNAVAILABLE");
  }
  if (options.requireSelf && path.resolve(__filename) !== paths.runner) reasons.push("HOOK_NOT_USING_INSTALLED_RUNNER");
  if (options.requireSelf && sha256(fs.readFileSync(__filename)) !== manifest.installedFiles?.runner?.sha256) {
    reasons.push("RUNNING_RUNNER_HASH_MISMATCH");
  }
  return {manifest, paths, reasons};
}

function doctorStatus(cwd = process.cwd()) {
  const root = repoRoot(cwd);
  let verified;
  try {
    verified = verifyManifest(root);
  } catch (error) {
    return {
      status: "RED",
      gateId: GATE_ID,
      gateVersion: GATE_VERSION,
      testProfileVersion: PROFILE_VERSION,
      reasonCodes: [error.code || "DOCTOR_READ_FAILED"],
      error: scrub(error.message)
    };
  }
  return {
    status: verified.reasons.length ? "RED" : "GREEN",
    gateId: GATE_ID,
    gateVersion: GATE_VERSION,
    testProfileVersion: PROFILE_VERSION,
    reasonCodes: verified.reasons,
    commonDirectory: commonDirectory(root),
    hooksPath: configuredHooksPath(root),
    installedHook: verified.paths.hook,
    installedRunner: verified.paths.runner,
    sourceCommit: verified.manifest.sourceCommit,
    sourceTree: verified.manifest.sourceTree
  };
}

function doctorMode() {
  const status = doctorStatus();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  if (status.status !== "GREEN") process.exitCode = 1;
}

function canonicalRemoteUrl(raw, cwd) {
  const value = String(raw || "").trim();
  if (!value) throw new GateError("REMOTE_URL_MISSING", "Remote URL is empty.");
  if (/^[^/@:\s]+@[^/:\s]+:.+/.test(value)) {
    const match = value.match(/^([^/@:\s]+)@([^/:\s]+):(.+)$/);
    return `ssh://${match[1]}@${match[2].toLowerCase()}/${match[3].replace(/^\/+|\/+$/g, "")}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.toString().replace(/\/$/, "");
  }
  const absolute = path.resolve(cwd, value);
  const resolved = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  return `file://${resolved}`;
}

function parsePrePushInput(input) {
  const lines = String(input || "").split(/\r?\n/).filter((line) => line.trim());
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new GateError("PUSH_INPUT_MALFORMED", `Malformed pre-push input: ${line}`);
    return {localRef: fields[0], localSha: fields[1], remoteRef: fields[2], remoteOldSha: fields[3]};
  });
}

function activeOperations(root) {
  const gitDir = gitText(["rev-parse", "--path-format=absolute", "--git-dir"], root);
  return ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]
    .filter((name) => fs.existsSync(path.join(gitDir, name)));
}

function remoteUrlFor(root, remoteName, remoteLocation) {
  const configured = git(["remote", "get-url", "--push", remoteName], {cwd: root});
  return canonicalRemoteUrl(configured.ok ? String(configured.stdout).trim() : remoteLocation, root);
}

function changedFileList(root, base, candidate) {
  const result = git(["diff", "--name-only", "-z", base, candidate], {cwd: root, encoding: null});
  if (!result.ok) throw new GateError("CANDIDATE_DIFF_UNAVAILABLE", scrub(result.stderr || result.error));
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

function candidateIdentity(root, remoteName, remoteLocation, refs) {
  if (refs.length === 0) throw new GateError("NO_REFS_IN_PUSH", "No ref was supplied to the pre-push hook.");
  if (refs.length !== 1) throw new GateError("MULTIPLE_REFS_BLOCKED", "Exactly one branch ref may be pushed.");
  const ref = refs[0];
  if (ref.localSha === NULL_SHA) throw new GateError("BRANCH_DELETION_BLOCKED", "Branch deletion is not allowed.");
  if (!/^[a-f0-9]{40}$/.test(ref.localSha)) throw new GateError("LOCAL_SHA_INVALID", "Local candidate SHA is missing or ambiguous.");
  if (!/^[a-f0-9]{40}$/.test(ref.remoteOldSha)) throw new GateError("REMOTE_OLD_SHA_INVALID", "Remote old SHA is missing or ambiguous.");
  if (ref.localRef.startsWith("refs/tags/") || ref.remoteRef.startsWith("refs/tags/")) {
    throw new GateError("TAG_PUSH_BLOCKED", "Tag pushes are not allowed.");
  }
  if (!ref.localRef.startsWith("refs/heads/") || !ref.remoteRef.startsWith("refs/heads/")) {
    throw new GateError("UNKNOWN_REF_TYPE_BLOCKED", "Only a single branch-to-branch push is supported.");
  }
  if (ref.remoteRef === "refs/heads/main") throw new GateError("DIRECT_MAIN_PUSH_BLOCKED", "Direct pushes to main are forbidden; use a pull request.");
  const type = gitText(["cat-file", "-t", ref.localSha], root, "CANDIDATE_OBJECT_MISSING");
  if (type !== "commit") throw new GateError("CANDIDATE_NOT_COMMIT", `Candidate object is ${type}, not commit.`);
  const resolved = gitText(["rev-parse", ref.localRef], root, "LOCAL_REF_UNRESOLVED");
  if (resolved !== ref.localSha) throw new GateError("LOCAL_REF_SHA_MISMATCH", "Local ref no longer resolves to the candidate SHA.");
  const symbolic = git(["symbolic-ref", "-q", "HEAD"], {cwd: root});
  if (!symbolic.ok || String(symbolic.stdout).trim() !== ref.localRef) {
    throw new GateError("CANDIDATE_BRANCH_CONTEXT_INCONSISTENT", "Push must originate from the clean checked-out candidate branch.");
  }
  const dirty = gitText(["status", "--porcelain=v1", "--untracked-files=all"], root);
  if (dirty) throw new GateError("CANDIDATE_WORKTREE_DIRTY", "Candidate worktree is not clean.");
  const operations = activeOperations(root);
  if (operations.length) throw new GateError("ACTIVE_GIT_OPERATION", `Active Git operation: ${operations.join(", ")}`);

  if (ref.remoteOldSha !== NULL_SHA) {
    const oldType = gitText(["cat-file", "-t", ref.remoteOldSha], root, "REMOTE_OLD_OBJECT_MISSING");
    if (oldType !== "commit") throw new GateError("REMOTE_OLD_NOT_COMMIT", "Remote old object is not a commit.");
    const fastForward = git(["merge-base", "--is-ancestor", ref.remoteOldSha, ref.localSha], {cwd: root});
    if (fastForward.status !== 0) throw new GateError("NON_FAST_FORWARD_FORCE_PUSH_BLOCKED", "Force and force-with-lease updates are forbidden.");
  }

  let base = ref.remoteOldSha;
  if (base === NULL_SHA) {
    const originMain = git(["rev-parse", "--verify", "refs/remotes/origin/main"], {cwd: root});
    const parent = git(["rev-parse", "--verify", `${ref.localSha}^`], {cwd: root});
    const anchor = originMain.ok ? String(originMain.stdout).trim() : parent.ok ? String(parent.stdout).trim() : null;
    if (!anchor) throw new GateError("CANDIDATE_BASE_UNAVAILABLE", "Cannot establish candidate base.");
    base = gitText(["merge-base", anchor, ref.localSha], root, "CANDIDATE_BASE_UNAVAILABLE");
  }
  const parentResult = git(["rev-parse", "--verify", `${ref.localSha}^`], {cwd: root});
  const parent = parentResult.ok ? String(parentResult.stdout).trim() : null;
  const commits = gitText(["rev-list", "--reverse", `${base}..${ref.localSha}`], root)
    .split(/\n/).filter(Boolean);
  if (!commits.length) throw new GateError("EMPTY_CANDIDATE_RANGE", "Candidate contains no commit beyond its base.");
  const common = commonDirectory(root);
  const candidateTree = gitText(["rev-parse", `${ref.localSha}^{tree}`], root);
  return {
    remoteName,
    remoteUrl: remoteUrlFor(root, remoteName, remoteLocation),
    localRef: ref.localRef,
    candidateSha: ref.localSha,
    candidateTree,
    remoteRef: ref.remoteRef,
    remoteOldSha: ref.remoteOldSha,
    parent,
    base,
    commitRange: `${base}..${ref.localSha}`,
    commits,
    changedFiles: changedFileList(root, base, ref.localSha),
    commonDirectory: common,
    gateVersion: GATE_VERSION,
    testProfileVersion: PROFILE_VERSION
  };
}

function binding(identity) {
  return Object.fromEntries([
    "candidateSha", "candidateTree", "remoteUrl", "localRef", "remoteRef", "remoteOldSha",
    "gateVersion", "testProfileVersion"
  ].map((key) => [key, identity[key]]));
}

function sameBinding(left, right) {
  return stableJson(binding(left)) === stableJson(binding(right));
}

function listJson(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^[A-Za-z0-9._-]+\.json$/.test(name)).sort()
    .map((name) => path.join(directory, name));
}

function reportHashValid(report) {
  return /^[a-f0-9]{64}$/.test(report?.reportSha256 || "") && canonicalHash(report, "reportSha256") === report.reportSha256;
}

function approvalHashValid(approval) {
  return /^[a-f0-9]{64}$/.test(approval?.approvalSha256 || "") && canonicalHash(approval, "approvalSha256") === approval.approvalSha256;
}

function invalidate(file, paths, reason) {
  const target = path.join(paths.consumed, `${path.basename(file, ".json")}.${Date.now()}.${reason}.json`);
  fs.renameSync(file, target);
  fs.chmodSync(target, 0o600);
}

function findPending(identity, paths) {
  const now = Date.now();
  for (const file of listJson(paths.pending)) {
    let request;
    try { request = safeJson(file); } catch (_error) { invalidate(file, paths, "unsafe"); continue; }
    if (Date.parse(request.expiresAt) <= now) { invalidate(file, paths, "expired"); continue; }
    if (!sameBinding(request, identity)) continue;
    const reportFile = path.join(paths.reports, `${request.reportId}.json`);
    try {
      const report = safeJson(reportFile);
      if (!reportHashValid(report) || report.reportSha256 !== request.reportSha256) {
        invalidate(file, paths, "report-mismatch");
        continue;
      }
    } catch (_error) {
      invalidate(file, paths, "report-missing");
      continue;
    }
    return {file, request};
  }
  return null;
}

function matchingApproval(identity, paths) {
  const now = Date.now();
  for (const file of listJson(paths.approvals)) {
    let approval;
    try { approval = safeJson(file); } catch (_error) { invalidate(file, paths, "unsafe"); continue; }
    const sameRef = approval.localRef === identity.localRef && approval.remoteRef === identity.remoteRef;
    if (!approvalHashValid(approval)) { invalidate(file, paths, "hash-mismatch"); continue; }
    if (Date.parse(approval.expiresAt) <= now) { invalidate(file, paths, "expired"); continue; }
    if (!sameBinding(approval, identity)) {
      if (sameRef) invalidate(file, paths, "binding-changed");
      continue;
    }
    const reportFile = path.join(paths.reports, `${approval.reportId}.json`);
    let report;
    try { report = safeJson(reportFile); } catch (_error) { invalidate(file, paths, "report-missing"); continue; }
    if (!reportHashValid(report) || report.reportSha256 !== approval.reportSha256) {
      invalidate(file, paths, "report-mismatch");
      continue;
    }
    return {file, approval, report};
  }
  return null;
}

function consumeApproval(match, identity, paths) {
  const destination = path.join(paths.consumed, `${match.approval.requestId}.${Date.now()}.used.json`);
  fs.renameSync(match.file, destination);
  fs.chmodSync(destination, 0o600);
  const consumed = {
    schemaVersion: REPORT_SCHEMA,
    gateId: GATE_ID,
    gateVersion: GATE_VERSION,
    testProfileVersion: PROFILE_VERSION,
    reportId: `${match.approval.requestId}.consumed`,
    generatedAt: new Date().toISOString(),
    candidate: binding(identity),
    approvalRequestId: match.approval.requestId,
    approvalReportSha256: match.approval.reportSha256,
    reasonCodes: ["ONE_TIME_APPROVAL_CONSUMED"],
    READY_FOR_BRANCH_PUSH_APPROVAL: true,
    PUSHED: true,
    autoFix: false
  };
  consumed.reportSha256 = canonicalHash(consumed, "reportSha256");
  writeReportFiles(consumed, paths);
  return consumed;
}

function commandTest(id, result, extra = {}) {
  return {
    id,
    command: result.command,
    status: result.ok ? "PASS" : "FAIL",
    skipped: false,
    exit: result.status,
    signal: result.signal,
    durationMs: result.durationMs,
    output: scrub(`${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`),
    ...extra
  };
}

function p0Ready(result) {
  if (result?.status === "GREEN") return true;
  if (result?.status !== "BLOCKED") return false;
  const reasons = [result.reasonCode, ...(result.details?.subgates || []).map((item) => item.reasonCode)].filter(Boolean);
  const contradiction = reasons.some((reason) => /MISMATCH|CONTRADICT|OPERATIVE_DATE|UI_STALE|SECRET_FOUND|MUTATION/.test(reason));
  const childRed = (result.details?.subgates || []).some((item) => item.status === "RED");
  return !contradiction && !childRed;
}

function testProfileOverride(identity, root) {
  const requested = process.env.SDE_PREPUSH_TEST_PROFILE;
  if (!requested) return null;
  if (process.env.SDE_PREPUSH_TESTING !== "1" || !identity.remoteUrl.startsWith("file:///private/tmp/")) {
    return {
      p0: {status: "RED", reasonCode: "TEST_PROFILE_OVERRIDE_REJECTED", details: {subgates: []}},
      tests: [{id: "test-profile-override", command: "internal test-profile guard", status: "FAIL", skipped: false, exit: 1, durationMs: 0, output: "Test profile override is restricted to disposable /private/tmp remotes."}],
      candidateMutation: false
    };
  }
  const p0 = requested === "P0_STALE"
    ? {status: "RED", reasonCode: "LIVE_DATA_OPERATIVE_DATE_MISMATCH", details: {subgates: [{id: "LIVE-DATA-OPERATIVE-DATES", status: "RED", reasonCode: "LIVE_DATA_OPERATIVE_DATE_MISMATCH"}]}}
    : requested === "EXTERNAL_BLOCKED"
      ? {status: "BLOCKED", reasonCode: "LIVE_DATA_EVIDENCE_MISSING", details: {subgates: []}}
      : {status: "GREEN", reasonCode: "LIVE_DATA_CONTINUITY_VERIFIED", details: {subgates: []}};
  let policy = {status: "PASS", output: "Disposable candidate policy scan passed."};
  try {
    policyScan(root, identity);
  } catch (error) {
    policy = {status: "FAIL", output: scrub(error.message)};
  }
  const ok = !["FAIL", "MISSING_RUNTIME"].includes(requested) && policy.status === "PASS";
  return {
    p0,
    tests: [
      {id: "p0-live-data-continuity", command: "released LIVE-DATA-FRESHNESS-P0 gate (disposable fixture)", status: p0.status === "RED" ? "FAIL" : "PASS", skipped: false, exit: p0.status === "RED" ? 1 : 0, durationMs: 0, output: p0.reasonCode},
      {id: "candidate-identity", command: "git candidate identity and exact diff", status: "PASS", skipped: false, exit: 0, durationMs: 0, output: identity.commitRange},
      {id: "disposable-profile", command: "permanent disposable profile fixture", status: ok ? "PASS" : "FAIL", skipped: false, exit: ok ? 0 : 1, durationMs: 0, output: requested},
      {id: "security-policy", command: "no-bypass, secret, permanent-test and skip policy scan", status: policy.status, skipped: false, exit: policy.status === "PASS" ? 0 : 1, durationMs: 0, output: policy.output}
    ],
    candidateMutation: false
  };
}

function mainWorktree(common) {
  const result = git(["worktree", "list", "--porcelain"], {cwd: common});
  if (!result.ok) return null;
  const blocks = String(result.stdout).trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split(/\n/);
    if (lines.includes("branch refs/heads/main")) return lines.find((line) => line.startsWith("worktree "))?.slice(9) || null;
  }
  return null;
}

function profileEnvironment(identity, artifactDirectory, root) {
  const common = commonDirectory(root);
  const runtimeRoot = process.env.SDE_QE_LIVE_DATA_RUNTIME_REPOSITORY || mainWorktree(common) || root;
  let approvedSha = process.env.SDE_QE_LIVE_DATA_APPROVED_SHA || null;
  let approvedTree = process.env.SDE_QE_LIVE_DATA_APPROVED_TREE || null;
  if (!approvedSha) {
    const value = git(["rev-parse", "--verify", "refs/remotes/origin/main"], {cwd: root});
    approvedSha = value.ok ? String(value.stdout).trim() : identity.base;
  }
  if (!approvedTree && approvedSha) {
    const value = git(["rev-parse", `${approvedSha}^{tree}`], {cwd: root});
    approvedTree = value.ok ? String(value.stdout).trim() : null;
  }
  const temp = path.join(artifactDirectory, "tmp");
  mkdirPrivate(temp);
  const managedPythonPath = path.join(common, "sde-qe-prepush", "runtime", "python");
  const managedBinPath = path.join(common, "sde-qe-prepush", "runtime", "bin");
  const defaultBrowserRoot = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
    : "";
  const serverNodePath = process.env.SDE_QE_SERVER_NODE_PATH || path.join(runtimeRoot, "server", "node_modules");
  return {
    SDE_PREPUSH_CANDIDATE_SHA: identity.candidateSha,
    SDE_PREPUSH_CANDIDATE_TREE: identity.candidateTree,
    SDE_QE_LIVE_DATA_RUNTIME_REPOSITORY: runtimeRoot,
    SDE_QE_LIVE_DATA_APPROVED_SHA: approvedSha || "",
    SDE_QE_LIVE_DATA_APPROVED_TREE: approvedTree || "",
    SDE_QE_LIVE_DATA_APPROVED_MAIN_REF: process.env.SDE_QE_LIVE_DATA_APPROVED_MAIN_REF || "refs/remotes/origin/main",
    SDE_QE_LIVE_DATA_EVIDENCE: process.env.SDE_QE_LIVE_DATA_EVIDENCE || "",
    SDE_QE_SERVER_NODE_PATH: serverNodePath,
    NODE_PATH: process.env.NODE_PATH || serverNodePath,
    PYTHONPATH: process.env.SDE_QE_PYTHONPATH || (fs.existsSync(managedPythonPath) ? managedPythonPath : process.env.PYTHONPATH || ""),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || defaultBrowserRoot,
    PATH: fs.existsSync(managedBinPath) ? `${managedBinPath}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH || "",
    PYTHONDONTWRITEBYTECODE: "1",
    npm_config_cache: path.join(artifactDirectory, "npm-cache"),
    TMPDIR: temp
  };
}

function runP0(candidateRoot, env) {
  const script = [
    "const {liveDataContinuityGate}=require('./tests/sde-quality-engine/lib/live-data-continuity.cjs');",
    "const input=process.env.SDE_QE_LIVE_DATA_EVIDENCE?[process.env.SDE_QE_LIVE_DATA_EVIDENCE]:[];",
    "const result=liveDataContinuityGate({inputPaths:input,subjectRepository:process.env.SDE_QE_LIVE_DATA_RUNTIME_REPOSITORY,approvedSha:process.env.SDE_QE_LIVE_DATA_APPROVED_SHA,approvedTree:process.env.SDE_QE_LIVE_DATA_APPROVED_TREE,approvedMainRef:process.env.SDE_QE_LIVE_DATA_APPROVED_MAIN_REF});",
    "process.stdout.write(JSON.stringify(result));"
  ].join("");
  const command = run(process.execPath, ["-e", script], {cwd: candidateRoot, env, timeoutMs: 3 * 60 * 1000});
  let result = null;
  try { result = JSON.parse(String(command.stdout || "")); } catch (_error) { result = null; }
  const pass = result && (result.status === "GREEN" || (result.status === "BLOCKED" && p0Ready(result)));
  return {
    result: result || {status: "RED", reasonCode: "P0_REPORT_MALFORMED", details: {subgates: []}},
    test: {...commandTest("p0-live-data-continuity", command), status: pass ? "PASS" : "FAIL", output: result ? stableJson(result) : command.stderr}
  };
}

function internalNodeTest(id, commandLabel, fn) {
  const started = Date.now();
  try {
    const output = fn();
    return {id, command: commandLabel, status: "PASS", skipped: false, exit: 0, signal: null, durationMs: Date.now() - started, output: scrub(output || "PASS")};
  } catch (error) {
    return {id, command: commandLabel, status: "FAIL", skipped: false, exit: 1, signal: null, durationMs: Date.now() - started, output: scrub(error.stack || error.message)};
  }
}

function trackedFiles(root, patterns = []) {
  const args = ["ls-files", "-z", "--", ...patterns];
  const result = git(args, {cwd: root, encoding: null});
  if (!result.ok) throw new Error(scrub(result.stderr || result.error));
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function validateJson(root) {
  const files = trackedFiles(root, ["*.json", "**/*.json"]);
  for (const file of files) JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  return `${files.length} tracked JSON files parsed`;
}

function validateNodeSyntax(root) {
  const files = trackedFiles(root, ["*.js", "*.cjs", "*.mjs", "**/*.js", "**/*.cjs", "**/*.mjs"]);
  for (const file of files) {
    const result = run(process.execPath, ["--check", file], {cwd: root, timeoutMs: 60_000});
    if (!result.ok) throw new Error(`${file}: ${result.stderr || result.stdout}`);
  }
  return `${files.length} tracked JavaScript files passed node --check`;
}

function validatePythonSyntax(root, env) {
  const files = trackedFiles(root, ["*.py", "**/*.py"]);
  const program = "import ast,pathlib,sys\nfor name in sys.argv[1:]: ast.parse(pathlib.Path(name).read_text(encoding='utf-8'),filename=name)";
  const result = run("python3.11", ["-B", "-c", program, ...files], {cwd: root, env, timeoutMs: 2 * 60 * 1000});
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error);
  return `${files.length} tracked Python files passed ast.parse`;
}

function validateWorkflowYaml(root, env) {
  const files = trackedFiles(root, [".github/workflows/*.yml", ".github/workflows/*.yaml"]);
  const program = "require 'yaml'; ARGV.each { |f| YAML.safe_load(File.read(f), permitted_classes: [Date, Time], aliases: true) }";
  const result = run("ruby", ["-rdate", "-e", program, ...files], {cwd: root, env, timeoutMs: 60_000});
  if (!result.ok) throw new Error(result.stderr || result.stdout || result.error);
  return `${files.length} workflow YAML files parsed`;
}

function policyScan(root, identity) {
  const problems = [];
  const files = trackedFiles(root);
  for (const file of files) {
    if (!/\.(?:sh|bash|zsh|js|cjs|mjs|py|md|txt|ya?ml|json)$/.test(file)) continue;
    if (file === "tests/sde-quality-engine/prepush-gate.test.cjs") continue;
    let source;
    try { source = fs.readFileSync(path.join(root, file), "utf8"); } catch (_error) { continue; }
    source.split(/\r?\n/).forEach((line, index) => {
      if (!line.includes(BYPASS_FLAG)) return;
      const explanatory = /(?:kan|could|can).{0,80}(?:omgå|bypass)/i.test(line) && !/^\s*(?:\$|git\s)/.test(line);
      if (!explanatory) problems.push(`BYPASS_USAGE:${file}:${index + 1}`);
    });
  }
  const baseTests = gitText(["ls-tree", "-r", "--name-only", identity.base, "--", "tests/sde", "tests/sde-quality-engine"], root)
    .split(/\n/).filter((file) => /(?:test|fixture|contract|invariant|audit|harness)/i.test(file));
  const current = new Set(files);
  for (const file of baseTests) if (!current.has(file)) problems.push(`PERMANENT_TEST_DELETED:${file}`);
  const diff = gitText(["diff", "--unified=0", identity.base, identity.candidateSha, "--", "tests", ".github", "package.json"], root);
  for (const line of diff.split(/\n/)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (/\b(?:test|describe)\.(?:skip|only)\b|\b(?:xit|xdescribe|xfail)\b|\{\s*skip\s*:\s*true\b/i.test(line)) {
      problems.push("ACTIVE_TEST_SKIP_OR_FOCUS_ADDED");
    }
    if (/\.status\s*=\s*["']GREEN["']|process\.exitCode\s*=\s*0/.test(line) && /P0|live.data|policy/i.test(diff)) {
      problems.push("QUALITY_POLICY_WEAKENING_PATTERN");
    }
  }
  const secretDiff = gitText(["diff", "--unified=0", identity.base, identity.candidateSha], root);
  for (const line of secretDiff.split(/\n/)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9+/_.-]{16,}/i.test(line)) {
      problems.push("POTENTIAL_SECRET_ADDED");
    }
  }
  if (problems.length) throw new Error([...new Set(problems)].join("\n"));
  return `policy scan passed; ${baseTests.length} permanent baseline resources retained; active skips added=0`;
}

function chmodReadOnly(root) {
  const files = trackedFiles(root);
  for (const file of files) {
    const target = path.join(root, file);
    const executable = (fs.statSync(target).mode & 0o111) !== 0;
    fs.chmodSync(target, executable ? 0o500 : 0o400);
  }
  const directories = [...new Set(files.map((file) => path.dirname(path.join(root, file))))]
    .sort((left, right) => right.length - left.length);
  for (const directory of directories) if (directory !== root) fs.chmodSync(directory, 0o500);
  return files;
}

function materializeExecutionTree(candidateRoot, executionRoot, serverNodePath) {
  mkdirPrivate(executionRoot);
  const index = git(["ls-files", "-s", "-z"], {cwd: candidateRoot, encoding: null});
  if (!index.ok) throw new GateError("CANDIDATE_INDEX_UNAVAILABLE", scrub(index.stderr || index.error));
  const entries = index.stdout.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const match = line.match(/^(\d{6}) [a-f0-9]{40} \d+\t([\s\S]+)$/);
    if (!match) throw new GateError("CANDIDATE_INDEX_MALFORMED", `Cannot parse tracked entry: ${line}`);
    return {mode: match[1], file: match[2]};
  });
  for (const entry of entries) {
    if (entry.mode === "160000") throw new GateError("CANDIDATE_SUBMODULE_UNSUPPORTED", `Submodule is not supported: ${entry.file}`);
    const source = path.join(candidateRoot, entry.file);
    const target = path.join(executionRoot, entry.file);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
    if (entry.mode === "120000") fs.symlinkSync(fs.readFileSync(source, "utf8"), target);
    else {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, entry.mode === "100755" ? 0o500 : 0o400);
    }
  }
  const candidateGitFile = path.join(candidateRoot, ".git");
  if (!fs.statSync(candidateGitFile).isFile()) throw new GateError("CANDIDATE_GIT_LINK_MISSING", "Detached worktree .git link is missing.");
  atomicWrite(path.join(executionRoot, ".git"), fs.readFileSync(candidateGitFile), 0o400);
  if (serverNodePath && fs.statSync(serverNodePath, {throwIfNoEntry: false})?.isDirectory()) {
    const serverDirectory = path.join(executionRoot, "server");
    fs.chmodSync(serverDirectory, 0o700);
    fs.symlinkSync(serverNodePath, path.join(serverDirectory, "node_modules"));
  }
  const directories = [...new Set(entries.map((entry) => path.dirname(path.join(executionRoot, entry.file))))]
    .sort((left, right) => right.length - left.length);
  for (const directory of directories) if (directory !== executionRoot) fs.chmodSync(directory, 0o500);
  fs.chmodSync(executionRoot, 0o500);
  return entries.length;
}

function candidateMutationStatus(candidateRoot, candidateSha, expectedServerNodePath = null) {
  // The execution mirror is deliberately chmod'd read-only. Ignore those expected
  // mode-bit differences while retaining content and untracked-file detection.
  const dependencyLink = path.join(candidateRoot, "server", "node_modules");
  const dependencyStat = fs.lstatSync(dependencyLink, {throwIfNoEntry: false});
  const dependencyLinkValid = expectedServerNodePath === null ||
    (dependencyStat?.isSymbolicLink() === true && fs.readlinkSync(dependencyLink) === expectedServerNodePath);
  const statusArgs = ["-c", "core.filemode=false", "status", "--porcelain=v1", "--untracked-files=all"];
  if (expectedServerNodePath !== null && dependencyLinkValid) {
    statusArgs.push("--", ".", ":(exclude)server/node_modules");
  }
  const status = git(statusArgs, {cwd: candidateRoot});
  const diff = git(["-c", "core.filemode=false", "diff", "--exit-code", candidateSha, "--"], {cwd: candidateRoot});
  return {
    mutated: !dependencyLinkValid || !status.ok || String(status.stdout).trim() !== "" || !diff.ok,
    dependencyLinkValid,
    status,
    diff
  };
}

function restoreWritable(root) {
  if (!fs.existsSync(root)) return;
  const visit = (directory) => {
    try { fs.chmodSync(directory, 0o700); } catch (_error) {}
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (!entry.isSymbolicLink()) { try { fs.chmodSync(target, 0o600); } catch (_error) {} }
    }
  };
  visit(root);
}

function executeFullProfile(candidateRoot, identity, artifactDirectory, invocationRoot) {
  const env = profileEnvironment(identity, artifactDirectory, invocationRoot);
  const tests = [];
  const p0 = runP0(candidateRoot, env);
  tests.push(p0.test);
  tests.push({id: "candidate-identity", command: "git candidate identity and exact diff", status: "PASS", skipped: false, exit: 0, signal: null, durationMs: 0, output: `${identity.commitRange}; commits=${identity.commits.length}; files=${identity.changedFiles.length}`});
  const commands = [
    ["qe-unit", "npm", ["run", "test:sde:qe:unit"], 5 * 60 * 1000],
    ["qe-policy", "npm", ["run", "test:sde:qe:policy"], 5 * 60 * 1000],
    ["strict", "npm", ["run", "test:sde:strict"], 25 * 60 * 1000],
    ["permanent-contracts", "npm", ["run", "test:sde:contracts"], 25 * 60 * 1000],
    ["determinism", "npm", ["run", "test:sde:determinism"], 50 * 60 * 1000],
    ["mutation-audit", "npm", ["run", "test:sde:mutations"], 50 * 60 * 1000],
    ["python-regressions", "python3.11", ["-B", "-m", "unittest", "-v", "test_update_static_data.py", "test_sde_schedule_observability.py", "tests/sde/test_balise_actual_platform.py", "server/scripts/test_sync_production_balise_data.py"], 15 * 60 * 1000],
    ["browserguard-runtime", "npm", ["run", "test:sde:qe:browserguard:runtime"], 5 * 60 * 1000],
    ["browserguard-contracts", "npm", ["run", "test:sde:qe:browserguard"], 20 * 60 * 1000]
  ];
  for (const [id, command, args, timeoutMs] of commands) {
    tests.push(commandTest(id, run(command, args, {cwd: candidateRoot, env, timeoutMs})));
  }
  const serverScript = "const {buildInventory}=require('./tests/sde-quality-engine/lib/inventory.cjs');const {runServerSuite}=require('./tests/sde-quality-engine/lib/checks.cjs');const r=runServerSuite(buildInventory());process.stdout.write(JSON.stringify(r));if(r.some(x=>x.status!=='GREEN'))process.exitCode=1;";
  tests.push(commandTest("server-contracts", run(process.execPath, ["-e", serverScript], {cwd: candidateRoot, env, timeoutMs: 30 * 60 * 1000})));
  tests.push(internalNodeTest("json-schema-validation", "parse every tracked JSON/schema", () => validateJson(candidateRoot)));
  tests.push(internalNodeTest("node-syntax", "node --check every tracked JavaScript source", () => validateNodeSyntax(candidateRoot)));
  tests.push(internalNodeTest("python-syntax", "python3.11 ast.parse every tracked Python source", () => validatePythonSyntax(candidateRoot, env)));
  tests.push(internalNodeTest("workflow-yaml", "Ruby Psych parse every tracked workflow YAML", () => validateWorkflowYaml(candidateRoot, env)));
  tests.push(commandTest("git-diff-check", git(["diff", "--check", identity.base, identity.candidateSha], {cwd: candidateRoot})));
  tests.push(internalNodeTest("security-policy", "no-bypass, secret, permanent-test and skip policy scan", () => policyScan(candidateRoot, identity)));
  const expectedServerNodePath = fs.statSync(env.SDE_QE_SERVER_NODE_PATH, {throwIfNoEntry: false})?.isDirectory()
    ? env.SDE_QE_SERVER_NODE_PATH
    : null;
  const mutation = candidateMutationStatus(candidateRoot, identity.candidateSha, expectedServerNodePath);
  const candidateMutation = mutation.mutated;
  tests.push({id: "candidate-no-mutation", command: "git status + git diff --exit-code against candidate (expected read-only mode bits and validated dependency link ignored)", status: candidateMutation ? "FAIL" : "PASS", skipped: false, exit: candidateMutation ? 1 : 0, signal: null, durationMs: mutation.status.durationMs + mutation.diff.durationMs, output: candidateMutation ? scrub(`dependencyLinkValid=${mutation.dependencyLinkValid}\n${mutation.status.stdout}\n${mutation.diff.stdout}\n${mutation.diff.stderr}`) : "Candidate remained byte-identical and clean; controlled dependency link remained exact."});
  return {p0: p0.result, tests, candidateMutation};
}

function runCandidateProfile(root, identity) {
  const override = testProfileOverride(identity, root);
  if (override) return override;
  const temporaryRoot = fs.mkdtempSync("/private/tmp/sde-qe-prepush-run.");
  fs.chmodSync(temporaryRoot, 0o700);
  const candidateRoot = path.join(temporaryRoot, "candidate");
  const executionRoot = path.join(temporaryRoot, "execution");
  const artifactDirectory = path.join(temporaryRoot, "artifacts");
  mkdirPrivate(artifactDirectory);
  const add = git(["worktree", "add", "--detach", candidateRoot, identity.candidateSha], {cwd: root, timeoutMs: 5 * 60 * 1000});
  if (!add.ok) {
    restoreWritable(temporaryRoot);
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
    throw new GateError("DETACHED_CANDIDATE_WORKTREE_FAILED", add.stderr || add.error || "Cannot create candidate worktree.");
  }
  let profile;
  try {
    chmodReadOnly(candidateRoot);
    const serverNodePath = process.env.SDE_QE_SERVER_NODE_PATH || path.join(mainWorktree(identity.commonDirectory) || root, "server", "node_modules");
    materializeExecutionTree(candidateRoot, executionRoot, serverNodePath);
    profile = executeFullProfile(executionRoot, identity, artifactDirectory, root);
    const anchorStatus = git(["status", "--porcelain=v1", "--untracked-files=all"], {cwd: candidateRoot});
    if (!anchorStatus.ok || String(anchorStatus.stdout).trim()) {
      profile.candidateMutation = true;
      profile.tests.push({id: "detached-candidate-anchor", command: "git status on detached candidate identity anchor", status: "FAIL", skipped: false, exit: 1, signal: null, durationMs: anchorStatus.durationMs, output: scrub(`${anchorStatus.stdout}\n${anchorStatus.stderr}`)});
    } else {
      profile.tests.push({id: "detached-candidate-anchor", command: "git status on detached candidate identity anchor", status: "PASS", skipped: false, exit: 0, signal: null, durationMs: anchorStatus.durationMs, output: "Detached candidate identity anchor remained clean and unmodified."});
    }
  } finally {
    restoreWritable(executionRoot);
    fs.rmSync(executionRoot, {recursive: true, force: true});
    restoreWritable(candidateRoot);
    git(["worktree", "remove", "--force", candidateRoot], {cwd: root, timeoutMs: 5 * 60 * 1000});
    restoreWritable(temporaryRoot);
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  }
  return profile;
}

function writeReportFiles(report, paths) {
  const jsonFile = path.join(paths.reports, `${report.reportId}.json`);
  const textFile = path.join(paths.reports, `${report.reportId}.txt`);
  atomicWrite(jsonFile, `${JSON.stringify(report, null, 2)}\n`, 0o600);
  const text = [
    `${GATE_ID} ${GATE_VERSION}`,
    `REPORT_ID: ${report.reportId}`,
    `CANDIDATE_SHA: ${report.candidate?.candidateSha || "UNKNOWN"}`,
    `REMOTE: ${report.candidate?.remoteUrl || "UNKNOWN"} ${report.candidate?.remoteRef || "UNKNOWN"}`,
    `P0: ${report.p0?.status || "NOT_EVALUATED"} ${report.p0?.reasonCode || ""}`,
    `QE_RESULT: ${report.qeResult || "NOT_EVALUATED"}`,
    `REASON_CODES: ${(report.reasonCodes || []).join(",") || "NONE"}`,
    `READY_FOR_BRANCH_PUSH_APPROVAL: ${String(report.READY_FOR_BRANCH_PUSH_APPROVAL).toUpperCase()}`,
    `APPROVAL_REQUEST_ID: ${report.approvalRequestId || "NONE"}`,
    `REPORT_SHA_256: ${report.reportSha256}`,
    report.approveCommand ? `APPROVE_COMMAND: ${report.approveCommand}` : null,
    `PUSHED: ${String(report.PUSHED).toUpperCase()}`,
    "AUTO_FIX: FALSE"
  ].filter(Boolean).join("\n") + "\n";
  atomicWrite(textFile, text, 0o600);
  return {jsonFile, textFile};
}

function createPending(identity, report, paths) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + MAX_APPROVAL_MS);
  const request = {
    schemaVersion: STATE_SCHEMA,
    kind: "PENDING",
    requestId: report.approvalRequestId,
    reportId: report.reportId,
    reportSha256: report.reportSha256,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...binding(identity)
  };
  request.requestSha256 = canonicalHash(request, "requestSha256");
  const file = path.join(paths.pending, `${request.requestId}.json`);
  atomicWrite(file, `${JSON.stringify(request, null, 2)}\n`, 0o600);
  return {request, file};
}

function approveCommand(paths, requestId, candidateSha) {
  return `node '${paths.runner.replaceAll("'", "'\\''")}' approve --request-id ${requestId} --candidate ${candidateSha}`;
}

function reportBlockedError(error, paths) {
  const report = {
    schemaVersion: REPORT_SCHEMA,
    gateId: GATE_ID,
    gateVersion: GATE_VERSION,
    testProfileVersion: PROFILE_VERSION,
    reportId: `blocked-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`,
    generatedAt: new Date().toISOString(),
    candidate: null,
    diff: null,
    commands: [],
    tests: [],
    p0: {status: "NOT_EVALUATED", reasonCode: "PRECONDITION_BLOCKED"},
    qeResult: "BLOCKED",
    reasonCodes: [error.code || "GATE_ERROR"],
    READY_FOR_BRANCH_PUSH_APPROVAL: false,
    approvalRequestId: null,
    approveCommand: null,
    PUSHED: false,
    autoFix: false,
    error: scrub(error.message)
  };
  report.reportSha256 = canonicalHash(report, "reportSha256");
  if (paths) writeReportFiles(report, paths);
  return report;
}

function printBlocked(report, files = {}) {
  process.stderr.write([
    `SDE pre-push gate: ${report.reasonCodes.join(",")}`,
    report.error || null,
    report.approvalRequestId ? `APPROVAL_REQUEST_ID: ${report.approvalRequestId}` : null,
    report.candidate?.candidateSha ? `CANDIDATE_SHA: ${report.candidate.candidateSha}` : null,
    `REPORT_SHA_256: ${report.reportSha256}`,
    files.jsonFile ? `REPORT_JSON: ${files.jsonFile}` : null,
    files.textFile ? `REPORT_TEXT: ${files.textFile}` : null,
    report.approveCommand ? `APPROVE_COMMAND: ${report.approveCommand}` : null,
    "PUSHED: FALSE"
  ].filter(Boolean).join("\n") + "\n");
}

function hookMode(remoteName, remoteLocation) {
  let root;
  let paths;
  try {
    root = repoRoot();
    const verified = verifyManifest(root, {requireSelf: true});
    paths = verified.paths;
    if (verified.reasons.length) throw new GateError("GATE_INSTALLATION_INVALID", verified.reasons.join(", "));
    const input = fs.readFileSync(0, "utf8");
    const identity = candidateIdentity(root, remoteName, remoteLocation, parsePrePushInput(input));
    const approved = matchingApproval(identity, paths);
    if (approved) {
      const consumed = consumeApproval(approved, identity, paths);
      process.stdout.write(`SDE pre-push gate: ONE_TIME_APPROVAL_CONSUMED\nCANDIDATE_SHA: ${identity.candidateSha}\nREPORT_SHA_256: ${consumed.reportSha256}\nPUSHED: TRUE\n`);
      return;
    }
    const pending = findPending(identity, paths);
    if (pending) {
      const report = safeJson(path.join(paths.reports, `${pending.request.reportId}.json`));
      printBlocked(report, {jsonFile: path.join(paths.reports, `${report.reportId}.json`), textFile: path.join(paths.reports, `${report.reportId}.txt`)});
      process.exitCode = 1;
      return;
    }

    const profile = runCandidateProfile(root, identity);
    const failedTests = profile.tests.filter((item) => item.status !== "PASS" || item.skipped);
    const ready = p0Ready(profile.p0) && failedTests.length === 0 && profile.candidateMutation === false;
    const reportId = `gate-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
    const requestId = ready ? crypto.randomUUID() : null;
    const reasons = [];
    if (!p0Ready(profile.p0)) reasons.push(profile.p0.reasonCode || "P0_NOT_APPROVABLE");
    reasons.push(...failedTests.map((item) => `TEST_FAILED:${item.id}`));
    if (profile.candidateMutation) reasons.push("CANDIDATE_MUTATED_BY_TEST_MACHINE");
    if (ready) reasons.push("FIRST_PUSH_ALWAYS_BLOCKED_PENDING_APPROVAL");
    const report = {
      schemaVersion: REPORT_SCHEMA,
      gateId: GATE_ID,
      gateVersion: GATE_VERSION,
      testProfileVersion: PROFILE_VERSION,
      reportId,
      generatedAt: new Date().toISOString(),
      candidate: binding(identity),
      diff: {parent: identity.parent, base: identity.base, range: identity.commitRange, commits: identity.commits, changedFiles: identity.changedFiles, commonDirectory: identity.commonDirectory},
      commands: profile.tests.map((item) => item.command),
      tests: profile.tests,
      p0: {status: profile.p0.status, reasonCode: profile.p0.reasonCode, subgates: profile.p0.details?.subgates || []},
      qeResult: ready ? "GREEN" : "RED",
      reasonCodes: [...new Set(reasons)],
      READY_FOR_BRANCH_PUSH_APPROVAL: ready,
      approvalRequestId: requestId,
      approveCommand: requestId ? approveCommand(paths, requestId, identity.candidateSha) : null,
      PUSHED: false,
      autoFix: false,
      candidateMutation: profile.candidateMutation,
      activeSkips: profile.tests.filter((item) => item.skipped).length
    };
    report.reportSha256 = canonicalHash(report, "reportSha256");
    const files = writeReportFiles(report, paths);
    if (ready) createPending(identity, report, paths);
    printBlocked(report, files);
    process.exitCode = 1;
  } catch (error) {
    let report;
    try {
      if (!paths && root) paths = managedPaths(commonDirectory(root));
      report = reportBlockedError(error, paths);
    } catch (_reportError) {
      report = reportBlockedError(error, null);
    }
    printBlocked(report);
    process.exitCode = 1;
  }
}

function approveMode(argv) {
  const args = parseArgs(argv);
  const requestId = String(args["request-id"] || "");
  const candidate = String(args.candidate || "");
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[a-f0-9]{40}$/.test(candidate)) {
    throw new GateError("APPROVAL_ARGUMENT_INVALID", "approve requires exact --request-id and --candidate.");
  }
  const root = repoRoot();
  const verified = verifyManifest(root);
  if (verified.reasons.length) throw new GateError("GATE_INSTALLATION_INVALID", verified.reasons.join(", "));
  const pendingFile = path.join(verified.paths.pending, `${requestId}.json`);
  if (!fs.existsSync(pendingFile)) throw new GateError("APPROVAL_REQUEST_NOT_FOUND", "Pending approval request does not exist.");
  const request = safeJson(pendingFile);
  if (request.schemaVersion !== STATE_SCHEMA || request.kind !== "PENDING" || request.requestId !== requestId ||
      canonicalHash(request, "requestSha256") !== request.requestSha256) {
    throw new GateError("APPROVAL_REQUEST_INVALID", "Pending approval request failed integrity validation.");
  }
  if (request.candidateSha !== candidate) throw new GateError("APPROVAL_CANDIDATE_MISMATCH", "Candidate SHA does not match the request.");
  if (Date.parse(request.expiresAt) <= Date.now() || Date.parse(request.expiresAt) - Date.parse(request.createdAt) > MAX_APPROVAL_MS) {
    invalidate(pendingFile, verified.paths, "expired");
    throw new GateError("APPROVAL_REQUEST_EXPIRED", "Approval request has expired.");
  }
  const report = safeJson(path.join(verified.paths.reports, `${request.reportId}.json`));
  if (!reportHashValid(report) || report.reportSha256 !== request.reportSha256 || report.READY_FOR_BRANCH_PUSH_APPROVAL !== true || report.PUSHED !== false) {
    throw new GateError("APPROVAL_REPORT_INVALID", "Approval report is missing, changed, or not approvable.");
  }
  const approval = {
    ...request,
    kind: "APPROVED",
    approvedAt: new Date().toISOString()
  };
  delete approval.requestSha256;
  approval.approvalSha256 = canonicalHash(approval, "approvalSha256");
  const approvalFile = path.join(verified.paths.approvals, `${requestId}.json`);
  if (fs.existsSync(approvalFile)) throw new GateError("APPROVAL_ALREADY_EXISTS", "Approval already exists.");
  atomicWrite(approvalFile, `${JSON.stringify(approval, null, 2)}\n`, 0o600);
  fs.unlinkSync(pendingFile);
  process.stdout.write(`${JSON.stringify({status: "APPROVED_ONCE", requestId, candidateSha: candidate, expiresAt: approval.expiresAt, reportSha256: approval.reportSha256}, null, 2)}\n`);
}

function main() {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === "install") return installMode();
  if (mode === "doctor") return doctorMode();
  if (mode === "approve") return approveMode(argv);
  if (mode === "hook") return hookMode(argv[0], argv[1]);
  throw new GateError("UNKNOWN_COMMAND", "Usage: sde-prepush-gate.cjs <install|doctor|approve|hook>.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`SDE pre-push gate: ${error.code || "UNHANDLED_ERROR"}\n${scrub(error.stack || error.message)}\nPUSHED: FALSE\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  GATE_ID,
  GATE_VERSION,
  PROFILE_VERSION,
  GateError,
  binding,
  candidateMutationStatus,
  canonicalHash,
  canonicalRemoteUrl,
  candidateIdentity,
  doctorStatus,
  parsePrePushInput,
  p0Ready,
  policyScan,
  sameBinding,
  sha256,
  stableJson
};

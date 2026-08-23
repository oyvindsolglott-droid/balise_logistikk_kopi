#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config', 'sde-canonical-shift-rollback-v1.json'), 'utf8'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8',
    input: options.input,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout || ''}${result.stderr || ''}`);
  }
  const output = String(result.stdout || '');
  return options.trim === false ? output : output.trim();
}

function git(cwd, ...args) {
  return run('git', args, { cwd });
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function dataHashes(cwd) {
  return Object.fromEntries(manifest.protectedRepositoryData.map(relative => {
    const absolute = path.join(cwd, relative);
    assert.ok(fs.existsSync(absolute), `Protected repository data is missing: ${relative}`);
    return [relative, sha256File(absolute)];
  }));
}

function assertClean(cwd) {
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'Rollback drill requires a clean committed candidate.');
}

function listUntrackedFiles(cwd) {
  const result = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: null,
    stdio: 'pipe',
  });
  if (result.status !== 0) throw new Error(`Unable to list worktree snapshot files (${result.status})`);
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function materializeWorktreeCandidate(temporaryParent, baselineSha) {
  const source = path.join(temporaryParent, 'candidate-source');
  run('git', ['clone', '--shared', '--no-checkout', root, source], { cwd: temporaryParent });
  git(source, 'checkout', '-b', 'worktree-candidate-source', baselineSha);
  git(source, 'config', '--local', 'user.name', 'SDE Disposable Rollback Drill');
  git(source, 'config', '--local', 'user.email', 'sde-rollback-drill@example.invalid');
  const patch = run('git', ['diff', '--binary', '--no-ext-diff', baselineSha], { cwd: root, trim: false });
  if (patch) run('git', ['apply', '--index', '--binary', '-'], { cwd: source, input: patch });
  for (const relative of listUntrackedFiles(root)) {
    const from = path.join(root, relative);
    const to = path.join(source, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  git(source, 'add', '-A');
  assert.notEqual(git(source, 'status', '--porcelain'), '', 'Worktree snapshot contains no candidate change.');
  git(source, 'commit', '-m', 'SDE disposable Phase A rollback snapshot');
  return {
    source,
    candidateSha: git(source, 'rev-parse', 'HEAD'),
    candidateTree: git(source, 'rev-parse', 'HEAD^{tree}'),
  };
}

function main() {
  assert.equal(manifest.rollbackMethod, 'REVERT_COMMIT_AND_CONTROLLED_REDEPLOY');
  assert.deepEqual(manifest.forbiddenGitOperations, ['reset', 'rebase', 'force', 'force-with-lease']);
  const worktreeCandidate = process.argv.includes('--worktree-candidate');
  const baselineSha = git(root, 'rev-parse', manifest.previousProductSha);
  const baselineTree = git(root, 'rev-parse', `${baselineSha}^{tree}`);
  const nodePath = String(process.env.SDE_ROLLBACK_NODE_PATH || '').trim();
  assert.ok(nodePath && fs.existsSync(nodePath), 'SDE_ROLLBACK_NODE_PATH must identify an existing read-only server node_modules tree.');

  const temporaryParent = fs.mkdtempSync(path.join(os.tmpdir(), 'sde-shift-rollback-'));
  let candidateSource = root;
  let candidateSha;
  let candidateTree;
  let commits;
  if (worktreeCandidate) {
    const snapshot = materializeWorktreeCandidate(temporaryParent, baselineSha);
    candidateSource = snapshot.source;
    candidateSha = snapshot.candidateSha;
    candidateTree = snapshot.candidateTree;
    commits = [candidateSha];
  } else {
    assertClean(root);
    candidateSha = git(root, 'rev-parse', 'HEAD');
    assert.equal(git(root, 'merge-base', '--is-ancestor', baselineSha, candidateSha), '');
    assert.notEqual(candidateSha, baselineSha, 'A committed Phase A candidate is required before commit-bound rollback drill.');
    candidateTree = git(root, 'rev-parse', `${candidateSha}^{tree}`);
    commits = git(root, 'rev-list', '--reverse', `${baselineSha}..${candidateSha}`).split('\n').filter(Boolean);
    assert.ok(commits.length > 0, 'No Phase A candidate commits found.');
  }
  const clone = path.join(temporaryParent, 'drill');
  const evidence = {
    schemaVersion: manifest.evidenceOutputSchema,
    contractId: manifest.contractId,
    baselineSha,
    candidateSha,
    appliedCommits: commits,
    revertCommits: [],
    candidateTree,
    candidateSource: worktreeCandidate ? 'DISPOSABLE_WORKTREE_SNAPSHOT_COMMIT' : 'COMMITTED_PHASE_A_CANDIDATE',
    finalCommitBoundDrillRequired: worktreeCandidate,
    baselineTree,
    rollbackMethod: manifest.rollbackMethod,
    productionServerRestarted: false,
    productionSyncworkerTouched: false,
    businessWrite: false,
  };
  let succeeded = false;
  try {
    run('git', ['clone', '--shared', '--no-checkout', candidateSource, clone], { cwd: temporaryParent });
    git(clone, 'checkout', '-b', 'rollback-drill', baselineSha);
    git(clone, 'config', '--local', 'user.name', 'SDE Disposable Rollback Drill');
    git(clone, 'config', '--local', 'user.email', 'sde-rollback-drill@example.invalid');
    const hashesBefore = dataHashes(clone);
    for (const commit of commits) git(clone, 'cherry-pick', commit);
    assert.equal(git(clone, 'rev-parse', 'HEAD^{tree}'), candidateTree, 'Applied candidate tree does not match exact candidate.');
    run(process.execPath, ['--test', ...manifest.candidateSmoke], {
      cwd: clone,
      env: { ...process.env, NODE_PATH: nodePath },
    });
    for (const commit of [...commits].reverse()) {
      git(clone, 'revert', '--no-edit', commit);
      evidence.revertCommits.push(git(clone, 'rev-parse', 'HEAD'));
    }
    assert.equal(git(clone, 'rev-parse', 'HEAD^{tree}'), baselineTree, 'Reverted tree differs from previous product tree.');
    assert.equal(git(clone, 'diff', '--exit-code', baselineSha, '--', ...manifest.protectedRepositoryData), '');
    run(process.execPath, [manifest.revertedRuntimeSmoke], {
      cwd: clone,
      env: { ...process.env, NODE_PATH: nodePath },
    });
    const hashesAfter = dataHashes(clone);
    assert.deepEqual(hashesAfter, hashesBefore, 'Protected repository data changed during rollback drill.');
    evidence.protectedDataSha256Before = hashesBefore;
    evidence.protectedDataSha256After = hashesAfter;
    evidence.revertedTree = git(clone, 'rev-parse', 'HEAD^{tree}');
    evidence.status = 'GREEN';
    succeeded = true;
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    if (succeeded) fs.rmSync(temporaryParent, { recursive: true, force: false });
    else process.stderr.write(`Rollback evidence retained for diagnosis: ${temporaryParent}\n`);
  }
}

main();

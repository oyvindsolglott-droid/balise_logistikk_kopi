const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config', 'sde-canonical-shift-rollback-v1.json'), 'utf8'));
const runbook = fs.readFileSync(path.join(root, 'docs', 'sde-canonical-shift-rollback-v1.md'), 'utf8');
const drill = fs.readFileSync(path.join(root, 'scripts', 'test-sde-canonical-shift-rollback.cjs'), 'utf8');

test('rollback manifest binds the exact previous product and a runtime-resolved immutable candidate', () => {
  assert.equal(manifest.contractId, 'SDE-CANONICAL-SHIFT-ROLLBACK-20260822-V1');
  assert.equal(manifest.previousProductSha, 'acf02a455cff4ba6275ac0ab388a138d05b47f5a');
  assert.equal(manifest.candidateRef, 'HEAD');
  assert.match(manifest.candidateShaResolution, /temporary commit/i);
  assert.match(manifest.candidateShaResolution, /repeat against git rev-parse HEAD/i);
  assert.equal(manifest.rollbackMethod, 'REVERT_COMMIT_AND_CONTROLLED_REDEPLOY');
});

test('rollback contract forbids history rewriting and production mutation', () => {
  assert.deepEqual(manifest.forbiddenGitOperations, ['reset', 'rebase', 'force', 'force-with-lease']);
  assert.equal(manifest.serverRestart.productionRestartDuringDrill, false);
  assert.equal(manifest.syncworker.productionWorkerTouched, false);
  assert.match(runbook, /never rewrites Git history/i);
  assert.match(runbook, /never edits production data/i);
});

test('disposable drill applies candidate, creates real revert commits and proves the baseline tree', () => {
  assert.match(drill, /cherry-pick/);
  assert.match(drill, /git\(clone, 'revert', '--no-edit', commit\)/);
  assert.match(drill, /git\(clone, 'config', '--local', 'user\.name'/);
  assert.match(drill, /git\(clone, 'config', '--local', 'user\.email'/);
  assert.match(drill, /reverted tree differs from previous product tree/i);
  assert.match(drill, /Protected repository data changed during rollback drill/i);
  assert.doesNotMatch(drill, /git\([^\n]*['"](?:reset|rebase)['"]/);
  assert.doesNotMatch(drill, /--force(?:-with-lease)?/);
});

test('drill supports an exact pre-commit snapshot and requires a later commit-bound repeat', () => {
  assert.match(drill, /--worktree-candidate/);
  assert.match(drill, /DISPOSABLE_WORKTREE_SNAPSHOT_COMMIT/);
  assert.match(drill, /Rollback drill requires a clean committed candidate/);
  assert.match(drill, /A committed Phase A candidate is required before commit-bound rollback drill/);
  assert.match(runbook, /commit-bound repeat is mandatory/i);
  assert.match(runbook, /HOLD — TESTED ROLLBACK TO PREVIOUS ENGINE IS NOT AVAILABLE/);
});

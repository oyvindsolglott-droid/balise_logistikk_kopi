const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../../config/sde-shift-acceptance-scenarios-v1.json');
const coverage = require('../../config/sde-shift-acceptance-coverage-v1.json');
const { buildInventory } = require('../../scripts/sde-vehicle-id-inventory.cjs');
const root = path.resolve(__dirname, '../..');

test('the permanent Phase A acceptance catalog contains exactly scenarios 1 through 87', () => {
  assert.equal(catalog.contractId, 'SDE-SHIFT-ACCEPTANCE-87-20260822-V1');
  assert.equal(catalog.searchBoundaryVersion, 'SDE-SHIFT-SEARCH-BOUNDARY-20260822-V1');
  assert.equal(catalog.scenarios.length, 87);
  assert.deepEqual(catalog.scenarios.map(item => item.number), Array.from({ length: 87 }, (_, index) => index + 1));
  assert.equal(new Set(catalog.scenarios.map(item => item.id)).size, 87);
});

test('only the named 70-11 evidence-dependent scenarios declare the exact historical fixture gate', () => {
  const gated = catalog.scenarios.filter(item => item.requiresExactHistoricalFixture).map(item => item.number);
  assert.deepEqual(gated, [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]);
});

test('every acceptance scenario has exactly one explicit coverage state and evidence anchor', () => {
  assert.equal(coverage.contractId, 'SDE-SHIFT-ACCEPTANCE-COVERAGE-20260822-V1');
  assert.equal(coverage.catalogContractId, catalog.contractId);
  assert.equal(coverage.entries.length, 87);
  assert.deepEqual(coverage.entries.map(item => item.number), catalog.scenarios.map(item => item.number));
  assert.equal(new Set(coverage.entries.map(item => item.number)).size, 87);
  for (const entry of coverage.entries) {
    assert.ok(['AUTOMATED', 'AUTOMATED_RUNTIME_DRILL_REQUIRED'].includes(entry.status));
    assert.ok(entry.file && entry.anchor, `scenario ${entry.number} must bind evidence`);
    const source = fs.readFileSync(path.join(root, entry.file), 'utf8');
    assert.ok(source.includes(entry.anchor), `scenario ${entry.number} evidence anchor missing: ${entry.anchor}`);
  }
});

test('the exact historical fixture is automated while runtime rollback evidence remains an explicit gate', () => {
  assert.deepEqual(coverage.entries.filter(item => item.status === 'HOLD_EXACT_FIXTURE_REQUIRED'), []);
  assert.ok(coverage.entries.filter(item => item.number >= 33 && item.number <= 43).every(item =>
    item.status === 'AUTOMATED' && item.file === 'tests/sde/canonical-shift-70-11-regression.test.cjs'
  ));
  assert.deepEqual(
    coverage.entries.filter(item => item.status === 'AUTOMATED_RUNTIME_DRILL_REQUIRED').map(item => item.number),
    [82, 83, 84, 85, 87],
  );
});

test('named regression identities in catalog, exact fixture and harness remain isolated test-only evidence', () => {
  const fixtureFiles = new Set([
    'config/sde-shift-acceptance-scenarios-v1.json',
    'config/sde-regression-70-11-10s-to-8s-silent-candidate-drop-20260821-v1.json',
    'tests/sde/canonical-shift-70-11-regression.test.cjs',
  ]);
  const occurrences = buildInventory().occurrences.filter(item => fixtureFiles.has(item.file));
  assert.ok(occurrences.length > 11);
  assert.ok(occurrences.every(item => item.classification === 'TEST_FIXTURE'));
  assert.ok(occurrences.every(item => item.runtimeReachable === false && item.plannerRelevant === false));
});

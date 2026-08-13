"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  assertReadOnlyMethod,
  normalizeEndpoint,
  runProductionReadOnly
} = require("../lib/production-readonly.cjs");
const { buildInventory } = require("../lib/inventory.cjs");
const {
  isNightPlanTabRegistered,
  qualificationNodePath,
  serverScriptArgument,
  validateRegistry
} = require("../lib/checks.cjs");

test("nattplan-tab må være statisk eller komplett dynamisk registrert", () => {
  assert.equal(isNightPlanTabRegistered('<button data-tab="sdeNattplanErfaring">'), true);
  const dynamic = [
    'const SDE_NIGHT_PLAN_TAB_ID = "sdeNattplanErfaring";',
    'button.dataset.tab = SDE_NIGHT_PLAN_TAB_ID;',
    'function syncSdeNightPlanMenuButton(){ return true; }'
  ].join("\n");
  assert.equal(isNightPlanTabRegistered(dynamic), true);
  assert.equal(
    isNightPlanTabRegistered('const SDE_NIGHT_PLAN_TAB_ID = "sdeNattplanErfaring";'),
    false,
    "en konstant uten mount-path må feile lukket"
  );
});

test("production guard tillater bare GET og HEAD", () => {
  assert.equal(assertReadOnlyMethod("get"), "GET");
  assert.equal(assertReadOnlyMethod("HEAD"), "HEAD");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.throws(
      () => assertReadOnlyMethod(method),
      /SDE_QE_READ_ONLY_GUARD/
    );
  }
});

test("production endpoint må være lokal absolutt path", () => {
  assert.equal(normalizeEndpoint("/api/health"), "/api/health");
  for (const endpoint of ["api/health", "//evil.example/api", "", null]) {
    assert.throws(() => normalizeEndpoint(endpoint), /Ugyldig production-endepunkt/);
  }
});

test("manglende production-URL gir en unik, eksplisitt blokkering uten nettverkskall", async () => {
  const observed = await runProductionReadOnly("");
  assert.deepEqual(observed.ledger, []);
  assert.equal(observed.results.length, 1);
  assert.equal(observed.results[0].id, "PROD-READONLY-URL");
  assert.equal(observed.results[0].contractId, "QE-SAFE-001");
  assert.equal(observed.results[0].status, "BLOCKED");
});

test("kontraktregister og funksjonsmatrise er sammenhengende", () => {
  const observed = validateRegistry();
  assert.equal(observed.status, "GREEN", JSON.stringify(observed.details, null, 2));
  assert.ok(observed.details.contractCount >= 25);
  assert.ok(observed.details.functionCount >= 35);
});

test("inventaret finner seks nivåer og sentrale moduler", () => {
  const inventory = buildInventory();
  assert.deepEqual(
    inventory.accessLevels.map((item) => item.value).sort(),
    ["0", "1", "2", "3", "4", "5"]
  );
  const tabs = new Set(inventory.navigation.map((item) => item.tab));
  for (const tab of ["oppstilling", "sporplan", "sdeSkiftebevegelser", "dropsMateriellstyrer"]) {
    assert.ok(tabs.has(tab), `mangler ${tab}`);
  }
  assert.ok(inventory.tests.permanent.length >= 50);
  assert.ok(inventory.tests.server.length >= 20);
});

test("serverkommandoer er relative til server-arbeidskatalogen", () => {
  assert.equal(
    serverScriptArgument("/repo", "server/scripts/test-access-identity.js"),
    "scripts/test-access-identity.js"
  );
  assert.throws(
    () => serverScriptArgument("/repo", "tests/sde/firewall.test.cjs"),
    /utenfor server/
  );
});

test("qualification-wrapperen bevarer eksplisitt ekstern dependency-path", () => {
  const observed = qualificationNodePath("/isolert-worktree", {
    NODE_PATH: ["/shared/server/node_modules", "/shared/extra"].join(path.delimiter)
  });
  assert.deepEqual(observed.split(path.delimiter), [
    "/isolert-worktree/server/node_modules",
    "/shared/server/node_modules",
    "/shared/extra"
  ]);
});

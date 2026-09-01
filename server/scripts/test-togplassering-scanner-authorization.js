"use strict";

// The scanner routes sit behind the same night_plan.read capability as the menu
// button that opens the import surface. If the two disagree, the button appears
// and then the import is refused, which reads to the user as a broken scanner.

const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const {createTogplasseringScannerApi} = require("../src/togplasseringScannerRoutes");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function identity(subject) {
  return {authenticated: true, identityVerified: true, identityKind: "human", subject};
}

const IDENTITIES = {
  txp: identity("txp-subject"),
  drops: identity("drops-subject")
};

const BINDINGS = [
  {bindingId: "txp-binding", subject: "txp-subject", role: "txp", enabled: true},
  {bindingId: "drops-binding", subject: "drops-subject", role: "drops", enabled: true}
];

async function withServer(apiOptions, run) {
  const api = createTogplasseringScannerApi({
    repositoryRoot: REPO_ROOT,
    verifyIdentityRequest: async ({headers}) => {
      const key = headers["x-test-identity"];
      return IDENTITIES[key]
        ? {ok: true, status: 200, identity: IDENTITIES[key]}
        : {ok: false, status: 401, publicError: "authentication_required"};
    },
    ...apiOptions
  });
  const app = express();
  app.use("/api/togplassering-scanner", api.router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getStatus(baseUrl, testIdentity) {
  const headers = testIdentity ? {"x-test-identity": testIdentity} : {};
  const response = await fetch(`${baseUrl}/api/togplassering-scanner/status`, {headers});
  return {status: response.status, body: await response.json()};
}

const checks = [];
function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
}

async function main() {
  await withServer({roleBindingsCatalog: {bindings: BINDINGS}}, async (baseUrl) => {
    const anonymous = await getStatus(baseUrl, null);
    check("anonymous request is refused", anonymous.status === 401);
    check("anonymous refusal names authentication", anonymous.body.error === "authentication_required");

    const txp = await getStatus(baseUrl, "txp");
    check("a bound txp identity reaches the scanner", txp.status === 200);
    check("the scanner reports its engine", txp.body.engine === "togplassering-skien-scanner-v0.3");
    check("the scanner never accepts a client key", txp.body.clientApiKey === false);

    const drops = await getStatus(baseUrl, "drops");
    check("a role without night_plan.read is denied", drops.status === 403);
    check("the denial names the capability", drops.body.error === "night_plan_capability_denied");
  });

  // The regression: the API used to forward options.roleBindingsCatalog straight
  // into the guard. Omitted, that is undefined, no role resolves, and every
  // verified identity gets 403 while the menu button stays visible.
  const catalogPath = path.join(os.tmpdir(), `sde-scanner-bindings-${process.pid}.json`);
  fs.writeFileSync(catalogPath, JSON.stringify({bindings: BINDINGS}), "utf8");
  try {
    await withServer(
      {env: {...process.env, SDE_IDENTITY_ROLE_BINDINGS_PATH: catalogPath}},
      async (baseUrl) => {
        const txp = await getStatus(baseUrl, "txp");
        check(
          "an omitted catalog is loaded from the environment rather than left undefined",
          txp.status === 200
        );
      }
    );
  } finally {
    fs.rmSync(catalogPath, {force: true});
  }

  console.log(`togplasseringScannerAuthorizationTests: ${checks.length}/${checks.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

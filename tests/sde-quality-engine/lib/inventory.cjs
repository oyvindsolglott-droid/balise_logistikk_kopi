"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { repoRoot, readJson } = require("./core.cjs");

function countSourceFunctions(source) {
  const names = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
}

function navigationInventory(html) {
  const entries = [];
  const pattern = /<button\b([^>]*\bdata-tab="([^"]+)"[^>]*)>([\s\S]*?)<\/button>/g;
  for (const match of html.matchAll(pattern)) {
    const attrs = match[1];
    const get = (name) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || null;
    entries.push({
      tab: match[2],
      levels: (get("data-levels") || "").split(/\s+/).filter(Boolean),
      ariaLabel: get("aria-label"),
      className: get("class"),
      hidden: /display\s*:\s*none/.test(get("style") || "")
    });
  }
  return entries;
}

function accessLevelInventory(html) {
  const select = html.match(/<select[^>]+id="accessLevelSelect"[\s\S]*?<\/select>/)?.[0] || "";
  return [...select.matchAll(/<option\s+value="([^"]+)">([^<]+)<\/option>/g)]
    .map((match) => ({ value: match[1], label: match[2].trim() }));
}

function serverRouteInventory(source) {
  const routes = [];
  const pattern = /\bapp\.(get|post|put|patch|delete|head)\(\s*["'`]([^"'`]+)["'`]/gi;
  for (const match of source.matchAll(pattern)) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return routes;
}

function recursiveFiles(dir, predicate, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) recursiveFiles(file, predicate, output);
    else if (predicate(file)) output.push(file);
  }
  return output;
}

function buildInventory() {
  const root = repoRoot();
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const serverSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
  const permanentTests = recursiveFiles(path.join(root, "tests/sde"), (file) =>
    /\.(?:c?js|json)$/.test(file)
  );
  const pythonTests = recursiveFiles(root, (file) =>
    /(?:^|\/)test[^/]*\.py$/.test(file) && !file.includes("/.git/")
  );
  const serverTests = recursiveFiles(path.join(root, "server/scripts"), (file) =>
    /\/test[-_].*\.(?:js|py)$/.test(file)
  );
  const matrix = readJson(path.join(root, "tests/sde-quality-engine/matrix/function-matrix.json"));
  const contracts = readJson(path.join(root, "tests/sde-quality-engine/contracts/green-contract.json"));
  return {
    generatedAt: new Date().toISOString(),
    source: {
      indexHtmlLines: html.split("\n").length,
      indexFunctionNames: countSourceFunctions(html),
      serverRoutes: serverRouteInventory(serverSource)
    },
    navigation: navigationInventory(html),
    accessLevels: accessLevelInventory(html),
    tests: {
      permanent: permanentTests.map((file) => path.relative(root, file)).sort(),
      python: pythonTests.map((file) => path.relative(root, file)).sort(),
      server: serverTests.map((file) => path.relative(root, file)).sort()
    },
    matrix: {
      functions: matrix.functions.length,
      modules: [...new Set(matrix.functions.map((item) => item.module))].sort()
    },
    contracts: {
      count: contracts.contracts.length,
      areas: [...new Set(contracts.contracts.map((item) => item.area))].sort()
    }
  };
}

module.exports = {
  accessLevelInventory,
  buildInventory,
  countSourceFunctions,
  navigationInventory,
  serverRouteInventory
};

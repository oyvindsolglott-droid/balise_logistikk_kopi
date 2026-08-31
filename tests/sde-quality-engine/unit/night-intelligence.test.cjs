"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const {test} = require("node:test");

const root = path.resolve(__dirname, "../../..");

function run(command, args) {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const result = childProcess.spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr || result.stdout);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("Quality Engine kjører permanente nattintelligenskontrakter", () => {
  const result = run(process.execPath, ["--test", "tests/sde/intelligent-night-planning.test.cjs", "tests/sde/handwriting-recognition.test.cjs"]);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /tests 61/);
  assert.match(output, /fail 0/);
});

test("Quality Engine kjører offline ML-, leakage- og promotionkontrakter", () => {
  const result = run("python3", ["-m", "unittest", "-v", "tests/sde/test_sde_night_model.py"]);
  assert.match(result.stderr, /Ran 8 tests/);
  assert.match(result.stderr, /OK/);
});

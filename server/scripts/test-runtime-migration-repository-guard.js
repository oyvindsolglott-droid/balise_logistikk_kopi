const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  normalizeRepositoryIdentity,
  validateApprovedServerRoot
} = require("../src/repositoryServerRoot");
const { getRuntimeMigrationGuardFailure } = require("../src/runtimeMigrationMode");

const SERVER_ROOT = fs.realpathSync(path.resolve(__dirname, ".."));
const REPOSITORY_ROOT = fs.realpathSync(path.resolve(SERVER_ROOT, ".."));

run();

function run(){
  assert.equal(validateApprovedServerRoot(SERVER_ROOT).ok, true, "current legitimate worktree server root");

  const commonDirRaw = git(REPOSITORY_ROOT, ["rev-parse", "--git-common-dir"]);
  const commonDir = fs.realpathSync(path.resolve(REPOSITORY_ROOT, commonDirRaw));
  const mainServerRoot = path.join(path.dirname(commonDir), "server");
  if(fs.existsSync(mainServerRoot)){
    assert.equal(validateApprovedServerRoot(mainServerRoot).ok, true, "main worktree server root");
  }

  assertRejected(REPOSITORY_ROOT, "repository parent is not server root");
  assertRejected(path.dirname(REPOSITORY_ROOT), "parent directory is rejected");
  assertRejected("/", "filesystem root is rejected");
  assertRejected(os.homedir(), "home directory is rejected");

  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sde-fake-repository-"));
  try{
    const fakeServer = path.join(fakeRoot, "server");
    fs.mkdirSync(path.join(fakeServer, "src"), { recursive: true });
    fs.writeFileSync(path.join(fakeRoot, "index.html"), "fake");
    fs.writeFileSync(path.join(fakeRoot, "package.json"), JSON.stringify({ name: "sde-permanent-regression-firewall" }));
    fs.writeFileSync(path.join(fakeServer, "package.json"), JSON.stringify({ name: "sde-server" }));
    fs.writeFileSync(path.join(fakeServer, "src", "runtimeMigrationMode.js"), "// fake");
    assertRejected(fakeServer, "directory that only imitates server markers is rejected");

    git(fakeRoot, ["init"]);
    git(fakeRoot, ["config", "user.email", "sde-qe@example.invalid"]);
    git(fakeRoot, ["config", "user.name", "SDE QE"]);
    git(fakeRoot, ["remote", "add", "origin", "https://github.com/example/not-sde.git"]);
    git(fakeRoot, ["add", "."]);
    git(fakeRoot, ["commit", "-m", "fake repository"]);
    assertRejected(fakeServer, "tracked marker imitation with wrong repository identity is rejected");
  }finally{
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }

  assert.deepEqual(
    normalizeRepositoryIdentity("git@github.com:oyvindsolglott-droid/balise_logistikk_kopi.git"),
    { host: "github.com", owner: "oyvindsolglott-droid", name: "balise_logistikk_kopi" },
    "SSH origin normalization"
  );

  const migrationGuard = getRuntimeMigrationGuardFailure({
    port: 9797,
    rawPort: "9797",
    databasePath: "/tmp/sde-runtime-migration-guard.sqlite3",
    cwd: SERVER_ROOT,
    env: {
      SDE_ENABLE_SCHEMA_MIGRATIONS: "1",
      SDE_SERVER_DB_PATH: "/tmp/sde-runtime-migration-guard.sqlite3"
    }
  });
  assert.equal(migrationGuard, null, "legitimate worktree passes the complete migration guard");

  const rejectedGuard = getRuntimeMigrationGuardFailure({
    port: 9797,
    rawPort: "9797",
    databasePath: "/tmp/sde-runtime-migration-guard.sqlite3",
    cwd: REPOSITORY_ROOT,
    env: {
      SDE_ENABLE_SCHEMA_MIGRATIONS: "1",
      SDE_SERVER_DB_PATH: "/tmp/sde-runtime-migration-guard.sqlite3"
    }
  });
  assert.equal(rejectedGuard?.error, "schema_migrations_wrong_cwd", "unauthorized cwd keeps fail-closed error");

  console.log("runtime migration repository guard: PASS");
}

function assertRejected(candidate, label){
  assert.equal(validateApprovedServerRoot(candidate).ok, false, label);
}

function git(cwd, args){
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

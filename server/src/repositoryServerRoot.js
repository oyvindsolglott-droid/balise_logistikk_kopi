const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const EXPECTED_REPOSITORY = Object.freeze({
  host: "github.com",
  owner: "oyvindsolglott-droid",
  name: "balise_logistikk_kopi"
});

const REQUIRED_TRACKED_MARKERS = Object.freeze([
  "index.html",
  "package.json",
  "server/package.json",
  "server/src/runtimeMigrationMode.js"
]);

function validateApprovedServerRoot(cwd){
  const canonicalCwd = canonicalDirectory(cwd);
  if(!canonicalCwd.ok){
    return failure("cwd_unavailable", { cwd, cause: canonicalCwd.cause });
  }

  const repositoryRoot = gitOutput(canonicalCwd.value, ["rev-parse", "--show-toplevel"]);
  if(!repositoryRoot.ok){
    return failure("not_a_git_worktree", { cwd: canonicalCwd.value });
  }

  const canonicalRepositoryRoot = canonicalDirectory(repositoryRoot.value);
  if(!canonicalRepositoryRoot.ok){
    return failure("repository_root_unavailable", { repositoryRoot: repositoryRoot.value });
  }

  const expectedServerRoot = canonicalDirectory(path.join(canonicalRepositoryRoot.value, "server"));
  if(!expectedServerRoot.ok || canonicalCwd.value !== expectedServerRoot.value){
    return failure("not_repository_server_root", {
      cwd: canonicalCwd.value,
      repositoryRoot: canonicalRepositoryRoot.value,
      expectedServerRoot: expectedServerRoot.ok ? expectedServerRoot.value : null
    });
  }

  const insideWorktree = gitOutput(canonicalRepositoryRoot.value, ["rev-parse", "--is-inside-work-tree"]);
  if(!insideWorktree.ok || insideWorktree.value !== "true"){
    return failure("not_a_git_worktree", { repositoryRoot: canonicalRepositoryRoot.value });
  }

  const origin = gitOutput(canonicalRepositoryRoot.value, ["config", "--get", "remote.origin.url"]);
  const repositoryIdentity = origin.ok ? normalizeRepositoryIdentity(origin.value) : null;
  if(!repositoryIdentity || !sameRepository(repositoryIdentity, EXPECTED_REPOSITORY)){
    return failure("unexpected_repository", {
      repositoryRoot: canonicalRepositoryRoot.value,
      origin: origin.ok ? origin.value : null
    });
  }

  const markerFailure = validateRepositoryMarkers(canonicalRepositoryRoot.value);
  if(markerFailure){
    return markerFailure;
  }

  const gitCommonDir = gitOutput(canonicalRepositoryRoot.value, ["rev-parse", "--git-common-dir"]);
  if(!gitCommonDir.ok){
    return failure("git_common_dir_unavailable", { repositoryRoot: canonicalRepositoryRoot.value });
  }
  const commonDirPath = path.resolve(canonicalRepositoryRoot.value, gitCommonDir.value);
  const canonicalCommonDir = canonicalDirectory(commonDirPath);
  if(!canonicalCommonDir.ok){
    return failure("git_common_dir_unavailable", { gitCommonDir: commonDirPath });
  }

  return {
    ok: true,
    cwd: canonicalCwd.value,
    repositoryRoot: canonicalRepositoryRoot.value,
    gitCommonDir: canonicalCommonDir.value,
    repositoryIdentity
  };
}

function validateRepositoryMarkers(repositoryRoot){
  for(const marker of REQUIRED_TRACKED_MARKERS){
    const markerPath = path.join(repositoryRoot, marker);
    if(!fs.existsSync(markerPath)){
      return failure("repository_marker_missing", { marker });
    }

    const tracked = gitOutput(repositoryRoot, ["ls-files", "--error-unmatch", "--", marker]);
    if(!tracked.ok || tracked.value !== marker){
      return failure("repository_marker_untracked", { marker });
    }
  }

  const rootPackage = readPackageName(path.join(repositoryRoot, "package.json"));
  if(rootPackage !== "sde-permanent-regression-firewall"){
    return failure("unexpected_root_package", { packageName: rootPackage });
  }

  const serverPackage = readPackageName(path.join(repositoryRoot, "server", "package.json"));
  if(serverPackage !== "sde-server"){
    return failure("unexpected_server_package", { packageName: serverPackage });
  }

  return null;
}

function normalizeRepositoryIdentity(remoteUrl){
  if(typeof remoteUrl !== "string" || !remoteUrl.trim()) return null;
  const raw = remoteUrl.trim().replace(/\.git\/?$/, "");
  let host;
  let pathname;

  const scpMatch = raw.match(/^git@([^:]+):(.+)$/i);
  if(scpMatch){
    host = scpMatch[1];
    pathname = scpMatch[2];
  }else{
    try{
      const parsed = new URL(raw);
      host = parsed.hostname;
      pathname = parsed.pathname.replace(/^\//, "");
    }catch(_error){
      return null;
    }
  }

  const parts = String(pathname || "").split("/").filter(Boolean);
  if(parts.length !== 2) return null;
  return {
    host: String(host || "").toLowerCase(),
    owner: parts[0].toLowerCase(),
    name: parts[1].toLowerCase()
  };
}

function sameRepository(actual, expected){
  return actual.host === expected.host
    && actual.owner === expected.owner
    && actual.name === expected.name;
}

function canonicalDirectory(candidate){
  try{
    const resolved = fs.realpathSync(path.resolve(String(candidate || "")));
    if(!fs.statSync(resolved).isDirectory()){
      return { ok: false, cause: "not_directory" };
    }
    return { ok: true, value: resolved };
  }catch(error){
    return { ok: false, cause: error.code || error.message };
  }
}

function gitOutput(cwd, args){
  try{
    return {
      ok: true,
      value: execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim()
    };
  }catch(_error){
    return { ok: false, value: "" };
  }
}

function readPackageName(packagePath){
  try{
    return JSON.parse(fs.readFileSync(packagePath, "utf8")).name || null;
  }catch(_error){
    return null;
  }
}

function failure(reason, details = {}){
  return { ok: false, reason, details };
}

module.exports = {
  EXPECTED_REPOSITORY,
  REQUIRED_TRACKED_MARKERS,
  normalizeRepositoryIdentity,
  validateApprovedServerRoot
};

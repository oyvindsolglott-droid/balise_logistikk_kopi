#!/usr/bin/env python3
import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest

WORKER = Path(__file__).with_name("sync_production_balise_data.py")
spec = importlib.util.spec_from_file_location("sync_production_balise_data", WORKER)
worker_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker_module)

GIT = "/usr/bin/git"
NOW_AFTER_15 = "2026-07-10T16:00:00+02:00"
NOW_BEFORE_07 = "2026-07-10T06:30:00+02:00"
NOW_DAY = "2026-07-10T12:00:00+02:00"


def run(cmd, cwd=None, check=True, input_text=None):
    result = subprocess.run(cmd, cwd=cwd, text=True, input=input_text, capture_output=True)
    if check and result.returncode != 0:
        raise AssertionError(f"command failed {cmd}\nstdout={result.stdout}\nstderr={result.stderr}")
    return result


def write_json(path, date="2026-07-10", updated="10.07.2026 10:00:00", extra=None):
    payload = {"date": date, "updatedAt": updated, "items": []}
    if extra:
        payload.update(extra)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")


class GitFixture:
    def __init__(self, test_case):
        self.test_case = test_case
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.remote = self.root / "remote.git"
        self.seed = self.root / "seed"
        self.prod = self.root / "prod"
        self.status = self.root / "status.json"
        self.log = self.root / "sync.log"
        self.lock = self.root / "sync.lock"
        self._init()

    def cleanup(self):
        self.tmp.cleanup()

    def _init(self):
        run([GIT, "init", "--bare", str(self.remote)])
        run([GIT, "init", "-b", "main"], cwd=self.root)
        # Use a real work repo in seed rather than the root itself.
        run([GIT, "init", "-b", "main", str(self.seed)])
        run([GIT, "config", "user.name", "Test"], cwd=self.seed)
        run([GIT, "config", "user.email", "test@example.invalid"], cwd=self.seed)
        write_json(self.seed / "data/api_idag.json", "2026-07-10", "10.07.2026 10:00:00")
        write_json(self.seed / "data/api_imorgen.json", "2026-07-11", "10.07.2026 10:00:01")
        (self.seed / "index.html").write_text("<html></html>\n", encoding="utf-8")
        (self.seed / "server/src").mkdir(parents=True)
        (self.seed / "server/src/index.js").write_text("console.log('server');\n", encoding="utf-8")
        run([GIT, "add", "."], cwd=self.seed)
        run([GIT, "commit", "-m", "initial"], cwd=self.seed)
        run([GIT, "remote", "add", "origin", str(self.remote)], cwd=self.seed)
        run([GIT, "push", "-u", "origin", "main"], cwd=self.seed)
        run([GIT, "clone", str(self.remote), str(self.prod)])
        run([GIT, "checkout", "main"], cwd=self.prod)
        run([GIT, "config", "user.name", "Prod"], cwd=self.prod)
        run([GIT, "config", "user.email", "prod@example.invalid"], cwd=self.prod)

    def upstream_commit(self, message="data", idag=("2026-07-10", "10.07.2026 10:05:00"), imorgen=("2026-07-11", "10.07.2026 10:05:01"), changes=None, push=True):
        upstream = self.root / f"upstream-{message.replace(' ', '-')}-{len(list(self.root.glob('upstream-*')))}"
        run([GIT, "clone", str(self.remote), str(upstream)])
        run([GIT, "checkout", "main"], cwd=upstream)
        run([GIT, "config", "user.name", "Upstream"], cwd=upstream)
        run([GIT, "config", "user.email", "up@example.invalid"], cwd=upstream)
        if changes is None:
            write_json(upstream / "data/api_idag.json", *idag)
            write_json(upstream / "data/api_imorgen.json", *imorgen)
        else:
            changes(upstream)
        run([GIT, "add", "."], cwd=upstream)
        run([GIT, "commit", "-m", message], cwd=upstream)
        sha = run([GIT, "rev-parse", "HEAD"], cwd=upstream).stdout.strip()
        if push:
            run([GIT, "push", "origin", "main"], cwd=upstream)
        return sha

    def run_worker(self, *extra, check=False, repo=None, remote="origin", now=NOW_AFTER_15):
        repo = repo or self.prod
        cmd = [
            sys.executable,
            str(WORKER),
            "--repo", str(repo),
            "--remote", remote,
            "--branch", "main",
            "--status-file", str(self.status),
            "--log-file", str(self.log),
            "--lock-file", str(self.lock),
            "--git-path", GIT,
            "--now", now,
        ]
        cmd.extend(extra)
        result = run(cmd, check=check)
        return result

    def status_json(self):
        return json.loads(self.status.read_text(encoding="utf-8"))

    def prod_head(self):
        return run([GIT, "rev-parse", "HEAD"], cwd=self.prod).stdout.strip()

    def origin_head(self):
        return run([GIT, "rev-parse", "origin/main"], cwd=self.prod).stdout.strip()


class SyncProductionBaliseDataTests(unittest.TestCase):
    def setUp(self):
        self.fx = GitFixture(self)

    def tearDown(self):
        self.fx.cleanup()

    def test_a_repo_already_up_to_date(self):
        result = self.fx.run_worker(check=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn(self.fx.status_json()["state"], {"up_to_date", "waiting_for_fresh_remote"})
        self.assertEqual(self.fx.prod_head(), self.fx.origin_head())

    def test_b_one_data_only_remote_commit_fast_forwards(self):
        target = self.fx.upstream_commit("data one", idag=("2026-07-10", "10.07.2026 10:10:00"), imorgen=("2026-07-11", "10.07.2026 10:10:01"))
        result = self.fx.run_worker(check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.fx.prod_head(), target)
        self.assertEqual(self.fx.status_json()["state"], "synced")

    def test_c_multiple_data_only_commits_fast_forward_to_exact_target(self):
        self.fx.upstream_commit("data one", idag=("2026-07-10", "10.07.2026 10:10:00"), imorgen=("2026-07-11", "10.07.2026 10:10:01"))
        target = self.fx.upstream_commit("data two", idag=("2026-07-10", "10.07.2026 10:11:00"), imorgen=("2026-07-11", "10.07.2026 10:11:01"))
        result = self.fx.run_worker(check=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.fx.prod_head(), target)
        self.assertEqual(len(self.fx.status_json()["changedCommits"]), 2)

    def test_d_remote_index_html_change_blocks(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("code", changes=lambda p: (p / "index.html").write_text("changed\n", encoding="utf-8"))
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_disallowed_scope")
        self.assertEqual(self.fx.prod_head(), old)

    def test_e_remote_server_change_blocks(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("server", changes=lambda p: (p / "server/src/index.js").write_text("changed\n", encoding="utf-8"))
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_disallowed_scope")
        self.assertEqual(self.fx.prod_head(), old)

    def test_f_disallowed_change_reverted_later_still_blocks(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("bad", changes=lambda p: (p / "index.html").write_text("bad\n", encoding="utf-8"))
        self.fx.upstream_commit("revert bad", changes=lambda p: (p / "index.html").write_text("<html></html>\n", encoding="utf-8"))
        self.fx.upstream_commit("later data", idag=("2026-07-10", "10.07.2026 10:20:00"), imorgen=("2026-07-11", "10.07.2026 10:20:01"))
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_disallowed_scope")
        self.assertEqual(self.fx.prod_head(), old)

    def test_g_remote_merge_commit_blocks(self):
        old = self.fx.prod_head()
        up = self.fx.root / "merge-up"
        run([GIT, "clone", str(self.fx.remote), str(up)])
        run([GIT, "checkout", "main"], cwd=up)
        run([GIT, "config", "user.name", "Upstream"], cwd=up)
        run([GIT, "config", "user.email", "up@example.invalid"], cwd=up)
        run([GIT, "checkout", "-b", "feature"], cwd=up)
        write_json(up / "data/api_idag.json", "2026-07-10", "10.07.2026 10:30:00")
        run([GIT, "add", "."], cwd=up)
        run([GIT, "commit", "-m", "feature data"], cwd=up)
        run([GIT, "checkout", "main"], cwd=up)
        write_json(up / "data/api_imorgen.json", "2026-07-11", "10.07.2026 10:31:00")
        run([GIT, "add", "."], cwd=up)
        run([GIT, "commit", "-m", "main data"], cwd=up)
        run([GIT, "merge", "--no-ff", "feature", "-m", "merge feature"], cwd=up)
        run([GIT, "push", "origin", "main"], cwd=up)
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_merge_commit")
        self.assertEqual(self.fx.prod_head(), old)

    def test_h_dirty_worktree_blocks(self):
        (self.fx.prod / "scratch.txt").write_text("dirty\n", encoding="utf-8")
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_dirty")

    def test_i_local_branch_ahead_blocks(self):
        (self.fx.prod / "local.txt").write_text("local\n", encoding="utf-8")
        run([GIT, "add", "local.txt"], cwd=self.fx.prod)
        run([GIT, "commit", "-m", "local ahead"], cwd=self.fx.prod)
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_ahead_or_diverged")

    def test_j_diverged_branch_blocks(self):
        self.fx.upstream_commit("remote data", idag=("2026-07-10", "10.07.2026 10:40:00"), imorgen=("2026-07-11", "10.07.2026 10:40:01"))
        (self.fx.prod / "local.txt").write_text("local\n", encoding="utf-8")
        run([GIT, "add", "local.txt"], cwd=self.fx.prod)
        run([GIT, "commit", "-m", "local ahead"], cwd=self.fx.prod)
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_ahead_or_diverged")

    def test_k_detached_head_blocks(self):
        run([GIT, "checkout", "--detach"], cwd=self.fx.prod)
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_wrong_branch")

    def test_l_invalid_json_blocks(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("invalid", changes=lambda p: (p / "data/api_idag.json").write_text("{not json", encoding="utf-8"))
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_invalid_json")
        self.assertEqual(self.fx.prod_head(), old)

    def test_m_missing_date_blocks(self):
        old = self.fx.prod_head()
        def change(p):
            (p / "data/api_idag.json").write_text(json.dumps({"updatedAt":"10.07.2026 11:00:00"}) + "\n", encoding="utf-8")
        self.fx.upstream_commit("missing date", changes=change)
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_invalid_json")
        self.assertEqual(self.fx.prod_head(), old)

    def test_n_target_date_older_than_local_blocks(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("older date", idag=("2026-07-09", "09.07.2026 20:00:00"), imorgen=("2026-07-11", "10.07.2026 10:50:01"))
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_regression")
        self.assertEqual(self.fx.prod_head(), old)

    def test_o_target_updated_at_older_same_date_blocks(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("older updated", idag=("2026-07-10", "10.07.2026 09:00:00"), imorgen=("2026-07-11", "10.07.2026 10:50:01"))
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "blocked_regression")
        self.assertEqual(self.fx.prod_head(), old)

    def test_p_required_file_missing_blocks(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("delete file", changes=lambda p: (p / "data/api_imorgen.json").unlink())
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(self.fx.status_json()["state"], {"blocked_invalid_json", "blocked_disallowed_scope"})
        self.assertEqual(self.fx.prod_head(), old)

    def test_q_lock_busy_exits_without_git_operation(self):
        with self.fx.lock.open("w") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.fx.run_worker(check=False)
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "lock_busy")

    def test_r_dry_run_would_sync_head_unchanged(self):
        old = self.fx.prod_head()
        self.fx.upstream_commit("data dry", idag=("2026-07-10", "10.07.2026 10:55:00"), imorgen=("2026-07-11", "10.07.2026 10:55:01"))
        result = self.fx.run_worker("--dry-run", check=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "dry_run_would_sync")
        self.assertEqual(self.fx.prod_head(), old)

    def test_s_fetch_failed_head_unchanged(self):
        old = self.fx.prod_head()
        run([GIT, "remote", "set-url", "origin", str(self.fx.root / "missing.git")], cwd=self.fx.prod)
        result = self.fx.run_worker(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.fx.status_json()["state"], "fetch_failed")
        self.assertEqual(self.fx.prod_head(), old)

    def test_t_successful_sync_status_contains_sha_and_no_secrets(self):
        self.fx.upstream_commit("data status", idag=("2026-07-10", "10.07.2026 11:00:00"), imorgen=("2026-07-11", "10.07.2026 11:00:01"))
        result = self.fx.run_worker(check=False)
        self.assertEqual(result.returncode, 0)
        status = self.fx.status_json()
        self.assertEqual(status["state"], "synced")
        self.assertRegex(status["api_idag"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertNotIn("token", self.fx.log.read_text(encoding="utf-8", errors="ignore").lower())

    def test_u_freshness_before_0700_oslo(self):
        dates = worker_module.expected_dates_for_oslo(NOW_BEFORE_07)
        self.assertEqual(dates["api_idag"], "2026-07-09")
        self.assertEqual(dates["api_imorgen"], "2026-07-10")

    def test_v_freshness_between_0700_and_1500_oslo(self):
        dates = worker_module.expected_dates_for_oslo(NOW_DAY)
        self.assertEqual(dates["api_idag"], "2026-07-10")
        self.assertEqual(dates["api_imorgen"], "2026-07-10")

    def test_w_freshness_after_1500_oslo(self):
        dates = worker_module.expected_dates_for_oslo(NOW_AFTER_15)
        self.assertEqual(dates["api_idag"], "2026-07-10")
        self.assertEqual(dates["api_imorgen"], "2026-07-11")

    def test_x_oslo_dst_summer_and_winter(self):
        summer = worker_module.oslo_now("2026-07-10T12:00:00+00:00")
        winter = worker_module.oslo_now("2026-01-10T12:00:00+00:00")
        self.assertEqual(summer.utcoffset().total_seconds(), 7200)
        self.assertEqual(winter.utcoffset().total_seconds(), 3600)

    def test_y_worker_source_does_not_call_forbidden_git_commands(self):
        source = WORKER.read_text(encoding="utf-8")
        forbidden_snippets = [
            '["pull"', '["reset"', '["clean"', '["stash"', '["rebase"',
            '["commit"', '["push"', 'checkout', '--force', 'force=True',
        ]
        for snippet in forbidden_snippets:
            self.assertNotIn(snippet, source)


if __name__ == "__main__":
    unittest.main()

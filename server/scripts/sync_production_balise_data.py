#!/usr/bin/env python3
"""Fail-closed data-only sync for production Balise static data.

This worker intentionally permits only fast-forward updates where every
remote-only commit touches only the exact three-file generated data contract.
It runs once and exits; launchd is responsible for scheduling.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import fcntl
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import traceback
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

ALLOWED_DATA_FILES = (
    "data/api_idag.json",
    "data/api_imorgen.json",
    "data/sde-data-provenance.json",
)
ALLOWED_DATA_FILE_SET = set(ALLOWED_DATA_FILES)
OPERATIONAL_DATA_FILES = ("data/api_idag.json", "data/api_imorgen.json")
PROVENANCE_FILE = "data/sde-data-provenance.json"
REGULAR_DATA_FILE_MODE = "100644"
STATE_EXIT_OK = {
    "up_to_date",
    "synced",
    "waiting_for_fresh_remote",
    "dry_run_up_to_date",
    "dry_run_would_sync",
}
OSLO = ZoneInfo("Europe/Oslo")
UTC = ZoneInfo("UTC")
UPDATED_AT_FORMAT = "%d.%m.%Y %H:%M:%S"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SyncBlocked(Exception):
    def __init__(self, state: str, message: str, exit_code: int = 2):
        super().__init__(message)
        self.state = state
        self.message = message
        self.exit_code = exit_code


class GitError(Exception):
    def __init__(self, args: Sequence[str], returncode: int, stdout: str, stderr: str):
        super().__init__(f"git {' '.join(args)} failed with {returncode}")
        self.args_list = list(args)
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class LockBusy(Exception):
    pass


def oslo_now(now_text: Optional[str] = None) -> _dt.datetime:
    if now_text:
        text = now_text.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = _dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=OSLO)
        return parsed.astimezone(OSLO)
    return _dt.datetime.now(OSLO)


def iso_date_add(date_text: str, days: int) -> str:
    return (_dt.date.fromisoformat(date_text) + _dt.timedelta(days=days)).isoformat()


def expected_dates_for_oslo(now_text: Optional[str] = None) -> Dict[str, Any]:
    now = oslo_now(now_text)
    today = now.date().isoformat()
    if now.hour < 7:
        return {
            "api_idag": iso_date_add(today, -1),
            "api_imorgen": today,
            "window": "night_before_07",
        }
    if now.hour < 15:
        return {
            "api_idag": today,
            "api_imorgen": today,
            "window": "day_07_to_15",
        }
    return {
        "api_idag": today,
        "api_imorgen": iso_date_add(today, 1),
        "window": "after_15",
    }


def parse_updated_at(text: str) -> _dt.datetime:
    return _dt.datetime.strptime(text, UPDATED_AT_FORMAT).replace(tzinfo=OSLO)


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def mask_url(text: str) -> str:
    return re.sub(r"https://([^/@:\s]+):([^/@\s]+)@", "https://***:***@", text)


def ensure_parent(path: Path) -> None:
    path.expanduser().parent.mkdir(parents=True, exist_ok=True)


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path = path.expanduser()
    ensure_parent(path)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def setup_logger(log_file: Path) -> logging.Logger:
    ensure_parent(log_file)
    logger = logging.getLogger("balise-data-sync")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    handler = RotatingFileHandler(log_file.expanduser(), maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s Europe/Oslo %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.propagate = False
    return logger


class FileLock:
    def __init__(self, path: Path):
        self.path = path.expanduser()
        self.fh = None

    def __enter__(self):
        ensure_parent(self.path)
        self.fh = self.path.open("a+")
        try:
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.fh.close()
            raise LockBusy() from exc
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.fh:
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            self.fh.close()


class SyncWorker:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.repo = Path(args.repo).expanduser()
        self.status_file = Path(args.status_file).expanduser()
        self.log_file = Path(args.log_file).expanduser()
        self.lock_file = Path(args.lock_file).expanduser()
        self.git_path = args.git_path
        self.remote = args.remote
        self.branch = args.branch
        self.logger = setup_logger(self.log_file)
        self.started_utc = _dt.datetime.now(UTC)
        self.status: Dict[str, Any] = {
            "checkedAtUtc": None,
            "checkedAtEuropeOslo": None,
            "state": "unexpected_error",
            "message": "not completed",
            "oldHead": None,
            "targetHead": None,
            "newHead": None,
            "ahead": None,
            "behind": None,
            "changedCommits": [],
            "changedFiles": [],
            "api_idag": None,
            "api_imorgen": None,
            "provenance": None,
            "freshnessWindow": None,
            "dryRun": bool(args.dry_run),
            "lastSuccessfulSyncAt": None,
            "exitCode": 1,
        }
        previous = self._read_previous_status()
        self.previous_success = previous.get("lastSuccessfulSyncAt") if isinstance(previous, dict) else None

    def _read_previous_status(self) -> Dict[str, Any]:
        try:
            if self.status_file.exists():
                return json.loads(self.status_file.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return {}

    def run_git(self, git_args: Sequence[str], timeout: int = 30, check: bool = True, input_text: Optional[str] = None) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"
        result = subprocess.run(
            [self.git_path, *git_args],
            cwd=str(self.repo),
            input=input_text,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=env,
        )
        if check and result.returncode != 0:
            raise GitError(git_args, result.returncode, result.stdout, result.stderr)
        return result

    def git_out(self, git_args: Sequence[str], timeout: int = 30, check: bool = True) -> str:
        return self.run_git(git_args, timeout=timeout, check=check).stdout.strip()

    def run(self) -> int:
        self.logger.info("start repo=%s branch=%s remote=%s dry_run=%s", self.repo, self.branch, self.remote, self.args.dry_run)
        try:
            with FileLock(self.lock_file):
                code = self._run_locked()
        except LockBusy:
            self._finish("lock_busy", "another sync worker is already running", 0)
            code = 0
        except SyncBlocked as exc:
            self._finish(exc.state, exc.message, exc.exit_code)
            code = exc.exit_code
        except GitError as exc:
            message = mask_url(f"git command failed: {' '.join(exc.args_list)}: {exc.stderr or exc.stdout}".strip())
            self._finish("unexpected_error", message, 1)
            self.logger.error("unexpected git error %s", message)
            code = 1
        except Exception as exc:  # pragma: no cover - retained for production safety
            message = f"unexpected error: {exc.__class__.__name__}: {exc}"
            self._finish("unexpected_error", message, 1)
            self.logger.error("%s\n%s", message, traceback.format_exc())
            code = 1
        self.logger.info("finish state=%s exit=%s old=%s target=%s new=%s", self.status.get("state"), code, self.status.get("oldHead"), self.status.get("targetHead"), self.status.get("newHead"))
        return code

    def _finish(self, state: str, message: str, exit_code: int) -> None:
        now_utc = _dt.datetime.now(UTC)
        now_oslo = now_utc.astimezone(OSLO)
        self.status["checkedAtUtc"] = now_utc.isoformat()
        self.status["checkedAtEuropeOslo"] = now_oslo.isoformat()
        self.status["state"] = state
        self.status["message"] = message
        self.status["exitCode"] = exit_code
        self.status.setdefault("lastSuccessfulSyncAt", self.previous_success)
        if state in {"synced", "up_to_date", "dry_run_up_to_date"}:
            self.status["lastSuccessfulSyncAt"] = now_utc.isoformat()
        atomic_write_json(self.status_file, self.status)

    def _run_locked(self) -> int:
        self._preflight_before_fetch()
        old_head = self.git_out(["rev-parse", "HEAD"])
        self.status["oldHead"] = old_head
        try:
            self.run_git(["fetch", "--prune", self.remote], timeout=self.args.fetch_timeout)
        except (subprocess.TimeoutExpired, GitError) as exc:
            raise SyncBlocked("fetch_failed", f"fetch failed: {mask_url(str(exc))}") from exc

        target = self.git_out(["rev-parse", f"refs/remotes/{self.remote}/{self.branch}"])
        self.status["targetHead"] = target
        ahead, behind = self._ahead_behind(target)
        self.status["ahead"] = ahead
        self.status["behind"] = behind

        if ahead == 0 and behind == 0:
            data = self._validate_tree_data(target, compare_local=False)
            self._record_data(data)
            state = "dry_run_up_to_date" if self.args.dry_run else self._state_for_no_remote_changes(data)
            self._finish(state, "repository already matches validated target", 0)
            return 0

        if ahead > 0:
            raise SyncBlocked("blocked_ahead_or_diverged", f"local branch is ahead/diverged: ahead={ahead} behind={behind}")
        if not self._is_ancestor(old_head, target):
            raise SyncBlocked("blocked_ahead_or_diverged", "HEAD is not an ancestor of target")

        commits = self._remote_only_commits(target)
        self.status["changedCommits"] = commits
        changed_files = sorted({path for item in commits for path in item["paths"]})
        self.status["changedFiles"] = changed_files
        target_data = self._validate_tree_data(target, compare_local=True)
        self._record_data(target_data)

        self._recheck_before_merge(old_head, target)
        if self.args.dry_run:
            self._finish("dry_run_would_sync", f"would fast-forward {behind} data-only commit(s) to {target[:12]}", 0)
            return 0

        try:
            self.run_git(["merge", "--ff-only", target], timeout=self.args.merge_timeout)
        except (subprocess.TimeoutExpired, GitError) as exc:
            raise SyncBlocked("merge_failed", f"fast-forward merge failed: {mask_url(str(exc))}") from exc

        new_head = self.git_out(["rev-parse", "HEAD"])
        self.status["newHead"] = new_head
        if new_head != target:
            raise SyncBlocked("merge_failed", "HEAD did not become validated target after merge")
        if self.git_out(["status", "--porcelain"]):
            raise SyncBlocked("merge_failed", "working tree not clean after merge")
        self._assert_worktree_matches_target(target)
        final_data = self._validate_worktree_data()
        self._record_data(final_data)
        state = "synced"
        message = f"fast-forwarded {behind} data-only commit(s) to {target[:12]}"
        if any(item.get("fresh") is False for item in [self.status.get("api_idag"), self.status.get("api_imorgen")]):
            message += "; latest remote is still not fresh for current Oslo window"
        self._finish(state, message, 0)
        return 0

    def _preflight_before_fetch(self) -> None:
        if not self.repo.exists() or not self.repo.is_dir():
            raise SyncBlocked("blocked_wrong_branch", "repo path does not exist")
        if not (self.repo / ".git").exists():
            raise SyncBlocked("blocked_wrong_branch", "repo .git missing")
        branch_result = self.run_git(["symbolic-ref", "--short", "HEAD"], check=False)
        if branch_result.returncode != 0:
            raise SyncBlocked("blocked_wrong_branch", "detached HEAD or symbolic branch missing")
        branch = branch_result.stdout.strip()
        if branch != self.branch:
            raise SyncBlocked("blocked_wrong_branch", f"wrong branch: {branch}")
        git_dir = Path(self.git_out(["rev-parse", "--git-dir"]))
        if not git_dir.is_absolute():
            git_dir = self.repo / git_dir
        for marker in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]:
            if (git_dir / marker).exists():
                raise SyncBlocked("blocked_dirty", f"git operation in progress: {marker}")
        for marker in ["rebase-merge", "rebase-apply"]:
            if (git_dir / marker).exists():
                raise SyncBlocked("blocked_dirty", f"git operation in progress: {marker}")
        if self.git_out(["status", "--porcelain"]):
            raise SyncBlocked("blocked_dirty", "working tree is not clean")
        remotes = self.git_out(["remote"]).splitlines()
        if self.remote not in remotes:
            raise SyncBlocked("fetch_failed", f"remote {self.remote!r} missing")
        self.git_out(["rev-parse", "HEAD"])

    def _ahead_behind(self, target: str) -> Tuple[int, int]:
        text = self.git_out(["rev-list", "--left-right", "--count", f"HEAD...{target}"])
        left, right = text.split()
        return int(left), int(right)

    def _is_ancestor(self, base: str, target: str) -> bool:
        return self.run_git(["merge-base", "--is-ancestor", base, target], check=False).returncode == 0

    def _remote_only_commits(self, target: str) -> List[Dict[str, Any]]:
        shas = [line for line in self.git_out(["rev-list", "--reverse", f"HEAD..{target}"]).splitlines() if line]
        commits: List[Dict[str, Any]] = []
        for sha in shas:
            parents = self.git_out(["rev-list", "--parents", "-n", "1", sha]).split()
            if len(parents) > 2:
                raise SyncBlocked("blocked_merge_commit", f"remote-only merge commit blocked: {sha}")
            subject = self.git_out(["show", "-s", "--format=%s", sha])
            name_status = self.git_out(["show", "--format=", "--name-status", sha])
            paths: List[str] = []
            for line in name_status.splitlines():
                if not line.strip():
                    continue
                parts = line.split("\t")
                status = parts[0]
                if status.startswith(("R", "C")) or status[:1] not in {"A", "M", "D"} or len(parts) != 2:
                    raise SyncBlocked("blocked_disallowed_scope", f"unsupported path change {status} in {sha}")
                path = parts[1]
                paths.append(path)
                if path not in ALLOWED_DATA_FILE_SET:
                    raise SyncBlocked("blocked_disallowed_scope", f"remote commit {sha[:12]} changed disallowed path {path}")
                if status == "D":
                    raise SyncBlocked("blocked_disallowed_scope", f"remote commit {sha[:12]} deleted required data path {path}")
                raw = self._regular_blob_bytes(sha, path)
                self._parse_json_object(raw, path)
            if not paths:
                raise SyncBlocked("blocked_disallowed_scope", f"remote commit {sha[:12]} has no file changes")
            commits.append({"sha": sha, "subject": subject, "paths": paths})
        return commits

    def _blob_bytes(self, commit: str, path: str) -> bytes:
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"
        result = subprocess.run(
            [self.git_path, "show", f"{commit}:{path}"],
            cwd=str(self.repo),
            capture_output=True,
            timeout=30,
            env=env,
        )
        if result.returncode != 0:
            raise SyncBlocked("blocked_invalid_json", f"required file missing at target: {path}")
        return result.stdout

    def _regular_blob_bytes(self, commit: str, path: str) -> bytes:
        entry = self.git_out(["ls-tree", commit, "--", path], check=False)
        if not entry:
            raise SyncBlocked("blocked_invalid_json", f"required file missing at target: {path}")
        metadata, _, observed_path = entry.partition("\t")
        parts = metadata.split()
        if len(parts) != 3 or observed_path != path:
            raise SyncBlocked("blocked_disallowed_scope", f"invalid tree entry for {path} at {commit[:12]}")
        mode, object_type, _object_id = parts
        if mode != REGULAR_DATA_FILE_MODE or object_type != "blob":
            raise SyncBlocked(
                "blocked_disallowed_scope",
                f"data path {path} at {commit[:12]} is not a regular non-executable file",
            )
        return self._blob_bytes(commit, path)

    def _parse_json_object(self, raw: bytes, label: str) -> Dict[str, Any]:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise SyncBlocked("blocked_invalid_json", f"{label} is not valid UTF-8") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise SyncBlocked("blocked_invalid_json", f"{label} is not valid JSON") from exc
        if not isinstance(data, dict):
            raise SyncBlocked("blocked_invalid_json", f"{label} top-level JSON is not an object")
        return data

    def _validate_json_bytes(self, raw: bytes, label: str, expected_date: str) -> Dict[str, Any]:
        data = self._parse_json_object(raw, label)
        date = data.get("date")
        updated = data.get("updatedAt")
        if not isinstance(date, str) or not DATE_RE.match(date):
            raise SyncBlocked("blocked_invalid_json", f"{label} missing or invalid date")
        try:
            _dt.date.fromisoformat(date)
        except ValueError as exc:
            raise SyncBlocked("blocked_invalid_json", f"{label} invalid date") from exc
        if not isinstance(updated, str):
            raise SyncBlocked("blocked_invalid_json", f"{label} missing updatedAt")
        try:
            parse_updated_at(updated)
        except ValueError as exc:
            raise SyncBlocked("blocked_invalid_json", f"{label} invalid updatedAt") from exc
        return {
            "date": date,
            "updatedAt": updated,
            "sha256": sha256_bytes(raw),
            "expectedDate": expected_date,
            "fresh": date == expected_date,
        }

    def _validate_tree_data(self, target: str, compare_local: bool) -> Dict[str, Dict[str, Any]]:
        expected = expected_dates_for_oslo(self.args.now)
        self.status["freshnessWindow"] = expected["window"]
        result: Dict[str, Dict[str, Any]] = {}
        raw_by_path: Dict[str, bytes] = {}
        for path in ALLOWED_DATA_FILES:
            raw = self._regular_blob_bytes(target, path)
            self._parse_json_object(raw, path)
            raw_by_path[path] = raw
        for path in OPERATIONAL_DATA_FILES:
            label = "api_idag" if path.endswith("api_idag.json") else "api_imorgen"
            raw = raw_by_path[path]
            result[label] = self._validate_json_bytes(raw, label, expected[label])
            if compare_local:
                self._check_monotonic(path, result[label])
        result["provenance"] = {
            "sha256": sha256_bytes(raw_by_path[PROVENANCE_FILE]),
            "validJson": True,
        }
        return result

    def _validate_worktree_data(self) -> Dict[str, Dict[str, Any]]:
        expected = expected_dates_for_oslo(self.args.now)
        result: Dict[str, Dict[str, Any]] = {}
        raw_by_path: Dict[str, bytes] = {}
        for path in ALLOWED_DATA_FILES:
            local_path = self.repo / path
            try:
                local_stat = local_path.lstat()
            except FileNotFoundError as exc:
                raise SyncBlocked("blocked_invalid_json", f"required worktree file missing: {path}") from exc
            if local_path.is_symlink() or not local_path.is_file() or local_stat.st_mode & 0o111:
                raise SyncBlocked("blocked_disallowed_scope", f"worktree data path is not a regular non-executable file: {path}")
            raw = local_path.read_bytes()
            self._parse_json_object(raw, path)
            raw_by_path[path] = raw
        for path in OPERATIONAL_DATA_FILES:
            label = "api_idag" if path.endswith("api_idag.json") else "api_imorgen"
            raw = raw_by_path[path]
            result[label] = self._validate_json_bytes(raw, label, expected[label])
        result["provenance"] = {
            "sha256": sha256_bytes(raw_by_path[PROVENANCE_FILE]),
            "validJson": True,
        }
        return result

    def _check_monotonic(self, path: str, target_item: Dict[str, Any]) -> None:
        label = "api_idag" if path.endswith("api_idag.json") else "api_imorgen"
        local_path = self.repo / path
        if not local_path.exists():
            return
        local_item = self._validate_json_bytes(local_path.read_bytes(), f"local {label}", target_item["expectedDate"])
        target_date = _dt.date.fromisoformat(target_item["date"])
        local_date = _dt.date.fromisoformat(local_item["date"])
        if target_date < local_date:
            raise SyncBlocked("blocked_regression", f"{label} target date is older than local date")
        if target_date == local_date:
            target_updated = parse_updated_at(target_item["updatedAt"])
            local_updated = parse_updated_at(local_item["updatedAt"])
            if target_updated < local_updated:
                raise SyncBlocked("blocked_regression", f"{label} target updatedAt is older than local updatedAt")

    def _record_data(self, data: Dict[str, Dict[str, Any]]) -> None:
        self.status["api_idag"] = data.get("api_idag")
        self.status["api_imorgen"] = data.get("api_imorgen")
        self.status["provenance"] = data.get("provenance")

    def _state_for_no_remote_changes(self, data: Dict[str, Dict[str, Any]]) -> str:
        if any(item.get("fresh") is False for item in data.values()):
            return "waiting_for_fresh_remote"
        return "up_to_date"

    def _recheck_before_merge(self, old_head: str, target: str) -> None:
        self._preflight_before_fetch()
        current = self.git_out(["rev-parse", "HEAD"])
        if current != old_head:
            raise SyncBlocked("blocked_dirty", "HEAD changed before merge")
        target_check = self.git_out(["rev-parse", target])
        if target_check != target:
            raise SyncBlocked("merge_failed", "validated target changed before merge")

    def _assert_worktree_matches_target(self, target: str) -> None:
        for path in ALLOWED_DATA_FILES:
            target_raw = self._regular_blob_bytes(target, path)
            worktree_raw = (self.repo / path).read_bytes()
            if target_raw != worktree_raw:
                raise SyncBlocked("merge_failed", f"worktree file does not match target blob: {path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Fail-closed production Balise data-only sync")
    parser.add_argument("--repo", default="/Users/solglottsr/balise_logistikk_kopi")
    parser.add_argument("--remote", default="origin")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--status-file", default="~/Library/Application Support/SDE/balise-data-sync-status.json")
    parser.add_argument("--log-file", default="~/Library/Logs/SDE/balise-data-sync.log")
    parser.add_argument("--lock-file", default="~/Library/Application Support/SDE/balise-data-sync.lock")
    parser.add_argument("--git-path", default="/usr/bin/git")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--now", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--fetch-timeout", type=int, default=45, help=argparse.SUPPRESS)
    parser.add_argument("--merge-timeout", type=int, default=30, help=argparse.SUPPRESS)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    worker = SyncWorker(args)
    return worker.run()


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build a fail-closed, allowlisted schedule-observability record.

The record is diagnostic only.  It never changes the update decision, invokes
the generator, writes repository data, or infers a schedule slot outside the
explicit association interval.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import stat
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


SCHEMA_VERSION = "sde-schedule-observability/v1"
OSLO_TIMEZONE = "Europe/Oslo"
WORKFLOW_FILE = ".github/workflows/update-static-data.yml"
CONTROL_EXPRESSION = "17 * * * *"
CRITICAL_EXPRESSIONS = {
    "7 4,7,15,21 * * *": 7,
    "22 4,7,15,21 * * *": 22,
    "37 4,7,15,21 * * *": 37,
    "52 4,7,15,21 * * *": 52,
}
ASSOCIATION_WINDOW = timedelta(hours=1)

RECORD_FIELDS = (
    "schemaVersion",
    "generatedAt",
    "repository",
    "workflowName",
    "workflowFile",
    "workflowRef",
    "eventName",
    "eventScheduleExpression",
    "runId",
    "runNumber",
    "runAttempt",
    "headSha",
    "ref",
    "actor",
    "triggeringActor",
    "timezone",
    "triggerClass",
    "triggerMinute",
    "triggerSlotStatus",
    "expectedSlotLocal",
    "expectedSlotUTC",
    "runRecordCreatedAt",
    "runStartedAt",
    "firstJobStartedAt",
    "workflowObservedAt",
    "gateStartedAt",
    "gateCompletedAt",
    "intendedCycle",
    "shouldRun",
    "gateReason",
    "generatorSelected",
    "scheduleCreationDelaySeconds",
    "workflowQueueSeconds",
    "firstJobQueueSeconds",
    "metadataStatus",
    "metadataWarnings",
    "naturalScheduleCandidate",
    "rerun",
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def parse_positive_int(value: Any) -> int | None:
    """Parse only a positive integer or a pure base-10 ASCII string."""

    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 1 else None
    if isinstance(value, str) and re.fullmatch(r"[0-9]+", value):
        parsed = int(value, 10)
        return parsed if parsed >= 1 else None
    return None


def parse_nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    return None


def run_identity_warning(field: str, raw_value: Any) -> str:
    return f"{field}_missing" if raw_value is None else f"{field}_invalid"


def parse_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return None


def classify_trigger(event_name: str | None, expression: str | None) -> dict[str, Any]:
    if event_name == "workflow_dispatch":
        return {
            "triggerClass": "MANUAL",
            "triggerMinute": None,
            "triggerSlotStatus": "NOT_APPLICABLE",
            "hours": None,
            "warnings": [],
        }
    if event_name != "schedule":
        return {
            "triggerClass": "OTHER",
            "triggerMinute": None,
            "triggerSlotStatus": "NOT_APPLICABLE",
            "hours": None,
            "warnings": [],
        }
    if expression == CONTROL_EXPRESSION:
        return {
            "triggerClass": "CONTROL",
            "triggerMinute": 17,
            "triggerSlotStatus": None,
            "hours": set(range(24)),
            "warnings": [],
        }
    if expression in CRITICAL_EXPRESSIONS:
        return {
            "triggerClass": "CRITICAL",
            "triggerMinute": CRITICAL_EXPRESSIONS[expression],
            "triggerSlotStatus": None,
            "hours": {4, 7, 15, 21},
            "warnings": [],
        }
    warning = "missing_schedule_expression" if not expression else "unknown_schedule_expression"
    return {
        "triggerClass": "OTHER",
        "triggerMinute": None,
        "triggerSlotStatus": "BLOCKED",
        "hours": None,
        "warnings": [warning],
    }


def resolve_expected_slot(
    created_at: datetime | None,
    trigger_minute: int | None,
    hours: set[int] | None,
    association_window: timedelta = ASSOCIATION_WINDOW,
) -> dict[str, Any]:
    """Resolve only when exactly one cron match exists in the closed interval.

    The interval is ``[created_at - association_window, created_at]``.  There is
    deliberately no nearest-slot fallback.  Iteration happens in UTC so the
    repeated Europe/Oslo hour at the DST boundary produces two candidates and
    therefore AMBIGUOUS rather than a guessed slot.
    """

    if created_at is None:
        return {
            "status": "BLOCKED",
            "local": None,
            "utc": None,
            "delay": None,
            "warnings": ["run_record_created_at_missing"],
        }
    if trigger_minute is None or not hours:
        return {
            "status": "BLOCKED",
            "local": None,
            "utc": None,
            "delay": None,
            "warnings": ["schedule_expression_not_resolvable"],
        }

    created = created_at.astimezone(timezone.utc)
    lower = created - association_window
    cursor = lower.replace(second=0, microsecond=0)
    if cursor < lower:
        cursor += timedelta(minutes=1)
    oslo = ZoneInfo(OSLO_TIMEZONE)
    matches: list[datetime] = []
    while cursor <= created:
        local = cursor.astimezone(oslo)
        if local.minute == trigger_minute and local.hour in hours:
            matches.append(cursor)
        cursor += timedelta(minutes=1)

    if len(matches) > 1:
        return {
            "status": "AMBIGUOUS",
            "local": None,
            "utc": None,
            "delay": None,
            "warnings": ["multiple_schedule_slots_in_association_interval"],
        }
    if not matches:
        return {
            "status": "BLOCKED",
            "local": None,
            "utc": None,
            "delay": None,
            "warnings": ["no_schedule_slot_in_association_interval"],
        }

    slot = matches[0]
    delay = (created - slot).total_seconds()
    if delay < 0:
        return {
            "status": "BLOCKED",
            "local": None,
            "utc": None,
            "delay": None,
            "warnings": ["negative_schedule_creation_delay"],
        }
    return {
        "status": "CONFIRMED_BY_SCHEDULE_EXPRESSION",
        "local": slot.astimezone(oslo).isoformat(),
        "utc": iso_utc(slot),
        "delay": delay,
        "warnings": [],
    }


def safe_duration(
    start: datetime | None,
    end: datetime | None,
    warning: str,
    warnings: list[str],
) -> float | None:
    if start is None or end is None:
        return None
    duration = (end - start).total_seconds()
    if duration < 0:
        warnings.append(warning)
        return None
    return duration


def github_get_json(url: str, token: str, timeout: int = 20) -> Any:
    request = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "sde-schedule-observability/v1",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _open_secure_parent(output: Path) -> tuple[int, str]:
    """Open an output parent without following any path-component symlink."""

    required = ("O_NOFOLLOW", "O_DIRECTORY")
    if os.name != "posix" or any(not hasattr(os, name) for name in required):
        raise RuntimeError("secure_nofollow_output_unavailable")

    absolute = Path(os.path.abspath(os.fspath(output)))
    filename = absolute.name
    if filename in ("", ".", ".."):
        raise RuntimeError("output_filename_invalid")

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        directory_flags |= os.O_CLOEXEC
    directory_fd = os.open("/", directory_flags)
    try:
        for component in absolute.parent.parts[1:]:
            try:
                next_fd = os.open(component, directory_flags, dir_fd=directory_fd)
            except FileNotFoundError:
                os.mkdir(component, mode=0o700, dir_fd=directory_fd)
                next_fd = os.open(component, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        return directory_fd, filename
    except Exception:
        os.close(directory_fd)
        raise


def _reject_non_regular_output(directory_fd: int, filename: str) -> None:
    try:
        existing = os.stat(filename, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if stat.S_ISLNK(existing.st_mode):
        raise RuntimeError("output_symlink_rejected")
    if not stat.S_ISREG(existing.st_mode):
        raise RuntimeError("output_not_regular_file")


def _canonicalize_macos_var_alias(path: Path) -> Path:
    """Accept only macOS' fixed /var -> /private/var system alias.

    Every other parent component remains subject to no-follow traversal.  The
    output basename is deliberately not resolved, so output symlinks are still
    rejected by ``_reject_non_regular_output``.
    """

    if sys.platform != "darwin" or len(path.parts) < 2 or path.parts[1] != "var":
        return path

    var_stat = os.lstat("/var")
    if not stat.S_ISLNK(var_stat.st_mode):
        return path
    if os.readlink("/var") not in {"private/var", "/private/var"}:
        raise RuntimeError("unexpected_macos_var_alias")

    for trusted_directory in ("/private", "/private/var"):
        trusted_stat = os.lstat(trusted_directory)
        if stat.S_ISLNK(trusted_stat.st_mode) or not stat.S_ISDIR(trusted_stat.st_mode):
            raise RuntimeError("invalid_macos_var_target")
    return Path("/private/var", *path.parts[2:])


def atomic_write_record(output: Path, record: dict[str, Any]) -> None:
    """Write JSON atomically in a no-follow directory, or fail closed."""

    absolute_output = Path(os.path.abspath(os.fspath(output)))
    directory_fd, filename = _open_secure_parent(_canonicalize_macos_var_alias(absolute_output))
    temporary_name = f".{filename}.tmp-{os.getpid()}-{secrets.token_hex(8)}"
    temporary_fd: int | None = None
    temporary_exists = False
    try:
        _reject_non_regular_output(directory_fd, filename)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        if hasattr(os, "O_CLOEXEC"):
            flags |= os.O_CLOEXEC
        temporary_fd = os.open(temporary_name, flags, 0o600, dir_fd=directory_fd)
        temporary_exists = True
        payload = (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("utf-8")
        remaining = memoryview(payload)
        while remaining:
            written = os.write(temporary_fd, remaining)
            if written <= 0:
                raise OSError("atomic_output_write_failed")
            remaining = remaining[written:]
        os.fsync(temporary_fd)
        os.close(temporary_fd)
        temporary_fd = None

        # Recheck immediately before replace. A concurrent symlink swap can
        # never reach its target because replace operates on the directory
        # entry through the already-open no-follow parent descriptor.
        _reject_non_regular_output(directory_fd, filename)
        os.replace(
            temporary_name,
            filename,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        temporary_exists = False
        os.fsync(directory_fd)
    finally:
        if temporary_fd is not None:
            os.close(temporary_fd)
        if temporary_exists:
            try:
                os.unlink(temporary_name, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        os.close(directory_fd)


def fetch_run_metadata(repository: str | None, run_id: str | None, token: str | None) -> dict[str, Any]:
    if not token:
        return {"available": False, "warning": "github_actions_read_token_unavailable"}
    if not repository or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        return {"available": False, "warning": "repository_identity_invalid"}
    if not run_id or not str(run_id).isdigit():
        return {"available": False, "warning": "run_id_invalid"}

    base = f"https://api.github.com/repos/{repository}/actions/runs/{run_id}"
    try:
        run = github_get_json(base, token)
        jobs = github_get_json(f"{base}/jobs?per_page=100", token)
    except urllib.error.HTTPError as error:
        return {"available": False, "warning": f"github_actions_read_http_{error.code}"}
    except (urllib.error.URLError, TimeoutError):
        return {"available": False, "warning": "github_actions_read_transport_failure"}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {"available": False, "warning": "github_actions_read_invalid_json"}

    if not isinstance(run, dict) or not isinstance(jobs, dict):
        return {"available": False, "warning": "github_actions_read_shape_invalid"}
    total_count = parse_nonnegative_int(jobs.get("total_count"))
    job_list = jobs.get("jobs")
    if total_count is None:
        return {"available": False, "warning": "jobs_total_count_invalid"}
    if not isinstance(job_list, list):
        return {"available": False, "warning": "jobs_list_invalid"}
    if total_count != len(job_list):
        return {"available": False, "warning": "jobs_response_incomplete"}

    job_ids: set[int] = set()
    started_values: list[datetime] = []
    for job in job_list:
        if not isinstance(job, dict):
            return {"available": False, "warning": "jobs_list_invalid"}
        job_id = parse_positive_int(job.get("id"))
        if job_id is None:
            return {"available": False, "warning": "job_id_invalid"}
        if job_id in job_ids:
            return {"available": False, "warning": "duplicate_job_id"}
        job_ids.add(job_id)
        started_at = parse_timestamp(job.get("started_at"))
        if started_at is None:
            return {"available": False, "warning": "job_started_at_missing_or_invalid"}
        started_values.append(started_at)

    first_job_started = min(started_values, default=None)
    return {
        "available": True,
        "createdAt": run.get("created_at"),
        "runStartedAt": run.get("run_started_at"),
        "firstJobStartedAt": iso_utc(first_job_started),
        "eventName": run.get("event"),
        "headSha": run.get("head_sha"),
        "runAttempt": run.get("run_attempt"),
    }


def build_record(
    context: dict[str, Any],
    api_metadata: dict[str, Any] | None = None,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    event_name = context.get("eventName") or None
    expression = context.get("eventScheduleExpression") or None
    run_number_raw = context.get("runNumber")
    run_attempt_raw = context.get("runAttempt")
    run_number = parse_positive_int(run_number_raw)
    run_attempt = parse_positive_int(run_attempt_raw)
    trigger = classify_trigger(event_name, expression)
    warnings = list(trigger["warnings"])
    if run_number is None:
        warnings.append(run_identity_warning("run_number", run_number_raw))
    if run_attempt is None:
        warnings.append(run_identity_warning("run_attempt", run_attempt_raw))

    api = api_metadata or {"available": False, "warning": "github_actions_metadata_not_provided"}
    if not api.get("available"):
        warnings.append(str(api.get("warning") or "github_actions_metadata_unavailable"))

    created_at = parse_timestamp(api.get("createdAt")) if api.get("available") else None
    run_started_at = parse_timestamp(api.get("runStartedAt")) if api.get("available") else None
    first_job_started_at = parse_timestamp(api.get("firstJobStartedAt")) if api.get("available") else None
    workflow_observed_at = parse_timestamp(context.get("workflowObservedAt"))
    gate_started_at = parse_timestamp(context.get("gateStartedAt"))
    gate_completed_at = parse_timestamp(context.get("gateCompletedAt"))

    expected = {
        "status": trigger["triggerSlotStatus"],
        "local": None,
        "utc": None,
        "delay": None,
        "warnings": [],
    }
    if event_name == "schedule" and trigger["triggerSlotStatus"] is None:
        expected = resolve_expected_slot(created_at, trigger["triggerMinute"], trigger["hours"])
    warnings.extend(expected["warnings"])

    if api.get("available"):
        api_event = api.get("eventName")
        api_sha = api.get("headSha")
        api_attempt_raw = api.get("runAttempt")
        api_attempt = parse_positive_int(api_attempt_raw)
        if api_event and event_name and api_event != event_name:
            warnings.append("run_api_event_mismatch")
        if api_sha and context.get("headSha") and api_sha != context.get("headSha"):
            warnings.append("run_api_head_sha_mismatch")
        if api_attempt is None:
            warnings.append(run_identity_warning("run_api_attempt", api_attempt_raw))
        elif run_attempt is not None and api_attempt != run_attempt:
            warnings.append("run_api_attempt_mismatch")

    workflow_queue = safe_duration(
        created_at,
        run_started_at,
        "negative_workflow_queue_duration",
        warnings,
    )
    first_job_queue = safe_duration(
        run_started_at,
        first_job_started_at,
        "negative_first_job_queue_duration",
        warnings,
    )
    safe_duration(
        gate_started_at,
        gate_completed_at,
        "negative_gate_duration",
        warnings,
    )

    intended_date = context.get("intendedCycleDate") or None
    intended_hour = context.get("intendedCycleHour") or None
    intended_cycle = None
    if intended_date and intended_hour:
        intended_cycle = f"{intended_date}T{str(intended_hour).zfill(2)}:00:00[{OSLO_TIMEZONE}]"
    elif intended_date or intended_hour:
        warnings.append("partial_intended_cycle")

    should_run = parse_bool(context.get("shouldRun"))
    generator_selected = should_run
    if context.get("shouldRun") not in (None, "") and should_run is None:
        warnings.append("invalid_should_run_value")

    blocking_warnings = {
        "missing_schedule_expression",
        "unknown_schedule_expression",
        "run_record_created_at_missing",
        "schedule_expression_not_resolvable",
        "multiple_schedule_slots_in_association_interval",
        "no_schedule_slot_in_association_interval",
        "negative_schedule_creation_delay",
        "github_actions_read_token_unavailable",
        "repository_identity_invalid",
        "run_id_invalid",
        "github_actions_read_transport_failure",
        "github_actions_read_invalid_json",
        "github_actions_metadata_not_provided",
        "run_api_event_mismatch",
        "run_api_head_sha_mismatch",
        "run_api_attempt_mismatch",
        "negative_workflow_queue_duration",
        "negative_first_job_queue_duration",
        "negative_gate_duration",
        "run_number_missing",
        "run_number_invalid",
        "run_attempt_missing",
        "run_attempt_invalid",
        "run_api_attempt_missing",
        "run_api_attempt_invalid",
        "github_actions_read_shape_invalid",
        "jobs_total_count_invalid",
        "jobs_list_invalid",
        "jobs_response_incomplete",
        "job_id_invalid",
        "duplicate_job_id",
        "job_started_at_missing_or_invalid",
    }
    if any(item.startswith("github_actions_read_http_") for item in warnings):
        blocking_warnings.add(next(item for item in warnings if item.startswith("github_actions_read_http_")))

    if any(item in blocking_warnings for item in warnings):
        metadata_status = "BLOCKED"
    else:
        incomplete = [
            created_at,
            run_started_at,
            first_job_started_at,
            workflow_observed_at,
            gate_started_at,
            gate_completed_at,
            intended_cycle,
            should_run,
        ]
        metadata_status = "PARTIAL" if any(value is None for value in incomplete) else "GREEN"
        if metadata_status == "PARTIAL":
            warnings.append("optional_runtime_metadata_incomplete")

    rerun = None if run_attempt is None else run_attempt > 1
    natural_schedule_candidate = (
        event_name == "schedule"
        and run_attempt == 1
        and metadata_status == "GREEN"
    )
    record = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso_utc(generated_at or utc_now()),
        "repository": context.get("repository") or None,
        "workflowName": context.get("workflowName") or None,
        "workflowFile": WORKFLOW_FILE,
        "workflowRef": context.get("workflowRef") or None,
        "eventName": event_name,
        "eventScheduleExpression": expression,
        "runId": str(context.get("runId")) if context.get("runId") not in (None, "") else None,
        "runNumber": run_number,
        "runAttempt": run_attempt,
        "headSha": context.get("headSha") or None,
        "ref": context.get("ref") or None,
        "actor": context.get("actor") or None,
        "triggeringActor": context.get("triggeringActor") or None,
        "timezone": OSLO_TIMEZONE,
        "triggerClass": trigger["triggerClass"],
        "triggerMinute": trigger["triggerMinute"],
        "triggerSlotStatus": expected["status"],
        "expectedSlotLocal": expected["local"],
        "expectedSlotUTC": expected["utc"],
        "runRecordCreatedAt": iso_utc(created_at),
        "runStartedAt": iso_utc(run_started_at),
        "firstJobStartedAt": iso_utc(first_job_started_at),
        "workflowObservedAt": iso_utc(workflow_observed_at),
        "gateStartedAt": iso_utc(gate_started_at),
        "gateCompletedAt": iso_utc(gate_completed_at),
        "intendedCycle": intended_cycle,
        "shouldRun": should_run,
        "gateReason": context.get("gateReason") or None,
        "generatorSelected": generator_selected,
        "scheduleCreationDelaySeconds": expected["delay"],
        "workflowQueueSeconds": workflow_queue,
        "firstJobQueueSeconds": first_job_queue,
        "metadataStatus": metadata_status,
        "metadataWarnings": sorted(set(warnings)),
        "naturalScheduleCandidate": natural_schedule_candidate,
        "rerun": rerun,
    }
    return {field: record[field] for field in RECORD_FIELDS}


def context_from_environment(environment: dict[str, str] | None = None) -> dict[str, Any]:
    env = environment or os.environ
    return {
        "repository": env.get("SDE_REPOSITORY"),
        "workflowName": env.get("SDE_WORKFLOW_NAME"),
        "workflowRef": env.get("SDE_WORKFLOW_REF"),
        "eventName": env.get("SDE_EVENT_NAME"),
        "eventScheduleExpression": env.get("SDE_EVENT_SCHEDULE_EXPRESSION"),
        "runId": env.get("SDE_RUN_ID"),
        "runNumber": env.get("SDE_RUN_NUMBER"),
        "runAttempt": env.get("SDE_RUN_ATTEMPT"),
        "headSha": env.get("SDE_HEAD_SHA"),
        "ref": env.get("SDE_REF"),
        "actor": env.get("SDE_ACTOR"),
        "triggeringActor": env.get("SDE_TRIGGERING_ACTOR"),
        "workflowObservedAt": env.get("SDE_WORKFLOW_OBSERVED_AT"),
        "gateStartedAt": env.get("SDE_GATE_STARTED_AT"),
        "gateCompletedAt": env.get("SDE_GATE_COMPLETED_AT"),
        "intendedCycleDate": env.get("SDE_INTENDED_CYCLE_DATE"),
        "intendedCycleHour": env.get("SDE_INTENDED_CYCLE_HOUR"),
        "shouldRun": env.get("SDE_SHOULD_RUN"),
        "gateReason": env.get("SDE_GATE_REASON"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()

    context = context_from_environment()
    api = fetch_run_metadata(
        context.get("repository"),
        context.get("runId"),
        os.environ.get("GITHUB_TOKEN"),
    )
    record = build_record(context, api)
    output = Path(arguments.output)
    atomic_write_record(output, record)
    print(
        f"Schedule observability: {record['metadataStatus']} "
        f"{record['triggerClass']} {record['triggerSlotStatus']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

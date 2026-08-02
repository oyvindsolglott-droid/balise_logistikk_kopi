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


def parse_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


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

    started_values = [
        parse_timestamp(job.get("started_at"))
        for job in (jobs.get("jobs") or [])
        if isinstance(job, dict)
    ]
    first_job_started = min((value for value in started_values if value), default=None)
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
    run_attempt = parse_int(context.get("runAttempt"))
    trigger = classify_trigger(event_name, expression)
    warnings = list(trigger["warnings"])

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
        api_attempt = parse_int(api.get("runAttempt"))
        if api_event and event_name and api_event != event_name:
            warnings.append("run_api_event_mismatch")
        if api_sha and context.get("headSha") and api_sha != context.get("headSha"):
            warnings.append("run_api_head_sha_mismatch")
        if api_attempt is not None and run_attempt is not None and api_attempt != run_attempt:
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

    rerun = bool(run_attempt and run_attempt > 1)
    natural_schedule_candidate = event_name == "schedule" and run_attempt == 1
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
        "runNumber": parse_int(context.get("runNumber")),
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
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"Schedule observability: {record['metadataStatus']} "
        f"{record['triggerClass']} {record['triggerSlotStatus']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

import sde_schedule_observability as observability


ROOT = Path(__file__).resolve().parent
WORKFLOW = ROOT / ".github" / "workflows" / "update-static-data.yml"
SCHEMA = (
    ROOT
    / "tests"
    / "sde-quality-engine"
    / "contracts"
    / "sde-schedule-observability-v1.schema.json"
)


def full_context(**overrides):
    context = {
        "repository": "oyvindsolglott-droid/balise_logistikk_kopi",
        "workflowName": "Update static balise data",
        "workflowRef": "owner/repo/.github/workflows/update-static-data.yml@refs/heads/main",
        "eventName": "schedule",
        "eventScheduleExpression": "22 4,7,15,21 * * *",
        "runId": "123456",
        "runNumber": "81",
        "runAttempt": "1",
        "headSha": "a" * 40,
        "ref": "refs/heads/main",
        "actor": "github-actions[bot]",
        "triggeringActor": "github-actions[bot]",
        "workflowObservedAt": "2026-08-02T19:22:18Z",
        "gateStartedAt": "2026-08-02T19:22:30Z",
        "gateCompletedAt": "2026-08-02T19:22:31Z",
        "intendedCycleDate": "2026-08-02",
        "intendedCycleHour": "21",
        "shouldRun": "false",
        "gateReason": "up_to_date",
    }
    context.update(overrides)
    return context


def full_api(**overrides):
    metadata = {
        "available": True,
        "createdAt": "2026-08-02T19:22:10Z",
        "runStartedAt": "2026-08-02T19:22:20Z",
        "firstJobStartedAt": "2026-08-02T19:22:25Z",
        "eventName": "schedule",
        "headSha": "a" * 40,
        "runAttempt": 1,
    }
    metadata.update(overrides)
    return metadata


def critical_wall_slots(year, minutes):
    oslo = ZoneInfo("Europe/Oslo")
    current = date(year, 1, 1)
    end = date(year + 1, 1, 1)
    slots = set()
    while current < end:
        for hour in (4, 7, 15, 21):
            for minute in minutes:
                slots.add(datetime(current.year, current.month, current.day, hour, minute, tzinfo=oslo))
        current += timedelta(days=1)
    return slots


class ScheduleEquivalenceTest(unittest.TestCase):
    def test_split_critical_schedule_is_equivalent_for_full_leap_year(self):
        old = critical_wall_slots(2024, (7, 22, 37, 52))
        new = set().union(*(critical_wall_slots(2024, (minute,)) for minute in (7, 22, 37, 52)))
        self.assertEqual(old, new)
        self.assertEqual(len(old), 366 * 4 * 4)
        self.assertEqual(len({slot.astimezone(timezone.utc) for slot in new}), len(new))
        self.assertIn(datetime(2024, 1, 1, 4, 7, tzinfo=ZoneInfo("Europe/Oslo")), new)
        self.assertIn(datetime(2024, 12, 31, 21, 52, tzinfo=ZoneInfo("Europe/Oslo")), new)
        offsets = {slot.utcoffset() for slot in new}
        self.assertEqual(offsets, {timedelta(hours=1), timedelta(hours=2)})

    def test_workflow_contains_exact_split_without_duplicate_or_old_group(self):
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn('cron: "7,22,37,52 4,7,15,21 * * *"', source)
        for minute in (7, 22, 37, 52):
            self.assertEqual(source.count(f'cron: "{minute} 4,7,15,21 * * *"'), 1)
        self.assertEqual(source.count('cron: "17 * * * *"'), 1)
        self.assertEqual(source.count('timezone: "Europe/Oslo"'), 5)


class TriggerIdentityTest(unittest.TestCase):
    def test_each_critical_minute_is_primary_expression_proof(self):
        oslo = ZoneInfo("Europe/Oslo")
        for minute in (7, 22, 37, 52):
            with self.subTest(minute=minute):
                created = datetime(2026, 8, 2, 21, minute, 10, tzinfo=oslo).astimezone(timezone.utc)
                context = full_context(eventScheduleExpression=f"{minute} 4,7,15,21 * * *")
                api = full_api(
                    createdAt=observability.iso_utc(created),
                    runStartedAt=observability.iso_utc(created + timedelta(seconds=5)),
                    firstJobStartedAt=observability.iso_utc(created + timedelta(seconds=9)),
                )
                record = observability.build_record(context, api)
                self.assertEqual(record["triggerClass"], "CRITICAL")
                self.assertEqual(record["triggerMinute"], minute)
                self.assertEqual(record["triggerSlotStatus"], "CONFIRMED_BY_SCHEDULE_EXPRESSION")
                self.assertEqual(record["scheduleCreationDelaySeconds"], 10)

    def test_hourly_control_is_resolved_without_changing_its_expression(self):
        record = observability.build_record(
            full_context(eventScheduleExpression="17 * * * *"),
            full_api(createdAt="2026-08-02T19:17:12Z"),
        )
        self.assertEqual(record["triggerClass"], "CONTROL")
        self.assertEqual(record["triggerMinute"], 17)
        self.assertEqual(record["expectedSlotUTC"], "2026-08-02T19:17:00Z")

    def test_repeated_oslo_dst_hour_is_ambiguous_not_nearest(self):
        result = observability.resolve_expected_slot(
            datetime(2024, 10, 27, 1, 17, tzinfo=timezone.utc),
            17,
            set(range(24)),
        )
        self.assertEqual(result["status"], "AMBIGUOUS")
        self.assertIsNone(result["utc"])
        self.assertIn("multiple_schedule_slots_in_association_interval", result["warnings"])

    def test_missing_and_unknown_schedule_expressions_fail_closed(self):
        for expression, warning in ((None, "missing_schedule_expression"), ("8 * * * *", "unknown_schedule_expression")):
            with self.subTest(expression=expression):
                record = observability.build_record(
                    full_context(eventScheduleExpression=expression),
                    full_api(),
                )
                self.assertEqual(record["triggerSlotStatus"], "BLOCKED")
                self.assertEqual(record["metadataStatus"], "BLOCKED")
                self.assertIn(warning, record["metadataWarnings"])


class TimingAndFailureTest(unittest.TestCase):
    def test_green_record_separates_all_time_domains(self):
        record = observability.build_record(full_context(), full_api())
        self.assertEqual(record["metadataStatus"], "GREEN")
        self.assertEqual(record["runRecordCreatedAt"], "2026-08-02T19:22:10Z")
        self.assertEqual(record["runStartedAt"], "2026-08-02T19:22:20Z")
        self.assertEqual(record["firstJobStartedAt"], "2026-08-02T19:22:25Z")
        self.assertEqual(record["workflowQueueSeconds"], 10)
        self.assertEqual(record["firstJobQueueSeconds"], 5)
        self.assertNotIn("eventDeliveredAt", record)

    def test_negative_timing_is_blocked_and_never_serialized_as_latency(self):
        record = observability.build_record(
            full_context(),
            full_api(runStartedAt="2026-08-02T19:22:00Z"),
        )
        self.assertEqual(record["metadataStatus"], "BLOCKED")
        self.assertIsNone(record["workflowQueueSeconds"])
        self.assertIn("negative_workflow_queue_duration", record["metadataWarnings"])

    def test_unavailable_actions_read_api_is_useful_blocked_not_exception(self):
        record = observability.build_record(
            full_context(),
            {"available": False, "warning": "github_actions_read_token_unavailable"},
        )
        self.assertEqual(record["metadataStatus"], "BLOCKED")
        self.assertEqual(record["triggerMinute"], 22)
        self.assertIn("github_actions_read_token_unavailable", record["metadataWarnings"])

    def test_skip_records_generator_not_selected_without_repository_data_write(self):
        paths = [ROOT / "data" / "api_idag.json", ROOT / "data" / "api_imorgen.json"]
        before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
        record = observability.build_record(full_context(shouldRun="false"), full_api())
        after = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
        self.assertEqual(before, after)
        self.assertFalse(record["shouldRun"])
        self.assertFalse(record["generatorSelected"])
        self.assertEqual(record["metadataStatus"], "GREEN")


class ManualRerunAndSecurityTest(unittest.TestCase):
    def test_manual_dispatch_is_not_a_natural_schedule_candidate(self):
        record = observability.build_record(
            full_context(eventName="workflow_dispatch", eventScheduleExpression=None),
            full_api(eventName="workflow_dispatch"),
        )
        self.assertEqual(record["triggerClass"], "MANUAL")
        self.assertEqual(record["triggerSlotStatus"], "NOT_APPLICABLE")
        self.assertFalse(record["naturalScheduleCandidate"])
        self.assertFalse(record["rerun"])

    def test_rerun_is_never_a_natural_schedule_candidate(self):
        record = observability.build_record(
            full_context(runAttempt="2"),
            full_api(runAttempt=2),
        )
        self.assertTrue(record["rerun"])
        self.assertFalse(record["naturalScheduleCandidate"])

    def test_record_is_an_exact_allowlist_and_excludes_injected_secrets(self):
        context = full_context(
            token="TOP-SECRET",
            authorization="Bearer TOP-SECRET",
            cookies="session=TOP-SECRET",
            rawEventPayload={"secret": "TOP-SECRET"},
        )
        record = observability.build_record(context, full_api())
        serialized = json.dumps(record, sort_keys=True)
        self.assertEqual(tuple(record), observability.RECORD_FIELDS)
        self.assertNotIn("TOP-SECRET", serialized)
        for forbidden in ("token", "authorization", "cookies", "rawEventPayload"):
            self.assertNotIn(forbidden, record)

    def test_schema_and_runtime_allowlists_are_identical(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), set(observability.RECORD_FIELDS))
        self.assertEqual(set(schema["properties"]), set(observability.RECORD_FIELDS))

    def test_run_identity_accepts_only_positive_integer_or_pure_decimal_string(self):
        for accepted in (1, 2, "1", "2", "01"):
            with self.subTest(accepted=accepted):
                self.assertIsNotNone(observability.parse_positive_int(accepted))
        for rejected in (None, 0, -1, True, False, 1.5, "", " ", " 1", "1 ", "+1", "1.0", "abc"):
            with self.subTest(rejected=rejected):
                self.assertIsNone(observability.parse_positive_int(rejected))

    def test_invalid_or_missing_run_number_is_blocked(self):
        for value in (None, 0, -1, True, 1.5, "", " ", "abc"):
            with self.subTest(value=value):
                record = observability.build_record(full_context(runNumber=value), full_api())
                self.assertIsNone(record["runNumber"])
                self.assertEqual(record["metadataStatus"], "BLOCKED")
                self.assertFalse(record["naturalScheduleCandidate"])

    def test_invalid_or_missing_attempt_is_blocked_and_not_classified_as_non_rerun(self):
        for value in (None, 0, -1, True, 1.5, "", " ", "abc"):
            with self.subTest(value=value):
                record = observability.build_record(full_context(runAttempt=value), full_api())
                self.assertIsNone(record["runAttempt"])
                self.assertIsNone(record["rerun"])
                self.assertEqual(record["metadataStatus"], "BLOCKED")
                self.assertFalse(record["naturalScheduleCandidate"])

    def test_schema_requires_positive_run_identity_and_nullable_rerun(self):
        schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["runNumber"]["minimum"], 1)
        self.assertEqual(schema["properties"]["runAttempt"]["minimum"], 1)
        self.assertEqual(schema["properties"]["rerun"]["type"], ["boolean", "null"])


class AtomicOutputSecurityTest(unittest.TestCase):
    def test_new_file_and_regular_file_replacement_are_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "record.json"
            observability.atomic_write_record(output, {"status": "first"})
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {"status": "first"})
            observability.atomic_write_record(output, {"status": "second"})
            self.assertEqual(json.loads(output.read_text(encoding="utf-8")), {"status": "second"})
            self.assertEqual(list(Path(directory).glob(".record.json.tmp-*")), [])

    def test_existing_and_dangling_output_symlinks_are_rejected_without_target_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.json"
            target.write_bytes(b"unchanged-target")
            existing_link = root / "existing-link.json"
            existing_link.symlink_to(target)
            with self.assertRaises(RuntimeError):
                observability.atomic_write_record(existing_link, {"unsafe": True})
            self.assertEqual(target.read_bytes(), b"unchanged-target")

            dangling_target = root / "missing-target.json"
            dangling_link = root / "dangling-link.json"
            dangling_link.symlink_to(dangling_target)
            with self.assertRaises(RuntimeError):
                observability.atomic_write_record(dangling_link, {"unsafe": True})
            self.assertFalse(dangling_target.exists())
            self.assertEqual(list(root.glob(".*.tmp-*")), [])

    def test_symlinked_parent_directory_is_rejected_without_target_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            actual_parent = root / "actual-parent"
            actual_parent.mkdir()
            linked_parent = root / "linked-parent"
            linked_parent.symlink_to(actual_parent, target_is_directory=True)

            with self.assertRaises(OSError):
                observability.atomic_write_record(linked_parent / "record.json", {"unsafe": True})

            self.assertFalse((actual_parent / "record.json").exists())
            self.assertEqual(list(actual_parent.glob(".record.json.tmp-*")), [])

    def test_replace_failure_preserves_target_and_removes_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "record.json"
            output.write_bytes(b"original")
            with mock.patch.object(observability.os, "replace", side_effect=OSError("injected")):
                with self.assertRaises(OSError):
                    observability.atomic_write_record(output, {"status": "new"})
            self.assertEqual(output.read_bytes(), b"original")
            self.assertEqual(list(root.glob(".record.json.tmp-*")), [])

    def test_cli_write_failure_returns_nonzero_and_never_follows_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.json"
            target.write_bytes(b"preserved")
            output = root / "record.json"
            output.symlink_to(target)
            environment = os.environ.copy()
            environment.pop("GITHUB_TOKEN", None)
            result = subprocess.run(
                [sys.executable, str(ROOT / "sde_schedule_observability.py"), "--output", str(output)],
                cwd=ROOT,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(target.read_bytes(), b"preserved")
            self.assertEqual(list(root.glob(".record.json.tmp-*")), [])


class JobsCompletenessTest(unittest.TestCase):
    @staticmethod
    def run_payload():
        return {
            "created_at": "2026-08-02T19:22:10Z",
            "run_started_at": "2026-08-02T19:22:20Z",
            "event": "schedule",
            "head_sha": "a" * 40,
            "run_attempt": 1,
        }

    @staticmethod
    def job(job_id, started_at="2026-08-02T19:22:25Z"):
        return {"id": job_id, "started_at": started_at}

    def fetch_with_jobs(self, jobs_payload):
        with mock.patch.object(
            observability,
            "github_get_json",
            side_effect=[self.run_payload(), jobs_payload],
        ) as get_json:
            result = observability.fetch_run_metadata("owner/repo", "123", "token")
        self.assertTrue(get_json.call_args_list[1].args[0].endswith("/jobs?per_page=100"))
        return result

    def test_complete_zero_one_and_one_hundred_job_responses_are_accepted(self):
        for count in (0, 1, 100):
            with self.subTest(count=count):
                jobs = [self.job(index + 1) for index in range(count)]
                result = self.fetch_with_jobs({"total_count": count, "jobs": jobs})
                self.assertTrue(result["available"])
                if count == 0:
                    self.assertIsNone(result["firstJobStartedAt"])
                else:
                    self.assertEqual(result["firstJobStartedAt"], "2026-08-02T19:22:25Z")

    def test_truncation_or_total_count_contradiction_is_blocked_without_first_job(self):
        for payload in (
            {"total_count": 2, "jobs": [self.job(1)]},
            {"total_count": 0, "jobs": [self.job(1)]},
        ):
            with self.subTest(payload=payload):
                result = self.fetch_with_jobs(payload)
                self.assertFalse(result["available"])
                self.assertEqual(result["warning"], "jobs_response_incomplete")
                record = observability.build_record(full_context(), result)
                self.assertEqual(record["metadataStatus"], "BLOCKED")
                self.assertIsNone(record["firstJobStartedAt"])

    def test_missing_or_invalid_total_count_is_blocked(self):
        for value in (None, -1, True, 1.5, "1"):
            with self.subTest(value=value):
                payload = {"jobs": []}
                if value is not None:
                    payload["total_count"] = value
                result = self.fetch_with_jobs(payload)
                self.assertEqual(result, {"available": False, "warning": "jobs_total_count_invalid"})

    def test_duplicate_jobs_and_missing_started_at_are_blocked(self):
        duplicate = self.fetch_with_jobs(
            {"total_count": 2, "jobs": [self.job(1), self.job(1)]}
        )
        self.assertEqual(duplicate["warning"], "duplicate_job_id")
        missing_started = self.fetch_with_jobs(
            {"total_count": 1, "jobs": [{"id": 1}]}
        )
        self.assertEqual(missing_started["warning"], "job_started_at_missing_or_invalid")

    def test_actions_api_http_errors_and_invalid_json_are_blocked(self):
        for code in (401, 403, 404, 429, 500, 503):
            with self.subTest(code=code), mock.patch.object(
                observability,
                "github_get_json",
                side_effect=urllib.error.HTTPError("url", code, "error", {}, None),
            ):
                result = observability.fetch_run_metadata("owner/repo", "123", "token")
                self.assertEqual(result["warning"], f"github_actions_read_http_{code}")
        with mock.patch.object(
            observability,
            "github_get_json",
            side_effect=json.JSONDecodeError("invalid", "x", 0),
        ):
            result = observability.fetch_run_metadata("owner/repo", "123", "token")
        self.assertEqual(result["warning"], "github_actions_read_invalid_json")


class WorkflowIntegrationTest(unittest.TestCase):
    def test_pipeline_guards_and_existing_attestation_remain_separate(self):
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("permissions:\n  contents: write\n  actions: read", source)
        self.assertNotIn("id-token: write", source)
        self.assertIn("group: update-static-balise-data", source)
        self.assertIn("cancel-in-progress: false", source)
        self.assertIn("run: python update_static_data.py", source)
        self.assertIn("name: sde-data-release-attestation-${{ steps.data-push.outputs.commit }}", source)
        self.assertIn("name: sde-schedule-observability-${{ github.run_id }}-${{ github.run_attempt }}", source)
        self.assertIn("if: always()\n        uses: actions/upload-artifact@v4", source)

    def test_helper_uses_only_get_and_never_names_repository_data_outputs(self):
        source = (ROOT / "sde_schedule_observability.py").read_text(encoding="utf-8")
        self.assertIn('method="GET"', source)
        for method in ('method="POST"', 'method="PUT"', 'method="PATCH"', 'method="DELETE"'):
            self.assertNotIn(method, source)
        self.assertNotIn("api_idag.json", source)
        self.assertNotIn("api_imorgen.json", source)
        self.assertNotIn("sde-data-provenance.json", source)

    def test_python_311_setup_precedes_all_observability_and_gate_steps(self):
        source = WORKFLOW.read_text(encoding="utf-8")
        ordered_names = (
            "Set up Python",
            "Initialize fail-closed schedule observability record",
            "Determine whether update is needed",
            "Generate static JSON files",
            "Enrich fail-closed schedule observability record",
            "Upload schedule observability record",
        )
        positions = [source.index(f"- name: {name}") for name in ordered_names]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(source.count("uses: actions/setup-python@v5"), 1)
        self.assertIn('python-version: "3.11"', source)
        setup_block = source[positions[0]:positions[1]]
        self.assertNotIn("if:", setup_block)
        self.assertEqual(source.count("run: python update_static_data.py"), 1)

    def test_initial_and_enriched_outputs_use_the_atomic_no_follow_writer(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        helper = (ROOT / "sde_schedule_observability.py").read_text(encoding="utf-8")
        self.assertIn("observability.atomic_write_record(output, record)", workflow)
        self.assertNotIn("output.write_text", workflow)
        self.assertIn("atomic_write_record(output, record)", helper)
        self.assertIn("os.O_NOFOLLOW", helper)


if __name__ == "__main__":
    unittest.main()

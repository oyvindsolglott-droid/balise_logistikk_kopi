import hashlib
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()

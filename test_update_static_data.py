import json
import itertools
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import update_static_data as static_data


OCCURRENCE_FIXTURE = json.loads(
    (Path(__file__).parent / "tests/fixtures/balise_tursatt_occurrences_2026-07-22.json").read_text()
)
PORSGRUNN_SPLIT_FIXTURE = json.loads(
    (Path(__file__).parent / "tests/fixtures/balise_tursatt_porsgrunn_split_2026-07-26.json").read_text()
)


def make_payload(mode, run_date):
    return {
        "ok": True,
        "updatedAt": "29.06.2026 12:00:00",
        "mode": mode,
        "date": run_date,
    }


class BaliseTrainLookupCandidateTest(unittest.TestCase):
    def test_re11_8xx_departures_try_808xx_before_908xx(self):
        self.assertEqual(
            static_data.get_balise_train_lookup_candidates("804"),
            ["804", "80804", "90804"],
        )

    def test_24xx_trains_try_bratsberg_balise_numbers(self):
        self.assertEqual(
            static_data.get_balise_train_lookup_candidates("2472"),
            ["2472", "92472", "12472"],
        )

    def test_remap_train_keys_uses_actual_balise_train_number(self):
        self.assertEqual(
            static_data.remap_train_keys(
                {"804": "74-44", "2472": "74-01"},
                {"804": "80804"},
            ),
            {"80804": "74-44", "2472": "74-01"},
        )

    def test_re11_8xx_departure_validates_outbound_balise_train_number(self):
        self.assertIn("80824", static_data.get_balise_train_lookup_candidates("824"))


class BaliseCandidateSelectionTest(unittest.TestCase):
    def make_candidate(
        self,
        lookup_train_no,
        general_hits=None,
        departure_hits=None,
        arrival_hits=None,
        has_train_content=True,
        skien_arrival_time="10:00",
        skien_departure_time="10:01",
    ):
        return {
            "lookup_train_no": lookup_train_no,
            "general_hits": general_hits or [],
            "departure_hits": departure_hits or [],
            "arrival_hits": arrival_hits or [],
            "has_train_content": has_train_content,
            "skien_arrival_time": skien_arrival_time,
            "skien_departure_time": skien_departure_time,
        }

    def test_re11_8xx_arrival_prefers_alternate_with_arrival_material(self):
        selected = static_data.select_balise_candidate_result(
            "853",
            [
                self.make_candidate("853", arrival_hits=["74-46", "74-50"]),
                self.make_candidate("80853", has_train_content=True),
                self.make_candidate("90853", general_hits=["74-19"], arrival_hits=["74-19"]),
            ],
        )

        self.assertEqual(selected["lookup_train_no"], "90853")
        self.assertEqual(selected["arrival_hits"], ["74-19"])
        self.assertNotEqual(selected["arrival_hits"], ["74-46", "74-50"])

    def test_re11_8xx_arrival_does_not_inherit_base_material_when_908xx_has_hits(self):
        selected = static_data.select_balise_candidate_result(
            "853",
            [
                self.make_candidate("853", general_hits=["74-46", "74-50"], arrival_hits=["74-46", "74-50"]),
                self.make_candidate("90853", general_hits=["74-19"], arrival_hits=["74-19"]),
            ],
        )

        self.assertEqual(selected["lookup_train_no"], "90853")
        self.assertEqual(selected["arrival_hits"], ["74-19"])

    def test_re11_8xx_departure_does_not_prefer_non_skien_alternate_content(self):
        selected = static_data.select_balise_candidate_result(
            "802",
            [
                self.make_candidate("802", general_hits=["74-01"], skien_departure_time=None),
                self.make_candidate(
                    "80802",
                    general_hits=["74-08"],
                    has_train_content=True,
                    skien_departure_time=None,
                ),
                self.make_candidate(
                    "90802",
                    general_hits=["74-20"],
                    departure_hits=["74-20"],
                    skien_departure_time="06:49",
                ),
            ],
        )

        self.assertEqual(selected["lookup_train_no"], "90802")
        self.assertEqual(selected["departure_hits"], ["74-20"])


class BaliseOccurrenceBoundDepartureTest(unittest.TestCase):
    def make_candidate(self, occurrence, general_hits=None):
        route_info = occurrence["routeInfo"]
        return {
            "lookup_train_no": occurrence["lookupTrainNumber"],
            "general_hits": list(general_hits or []),
            "departure_hits": [],
            "arrival_hits": [],
            "route_vehicle_hits": static_data.extract_route_vehicle_hits(
                occurrence["vehicleRows"],
                route_info.get("routeId", ""),
                "Skien",
            ),
            "has_train_content": bool(route_info),
            "skien_arrival_time": None,
            "skien_departure_time": occurrence["skienDepartureTime"],
            "route_info": route_info,
        }

    def test_80818_exact_occurrence_is_complete_and_ordered(self):
        candidates = [self.make_candidate(row) for row in OCCURRENCE_FIXTURE["occurrences"]]
        selected = static_data.select_balise_candidate_result(
            OCCURRENCE_FIXTURE["logicalTrain"],
            candidates,
            operational_date=OCCURRENCE_FIXTURE["operationalDate"],
        )
        resolution = static_data.resolve_departure_candidate(
            OCCURRENCE_FIXTURE["logicalTrain"],
            OCCURRENCE_FIXTURE["operationalDate"],
            selected,
        )

        self.assertEqual(selected["lookup_train_no"], "80818")
        self.assertEqual(selected["route_info"]["origin"], "Skien")
        self.assertEqual(selected["route_info"]["destination"], "Eidsvoll")
        self.assertEqual(resolution["displayTrainNumber"], "80818")
        self.assertEqual(resolution["departureTime"], "11:45")
        self.assertEqual(resolution["vehicleIds"], ["74-11", "74-41"])
        self.assertEqual(resolution["error"], "")

    def test_candidate_input_order_does_not_change_exact_occurrence(self):
        candidates = [self.make_candidate(row) for row in OCCURRENCE_FIXTURE["occurrences"]]
        selections = {
            static_data.select_balise_candidate_result(
                OCCURRENCE_FIXTURE["logicalTrain"],
                list(permutation),
                operational_date=OCCURRENCE_FIXTURE["operationalDate"],
            )["lookup_train_no"]
            for permutation in itertools.permutations(candidates)
        }
        self.assertEqual(selections, {"80818"})

    def test_page_wide_material_cannot_replace_occurrence_bound_material(self):
        exact = OCCURRENCE_FIXTURE["occurrences"][1]
        selected = self.make_candidate(exact, general_hits=["74-19", "74-49"])
        resolution = static_data.resolve_departure_candidate(
            OCCURRENCE_FIXTURE["logicalTrain"],
            OCCURRENCE_FIXTURE["operationalDate"],
            selected,
        )
        self.assertEqual(resolution["vehicleIds"], ["74-11", "74-41"])
        self.assertNotIn("74-19", resolution["vehicleIds"])

    def test_time_only_occurrence_is_explicitly_unresolved_without_cross_candidate_fallback(self):
        exact = OCCURRENCE_FIXTURE["occurrences"][1]
        selected = self.make_candidate(
            {**exact, "vehicleRows": []},
            general_hits=["74-19", "74-49"],
        )
        resolution = static_data.resolve_departure_candidate(
            OCCURRENCE_FIXTURE["logicalTrain"],
            OCCURRENCE_FIXTURE["operationalDate"],
            selected,
        )
        self.assertEqual(resolution["vehicleIds"], [])
        self.assertIn("80818", resolution["error"])
        self.assertIn("fixture-route-80818", resolution["error"])

    def test_80824_uses_only_its_separate_occurrence(self):
        occurrence = OCCURRENCE_FIXTURE["separateOccurrence"]
        selected = self.make_candidate(occurrence, general_hits=["74-11", "74-41"])
        resolution = static_data.resolve_departure_candidate(
            "824",
            OCCURRENCE_FIXTURE["operationalDate"],
            selected,
        )
        self.assertEqual(resolution["displayTrainNumber"], "80824")
        self.assertEqual(resolution["departureTime"], "14:45")
        self.assertEqual(resolution["vehicleIds"], ["74-19", "74-49"])
        self.assertNotIn("74-41", resolution["vehicleIds"])


class BalisePorsgrunnDepartureCompositionTest(unittest.TestCase):
    def make_candidate(
        self,
        vehicle_rows=None,
        *,
        route_info=None,
        route_stops=None,
    ):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        info = dict(route_info or fixture["routeInfo"])
        rows = list(fixture["vehicleRows"] if vehicle_rows is None else vehicle_rows)
        return {
            "lookup_train_no": fixture["lookupTrainNumber"],
            "general_hits": ["74-03", "74-46"],
            "departure_hits": ["74-03", "74-46"],
            "arrival_hits": [],
            "route_vehicle_hits": static_data.extract_route_vehicle_hits(
                rows,
                info.get("routeId", ""),
                "Skien",
            ),
            "route_vehicle_rows": rows,
            "route_stops": list(fixture["routeStops"] if route_stops is None else route_stops),
            "has_train_content": True,
            "skien_arrival_time": None,
            "skien_departure_time": fixture["skienDepartureTime"],
            "route_info": info,
        }

    def resolve(self, candidate=None, operational_date=None):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        return static_data.resolve_departure_candidate(
            fixture["logicalTrain"],
            operational_date or fixture["operationalDate"],
            candidate or self.make_candidate(),
        )

    def test_documented_80824_split_uses_only_porsgrunn_subset(self):
        resolution = self.resolve()

        self.assertEqual(resolution["displayTrainNumber"], "80824")
        self.assertEqual(resolution["departureTime"], "15:00")
        self.assertEqual(resolution["vehiclesObservedAtSkien"], ["74-03", "74-46"])
        self.assertEqual(resolution["vehiclesContinuingAtPorsgrunn"], ["74-03"])
        self.assertEqual(resolution["departureVehicles"], ["74-03"])
        self.assertEqual(resolution["vehicleIds"], ["74-03"])
        self.assertEqual(resolution["detachedAtSkien"], ["74-46"])
        self.assertEqual(resolution["vehicleResolutionSource"], "porsgrunn_occurrence_subset")
        self.assertEqual(resolution["vehicleError"], "")

    def test_double_set_continuing_at_porsgrunn_remains_double(self):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        rows = list(fixture["vehicleRows"]) + [
            {
                "sv_route": fixture["routeInfo"]["routeId"],
                "station_name": "Porsgrunn",
                "position": 5,
                "vehicle": "74-46",
            }
        ]
        resolution = self.resolve(self.make_candidate(rows))
        self.assertEqual(resolution["departureVehicles"], ["74-03", "74-46"])
        self.assertEqual(resolution["detachedAtSkien"], [])

    def test_single_set_continuing_at_porsgrunn_remains_single(self):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        rows = [
            row
            for row in fixture["vehicleRows"]
            if row["vehicle"] == "74-03"
        ]
        resolution = self.resolve(self.make_candidate(rows))
        self.assertEqual(resolution["departureVehicles"], ["74-03"])
        self.assertEqual(resolution["detachedAtSkien"], [])

    def test_other_operational_date_is_not_combined(self):
        resolution = self.resolve(operational_date="2026-07-27")
        self.assertEqual(resolution["departureVehicles"], [])
        self.assertIn("forekomstidentiteten", resolution["vehicleError"])

    def test_other_route_cannot_supply_porsgrunn_material(self):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        rows = [
            row
            for row in fixture["vehicleRows"]
            if row["station_name"] == "Skien"
        ] + [
            {
                "sv_route": "fixture-other-route",
                "station_name": "Porsgrunn",
                "position": 0,
                "vehicle": "74-03",
            }
        ]
        resolution = self.resolve(self.make_candidate(rows))
        self.assertEqual(resolution["departureVehicles"], [])
        self.assertIn("Porsgrunn", resolution["vehicleError"])

    def test_unknown_porsgrunn_vehicle_is_fail_closed(self):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        rows = [
            row
            for row in fixture["vehicleRows"]
            if row["station_name"] == "Skien"
        ] + [
            {
                "sv_route": fixture["routeInfo"]["routeId"],
                "station_name": "Porsgrunn",
                "position": 0,
                "vehicle": "74-41",
            }
        ]
        resolution = self.resolve(self.make_candidate(rows))
        self.assertEqual(resolution["departureVehicles"], [])
        self.assertNotIn("74-41", resolution["vehicleIds"])
        self.assertIn("delmengde", resolution["vehicleError"])

    def test_missing_porsgrunn_material_is_explicitly_unresolved(self):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        rows = [
            row
            for row in fixture["vehicleRows"]
            if row["station_name"] == "Skien"
        ]
        resolution = self.resolve(self.make_candidate(rows))
        self.assertEqual(resolution["departureVehicles"], [])
        self.assertIn("Porsgrunn", resolution["vehicleError"])

    def test_general_set_difference_supports_more_than_two_vehicles(self):
        route_id = PORSGRUNN_SPLIT_FIXTURE["routeInfo"]["routeId"]
        rows = [
            {"sv_route": route_id, "station_name": "Skien", "position": 0, "vehicle": "74-03"},
            {"sv_route": route_id, "station_name": "Skien", "position": 5, "vehicle": "74-46"},
            {"sv_route": route_id, "station_name": "Skien", "position": 10, "vehicle": "74-41"},
            {"sv_route": route_id, "station_name": "Porsgrunn", "position": 0, "vehicle": "74-46"},
            {"sv_route": route_id, "station_name": "Porsgrunn", "position": 5, "vehicle": "74-41"},
        ]
        resolution = self.resolve(self.make_candidate(rows))
        self.assertEqual(resolution["departureVehicles"], ["74-46", "74-41"])
        self.assertEqual(resolution["detachedAtSkien"], ["74-03"])

    def test_porsgrunn_subset_order_selects_actual_vehicle_not_first_skien_vehicle(self):
        fixture = PORSGRUNN_SPLIT_FIXTURE
        rows = [
            row
            for row in fixture["vehicleRows"]
            if row["station_name"] == "Skien"
        ] + [
            {
                "sv_route": fixture["routeInfo"]["routeId"],
                "station_name": "Porsgrunn",
                "position": 0,
                "vehicle": "74-46",
            }
        ]
        resolution = self.resolve(self.make_candidate(rows))
        self.assertEqual(resolution["departureVehicles"], ["74-46"])
        self.assertEqual(resolution["detachedAtSkien"], ["74-03"])


class DepartureCompletenessContractTest(unittest.TestCase):
    def test_build_payload_keeps_departure_and_vehicle_on_same_display_number(self):
        occurrence = {
            "operationalDate": "2026-07-22",
            "requestedTrainNumber": "818",
            "displayTrainNumber": "80818",
            "routeId": "fixture-route-80818",
            "origin": "Skien",
            "destination": "Eidsvoll",
            "station": "Skien",
            "departureTime": "11:45",
            "vehicleIds": ["74-11", "74-41"],
        }

        def fake_fetch(train_numbers, run_date, deadline_at=None):
            return (
                {"818": "74-11, 74-41"},
                {"818": "74-11, 74-41"},
                {},
                {},
                {"818": "80818"},
                {"818": "80818"},
                {},
                {"818": "11:45"},
                {},
                {},
                {"818": occurrence},
            )

        with patch.object(static_data, "fetch_vehicle_maps_for_trains", side_effect=fake_fetch):
            with patch.object(
                static_data,
                "get_operational_tursatt_dates",
                return_value={
                    "arrival_date": static_data.date(2026, 7, 22),
                    "departure_date": static_data.date(2026, 7, 22),
                    "window": "test",
                },
            ):
                payload = static_data.build_payload("imorgen")

        self.assertEqual(payload["departures"]["80818"], "11:45")
        self.assertEqual(payload["departureVehicles"]["80818"], "74-11, 74-41")
        self.assertEqual(payload["departureOccurrences"]["80818"]["routeId"], "fixture-route-80818")

    def test_departure_without_material_or_error_is_rejected(self):
        payload = {
            "ok": True,
            "updatedAt": "22.07.2026 12:00:00",
            "mode": "imorgen",
            "date": "2026-07-22",
            "departures": {"80818": "11:45"},
            "departureVehicles": {},
            "vehicleErrors": {},
        }
        with self.assertRaisesRegex(ValueError, "80818"):
            static_data.validate_payload("imorgen", payload)

    def test_explicitly_unresolved_departure_passes_per_train_fail_closed_contract(self):
        payload = {
            "ok": True,
            "updatedAt": "22.07.2026 12:00:00",
            "mode": "imorgen",
            "date": "2026-07-22",
            "departures": {"80818": "11:45"},
            "departureVehicles": {},
            "vehicleErrors": {"80818": "Forekomstbundet materiell mangler"},
        }
        self.assertIs(static_data.validate_payload("imorgen", payload), payload)


class BaliseArrivalSegmentSelectionTest(unittest.TestCase):
    def test_arrival_to_skien_prefers_skien_segment_over_locked_earlier_segment(self):
        text = """
        Eidsvoll - Hensetting: 🔒 74-40, 74-20
        Eidsvoll Verk - Oslo S: 74-20
        Oslo S - Skien: 74-20, 74-41
        """

        general, departure, arrival = static_data.extract_vehicle_hits_from_balise_text(text)

        self.assertEqual(general, ["74-20", "74-41"])
        self.assertEqual(departure, [])
        self.assertEqual(arrival, ["74-20", "74-41"])
        self.assertNotIn("74-40", arrival)

    def test_arrival_to_skien_falls_back_to_segment_passing_porsgrunn(self):
        text = """
        Eidsvoll - Hensetting: 74-40, 74-20
        Eidsvoll Verk - Oslo S: 74-20
        Oslo S - Porsgrunn: 74-20, 74-41
        """

        _general, departure, arrival = static_data.extract_vehicle_hits_from_balise_text(text)

        self.assertEqual(departure, [])
        self.assertEqual(arrival, ["74-20", "74-41"])
        self.assertNotIn("74-40", arrival)


class BaliseDepartureSegmentSelectionTest(unittest.TestCase):
    def test_departure_from_skien_prefers_skien_segment_over_earlier_segment(self):
        text = """
        Eidsvoll - Hensetting: 🔒 74-40, 74-20
        Skien - Eidsvoll: 74-20, 74-41
        """

        general, departure, _arrival = static_data.extract_vehicle_hits_from_balise_text(text)

        self.assertEqual(general, ["74-20", "74-41"])
        self.assertEqual(departure, ["74-20", "74-41"])
        self.assertNotIn("74-40", departure)

    def test_departure_from_skien_falls_back_to_segment_passing_porsgrunn(self):
        text = """
        Hensetting - Oslo S: 74-40, 74-20
        Skien - Porsgrunn: 74-20, 74-41
        """

        _general, departure, _arrival = static_data.extract_vehicle_hits_from_balise_text(text)

        self.assertEqual(departure, ["74-20", "74-41"])
        self.assertNotIn("74-40", departure)

    def test_departure_from_skien_does_not_use_segment_ending_at_porsgrunn(self):
        text = """
        Eidsvoll - Hensetting: 74-40, 74-20
        Oslo S - Porsgrunn: 74-20, 74-41
        """

        _general, departure, arrival = static_data.extract_vehicle_hits_from_balise_text(text)

        self.assertEqual(departure, [])
        self.assertEqual(arrival, ["74-20", "74-41"])

    def test_departure_from_skien_rejects_route_from_other_origin(self):
        text = """
        Drammen - Eidsvoll: 74-08
        """

        _general, departure, _arrival = static_data.extract_vehicle_hits_from_balise_text(text)

        self.assertFalse(static_data.has_departure_stop_at_skien(text))
        self.assertEqual(departure, [])


class BaliseSkienStationStopTest(unittest.TestCase):
    def test_station_stop_detects_starting_departure_from_skien(self):
        text = "\tSkien\t2\t\t\t15:09\t"

        stop = static_data.extract_skien_station_stop(text)

        self.assertIsNone(stop["arrival"])
        self.assertEqual(stop["departure"], "15:09")
        self.assertTrue(static_data.has_departure_stop_at_skien(text))

    def test_station_stop_detects_terminating_arrival_to_skien(self):
        text = "\tSkien\t2\t13:53\t\t\t"

        stop = static_data.extract_skien_station_stop(text)

        self.assertEqual(stop["arrival"], "13:53")
        self.assertIsNone(stop["departure"])
        self.assertTrue(static_data.has_arrival_stop_at_skien(text))

    def test_station_stop_detects_through_train_arrival_and_departure(self):
        text = "\tSkien\t3\t12:02\t\t12:03\t"

        stop = static_data.extract_skien_station_stop(text)

        self.assertEqual(stop["arrival"], "12:02")
        self.assertEqual(stop["departure"], "12:03")
        self.assertTrue(static_data.has_arrival_stop_at_skien(text))
        self.assertTrue(static_data.has_departure_stop_at_skien(text))

    def test_station_stop_rejects_route_without_skien_stop(self):
        text = "\tDrammen\t2\t05:35\t\t05:42\t\n\tEidsvoll\t2\t07:01\t\t\t"

        stop = static_data.extract_skien_station_stop(text)

        self.assertIsNone(stop["arrival"])
        self.assertIsNone(stop["departure"])
        self.assertFalse(static_data.has_arrival_stop_at_skien(text))
        self.assertFalse(static_data.has_departure_stop_at_skien(text))


class SkienStationStopPayloadFilterTest(unittest.TestCase):
    def test_departures_only_include_balise_validated_skien_station_departures(self):
        def fake_fetch(train_numbers, run_date, deadline_at=None):
            return (
                {"802": "74-08", "824": "74-20, 74-41", "2478": "74-07"},
                {"824": "74-20, 74-41", "2478": "74-07"},
                {"2478": "74-07"},
                {},
                {"802": "80802", "824": "80824", "2478": "92478"},
                {"824": "80824", "2478": "92478"},
                {"2478": "92478"},
                {"824": "14:45", "2478": "12:03"},
                {"2478": "12:02"},
            )

        with patch.object(static_data, "fetch_vehicle_maps_for_trains", side_effect=fake_fetch):
            with patch.object(
                static_data,
                "get_operational_tursatt_dates",
                return_value={
                    "arrival_date": static_data.date(2026, 7, 2),
                    "departure_date": static_data.date(2026, 7, 2),
                    "window": "test",
                },
            ):
                payload = static_data.build_payload("imorgen")

        self.assertNotIn("802", payload["departures"])
        self.assertNotIn("80802", payload["departures"])
        self.assertIn("80824", payload["departures"])
        self.assertIn("92478", payload["departures"])
        self.assertIn("92478", payload["arrivals"])
        self.assertEqual(payload["departures"]["80824"], "14:45")
        self.assertEqual(payload["departures"]["92478"], "12:03")
        self.assertEqual(payload["arrivals"]["92478"]["time"], "12:02")
        self.assertEqual(payload["departureVehicles"]["80824"], "74-20, 74-41")
        self.assertEqual(payload["departureVehicles"]["92478"], "74-07")
        self.assertEqual(payload["arrivalVehicles"]["92478"], "74-07")


class AtomicStaticDataRefreshTest(unittest.TestCase):
    def test_atomic_write_writes_both_payload_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            payloads = {
                "idag": make_payload("idag", "2026-06-29"),
                "imorgen": make_payload("imorgen", "2026-06-30"),
            }

            static_data.atomic_write_payloads(payloads, output_dir=output_dir, log=lambda _: None)

            idag = json.loads((output_dir / "api_idag.json").read_text())
            imorgen = json.loads((output_dir / "api_imorgen.json").read_text())
            self.assertEqual(idag["date"], "2026-06-29")
            self.assertEqual(imorgen["date"], "2026-06-30")

    def test_imorgen_build_failure_leaves_existing_files_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            idag_path = output_dir / "api_idag.json"
            imorgen_path = output_dir / "api_imorgen.json"
            original_idag = '{"old":"idag"}'
            original_imorgen = '{"old":"imorgen"}'
            idag_path.write_text(original_idag)
            imorgen_path.write_text(original_imorgen)

            def failing_build(mode, deadline_at=None):
                if mode == "imorgen":
                    raise RuntimeError("simulated imorgen failure")
                return make_payload(mode, "2026-06-29")

            with self.assertRaises(RuntimeError):
                static_data.refresh_static_data(
                    output_dir=output_dir,
                    build_func=failing_build,
                    log=lambda _: None,
                )

            self.assertEqual(idag_path.read_text(), original_idag)
            self.assertEqual(imorgen_path.read_text(), original_imorgen)

    def test_dry_run_builds_but_does_not_write_final_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            output_dir = Path(tmp)
            built_modes = []

            def fake_build(mode, deadline_at=None):
                built_modes.append(mode)
                return make_payload(mode, "2026-06-29")

            static_data.refresh_static_data(
                output_dir=output_dir,
                dry_run=True,
                build_func=fake_build,
                log=lambda _: None,
            )

            self.assertEqual(built_modes, ["idag", "imorgen"])
            self.assertFalse((output_dir / "api_idag.json").exists())
            self.assertFalse((output_dir / "api_imorgen.json").exists())


if __name__ == "__main__":
    unittest.main()

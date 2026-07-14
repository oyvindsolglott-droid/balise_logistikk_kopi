import unittest
from datetime import date
from unittest.mock import patch

import update_static_data as static_data


class BaliseActualPlatformPropagationTest(unittest.TestCase):
    def route_info(self):
        return {
            "routeId": "route-92489",
            "trainNumber": "92489",
            "operationalDate": "2026-07-13",
            "origin": "Porsgrunn",
            "destination": "Notodden",
        }

    def skien_stop(self, track="2", actual_arrival="2026-07-13 20:48:26"):
        return {
            "stop_id": "stop-skien",
            "station_name": "Skien",
            "station_ref": "SKN",
            "stop_track": track,
            "stop_planned_arrival": "2026-07-13 20:51:00",
            "stop_estimated_arrival": "",
            "stop_actual_arrival": actual_arrival,
            "stop_planned_departure": "2026-07-13 20:52:00",
            "stop_estimated_departure": "",
            "stop_actual_departure": "",
        }

    def test_m_parser_preserves_explicit_track_without_guessing_slot_side(self):
        track_two = static_data.extract_skien_station_stop("\tSkien\t2\t20:51\t\t20:52\t")
        track_three = static_data.extract_skien_station_stop("\tSkien\tspor 3\t20:51\t\t20:52\t")
        missing = static_data.extract_skien_station_stop("\tSkien\tukjent\t20:51\t\t20:52\t")

        self.assertEqual(track_two["platformTrack"], "2")
        self.assertEqual(track_three["platformTrack"], "3")
        self.assertIsNone(missing["platformTrack"])
        self.assertEqual(missing["rawTrackValue"], "ukjent")

    def test_m_movement_context_is_bound_to_one_exact_occurrence(self):
        context = static_data.build_skien_movement_context(
            self.route_info(),
            [self.skien_stop("2")],
            "2026-07-13T22:55:31+02:00",
            "2026-07-13T22:55:30+02:00",
        )

        self.assertEqual(context["occurrenceId"], "2026-07-13|arrival|92489|20:51")
        self.assertEqual(context["platformTrack"], "2")
        self.assertEqual(context["rawTrackField"], "stop_track")
        self.assertEqual(context["rawTrackValue"], "2")
        self.assertEqual(context["movementStatus"], "actual_arrival")
        self.assertEqual(context["trackProvenance"], "balise.no/api/train/stops.stop_track")

    def test_m_ambiguous_or_unidentified_stop_fails_closed(self):
        duplicate = [self.skien_stop("2"), {**self.skien_stop("3"), "stop_id": "other"}]
        self.assertIsNone(
            static_data.build_skien_movement_context(
                self.route_info(), duplicate, "2026-07-13T22:55:31+02:00"
            )
        )
        self.assertIsNone(
            static_data.build_skien_movement_context(
                {**self.route_info(), "routeId": ""},
                [self.skien_stop("2")],
                "2026-07-13T22:55:31+02:00",
            )
        )

    def test_m_static_payload_adds_context_without_replacing_legacy_fields(self):
        movement_context = static_data.build_skien_movement_context(
            {**self.route_info(), "trainNumber": "92478"},
            [{**self.skien_stop("3"), "stop_planned_arrival": "2026-07-02 12:02:00"}],
            "2026-07-02T12:05:00+02:00",
        )
        movement_context["vehicleIds"] = ["74-07"]
        movement_context["consistContext"] = "single_set"

        def fake_fetch(train_numbers, run_date, deadline_at=None):
            return (
                {"2478": "74-07"},
                {"2478": "74-07"},
                {"2478": "74-07"},
                {},
                {"2478": "92478"},
                {"2478": "92478"},
                {"2478": "92478"},
                {"2478": "12:03"},
                {"2478": "12:02"},
                {"2478": movement_context},
            )

        with patch.object(static_data, "fetch_vehicle_maps_for_trains", side_effect=fake_fetch):
            with patch.object(
                static_data,
                "get_operational_tursatt_dates",
                return_value={
                    "arrival_date": date(2026, 7, 2),
                    "departure_date": date(2026, 7, 2),
                    "window": "test",
                },
            ):
                payload = static_data.build_payload("idag")

        arrival = payload["arrivals"]["92478"]
        self.assertEqual(arrival["time"], "12:02")
        self.assertFalse(arrival["nextDay"])
        self.assertEqual(arrival["movementContext"]["platformTrack"], "3")
        self.assertEqual(arrival["movementContext"]["vehicleIds"], ["74-07"])
        self.assertEqual(arrival["movementContext"]["consistContext"], "single_set")


if __name__ == "__main__":
    unittest.main()

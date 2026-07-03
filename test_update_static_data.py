import json
import tempfile
import unittest
from pathlib import Path

import update_static_data as static_data


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

    def test_non_8xx_trains_use_original_train_number(self):
        self.assertEqual(
            static_data.get_balise_train_lookup_candidates("2472"),
            ["2472"],
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
        is_arrival_route_to_base=True,
    ):
        return {
            "lookup_train_no": lookup_train_no,
            "general_hits": general_hits or [],
            "departure_hits": departure_hits or [],
            "arrival_hits": arrival_hits or [],
            "has_train_content": has_train_content,
            "is_arrival_route_to_base": is_arrival_route_to_base,
        }

    def test_re11_8xx_arrival_prefers_alternate_with_arrival_material(self):
        selected = static_data.select_balise_candidate_result(
            "853",
            [
                self.make_candidate("853", arrival_hits=["74-46", "74-50"]),
                self.make_candidate("80853", has_train_content=True, is_arrival_route_to_base=True),
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

import unittest

import update_static_data as static_data


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


if __name__ == "__main__":
    unittest.main()

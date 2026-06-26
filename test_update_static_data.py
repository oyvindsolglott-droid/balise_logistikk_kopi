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


if __name__ == "__main__":
    unittest.main()

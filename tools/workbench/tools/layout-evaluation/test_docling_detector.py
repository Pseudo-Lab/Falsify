"""Synthetic unit tests only; they do not establish model accuracy."""
import math
import unittest
from docling_detector import normalize


class NormalizeTest(unittest.TestCase):
    def test_scale_page_coordinates_and_preserve_label(self):
        self.assertEqual(normalize(1, [10, 20, 90, 180], .75, 0, (100, 200), (300, 400)),
                         {'pageIndex': 1, 'bbox': [30, 40, 270, 360], 'label': 'Caption', 'confidence': .75})

    def test_invalid_observations_fail_explicitly(self):
        for box, score, label in [([-1, 0, 5, 5], .5, 0), ([0, 0, 0, 1], .5, 0), ([0, 0, 1, 1], math.nan, 0), ([0, 0, 1, 1], 1.1, 0), ([0, 0, 1, 1], .5, 17)]:
            with self.subTest(box=box, score=score, label=label), self.assertRaises(ValueError):
                normalize(0, box, score, label, (100, 100), (100, 100))


if __name__ == '__main__':
    unittest.main()

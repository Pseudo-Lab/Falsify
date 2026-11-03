import sys
import unittest
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from paper_chart_traces import trace_mask


class TraceTests(unittest.TestCase):
    def test_parallel_same_color_bands_are_distinct(self):
        mask = np.zeros((100, 160), bool)
        mask[30:33, 10:150] = True
        mask[60:63, 10:150] = True
        result = trace_mask(mask)
        self.assertEqual(len(result['traces']), 2)
        self.assertEqual([t['columns'][0]['y'] for t in result['traces']], [31, 61])
        self.assertEqual(result['issues'], [])

    def test_dashed_curve_links_observations_without_inventing_gap_pixels(self):
        mask = np.zeros((100, 160), bool)
        for x in range(10, 150, 16): mask[30:33, x:x+8] = True
        result = trace_mask(mask, max_gap=12)
        self.assertEqual(len(result['traces']), 1)
        trace = result['traces'][0]
        self.assertTrue(trace['gaps'])
        self.assertTrue(all(mask[round(p['y']), p['x']] for p in trace['columns']))
        self.assertNotIn(20, [p['x'] for p in trace['columns']])

    def test_crossing_junction_does_not_pool_the_two_series(self):
        image = Image.new('1', (180, 120))
        draw = ImageDraw.Draw(image)
        draw.line([(10, 20), (170, 100)], fill=1, width=3)
        draw.line([(10, 100), (170, 20)], fill=1, width=3)
        mask = np.asarray(image, dtype=bool)
        result = trace_mask(mask)
        self.assertGreaterEqual(len(result['traces']), 2)
        self.assertIn('curve-junction-ambiguous', result['issues'])
        for trace in result['traces']:
            self.assertTrue(all(mask[round(p['y']), p['x']] for p in trace['columns']))

    def test_large_missing_interval_is_not_filled_or_silently_joined(self):
        mask = np.zeros((100, 160), bool)
        mask[40:43, 5:60] = True
        mask[40:43, 90:150] = True
        result = trace_mask(mask, max_gap=12)
        self.assertEqual(len(result['traces']), 2)
        self.assertFalse(any(60 <= p['x'] < 90 for t in result['traces'] for p in t['columns']))

    def test_speckles_and_empty_masks_do_not_become_traces(self):
        mask = np.zeros((100, 160), bool)
        self.assertEqual(trace_mask(mask)['traces'], [])
        mask[10, 20] = True
        self.assertEqual(trace_mask(mask)['traces'], [])


if __name__ == '__main__': unittest.main()

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from paper_chart_sampling import sample_trace


def column(x, y):
    value = float(y)
    return {'x': int(x), 'y': value, 'low': math.floor(value), 'high': math.ceil(value)}


def xs(result):
    return [point['x'] for point in result['points']]


class SampleTraceTests(unittest.TestCase):
    def assert_original_records(self, columns, result):
        identities = {id(item) for item in columns}
        self.assertTrue(result['points'])
        self.assertEqual(len(result['points']), len({id(point) for point in result['points']}))
        for point in result['points']:
            self.assertIn(id(point), identities)
            self.assertIsInstance(point, dict)
            self.assertIn('y', point)

    def test_straight_line_keeps_endpoints_and_tick_anchors(self):
        columns = [column(x, 5) for x in range(41)]
        columns[10]['marker'] = 'tick'
        before = [(item['x'], item['y']) for item in columns]
        result = sample_trace(columns, x_ticks=(10, 10.4, 33))
        self.assertEqual(before, [(item['x'], item['y']) for item in columns])
        self.assertEqual(xs(result), [0, 10, 33, 40])
        self.assertIs(result['points'][1], columns[10])
        self.assertEqual(result['points'][1]['marker'], 'tick')
        self.assertEqual(result['segments'], [[0, 3]])
        self.assertEqual(result['issues'], [])
        self.assertLessEqual(result['maxDeviationPixels'], 0.001)
        diagonal = [column(x, x) for x in range(101)]
        diagonal_result = sample_trace(diagonal)
        self.assertEqual(xs(diagonal_result), [0, 100])
        self.assertEqual([point['y'] for point in diagonal_result['points']], [0.0, 100.0])

    def test_subtolerance_wiggle_is_removed_and_real_peak_remains(self):
        noise = [column(x, 0) for x in range(21)]
        noise[10] = column(10, 0.2)
        self.assertEqual(xs(sample_trace(noise, tolerance_px=0.75)), [0, 20])
        peak = [column(x, 0) for x in range(21)]
        peak[10] = column(10, 2)
        result = sample_trace(peak, tolerance_px=0.75, max_points=8)
        # A one-column spike needs its flat shoulders as well as the peak;
        # three vertices would turn it into a broad triangular hill.
        self.assertEqual(xs(result), [0, 9, 10, 11, 20])
        self.assertIs(result['points'][xs(result).index(10)], peak[10])
        self.assertLessEqual(result['maxDeviationPixels'], 0.751)
        self.assertEqual(result['issues'], [])

    def test_peaks_and_valleys_between_ticks_survive(self):
        columns = []
        for x in range(101):
            if x <= 30:
                y = 50 - 40 * (x / 30)
            elif x <= 70:
                y = 10 + 80 * ((x - 30) / 40)
            else:
                y = 90 - 40 * ((x - 70) / 30)
            columns.append(column(x, y))
        result = sample_trace(columns, x_ticks=(0, 50, 100), max_points=8, tolerance_px=0.75)
        self.assert_original_records(columns, result)
        self.assertEqual(xs(result), [0, 30, 50, 70, 100])
        self.assertEqual(result['points'][1]['y'], 10.0)
        self.assertEqual(result['points'][3]['y'], 90.0)
        self.assertEqual(result['segments'], [[0, 4]])
        self.assertEqual(result['issues'], [])
        self.assertLessEqual(result['maxDeviationPixels'], 0.751)

    def test_tight_budget_still_keeps_a_triangle_peak_between_ticks(self):
        columns = []
        for x in range(101):
            y = 30 * (x / 50) if x <= 50 else 30 * ((100 - x) / 50)
            columns.append(column(x, y))
        tight = sample_trace(columns, x_ticks=(0, 25, 100), max_points=3, tolerance_px=0.75)
        self.assertEqual(xs(tight), [0, 50, 100])
        self.assertEqual(tight['points'][1]['y'], 30.0)
        self.assertEqual(tight['issues'], [])
        self.assertLessEqual(tight['maxDeviationPixels'], 0.751)
        with_anchor = sample_trace(columns, x_ticks=(0, 25, 100), max_points=4, tolerance_px=0.75)
        self.assertEqual(xs(with_anchor), [0, 25, 50, 100])
        self.assertNotIn('sampling-point-limit', with_anchor['issues'])

    def test_budget_below_extrema_marks_sampling_point_limit(self):
        columns = []
        for x in range(101):
            y = 30 * (x / 50) if x <= 50 else 30 * ((100 - x) / 50)
            columns.append(column(x, y))
        dropped = sample_trace(columns, max_points=2, tolerance_px=0.75)
        self.assertEqual(xs(dropped), [0, 100])
        self.assertEqual(dropped['issues'], ['sampling-point-limit'])
        self.assertAlmostEqual(dropped['maxDeviationPixels'], 30.0, places=4)
        self.assertTrue(all(point is columns[point['x']] for point in dropped['points']))
        self.assertNotIn(15.0, [point['y'] for point in dropped['points']])

        zigzag = []
        x = 0
        for _ in range(5):
            for step in range(10):
                zigzag.append(column(x, 20 * step / 10))
                x += 1
            for step in range(10):
                zigzag.append(column(x, 20 * (10 - step) / 10))
                x += 1
        zigzag.append(column(x, 0))
        limited = sample_trace(zigzag, max_points=4, tolerance_px=0.75)
        self.assertLessEqual(len(limited['points']), 4)
        self.assertEqual(limited['issues'], ['sampling-point-limit'])
        self.assertGreater(limited['maxDeviationPixels'], 0.75)
        self.assertLessEqual(limited['maxDeviationPixels'], 20.01)
        self.assertIn(zigzag[0], limited['points'])
        self.assertIn(zigzag[-1], limited['points'])
        self.assertTrue(all(point in zigzag for point in limited['points']))

    def test_absent_columns_split_segments_without_interpolation(self):
        left = [column(x, 0) for x in range(5)]
        right = [column(x, 40) for x in range(10, 15)]
        columns = left + right
        result = sample_trace(columns, x_ticks=(7,), max_points=8)
        self.assertEqual(xs(result), [0, 4, 10, 14])
        self.assertEqual([point['y'] for point in result['points']], [0.0, 0.0, 40.0, 40.0])
        self.assertEqual(result['segments'], [[0, 1], [2, 3]])
        self.assertNotIn(7, xs(result))
        self.assertEqual(result['issues'], [])
        single_gap = [column(x, 3) for x in (0, 1, 2, 4, 5)]
        split = sample_trace(single_gap, max_points=10)
        self.assertEqual(xs(split), [0, 2, 4, 5])
        self.assertEqual(split['segments'], [[0, 1], [2, 3]])

    def test_each_gap_segment_keeps_its_own_peak(self):
        def hump(start):
            peak = start + 10
            end = start + 20
            built = []
            for x in range(start, end + 1):
                if x <= peak:
                    y = 15 * (x - start) / 10
                else:
                    y = 15 * (end - x) / 10
                built.append(column(x, y))
            return built
        columns = hump(0) + hump(40)
        result = sample_trace(columns, max_points=16, tolerance_px=0.75)
        self.assertIn(10, xs(result))
        self.assertIn(50, xs(result))
        self.assertEqual(result['points'][xs(result).index(10)]['y'], 15.0)
        self.assertEqual(result['points'][xs(result).index(50)]['y'], 15.0)
        self.assertEqual(len(result['segments']), 2)
        self.assertEqual(result['issues'], [])
        self.assertTrue(all(point['x'] <= 20 or point['x'] >= 40 for point in result['points']))

    def test_pixel_sampling_is_independent_of_log_calibration(self):
        curved = [column(x, 10 ** (1 + x / 100)) for x in range(101)]
        result = sample_trace(curved, tolerance_px=0.75)
        self.assertGreater(len(result['points']), 2)
        self.assertNotIn('sampling-point-limit', result['issues'])
        self.assertLessEqual(result['maxDeviationPixels'], 0.751)
        for point in result['points']:
            self.assertIs(point, curved[point['x']])
            self.assertNotAlmostEqual(point['y'], math.log10(point['y']), delta=0.01)
        sparse = [column(0, 1), column(50, 10), column(100, 100)]
        kept = sample_trace(sparse, tolerance_px=0.75)
        self.assertEqual([point['y'] for point in kept['points']], [1.0, 10.0, 100.0])
        self.assertIs(kept['points'][1], sparse[1])

    def test_unsorted_columns_are_ordered_without_copying_records(self):
        columns = [column(2, 1), column(0, 4), column(1, 4)]
        result = sample_trace(columns)
        # The corner at (1,4) is 0.832 pixels from the endpoint chord, so it
        # cannot be discarded under the default 0.75-pixel error bound.
        self.assertEqual(xs(result), [0, 1, 2])
        self.assertIs(result['points'][0], columns[1])
        self.assertIs(result['points'][-1], columns[0])
        self.assertEqual([item['x'] for item in columns], [2, 0, 1])

    def test_tick_tie_prefers_the_smaller_x(self):
        columns = [column(x, 1) for x in range(21)]
        result = sample_trace(columns, x_ticks=(10.5,))
        self.assertEqual(xs(result), [0, 10, 20])

    def test_empty_and_single_column(self):
        empty = sample_trace(())
        self.assertEqual(empty, {'points': [], 'segments': [], 'issues': [], 'maxDeviationPixels': 0.0})
        only = [column(4, 8)]
        result = sample_trace(only, x_ticks=(100,))
        self.assertIs(result['points'][0], only[0])
        self.assertEqual(result['segments'], [[0, 0]])
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['maxDeviationPixels'], 0.0)


if __name__ == '__main__':
    unittest.main()

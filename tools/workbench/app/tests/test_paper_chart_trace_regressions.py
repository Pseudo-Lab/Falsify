"""Semantic trace regressions for same-color curves, off-tick extrema, and the geometry adapter.

Drawings are Pillow-only. Axis text is the supplied OCR boxes, not a live OCR call.
Assertions follow values and positions. They do not require a fixed reduced-point count or order.
"""
import io
import json
import math
import sys
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
from paper_chart import _geometry_result, _image_info
from paper_chart_geometry import extract_geometry

# Exact labels used to reproduce the G01/G02 calibrations.
OCR = [
    {'text': '1', 'bbox': [113, 418, 127, 438]},
    {'text': '2', 'bbox': [233, 418, 247, 438]},
    {'text': '3', 'bbox': [353, 418, 367, 438]},
    {'text': '4', 'bbox': [473, 418, 487, 438]},
    {'text': '80', 'bbox': [40, 72, 75, 88]},
    {'text': '40', 'bbox': [40, 152, 75, 168]},
    {'text': '20', 'bbox': [40, 232, 75, 248]},
    {'text': '10', 'bbox': [40, 312, 75, 328]},
]
BLUE = '#1f77b4'
RED = '#d62728'
GREEN = '#2ca02c'
PURPLE = '#9467bd'
ORANGE = '#ff7f0e'
CYAN = '#17becf'
MEDIAN_AT_TICKS = (8.408964152537154, 16.81792830507431, 33.63585661014861, 67.27171322029719)
LOW_AT_TICKS = (math.sqrt(50), math.sqrt(200), math.sqrt(800), math.sqrt(3200))
HIGH_AT_TICKS = (10, 20, 40, 80)
JSON_LIMIT = 2 * 1024 * 1024


def chart(draw):
    image = Image.new('RGB', (640, 480), 'white')
    pen = ImageDraw.Draw(image)
    pen.rectangle((90, 30, 550, 400), outline='black', width=2)
    draw(pen)
    buf = io.BytesIO()
    image.save(buf, format='PNG')
    return buf.getvalue(), [dict(item) for item in OCR]


def frame_fixture(dual=False, bars=False):
    """Same frame, ticks, and strokes as test_paper_chart_geometry.fixture."""
    image = Image.new('RGB', (640, 480), 'white')
    pen = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=17)
    lines = []
    pen.rectangle((90, 30, 550, 400), outline='black', width=2)

    def label(text, box, color='black'):
        pen.text((box[0], box[1]), text, font=font, fill=color)
        lines.append({'text': text, 'bbox': box})

    for x, value in zip([120, 240, 360, 480], [1, 2, 3, 4]):
        label(str(value), [x - 7, 418, x + 7, 438])
    for y, value in zip([80, 160, 240, 320], [80, 40, 20, 10]):
        label(str(value), [40, y - 8, 75, y + 8], BLUE if dual else 'black')
    if bars:
        for x in [120, 240, 360, 480]:
            pen.rectangle((x - 18, 180, x + 18, 398), fill=BLUE)
    else:
        blue = [(120, 320), (240, 240), (360, 160), (480, 80)]
        pen.line(blue, fill=BLUE, width=3)
        for x, y in blue:
            pen.ellipse((x - 5, y - 5, x + 5, y + 5), fill=BLUE)
    if dual:
        for y, value in zip([80, 160, 240, 320], [12, 9, 6, 3]):
            label(str(value), [565, y - 8, 598, y + 8], RED)
        red = [(120, 350), (240, 270), (360, 190), (480, 110)]
        pen.line(red, fill=RED, width=3)
        for x, y in red:
            pen.ellipse((x - 5, y - 5, x + 5, y + 5), fill=RED)
    buf = io.BytesIO()
    image.save(buf, format='PNG')
    return buf.getvalue(), lines


def y_at(series, x, window=0.08):
    point = min(series['points'], key=lambda item: abs(item['x'] - x))
    if abs(point['x'] - x) > window:
        return None
    return point.get('y')


def near(value, target, ratio=0.04):
    return value is not None and abs(value - target) <= max(0.05, abs(target) * ratio)


def points_of(geometry):
    return [point for series in geometry['series'] for point in series['points']]


def polyline_segments(points):
    return [(x0, y0, x1, y1) for (x0, y0), (x1, y1) in zip(points, points[1:])]


def segment_distance(px, py, segments):
    best = None
    for x0, y0, x1, y1 in segments:
        dx, dy = x1 - x0, y1 - y0
        span = dx * dx + dy * dy
        if span == 0:
            distance = math.hypot(px - x0, py - y0)
        else:
            t = max(0, min(1, ((px - x0) * dx + (py - y0) * dy) / span))
            distance = math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
        best = distance if best is None else min(best, distance)
    return best


def outline(geometry):
    series = []
    for item in geometry.get('series', []):
        head = []
        for point in item.get('points', [])[:4]:
            head.append((round(point.get('x', 0), 3), None if point.get('y') is None else round(point['y'], 3)))
        series.append('%s n=%d bind=%s ambiguous=%s %s' % (
            item.get('id'), len(item.get('points', [])), item.get('axisBinding'),
            item.get('traceAmbiguous'), head))
    return 'status=%s issues=%s series=%s' % (geometry.get('status'), geometry.get('issues'), series)


class TraceRegressionTests(unittest.TestCase):
    def open(self, png, lines):
        geometry = extract_geometry(png, lines)
        self.assertNotIn('geometry-dependency-missing', geometry.get('issues', []), outline(geometry))
        self.assertIn(geometry['status'], ('ready', 'partial'), outline(geometry))
        self.assertTrue(geometry['series'], outline(geometry))
        image, issue = _image_info(png)
        self.assertIsNone(issue)
        return geometry, _geometry_result(geometry, image)

    def assert_on_curves(self, geometry, segments, tolerance=6):
        for point in points_of(geometry):
            distance = segment_distance(point['xPixel'], point['yPixel'], segments)
            self.assertLessEqual(distance, tolerance, outline(geometry))

    def assert_table(self, geometry, adapted):
        self.assertLessEqual(len(adapted['rows']), 500, len(adapted['rows']))
        payload = json.dumps(adapted, allow_nan=False).encode('utf-8')
        self.assertLess(len(payload), JSON_LIMIT, len(payload))
        self.assertEqual(adapted['provenance']['revision'], 'geometry-2')
        self.assertEqual(adapted['columns'][0], 'series')
        ids = [series['id'] for series in geometry['series']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all(isinstance(series_id, str) and series_id for series_id in ids))
        colors = {series['color'] for series in geometry['series']}
        self.assertTrue(set(ids).isdisjoint(colors))
        self.assertEqual([row[0] for row in adapted['rows']], [series['id'] for series in geometry['series'] for _ in series['points']])
        y_cells = [cell for cell in adapted['numericCells'] if cell['column'] == 3]
        points = points_of(geometry)
        self.assertEqual(len(y_cells), len(points))
        for cell, point in zip(y_cells, points):
            self.assertEqual(cell['origin'], 'pixel-calibrated')
            self.assertEqual(cell['sourcePixel'], [point['xPixel'], point['yPixel']])
            self.assertGreater(cell['sourcePixel'][0], 90)
            self.assertLess(cell['sourcePixel'][0], 550)
            self.assertGreater(cell['sourcePixel'][1], 30)
            self.assertLess(cell['sourcePixel'][1], 400)
            self.assertEqual(len(point['pixelInterval']), 2)
            self.assertEqual(cell['value'], point['y'])

    def assert_both_targets(self, geometry, x, targets):
        found = []
        for series in geometry['series']:
            value = y_at(series, x)
            self.assertIsNotNone(value, outline(geometry))
            hits = [target for target in targets if near(value, target)]
            self.assertEqual(len(hits), 1, (x, value, targets, outline(geometry)))
            found.append(hits[0])
        for target in targets:
            self.assertTrue(any(near(value, target) for value in found), (x, target, found, outline(geometry)))

    def test_same_color_parallel_curves_keep_separate_values(self):
        def draw(pen):
            pen.line([(120, 320), (240, 240), (360, 160), (480, 80)], fill=BLUE, width=3)
            pen.line([(120, 360), (240, 280), (360, 200), (480, 120)], fill=BLUE, width=3)

        geometry, adapted = self.open(*chart(draw))
        self.assertEqual(geometry['axes']['left']['scale'], 'log')
        self.assertGreaterEqual(len(geometry['series']), 2, outline(geometry))
        for x, high, low, median in zip((1, 2, 3, 4), HIGH_AT_TICKS, LOW_AT_TICKS, MEDIAN_AT_TICKS):
            self.assert_both_targets(geometry, x, (high, low))
            for series in geometry['series']:
                self.assertFalse(near(y_at(series, x), median, 0.03), outline(geometry))
        self.assert_on_curves(geometry, [
            (120, 320, 480, 80),
            (120, 360, 480, 120),
        ])
        self.assert_table(geometry, adapted)

    def test_off_tick_triangular_peaks_and_valleys_survive(self):
        vertices = [(120, 320), (180, 80), (300, 320), (420, 80), (480, 200)]

        def draw(pen):
            pen.line(vertices, fill=BLUE, width=4)

        geometry, adapted = self.open(*chart(draw))
        # x = pixel/120 on this calibration: peaks at 1.5 and 3.5, valley at 2.5.
        for x, value in ((1.5, 80), (2.5, 10), (3.5, 80)):
            matches = [point for point in points_of(geometry)
                       if abs(point['x'] - x) <= 0.08 and near(point.get('y'), value, 0.06)]
            self.assertTrue(matches, (x, value, outline(geometry)))
        self.assert_on_curves(geometry, polyline_segments(vertices))
        self.assert_table(geometry, adapted)

    def test_same_color_crossing_does_not_invent_midpoints(self):
        segments = [(120, 320, 480, 80), (120, 80, 480, 320)]

        def draw(pen):
            for segment in segments:
                pen.line([(segment[0], segment[1]), (segment[2], segment[3])], fill=BLUE, width=3)

        geometry, adapted = self.open(*chart(draw))
        self.assert_on_curves(geometry, segments)
        for x, targets in ((1, (10, 80)), (4, (10, 80))):
            values = [point['y'] for point in points_of(geometry) if abs(point['x'] - x) <= 0.1]
            for target in targets:
                self.assertTrue(any(near(value, target, 0.06) for value in values), (x, target, values, outline(geometry)))
        self.assert_table(geometry, adapted)

    def test_same_color_touching_does_not_invent_midpoints(self):
        segments = [(120, 220, 480, 220), (120, 340, 300, 220), (300, 220, 480, 340)]

        def draw(pen):
            pen.line([(120, 220), (480, 220)], fill=BLUE, width=3)
            pen.line([(120, 340), (300, 220), (480, 340)], fill=BLUE, width=3)

        geometry, adapted = self.open(*chart(draw))
        self.assert_on_curves(geometry, segments)
        values = [point['y'] for point in points_of(geometry) if abs(point['x'] - 1) <= 0.1]
        for target in (23.784142, 8.408964):
            self.assertTrue(any(near(value, target, 0.06) for value in values), (target, values, outline(geometry)))
        self.assert_table(geometry, adapted)

    def test_dashed_gaps_do_not_invent_points(self):
        def draw(pen):
            pen.line([(120, 320), (295, 320)], fill=BLUE, width=3)
            pen.line([(370, 160), (540, 160)], fill=BLUE, width=3)

        geometry, adapted = self.open(*chart(draw))
        for point in points_of(geometry):
            self.assertFalse(305 < point['xPixel'] < 360, outline(geometry))
        left = [point for point in points_of(geometry) if point['xPixel'] < 300]
        right = [point for point in points_of(geometry) if point['xPixel'] > 370]
        self.assertTrue(any(near(point.get('y'), 10) for point in left), outline(geometry))
        self.assertTrue(any(near(point.get('y'), 40) for point in right), outline(geometry))
        self.assert_table(geometry, adapted)

    def test_black_curve_uses_log_calibration(self):
        png, lines = frame_fixture()
        image = Image.open(io.BytesIO(png))
        pixels = image.load()
        for y in range(image.height):
            for x in range(image.width):
                if pixels[x, y] == (31, 119, 180):
                    pixels[x, y] = (0, 0, 0)
        buf = io.BytesIO()
        image.save(buf, format='PNG')
        geometry, adapted = self.open(buf.getvalue(), lines)
        self.assertEqual(geometry['status'], 'ready', outline(geometry))
        self.assertEqual(geometry['axes']['left']['scale'], 'log')
        self.assertEqual(geometry['series'][0]['color'], '#222222')
        self.assertTrue(near(y_at(geometry['series'][0], 3), 40), outline(geometry))
        self.assert_table(geometry, adapted)

    def test_colored_dual_axes_keep_both_scales(self):
        geometry, adapted = self.open(*frame_fixture(dual=True))
        self.assertEqual(geometry['axes']['left']['scale'], 'log')
        self.assertEqual(geometry['axes']['right']['scale'], 'linear')
        self.assertEqual({series['axisBinding'] for series in geometry['series']}, {'left', 'right'})
        left = next(series for series in geometry['series'] if series['axisBinding'] == 'left')
        right = next(series for series in geometry['series'] if series['axisBinding'] == 'right')
        for x, value in zip((1, 2, 3, 4), HIGH_AT_TICKS):
            self.assertTrue(near(y_at(left, x), value), outline(geometry))
        for x, value in zip((1, 2, 3, 4), (1.875, 4.875, 7.875, 10.875)):
            observed = y_at(right, x)
            self.assertIsNotNone(observed, outline(geometry))
            self.assertAlmostEqual(observed, value, delta=0.2)
        self.assert_table(geometry, adapted)

    def test_different_colors_on_one_log_axis_stay_separate(self):
        def draw(pen):
            pen.line([(120, 320), (240, 240), (360, 160), (480, 80)], fill=BLUE, width=3)
            pen.line([(120, 360), (240, 280), (360, 200), (480, 120)], fill=RED, width=3)

        geometry, adapted = self.open(*chart(draw))
        self.assertGreaterEqual(len(geometry['series']), 2, outline(geometry))
        self.assertEqual({series['axisBinding'] for series in geometry['series']}, {'left'})
        self.assert_both_targets(geometry, 1, (10, LOW_AT_TICKS[0]))
        self.assert_table(geometry, adapted)

    def test_filled_bars_do_not_become_a_line(self):
        geometry = extract_geometry(*frame_fixture(bars=True))
        self.assertNotIn('geometry-dependency-missing', geometry.get('issues', []), outline(geometry))
        self.assertEqual(geometry['status'], 'unavailable', outline(geometry))
        self.assertEqual(geometry['series'], [])

    def test_dense_curves_stay_within_table_budget_and_keep_pixel_provenance(self):
        specs = ((BLUE, 110), (RED, 160), (GREEN, 210), (PURPLE, 260), (ORANGE, 310), (CYAN, 360))

        def draw(pen):
            for color, y in specs:
                pen.line([(120, y), (480, y)], fill=color, width=3)

        geometry, adapted = self.open(*chart(draw))
        self.assertEqual(len(geometry['series']), len(specs), outline(geometry))
        observed = [min(series['points'], key=lambda point: abs(point['xPixel'] - 300))['yPixel']
                    for series in geometry['series']]
        for _, y in specs:
            self.assertTrue(any(abs(pixel - y) <= 4 for pixel in observed), (y, observed, outline(geometry)))
        self.assert_table(geometry, adapted)


if __name__ == '__main__':
    unittest.main()

import hashlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart
import paper_plottracer as plot


def fixture():
    im = Image.new('RGB', (640, 480), 'white')
    d = ImageDraw.Draw(im)
    d.line([(100, 100), (300, 250), (500, 400)], fill='#1f77b4', width=4)
    buf = io.BytesIO(); im.save(buf, format='PNG')
    png = buf.getvalue()
    options = {'imageSha256': hashlib.sha256(png).hexdigest(),
        'calibration': {'x': {'scale': 'linear', 'points': [{'pixel': 100, 'value': 0}, {'pixel': 500, 'value': 10}]},
                        'y': {'scale': 'linear', 'points': [{'pixel': 100, 'value': 0}, {'pixel': 400, 'value': -3}]}},
        'series': [{'id': 'blue', 'color': '#1f77b4', 'name': 'Trial'}], 'plotBbox': [90, 80, 520, 420]}
    return png, options


class PlotTracerTests(unittest.TestCase):
    def test_small_chart_cannot_silently_switch_to_a_table_model(self):
        im = Image.new('RGB', (120, 90), 'white')
        buf = io.BytesIO(); im.save(buf, format='PNG')
        with patch.object(paper_chart, 'default_engine', side_effect=AssertionError('model fallback')):
            result = paper_chart.extract_chart(buf.getvalue())
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['rows'], [])

    def test_negative_curve_keeps_pixels_and_real_units(self):
        png, options = fixture()
        data = paper_chart.extract_chart(png, options={'chartOptions': options})
        self.assertIn(data['status'], ('ready', 'partial'))
        self.assertEqual(data['provenance']['engine'], 'plottracer')
        self.assertEqual(data['provenance']['revision'], plot.UPSTREAM)
        geometry = data['geometry']['provenance']
        self.assertEqual(geometry['engine'], 'plottracer')
        self.assertEqual(geometry['revision'], plot.UPSTREAM)
        self.assertEqual(geometry['method'], 'oss-pixel-calibration')
        self.assertEqual(geometry['wpdCommit'], plot.WPD_COMMIT)
        self.assertEqual(geometry['adapter'], 'falsify-plottracer')
        self.assertEqual(geometry['policy'], 'auto-route-v1')
        self.assertEqual(geometry['bundleSha256'], hashlib.sha256(plot.BUNDLE.read_bytes()).hexdigest())
        self.assertEqual(data['pointKind'], 'curve-sample')
        self.assertGreater(len(data['rows']), 20)
        series = data['geometry']['series'][0]
        point = min(series['points'], key=lambda p: abs(p['x']-5))
        self.assertAlmostEqual(point['y'], -1.5, delta=.05)
        self.assertAlmostEqual(point['xPixel'], 300, delta=4)
        self.assertTrue(all(cell['origin'] == 'pixel-calibrated' for cell in data['numericCells']))
        self.assertTrue(any(cell['value'] < -2.9 for cell in data['numericCells']))
        self.assertEqual(series['traceRoute'], 'wpd-step')
        self.assertTrue(all(p['origin'] == 'pixel-calibrated' for p in series['points']))
        self.assertNotIn('curve-interpolated', {p['origin'] for p in series['points']})

    def test_missing_axes_never_loads_a_table_model(self):
        png, _ = fixture()
        with patch.object(paper_chart, 'default_engine', side_effect=AssertionError('model fallback')):
            result = paper_chart.extract_chart(png)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['rows'], [])
        self.assertTrue({'axis-calibration-required','plottracer-runtime-missing'} & set(result['issues']))

    def test_stale_image_is_rejected(self):
        png, options = fixture()
        options['imageSha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'chart_image_mismatch'):
            plot.trace_geometry(png, manual=options)

    def test_actual_upstream_log_axis_conversion(self):
        _, options = fixture()
        calibration = options['calibration']
        calibration['y'] = {'scale': 'log', 'points': [{'pixel': 100, 'value': 1}, {'pixel': 400, 'value': 100}]}
        core = plot.Core()
        try:
            result = core.convert(calibration, [[300, 250]])
        finally:
            core.close()
        self.assertAlmostEqual(result[0][0], 5)
        self.assertAlmostEqual(result[0][1], 10)

    def test_invalid_log_values_and_duplicate_axes(self):
        _, options = fixture()
        options['calibration']['y']['scale'] = 'log'
        with self.assertRaisesRegex(ValueError, 'digitizer_axis_invalid'):
            plot.validate_options(options)
        _, options = fixture()
        options['calibration']['x']['points'][1]['pixel'] = 100
        with self.assertRaisesRegex(ValueError, 'digitizer_axis_invalid'):
            plot.validate_options(options)

    def test_curve_selection_does_not_accept_an_unbounded_list(self):
        _, options = fixture()
        options['series'] = [{'id': str(i), 'color': '#123456'} for i in range(9)]
        with self.assertRaisesRegex(ValueError, 'chart_series_invalid'):
            plot.validate_options(options)

    def test_upstream_same_color_curves_and_off_tick_peaks(self):
        try:
            import cv2
        except ImportError:
            self.skipTest('Optional automatic OCR/CV preparation is not installed')
        from test_paper_chart_trace_regressions import chart, BLUE
        def curves(d):
            d.line([(120,320),(240,240),(360,160),(480,80)],fill=BLUE,width=3)
            d.line([(120,360),(240,280),(360,200),(480,120)],fill=BLUE,width=3)
        png, lines = chart(curves)
        data = plot.trace_geometry(png, ocr_lines=lines)
        self.assertGreaterEqual(len(data['series']), 2, data['issues'])
        values = [min(s['points'],key=lambda p:abs(p['x']-2))['y'] for s in data['series']]
        self.assertTrue(any(abs(v-20)<1 for v in values), values)
        self.assertTrue(any(abs(v-14.142)<1 for v in values), values)
        def peaks(d):
            d.line([(120,320),(180,80),(300,320),(420,80),(480,200)],fill=BLUE,width=4)
        png, lines = chart(peaks)
        data = plot.trace_geometry(png, ocr_lines=lines)
        points = [p for s in data['series'] for p in s['points']]
        for x, y in [(1.5,80),(2.5,10),(3.5,80)]:
            self.assertTrue(any(abs(p['x']-x)<.08 and abs(p['y']/y-1)<.08 for p in points), (x,y,data['issues']))

    def _manual(self, draw, *, y_scale='linear', y_points=None, color=(31, 119, 180)):
        image = Image.new('RGB', (640, 480), 'white')
        pen = ImageDraw.Draw(image)
        draw(pen)
        buf = io.BytesIO(); image.save(buf, format='PNG')
        png = buf.getvalue()
        y_points = y_points or [{'pixel': 400, 'value': 0}, {'pixel': 80, 'value': 10}]
        options = {'imageSha256': hashlib.sha256(png).hexdigest(),
            'calibration': {'x': {'scale': 'linear', 'points': [{'pixel': 80, 'value': 0}, {'pixel': 560, 'value': 10}]},
                            'y': {'scale': y_scale, 'points': y_points}},
            'series': [{'id': 'ink', 'color': '#%02x%02x%02x' % color, 'name': 'Curve'}],
            'plotBbox': [60, 40, 580, 440]}
        return png, options

    def test_boundary_color_uses_nearby_interior_ink(self):
        scale = 4
        big = Image.new('RGB', (640 * scale, 480 * scale), 'white')
        ImageDraw.Draw(big).line([(80 * scale, 400 * scale), (560 * scale, 80 * scale)], fill=(31, 119, 180), width=4 * scale)
        image = big.resize((640, 480), Image.Resampling.LANCZOS)
        try:
            import numpy as np
        except ImportError:
            self.skipTest('numpy is required to pick an antialiased boundary pixel')
        pixels = np.asarray(image)
        interior = np.array([31, 119, 180])
        distance = np.sqrt(((pixels.astype(int) - interior) ** 2).sum(axis=2))
        chosen = None
        for y, x in np.argwhere((distance > 28) & (distance < 85) & (pixels[:, :, 0] < 230)):
            if 70 <= x <= 560 and 70 <= y <= 420:
                chosen = (int(x), int(y), [int(v) for v in pixels[y, x]])
                break
        self.assertIsNotNone(chosen)
        png_image = image
        buf = io.BytesIO(); png_image.save(buf, format='PNG'); png = buf.getvalue()
        color = '#%02x%02x%02x' % tuple(chosen[2])
        options = {'imageSha256': hashlib.sha256(png).hexdigest(),
            'calibration': {'x': {'scale': 'linear', 'points': [{'pixel': 80, 'value': 0}, {'pixel': 560, 'value': 10}]},
                            'y': {'scale': 'linear', 'points': [{'pixel': 400, 'value': 0}, {'pixel': 80, 'value': 10}]}},
            'series': [{'id': 'ink', 'color': color, 'name': 'Boundary'}], 'plotBbox': [60, 40, 580, 440]}
        data = plot.trace_geometry(png, manual=options)
        series = data['series'][0]
        effective = [int(series['effectiveColor'][i:i+2], 16) for i in (1, 3, 5)]
        self.assertLess(sum(abs(a - b) for a, b in zip(effective, (31, 119, 180))), 36, series['effectiveColor'])
        self.assertNotEqual(series['requestedColor'].lower(), series['effectiveColor'].lower())
        self.assertEqual(series['color'].lower(), series['effectiveColor'].lower())
        xs = [p['xPixel'] for p in series['points']]
        reversals = sum(b < a - .5 for a, b in zip(xs, xs[1:]))
        self.assertLess(reversals, max(2, len(xs) * .05), (series['traceRoute'], reversals, len(xs)))
        self.assertNotEqual(series['traceRoute'], 'find-lines')

    def test_same_color_crossing_is_not_averaged(self):
        def draw(pen):
            pen.line([(80, 400), (560, 80)], fill=(31, 119, 180), width=4)
            pen.line([(80, 80), (560, 400)], fill=(31, 119, 180), width=4)
        png, options = self._manual(draw)
        data = plot.trace_geometry(png, manual=options)
        self.assertGreaterEqual(len(data['series']), 2, [s.get('traceRoute') for s in data['series']])
        self.assertTrue(all(s['traceRoute'] == 'find-lines' for s in data['series']))
        ends = []
        for series in data['series']:
            ordered = sorted(series['points'], key=lambda p: p['x'])
            ends.append((ordered[0]['y'], ordered[-1]['y']))
        self.assertTrue(any(abs(a) < .6 and abs(b - 10) < .6 for a, b in ends), ends)
        self.assertTrue(any(abs(a - 10) < .6 and abs(b) < .6 for a, b in ends), ends)
        self.assertFalse(any(abs(a - 5) < .4 and abs(b - 5) < .4 for a, b in ends), ends)

    def test_loop_is_not_sorted_into_a_function(self):
        def draw(pen):
            pen.ellipse((180, 120, 460, 360), outline=(31, 119, 180), width=4)
        png, options = self._manual(draw)
        data = plot.trace_geometry(png, manual=options)
        self.assertTrue(data['series'], data['issues'])
        series = max(data['series'], key=lambda s: len(s['points']))
        self.assertEqual(series['traceRoute'], 'find-lines')
        xs = [p['xPixel'] for p in series['points']]
        self.assertTrue(any(b < a - 1 for a, b in zip(xs, xs[1:])), series['traceRoute'])
        self.assertTrue(series.get('traceClosed') or any(p['role'] == 'measured' for p in series['points']))

    def test_dashed_linear_curve_keeps_gaps_and_skips_log_interpolation(self):
        def draw(pen):
            for start in range(80, 540, 48):
                pen.line([(start, 240), (start + 18, 240)], fill=(31, 119, 180), width=4)
        png, options = self._manual(draw)
        data = plot.trace_geometry(png, manual=options)
        series = data['series'][0]
        self.assertIn(series['traceRoute'], ('wpd-step', 'column'))
        self.assertNotEqual(series['traceRoute'], 'wpd-xstep')
        xs = [p['xPixel'] for p in series['points']]
        self.assertGreater(max(b - a for a, b in zip(xs, xs[1:])), 18)
        interpolated = [p for p in series['points'] if p['origin'] == 'curve-interpolated']
        self.assertLess(len(interpolated) / len(series['points']), .15)

    def test_explicit_log_axis_uses_xstep_not_step(self):
        def draw(pen):
            pen.line([(80, 400), (560, 80)], fill=(31, 119, 180), width=4)
        png, options = self._manual(draw, y_scale='log', y_points=[{'pixel': 400, 'value': 1}, {'pixel': 80, 'value': 100}])
        data = plot.trace_geometry(png, manual=options)
        series = data['series'][0]
        self.assertEqual(series['traceRoute'], 'wpd-xstep')
        self.assertEqual(series['traceAlgorithm'], 'XStepWithInterpolationAlgo')
        point = min(series['points'], key=lambda p: abs(p['x'] - 5))
        self.assertAlmostEqual(point['y'], 10, delta=2.5)
        self.assertTrue(all(p['origin'] == 'curve-interpolated' for p in series['points']))
        self.assertNotIn('measured', {p['role'] for p in series['points']})
        self.assertTrue(any(p.get('inkSupport') for p in series['points']))
        self.assertTrue(all(p['role'] in ('ink-supported', 'bridged') for p in series['points']))

    def test_narrow_peak_survives_sampling(self):
        def draw(pen):
            pen.line([(80, 360), (300, 360), (320, 80), (340, 360), (560, 360)], fill=(31, 119, 180), width=4)
        png, options = self._manual(draw)
        data = plot.trace_geometry(png, manual=options)
        points = [p for s in data['series'] for p in s['points']]
        self.assertTrue(any(abs(p['x'] - 5) < .35 and p['y'] > 8 for p in points),
                        [(round(p['x'], 2), round(p['y'], 2), s['traceRoute']) for s in data['series'] for p in s['points'][::max(1, len(s['points']) // 8)]])

    def test_error_bars_stay_on_the_curve(self):
        def draw(pen):
            pen.line([(80, 400), (560, 80)], fill=(31, 119, 180), width=4)
            for x in (200, 320, 440):
                pen.line([(x, 180), (x, 300)], fill=(31, 119, 180), width=3)
                pen.line([(x - 8, 180), (x + 8, 180)], fill=(31, 119, 180), width=3)
                pen.line([(x - 8, 300), (x + 8, 300)], fill=(31, 119, 180), width=3)
        png, options = self._manual(draw)
        data = plot.trace_geometry(png, manual=options)
        self.assertTrue(data['series'], data['issues'])
        self.assertTrue(all(s['traceRoute'] == 'find-lines' for s in data['series']), [s['traceRoute'] for s in data['series']])
        main = max(data['series'], key=lambda s: max(p['xPixel'] for p in s['points']) - min(p['xPixel'] for p in s['points']))
        near = [p for p in main['points'] if abs(p['x'] - 5) < .35]
        self.assertTrue(near, data['issues'])
        self.assertTrue(all(abs(p['y'] - 5) < 1.2 for p in near), [(round(p['y'], 2), p['yPixel']) for p in near])

    def test_short_fork_keeps_both_branches(self):
        def draw(pen):
            pen.line([(80, 240), (560, 240)], fill=(31, 119, 180), width=4)
            pen.line([(540, 240), (560, 120)], fill=(31, 119, 180), width=4)
        png, options = self._manual(draw)
        data = plot.trace_geometry(png, manual=options)
        self.assertTrue(data['series'], data['issues'])
        routes = [s.get('traceRoute') for s in data['series']]
        self.assertIn('find-lines', routes, routes)
        flat = [s for s in data['series'] if s['points'] and all(abs(p['y'] - 5) < .75 for p in s['points'])]
        self.assertTrue(flat, [(round(p['x'], 2), round(p['y'], 2)) for s in data['series'] for p in s['points'][:4]])
        self.assertTrue(any(p['x'] < 1 for s in flat for p in s['points']))
        self.assertTrue(any(p['x'] > 9.5 and abs(p['y'] - 5) < .75 for s in flat for p in s['points']))
        self.assertTrue(any(p['x'] > 9.5 and p['y'] > 7.5 for s in data['series'] for p in s['points']))
        for series in data['series']:
            jumps = sum(1 for a, b in zip(series['points'], series['points'][1:])
                        if abs(b['xPixel'] - a['xPixel']) <= 1.5 and abs(b['yPixel'] - a['yPixel']) > 14)
            self.assertEqual(jumps, 0, series['traceRoute'])

    def test_one_asymmetric_error_bar_stays_on_the_curve(self):
        def draw(pen):
            pen.line([(80, 400), (560, 80)], fill=(31, 119, 180), width=4)
            pen.line([(320, 90), (320, 250)], fill=(31, 119, 180), width=3)
        png, options = self._manual(draw)
        data = plot.trace_geometry(png, manual=options)
        self.assertTrue(data['series'], data['issues'])
        self.assertTrue(all(s['traceRoute'] == 'find-lines' for s in data['series']),
                        [(s['traceRoute'], s.get('traceDiagnostics')) for s in data['series']])
        main = max(data['series'], key=lambda s: max(p['xPixel'] for p in s['points']) - min(p['xPixel'] for p in s['points']))
        self.assertEqual(main['traceRoute'], 'find-lines')
        near = [p for p in main['points'] if abs(p['x'] - 5) < .35]
        self.assertTrue(near, data['issues'])
        self.assertTrue(all(abs(p['y'] - 5) < 1.2 for p in near), [(round(p['y'], 2), round(p['yPixel'], 1)) for p in near])


if __name__ == '__main__':
    unittest.main()

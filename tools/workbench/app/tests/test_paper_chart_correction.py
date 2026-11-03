"""Black-box chart-correction checks for PlotTracer Core and manual trace_geometry.

Synthetic fixtures are generated here. Native strokes are read only through
paper_chart_vectors.prefer_native_paths. A private benchmark directory is used
only when it is discovered beside this checkout; the public cases do not require it.
Product code is not modified. Metrics and same-region overlays go to the
registered accuracy-v2/implementation-qa folder when that folder's parent exists.
"""
import hashlib
import inspect
import io
import json
import math
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_vectors
import paper_plottracer as plot

BLUE = '#1f77b4'
HALO = '#5f9eca'
JSON_LIMIT = 2 * 1024 * 1024
RESULTS = []


def benchmark_root():
    for parent in Path(__file__).resolve().parents:
        candidate = parent / 'chart-oss-benchmark-20261103' / 'accuracy-v2'
        if candidate.is_dir():
            return candidate
    return None


def qa_dir():
    root = benchmark_root()
    if root is None:
        return None
    path = root / 'implementation-qa'
    path.mkdir(parents=True, exist_ok=True)
    (path / 'images').mkdir(parents=True, exist_ok=True)
    return path


def rgb_of(color):
    return [int(color[i:i + 2], 16) for i in (1, 3, 5)]


def png_of(draw, size=(640, 480)):
    image = Image.new('RGB', size, 'white')
    draw(ImageDraw.Draw(image))
    buf = io.BytesIO()
    image.save(buf, format='PNG')
    raw = buf.getvalue()
    return raw, hashlib.sha256(raw).hexdigest()


def manual(png_sha, box, color, x_points, y_points, x_scale='linear', y_scale='linear', series_id='series'):
    return {
        'imageSha256': png_sha,
        'calibration': {
            'x': {'scale': x_scale, 'points': [{'pixel': px, 'value': value} for px, value in x_points]},
            'y': {'scale': y_scale, 'points': [{'pixel': py, 'value': value} for py, value in y_points]},
        },
        'series': [{'id': series_id, 'color': color}],
        'plotBbox': list(box),
    }


def as_xy(point):
    if isinstance(point, dict):
        return (float(point.get('x', point.get('xPixel'))), float(point.get('y', point.get('yPixel'))))
    return (float(point[0]), float(point[1]))


def core_polylines(raw):
    polylines = []
    details = []
    for series in raw.get('series', []):
        for line in series.get('lines') or []:
            points = [as_xy(point) for point in line.get('points') or []]
            if len(points) >= 2:
                polylines.append(points)
                details.append(line)
    return polylines, details


def geometry_polylines(geometry):
    polylines = []
    for series in geometry.get('series', []):
        points = [(float(point['xPixel']), float(point['yPixel'])) for point in series.get('points') or [] if 'xPixel' in point]
        if len(points) >= 2:
            polylines.append(points)
    return polylines


def segments(poly):
    return list(zip(poly, poly[1:]))


def segment_distance(point, start, end):
    px, py = point
    x0, y0 = start
    x1, y1 = end
    dx, dy = x1 - x0, y1 - y0
    span = dx * dx + dy * dy
    if span == 0:
        return math.hypot(px - x0, py - y0)
    t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / span))
    return math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))


def nearest_distance(point, polylines):
    best = None
    for poly in polylines:
        pairs = segments(poly)
        if not pairs and poly:
            best_one = math.hypot(point[0] - poly[0][0], point[1] - poly[0][1])
            best = best_one if best is None else min(best, best_one)
        for start, end in pairs:
            distance = segment_distance(point, start, end)
            best = distance if best is None else min(best, distance)
    return 1e9 if best is None else best


def resample(poly, step):
    if len(poly) < 2:
        return list(poly)
    out = []
    for start, end in segments(poly):
        length = math.hypot(end[0] - start[0], end[1] - start[1])
        count = max(1, int(math.ceil(length / step)))
        for index in range(count):
            t = index / count
            out.append((start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t))
    out.append(poly[-1])
    return out


def thin(samples, limit):
    if len(samples) <= limit:
        return samples
    stride = len(samples) / limit
    return [samples[min(len(samples) - 1, int(index * stride))] for index in range(limit)]


def false_ratio(polylines, truth, tolerance=2.0, step=0.75, limit=500):
    samples = thin([point for poly in polylines for point in resample(poly, step)], limit)
    if not samples:
        return 1.0
    bad = sum(1 for point in samples if nearest_distance(point, truth) > tolerance)
    return bad / len(samples)


def coverage(truth_poly, polylines, tolerance=2.0, step=1.0, limit=400):
    samples = thin(resample(truth_poly, step), limit)
    if not samples:
        return 0.0
    hits = sum(1 for point in samples if nearest_distance(point, polylines) <= tolerance)
    return hits / len(samples)


def reversals(poly, minimum=0.75):
    count = 0
    previous = None
    for start, end in segments(poly):
        dx = end[0] - start[0]
        if abs(dx) < minimum:
            continue
        sign = 1 if dx > 0 else -1
        if previous is not None and sign != previous:
            count += 1
        previous = sign
    return count


def walk_nonfinite(value, path='$'):
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            found.extend(walk_nonfinite(item, '%s.%s' % (path, key)))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(walk_nonfinite(item, '%s[%d]' % (path, index)))
    elif isinstance(value, float) and not math.isfinite(value):
        found.append(path)
    return found


def bounded(result):
    problems = walk_nonfinite(result)
    try:
        payload = json.dumps(result, allow_nan=False).encode('utf-8')
    except (TypeError, ValueError) as exc:
        return ['json: %s' % exc]
    if len(payload) >= JSON_LIMIT:
        problems.append('json %d bytes' % len(payload))
    return problems


def save_overlay(name, png, polylines, box):
    folder = qa_dir()
    if folder is None:
        return None
    image = Image.open(io.BytesIO(png)).convert('RGB')
    crop = tuple(int(v) for v in box)
    image.crop(crop).save(folder / 'images' / ('%s-before.png' % name))
    pen = ImageDraw.Draw(image)
    for poly in polylines:
        if len(poly) >= 2:
            pen.line([(float(x), float(y)) for x, y in poly], fill=(255, 0, 255), width=1)
    image.crop(crop).save(folder / 'images' / ('%s-after.png' % name))
    return str(folder / 'images' / ('%s-after.png' % name))


def remember(name, metrics, problems):
    RESULTS.append({'name': name, 'ok': not problems, 'problems': list(problems), **metrics})


def explicit_unresolved(result):
    for series in result.get('series') or []:
        if series.get('traceAmbiguous') or series.get('unresolvedEvidence'):
            return True
    return any('unresolved' in str(issue).lower() for issue in result.get('issues') or [])


def color_binding(series, requested):
    problems = []
    if str(series.get('requestedColor', '')).lower() != requested:
        problems.append('requestedColor %s for %s' % (series.get('requestedColor'), requested))
    effective = series.get('effectiveColor')
    if not effective or str(series.get('color', '')).lower() != str(effective).lower():
        problems.append('series color %s is not effectiveColor %s' % (series.get('color'), effective))
    return problems


def cubic_point(p0, p1, p2, p3, t):
    weight = 1 - t
    def mix(index):
        return ((weight ** 3) * p0[index] + 3 * (weight ** 2) * t * p1[index]
                + 3 * weight * (t ** 2) * p2[index] + (t ** 3) * p3[index])
    return (mix(0), mix(1))


def dense_curve(curves, count=200):
    samples = []
    for controls in curves:
        for step in range(count + 1):
            samples.append(cubic_point(*controls, step / count))
    return samples


def trace_manual(png, options):
    accepted = {name for name in inspect.signature(plot.trace_geometry).parameters if name != 'png_bytes'}
    kwargs = {'manual': options}
    return plot.trace_geometry(png, **{key: value for key, value in kwargs.items() if key in accepted})


class CoreLineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.core = plot.Core()

    @classmethod
    def tearDownClass(cls):
        cls.core.close()

    def trace(self, png, color, box):
        image = Image.open(io.BytesIO(png)).convert('RGBA')
        width, height = image.size
        region = {'x': box[0], 'y': box[1], 'width': box[2] - box[0], 'height': box[3] - box[1]}
        return self.core.trace(image.tobytes(), width, height, [{'id': 's', 'rgb': rgb_of(color)}], region, find_lines=True)

    def test_same_color_crossing_keeps_both_branches(self):
        def draw(pen):
            pen.line([(80, 80), (560, 400)], fill=BLUE, width=4)
            pen.line([(80, 400), (560, 80)], fill=BLUE, width=4)

        png, _ = png_of(draw)
        truth = [[(80, 80), (560, 400)], [(80, 400), (560, 80)]]
        raw = self.trace(png, BLUE, (60, 60, 580, 420))
        polylines, details = core_polylines(raw)
        ratios = [coverage(line, polylines, tolerance=6) for line in truth]
        metric = {
            'lines': len(polylines),
            'coverage': [round(item, 4) for item in ratios],
            'falseRatio': round(false_ratio(polylines, truth, tolerance=6), 4),
            'roles': sorted({role for line in details for role in line.get('roles') or []}),
            'places': sum(len(series.get('places') or []) for series in raw.get('series', [])),
        }
        problems = []
        if metric['lines'] < 2:
            problems.append('expected two crossing lines, got %d' % metric['lines'])
        if any(item < 0.7 for item in ratios):
            problems.append('branch coverage %s' % metric['coverage'])
        if metric['falseRatio'] > 0.2:
            problems.append('false segment ratio %.3f' % metric['falseRatio'])
        if 'measured' not in metric['roles']:
            problems.append('measured role missing')
        save_overlay('core-crossing', png, polylines, (60, 60, 580, 420))
        remember('core-crossing', metric, problems)
        self.assertFalse(problems, problems)

    def test_loop_is_not_collapsed_to_one_value(self):
        def draw(pen):
            pen.ellipse((230, 150, 410, 330), outline=BLUE, width=4)

        png, _ = png_of(draw)
        truth = [[(320 + 90 * math.cos(t), 240 + 90 * math.sin(t)) for t in [index * math.tau / 80 for index in range(81)]]]
        raw = self.trace(png, BLUE, (180, 100, 470, 390))
        polylines, _ = core_polylines(raw)
        samples = [point for poly in polylines for point in poly]
        paired = False
        for x in range(250, 390, 10):
            ys = [y for px, y in samples if abs(px - x) <= 8]
            if ys and max(ys) - min(ys) > 50:
                paired = True
                break
        metric = {
            'lines': len(polylines),
            'coverage': round(coverage(truth[0], polylines, tolerance=7), 4),
            'falseRatio': round(false_ratio(polylines, truth, tolerance=7), 4),
            'xDecreases': any(reversals(poly) >= 1 or any(b[0] < a[0] - 0.75 for a, b in segments(poly)) for poly in polylines),
            'twoY': paired,
        }
        problems = []
        if metric['coverage'] < 0.7:
            problems.append('loop coverage %.3f' % metric['coverage'])
        if metric['falseRatio'] > 0.25:
            problems.append('loop false ratio %.3f' % metric['falseRatio'])
        if not metric['twoY']:
            problems.append('loop collapsed toward a single y per x')
        if not metric['xDecreases']:
            problems.append('loop x never decreases')
        save_overlay('core-loop', png, polylines, (180, 100, 470, 390))
        remember('core-loop', metric, problems)
        self.assertFalse(problems, problems)

    def test_thin_dashed_line_marks_gap_bridges(self):
        dashes = []
        x = 90
        while x < 540:
            dashes.append([(x, 240), (min(x + 16, 540), 240)])
            x += 34

        def draw(pen):
            for start, end in dashes:
                pen.line([start, end], fill=BLUE, width=3)

        png, _ = png_of(draw)
        raw = self.trace(png, BLUE, (70, 180, 570, 300))
        polylines, details = core_polylines(raw)
        points = [point for poly in polylines for point in poly]
        gap_points = [point for point in points if nearest_distance(point, dashes) > 5]
        roles = {role for line in details for role in line.get('roles') or []}
        gaps = sum(len(line.get('gaps') or []) for line in details)
        metric = {
            'lines': len(polylines),
            'dashCoverage': round(sum(coverage(dash, polylines, tolerance=6, step=2) for dash in dashes) / len(dashes), 4),
            'gapPoints': len(gap_points),
            'roles': sorted(roles),
            'gaps': gaps,
        }
        problems = []
        if metric['dashCoverage'] < 0.6:
            problems.append('dashed coverage %.3f' % metric['dashCoverage'])
        if gap_points and 'bridged' not in roles and gaps == 0:
            problems.append('points inside dash gaps are not identified as bridges')
        save_overlay('core-dashed', png, polylines, (70, 180, 570, 300))
        remember('core-dashed', metric, problems)
        self.assertFalse(problems, problems)

    def test_errorbar_main_line_stays_separate(self):
        def draw(pen):
            pen.line([(80, 220), (560, 220)], fill=BLUE, width=3)
            for x in (180, 320, 460):
                pen.line([(x, 150), (x, 290)], fill=BLUE, width=3)
                pen.line([(x - 8, 150), (x + 8, 150)], fill=BLUE, width=3)
                pen.line([(x - 8, 290), (x + 8, 290)], fill=BLUE, width=3)

        png, _ = png_of(draw)
        raw = self.trace(png, BLUE, (60, 120, 580, 330))
        polylines, _ = core_polylines(raw)
        main = max(polylines, key=lambda poly: max(p[0] for p in poly) - min(p[0] for p in poly))
        ys = [point[1] for point in main]
        median = sorted(abs(y - 220) for y in ys)[len(ys) // 2]
        tips = [(180, 150), (320, 150), (460, 290)]
        separate = []
        for tip in tips:
            hosts = [poly for poly in polylines if poly is not main and nearest_distance(tip, [poly]) <= 8]
            separate.append(bool(hosts))
        metric = {
            'lines': len(polylines),
            'mainMedianPx': round(median, 3),
            'mainMaxPx': round(max(abs(y - 220) for y in ys), 3),
            'whiskerSeparate': separate,
        }
        problems = []
        if median > 8 or metric['mainMaxPx'] > 18:
            problems.append('main line left the horizontal stroke: %s' % metric)
        if not any(separate):
            problems.append('error-bar strokes were not returned apart from the main line')
        save_overlay('core-errorbar', png, polylines, (60, 120, 580, 330))
        remember('core-errorbar', metric, problems)
        self.assertFalse(problems, problems)

    def test_sharp_peak_is_kept(self):
        truth = [[(120, 320), (320, 80), (520, 320)]]

        def draw(pen):
            pen.line(truth[0], fill=BLUE, width=4)

        png, _ = png_of(draw)
        raw = self.trace(png, BLUE, (80, 40, 560, 380))
        polylines, _ = core_polylines(raw)
        distance = min(nearest_distance((320, 80), [poly]) for poly in polylines)
        metric = {'vertexPx': round(distance, 3), 'falseRatio': round(false_ratio(polylines, truth, tolerance=6), 4)}
        problems = []
        if distance > 8:
            problems.append('peak vertex %.2f px away' % distance)
        if metric['falseRatio'] > 0.2:
            problems.append('peak false ratio %.3f' % metric['falseRatio'])
        save_overlay('core-peak', png, polylines, (80, 40, 560, 380))
        remember('core-peak', metric, problems)
        self.assertFalse(problems, problems)


class ManualCorrectionTests(unittest.TestCase):
    def geometry(self, png, sha, box, color, x_points, y_points, x_scale='linear', y_scale='linear'):
        options = manual(sha, box, color, x_points, y_points, x_scale, y_scale)
        result = trace_manual(png, options)
        self.assertIn(result['status'], ('ready', 'partial'), result.get('issues'))
        self.assertTrue(result['series'], result.get('issues'))
        return result

    def test_same_color_crossing_is_not_averaged(self):
        def draw(pen):
            pen.line([(80, 80), (560, 400)], fill=BLUE, width=4)
            pen.line([(80, 400), (560, 80)], fill=BLUE, width=4)

        png, sha = png_of(draw)
        box = (60, 60, 580, 420)
        truth = [[(80, 80), (560, 400)], [(80, 400), (560, 80)]]
        result = self.geometry(png, sha, box, BLUE, [(80, 0), (560, 10)], [(80, 10), (400, 0)])
        polylines = geometry_polylines(result)
        ratios = [coverage(line, polylines, tolerance=6) for line in truth]
        roles = sorted({role for series in result['series'] for role in series.get('upstreamRoles') or []})
        routes = sorted({series.get('traceRoute') for series in result['series']})
        metric = {
            'series': len(result['series']),
            'coverage': [round(item, 4) for item in ratios],
            'falseRatio': round(false_ratio(polylines, truth, tolerance=6), 4),
            'roles': roles,
            'routes': routes,
            'issues': result.get('issues'),
        }
        problems = bounded(result)
        if routes != ['find-lines']:
            problems.append('manual crossing route %s' % routes)
        if len(polylines) < 2:
            problems.append('manual crossing returned %d polyline for two branches' % len(polylines))
        if any(item < 0.7 for item in ratios):
            problems.append('manual crossing dropped a branch: %s' % metric['coverage'])
        if metric['falseRatio'] > 0.05:
            problems.append('manual crossing bridged or averaged branches: %.3f' % metric['falseRatio'])
        if 'measured' not in roles:
            problems.append('manual path dropped measured/bridged roles')
        save_overlay('manual-crossing', png, polylines, box)
        remember('manual-crossing', metric, problems)
        self.assertFalse(problems, problems)

    def test_loop_keeps_two_y_values(self):
        def draw(pen):
            pen.ellipse((230, 150, 410, 330), outline=BLUE, width=4)

        png, sha = png_of(draw)
        box = (180, 100, 470, 390)
        truth = [[(320 + 90 * math.cos(t), 240 + 90 * math.sin(t)) for t in [index * math.tau / 80 for index in range(81)]]]
        result = self.geometry(png, sha, box, BLUE, [(230, 0), (410, 10)], [(150, 10), (330, 0)])
        polylines = geometry_polylines(result)
        samples = [point for poly in polylines for point in poly]
        paired = False
        for x in range(250, 390, 10):
            ys = [y for px, y in samples if abs(px - x) <= 8]
            if ys and max(ys) - min(ys) > 50:
                paired = True
                break
        routes = sorted({series.get('traceRoute') for series in result['series']})
        metric = {
            'coverage': round(coverage(truth[0], polylines, tolerance=7), 4),
            'falseRatio': round(false_ratio(polylines, truth, tolerance=7), 4),
            'twoY': paired,
            'xDecreases': any(any(b[0] < a[0] - 0.75 for a, b in segments(poly)) for poly in polylines),
            'routes': routes,
        }
        problems = bounded(result)
        if routes != ['find-lines']:
            problems.append('manual loop route %s' % routes)
        if metric['coverage'] < 0.7 or metric['falseRatio'] > 0.25 or not paired or not metric['xDecreases']:
            problems.append('manual loop topology %s' % metric)
        save_overlay('manual-loop', png, polylines, box)
        remember('manual-loop', metric, problems)
        self.assertFalse(problems, problems)

    def test_dashed_gap_points_are_identified(self):
        dashes = []
        x = 90
        while x < 540:
            dashes.append([(x, 240), (min(x + 16, 540), 240)])
            x += 34

        def draw(pen):
            for start, end in dashes:
                pen.line([start, end], fill=BLUE, width=3)

        png, sha = png_of(draw)
        box = (70, 180, 570, 300)
        result = self.geometry(png, sha, box, BLUE, [(90, 0), (540, 8)], [(200, 10), (280, 1)], y_scale='log')
        polylines = geometry_polylines(result)
        gap_points = []
        unmarked = 0
        for series in result['series']:
            for point in series.get('points') or []:
                xy = (float(point['xPixel']), float(point['yPixel']))
                if nearest_distance(xy, dashes) <= 5:
                    continue
                gap_points.append(xy)
                if point.get('role') != 'bridged' and point.get('origin') != 'curve-interpolated':
                    unmarked += 1
        gap_segments = 0
        for poly in polylines:
            for start, end in segments(poly):
                mid = ((start[0] + end[0]) / 2, (start[1] + end[1]) / 2)
                if nearest_distance(mid, dashes) > 5:
                    gap_segments += 1
        roles = {role for series in result['series'] for role in series.get('upstreamRoles') or []}
        gaps = sum(len(series.get('gapsPixels') or []) for series in result['series'])
        metric = {
            'dashCoverage': round(sum(coverage(dash, polylines, tolerance=6, step=2) for dash in dashes) / len(dashes), 4),
            'gapPoints': len(gap_points),
            'gapSegments': gap_segments,
            'roles': sorted(roles),
            'gaps': gaps,
            'unmarkedGapPoints': unmarked,
            'routes': sorted({series.get('traceRoute') for series in result['series']}),
        }
        problems = bounded(result)
        if metric['dashCoverage'] < 0.55:
            problems.append('manual dashed coverage %.3f' % metric['dashCoverage'])
        if unmarked:
            problems.append('dash gap points lack an interpolation role: %s' % metric)
        elif (gap_points or gap_segments) and 'bridged' not in roles and gaps == 0:
            problems.append('dash gaps were connected without a bridge/interpolation mark: %s' % metric)
        save_overlay('manual-dashed', png, polylines, box)
        remember('manual-dashed-log', metric, problems)
        self.assertFalse(problems, problems)

    def test_errorbar_preserves_main_line(self):
        def draw(pen):
            pen.line([(80, 220), (560, 220)], fill=BLUE, width=3)
            for x in (180, 320, 460):
                pen.line([(x, 150), (x, 290)], fill=BLUE, width=3)
                pen.line([(x - 8, 150), (x + 8, 150)], fill=BLUE, width=3)
                pen.line([(x - 8, 290), (x + 8, 290)], fill=BLUE, width=3)

        png, sha = png_of(draw)
        box = (60, 120, 580, 330)
        result = self.geometry(png, sha, box, BLUE, [(80, 0), (560, 10)], [(150, 4), (290, -2)])
        polylines = geometry_polylines(result)
        main = max(polylines, key=lambda poly: max(p[0] for p in poly) - min(p[0] for p in poly))
        deviations = sorted(abs(y - 220) for _, y in main)
        median = deviations[len(deviations) // 2]
        tips = [(180, 150), (320, 290), (460, 150)]
        separate = [any(poly is not main and nearest_distance(tip, [poly]) <= 8 for poly in polylines) for tip in tips]
        metric = {
            'mainMedianPx': round(median, 3),
            'mainMaxPx': round(deviations[-1], 3),
            'whiskerSeparate': separate,
            'polylines': len(polylines),
            'routes': sorted({series.get('traceRoute') for series in result['series']}),
        }
        problems = bounded(result)
        if median > 8 or deviations[-1] > 18:
            problems.append('manual error bars pulled the main line: %s' % metric)
        if not any(separate):
            problems.append('manual path did not keep error-bar strokes apart from the main line')
        save_overlay('manual-errorbar', png, polylines, box)
        remember('manual-errorbar', metric, problems)
        self.assertFalse(problems, problems)

    def test_sharp_peak_small_crop_and_axis_directions(self):
        def draw(pen):
            pen.line([(120, 320), (320, 80), (520, 320)], fill=BLUE, width=4)
            pen.line([(140, 420), (500, 450)], fill=BLUE, width=4)

        png, sha = png_of(draw)
        box = (90, 40, 550, 360)
        result = self.geometry(png, sha, box, BLUE, [(520, 0), (120, 10)], [(80, -3), (320, 6)])
        polylines = geometry_polylines(result)
        points = [point for poly in polylines for point in poly]
        vertex = min(math.hypot(x - 320, y - 80) for x, y in points)
        outside = [point for point in points if point[1] > 380]
        mid = min(result['series'][0]['points'], key=lambda point: abs(point['xPixel'] - 320))
        problems = bounded(result)
        metric = {'vertexPx': round(vertex, 3), 'outside': len(outside), 'midX': mid['x'], 'midY': mid['y']}
        if vertex > 10:
            problems.append('sharp peak lost: %.2f px' % vertex)
        if outside:
            problems.append('small crop included %d points from the stroke outside plotBbox' % len(outside))
        if not 4 < mid['x'] < 6:
            problems.append('reversed x calibration mapped pixel 320 to %s' % mid['x'])
        if not mid['y'] < -1:
            problems.append('negative y calibration mapped the peak to %s' % mid['y'])
        save_overlay('manual-peak-crop', png, polylines, box)
        remember('manual-peak-crop-axes', metric, problems)
        self.assertFalse(problems, problems)

    def test_log_calibration_is_not_treated_as_linear(self):
        def draw(pen):
            pen.line([(120, 250), (520, 250)], fill=BLUE, width=3)

        png, sha = png_of(draw)
        box = (80, 80, 560, 420)
        result = self.geometry(
            png, sha, box, BLUE,
            [(120, 0), (520, 4)],
            [(100, 1), (400, 1000)],
            y_scale='log')
        point = min(result['series'][0]['points'], key=lambda item: abs(item['xPixel'] - 320))
        expected = 10 ** 1.5
        linear = 1 + (250 - 100) / 300 * 999
        route = result['series'][0].get('traceRoute')
        metric = {'y': point['y'], 'expectedLog': expected, 'linearTrap': linear, 'route': route}
        problems = bounded(result)
        if route != 'wpd-xstep':
            problems.append('log curve used %s instead of wpd-xstep' % route)
        if abs(point['y'] - expected) / expected > 0.2:
            problems.append('log sample %s is not near %s' % (point['y'], expected))
        if abs(point['y'] - expected) >= abs(point['y'] - linear):
            problems.append('log sample is closer to the linear trap than to the log value')
        remember('manual-log', metric, problems)
        self.assertFalse(problems, problems)

    def test_anchor_shift_moves_values_without_moving_pixels_or_forcing_y_equals_x(self):
        def draw(pen):
            pen.line([(100, 160), (500, 360)], fill=BLUE, width=4)

        png, sha = png_of(draw)
        box = (70, 80, 540, 420)
        true = self.geometry(png, sha, box, BLUE, [(100, 0), (500, 10)], [(160, 1), (360, 7)])
        shifted = self.geometry(png, sha, box, BLUE, [(80, 0), (480, 10)], [(140, 1), (340, 7)])
        true_px = [(point['xPixel'], point['yPixel']) for point in true['series'][0]['points']]
        shifted_px = [(point['xPixel'], point['yPixel']) for point in shifted['series'][0]['points']]
        forward = sorted(nearest_distance(point, [shifted_px]) for point in thin(true_px, 120))
        backward = sorted(nearest_distance(point, [true_px]) for point in thin(shifted_px, 120))
        pixel_median = (forward[len(forward) // 2] + backward[len(backward) // 2]) / 2
        true_mid = min(true['series'][0]['points'], key=lambda point: abs(point['xPixel'] - 300))
        shifted_mid = min(shifted['series'][0]['points'], key=lambda point: abs(point['xPixel'] - 300))
        metric = {
            'pixelMedian': round(pixel_median, 3),
            'trueXY': [true_mid['x'], true_mid['y']],
            'shiftedXY': [shifted_mid['x'], shifted_mid['y']],
            'trueValueGap': abs(true_mid['y'] - true_mid['x']),
        }
        problems = bounded(true) + bounded(shifted)
        if pixel_median > 2:
            problems.append('anchor values changed the extracted pixels by %.2f px' % pixel_median)
        if abs(true_mid['y'] - true_mid['x']) < 0.45:
            problems.append('offset stroke was forced toward y=x: %s' % metric['trueXY'])
        if abs(shifted_mid['y'] - true_mid['y']) < 0.25 and abs(shifted_mid['x'] - true_mid['x']) < 0.25:
            problems.append('shifted anchors did not change data values')
        remember('manual-anchor-vs-pixels', metric, problems)
        self.assertFalse(problems, problems)

    def test_interior_color_stays_on_the_stroke(self):
        stroke = [(100, 120), (540, 380)]

        def draw(pen):
            pen.line(stroke, fill=HALO, width=14)
            pen.line(stroke, fill=BLUE, width=5)

        png, sha = png_of(draw)
        box = (70, 70, 580, 430)

        def run(color):
            options = manual(sha, box, color, [(100, 0), (540, 10)], [(120, 8), (380, 1)])
            result = trace_manual(png, options)
            if result.get('status') not in ('ready', 'partial') or not result.get('series'):
                return result, [], None, None
            polylines = geometry_polylines(result)
            distances = sorted(nearest_distance(point, [stroke]) for poly in polylines for point in thin(poly, 200))
            return result, polylines, distances[len(distances) // 2], max(reversals(poly) for poly in polylines)

        interior, interior_lines, interior_median, interior_reversals = run(BLUE)
        boundary, boundary_lines, boundary_median, boundary_reversals = run(HALO)

        def series_color(result):
            return None if not result.get('series') else result['series'][0].get('color')

        metric = {
            'interiorMedianPx': None if interior_median is None else round(interior_median, 3),
            'boundaryMedianPx': None if boundary_median is None else round(boundary_median, 3),
            'interiorReversals': interior_reversals,
            'boundaryReversals': boundary_reversals,
            'interiorColor': series_color(interior),
            'boundaryColor': series_color(boundary),
            'interiorStatus': interior.get('status'),
            'boundaryStatus': boundary.get('status'),
            'boundaryIssues': boundary.get('issues'),
            'boundaryEffective': None if not boundary.get('series') else boundary['series'][0].get('effectiveColor'),
        }
        problems = bounded(interior) + bounded(boundary)
        if not interior.get('series'):
            problems.append('interior color returned %s %s' % (interior.get('status'), interior.get('issues')))
        else:
            problems.extend(color_binding(interior['series'][0], BLUE))
        if not boundary.get('series'):
            problems.append('boundary color returned %s %s' % (boundary.get('status'), boundary.get('issues')))
        else:
            problems.extend(color_binding(boundary['series'][0], HALO))
        if interior_median is None or interior_median > 5:
            problems.append('interior color left the stroke by %s px' % interior_median)
        if interior_reversals is not None and interior_reversals > 6:
            problems.append('interior trace reversed %d times on a monotone stroke' % interior_reversals)
        save_overlay('manual-interior', png, interior_lines, box)
        save_overlay('manual-boundary', png, boundary_lines, box)
        remember('manual-boundary-color', metric, problems)
        self.assertFalse(problems, problems)

    def test_repeat_trace_keeps_the_same_pixels(self):
        def draw(pen):
            pen.line([(100, 140), (520, 300)], fill=BLUE, width=4)

        png, sha = png_of(draw)
        box = (70, 80, 560, 360)
        options_args = (png, sha, box, BLUE, [(100, 0), (520, 9)], [(140, 2), (300, -1)])
        first = self.geometry(*options_args)
        second = self.geometry(*options_args)
        first_px = geometry_polylines(first)
        second_px = geometry_polylines(second)
        distance = false_ratio(first_px, second_px, tolerance=0.1, step=2)
        metric = {'movedFraction': round(distance, 4), 'points': [len(poly) for poly in first_px]}
        problems = []
        if distance > 0:
            problems.append('repeat trace moved pixels: %s' % metric)
        remember('manual-deterministic', metric, problems)
        self.assertFalse(problems, problems)

    def test_rerendered_live_crop_boundary_color_when_present(self):
        root = benchmark_root()
        png_path = None if root is None else root / 'inputs' / 'live-crop.png'
        truth_path = None if root is None else root / 'inputs' / 'live-crop.truth.json'
        interior_truth = None if root is None else root / 'inputs' / 'live-original-color.truth.json'
        if png_path is None or not png_path.is_file() or not truth_path.is_file():
            self.skipTest('private live-crop fixture is not beside this checkout')
        png = png_path.read_bytes()
        truth = json.loads(truth_path.read_text(encoding='utf-8'))
        box = tuple(truth['box'])
        sha = hashlib.sha256(png).hexdigest()
        color = '#%02x%02x%02x' % tuple(truth['target'])
        result = self.geometry(
            png, sha, box, color,
            [(box[0], 0), (box[2], 1)],
            [(box[1], 1), (box[3], 0)])
        polylines = geometry_polylines(result)
        truth_polys = [[(float(x), float(y)) for x, y in path] for path in truth['paths']]
        metric = {
            'falseRatio': round(false_ratio(polylines, truth_polys, tolerance=2, step=2, limit=350), 4),
            'coverage': round(max(coverage(path, polylines, tolerance=2, step=3, limit=300) for path in truth_polys), 4),
            'reversals': max(reversals(poly) for poly in polylines),
            'series': len(result['series']),
            'color': result['series'][0]['color'],
            'requestedColor': result['series'][0].get('requestedColor'),
            'effectiveColor': result['series'][0].get('effectiveColor'),
        }
        if interior_truth.is_file():
            interior = json.loads(interior_truth.read_text(encoding='utf-8'))
            interior_color = '#%02x%02x%02x' % tuple(interior['target'])
            interior_result = self.geometry(
                png, sha, box, interior_color,
                [(box[0], 0), (box[2], 1)],
                [(box[1], 1), (box[3], 0)])
            interior_lines = geometry_polylines(interior_result)
            metric['interiorFalseRatio'] = round(false_ratio(interior_lines, truth_polys, tolerance=2, step=2, limit=350), 4)
            metric['interiorReversals'] = max(reversals(poly) for poly in interior_lines)
            save_overlay('live-interior', png, interior_lines, box)
        problems = bounded(result)
        problems.extend(color_binding(result['series'][0], color))
        if metric['falseRatio'] > 0.25:
            problems.append('live boundary false-segment ratio %.3f' % metric['falseRatio'])
        if metric['reversals'] > 8:
            problems.append('live boundary color reversed %d times' % metric['reversals'])
        if metric['coverage'] < 0.7:
            problems.append('live boundary coverage %.3f' % metric['coverage'])
        save_overlay('live-boundary', png, polylines, box)
        remember('live-crop-boundary', metric, problems)
        self.assertFalse(problems, problems)

    def test_short_same_color_fork_is_kept(self):
        # The second branch exists only in the last 20px of a 480px-wide plot.
        box = (40, 30, 520, 210)
        main = [(40, 110), (520, 110)]
        fork = [(500, 110), (520, 50)]

        def draw(pen):
            pen.line(main, fill=BLUE, width=4)
            pen.line(fork, fill=BLUE, width=4)

        png, sha = png_of(draw)
        self.assertEqual(box[2] - box[0], 480)
        result = self.geometry(png, sha, box, BLUE, [(40, 0), (520, 10)], [(50, 4), (110, 1)])
        polylines = geometry_polylines(result)
        points = [point for poly in polylines for point in poly]
        zone = [point for point in points if point[0] >= 508]
        zone_distance = [nearest_distance(point, [main, fork]) for point in zone]
        zone_median = sorted(zone_distance)[len(zone_distance) // 2] if zone_distance else None
        early_spread = 0
        early = [point for point in points if point[0] < 490]
        for x in range(60, 480, 20):
            ys = [y for px, y in early if abs(px - x) <= 6]
            if len(ys) >= 2:
                early_spread = max(early_spread, max(ys) - min(ys))
        fork_coverage = coverage(fork, polylines, tolerance=4, step=1)
        unresolved = explicit_unresolved(result)
        metric = {
            'plotWidthPx': 480,
            'forkWidthPx': 20,
            'forkCoverage': round(fork_coverage, 4),
            'zoneMedianPx': None if zone_median is None else round(zone_median, 3),
            'earlySpreadPx': round(early_spread, 3),
            'unresolved': unresolved,
            'routes': sorted({series.get('traceRoute') for series in result['series']}),
            'polylines': len(polylines),
        }
        problems = bounded(result)
        if early_spread > 12:
            problems.append('single-valued span was zippered: y spread %.1f px' % early_spread)
        if zone_median is None or zone_median > 6:
            problems.append('fork-zone samples left both source strokes: %s' % metric)
        if fork_coverage < 0.7 and not unresolved:
            problems.append('20px same-color fork was discarded without unresolved evidence: %s' % metric)
        save_overlay('manual-short-fork', png, polylines, box)
        remember('manual-short-fork', metric, problems)
        self.assertFalse(problems, problems)

    def test_single_asymmetric_errorbar_stays_on_the_source(self):
        box = (40, 40, 520, 360)
        main = [(40, 200), (520, 200)]
        whisker = [(300, 120), (300, 230)]
        tip = (300, 120)

        def draw(pen):
            pen.line(main, fill=BLUE, width=3)
            pen.line(whisker, fill=BLUE, width=3)
            pen.line([(292, 120), (308, 120)], fill=BLUE, width=3)
            pen.line([(292, 230), (308, 230)], fill=BLUE, width=3)

        png, sha = png_of(draw)
        self.assertEqual(box[2] - box[0], 480)
        result = self.geometry(png, sha, box, BLUE, [(40, 0), (520, 8)], [(120, 5), (230, -1)])
        polylines = geometry_polylines(result)
        curve = max(polylines, key=lambda poly: max(point[0] for point in poly) - min(point[0] for point in poly))
        deviations = sorted(abs(y - 200) for _, y in curve)
        tip_distance = nearest_distance(tip, polylines)
        unresolved = explicit_unresolved(result)
        metric = {
            'upPx': 80,
            'downPx': 30,
            'mainMedianPx': round(deviations[len(deviations) // 2], 3),
            'mainMaxPx': round(deviations[-1], 3),
            'tipPx': round(tip_distance, 3),
            'unresolved': unresolved,
            'routes': sorted({series.get('traceRoute') for series in result['series']}),
            'polylines': len(polylines),
        }
        problems = bounded(result)
        if metric['mainMedianPx'] > 4 or metric['mainMaxPx'] > 8:
            problems.append('asymmetric bar pulled the main curve off y=200: %s' % metric)
        if tip_distance > 6 and not unresolved:
            problems.append('asymmetric whisker was discarded without unresolved evidence: %s' % metric)
        save_overlay('manual-asymmetric-errorbar', png, polylines, box)
        remember('manual-asymmetric-errorbar', metric, problems)
        self.assertFalse(problems, problems)

    def test_xstep_origin_is_curve_interpolated_on_ink(self):
        stroke = [(80, 360), (560, 100)]

        def draw(pen):
            pen.line(stroke, fill=BLUE, width=5)

        png, sha = png_of(draw)
        box = (60, 60, 580, 420)
        result = self.geometry(
            png, sha, box, BLUE,
            [(80, 0), (560, 6)],
            [(360, 1), (100, 1000)],
            y_scale='log')
        points = result['series'][0]['points']
        on_ink = [point for point in points if nearest_distance((point['xPixel'], point['yPixel']), [stroke]) <= 2]
        origins = sorted({point.get('origin') for point in on_ink})
        metric = {
            'route': result['series'][0].get('traceRoute'),
            'points': len(points),
            'onInk': len(on_ink),
            'onInkOrigins': origins,
            'roles': sorted({point.get('role') for point in on_ink}),
        }
        problems = bounded(result)
        if metric['route'] != 'wpd-xstep':
            problems.append('log stroke route %s' % metric['route'])
        if not on_ink:
            problems.append('xstep returned no sample within 2px of the ink')
        elif any(point.get('origin') != 'curve-interpolated' for point in on_ink):
            problems.append('xstep marked on-ink samples as measured observations: %s' % origins)
        if len(points) > 480:
            problems.append('xstep returned %d points' % len(points))
        remember('manual-xstep-origin', metric, problems)
        self.assertFalse(problems, problems)

    def test_step_origin_stays_pixel_calibrated_on_ink(self):
        stroke = [(80, 360), (560, 100)]

        def draw(pen):
            pen.line(stroke, fill=BLUE, width=5)

        png, sha = png_of(draw)
        box = (60, 60, 580, 420)
        result = self.geometry(png, sha, box, BLUE, [(80, 0), (560, 6)], [(360, 1), (100, 9)])
        points = result['series'][0]['points']
        on_ink = [point for point in points if nearest_distance((point['xPixel'], point['yPixel']), [stroke]) <= 2]
        origins = sorted({point.get('origin') for point in on_ink})
        metric = {
            'route': result['series'][0].get('traceRoute'),
            'points': len(points),
            'onInk': len(on_ink),
            'onInkOrigins': origins,
            'roles': sorted({point.get('role') for point in on_ink}),
        }
        problems = bounded(result)
        if metric['route'] != 'wpd-step':
            problems.append('linear stroke route %s' % metric['route'])
        if not on_ink:
            problems.append('step returned no sample within 2px of the ink')
        elif any(point.get('origin') != 'pixel-calibrated' for point in on_ink):
            problems.append('step on-ink provenance matched xstep interpolation: %s' % origins)
        if len(points) > 480:
            problems.append('step returned %d points' % len(points))
        remember('manual-step-origin', metric, problems)
        self.assertFalse(problems, problems)

    def test_sharp_step_stays_on_treads_and_riser(self):
        box = (40, 40, 520, 360)
        step = [(40, 260), (250, 260), (250, 100), (520, 100)]
        riser = [(250, 260), (250, 100)]

        def draw(pen):
            pen.line(step, fill=BLUE, width=4)

        png, sha = png_of(draw)
        result = self.geometry(png, sha, box, BLUE, [(40, 0), (520, 1)], [(260, 0.25), (100, 0.75)])
        polylines = geometry_polylines(result)
        step_coverage = coverage(step, polylines, tolerance=4, step=1)
        riser_coverage = coverage(riser, polylines, tolerance=4, step=1)
        ratio = false_ratio(polylines, [step], tolerance=4)
        metric = {
            'coverage': round(step_coverage, 4),
            'riserCoverage': round(riser_coverage, 4),
            'falseRatio': round(ratio, 4),
            'routes': sorted({series.get('traceRoute') for series in result['series']}),
            'polylines': len(polylines),
        }
        problems = bounded(result)
        if step_coverage < 0.9:
            problems.append('sharp step coverage %.3f' % step_coverage)
        if riser_coverage < 0.8:
            problems.append('sharp step riser coverage %.3f' % riser_coverage)
        if ratio > 0.08:
            problems.append('sharp step left the source strokes: false ratio %.3f' % ratio)
        save_overlay('manual-sharp-step', png, polylines, box)
        remember('manual-sharp-step', metric, problems)
        self.assertFalse(problems, problems)


class NativePathQaTests(unittest.TestCase):
    """Synthetic PDF only. The entry is paper_chart_vectors.prefer_native_paths."""

    OPEN = ((40.0, 200.0), (90.0, 40.0), (280.0, 260.0), (360.0, 70.0))
    LOOP = (
        ((80.0, 150.0), (80.0, 40.0), (220.0, 40.0), (220.0, 150.0)),
        ((220.0, 150.0), (220.0, 260.0), (80.0, 260.0), (80.0, 150.0)),
    )
    CROP = [0, 0, 400, 300]
    DPI = 72
    INK_BOX = (20.0, 40.0, 380.0, 260.0)
    INK_SIZE = (360, 220)
    INK_LINE = ((20, 160), (340, 160))
    INK_RGB = (31, 119, 180)

    @classmethod
    def setUpClass(cls):
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        shape = page.new_shape()
        shape.draw_bezier(*cls.OPEN)
        shape.finish(color=(0, 0, 1), width=1.5, dashes='[3 2] 0', closePath=False)
        shape.draw_bezier(*cls.LOOP[0])
        shape.draw_bezier(*cls.LOOP[1])
        shape.finish(color=(1, 0, 0), width=1.25, dashes='[4 1] 0', closePath=True)
        shape.commit()
        later = doc.new_page(width=400, height=300)
        later.draw_line((30, 40), (300, 240), color=(0, 1, 0), width=3)
        cls.raw = doc.tobytes()
        doc.close()
        cls.digest = hashlib.sha256(cls.raw).hexdigest()
        cls.page1 = cls.page_drawings(cls.raw, 1)

    @staticmethod
    def page_drawings(raw, page_index):
        import pymupdf
        doc = pymupdf.open(stream=raw, filetype='pdf')
        try:
            page = doc[page_index]
            drawings = []
            for drawing in page.get_drawings(extended=True):
                items = []
                for item in drawing.get('items') or []:
                    points = []
                    for value in item[1:]:
                        if hasattr(value, 'x') and hasattr(value, 'y'):
                            points.append((round(value.x, 3), round(value.y, 3)))
                    items.append((item[0], tuple(points)))
                drawings.append((drawing.get('type'), bool(drawing.get('closePath')), tuple(items)))
            return tuple(drawings)
        finally:
            doc.close()

    def raster(self):
        def series(ident, color):
            return {'id': ident, 'name': ident, 'color': color, 'axisBinding': 'left',
                    'points': [{'xPixel': 10, 'yPixel': 10, 'x': 10, 'y': 10}]}
        return {
            'schema': 'falsify.chart-data.v1', 'status': 'partial',
            'image': {'sha256': 'ab' * 32, 'width': 400, 'height': 300},
            'columns': ['series', 'x', 'y'], 'rows': [['guess', '10', '10']],
            'numericCells': [], 'issues': ['curves-not-found'],
            'provenance': {'method': 'oss-pixel-calibration'},
            'geometry': {
                'schema': 'falsify.chart-geometry.v1', 'status': 'partial', 'issues': ['curves-not-found'],
                'axes': {
                    'x': {'scale': 'linear', 'points': [{'pixel': 40, 'value': 0}, {'pixel': 360, 'value': 10}]},
                    'left': {'scale': 'linear', 'points': [{'pixel': 40, 'value': -4}, {'pixel': 260, 'value': 20}]},
                },
                'series': [series('blue', '#0000ff'), series('red', '#ff0000')],
            },
        }

    def prefer(self, raster):
        buf = bytearray(self.raw)
        result = paper_chart_vectors.prefer_native_paths(
            buf, page_index=0, crop=list(self.CROP), dpi=self.DPI, width=400, height=300,
            raster=raster, plot_bbox=list(self.CROP))
        return buf, result

    def data_xy(self, px, py):
        return ((px - 40) / 320 * 10, -4 + (py - 40) / 220 * 24)

    def assert_binding(self, series, problems):
        stroke = series.get('sourceStroke') or {}
        if stroke.get('sourceSha256') != self.digest:
            problems.append('%s source hash %s' % (series.get('id'), stroke.get('sourceSha256')))
        if stroke.get('pageIndex') != 0 or stroke.get('crop') != self.CROP or stroke.get('dpi') != self.DPI:
            problems.append('%s binding page=%s crop=%s dpi=%s' % (
                series.get('id'), stroke.get('pageIndex'), stroke.get('crop'), stroke.get('dpi')))

    def assert_on_curve(self, series, curves, problems):
        poly = [(point['xPixel'], point['yPixel']) for point in series.get('points') or []]
        dense = dense_curve(curves)
        if len(poly) < 2:
            problems.append('%s returned no vector path' % series.get('id'))
            return None, None
        vertex = max(nearest_distance(point, [dense]) for point in poly)
        gap = max(nearest_distance(point, [poly]) for point in dense[::2])
        if vertex > 0.15:
            problems.append('%s sample left the true cubic by %.3f px' % (series.get('id'), vertex))
        if gap > 0.25:
            problems.append('%s polyline is %.3f px from the dense cubic; sampling limit is 0.25 px' % (series.get('id'), gap))
        for point in series['points']:
            expected = self.data_xy(point['xPixel'], point['yPixel'])
            if abs(point['x'] - expected[0]) > 1e-6 or abs(point['y'] - expected[1]) > 1e-6:
                problems.append('%s value %s is not the axis calibration of its pixel' % (
                    series.get('id'), (point['x'], point['y'])))
                break
        return vertex, gap

    def test_open_cubic_matches_dense_curve_and_source_binding(self):
        raster = self.raster()
        buf, result = self.prefer(raster)
        problems = []
        if bytes(buf) != self.raw:
            problems.append('source bytes changed')
        if self.page_drawings(self.raw, 1) != self.page1:
            problems.append('unrelated page changed')
        provenance = result.get('provenance') or {}
        if result is raster or provenance.get('vector') != 'pdf-native-path':
            problems.append('cubic was not returned as a pdf-native-path')
        if provenance.get('vector') == 'pdf-native-path' and provenance.get('method') != 'oss-pixel-calibration':
            problems.append('provenance method changed to %s' % provenance.get('method'))
        if raster['geometry']['series'][0]['points'][0] != {'xPixel': 10, 'yPixel': 10, 'x': 10, 'y': 10}:
            problems.append('input raster was mutated')
        blues = [series for series in (result.get('geometry') or {}).get('series', []) if series.get('color') == '#0000ff']
        vertex = gap = None
        if len(blues) != 1:
            problems.append('blue cubic series count %d' % len(blues))
        else:
            blue = blues[0]
            commands = (blue.get('sourceStroke') or {}).get('commands')
            expected = [{'op': 'c', 'points': [list(point) for point in self.OPEN]}]
            if commands != expected:
                problems.append('cubic controls %s' % commands)
            style = (blue.get('sourceStroke') or {}).get('style') or {}
            dashes = str(style.get('dashes'))
            if '3' not in dashes or '2' not in dashes:
                problems.append('cubic dashes dropped: %s' % style.get('dashes'))
            if style.get('width') != 1.5:
                problems.append('cubic width %s' % style.get('width'))
            self.assert_binding(blue, problems)
            points = blue.get('points') or []
            if not points or points[0].get('origin') != 'pdf-vector-calibrated' or points[-1].get('origin') != 'pdf-vector-calibrated':
                problems.append('cubic endpoint origin missing')
            interiors = [point for point in points[1:-1] if point.get('origin') == 'curve-interpolated']
            if len(interiors) < 14:
                problems.append('cubic curve-interpolated samples %d' % len(interiors))
            if points[1:-1] and min(math.hypot(point['xPixel'] - 90, point['yPixel'] - 40) for point in points[1:-1]) < 20:
                problems.append('off-curve control was returned as a sample')
            vertex, gap = self.assert_on_curve(blue, [self.OPEN], problems)
            if points:
                midpoint = min(points, key=lambda point: abs(point['xPixel'] - 188.75))
                if abs(midpoint['y'] - midpoint['x']) < 1:
                    problems.append('cubic fitted toward y=x at %s,%s' % (midpoint['x'], midpoint['y']))
        if '#00ff00' in {series.get('color') for series in (result.get('geometry') or {}).get('series', [])}:
            problems.append('unrelated page stroke was returned')
        metric = {
            'vector': provenance.get('vector'),
            'vertexPx': None if vertex is None else round(vertex, 4),
            'denseGapPx': None if gap is None else round(gap, 4),
            'sha256': self.digest,
        }
        remember('native-open-cubic', metric, problems)
        self.assertFalse(problems, problems)

    def test_closed_cubic_loop_is_returned(self):
        raster = self.raster()
        buf, result = self.prefer(raster)
        problems = []
        if bytes(buf) != self.raw:
            problems.append('source bytes changed')
        if self.page_drawings(self.raw, 1) != self.page1:
            problems.append('unrelated page changed')
        reds = [series for series in (result.get('geometry') or {}).get('series', []) if series.get('color') == '#ff0000']
        vertex = gap = None
        if len(reds) != 1:
            problems.append('closed cubic loop series count %d' % len(reds))
        else:
            red = reds[0]
            commands = (red.get('sourceStroke') or {}).get('commands')
            expected = [{'op': 'c', 'points': [list(point) for point in controls]} for controls in self.LOOP]
            if commands != expected:
                problems.append('loop controls %s' % commands)
            style = (red.get('sourceStroke') or {}).get('style') or {}
            dashes = str(style.get('dashes'))
            if '4' not in dashes or '1' not in dashes:
                problems.append('loop dashes dropped: %s' % style.get('dashes'))
            if style.get('width') != 1.25:
                problems.append('loop width %s' % style.get('width'))
            self.assert_binding(red, problems)
            points = red.get('points') or []
            origins = {point.get('origin') for point in points}
            if origins - {'pdf-vector-calibrated', 'curve-interpolated'}:
                problems.append('loop origins %s' % sorted(origins))
            if sum(point.get('origin') == 'curve-interpolated' for point in points) < 28:
                problems.append('loop curve-interpolated samples %d' % sum(point.get('origin') == 'curve-interpolated' for point in points))
            if not points or points[0].get('origin') != 'pdf-vector-calibrated' or points[-1].get('origin') != 'pdf-vector-calibrated':
                problems.append('loop endpoints are not pdf-vector-calibrated')
            if points and math.hypot(points[0]['xPixel'] - points[-1]['xPixel'], points[0]['yPixel'] - points[-1]['yPixel']) > 0.2:
                problems.append('loop path does not close')
            xs = [point['xPixel'] for point in points]
            if not any(right < left - 0.5 for left, right in zip(xs, xs[1:])):
                problems.append('loop x never decreases')
            band = [point['yPixel'] for point in points if 130 <= point['xPixel'] <= 170]
            if len(band) < 2 or max(band) - min(band) <= 40:
                problems.append('loop collapsed toward one y per x')
            vertex, gap = self.assert_on_curve(red, self.LOOP, problems)
            if points and all(abs(point['y'] - point['x']) < 0.25 for point in points):
                problems.append('loop was fitted to y=x')
        metric = {
            'series': len(reds),
            'vertexPx': None if vertex is None else round(vertex, 4),
            'denseGapPx': None if gap is None else round(gap, 4),
            'bytesUnchanged': bytes(buf) == self.raw,
            'pageUnchanged': self.page_drawings(self.raw, 1) == self.page1,
        }
        remember('native-closed-loop', metric, problems)
        self.assertFalse(problems, problems)




    def test_opacity_zero_same_color_stroke_is_omitted(self):
        import pymupdf
        visible = ((40.0, 160.0), (300.0, 40.0))
        hidden = ((40.0, 80.0), (360.0, 200.0))
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        shape = page.new_shape()
        shape.draw_line(*hidden)
        shape.finish(color=(0, 0, 1), width=2, stroke_opacity=0)
        shape.draw_line(*visible)
        shape.finish(color=(0, 0, 1), width=2, stroke_opacity=1)
        shape.commit()
        later = doc.new_page(width=400, height=300)
        later.draw_line((30, 40), (300, 240), color=(0, 1, 0), width=3)
        raw = doc.tobytes()
        other = self.page_drawings(raw, 1)
        doc.close()
        buf = bytearray(raw)
        raster = self.raster()
        result = paper_chart_vectors.prefer_native_paths(
            buf, page_index=0, crop=list(self.CROP), dpi=self.DPI, width=400, height=300,
            raster=raster, plot_bbox=list(self.CROP))
        native = [series for series in (result.get('geometry') or {}).get('series', []) if series.get('sourceStroke')]
        points = [(point['xPixel'], point['yPixel']) for series in native for point in series.get('points') or []]

        def near(target):
            return bool(points) and nearest_distance(target, [points]) <= 1.5

        problems = []
        if bytes(buf) != raw or self.page_drawings(raw, 1) != other:
            problems.append('opacity fixture changed the source or the other page')
        if not near(visible[0]) or not near(visible[1]):
            problems.append('visible same-color stroke was not returned')
        if near(hidden[0]) or near(hidden[1]):
            problems.append('opacity-zero same-color stroke was returned')
        if any((series.get('sourceStroke') or {}).get('style', {}).get('opacity') == 0 for series in native):
            problems.append('returned stroke style opacity is 0')
        metric = {'nativeSeries': len(native), 'points': len(points)}
        remember('native-opacity-zero', metric, problems)
        self.assertFalse(problems, problems)

    def test_step_curve_is_kept_apart_from_grid_and_legend(self):
        import pymupdf
        step = [(40.0, 220.0), (150.0, 220.0), (150.0, 140.0), (270.0, 140.0), (270.0, 70.0), (360.0, 70.0)]
        legend = ((12.0, 16.0), (58.0, 16.0))
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        grid = page.new_shape()
        for y in (80, 150, 220):
            grid.draw_line((40, y), (360, y))
        for x in (100, 200, 300):
            grid.draw_line((x, 40), (x, 260))
        grid.finish(color=(0.75, 0.75, 0.75), width=0.6)
        grid.commit()
        swatch = page.new_shape()
        swatch.draw_line(*legend)
        swatch.finish(color=(0, 0, 1), width=2)
        swatch.commit()
        curve = page.new_shape()
        for start, end in zip(step, step[1:]):
            curve.draw_line(start, end)
        curve.finish(color=(0, 0, 1), width=1.8)
        curve.commit()
        raw = doc.tobytes()
        doc.close()
        raster = self.raster()
        raster['geometry']['series'] = [raster['geometry']['series'][0]]
        result = paper_chart_vectors.prefer_native_paths(
            raw, page_index=0, crop=list(self.CROP), dpi=self.DPI, width=400, height=300,
            raster=raster, plot_bbox=[30, 40, 380, 270])
        series = (result.get('geometry') or {}).get('series', [])
        native = [item for item in series if item.get('sourceStroke')]
        points = [(point['xPixel'], point['yPixel']) for item in native for point in item.get('points') or []]
        colors = {item.get('color') for item in series}
        missing = [corner for corner in step if not points or nearest_distance(corner, [points]) > 1.5]
        problems = []
        if '#bfbfbf' in colors:
            problems.append('gray grid was returned as data')
        if points and any(nearest_distance(point, [points]) <= 1.5 for point in legend):
            problems.append('legend swatch outside the plot was returned')
        if missing:
            problems.append('step/flat data curve was dropped: %s' % missing)
        metric = {'nativeSeries': len(native), 'points': len(points), 'missingCorners': len(missing), 'colors': sorted(colors)}
        remember('native-step-vs-grid', metric, problems)
        self.assertFalse(problems, problems)

    def visible_ink_page_line(self):
        x0, y0, x1, y1 = self.INK_BOX
        width, height = self.INK_SIZE
        if (x1 - x0, y1 - y0) != (float(width), float(height)):
            return None
        def page_point(image_point):
            return (x0 + image_point[0] * (x1 - x0) / width,
                    y0 + image_point[1] * (y1 - y0) / height)
        return page_point(self.INK_LINE[0]), page_point(self.INK_LINE[1])

    def visible_curve_raster(self):
        raster = self.raster()
        points = []
        for x in range(40, 361, 40):
            px, py = float(x), 200.0
            data_x, data_y = self.data_xy(px, py)
            points.append({'xPixel': px, 'yPixel': py, 'x': data_x, 'y': data_y,
                           'origin': 'pixel-calibrated', 'role': 'measured'})
        blue = raster['geometry']['series'][0]
        blue['color'] = BLUE
        blue['points'] = points
        raster['geometry']['series'] = [blue]
        return raster

    def occluded_curve_pdf(self, hidden):
        import pymupdf
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        shape = page.new_shape()
        shape.draw_line(*hidden)
        shape.finish(color=tuple(channel / 255 for channel in self.INK_RGB), width=2)
        shape.commit()
        page.draw_rect(pymupdf.Rect(0, 0, 400, 300), color=None, fill=(1, 1, 1), overlay=True)
        overlay = Image.new('RGB', self.INK_SIZE, (255, 255, 255))
        ImageDraw.Draw(overlay).line(list(self.INK_LINE), fill=self.INK_RGB, width=4)
        payload = io.BytesIO()
        overlay.save(payload, format='PNG')
        page.insert_image(pymupdf.Rect(*self.INK_BOX), stream=payload.getvalue(), overlay=True)
        raw = doc.tobytes()
        doc.close()
        return raw

    def nearest_hidden(self, samples, hidden):
        return min((nearest_distance(point, [list(hidden)]) for point in samples), default=1e9)

    def test_later_white_rect_and_image_hide_the_old_curve(self):
        hidden = ((40.0, 48.0), (360.0, 108.0))
        raw = self.occluded_curve_pdf(hidden)
        raster = self.visible_curve_raster()
        ink = self.visible_ink_page_line()
        color = raster['geometry']['series'][0].get('color')
        before_points = [dict(point) for point in raster['geometry']['series'][0]['points']]
        before = [(point['xPixel'], point['yPixel']) for point in before_points]
        result = paper_chart_vectors.prefer_native_paths(
            raw, page_index=0, crop=list(self.CROP), dpi=self.DPI, width=400, height=300,
            raster=raster, plot_bbox=list(self.CROP))
        series = (result.get('geometry') or {}).get('series', [])
        points = [(point['xPixel'], point['yPixel']) for item in series for point in item.get('points') or []]
        hidden_hit = self.nearest_hidden(points, hidden)
        stayed = bool(points) and max(nearest_distance(point, [points]) for point in before) <= 1.5
        same = len(series) == 1 and series[0].get('points') == before_points
        separation = self.nearest_hidden(before, hidden)
        hidden_original = self.nearest_hidden([hidden[0], hidden[1]], hidden)
        problems = []
        if ink != ((40.0, 200.0), (360.0, 200.0)) or {point['yPixel'] for point in before_points} != {200.0}:
            problems.append('visible raster does not match the inserted image line %s' % (ink,))
        elif any(point[0] < ink[0][0] or point[0] > ink[1][0] for point in before):
            problems.append('visible raster samples leave the image line')
        if list(self.INK_RGB) != rgb_of(BLUE) or color != BLUE:
            problems.append('visible raster color does not match the overlay ink')
        if separation <= 6:
            problems.append('visible horizontal is not disjoint from the hidden stroke, nearest sample %.2f px' % separation)
        if hidden_original > 6:
            problems.append('distance check would accept a returned hidden-original path, nearest sample %.2f px' % hidden_original)
        if hidden_hit <= 6:
            problems.append('later white rect and image still returned the hidden curve, nearest sample %.2f px' % hidden_hit)
        if not stayed or not same:
            problems.append('visible raster curve was replaced')
        if any(item.get('sourceStroke') for item in series):
            problems.append('occluded pre-edit stroke was kept as sourceStroke')
        metric = {
            'points': len(points), 'hiddenDistancePx': None if not points else round(hidden_hit, 3),
            'separationPx': round(separation, 3), 'hiddenOriginalPx': round(hidden_original, 3),
            'keptRaster': stayed and same,
        }
        remember('native-paint-order-hide', metric, problems)
        self.assertFalse(problems, problems)

    def test_crossing_occluded_curve_keeps_exact_raster(self):
        hidden = ((40.0, 220.0), (360.0, 60.0))
        raw = self.occluded_curve_pdf(hidden)
        raster = self.visible_curve_raster()
        before_points = [dict(point) for point in raster['geometry']['series'][0]['points']]
        result = paper_chart_vectors.prefer_native_paths(
            raw, page_index=0, crop=list(self.CROP), dpi=self.DPI, width=400, height=300,
            raster=raster, plot_bbox=list(self.CROP))
        series = (result.get('geometry') or {}).get('series', [])
        points = [(point['xPixel'], point['yPixel']) for item in series for point in item.get('points') or []]
        hidden_hit = self.nearest_hidden(points, hidden)
        same = len(series) == 1 and series[0].get('points') == before_points
        problems = []
        if hidden_hit > 6:
            problems.append('crossing fixture no longer meets the hidden stroke, nearest sample %.2f px' % hidden_hit)
        if not same:
            problems.append('crossing occluded curve replaced the visible raster')
        if any(item.get('sourceStroke') for item in series):
            problems.append('occluded pre-edit stroke was kept as sourceStroke')
        metric = {
            'points': len(points), 'hiddenDistancePx': None if not points else round(hidden_hit, 3),
            'exactRaster': same,
        }
        remember('native-paint-order-crossing', metric, problems)
        self.assertFalse(problems, problems)

    def test_background_image_still_allows_the_native_stroke(self):
        import pymupdf
        visible = ((40.0, 160.0), (300.0, 40.0))
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        image = Image.new('RGB', (400, 300), (248, 248, 248))
        payload = io.BytesIO()
        image.save(payload, format='PNG')
        page.insert_image(pymupdf.Rect(0, 0, 400, 300), stream=payload.getvalue())
        shape = page.new_shape()
        shape.draw_line(*visible)
        shape.finish(color=(0, 0, 1), width=2, stroke_opacity=1)
        shape.commit()
        raw = doc.tobytes()
        doc.close()
        raster = self.raster()
        result = paper_chart_vectors.prefer_native_paths(
            raw, page_index=0, crop=list(self.CROP), dpi=self.DPI, width=400, height=300,
            raster=raster, plot_bbox=list(self.CROP))
        native = [item for item in (result.get('geometry') or {}).get('series', []) if item.get('sourceStroke')]
        points = [(point['xPixel'], point['yPixel']) for item in native for point in item.get('points') or []]
        problems = []
        if not points or any(nearest_distance(point, [points]) > 1.5 for point in visible):
            problems.append('background image suppressed the later native stroke')
        metric = {'nativeSeries': len(native), 'points': len(points)}
        remember('native-background-image', metric, problems)
        self.assertFalse(problems, problems)


def tearDownModule():
    folder = qa_dir()
    if folder is None:
        return
    payload = {'schema': 'falsify.chart-correction-qa.v1', 'results': RESULTS}
    (folder / 'metrics.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')


if __name__ == '__main__':
    unittest.main()

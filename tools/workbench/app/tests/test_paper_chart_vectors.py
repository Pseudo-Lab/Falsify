"""Native PDF line/cubic preference. Fixtures are synthetic and built in memory."""
import hashlib
import json
import math
import struct
import subprocess
import sys
import unittest
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart
import paper_chart_vectors as vectors
import paper_digitizer
import paper_enrichment as enrichment
import paper_evidence as evidence
import paper_evidence_blue as blue

LOCAL = Path(__file__).resolve().parents[1] / 'local'
HEAVY = ('cv2', 'numpy', 'torch', 'paper_chart', 'transformers')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def png_size(png):
    return struct.unpack('>II', png[16:24])


def page_matrix(page):
    matrix = page.rotation_matrix
    return (matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)


def map_point(x, y, matrix):
    a, b, c, d, e, f = matrix
    return (a * x + c * y + e, b * x + d * y + f)


def pixel(x, y, clip, dpi):
    zoom = dpi / 72
    return (x * zoom - math.floor(clip[0] * zoom), y * zoom - math.floor(clip[1] * zoom))


def page_pixel(x, y, clip, dpi, matrix):
    return pixel(*map_point(x, y, matrix), clip, dpi)


def unmap_pixel(px, py, clip, dpi, matrix):
    zoom = dpi / 72
    rotated = ((px + math.floor(clip[0] * zoom)) / zoom, (py + math.floor(clip[1] * zoom)) / zoom)
    # Inverse of [a c e; b d f] for the rotation matrices PyMuPDF reports.
    a, b, c, d, e, f = matrix
    det = a * d - b * c
    x = (d * (rotated[0] - e) - c * (rotated[1] - f)) / det
    y = (-b * (rotated[0] - e) + a * (rotated[1] - f)) / det
    return (x, y)


def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    def mix(index):
        return (u ** 3) * p0[index] + 3 * (u ** 2) * t * p1[index] + 3 * u * (t ** 2) * p2[index] + (t ** 3) * p3[index]
    return (mix(0), mix(1))


def distance_to_polyline(point, polyline):
    best = None
    for start, end in zip(polyline, polyline[1:]):
        dx, dy = end[0] - start[0], end[1] - start[1]
        span = math.hypot(dx, dy)
        if span == 0:
            distance = math.hypot(point[0] - start[0], point[1] - start[1])
        else:
            length = max(0.0, min(span, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / span))
            distance = math.hypot(point[0] - (start[0] + dx / span * length), point[1] - (start[1] + dy / span * length))
        best = distance if best is None else min(best, distance)
    return 0.0 if best is None else best


def axis(p0, v0, p1, v1, scale='linear'):
    return {'scale': scale, 'points': [{'pixel': p0, 'value': v0}, {'pixel': p1, 'value': v1}]}


def dummy_series(ident, color, binding='left', y=12345):
    return {'id': ident, 'name': ident, 'color': color, 'axisBinding': binding, 'pointKind': 'curve-sample',
            'points': [{'xPixel': 1, 'yPixel': 1, 'x': 12345, 'y': y, 'valueCandidates': {binding: y},
                        'pixelInterval': [y - 1, y + 1]}]}


def chart(image, axes, series, issues=None):
    geometry = {'schema': 'falsify.chart-geometry.v1', 'status': 'partial' if issues else 'ready',
                'issues': list(issues or ['curves-not-found']), 'axes': axes, 'series': series,
                'provenance': {'engine': 'plottracer', 'revision': 'dcc28a5', 'method': 'oss-pixel-calibration'},
                'pointKind': 'curve-sample', 'calibrationSource': 'caller-selected'}
    y_scales = [item['scale'] for key, item in axes.items() if key != 'x']
    return {'schema': 'falsify.chart-data.v1', 'status': 'partial',
            'image': {'sha256': image['sha256'], 'width': image['width'], 'height': image['height']},
            'columns': ['label', 'value'], 'rows': [['raster', '1']],
            'numericCells': [{'row': 0, 'column': 1, 'raw': '1', 'value': 1, 'unit': None, 'origin': 'pixel-calibrated'}],
            'title': None, 'chartType': 'unknown',
            'axes': {'x': {'label': 'X', 'scale': axes['x']['scale'], 'unit': 'u'},
                     'y': {'label': 'Y', 'scale': y_scales[0] if len(y_scales) == 1 else 'multiple', 'unit': 'u'}},
            'provenance': {'engine': 'plottracer', 'model': None, 'revision': 'dcc28a5', 'device': 'cpu',
                           'method': 'oss-pixel-calibration'},
            'issues': list(issues or ['curves-not-found']), 'rawOutput': 'raster', 'geometry': geometry,
            'pointKind': 'curve-sample'}


def prepare(raw):
    store = evidence.EvidenceStore(ttl_seconds=3600, max_documents=4)
    digest = sha256(raw)
    summary = store.prepare(raw, digest)
    return store, summary['paperId'], digest


def render(store, paper_id, page_index=0, bbox=None, dpi=150):
    return store.render_for_analysis(paper_id, page_index, bbox, dpi=dpi)


def inspect_page(raw, page_index):
    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        page = doc[page_index]
        drawings = []
        for drawing in page.get_drawings(extended=True):
            drawings.append({'type': drawing.get('type'), 'color': list(drawing['color']) if drawing.get('color') else None,
                             'dashes': drawing.get('dashes'), 'items': [
                                 [item[0]] + [[value.x, value.y] for value in item[1:] if isinstance(value, pymupdf.Point)]
                                 for item in drawing.get('items') or []]})
        return page_matrix(page), drawings
    finally:
        doc.close()


def main_pdf():
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.draw_line((40, 250), (360, 50), color=(0, 0, 1), width=2)
    page.draw_bezier((40, 230), (70, 10), (300, 280), (360, 40), color=(1, 0, 0), width=1.5, dashes='[3 2] 0')
    page.draw_rect(pymupdf.Rect(30, 20, 370, 280), color=(0, 0, 0), width=1)
    page.draw_line((30, 150), (370, 150), color=(0.75, 0.75, 0.75), width=0.4)
    page.draw_line((40, 40), (40, 70), color=(0.75, 0.75, 0.75), width=0.4)
    page.draw_line((50, 260), (300, 80), color=(0, 0, 0), width=2)
    page.insert_text((48, 28), 'Tick 10', fontsize=11)
    page.draw_line((50, 80), (120, 90), color=(0, 0.6, 0), width=2)
    page.draw_line((200, 100), (300, 140), color=(0, 0.6, 0), width=2)
    shape = page.new_shape()
    shape.draw_line((60, 40), (90, 60))
    shape.draw_line((140, 40), (180, 70))
    shape.finish(color=(0.2, 0.2, 0.8), width=2, closePath=False)
    shape.commit()
    later = doc.new_page(width=400, height=300)
    later.draw_line((40, 250), (360, 50), color=(0, 1, 0), width=2)
    raw = doc.tobytes()
    doc.close()
    return raw


def clipped_pdf(stream):
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.draw_line((1, 1), (2, 2), color=(0, 0, 0), width=0.2)
    doc.update_stream(page.get_contents()[0], stream)
    raw = doc.tobytes()
    doc.close()
    return raw


def prefer(raw, image, raster, page_index=0, dpi=150, **extra):
    return vectors.prefer_native_paths(raw, page_index=page_index, crop=image['bbox'], dpi=dpi,
                                       width=image['width'], height=image['height'], raster=raster, **extra)


class ImportTests(unittest.TestCase):
    def test_chart_cache_revision_is_the_combined_vector_policy(self):
        self.assertEqual(enrichment.MODEL_REVISIONS['chart'], 'plottracer-dcc28a5-vector-2')

    def test_parent_module_does_not_import_heavy_packages(self):
        script = ('import json,sys\n'
                  'sys.path.insert(0, sys.argv[1])\n'
                  'before=set(sys.modules)\n'
                  'import paper_chart_vectors, paper_enrichment\n'
                  'paper_enrichment.capability()\n'
                  'roots={name.split(".")[0] for name in set(sys.modules)-before}\n'
                  'print(json.dumps(sorted(roots & set(sys.argv[2].split(",")))))\n')
        completed = subprocess.run([sys.executable, '-c', script, str(LOCAL), ','.join(HEAVY)],
                                   capture_output=True, text=True, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), '[]')


class GeometryRowsTests(unittest.TestCase):
    def test_point_origin_and_optional_metadata_are_propagated(self):
        geometry = {'status': 'ready', 'issues': [], 'axes': {'x': {'scale': 'linear'}, 'left': {'scale': 'linear'}},
                    'series': [{'id': 'series-1', 'axisBinding': 'left', 'points': [
                        {'x': 1, 'y': -2, 'xPixel': 10, 'yPixel': 20, 'pixelInterval': [-2.2, -1.8],
                         'origin': 'pdf-vector-calibrated', 'role': 'source-endpoint',
                         'requestedColor': '#0000ff', 'effectiveColor': '#0000ff'},
                        {'x': 2, 'y': 3, 'xPixel': 30, 'yPixel': 40, 'pixelInterval': [2.8, 3.2],
                         'origin': 'curve-interpolated', 'role': 'curve-sample'},
                        {'x': 3, 'y': 4, 'xPixel': 50, 'yPixel': 60, 'pixelInterval': [3.8, 4.2]}]}]}
        result = paper_chart._geometry_result(geometry, {'sha256': 'c' * 64, 'width': 80, 'height': 80})
        origins = [cell['origin'] for cell in result['numericCells'] if cell['column'] == 3]
        self.assertEqual(origins, ['pdf-vector-calibrated', 'curve-interpolated', 'pixel-calibrated'])
        self.assertEqual(result['numericCells'][1]['role'], 'source-endpoint')
        self.assertEqual(result['numericCells'][1]['requestedColor'], '#0000ff')
        self.assertNotIn('role', result['numericCells'][5])
        self.assertEqual(result['rows'][0][3], '-2')


class NativePathTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = main_pdf()
        cls.before_page1 = inspect_page(cls.raw, 1)
        cls.store, cls.pid, cls.digest = prepare(cls.raw)
        cls.image = render(cls.store, cls.pid)
        cls.matrix, cls.drawings = inspect_page(cls.raw, 0)

    def pixels(self, x, y, image=None, matrix=None, dpi=150):
        image = self.image if image is None else image
        return page_pixel(x, y, image['bbox'], dpi, self.matrix if matrix is None else matrix)

    def calibrated(self, axes, series):
        return chart(self.image, axes, series)

    def test_line_cubic_frames_and_separate_subpaths(self):
        x0, y0 = self.pixels(40, 250)
        x1, y1 = self.pixels(360, 50)
        cx0, cy0 = self.pixels(40, 230)
        cx1, cy1 = self.pixels(360, 40)
        axes = {'x': axis(x0, -2, x1, 8), 'left': axis(y0, -4, y1, 6), 'right': axis(cy0, 10, cy1, 1000, 'log')}
        series = [dummy_series('blue', '#0000ff'), dummy_series('red', '#ff0000', 'right'),
                  dummy_series('black', '#000000'), dummy_series('gap', '#009900'), dummy_series('jump', '#3333cc')]
        buf = bytearray(self.raw)
        result = prefer(buf, self.image, self.calibrated(axes, series))
        self.assertEqual(bytes(buf), self.raw)
        self.assertEqual(self.store.source_bytes(self.pid, self.digest), self.raw)
        self.assertEqual(inspect_page(self.raw, 1), self.before_page1)
        self.assertEqual(result['provenance']['method'], 'oss-pixel-calibration')
        self.assertEqual(result['provenance']['vector'], 'pdf-native-path')
        self.assertEqual(result['axes']['x']['label'], 'X')
        self.assertEqual(result['pointKind'], 'source-vector')
        self.assertNotIn('curves-not-found', result['issues'])
        by_id = {item['id']: item for item in result['geometry']['series']}
        self.assertEqual(set(by_id), {'blue', 'red', 'black', 'gap', 'gap-2', 'jump', 'jump-2'})
        blue, red, black = by_id['blue'], by_id['red'], by_id['black']
        self.assertEqual([(point['x'], point['y'], point['origin']) for point in blue['points']],
                         [(-2, -4, 'pdf-vector-calibrated'), (8, 6, 'pdf-vector-calibrated')])
        self.assertEqual(blue['sourceStroke']['commands'], [{'op': 'l', 'points': [[40.0, 250.0], [360.0, 50.0]]}])
        self.assertEqual(blue['sourceStroke']['sourceSha256'], self.digest)
        self.assertEqual(blue['sourceStroke']['pageIndex'], 0)
        self.assertEqual(blue['sourceStroke']['crop'], self.image['bbox'])
        self.assertEqual(blue['sourceStroke']['dpi'], 150)
        self.assertTrue(all(cell['origin'] == 'pdf-vector-calibrated' for cell in result['numericCells']
                            if cell['row'] == 0 and cell['column'] == 3))
        cubic = red['sourceStroke']['commands']
        self.assertEqual(cubic, [{'op': 'c', 'points': [[40.0, 230.0], [70.0, 10.0], [300.0, 280.0], [360.0, 40.0]]}])
        self.assertIn('3', str(red['sourceStroke']['style']['dashes']))
        self.assertEqual(red['points'][0]['origin'], 'pdf-vector-calibrated')
        self.assertEqual(red['points'][-1]['origin'], 'pdf-vector-calibrated')
        self.assertTrue(all(point['origin'] == 'curve-interpolated' for point in red['points'][1:-1]))
        self.assertGreater(red['sampling']['curveSamples'], 0)
        self.assertEqual(red['points'][0]['y'], 10)
        self.assertEqual(red['points'][-1]['y'], 1000)
        convert = paper_digitizer._axis(axes['right'], self.image['height'])
        for point in red['points']:
            self.assertAlmostEqual(point['y'], convert(point['yPixel']), places=9)
            recovered = unmap_pixel(point['xPixel'], point['yPixel'], self.image['bbox'], 150, self.matrix)
            for control in ((70.0, 10.0), (300.0, 280.0)):
                self.assertGreater(math.hypot(recovered[0] - control[0], recovered[1] - control[1]), 1)
        expected = bezier((40, 230), (70, 10), (300, 280), (360, 40), 0.5)
        recovered_points = [unmap_pixel(point['xPixel'], point['yPixel'], self.image['bbox'], 150, self.matrix)
                            for point in red['points']]
        nearest = min(recovered_points, key=lambda point: math.hypot(point[0] - expected[0], point[1] - expected[1]))
        self.assertAlmostEqual(nearest[0], expected[0], places=6)
        self.assertAlmostEqual(nearest[1], expected[1], places=6)
        self.assertEqual(red['points'][0]['sourcePoint'], [40.0, 230.0])
        self.assertEqual(red['points'][-1]['sourcePoint'], [360.0, 40.0])
        self.assertEqual(red['points'][0]['sourcePointSpace'], 'page-rect')
        self.assertEqual(red['points'][0]['sourcePagePoint'], [40.0, 230.0])
        self.assertEqual(red['sourceStroke']['space'], 'unrotated-page-points')
        self.assertEqual(blue['points'][0]['sourcePoint'], [40.0, 250.0])
        self.assertEqual(blue['points'][0]['sourcePagePoint'], [40.0, 250.0])
        self.assertEqual(red['sampling']['method'], 'de-casteljau')
        self.assertLessEqual(red['sampling']['maxDeviationPixels'], 0.25)
        self.assertTrue(red['sampling']['withinTolerance'])
        polyline = [(point['xPixel'], point['yPixel']) for point in red['points']]
        controls = ((40, 230), (70, 10), (300, 280), (360, 40))
        worst = max(distance_to_polyline(self.pixels(*bezier(*controls, step / 200)), polyline) for step in range(201))
        self.assertLessEqual(worst, 0.25)
        self.assertEqual(black['sourceStroke']['commands'], [{'op': 'l', 'points': [[50.0, 260.0], [300.0, 80.0]]}])
        self.assertTrue(all(command['op'] != 're' for item in result['geometry']['series']
                            for command in item['sourceStroke']['commands']))
        self.assertNotIn('#bfbfbf', {item['color'] for item in result['geometry']['series']})
        gaps = [by_id['gap'], by_id['gap-2']]
        self.assertEqual([{tuple(point) for command in item['sourceStroke']['commands'] for point in command['points']}
                          for item in gaps], [{(50.0, 80.0), (120.0, 90.0)}, {(200.0, 100.0), (300.0, 140.0)}])
        jumps = [by_id['jump'], by_id['jump-2']]
        self.assertEqual([item['sourceStroke']['commands'] for item in jumps], [
            [{'op': 'l', 'points': [[60.0, 40.0], [90.0, 60.0]]}],
            [{'op': 'l', 'points': [[140.0, 40.0], [180.0, 70.0]]}]])
        self.assertTrue(all(len(item['points']) == 2 for item in gaps + jumps))

    def test_reversed_log_and_slope_calibration(self):
        x0, y0 = self.pixels(40, 250)
        x1, y1 = self.pixels(360, 50)
        reversed_axis = axis(x0, 8, x1, -2)
        logged = axis(y0, 1000, y1, 10, 'log')
        result = prefer(self.raw, self.image, self.calibrated(
            {'x': reversed_axis, 'left': logged}, [dummy_series('blue', '#0000ff')]))
        blue = result['geometry']['series'][0]
        self.assertEqual([(point['x'], point['y']) for point in blue['points']], [(8, 1000), (-2, 10)])
        slope = (math.log10(10) - math.log10(1000)) / (y1 - y0)
        intercept = math.log10(1000) - slope * y0
        slope_axis = {'scale': 'log', 'slope': slope, 'intercept': intercept, 'usedTicks': [
            {'pixel': y0, 'value': 1000}, {'pixel': (y0 + y1) / 2, 'value': 10 ** (intercept + slope * (y0 + y1) / 2)},
            {'pixel': y1, 'value': 10}]}
        sloped = prefer(self.raw, self.image, chart(self.image, {'x': reversed_axis, 'left': slope_axis},
                                                    [dummy_series('blue', '#0000ff')]))
        self.assertEqual([point['y'] for point in sloped['geometry']['series'][0]['points']], [1000, 10])

    def test_later_page_rotation_crop_and_offset(self):
        image = render(self.store, self.pid, 1)
        matrix, _drawings = inspect_page(self.raw, 1)
        x0, y0 = page_pixel(40, 250, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(360, 50, image['bbox'], 150, matrix)
        result = prefer(self.raw, image, chart(image, {'x': axis(x0, 0, x1, 4), 'left': axis(y0, 1, y1, 5)},
                                               [dummy_series('later', '#00ff00')]), page_index=1)
        self.assertEqual(result['geometry']['series'][0]['sourceStroke']['pageIndex'], 1)
        self.assertEqual(result['geometry']['series'][0]['sourceStroke']['commands'],
                         [{'op': 'l', 'points': [[40.0, 250.0], [360.0, 50.0]]}])
        self.assertEqual([(point['x'], point['y']) for point in result['geometry']['series'][0]['points']], [(0, 1), (4, 5)])
        self.assertNotIn('c', [command['op'] for item in result['geometry']['series'] for command in item['sourceStroke']['commands']])

    def test_rotation_and_selected_crop_use_pixmap_pixels(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_line((40, 250), (360, 50), color=(0, 0, 1), width=2)
        page.set_rotation(90)
        raw = doc.tobytes()
        doc.close()
        store, pid, _digest = prepare(raw)
        for dpi, bbox in ((150, None), (120, [20, 30, 260, 360])):
            image = render(store, pid, bbox=bbox, dpi=dpi)
            matrix, _drawings = inspect_page(raw, 0)
            x0, y0 = page_pixel(40, 250, image['bbox'], dpi, matrix)
            x1, y1 = page_pixel(360, 50, image['bbox'], dpi, matrix)
            result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 10), 'left': axis(y0, -5, y1, 5)},
                                              [dummy_series('blue', '#0000ff')]), dpi=dpi)
            self.assertEqual(result['geometry']['vectorSource']['rotation'], 90)
            self.assertEqual([(round(point['x'], 6), round(point['y'], 6)) for point in result['geometry']['series'][0]['points']],
                             [(0, -5), (10, 5)])
            self.assertAlmostEqual(result['geometry']['series'][0]['points'][0]['xPixel'], x0, places=6)
            mapped = enrichment._map_boxes(result, image['bbox'], image['width'], image['height'])
            point = mapped['geometry']['series'][0]['points'][0]
            end = mapped['geometry']['series'][0]['points'][-1]
            self.assertEqual(point['sourcePointSpace'], 'page-rect')
            self.assertEqual(point['sourcePagePoint'], [40.0, 250.0])
            self.assertEqual(point['sourcePoint'], list(map_point(40, 250, matrix)))
            self.assertEqual(end['sourcePagePoint'], [360.0, 50.0])
            self.assertEqual(end['sourcePoint'], list(map_point(360, 50, matrix)))
            self.assertEqual(result['geometry']['series'][0]['sourceStroke']['space'], 'unrotated-page-points')
            self.assertEqual(result['geometry']['series'][0]['sourceStroke']['commands'][0]['points'][0], [40.0, 250.0])
            self.assertNotEqual(point['sourcePoint'], point['sourcePagePoint'])
            proportional = (image['bbox'][0] + point['xPixel'] / image['width'] * (image['bbox'][2] - image['bbox'][0]),
                            image['bbox'][1] + point['yPixel'] / image['height'] * (image['bbox'][3] - image['bbox'][1]))
            self.assertGreater(math.hypot(proportional[0] - point['sourcePoint'][0], proportional[1] - point['sourcePoint'][1]), 0.02)

    def test_cropbox_and_shifted_mediabox_follow_drawing_space(self):
        doc = pymupdf.open()
        page = doc.new_page(width=500, height=400)
        page.set_cropbox(pymupdf.Rect(50, 30, 450, 330))
        page.draw_line((80, 200), (300, 80), color=(0, 0, 1), width=2)
        cropped = doc.tobytes()
        shifted = pymupdf.open()
        page = shifted.new_page(width=400, height=300)
        page.draw_line((40, 250), (360, 50), color=(0, 0, 1), width=2)
        page.set_mediabox(pymupdf.Rect(10, 20, 410, 320))
        moved = shifted.tobytes()
        shifted.close()
        doc.close()
        for raw, start, end in ((cropped, (80, 200), (300, 80)), (moved, None, None)):
            store, pid, _digest = prepare(raw)
            image = render(store, pid, bbox=[60, 50, 340, 260] if raw is cropped else None)
            matrix, drawings = inspect_page(raw, 0)
            line = next(item for item in drawings if item['items'] and item['items'][0][0] == 'l')
            p0, p1 = line['items'][0][1], line['items'][0][2]
            if start is not None:
                self.assertEqual(p0, [80.0, 200.0])
            x0, y0 = page_pixel(p0[0], p0[1], image['bbox'], 150, matrix)
            x1, y1 = page_pixel(p1[0], p1[1], image['bbox'], 150, matrix)
            result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 3), 'left': axis(y0, -1, y1, 4)},
                                              [dummy_series('blue', '#0000ff')]))
            self.assertEqual(result['geometry']['series'][0]['sourceStroke']['commands'][0]['points'], [p0, p1])
            self.assertEqual([(point['x'], point['y']) for point in result['geometry']['series'][0]['points']], [(0, -1), (3, 4)])
            mapped = enrichment._map_boxes(result, image['bbox'], image['width'], image['height'])
            for endpoint, command in zip(mapped['geometry']['series'][0]['points'], (p0, p1)):
                self.assertEqual(endpoint['sourcePointSpace'], 'page-rect')
                self.assertEqual(endpoint['sourcePagePoint'], command)
                self.assertEqual(endpoint['sourcePoint'], list(map_point(command[0], command[1], matrix)))

    def test_non_vector_ambiguous_and_plot_miss_keep_the_raster_object(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.insert_text((40, 40), 'no vectors', fontsize=12)
        raw = doc.tobytes()
        doc.close()
        store, pid, _digest = prepare(raw)
        image = render(store, pid)
        raster = chart(image, {'x': axis(10, 0, 100, 1), 'left': axis(10, 0, 100, 1)}, [dummy_series('blue', '#0000ff')])
        self.assertIs(prefer(raw, image, raster), raster)
        x0, y0 = self.pixels(40, 250)
        x1, y1 = self.pixels(360, 50)
        ambiguous = chart(self.image, {'x': axis(x0, 0, x1, 1), 'left': axis(y0, 0, y1, 1)},
                          [dummy_series('blue', '#0000ff', 'ambiguous')])
        self.assertIs(prefer(self.raw, self.image, ambiguous), ambiguous)
        same = chart(self.image, {'x': axis(x0, 0, x1, 1), 'left': axis(y0, 0, y1, 1)},
                     [dummy_series('a', '#0000ff'), dummy_series('b', '#0000ff')])
        self.assertIs(prefer(self.raw, self.image, same), same)
        missed = chart(self.image, {'x': axis(x0, 0, x1, 1), 'left': axis(y0, 0, y1, 1)}, [dummy_series('blue', '#0000ff')])
        missed['geometry']['plotBbox'] = [0, 0, 5, 5]
        self.assertIs(prefer(self.raw, self.image, missed), missed)

    def test_uncertain_clip_keeps_raster_points_and_records_the_original_commands(self):
        full = b'q 20 30 360 240 re W n 0 0 1 RG 2 w 40 250 m 360 50 l S Q\n'
        cut = b'q 60 40 200 180 re W n 0 0 1 RG 2 w 40 250 m 360 50 l S Q\n'
        triangle = b'q 30 20 m 370 20 l 200 280 l h W n 0 0 1 RG 2 w 40 250 m 360 50 l S Q\n'
        contained, _points = self.clip_result(full)
        self.assertEqual([(point['x'], point['y']) for point in contained['geometry']['series'][0]['points']], [(0, -3), (9, 7)])
        self.assertNotIn('rejectedVectors', contained['geometry'])
        for stream in (cut, triangle):
            fallback, points = self.clip_result(stream)
            self.assertEqual(fallback['rows'], [['raster', '1']])
            self.assertEqual(fallback['geometry']['series'][0]['points'][0]['y'], 12345)
            self.assertEqual(fallback['geometry']['rejectedVectors'][0]['reason'], 'clip-uncertain')
            self.assertEqual(fallback['geometry']['rejectedVectors'][0]['commands'][0]['points'], points)

    def clip_result(self, stream):
        raw = clipped_pdf(stream)
        store, pid, _digest = prepare(raw)
        image = render(store, pid)
        matrix, drawings = inspect_page(raw, 0)
        stroke = next(item for item in drawings if item['type'] in ('s', 'fs') and item['items'] and item['items'][0][0] == 'l')
        p0, p1 = stroke['items'][0][1], stroke['items'][0][2]
        x0, y0 = page_pixel(p0[0], p0[1], image['bbox'], 150, matrix)
        x1, y1 = page_pixel(p1[0], p1[1], image['bbox'], 150, matrix)
        raster = chart(image, {'x': axis(x0, 0, x1, 9), 'left': axis(y0, -3, y1, 7)}, [dummy_series('blue', '#0000ff')])
        return prefer(raw, image, raster), [p0, p1]


class AnalyzeIntegrationTests(unittest.TestCase):
    def test_analyze_prefers_native_paths_and_leaves_source_bytes_unchanged(self):
        raw = main_pdf()
        store, pid, digest = prepare(raw)
        image = render(store, pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 250, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(360, 50, image['bbox'], 150, matrix)
        axes = {'x': axis(x0, 0, x1, 10), 'left': axis(y0, -6, y1, 6)}
        calls = []

        def runner(kind, png, language, cancelled, chart_options=None):
            calls.append(kind)
            width, height = png_size(png)
            rendered = {'sha256': sha256(png), 'width': width, 'height': height}
            return chart(rendered, axes, [dummy_series('blue', '#0000ff'), dummy_series('gap', '#009900')])

        entry = enrichment.analyze({'paperId': pid, 'fileHash': digest, 'kind': 'chart', 'pageIndex': 0},
                                   store=store, runner=runner)
        self.assertEqual(calls, ['chart'])
        self.assertEqual(entry['data']['geometry']['series'][0]['sourceStroke']['commands'][0]['points'],
                         [[40.0, 250.0], [360.0, 50.0]])
        self.assertEqual(entry['data']['geometry']['series'][0]['points'][0]['origin'], 'pdf-vector-calibrated')
        self.assertEqual({item['id'] for item in entry['data']['geometry']['series']}, {'blue', 'gap', 'gap-2'})
        self.assertEqual(len(entry['data']['geometry']['series'][1]['points']), 2)
        self.assertEqual(entry['data']['geometry']['series'][2]['points'][0]['xPixel']
                         != entry['data']['geometry']['series'][1]['points'][1]['xPixel'], True)
        mapped = entry['data']['geometry']['series'][0]['points'][0]
        self.assertEqual(mapped['sourcePoint'], [40.0, 250.0])
        self.assertEqual(mapped['sourcePagePoint'], [40.0, 250.0])
        self.assertEqual(mapped['sourcePointSpace'], 'page-rect')
        self.assertEqual(store.source_bytes(pid, digest), raw)
        self.assertEqual(inspect_page(raw, 1)[1][0]['items'][0][0], 'l')

    def test_run_child_integration_preserves_line_and_cubic(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_line((40, 250), (360, 50), color=(0, 0, 1), width=2)
        page.draw_bezier((40, 230), (70, 10), (300, 280), (360, 40), color=(1, 0, 0), width=2)
        page.draw_rect(pymupdf.Rect(30, 20, 370, 280), color=(0, 0, 0), width=1)
        other = doc.new_page(width=400, height=300)
        other.draw_line((20, 40), (300, 200), color=(0, 1, 0), width=2)
        raw = doc.tobytes()
        doc.close()
        store, pid, digest = prepare(raw)
        image = render(store, pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 250, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(360, 50, image['bbox'], 150, matrix)
        cy0 = page_pixel(40, 230, image['bbox'], 150, matrix)[1]
        cy1 = page_pixel(360, 40, image['bbox'], 150, matrix)[1]
        entry = enrichment.analyze({
            'paperId': pid, 'fileHash': digest, 'kind': 'chart', 'pageIndex': 0,
            'chartOptions': {'imageSha256': image['sha256'], 'plotBbox': [0, 0, image['width'], image['height']],
                             'calibration': {'x': axis(x0, 0, x1, 10), 'y': axis(y0, -3, y1, 4)},
                             'series': [{'id': 'blue', 'color': '#0000ff', 'name': 'line'},
                                        {'id': 'red', 'color': '#ff0000', 'name': 'cubic'}]}}, store=store)
        series = entry['data']['geometry']['series']
        blue = next(item for item in series if item['sourceStroke']['commands'][0]['op'] == 'l')
        red = next(item for item in series if item['sourceStroke']['commands'][0]['op'] == 'c')
        self.assertEqual(blue['sourceStroke']['commands'], [{'op': 'l', 'points': [[40.0, 250.0], [360.0, 50.0]]}])
        self.assertEqual([(point['x'], point['y']) for point in blue['points']], [(0, -3), (10, 4)])
        self.assertEqual(red['sourceStroke']['commands'][0]['points'],
                         [[40.0, 230.0], [70.0, 10.0], [300.0, 280.0], [360.0, 40.0]])
        self.assertEqual(red['points'][0]['origin'], 'pdf-vector-calibrated')
        self.assertEqual(red['points'][1]['origin'], 'curve-interpolated')
        convert = paper_digitizer._axis(axis(y0, -3, y1, 4), image['height'])
        self.assertAlmostEqual(red['points'][0]['y'], convert(cy0), places=6)
        self.assertAlmostEqual(red['points'][-1]['y'], convert(cy1), places=6)
        self.assertEqual(entry['data']['provenance']['vector'], 'pdf-native-path')
        self.assertEqual(store.source_bytes(pid, digest), raw)
        _matrix, later = inspect_page(store.source_bytes(pid, digest), 1)
        self.assertEqual(later[0]['items'][0], ['l', [20.0, 40.0], [300.0, 200.0]])


class VectorRepairTests(unittest.TestCase):
    def test_closed_cubic_step_and_flat_stay_while_grid_and_legend_do_not(self):
        frame = [('l', [(10.0, 10.0), (110.0, 10.0)]), ('l', [(110.0, 10.0), (110.0, 80.0)]),
                 ('l', [(110.0, 80.0), (10.0, 80.0)]), ('l', [(10.0, 80.0), (10.0, 10.0)])]
        step = [('l', [(10.0, 10.0), (40.0, 10.0)]), ('l', [(40.0, 10.0), (40.0, 30.0)]),
                ('l', [(40.0, 30.0), (80.0, 30.0)])]
        self.assertTrue(vectors._rectangle_frame(frame, True))
        self.assertFalse(vectors._rectangle_frame(step, False))
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        shape = page.new_shape()
        shape.draw_bezier((80, 200), (80, 80), (300, 80), (300, 200))
        shape.draw_bezier((300, 200), (300, 260), (80, 260), (80, 200))
        shape.finish(color=(0, 0, 1), width=2, closePath=True)
        shape.commit()
        shape = page.new_shape()
        stair = [(50, 220), (110, 220), (110, 160), (180, 160), (180, 110), (280, 110)]
        for start, end in zip(stair, stair[1:]):
            shape.draw_line(start, end)
        shape.finish(color=(0, 0.6, 0), width=2, closePath=False)
        shape.commit()
        page.draw_line((30, 150), (370, 150), color=(0, 0.6, 0), width=1)
        page.draw_line((30, 190), (370, 190), color=(1, 0.4, 0), width=2)
        shape = page.new_shape()
        shape.draw_line((320, 40), (379.98, 40))
        shape.draw_line((380, 40.02), (380, 79.98))
        shape.draw_line((379.98, 80), (320.02, 80))
        shape.draw_line((320, 79.98), (320, 40.02))
        shape.finish(color=(0, 0.6, 0), width=1, closePath=False)
        shape.commit()
        page.draw_rect(pymupdf.Rect(30, 20, 370, 280), color=(0, 0, 0), width=1)
        raw = doc.tobytes()
        doc.close()
        store, _pid, _digest = prepare(raw)
        image = render(store, _pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 250, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(360, 50, image['bbox'], 150, matrix)

        def pixels(pairs):
            return [{'xPixel': page_pixel(x, y, image['bbox'], 150, matrix)[0],
                     'yPixel': page_pixel(x, y, image['bbox'], 150, matrix)[1],
                     'x': index, 'y': y, 'valueCandidates': {'left': y}}
                    for index, (x, y) in enumerate(pairs)]

        series = [
            dummy_series('loop', '#0000ff'),
            {'id': 'step', 'name': 'step', 'color': '#009900', 'axisBinding': 'left', 'points': pixels(stair)},
            {'id': 'flat', 'name': 'flat', 'color': '#ff6600', 'axisBinding': 'left',
             'points': pixels(((30, 190), (200, 190), (370, 190)))},
        ]
        result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 10), 'left': axis(y0, -2, y1, 8)}, series))
        found = result['geometry']['series']
        loop = next(item for item in found if item['sourceStroke']['commands'][0]['op'] == 'c')
        stepped = next(item for item in found if any(point == [50.0, 220.0] for command in item['sourceStroke']['commands'] for point in command['points']))
        flat = next(item for item in found if item['sourceStroke']['commands'][0]['points'][0] == [30.0, 190.0])
        self.assertTrue(loop['sourceStroke']['style']['closePath'])
        self.assertEqual([command['op'] for command in loop['sourceStroke']['commands']], ['c', 'c'])
        self.assertEqual(loop['points'][0]['sourcePoint'], loop['sourceStroke']['commands'][0]['points'][0])
        self.assertEqual(loop['points'][-1]['sourcePoint'], loop['sourceStroke']['commands'][-1]['points'][-1])
        self.assertIn('pdf-vector-calibrated', {point['origin'] for point in loop['points']})
        self.assertIn('curve-interpolated', {point['origin'] for point in loop['points']})
        self.assertLessEqual(loop['sampling']['maxDeviationPixels'], 0.25)
        self.assertTrue(loop['sampling']['withinTolerance'])
        self.assertEqual(loop['sampling']['method'], 'de-casteljau')
        self.assertGreaterEqual(len(stepped['sourceStroke']['commands']), 5)
        self.assertTrue(all(point['origin'] == 'pdf-vector-calibrated' for point in stepped['points']))
        self.assertFalse(stepped['sourceStroke']['style']['closePath'])
        self.assertEqual(flat['sourceStroke']['commands'][0]['points'], [[30.0, 190.0], [370.0, 190.0]])
        self.assertTrue(all(point['role'] == 'source-endpoint' for point in flat['points']))
        self.assertFalse(any(len(item['sourceStroke']['commands']) == 1 and item['sourceStroke']['commands'][0]['points'][0][1] == 150.0
                             for item in found))
        self.assertFalse(any(310 <= point[0] <= 390 and 30 <= point[1] <= 90
                             for item in found for command in item['sourceStroke']['commands'] for point in command['points']))
        self.assertTrue(all(command['op'] in ('l', 'c') for item in found for command in item['sourceStroke']['commands']))

    def test_effective_color_is_the_match_and_same_ink_stays_raster(self):
        raw = main_pdf()
        store, pid, _digest = prepare(raw)
        image = render(store, pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 250, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(360, 50, image['bbox'], 150, matrix)
        axes = {'x': axis(x0, 0, x1, 1), 'left': axis(y0, 0, y1, 1)}
        chosen = {'id': 'ink', 'name': 'ink', 'color': '#ff00aa', 'requestedColor': '#ff00aa',
                  'effectiveColor': '#0000f0', 'axisBinding': 'left', 'pointKind': 'curve-sample',
                  'points': [{'xPixel': x0, 'yPixel': y0, 'x': 0, 'y': 0, 'valueCandidates': {'left': 0}}]}
        result = prefer(raw, image, chart(image, axes, [chosen]))
        ink = next(item for item in result['geometry']['series'] if item.get('sourceStroke'))
        self.assertEqual(ink['requestedColor'], '#ff00aa')
        self.assertEqual(ink['points'][0]['requestedColor'], '#ff00aa')
        self.assertEqual(ink['effectiveColor'], '#0000ff')
        self.assertEqual(ink['color'], '#0000ff')
        self.assertEqual(ink['sourceStroke']['commands'][0]['points'], [[40.0, 250.0], [360.0, 50.0]])
        other = {'id': 'other', 'name': 'other', 'color': '#00ff88', 'requestedColor': '#00ff88',
                 'effectiveColor': '#0000ee', 'axisBinding': 'left', 'pointKind': 'curve-sample',
                 'points': [{'xPixel': x1, 'yPixel': y1, 'x': 1, 'y': 1, 'valueCandidates': {'left': 1}}]}
        ambiguous = chart(image, axes, [chosen, other])
        self.assertIs(prefer(raw, image, ambiguous), ambiguous)

    def test_zero_opacity_stroke_is_not_a_series(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_line((40, 200), (300, 80), color=(0, 0, 1), width=2, stroke_opacity=0)
        page.draw_line((40, 220), (300, 60), color=(0, 0, 1), width=2)
        raw = doc.tobytes()
        doc.close()
        store, pid, _digest = prepare(raw)
        image = render(store, pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 220, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(300, 60, image['bbox'], 150, matrix)
        result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 4), 'left': axis(y0, -1, y1, 3)},
                                          [dummy_series('blue', '#0000ff')]))
        commands = [item['sourceStroke']['commands'] for item in result['geometry']['series']]
        self.assertEqual(commands, [[{'op': 'l', 'points': [[40.0, 220.0], [300.0, 60.0]]}]])
        self.assertNotIn([40.0, 200.0], commands[0][0]['points'])

    def test_unrelated_drawings_outside_the_crop_do_not_drop_the_curve(self):
        doc = pymupdf.open()
        page = doc.new_page(width=500, height=400)
        page.draw_bezier((180, 300), (220, 120), (360, 280), (420, 140), color=(0, 0, 1), width=2)
        for index in range(401):
            y = 4 + (index % 20) * 0.35
            x = 6 + (index // 20) * 1.1
            page.draw_line((x, y), (x + 6, y), color=(0, 0, 1), width=0.3)
        raw = doc.tobytes()
        doc.close()
        store, pid, digest = prepare(raw)
        image = render(store, pid, bbox=[120, 40, 470, 360])
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(180, 300, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(420, 140, image['bbox'], 150, matrix)
        before = store.source_bytes(pid, digest)
        result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 5), 'left': axis(y0, -2, y1, 6)},
                                          [dummy_series('blue', '#0000ff')]))
        self.assertEqual(store.source_bytes(pid, digest), before)
        self.assertEqual(result['provenance']['vector'], 'pdf-native-path')
        self.assertNotIn('vector-drawing-budget', result['issues'])
        stroke = result['geometry']['series'][0]['sourceStroke']
        self.assertEqual(stroke['commands'][0]['op'], 'c')
        self.assertEqual(stroke['commands'][0]['points'][0], [180.0, 300.0])
        self.assertEqual(stroke['commands'][0]['points'][3], [420.0, 140.0])
        self.assertLessEqual(result['geometry']['series'][0]['sampling']['maxDeviationPixels'], 0.25)

    def test_fractional_crop_keeps_the_pymupdf_source_point(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_line((40, 80), (180, 200), color=(0, 0, 1), width=2)
        raw = doc.tobytes()
        doc.close()
        store, pid, digest = prepare(raw)
        preview = render(store, pid, bbox=[10.4, 20.8, 220.2, 260.7], dpi=150)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 80, preview['bbox'], 150, matrix)
        x1, y1 = page_pixel(180, 200, preview['bbox'], 150, matrix)
        axes = {'x': axis(x0, 0, x1, 9), 'left': axis(y0, -3, y1, 4)}

        def runner(kind, png, language, cancelled, chart_options=None):
            width, height = png_size(png)
            return chart({'sha256': sha256(png), 'width': width, 'height': height}, axes, [dummy_series('blue', '#0000ff')])

        entry = enrichment.analyze({'paperId': pid, 'fileHash': digest, 'kind': 'chart', 'pageIndex': 0,
                                    'bbox': preview['bbox']}, store=store, runner=runner)
        point = entry['data']['geometry']['series'][0]['points'][0]
        clip, width, height = entry['bbox'], entry['inputImage']['width'], entry['inputImage']['height']
        self.assertNotEqual(clip[0], round(clip[0]))
        zoom = 150 / 72
        true = ((point['xPixel'] + math.floor(clip[0] * zoom)) / zoom,
                (point['yPixel'] + math.floor(clip[1] * zoom)) / zoom)
        proportional = (clip[0] + point['xPixel'] / width * (clip[2] - clip[0]),
                        clip[1] + point['yPixel'] / height * (clip[3] - clip[1]))
        self.assertEqual(point['sourcePoint'], [40.0, 80.0])
        self.assertEqual(point['sourcePagePoint'], [40.0, 80.0])
        self.assertEqual(point['sourcePointSpace'], 'page-rect')
        self.assertAlmostEqual(true[0], 40.0, places=6)
        self.assertAlmostEqual(true[1], 80.0, places=6)
        self.assertGreater(math.hypot(true[0] - proportional[0], true[1] - proportional[1]), 0.01)
        self.assertEqual(store.source_bytes(pid, digest), raw)

    def test_point_budget_records_a_real_cubic_error(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_bezier((50, 150), (50, 20), (350, 280), (350, 150), color=(0, 0, 1), width=2)
        raw = doc.tobytes()
        doc.close()
        store, pid, _digest = prepare(raw)
        image = render(store, pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, _y_end = page_pixel(50, 150, image['bbox'], 150, matrix)
        x1, _y_end = page_pixel(350, 150, image['bbox'], 150, matrix)
        _x_span, y0 = page_pixel(50, 20, image['bbox'], 150, matrix)
        _x_span, y1 = page_pixel(350, 280, image['bbox'], 150, matrix)
        original = vectors._series_budget
        vectors._series_budget = lambda _count: 3
        try:
            result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 2), 'left': axis(y0, -4, y1, 4)},
                                              [dummy_series('blue', '#0000ff')]))
        finally:
            vectors._series_budget = original
        series = result['geometry']['series'][0]
        self.assertEqual(series['sourceStroke']['commands'][0]['points'],
                         [[50.0, 150.0], [50.0, 20.0], [350.0, 280.0], [350.0, 150.0]])
        self.assertGreater(series['sampling']['maxDeviationPixels'], 0.25)
        self.assertFalse(series['sampling']['withinTolerance'])
        self.assertEqual(series['sampling']['method'], 'de-casteljau')
        self.assertEqual(series['sampling']['tolerancePixels'], 0.25)
        self.assertIn('sampling-point-limit', result['issues'])
        self.assertEqual(series['points'][0]['origin'], 'pdf-vector-calibrated')
        self.assertEqual(series['points'][-1]['origin'], 'pdf-vector-calibrated')
        self.assertEqual(series['points'][0]['sourcePoint'], [50.0, 150.0])
        self.assertEqual(series['points'][0]['sourcePagePoint'], [50.0, 150.0])
        self.assertTrue(any(point['origin'] == 'curve-interpolated' for point in series['points']))

    def test_shared_budget_caps_many_cubics_at_480_points(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        controls = []
        for index in range(11):
            shift = index * 0.2
            curve = [(50.0 + shift, 150.0), (50.0 + shift, 20.0), (350.0 - shift, 280.0), (350.0 - shift, 150.0)]
            controls.append(curve)
            page.draw_bezier(curve[0], curve[1], curve[2], curve[3], color=(0, 0, 1), width=1.5)
        raw = doc.tobytes()
        doc.close()
        store, _pid, _digest = prepare(raw)
        image = render(store, _pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, _ignored = page_pixel(50, 150, image['bbox'], 150, matrix)
        x1, _ignored = page_pixel(350, 150, image['bbox'], 150, matrix)
        _ignored, y0 = page_pixel(50, 20, image['bbox'], 150, matrix)
        _ignored, y1 = page_pixel(350, 280, image['bbox'], 150, matrix)
        result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 2), 'left': axis(y0, -4, y1, 4)},
                                          [dummy_series('blue', '#0000ff')]))
        series = [item for item in result['geometry']['series'] if item.get('sourceStroke')]
        uncapped, _meta = vectors._samples(
            [('c', [tuple(point) for point in controls[0]])], matrix, image['bbox'], 150, 480, False)
        total = sum(len(item['points']) for item in series)
        self.assertEqual(len(series), 11)
        self.assertGreater(len(uncapped) * 11, 480)
        self.assertLessEqual(total, 480)
        self.assertIn('sampling-point-limit', result['issues'])

        def same_curve(command, curve):
            return all(abs(got[0] - expected[0]) < 1e-3 and abs(got[1] - expected[1]) < 1e-3
                       for got, expected in zip(command, curve))

        commands = [item['sourceStroke']['commands'][0]['points'] for item in series]
        for curve in controls:
            self.assertTrue(any(same_curve(command, curve) for command in commands))
        for item in series:
            self.assertLessEqual(len(item['points']), 480 // 11)
            self.assertFalse(item['sampling']['withinTolerance'])
            self.assertEqual(item['points'][0]['origin'], 'pdf-vector-calibrated')
            self.assertEqual(item['points'][-1]['origin'], 'pdf-vector-calibrated')
            self.assertEqual(item['points'][0]['sourcePointSpace'], 'page-rect')

    def test_series_cap_limits_one_color_to_64_components(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        for index in range(70):
            y = 40 + index * 3
            page.draw_line((80, y), (140, y), color=(0, 0, 1), width=1.2)
        raw = doc.tobytes()
        doc.close()
        store, _pid, _digest = prepare(raw)
        image = render(store, _pid)
        result = prefer(raw, image, chart(image, {'x': axis(10, 0, 200, 1), 'left': axis(10, 0, 400, 1)},
                                          [dummy_series('blue', '#0000ff')]))
        series = [item for item in result['geometry']['series'] if item.get('sourceStroke')]
        total = sum(len(item['points']) for item in series)
        self.assertEqual(len(series), 64)
        self.assertLessEqual(total, 480)
        self.assertIn('vector-series-cap', result['issues'])
        self.assertEqual(result['geometry']['status'], 'partial')
        self.assertTrue(all(len(item['sourceStroke']['commands']) == 1 for item in series))

    def test_mixed_native_and_raster_stay_inside_the_global_budget(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        curve = [(50.0, 150.0), (50.0, 20.0), (350.0, 280.0), (350.0, 150.0)]
        page.draw_bezier(*curve, color=(0, 0, 1), width=1.5)
        raw = doc.tobytes()
        doc.close()
        store, _pid, _digest = prepare(raw)
        image = render(store, _pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, _ignored = page_pixel(50, 150, image['bbox'], 150, matrix)
        x1, _ignored = page_pixel(350, 150, image['bbox'], 150, matrix)
        _ignored, y0 = page_pixel(50, 20, image['bbox'], 150, matrix)
        _ignored, y1 = page_pixel(350, 280, image['bbox'], 150, matrix)
        red_points = [{'xPixel': float(index % 80), 'yPixel': 12.0, 'x': index, 'y': 1.0, 'valueCandidates': {'left': 1.0}}
                      for index in range(450)]
        red = {'id': 'red', 'name': 'red', 'color': '#ff0000', 'axisBinding': 'left', 'pointKind': 'curve-sample',
               'points': red_points}
        result = prefer(raw, image, chart(image, {'x': axis(x0, 0, x1, 2), 'left': axis(y0, -4, y1, 4)},
                                          [dummy_series('blue', '#0000ff'), red]))
        series = result['geometry']['series']
        blue = next(item for item in series if item.get('sourceStroke'))
        kept_red = next(item for item in series if item.get('id') == 'red')
        self.assertLessEqual(sum(len(item['points']) for item in series), 480)
        self.assertEqual(len(kept_red['points']), 450)
        self.assertNotIn('sourceStroke', kept_red)
        self.assertEqual(blue['sourceStroke']['commands'][0]['points'][0], [50.0, 150.0])
        self.assertEqual(blue['sourceStroke']['commands'][0]['points'][3], [350.0, 150.0])
        self.assertLessEqual(len(blue['points']), 480 - 450)
        self.assertFalse(blue['sampling']['withinTolerance'])
        self.assertIn('sampling-point-limit', result['issues'])
        self.assertEqual(result['geometry']['status'], 'partial')

    def test_dropped_native_series_reserves_its_raster_points(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        for index in range(64):
            y = 40 + index * 3
            page.draw_line((80, y), (140, y), color=(0, 0, 1), width=1.2)
        page.draw_line((180, 80), (320, 80), color=(1, 0, 0), width=2)
        raw = doc.tobytes()
        doc.close()
        store, _pid, _digest = prepare(raw)
        image = render(store, _pid)
        red_points = [{'xPixel': float(index % 80), 'yPixel': 20.0, 'x': index, 'y': 1.0, 'valueCandidates': {'left': 1.0}}
                      for index in range(400)]
        red = {'id': 'red', 'name': 'red', 'color': '#ff0000', 'axisBinding': 'left', 'pointKind': 'curve-sample',
               'points': red_points}
        result = prefer(raw, image, chart(image, {'x': axis(10, 0, 200, 1), 'left': axis(10, 0, 400, 1)},
                                          [dummy_series('blue', '#0000ff'), red]))
        series = result['geometry']['series']
        total = sum(len(item['points']) for item in series)
        native = [item for item in series if item.get('sourceStroke')]
        kept_red = next(item for item in series if item.get('id') == 'red')
        self.assertLessEqual(total, 480)
        self.assertLessEqual(len(series), 64)
        self.assertEqual(len(kept_red['points']), 400)
        self.assertNotIn('sourceStroke', kept_red)
        self.assertGreater(len(native), 0)
        self.assertLessEqual(sum(len(item['points']) for item in native), 80)
        self.assertIn('vector-series-cap', result['issues'])
        self.assertEqual(result['status'], 'partial')

    def test_partial_later_image_hides_the_stroke(self):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 4, 4), 1)
        png = pix.tobytes('png')
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_line((40, 220), (360, 60), color=(0, 0, 1), width=2)
        page.draw_rect(pymupdf.Rect(180, 120, 230, 180), color=None, fill=(1, 1, 1))
        page.insert_image(pymupdf.Rect(180, 120, 230, 180), stream=png)
        raw = doc.tobytes()
        doc.close()
        store, _pid, _digest = prepare(raw)
        image = render(store, _pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 220, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(360, 60, image['bbox'], 150, matrix)
        raster = chart(image, {'x': axis(x0, 0, x1, 4), 'left': axis(y0, 1, y1, 9)},
                       [dummy_series('blue', '#0000ff', y=3)])
        self.assertIs(prefer(raw, image, raster), raster)
        self.assertEqual(raster['geometry']['series'][0]['points'][0]['y'], 3)
        self.assertNotIn('sourceStroke', raster['geometry']['series'][0])

    def test_later_covering_image_keeps_raster_and_earlier_image_does_not(self):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 4, 4), 1)
        png = pix.tobytes('png')
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_line((40, 200), (300, 80), color=(0, 0, 1), width=2)
        page.draw_rect(pymupdf.Rect(0, 0, 400, 300), color=None, fill=(1, 1, 1))
        page.insert_image(pymupdf.Rect(20, 40, 380, 260), stream=png)
        hidden = doc.tobytes()
        doc.close()
        store, pid, _digest = prepare(hidden)
        image = render(store, pid)
        matrix, _drawings = inspect_page(hidden, 0)
        x0, y0 = page_pixel(40, 200, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(300, 80, image['bbox'], 150, matrix)
        raster = chart(image, {'x': axis(x0, 0, x1, 4), 'left': axis(y0, 1, y1, 9)},
                       [dummy_series('blue', '#0000ff', y=3)])
        self.assertIs(prefer(hidden, image, raster), raster)
        self.assertEqual(raster['geometry']['series'][0]['points'][0]['y'], 3)
        self.assertNotIn('sourceStroke', raster['geometry']['series'][0])

        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.insert_image(pymupdf.Rect(0, 0, 400, 300), stream=png)
        page.draw_line((40, 220), (300, 60), color=(0, 0, 1), width=2)
        shown = doc.tobytes()
        doc.close()
        store, pid, _digest = prepare(shown)
        image = render(store, pid)
        matrix, _drawings = inspect_page(shown, 0)
        x0, y0 = page_pixel(40, 220, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(300, 60, image['bbox'], 150, matrix)
        result = prefer(shown, image, chart(image, {'x': axis(x0, 0, x1, 4), 'left': axis(y0, -1, y1, 3)},
                                            [dummy_series('blue', '#0000ff', y=3)]))
        self.assertEqual(result['geometry']['series'][0]['sourceStroke']['commands'],
                         [{'op': 'l', 'points': [[40.0, 220.0], [300.0, 60.0]]}])
        self.assertNotEqual(result['geometry']['series'][0]['points'][0]['y'], 3)

    def test_blue_context_uses_native_geometry_without_a_second_point_array(self):
        raw = main_pdf()
        store, pid, digest = prepare(raw)
        image = render(store, pid)
        matrix, _drawings = inspect_page(raw, 0)
        x0, y0 = page_pixel(40, 250, image['bbox'], 150, matrix)
        x1, y1 = page_pixel(360, 50, image['bbox'], 150, matrix)
        axes = {'x': axis(x0, 0, x1, 10), 'left': axis(y0, -6, y1, 6)}

        def runner(kind, png, language, cancelled, chart_options=None):
            width, height = png_size(png)
            return chart({'sha256': sha256(png), 'width': width, 'height': height}, axes,
                         [dummy_series('blue', '#0000ff'), dummy_series('red', '#ff0000')])

        entry = enrichment.analyze({'paperId': pid, 'fileHash': digest, 'kind': 'chart', 'pageIndex': 0},
                                   store=store, runner=runner)
        packed = blue.context_for_review(pid, digest, store=store)
        self.assertIn('DERIVED PDF path geometry', packed['text'])
        self.assertIn('not experimental observation', packed['text'])
        self.assertNotIn('PlotTracer pixel coordinates', packed['text'])
        projection = json.loads(next(line for line in packed['text'].splitlines() if '"table-and-vector-summary"' in line))
        self.assertNotIn('numericCells', projection['data'])
        self.assertNotIn('geometry', projection['data'])
        self.assertEqual(projection['data']['geometrySummary']['vectorSource']['space'], 'page-rect')
        cubic = next(item for item in projection['data']['curveSources'] if item['sourceStroke']['commands'][0]['op'] == 'c')
        self.assertEqual(cubic['sourceStroke']['space'], 'unrotated-page-points')
        self.assertEqual(cubic['sourceStroke']['commands'][0]['points'][1], [70.0, 10.0])
        self.assertIn('pdf-vector-calibrated', cubic['origins'])
        self.assertIn('curve-interpolated', cubic['origins'])
        self.assertEqual(cubic['sampling']['method'], 'de-casteljau')
        self.assertNotIn('points', cubic)
        self.assertNotIn('numericCells', cubic)
        self.assertIn('numericCells', entry['data'])
        self.assertGreater(len(entry['data']['geometry']['series'][1]['points']), 2)
        self.assertEqual(store.read_analysis(pid, entry['analysisId']), entry)

    def test_blue_context_preserves_raster_measured_and_interpolated_roles(self):
        raw = main_pdf()
        store, pid, digest = prepare(raw)
        points = [
            {'xPixel': 10, 'yPixel': 20, 'x': 1, 'y': 2, 'origin': 'pixel-calibrated', 'role': 'measured'},
            {'xPixel': 30, 'yPixel': 40, 'x': 3, 'y': 4, 'origin': 'curve-interpolated', 'role': 'bridged'},
        ]
        geometry = {'schema': 'falsify.chart-geometry.v1', 'status': 'ready', 'issues': [],
                    'axes': {'x': {'scale': 'linear'}, 'left': {'scale': 'linear'}},
                    'series': [{'id': 'series-1', 'color': '#123456', 'axisBinding': 'left', 'pointKind': 'curve-sample',
                                'points': points, 'sampling': {'method': 'wpd-xstep', 'tolerancePixels': 0.75}}]}
        data = chart({'sha256': 'c' * 64, 'width': 80, 'height': 80},
                     {'x': axis(0, 0, 10, 1), 'left': axis(0, 0, 10, 1)}, geometry['series'])
        data['geometry'] = geometry
        data['provenance']['method'] = 'oss-pixel-calibration'
        stored = store.add_analysis(pid, {'paperId': pid, 'fileHash': digest, 'kind': 'chart', 'pageIndex': 0,
                                           'bbox': [0, 0, 10, 10],
                                           'inputImage': {'sha256': 'c' * 64, 'width': 80, 'height': 80},
                                           'data': data}, 'wpd-blue')
        packed = blue.context_for_review(pid, digest, store=store)
        self.assertIn('Samples are not independent observations', packed['text'])
        self.assertIn('WPD XStep', packed['text'])
        projection = json.loads(next(line for line in packed['text'].splitlines() if '"table-and-geometry-summary"' in line))
        source = projection['data']['curveSources'][0]
        self.assertEqual(source['origins'], ['pixel-calibrated', 'curve-interpolated'])
        self.assertEqual(source['roles'], ['measured', 'bridged'])
        self.assertEqual(source['sampling']['method'], 'wpd-xstep')
        self.assertNotIn('points', source)
        self.assertNotIn('numericCells', projection['data'])
        self.assertEqual(projection['data']['representation'], 'table-and-geometry-summary')
        self.assertEqual(store.read_analysis(pid, stored['analysisId'])['data']['geometry']['series'][0]['points'], points)


if __name__ == '__main__':
    unittest.main()

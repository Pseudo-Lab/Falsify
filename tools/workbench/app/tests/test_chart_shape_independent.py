"""Independent PDF pipeline: fixture -> prepare_scene -> JS core -> export/render.

Product modules are read-only. Assertions stay at visible ink, byte identity,
and scene data. They are not relaxed when a stage is missing.
"""
import base64
import io
import math
import sys
import unittest
from pathlib import Path

import pikepdf
import pymupdf
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'local'))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import chart_shape_fixture as fixture
import paper_chart_paint as paint
import paper_chart_scene as scene
import paper_chart_shape_core as core

BBOX = [35.0, 40.0, 395.0, 278.0]
DY = -24.0
RADIUS = 12.0


def png_of(data):
    if isinstance(data, str):
        data = base64.b64decode(data)
    return Image.open(io.BytesIO(data)).convert('RGB')


def blue(pixel):
    red, _green, blue_channel = pixel[:3]
    return blue_channel > 140 and red < 130 and blue_channel > red + 50


def red_ink(pixel):
    red, green, blue_channel = pixel[:3]
    return red > 170 and green < 100 and blue_channel < 100


def gray(pixel):
    red, green, blue_channel = pixel[:3]
    return max(pixel[:3]) - min(pixel[:3]) < 18 and 150 < red < 250 and abs(red - green) < 12 and abs(red - blue_channel) < 12


def dark(pixel):
    return pixel[0] < 45 and pixel[1] < 45 and pixel[2] < 45


def _inside(width, height, x, y):
    return 0 <= x < width and 0 <= y < height


def near(image, x, y, pred, radius=2):
    cx, cy = int(round(x)), int(round(y))
    for dy in range(cy - radius, cy + radius + 1):
        for dx in range(cx - radius, cx + radius + 1):
            if _inside(image.width, image.height, dx, dy) and pred(image.getpixel((dx, dy))):
                return True
    return False


def pixmap_near(pix, x, y, pred, radius=2):
    cx, cy = int(round(x)), int(round(y))
    for dy in range(cy - radius, cy + radius + 1):
        for dx in range(cx - radius, cx + radius + 1):
            if _inside(pix.width, pix.height, dx, dy) and pred(pix.pixel(dx, dy)):
                return True
    return False


def pixel_at(image, x, y):
    return image.getpixel((int(round(x)), int(round(y))))


def covered(image, x, y, pred, radius):
    for dy in range(y - radius, y + radius + 1):
        for dx in range(x - radius, x + radius + 1):
            if 0 <= dx < image.width and 0 <= dy < image.height and pred(image.getpixel((dx, dy))):
                return True
    return False


def outside_mask(before, after, pred, radius=3, limit=8):
    found = []
    for y in range(before.height):
        for x in range(before.width):
            if covered(before, x, y, pred, radius) or covered(after, x, y, pred, radius):
                continue
            if before.getpixel((x, y)) != after.getpixel((x, y)):
                found.append((x, y, before.getpixel((x, y)), after.getpixel((x, y))))
                if len(found) >= limit:
                    return found
    return found


def page_bytes(raw):
    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        pages = []
        for page in doc:
            pix = page.get_pixmap(dpi=72, alpha=False)
            pages.append((pix.width, pix.height, bytes(pix.samples), page.get_text('text')))
        return pages
    finally:
        doc.close()


def differing_bbox(before, after):
    width, height, left, _text = before
    _w2, _h2, right, _text2 = after
    if (width, height) != (_w2, _h2) or len(left) != len(right):
        return None
    stride = width * 3
    xs, ys = [], []
    for y in range(height):
        row = y * stride
        if left[row:row + stride] == right[row:row + stride]:
            continue
        ys.append(y)
        for x in range(width):
            i = row + x * 3
            if left[i:i + 3] != right[i:i + 3]:
                xs.append(x)
    if not xs:
        return (None, None, None, None)
    return (min(xs), min(ys), max(xs), max(ys))


def deform(built, series_id, point, radius, dy, dx=0.0):
    return core.evaluate(built, [{
        'id': 'deform-1', 'kind': 'deform', 'seriesId': series_id,
        'center': [point['x'], point['y']], 'radius': radius, 'dx': dx, 'dy': dy,
    }])


def step_distance(points, start, end):
    dist = 0.0
    step = 1 if end > start else -1
    index = start
    while index != end:
        nxt = index + step
        dist += math.hypot(points[nxt]['x'] - points[index]['x'], points[nxt]['y'] - points[index]['y'])
        index = nxt
    return dist


def series_by_color(built, pred):
    found = [item for item in built['series'] if pred(item['color'])]
    if len(found) != 1:
        raise AssertionError('expected one series, got %s' % [item['color'] for item in built['series']])
    return found[0]


def hex_is_blue(value):
    return value.lower() == '#0d66bf'


def hex_blue_dominant(value):
    red = int(value[1:3], 16)
    green = int(value[3:5], 16)
    blue_channel = int(value[5:7], 16)
    return blue_channel > 140 and red < 80 and blue_channel > red + 40 and blue_channel > green


def hex_is_red(value):
    red = int(value[1:3], 16)
    green = int(value[3:5], 16)
    blue_channel = int(value[5:7], 16)
    return red > 170 and green < 100 and blue_channel < 100


def raster_reason(raw):
    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        xobjects = pdf.pages[1].Resources.get('/XObject')
        parts = []
        for key in ([] if xobjects is None else xobjects.keys()):
            obj = xobjects[key]
            colorspace = obj.get('/ColorSpace')
            if isinstance(colorspace, pikepdf.Array):
                alternate = colorspace[1].get('/Alternate') if hasattr(colorspace[1], 'get') else None
                label = '%s Alternate=%s' % (colorspace[0], alternate)
            else:
                label = str(colorspace)
            width, height = int(obj.Width), int(obj.Height)
            parts.append('%s %s %sx%s decoded=%s rgb-bytes=%s' % (
                key, label, width, height, len(obj.read_bytes()), width * height * 3))
        return 'fixture page 1 prepared no series; ' + '; '.join(parts)
    finally:
        pdf.close()


def curve_tail(raw):
    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        blobs = [stream.read_bytes() for stream in pdf.pages[0].obj.Contents]
    finally:
        pdf.close()
    blob = max(blobs, key=len)
    return blob[-80:]


class FixturePipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = fixture.chart_pdf()
        cls.native = scene.prepare_scene(cls.raw, 0, BBOX)
        cls.raster = scene.prepare_scene(cls.raw, 1, BBOX)

    def test_native_scene_matches_fixture_ink(self):
        built = self.native
        self.assertEqual(built['schema'], 'falsify.chart-scene.v1')
        self.assertEqual(built['pageIndex'], 0)
        self.assertEqual(built['revision'], 0)
        self.assertEqual([round(value, 4) for value in built['bbox']], BBOX)
        self.assertEqual(built['width'], 360)
        self.assertEqual(built['height'], 238)
        self.assertEqual(len(built['series']), 1)
        series = built['series'][0]
        self.assertTrue(hex_is_blue(series['color']))
        self.assertEqual(series['sourceBinding']['kind'], 'native-path')
        self.assertEqual(len(series['points']), 101)
        self.assertEqual(series['style']['width'], 1.8)
        self.assertTrue(all(point['origin'] == 'pdf-vector' for point in series['points']))
        original = png_of(built['originalPng'])
        anchor = series['points'][50]
        self.assertTrue(near(original, anchor['x'], anchor['y'], blue), pixel_at(original, anchor['x'], anchor['y']))
        background = png_of(built['backgroundPng'])
        self.assertGreater(sum(blue(original.getpixel((x, y))) for y in range(original.height) for x in range(0, original.width, 2)), 40)
        self.assertLess(
            sum(blue(background.getpixel((x, y))) for y in range(background.height) for x in range(0, background.width, 2)),
            8)

    def test_identity_evaluate_exports_exact_bytes(self):
        anchor_y = self.native['series'][0]['points'][50]['y']
        same = core.evaluate(self.native, [])
        self.assertEqual(sorted(same), ['changes', 'scene'])
        self.assertEqual(same['changes'], [])
        self.assertEqual(same['scene']['series'][0]['points'], self.native['series'][0]['points'])
        self.assertEqual(self.native['series'][0]['points'][50]['y'], anchor_y)
        output, report = paint.export_scene(self.raw, self.native, same['scene'])
        self.assertTrue(report['noop'])
        self.assertEqual(report['schema'], 'falsify.chart-paint-report.v1')
        self.assertEqual(output, self.raw)
        rendered = paint.render_scene(self.raw, self.native, same['scene'])
        self.assertTrue(rendered['noop'])
        self.assertEqual(rendered['mime'], 'image/png')
        self.assertTrue(rendered['png'].startswith(b'\x89PNG'))

    def test_deform_uses_curve_sample_and_gaussian_support(self):
        series = self.native['series'][0]
        anchor = 50
        point = series['points'][anchor]
        before = [(item['x'], item['y'], item['origin']) for item in series['points']]
        edited = deform(self.native, series['id'], point, RADIUS, DY)
        self.assertEqual(sorted(edited), ['changes', 'scene'])
        change = edited['changes'][0]
        self.assertEqual(change['kind'], 'deform')
        self.assertEqual(change['seriesId'], series['id'])
        self.assertIn(anchor, change['indexes'])
        moved = edited['scene']['series'][0]['points']
        self.assertEqual(before, [(item['x'], item['y'], item['origin']) for item in series['points']])
        self.assertAlmostEqual(moved[anchor]['y'] - point['y'], DY, places=6)
        self.assertEqual(moved[anchor]['x'], point['x'])
        self.assertEqual(moved[anchor]['origin'], 'pdf-vector')
        self.assertEqual(len(moved), len(series['points']))
        for index in (0, len(moved) - 1):
            self.assertEqual((moved[index]['x'], moved[index]['y']), (series['points'][index]['x'], series['points'][index]['y']))
        for index, item in enumerate(moved):
            if index not in change['indexes']:
                self.assertEqual((item['x'], item['y']), (series['points'][index]['x'], series['points'][index]['y']))
        neighbor = anchor - 1
        distance = step_distance(series['points'], anchor, neighbor)
        self.assertLess(distance, RADIUS)
        tent = DY * (1.0 - distance / RADIUS)
        actual = moved[neighbor]['y'] - series['points'][neighbor]['y']
        self.assertLess(actual, tent - 0.5)
        self.assertGreater(abs(moved[anchor]['y'] - point['y']), abs(actual))
        farther = min(change['indexes'])
        self.assertGreater(abs(actual), abs(moved[farther]['y'] - series['points'][farther]['y']))

    def test_deform_paints_new_ink_and_preserves_other_pages(self):
        series = self.native['series'][0]
        point = series['points'][50]
        edited = deform(self.native, series['id'], point, RADIUS, DY)
        output, report = paint.export_scene(self.raw, self.native, edited['scene'])
        self.assertFalse(report['noop'])
        self.assertEqual(report['mode'], 'native')
        self.assertEqual(report['changedSeries'], [series['id']])
        self.assertNotEqual(output, self.raw)
        rendered = png_of(paint.render_scene(self.raw, self.native, edited['scene'])['png'])
        moved = edited['scene']['series'][0]['points'][50]
        self.assertTrue(near(rendered, moved['x'], moved['y'], blue, 2), pixel_at(rendered, moved['x'], moved['y']))
        again = scene.prepare_scene(output, 0, BBOX)
        self.assertEqual(len(again['series']), 1)
        self.assertTrue(hex_is_blue(again['series'][0]['color']))
        self.assertEqual(again['series'][0]['style']['width'], 1.8)
        recovered = again['series'][0]['points']
        self.assertGreaterEqual(len(recovered), 101)
        self.assertLess(min(math.hypot(p['x']-moved['x'],p['y']-moved['y']) for p in recovered), 0.02)
        self.assertNotIn(b'1 1 1 rg', curve_tail(output))
        self.assertNotIn(b'1 1 1 RG', curve_tail(output))
        source_pages = page_bytes(self.raw)
        edited_pages = page_bytes(output)
        self.assertEqual(len(edited_pages), 3)
        for index in range(3):
            self.assertEqual(edited_pages[index][3], source_pages[index][3])
        self.assertEqual(edited_pages[1][:3], source_pages[1][:3])
        self.assertEqual(edited_pages[2][:3], source_pages[2][:3])
        box = differing_bbox(source_pages[0], edited_pages[0])
        self.assertIsNotNone(box[0])
        self.assertGreaterEqual(box[0], BBOX[0] - 2)
        self.assertGreaterEqual(box[1], BBOX[1] - 2)
        self.assertLessEqual(box[2], BBOX[2] + 2)
        self.assertLessEqual(box[3], BBOX[3] + 2)

    def test_deform_clears_old_stroke_and_restores_grid(self):
        series = self.native['series'][0]
        point = series['points'][50]
        before = png_of(self.native['originalPng'])
        self.assertTrue(near(before, point['x'], point['y'], blue, 1))
        edited = deform(self.native, series['id'], point, RADIUS, DY)
        rendered = png_of(paint.render_scene(self.raw, self.native, edited['scene'])['png'])
        moved = edited['scene']['series'][0]['points'][50]
        self.assertGreater(abs(moved['y'] - point['y']), 20)
        self.assertTrue(near(rendered, moved['x'], moved['y'], blue, 2))
        column, row = int(round(point['x'])), int(round(point['y']))
        grid = before.getpixel((column, 40))
        self.assertEqual(max(grid) - min(grid), 0)
        self.assertGreater(grid[0], 220)
        self.assertLess(grid[0], 255)
        self.assertEqual(rendered.getpixel((column, row)), grid)
        self.assertFalse(near(rendered, point['x'], point['y'], blue, 1), rendered.getpixel((column, row)))

    def test_nonedit_mask_keeps_distant_grid_and_text(self):
        series = self.native['series'][0]
        point = series['points'][50]
        before = png_of(self.native['originalPng'])
        edited = deform(self.native, series['id'], point, RADIUS, DY)
        after = png_of(paint.render_scene(self.raw, self.native, edited['scene'])['png'])
        self.assertEqual(before.size, after.size)
        leaked = outside_mask(before, after, blue, 3)
        self.assertEqual(leaked, [])
        text_pixel = next((x, y) for y in range(before.height) for x in range(before.width)
                          if dark(before.getpixel((x, y))) and math.hypot(x - point['x'], y - point['y']) > 80)
        grid_pixel = next((x, y) for y in range(before.height) for x in range(before.width)
                          if gray(before.getpixel((x, y))) and math.hypot(x - point['x'], y - point['y']) > 80)
        self.assertEqual(after.getpixel(text_pixel), before.getpixel(text_pixel))
        self.assertEqual(after.getpixel(grid_pixel), before.getpixel(grid_pixel))
        self.assertTrue(gray(after.getpixel(grid_pixel)))

    def test_raster_identity_exports_exact_bytes(self):
        same = core.evaluate(self.raster, [])
        self.assertEqual(same['changes'], [])
        output, report = paint.export_scene(self.raw, self.raster, same['scene'])
        self.assertTrue(report['noop'])
        self.assertEqual(output, self.raw)

    def test_raster_page_prepares_series_and_restores_grid_crossing(self):
        built = self.raster
        self.assertGreaterEqual(len(built['series']), 1, raster_reason(self.raw))
        series = built['series'][0]
        self.assertEqual(series['sourceBinding']['kind'], 'raster-image')
        self.assertGreaterEqual(len(series['points']), 2)
        original = png_of(built['originalPng'])
        # Known source grid: image x=68, placed at 0.5pt/px, crop origin x=35.
        # Its crop x is 45 + 68*0.5 - 35 = 44, away from image-edge antialiasing.
        index = min(range(len(series['points'])), key=lambda i: abs(series['points'][i]['x'] - 44))
        point = series['points'][index]
        self.assertLess(abs(point['x'] - 44), 0.2)
        x, y = int(round(point['x'])), int(round(point['y']))
        self.assertTrue(near(original, x, y, blue, 1))
        edited = deform(built, series['id'], series['points'][index], 18, -28)
        self.assertIn(index, edited['changes'][0]['indexes'])
        output, report = paint.export_scene(self.raw, built, edited['scene'])
        self.assertFalse(report['noop'])
        self.assertEqual(report['mode'], 'raster')
        self.assertIn(series['id'], report['changedSeries'])
        rendered = png_of(paint.render_scene(self.raw, built, edited['scene'])['png'])
        self.assertFalse(blue(rendered.getpixel((x, y))), rendered.getpixel((x, y)))
        self.assertTrue(gray(rendered.getpixel((x, y))), rendered.getpixel((x, y)))
        self.assertEqual(outside_mask(original, rendered, blue, 4), [])
        source_pages = page_bytes(self.raw)
        edited_pages = page_bytes(output)
        self.assertEqual(edited_pages[0][:3], source_pages[0][:3])
        self.assertEqual(edited_pages[2][:3], source_pages[2][:3])
        self.assertEqual(edited_pages[1][3], source_pages[1][3])


def two_color_pdf(raw):
    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        doc[0].draw_line((70, 70), (340, 210), color=(0.85, 0.12, 0.1), width=3)
        return doc.tobytes()
    finally:
        doc.close()


class TwoColorTests(unittest.TestCase):
    def test_unedited_color_and_its_grid_crossing_stay(self):
        raw = two_color_pdf(fixture.chart_pdf())
        built = scene.prepare_scene(raw, 0, BBOX)
        colors = [item['color'] for item in built['series']]
        self.assertEqual(len(built['series']), 2, colors)
        blue_series = series_by_color(built, hex_is_blue)
        red_series = series_by_color(built, hex_is_red)
        self.assertEqual(len(blue_series['points']), 101)
        self.assertGreaterEqual(len(red_series['points']), 2)
        self.assertEqual(red_series['sourceBinding']['kind'], 'native-path')
        before = png_of(built['originalPng'])
        red_point = red_series['points'][0]
        self.assertTrue(near(before, red_point['x'], red_point['y'], red_ink, 2), pixel_at(before, red_point['x'], red_point['y']))
        anchor = blue_series['points'][50]
        edited = deform(built, blue_series['id'], anchor, RADIUS, DY)
        self.assertEqual(edited['changes'][0]['seriesId'], blue_series['id'])
        red_after = next(item for item in edited['scene']['series'] if item['id'] == red_series['id'])
        self.assertEqual(red_after['points'], red_series['points'])
        self.assertEqual(red_after['color'], red_series['color'])
        output, report = paint.export_scene(raw, built, edited['scene'])
        self.assertEqual(report['changedSeries'], [blue_series['id']])
        rendered = png_of(paint.render_scene(raw, built, edited['scene'])['png'])
        self.assertTrue(near(rendered, red_point['x'], red_point['y'], red_ink, 2))
        spot = next((x, y) for y in range(before.height) for x in range(before.width)
                    if red_ink(before.getpixel((x, y))) and math.hypot(x - anchor['x'], y - anchor['y']) > 40)
        self.assertEqual(rendered.getpixel(spot), before.getpixel(spot))
        self.assertEqual(page_bytes(output)[1:], [item for item in page_bytes(raw)[1:]])
        self.assertEqual(page_bytes(output)[0][3], page_bytes(raw)[0][3])


def shared_form_pdf():
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 300))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    form_data = b'1 0 0 RG 2 w 10 80 m 90 20 l S 0 0 1 RG 1.5 w 10 40 m 30 10 70 70 90 30 c S'
    form = pdf.make_stream(form_data)
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array([0, 0, 100, 100])
    form.Resources = pikepdf.Dictionary()
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font), XObject=pikepdf.Dictionary(Fm=form))
    page.Contents = pdf.make_stream(
        b'BT /F1 12 Tf 40 280 Td (Keep) Tj ET\n'
        b'2 w .7 .7 .7 RG 50 40 m 360 40 l S\n'
        b'q 1 0 0 1 30 40 cm /Fm Do Q\n'
        b'q 1 0 0 1 220 40 cm /Fm Do Q\n')
    other = pdf.add_blank_page(page_size=(400, 300))
    other.Contents = pdf.make_stream(b'BT /F1 12 Tf 30 40 Td (Other page) Tj ET\n')
    other.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue(), form_data


class FormAndPageGeometryTests(unittest.TestCase):
    def test_shared_form_clone_keeps_the_other_occurrence(self):
        raw, form_data = shared_form_pdf()
        box = [0, 150, 180, 290]
        built = scene.prepare_scene(raw, 0, box)
        red_series = series_by_color(built, hex_is_red)
        end = max(red_series['points'], key=lambda item: item['x'])
        edited = deform(built, red_series['id'], end, 10, -40)
        self.assertIn(red_series['points'].index(end), edited['changes'][0]['indexes'])
        self.assertAlmostEqual(edited['scene']['series'][0]['points'][red_series['points'].index(end)]['y'], end['y'] - 40, places=5)
        output, report = paint.export_scene(raw, built, edited['scene'])
        self.assertTrue(report['formIsolated'])
        self.assertEqual(report['changedSeries'], [red_series['id']])
        source_pdf = pikepdf.open(io.BytesIO(raw))
        pdf = pikepdf.open(io.BytesIO(output))
        try:
            resources = pdf.pages[0].Resources.XObject
            self.assertEqual(resources['/Fm'].read_bytes(), form_data)
            clones = [str(key) for key in resources.keys() if str(key).startswith('/ChartFm')]
            self.assertEqual(clones, ['/ChartFm1'])
            clone = resources[clones[0]].read_bytes()
            self.assertNotEqual(clone, form_data)
            self.assertIn(b'30 10 70 70 90 30 c', clone)
            self.assertNotIn(b'90 20 l', clone)
            page = pdf.pages[0].Contents.read_bytes()
            self.assertEqual(page.count(b'/Fm Do'), 1)
            self.assertIn(b'/ChartFm1 Do', page)
            self.assertIn(b'(Keep) Tj', page)
            self.assertEqual(pdf.pages[1].Contents.read_bytes(), source_pdf.pages[1].Contents.read_bytes())
        finally:
            pdf.close()
            source_pdf.close()
        source = pymupdf.open(stream=raw, filetype='pdf')
        edited_doc = pymupdf.open(stream=output, filetype='pdf')
        try:
            self.assertEqual(edited_doc[0].get_text('text'), source[0].get_text('text'))
            self.assertEqual(edited_doc[1].get_text('text'), source[1].get_text('text'))
            second = pymupdf.Rect(220, 160, 320, 260)
            before = source[0].get_pixmap(clip=second, dpi=72, alpha=False)
            after = edited_doc[0].get_pixmap(clip=second, dpi=72, alpha=False)
            self.assertEqual(bytes(before.samples), bytes(after.samples))
            self.assertGreater(sum(1 for i in range(0, len(before.samples), 3) if before.samples[i] > 180), 10)
            moved = next(item for item in edited['scene']['series'] if item['id'] == red_series['id'])['points']
            moved_end = max(moved, key=lambda item: item['x'])
            full = edited_doc[0].get_pixmap(dpi=72, alpha=False)
            self.assertTrue(pixmap_near(full, box[0] + moved_end['x'], box[1] + moved_end['y'], red_ink, 2))
            self.assertFalse(pixmap_near(full, box[0] + end['x'], box[1] + end['y'], red_ink, 1))
        finally:
            source.close()
            edited_doc.close()

    def test_cropped_page_deform_moves_ink(self):
        doc = pymupdf.open()
        page = doc.new_page(width=420, height=320)
        page.draw_line((80, 200), (300, 90), color=(0.1, 0.35, 0.85), width=4)
        page.insert_text((40, 36), 'Crop me', fontsize=12)
        page.set_cropbox(pymupdf.Rect(20, 20, 400, 300))
        raw = doc.tobytes()
        doc.close()
        doc = pymupdf.open(stream=raw, filetype='pdf')
        box = [doc[0].rect.x0, doc[0].rect.y0, doc[0].rect.x1, doc[0].rect.y1]
        doc.close()
        built = scene.prepare_scene(raw, 0, box)
        series = series_by_color(built, hex_blue_dominant)
        original = png_of(built['originalPng'])
        self.assertTrue(all(near(original, point['x'], point['y'], blue, 3) for point in series['points']))
        end = max(series['points'], key=lambda item: item['x'])
        edited = deform(built, series['id'], end, 8, 30)
        output, report = paint.export_scene(raw, built, edited['scene'])
        self.assertFalse(report['noop'])
        rendered = png_of(paint.render_scene(raw, built, edited['scene'])['png'])
        moved = next(item for item in edited['scene']['series'] if item['id'] == series['id'])['points']
        moved_end = max(moved, key=lambda item: item['x'])
        self.assertTrue(near(rendered, moved_end['x'], moved_end['y'], blue, 2))
        self.assertFalse(near(rendered, end['x'], end['y'], blue, 1), pixel_at(rendered, end['x'], end['y']))
        self.assertEqual(outside_mask(original, rendered, blue, 3), [])
        source = pymupdf.open(stream=raw, filetype='pdf')
        edited_doc = pymupdf.open(stream=output, filetype='pdf')
        try:
            self.assertEqual(edited_doc[0].get_text('text'), source[0].get_text('text'))
        finally:
            source.close()
            edited_doc.close()

    def test_rotated_page_points_fall_on_ink(self):
        doc = pymupdf.open()
        page = doc.new_page(width=420, height=320)
        page.draw_line((60, 240), (340, 80), color=(1, 0, 0), width=4)
        page.insert_text((40, 30), 'Rotated', fontsize=12)
        page.set_rotation(90)
        raw = doc.tobytes()
        doc.close()
        doc = pymupdf.open(stream=raw, filetype='pdf')
        box = [doc[0].rect.x0, doc[0].rect.y0, doc[0].rect.x1, doc[0].rect.y1]
        rotation = doc[0].rotation
        doc.close()
        self.assertEqual(rotation, 90)
        built = scene.prepare_scene(raw, 0, box)
        series = series_by_color(built, hex_is_red)
        original = png_of(built['originalPng'])
        misses = []
        for point in series['points']:
            if not (0 <= point['x'] < original.width and 0 <= point['y'] < original.height) or not near(original, point['x'], point['y'], red_ink, 3):
                misses.append((round(point['x'], 1), round(point['y'], 1), original.size))
        self.assertEqual(misses, [], 'rotated page points are not on the rendered stroke')


if __name__ == '__main__':
    unittest.main()

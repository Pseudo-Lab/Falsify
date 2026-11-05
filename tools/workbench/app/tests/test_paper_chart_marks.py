"""Bar and scatter operand edits. Synthetic pages only. seqno is not an address."""
import copy
import io
import sys
import unittest
from pathlib import Path

import pikepdf
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_marks as marks


KAPPA = 0.5522847498307936


def circle(cx, cy, radius):
    k = KAPPA * radius
    points = [
        (cx + radius, cy),
        (cx + radius, cy + k), (cx + k, cy + radius), (cx, cy + radius),
        (cx - k, cy + radius), (cx - radius, cy + k), (cx - radius, cy),
        (cx - radius, cy - k), (cx - k, cy - radius), (cx, cy - radius),
        (cx + k, cy - radius), (cx + radius, cy - k), (cx + radius, cy),
    ]

    def num(value):
        text = ('%.5f' % value).rstrip('0').rstrip('.')
        return '0' if text in ('', '-0') else text

    parts = ['%s %s m' % (num(points[0][0]), num(points[0][1]))]
    for index in range(1, 13, 3):
        parts.append(' '.join(num(coord) for point in points[index:index + 3] for coord in point) + ' c')
    return (' '.join(parts) + ' h f').encode('ascii')


def document(stream, second=b'BT /F1 12 Tf 30 40 Td (Other) Tj ET\n20 40 m 80 90 l S\n'):
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    page = pdf.add_blank_page(page_size=(400, 300))
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.Contents = pdf.make_stream(stream)
    other = pdf.add_blank_page(page_size=(400, 300))
    other.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    other.Contents = pdf.make_stream(second)
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def chart_stream():
    return b'\n'.join([
        b'BT /F1 11 Tf 40 270 Td (Keep) Tj ET',
        b'0 0 0 RG 1 w 30 40 m 370 40 l S',
        b'0.75 0.75 0.75 RG 0.6 w 30 100 m 370 100 l S',
        b'0.75 0.75 0.75 RG 0.6 w 20 30 m 20 270 l S',
        b'0.4 0 0 RG 1 w 10 10 15 15 re S',
        b'0.2 0.4 0.8 rg',
        b'60 40 36 90 re f',
        b'120 40 36 140 re f',
        b'180 10 36 30 re f',
        b'0.55 0.28 0.12 rg',
        b'250 40 m 270 40 l 270 110 l 250 110 l h f',
        b'0.1 0.55 0.25 rg',
        circle(300, 100, 6),
        circle(340, 150, 6),
        b'0 0 1 RG 1.5 w 40 80 m 90 140 150 40 210 90 c S',
    ])


def content(raw, index=0):
    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        contents = pdf.pages[index].obj.get('/Contents')
        streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        return b''.join(stream.read_bytes() for stream in streams)
    finally:
        pdf.close()


def series_of(scene, kind, color=None):
    found = [item for item in scene['series'] if item['kind'] == kind and (color is None or item['color'] == color)]
    return found


def move_point(scene, series_id, index, **values):
    edited = copy.deepcopy(scene)
    point = next(item for item in edited['series'] if item['id'] == series_id)['points'][index]
    point.update(values)
    return edited


class MarkPrepareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = document(chart_stream())
        cls.scene = marks.prepare_marks(cls.raw, 0, [0, 0, 400, 300])

    def test_curve_only_page_returns_empty_list(self):
        raw = document(b'BT /F1 11 Tf 40 270 Td (Keep) Tj ET\n0 0 1 RG 2 w 40 80 m 90 140 150 40 210 90 c S\n')
        self.assertEqual(marks.prepare_marks(raw, 0, [0, 0, 400, 300]), [])

    def test_scene_contract(self):
        scene = self.scene
        self.assertEqual(scene['schema'], 'falsify.chart-scene.v1')
        self.assertEqual(scene['mode'], 'marks')
        self.assertEqual(scene['pageIndex'], 0)
        self.assertEqual(scene['width'], 400)
        self.assertEqual(scene['height'], 300)
        self.assertTrue(scene['backgroundPng'])
        self.assertTrue(scene['originalPng'])
        self.assertNotEqual(scene['backgroundPng'], scene['originalPng'])
        kinds = [item['kind'] for item in scene['series']]
        self.assertEqual(kinds, ['bar', 'bar', 'scatter'])
        for item in scene['series']:
            self.assertIn(item['kind'], ('bar', 'scatter'))
            self.assertIn('baseline', item)
            self.assertIn('radius', item)
            self.assertIn('orientation', item)
            binding = item['sourceBinding']
            self.assertNotIn('seqno', binding)
            self.assertNotIn('muSeqno', binding)
            self.assertNotIn('operatorIndex', binding)
            self.assertEqual(len(binding['marks']), len(item['points']))

    def test_groups_aligned_bars_and_keeps_negative(self):
        blue = series_of(self.scene, 'bar', '#3366cc')[0]
        self.assertEqual(blue['orientation'], 'vertical')
        self.assertEqual(len(blue['points']), 3)
        self.assertEqual([round(point['x']) for point in blue['points']], [78, 138, 198])
        self.assertEqual(round(blue['baseline']), 260)
        self.assertGreater(blue['points'][2]['y'], blue['baseline'])
        self.assertLess(blue['points'][0]['y'], blue['baseline'])
        self.assertTrue(all(round(point['width']) == 36 for point in blue['points']))
        path = series_of(self.scene, 'bar', '#8c471f')[0]
        self.assertEqual(len(path['points']), 1)
        self.assertEqual(round(path['points'][0]['width']), 20)

    def test_groups_similar_circles(self):
        scatter = series_of(self.scene, 'scatter')[0]
        self.assertIsNone(scatter['orientation'])
        self.assertEqual(len(scatter['points']), 2)
        self.assertEqual(scatter['color'], '#1a8c40')
        self.assertAlmostEqual(scatter['radius'], 6, places=2)
        self.assertEqual({(round(point['x']), round(point['y'])) for point in scatter['points']}, {(300, 200), (340, 150)})

    def test_background_removes_marks_and_keeps_axis(self):
        import base64
        import cv2
        import numpy as np

        def pixels(encoded):
            raw = base64.b64decode(encoded)
            image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
            self.assertEqual(image.shape[1], 400)
            self.assertEqual(image.shape[0], 300)
            return image

        original = pixels(self.scene['originalPng'])
        background = pixels(self.scene['backgroundPng'])
        # OpenCV is BGR. (215, 78) sits inside the first blue bar; (200, 300) is a marker.
        self.assertGreater(int(original[215, 78, 0]), 150)
        self.assertGreater(int(background[215, 78, 0]), 240)
        self.assertGreater(int(background[215, 78, 1]), 240)
        self.assertGreater(int(original[200, 300, 1]), 80)
        self.assertGreater(int(background[200, 300, 1]), 220)
        self.assertLess(abs(int(background[259, 100, 0]) - int(original[259, 100, 0])), 8)
        self.assertLess(int(background[259, 100, 0]), 180)

    def test_plot_bbox_can_exclude_every_mark(self):
        self.assertEqual(marks.prepare_marks(self.raw, 0, [0, 0, 400, 300], {'plotBbox': [0, 0, 10, 10]}), [])


class MarkExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = document(chart_stream())
        cls.scene = marks.prepare_marks(cls.raw, 0, [0, 0, 400, 300])

    def test_noop_returns_original_bytes(self):
        output, report = marks.export_marks(self.raw, self.scene, copy.deepcopy(self.scene))
        self.assertTrue(report['noop'])
        self.assertEqual(report['mode'], 'unchanged')
        self.assertEqual(output, self.raw)

    def test_bar_height_changes_only_that_operand(self):
        blue = series_of(self.scene, 'bar', '#3366cc')[0]
        edited = move_point(self.scene, blue['id'], 0, y=blue['points'][0]['y'] - 40)
        edited['series'][0]['sourceBinding']['seqno'] = 0
        edited['series'][0]['sourceBinding']['muSeqno'] = 0
        edited['series'][0]['sourceBinding']['operatorIndex'] = 0
        output, report = marks.export_marks(self.raw, self.scene, edited)
        self.assertFalse(report['noop'])
        self.assertEqual(report['changedSeries'], [blue['id']])
        new, old = content(output), content(self.raw)
        self.assertIn(b'60 40 36 90 re', old)
        self.assertNotIn(b'60 40 36 90 re', new)
        self.assertIn(b'60 40 36 130 re', new)
        self.assertIn(b'120 40 36 140 re', new)
        self.assertIn(b'180 10 36 30 re', new)
        self.assertIn(b'40 80 m 90 140 150 40 210 90 c S', new)
        self.assertIn(b'(Keep) Tj', new)
        self.assertIn(b'10 10 15 15 re S', new)
        self.assertEqual(new.count(b'1 1 1 rg'), old.count(b'1 1 1 rg'))
        self.assertEqual(new.count(b'1 1 1 RG'), old.count(b'1 1 1 RG'))
        self.assertEqual(content(output, 1), content(self.raw, 1))
        source = pymupdf.open(stream=self.raw, filetype='pdf')
        edited_doc = pymupdf.open(stream=output, filetype='pdf')
        try:
            self.assertEqual(edited_doc[0].get_text('text'), source[0].get_text('text'))
            self.assertEqual(edited_doc[1].get_text('text'), source[1].get_text('text'))
        finally:
            source.close()
            edited_doc.close()

    def test_negative_bar_can_cross_the_baseline(self):
        blue = series_of(self.scene, 'bar', '#3366cc')[0]
        edited = move_point(self.scene, blue['id'], 2, y=240)
        output, report = marks.export_marks(self.raw, self.scene, edited)
        self.assertEqual(report['changedSeries'], [blue['id']])
        new = content(output)
        self.assertNotIn(b'180 10 36 30 re', new)
        self.assertIn(b'180 60 36 -20 re', new)
        self.assertIn(b'60 40 36 90 re', new)
        self.assertIn(b'120 40 36 140 re', new)

    def test_path_rectangle_keeps_width_and_baseline(self):
        path = series_of(self.scene, 'bar', '#8c471f')[0]
        edited = move_point(self.scene, path['id'], 0, y=path['points'][0]['y'] - 20, x=path['points'][0]['x'] + 15)
        output, _report = marks.export_marks(self.raw, self.scene, edited)
        new = content(output)
        self.assertNotIn(b'270 110 l', new)
        self.assertIn(b'250 40 m 270 40 l 270 130 l 250 130 l h f', new)

    def test_scatter_moves_both_axes_and_keeps_radius(self):
        scatter = series_of(self.scene, 'scatter')[0]
        target = next(index for index, point in enumerate(scatter['points']) if round(point['x']) == 300)
        edited = move_point(self.scene, scatter['id'], target, x=315, y=190)
        output, report = marks.export_marks(self.raw, self.scene, edited)
        self.assertEqual(report['changedSeries'], [scatter['id']])
        again = marks.prepare_marks(output, 0, [0, 0, 400, 300])
        moved = series_of(again, 'scatter')[0]
        centers = {(round(point['x']), round(point['y'])) for point in moved['points']}
        self.assertIn((315, 190), centers)
        self.assertIn((340, 150), centers)
        self.assertTrue(all(abs(point['radius'] - 6) < 0.15 for point in moved['points']))
        self.assertEqual(content(output, 1), content(self.raw, 1))

    def test_dpi_scales_the_same_user_edit(self):
        scene = marks.prepare_marks(self.raw, 0, [0, 0, 400, 300], {'dpi': 144})
        blue = series_of(scene, 'bar', '#3366cc')[0]
        self.assertAlmostEqual(blue['points'][0]['width'], 72, places=2)
        edited = move_point(scene, blue['id'], 0, y=blue['points'][0]['y'] - 80)
        output, _report = marks.export_marks(self.raw, scene, edited)
        self.assertIn(b'60 40 36 130 re', content(output))

    def test_point_topology_and_source_hash(self):
        edited = copy.deepcopy(self.scene)
        edited['series'][0]['points'].pop()
        with self.assertRaises(ValueError) as caught:
            marks.export_marks(self.raw, self.scene, edited)
        self.assertEqual(str(caught.exception), 'point-topology')
        hashed = copy.deepcopy(self.scene)
        hashed['sourceFileHash'] = '0' * 64
        with self.assertRaises(ValueError) as caught:
            marks.export_marks(self.raw, hashed, hashed)
        self.assertEqual(str(caught.exception), 'source-mismatch')


class MarkLimitTests(unittest.TestCase):
    def test_form_xobject_is_not_claimed(self):
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 300))
        form = pdf.make_stream(b'0 0 1 rg 10 10 40 80 re f')
        form.Type = pikepdf.Name.XObject
        form.Subtype = pikepdf.Name.Form
        form.BBox = pikepdf.Array([0, 0, 100, 100])
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm=form))
        page.Contents = pdf.make_stream(b'q 1 0 0 1 40 40 cm /Fm Do Q\n')
        buf = io.BytesIO()
        pdf.save(buf)
        raw = buf.getvalue()
        self.assertEqual(marks.prepare_marks(raw, 0, [0, 0, 400, 300]), [])

    def test_top_level_bar_is_kept_when_a_form_is_also_present(self):
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 300))
        form = pdf.make_stream(b'0 0 1 rg 10 10 40 80 re f')
        form.Type = pikepdf.Name.XObject
        form.Subtype = pikepdf.Name.Form
        form.BBox = pikepdf.Array([0, 0, 100, 100])
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm=form))
        page.Contents = pdf.make_stream(
            b'0 0 0 RG 1 w 30 40 m 200 40 l S\n'
            b'0.2 0.4 0.8 rg 60 40 36 90 re f\n'
            b'q 1 0 0 1 40 40 cm /Fm Do Q\n')
        buf = io.BytesIO()
        pdf.save(buf)
        scene = marks.prepare_marks(buf.getvalue(), 0, [0, 0, 400, 300])
        self.assertEqual(len(scene['series']), 1)
        self.assertEqual(scene['series'][0]['kind'], 'bar')
        self.assertEqual(len(scene['series'][0]['points']), 1)

    def test_rotation_moves_the_value_edge_along_the_page_transform(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.draw_line((20, 220), (220, 220), color=(0, 0, 0), width=1)
        page.draw_rect(pymupdf.Rect(60, 100, 110, 220), color=None, fill=(0, 0, 1), width=0)
        page.insert_text((30, 40), 'Keep', fontsize=11, fontname='helv')
        page.set_rotation(90)
        raw = doc.tobytes()
        box = [float(page.rect.x0), float(page.rect.y0), float(page.rect.x1), float(page.rect.y1)]
        doc.close()
        scene = marks.prepare_marks(raw, 0, box)
        self.assertEqual(len(scene['series']), 1)
        series = scene['series'][0]
        self.assertEqual(series['kind'], 'bar')
        point = series['points'][0]
        before = _blue_span(raw, box)
        edited = copy.deepcopy(scene)
        if point['axis'] == 'x':
            edited['series'][0]['points'][0]['x'] = point['x'] + 30
        else:
            edited['series'][0]['points'][0]['y'] = point['y'] - 30
        output, report = marks.export_marks(raw, scene, edited)
        self.assertFalse(report['noop'])
        after = _blue_span(output, box)
        self.assertEqual(edited['series'][0]['points'][0]['width'], point['width'])
        if point['axis'] == 'x':
            self.assertAlmostEqual(after[2] - after[0], before[2] - before[0] + 30, delta=2)
            self.assertAlmostEqual(after[3] - after[1], before[3] - before[1], delta=2)
        else:
            self.assertAlmostEqual(after[3] - after[1], before[3] - before[1] + 30, delta=2)
            self.assertAlmostEqual(after[2] - after[0], before[2] - before[0], delta=2)
        edited_doc = pymupdf.open(stream=output, filetype='pdf')
        source = pymupdf.open(stream=raw, filetype='pdf')
        try:
            self.assertEqual(edited_doc[0].get_text('text'), source[0].get_text('text'))
        finally:
            edited_doc.close()
            source.close()


def _blue_span(raw, box):
    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        pix = doc[0].get_pixmap(clip=pymupdf.Rect(*box), dpi=72, alpha=False)
        xs, ys = [], []
        for y in range(pix.height):
            for x in range(pix.width):
                pixel = pix.pixel(x, y)
                if pixel[2] > 200 and pixel[0] < 40 and pixel[1] < 40:
                    xs.append(x)
                    ys.append(y)
        if not xs:
            raise AssertionError('blue bar missing')
        return (min(xs), min(ys), max(xs), max(ys))
    finally:
        doc.close()


if __name__ == '__main__':
    unittest.main()

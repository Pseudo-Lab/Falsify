"""Native line/cubic export. Synthetic pages only. seqno is not an operator address."""
import copy
import io
import sys
import unittest
from pathlib import Path

import pikepdf
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_paint as paint
import paper_chart_scene as scene


def native_pdf():
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.insert_text((40, 28), 'Keep', fontsize=11, fontname='helv', color=(0, 0, 0))
    page.draw_line((50, 140), (360, 140), color=(0.7, 0.7, 0.7), width=2)
    page.draw_line((60, 240), (340, 70), color=(1, 0, 0), width=3)
    shape = page.new_shape()
    shape.draw_line((70, 220), (150, 180))
    shape.draw_line((180, 160), (320, 100))
    shape.finish(color=(0, 0.5, 0), width=3, closePath=False)
    shape.commit()
    page.draw_bezier((60, 200), (120, 40), (250, 260), (340, 90), color=(0, 0, 1), width=3, dashes='[3 2] 0')
    other = doc.new_page(width=400, height=300)
    other.insert_text((30, 40), 'Other', fontsize=11, fontname='helv')
    other.draw_line((20, 40), (80, 90), color=(0, 0, 0), width=2)
    raw = doc.tobytes()
    doc.close()
    return raw


def form_pdf():
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 300))
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                                                BaseFont=pikepdf.Name.Helvetica))
    form_data = b'1 0 0 RG 2 w 10 80 m 90 20 l S 0 0 1 RG 1.5 w 10 40 m 30 10 70 70 90 30 c S'
    form = pdf.make_stream(form_data)
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array([0, 0, 100, 100])
    form.Resources = pikepdf.Dictionary()
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font), XObject=pikepdf.Dictionary(Fm=form))
    page.Contents = pdf.make_stream(
        b'BT /F1 12 Tf 40 280 Td (Keep) Tj ET\n'
        b'2 w .7 .7 .7 RG 50 40 m 360 40 l S\n'
        b'q 1 0 0 1 30 40 cm /Fm Do Q\n'
        b'q 1 0 0 1 220 40 cm /Fm Do Q\n')
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue(), form_data


def content(raw, index=0):
    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        contents = pdf.pages[index].obj.get('/Contents')
        streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        return b''.join(stream.read_bytes() for stream in streams)
    finally:
        pdf.close()


def operators(data):
    pdf = pikepdf.new()
    page = pdf.add_blank_page()
    page.Contents = pdf.make_stream(data)
    found = [(str(op), [str(item) for item in operands]) for operands, op in pikepdf.parse_content_stream(page.Contents)]
    pdf.close()
    return found


def line_operator_index(raw):
    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        for index, (operands, op) in enumerate(pikepdf.parse_content_stream(pdf.pages[0])):
            if str(op) == 'l' and len(operands) == 2 and float(operands[0]) == 340 and float(operands[1]) == 230:
                return index
    finally:
        pdf.close()
    raise AssertionError('red line operator missing')


def move(series, index, dx, dy):
    series['points'][index]['x'] = float(series['points'][index]['x']) + dx
    series['points'][index]['y'] = float(series['points'][index]['y']) + dy


def shift(series, dx, dy):
    for point in series['points']:
        point['x'] = float(point['x']) + dx
        point['y'] = float(point['y']) + dy


class NativePaintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = native_pdf()
        cls.scene = scene.prepare_scene(cls.raw, 0, [0, 0, 400, 300])

    def test_noop_returns_original_bytes(self):
        edited = copy.deepcopy(self.scene)
        output, report = paint.export_scene(self.raw, self.scene, edited)
        self.assertTrue(report['noop'])
        self.assertEqual(output, self.raw)
        rendered = paint.render_scene(self.raw, self.scene, edited)
        self.assertTrue(rendered['noop'])
        self.assertEqual(rendered['mime'], 'image/png')
        self.assertTrue(rendered['png'].startswith(b'\x89PNG'))

    def test_seqno_is_not_the_operator_index(self):
        red = self.scene['series'][0]
        seqno = red['sourceBinding']['muSeqno']
        operator_index = line_operator_index(self.raw)
        self.assertIsInstance(seqno, int)
        self.assertNotEqual(seqno, operator_index)
        baseline = copy.deepcopy(self.scene)
        baseline['series'][0]['sourceBinding']['operatorIndex'] = operator_index
        edited = copy.deepcopy(baseline)
        edited['series'][0]['sourceBinding']['operatorIndex'] = seqno
        edited['series'][0]['sourceBinding']['seqno'] = 0
        edited['series'][0]['sourceBinding']['muSeqno'] = 0
        edited['series'][0]['sourceBinding']['fingerprint'] = 'ignored'
        shift(edited['series'][0], 0, -60)
        output, report = paint.export_scene(self.raw, baseline, edited)
        self.assertFalse(report['noop'])
        self.assertEqual(report['changedSeries'], ['series-1'])
        self.assertFalse(report['formIsolated'])
        new = content(output, 0)
        old = content(self.raw, 0)
        self.assertIn(b'180 140 m', old)
        self.assertIn(b'180 140 m', new)
        self.assertIn(b'340 210 c', old)
        self.assertIn(b'340 210 c', new)
        self.assertIn(b'50 160 m', old)
        self.assertIn(b'50 160 m', new)
        self.assertIn(b'340 230 l', old)
        self.assertNotIn(b'340 230 l', new)
        self.assertEqual(operators(content(output, 1)), operators(content(self.raw, 1)))
        doc = pymupdf.open(stream=output, filetype='pdf')
        source = pymupdf.open(stream=self.raw, filetype='pdf')
        try:
            self.assertEqual(doc[0].get_text('text'), source[0].get_text('text'))
            self.assertNotIn(b'1 1 1 rg', new)
            self.assertNotIn(b'1 1 1 RG', new)
            before = source[0].get_pixmap(dpi=72, alpha=False)
            after = doc[0].get_pixmap(dpi=72, alpha=False)
            self.assertEqual(before.pixel(200, 155), (255, 0, 0))
            self.assertEqual(after.pixel(200, 155), (255, 255, 255))
            self.assertEqual(after.pixel(200, 95), (255, 0, 0))
            self.assertEqual(before.pixel(60, 200), after.pixel(60, 200))
            self.assertEqual(before.pixel(80, 140), after.pixel(80, 140))
        finally:
            doc.close()
            source.close()

    def test_edits_one_fragment_of_a_shared_path(self):
        edited = copy.deepcopy(self.scene)
        shift(edited['series'][1], 0, -30)
        output, report = paint.export_scene(self.raw, self.scene, edited)
        self.assertEqual(report['changedSeries'], ['series-2'])
        new, old = content(output, 0), content(self.raw, 0)
        self.assertIn(b'180 140 m', new)
        self.assertIn(b'320 200 l', new)
        self.assertIn(b'70 80 m', old)
        self.assertNotIn(b'70 80 m', new)
        self.assertIn(b'340 230 l', new)
        self.assertIn(b'340 210 c', new)
        old_ops = [op for op, _operands in operators(old)]
        new_ops = [op for op, _operands in operators(new)]
        self.assertEqual(old_ops, new_ops)

    def test_interior_bump_resamples_one_fragment(self):
        import paper_chart_shape_core as shape
        red = self.scene['series'][0]
        center = red['points'][len(red['points']) // 2]
        result = shape.evaluate(self.scene, [{
            'id': 'bump', 'kind': 'deform', 'seriesId': red['id'],
            'center': [center['x'], center['y']], 'radius': 36, 'dx': 0, 'dy': -28,
        }])
        edited = result['scene']
        moved = [index for index, (before, after) in enumerate(zip(red['points'], edited['series'][0]['points']))
                 if abs(before['y'] - after['y']) > 1]
        self.assertTrue(moved)
        self.assertLess(moved[0], len(red['points']) // 2)
        self.assertGreater(moved[-1], len(red['points']) // 2)
        self.assertLess(abs(edited['series'][0]['points'][0]['y'] - red['points'][0]['y']), 0.2)
        self.assertLess(abs(edited['series'][0]['points'][-1]['y'] - red['points'][-1]['y']), 0.2)
        output, report = paint.export_scene(self.raw, self.scene, edited)
        self.assertEqual(report['changedSeries'], ['series-1'])
        new, old = content(output, 0), content(self.raw, 0)
        self.assertIn(b'340 210 c', new)
        self.assertIn(b'180 140 m', new)
        self.assertIn(b'50 160 m', new)
        self.assertNotEqual(old.count(b' l'), new.count(b' l'))
        doc = pymupdf.open(stream=output, filetype='pdf')
        source = pymupdf.open(stream=self.raw, filetype='pdf')
        try:
            self.assertEqual(doc[0].get_text('text'), source[0].get_text('text'))
            after = doc[0].get_pixmap(dpi=72, alpha=False)
            before = source[0].get_pixmap(dpi=72, alpha=False)
            self.assertEqual(before.pixel(200, 155), (255, 0, 0))
            self.assertNotEqual(after.pixel(200, 155), (255, 0, 0))
            self.assertEqual(after.pixel(200, 127), (255, 0, 0))
            self.assertEqual(before.pixel(80, 140), after.pixel(80, 140))
        finally:
            doc.close()
            source.close()

    def test_point_count_is_preserved(self):
        edited = copy.deepcopy(self.scene)
        edited['series'][0]['points'] = edited['series'][0]['points'][:1]
        with self.assertRaises(ValueError) as caught:
            paint.export_scene(self.raw, self.scene, edited)
        self.assertEqual(str(caught.exception), 'point-topology')


class FormIsolationTests(unittest.TestCase):
    def test_shared_form_clone_keeps_the_other_invocation(self):
        raw, form_data = form_pdf()
        built = scene.prepare_scene(raw, 0, [0, 150, 180, 290])
        colors = [item['color'] for item in built['series']]
        self.assertEqual(colors, ['#ff0000', '#0000ff'])
        red = built['series'][0]
        self.assertGreater(len(red['points']), 2)
        self.assertLess(abs(red['points'][0]['x'] - 40) + abs(red['points'][0]['y'] - 30), 1.2)
        self.assertLess(abs(red['points'][-1]['x'] - 120) + abs(red['points'][-1]['y'] - 90), 1.2)
        edited = copy.deepcopy(built)
        start, end = edited['series'][0]['points'][0], edited['series'][0]['points'][-1]
        new_end_y = float(end['y']) - 40
        count = len(edited['series'][0]['points'])
        for index, point in enumerate(edited['series'][0]['points']):
            t = index / (count - 1)
            point['x'] = float(start['x']) + t * (float(end['x']) - float(start['x']))
            point['y'] = float(start['y']) + t * (new_end_y - float(start['y']))
        edited['series'][0]['sourceBinding']['operatorIndex'] = 0
        output, report = paint.export_scene(raw, built, edited)
        self.assertTrue(report['formIsolated'])
        self.assertEqual(report['changedSeries'], ['series-1'])
        pdf = pikepdf.open(io.BytesIO(output))
        try:
            resources = pdf.pages[0].Resources.XObject
            names = {str(key) for key in resources.keys()}
            self.assertIn('/Fm', names)
            self.assertEqual(resources['/Fm'].read_bytes(), form_data)
            clones = [str(key) for key in resources.keys() if str(key).startswith('/ChartFm')]
            self.assertEqual(len(clones), 1)
            clone = resources[clones[0]].read_bytes()
            self.assertIn(b'90 60 l', clone)
            self.assertNotIn(b'90 20 l', clone)
            self.assertIn(b'30 10 70 70 90 30 c', clone)
            page = pdf.pages[0].Contents.read_bytes()
            self.assertEqual(page.count(b'/Fm Do'), 1)
            self.assertIn(b'/ChartFm', page)
            self.assertIn(b'(Keep) Tj', page)
            self.assertIn(b'50 40 m 360 40 l S', page)
        finally:
            pdf.close()
        doc = pymupdf.open(stream=output, filetype='pdf')
        source = pymupdf.open(stream=raw, filetype='pdf')
        try:
            self.assertEqual(doc[0].get_text('words'), source[0].get_text('words'))
            pix = doc[0].get_pixmap(dpi=72, alpha=False)
            before = source[0].get_pixmap(dpi=72, alpha=False)

            def pixel(image, x, y):
                return image.pixel(x, y)

            self.assertEqual(pixel(before, 270, 210), (255, 0, 0))
            self.assertEqual(pixel(pix, 270, 210), (255, 0, 0))
            self.assertEqual(pixel(pix, 104, 228), (255, 255, 255))
            self.assertEqual(pixel(pix, 104, 196), (255, 0, 0))
            self.assertEqual(pixel(pix, 80, 260), (178, 178, 178))
        finally:
            doc.close()
            source.close()


class ClosedSourceTests(unittest.TestCase):
    def test_closed_stroke_is_preserved_in_preview_and_export(self):
        doc = pymupdf.open()
        page = doc.new_page(width=300, height=200)
        shape = page.new_shape()
        shape.draw_polyline([(40, 140), (120, 60), (240, 120)])
        shape.finish(color=(0, 0, 1), width=2, closePath=True)
        shape.commit()
        raw = doc.tobytes()
        doc.close()
        prepared = scene.prepare_scene(raw, 0, [20, 20, 270, 175])
        self.assertTrue(prepared['series'][0]['style']['closed'])
        self.assertEqual(paint.export_scene(raw, prepared, prepared)[0], raw)
        edited = copy.deepcopy(prepared)
        for point in edited['series'][0]['points']:
            point['y'] -= 8
        output, _ = paint.export_scene(raw, prepared, edited)
        with pymupdf.open(stream=output, filetype='pdf') as result:
            drawings = result[0].get_drawings()
            self.assertEqual(drawings[0]['items'][-1][2], drawings[0]['items'][0][1])
            self.assertIn(b'h', content(output).split())
            self.assertAlmostEqual(drawings[0]['rect'].y0, 52, delta=.1)


if __name__ == '__main__':
    unittest.main()

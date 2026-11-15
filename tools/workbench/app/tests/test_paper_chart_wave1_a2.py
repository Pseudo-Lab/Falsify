"""Wave 1 A2 comprehensive acceptance tests (parts A-D)."""

import importlib.util
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pikepdf
import pymupdf
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart as chart
import paper_chart_geometry as geom
import paper_chart_marks as marks
import paper_chart_paint as paint
import paper_chart_printed as printed
import paper_chart_raster_edit as raster_edit
import paper_chart_raster_scene as raster_scene
from test_paper_chart_marks import circle


def _png_bytes(im):
    buf = io.BytesIO()
    im.save(buf, format='PNG')
    return buf.getvalue()


class PartA1ZeroSeriesGuardTests(unittest.TestCase):
    def test_deplot_all_zero_uncalibrated_sets_partial_and_issues(self):
        im = Image.new('RGB', (40, 40), 'white')
        raw = 'x | y\nA | 0.0\nB | 0\nC | 0.00'
        with mock.patch.object(chart, 'default_engine', return_value=lambda _png, _prompt, _opt: raw):
            out = chart.extract_chart(_png_bytes(im), engine='deplot')
        self.assertEqual(out['status'], 'partial')
        self.assertIn('axis_calibration_required', out['issues'])
        self.assertIn('degenerate_zero_series', out['issues'])

    def test_nonzero_plus_zero_stays_ready(self):
        im = Image.new('RGB', (40, 40), 'white')
        raw = 'x | y\nA | 0.0\nB | 12.5\nC | 0'
        out = chart.extract_chart(_png_bytes(im), engine=lambda _png, _prompt, _opt: raw)
        self.assertEqual(out['status'], 'ready')
        self.assertNotIn('degenerate_zero_series', out['issues'])

    def test_geometry_result_uncalibrated_zero_series_flagged(self):
        geometry = {
            'status': 'ready',
            'issues': [],
            'axes': {'x': {'scale': 'linear', 'ticks': []}, 'left': {'scale': 'linear', 'ticks': []}},
            'series': [{'id': 's1', 'axisBinding': 'left', 'points': [
                {'x': 1, 'y': 0.0, 'xPixel': 20, 'yPixel': 100},
                {'x': 2, 'y': 0.0, 'xPixel': 40, 'yPixel': 100},
            ]}],
        }
        out = chart._geometry_result(geometry, {'width': 200, 'height': 150, 'sha256': 'x', 'format': 'png'})
        self.assertEqual(out['status'], 'partial')
        self.assertIn('axis_calibration_required', out['issues'])
        self.assertIn('degenerate_zero_series', out['issues'])


class PartA2PrintedReconciliationTests(unittest.TestCase):
    def test_parse_printed_values_and_reconcile(self):
        spans = [
            {'text': 'Group A: 1.24 (0.98, 1.56)', 'bbox': [10, 20, 120, 34], 'source': 'pdf-text'},
            {'text': 'HR 0.76 [95% CI 0.61–0.94]', 'bbox': [10, 40, 140, 54], 'source': 'ocr'},
            {'text': 'Mean 12.4 ± 1.8 SE', 'bbox': [10, 60, 110, 74], 'source': 'ocr'},
        ]
        parsed = printed.parse_printed_values(spans)
        self.assertEqual(len(parsed), 3)
        self.assertEqual(parsed[0]['value'], 1.24)
        self.assertEqual((parsed[0]['lowerCi'], parsed[0]['upperCi']), (0.98, 1.56))
        self.assertEqual(parsed[1]['source'], 'ocr')
        self.assertEqual(parsed[2]['se'], 1.8)

        im = Image.new('RGB', (40, 40), 'white')
        out = chart.extract_chart(
            _png_bytes(im),
            engine=lambda _png, _prompt, _opt: 'x | y\nA | 1.24\nB | 0.76\nC | 12.4',
            options={'textSpans': spans},
        )
        self.assertEqual(len(out['printedValues']), 3)
        self.assertEqual(out['reconciliation']['status'], 'consistent')
        self.assertEqual(out['reconciliation']['matchedCount'], 3)

        bad = chart.extract_chart(
            _png_bytes(im),
            engine=lambda _png, _prompt, _opt: 'x | y\nA | 5.5\nB | 9.9\nC | 12.4',
            options={'textSpans': spans},
        )
        self.assertEqual(bad['reconciliation']['status'], 'discrepant')
        self.assertGreater(len(bad['reconciliation']['discrepancies']), 0)

    def test_extract_pdf_text_spans_inside_crop(self):
        doc = pymupdf.open()
        page = doc.new_page(width=400, height=300)
        page.insert_text((50, 80), 'Effect 1.24 (0.98, 1.56)')
        pdf_bytes = doc.tobytes()
        doc.close()
        spans = printed.extract_pdf_text_spans(pdf_bytes, 0, [20, 40, 260, 140], 480, 200)
        parsed = printed.parse_printed_values(spans, default_source='pdf-text')
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]['source'], 'pdf-text')
        self.assertEqual((parsed[0]['lowerCi'], parsed[0]['upperCi']), (0.98, 1.56))


class PartA3ErrorBarTests(unittest.TestCase):
    def test_vertical_error_bars_classify_ci_bounds_without_extra_series(self):
        im = Image.new('RGB', (640, 480), 'white')
        d = ImageDraw.Draw(im)
        font = ImageFont.load_default(size=16)
        lines = []
        d.rectangle((90, 30, 550, 400), outline='black', width=2)

        def label(text, box):
            d.text((box[0], box[1]), text, font=font, fill='black')
            lines.append({'text': text, 'bbox': box})

        for x, val in zip([120, 240, 360, 480], [1, 2, 3, 4]):
            label(str(val), [x - 6, 415, x + 10, 435])
        for y, val in zip([80, 160, 240, 320], [80, 60, 40, 20]):
            label(str(val), [40, y - 8, 72, y + 8])

        pts = [(120, 320), (240, 240), (360, 160), (480, 80)]
        d.line(pts, fill='#1f77b4', width=3)
        # Draw asymmetric vertical I-beam CI error bars at 240 and 360
        for px, py, hi_y, lo_y in [(240, 240, 190, 275), (360, 160, 115, 200)]:
            d.line([(px, hi_y), (px, lo_y)], fill='#1f77b4', width=2)
            d.line([(px - 7, hi_y), (px + 7, hi_y)], fill='#1f77b4', width=2)
            d.line([(px - 7, lo_y), (px + 7, lo_y)], fill='#1f77b4', width=2)
            d.ellipse((px - 5, py - 5, px + 5, py + 5), fill='#1f77b4')

        result = geom.extract_geometry(_png_bytes(im), lines)
        self.assertEqual(len(result['series']), 1)
        eb = result.get('errorBars') or []
        self.assertGreaterEqual(len(eb), 2)
        p2 = min(result['series'][0]['points'], key=lambda p: abs(p['x'] - 2))
        self.assertIn('ciBounds', p2)
        self.assertAlmostEqual(p2['y'], 40.0, delta=3.0)
        self.assertLess(p2['ciBounds']['lower'], p2['y'])
        self.assertGreater(p2['ciBounds']['upper'], p2['y'])


class PartBNestedFormXObjectTests(unittest.TestCase):
    def _nested_depth4_pdf(self):
        pdf = pikepdf.new()
        p0 = pdf.add_blank_page(page_size=(400, 300))
        fm4 = pdf.make_stream(b'0.2 0.4 0.8 rg 0 0 36 80 re f')
        fm4.Type, fm4.Subtype, fm4.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 100, 150])
        fm3 = pdf.make_stream(b'q 1 0 0 1 10 0 cm /Fm4 Do Q\n')
        fm3.Type, fm3.Subtype, fm3.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 200, 200])
        fm3.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm4=fm4))
        fm2 = pdf.make_stream(b'q 1 0 0 1 20 0 cm /Fm3 Do Q\n')
        fm2.Type, fm2.Subtype, fm2.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 300, 250])
        fm2.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm3=fm3))
        fm1 = pdf.make_stream(b'0 0 0 RG 1 w 0 0 m 200 0 l S\nq 1 0 0 1 30 40 cm /Fm2 Do Q\n')
        fm1.Type, fm1.Subtype, fm1.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 350, 260])
        fm1.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm2=fm2))
        p0.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm1=fm1))
        p0.Contents = pdf.make_stream(b'q /Fm1 Do Q\n')
        buf = io.BytesIO()
        pdf.save(buf)
        return buf.getvalue()

    def test_depth_4_form_marks_detected_and_editable(self):
        raw = self._nested_depth4_pdf()
        scene = marks.prepare_marks(raw, 0, [0, 0, 400, 300])
        self.assertEqual(scene['mode'], 'marks')
        self.assertEqual(len(scene['series']), 1)
        edited = {'series': [{'id': scene['series'][0]['id'],
                              'kind': scene['series'][0]['kind'],
                              'points': [{'x': scene['series'][0]['points'][0]['x'],
                                          'y': scene['series'][0]['points'][0]['y'] - 25}]}]}
        out, report = marks.export_marks(raw, scene, edited)
        self.assertFalse(report['noop'])
        self.assertNotEqual(out, raw)
        scene_after = marks.prepare_marks(out, 0, [0, 0, 400, 300])
        self.assertAlmostEqual(scene_after['series'][0]['points'][0]['y'],
                               scene['series'][0]['points'][0]['y'] - 25, delta=0.5)

    def test_shared_form_occurrence_isolation_preserves_other_occurrences_and_pages(self):
        pdf = pikepdf.new()
        p0 = pdf.add_blank_page(page_size=(400, 300))
        p1 = pdf.add_blank_page(page_size=(400, 300))
        shared = pdf.make_stream(b'0.15 0.55 0.25 rg ' + circle(20, 40, 6))
        shared.Type, shared.Subtype, shared.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 100, 100])
        p0.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Mk=shared))
        p1.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Mk=shared))
        p0.Contents = pdf.make_stream(b'q 1 0 0 1 40 40 cm /Mk Do Q\nq 1 0 0 1 200 40 cm /Mk Do Q\n')
        p1.Contents = pdf.make_stream(b'q 1 0 0 1 120 80 cm /Mk Do Q\n')
        buf = io.BytesIO()
        pdf.save(buf)
        raw = buf.getvalue()

        scene = marks.prepare_marks(raw, 0, [0, 0, 400, 300])
        self.assertEqual(len(scene['series']), 1)
        pts = scene['series'][0]['points']
        self.assertEqual(len(pts), 2)
        edited = {'series': [{'id': scene['series'][0]['id'],
                              'kind': scene['series'][0]['kind'],
                              'points': [{'x': pts[0]['x'] + 10, 'y': pts[0]['y'] - 20}, pts[1]]}]}
        out, report = marks.export_marks(raw, scene, edited)
        self.assertFalse(report['noop'])
        with pymupdf.open(stream=raw, filetype='pdf') as before, pymupdf.open(stream=out, filetype='pdf') as after:
            # Occurrence 2 on page 0 stays pixel-identical
            clip_occ2 = pymupdf.Rect(190, 190, 260, 250)
            self.assertEqual(before[0].get_pixmap(clip=clip_occ2).samples, after[0].get_pixmap(clip=clip_occ2).samples)
            # Page 1 stays completely pixel-identical
            self.assertEqual(before[1].get_pixmap().samples, after[1].get_pixmap().samples)

    def test_depth_5_exceeding_max_form_depth_is_safely_ignored(self):
        pdf = pikepdf.new()
        p0 = pdf.add_blank_page(page_size=(400, 300))
        cur = pdf.make_stream(b'0.2 0.4 0.8 rg 10 10 30 60 re f')
        cur.Type, cur.Subtype, cur.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 100, 100])
        for depth in range(5):
            name = f'F{depth}'
            nxt = pdf.make_stream(f'q /{name} Do Q\n'.encode('ascii'))
            nxt.Type, nxt.Subtype, nxt.BBox = pikepdf.Name.XObject, pikepdf.Name.Form, pikepdf.Array([0, 0, 200, 200])
            nxt.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary({f'/{name}': cur}))
            cur = nxt
        p0.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Top=cur))
        p0.Contents = pdf.make_stream(b'q /Top Do Q\n')
        buf = io.BytesIO()
        pdf.save(buf)
        self.assertEqual(marks.prepare_marks(buf.getvalue(), 0, [0, 0, 400, 300]), [])


@unittest.skipUnless(importlib.util.find_spec('py_mini_racer') is not None, 'py_mini_racer not installed')
class PartCDarkNeutralCurveTests(unittest.TestCase):
    def _dark_chart_array(self, *, with_red=False):
        im = Image.new('RGB', (280, 200), 'white')
        d = ImageDraw.Draw(im)
        font = ImageFont.load_default(size=12)
        # Black axes, outward ticks, full-width dark gridline, solid legend box, and text labels
        d.line([(40, 20), (40, 165), (255, 165)], fill=(0, 0, 0), width=2)
        for ty in (50, 95, 135):
            d.line([(34, ty), (40, ty)], fill=(0, 0, 0), width=2)
            d.line([(41, ty), (254, ty)], fill=(80, 80, 80), width=1)
        for tx in (80, 140, 200):
            d.line([(tx, 165), (tx, 171)], fill=(0, 0, 0), width=2)
        d.text((8, 45), '80', font=font, fill=(0, 0, 0))
        d.text((76, 176), '10', font=font, fill=(0, 0, 0))
        d.rectangle((210, 25, 228, 39), fill=(0, 0, 0))  # Solid legend swatch
        # Interior black data curve crossing gridlines
        d.line([(46, 150), (110, 115), (180, 75), (245, 38)], fill=(0, 0, 0), width=3)
        if with_red:
            d.line([(46, 130), (120, 135), (240, 100)], fill=(210, 30, 30), width=3)
        return np.array(im, dtype=np.uint8)

    def test_dark_neutral_curve_traced_and_edited_without_axis_mutation(self):
        arr = self._dark_chart_array(with_red=True)
        traced = raster_edit.trace_series(arr)
        dark_series = [s for s in traced if max(s['color']) - min(s['color']) <= 45]
        red_series = [s for s in traced if s['color'][0] > 150 and s['color'][1] < 80]
        self.assertEqual(len(dark_series), 1)
        self.assertEqual(len(red_series), 1)

        pts = dark_series[0]['points']
        shifted = [(x, y - 14.0 if i == len(pts) // 2 else y) for i, (x, y) in enumerate(pts)]
        edited = raster_edit.edit_raster(arr, pts, shifted, dark_series[0]['color'], dark_series[0]['width'])
        # Left axis column (x=40), bottom axis row (y=165), ticks (x=34..39, y=166..171), margin text, legend box must be untouched
        self.assertTrue(np.array_equal(edited[:, 40], arr[:, 40]))
        self.assertTrue(np.array_equal(edited[165, :], arr[165, :]))
        self.assertTrue(np.array_equal(edited[45:65, 5:40], arr[45:65, 5:40]))
        self.assertTrue(np.array_equal(edited[25:39, 210:228], arr[25:39, 210:228]))

    def test_raster_scene_build_finds_dark_neutral_pdf_image_curve(self):
        arr = self._dark_chart_array(with_red=False)
        png = _png_bytes(Image.fromarray(arr))
        doc = pymupdf.open()
        page = doc.new_page(width=280, height=200)
        page.insert_image(pymupdf.Rect(0, 0, 280, 200), stream=png)
        raw = doc.tobytes()
        doc.close()
        built = paint.series_for_crop(raw, 0, [0, 0, 280, 200], 72, None)
        self.assertEqual(len(built), 1)
        self.assertEqual(built[0]['color'], '#000000')
        self.assertEqual(built[0]['sourceBinding']['kind'], 'raster-image')


if __name__ == '__main__':
    unittest.main()

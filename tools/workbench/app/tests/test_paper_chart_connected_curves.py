"""Connected error-bar curves split across source image tiles; synthetic only."""
import copy
import io
from pathlib import Path
import sys
import unittest
import zlib

import cv2
import numpy as np
import pikepdf
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_scene as scene
import paper_chart_paint as paint
import paper_chart_raster_edit as raster
from paper_chart_curve_links import linked_ids
from paper_chart_shape_core import evaluate

COLOR = (25, 95, 210)


def fixture(alpha=False):
    image = np.full((140, 440, 3), 255, np.uint8)
    for offset in (0, 220):
        for y in (30, 60, 90, 120):
            cv2.line(image, (offset, y), (offset + 219, y), (185, 185, 185), 1)
        points = [(20 + offset, 95), (80 + offset, 60), (145 + offset, 55), (200 + offset, 80)]
        cv2.polylines(image, [np.array(points)], False, COLOR, 2, cv2.LINE_AA)
        for x, y in points[1:]:
            cv2.line(image, (x, y - 12), (x, y + 12), COLOR, 1, cv2.LINE_AA)
            cv2.line(image, (x - 4, y - 12), (x + 4, y - 12), COLOR, 1, cv2.LINE_AA)
            cv2.line(image, (x - 4, y + 12), (x + 4, y + 12), COLOR, 1, cv2.LINE_AA)
    pdf = pikepdf.new()
    images = []
    for tile in (image[:70], image[70:]):
        stream = pdf.make_stream(zlib.compress(tile.tobytes()))
        stream.Type = pikepdf.Name.XObject
        stream.Subtype = pikepdf.Name.Image
        stream.Width, stream.Height = 440, 70
        stream.ColorSpace = pikepdf.Name.DeviceRGB
        stream.BitsPerComponent = 8
        stream.Filter = pikepdf.Name.FlateDecode
        if alpha:
            opacity = np.where(tile.max(axis=2) - tile.min(axis=2) > 10, 200, 0).astype(np.uint8)
            soft = pdf.make_stream(zlib.compress(opacity.tobytes()))
            soft.Type, soft.Subtype = pikepdf.Name.XObject, pikepdf.Name.Image
            soft.Width, soft.Height = 440, 70
            soft.ColorSpace, soft.BitsPerComponent = pikepdf.Name.DeviceGray, 8
            soft.Filter = pikepdf.Name.FlateDecode
            stream.SMask = soft
        images.append(stream)
    for _ in range(2):
        page = pdf.add_blank_page(page_size=(440, 140))
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Top=images[0], Bottom=images[1]))
        page.Contents = pdf.make_stream(b'q 440 0 0 70 0 70 cm /Top Do Q q 440 0 0 70 0 0 cm /Bottom Do Q')
    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def rendered(raw, page=0):
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        pix = doc[page].get_pixmap(dpi=72, alpha=False)
        return np.frombuffer(pix.samples, np.uint8).reshape((140, 440, 3)).copy()


class ConnectedCurveTests(unittest.TestCase):
    def test_short_aa_connection_is_painted_as_one_bridge_not_two_endpoint_dots(self):
        from test_paper_chart_raster_edit import embed
        image = np.full((120, 320, 3), 255, np.uint8)
        cv2.line(image, (20, 60), (143, 60), COLOR, 1)
        cv2.line(image, (149, 60), (300, 60), COLOR, 1)
        for x in (80, 240):
            cv2.line(image, (x, 40), (x, 80), COLOR, 1)
            for y in (40, 80):
                cv2.line(image, (x - 4, y), (x + 4, y), COLOR, 1)
        raw, _ = embed(image)
        with pikepdf.open(io.BytesIO(raw)) as pdf:
            for page in pdf.pages:
                page.MediaBox = [0, 0, 80, 30]
                page.Contents = pdf.make_stream(b'q 80 0 0 30 0 0 cm /Im1 Do Q')
            out = io.BytesIO()
            pdf.save(out)
            raw = out.getvalue()
        built = scene.prepare_scene(raw, 0, [0, 0, 80, 30])
        _, selected, point = min(((abs(p['x'] - 35.75) + abs(p['y'] - 15), s, p)
                                 for s in built['series'] for p in s['points']), key=lambda v: v[0])
        edited = evaluate(built, [{'id': 'gap-drag', 'kind': 'deform', 'seriesId': selected['id'],
                                  'center': [point['x'], point['y']], 'radius': 6, 'dx': 0, 'dy': -3}])['scene']
        output, _ = paint.export_scene(raw, built, edited)
        with pymupdf.open(stream=output, filetype='pdf') as doc:
            pix = doc[0].get_pixmap(dpi=288, alpha=False)
            rgb = np.frombuffer(pix.samples, np.uint8).reshape((120, 320, 3))
        _, _, stats, _ = cv2.connectedComponentsWithStats(raster.color_mask(rgb, COLOR).astype(np.uint8), 8)
        self.assertEqual(sum(r[cv2.CC_STAT_AREA] > 8 for r in stats[1:]), 1)

    def test_aa_ink_keeps_pale_samples_and_excludes_grid_and_other_color(self):
        image = np.array([[COLOR, (140, 175, 233), (185, 185, 185), (240, 100, 30)]], np.uint8)
        self.assertEqual(raster.color_mask(image, COLOR).tolist(), [[True, True, False, False]])

    def test_seam_deformation_export_and_undo_keep_other_panel_and_page(self):
        self.check_seam(False)

    def test_transparent_tiles_keep_the_curve_connected_and_other_occurrence_unchanged(self):
        self.check_seam(True)

    def check_seam(self, alpha):
        raw = fixture(alpha=alpha)
        built = scene.prepare_scene(raw, 0, [0, 0, 440, 140])
        choices = [(abs(p['x'] - 63) + abs(p['y'] - 70), s, p) for s in built['series'] for p in s['points']]
        _, selected, anchor = min(choices, key=lambda item: item[0])
        group = linked_ids(built['curveLinks'], selected['id'])
        members = [s for s in built['series'] if s['id'] in group]
        self.assertGreater(len({str(s['sourceBinding']['imageOccurrence']) for s in members}), 1)
        self.assertLess(max(p['x'] for s in members for p in s['points']), 220)
        operation = {'id': 'drag', 'kind': 'deform', 'seriesId': selected['id'],
                     'center': [anchor['x'], anchor['y']], 'radius': 35, 'dx': 0, 'dy': -18}
        changed = evaluate(built, [operation])['scene']
        moved = [s for s, old in zip(changed['series'], built['series']) if s['points'] != old['points']]
        self.assertGreater(len({str(s['sourceBinding']['imageOccurrence']) for s in moved}), 1)
        output, report = paint.export_scene(raw, built, changed)
        self.assertFalse(report['noop'])
        before, after = rendered(raw), rendered(output)
        np.testing.assert_array_equal(before[:, 220:], after[:, 220:])
        np.testing.assert_array_equal(rendered(raw, 1), rendered(output, 1))
        mask = raster.color_mask(after[:, :220], COLOR).astype(np.uint8)
        _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        substantial = [r for r in stats[1:] if r[cv2.CC_STAT_AREA] >= 8]
        self.assertEqual(len(substantial), 1, substantial)
        restored, report = paint.export_scene(raw, built, copy.deepcopy(built))
        self.assertTrue(report['noop'])
        self.assertEqual(restored, raw)

    def test_parallel_and_crossing_curves_keep_independent_series_without_error_bars(self):
        from test_paper_chart_raster_edit import embed
        for cross in (False, True):
            with self.subTest(cross=cross):
                image = np.full((120, 160, 3), 255, np.uint8)
                a, b = ((20, 30), (140, 90)) if cross else ((20, 30), (140, 30))
                c, d = ((20, 90), (140, 30)) if cross else ((20, 38), (140, 38))
                cv2.line(image, a, b, COLOR, 2, cv2.LINE_AA)
                cv2.line(image, c, d, COLOR, 2, cv2.LINE_AA)
                raw, _ = embed(image)
                built = scene.prepare_scene(raw, 0, [0, 0, 160, 120])
                self.assertEqual(len(built['series']), 2)
                self.assertEqual(built['curveLinks'], [])


if __name__ == '__main__':
    unittest.main()

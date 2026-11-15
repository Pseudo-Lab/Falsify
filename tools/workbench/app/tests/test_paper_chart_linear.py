"""Piecewise line edits preserve markers, error bars and one-action undo geometry."""
import base64
import copy
import hashlib
from pathlib import Path
import sys
import unittest

import cv2 as cv
import numpy as np
import pymupdf as mu

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_scene as scenes
import paper_chart_paint as paint
from paper_chart_shape_core import evaluate
from paper_chart_edit_service import _public, _verify_output
from paper_chart_linear_paint import _insert_rgba


def fixture(rotation=0, alpha=False):
    image = np.full((160, 300, 4 if alpha else 3), 255, np.uint8)
    color = (210, 90, 20, 255) if alpha else (210, 90, 20)
    for y in (30, 60, 90, 120):
        cv.line(image, (10, y), (290, y), (210, 210, 210, 255), 1)
    points = [(30, 60), (100, 80), (170, 70), (260, 90)]
    cv.polylines(image, [np.array(points)], False, color, 2, cv.LINE_AA)
    for x, y in points:
        cv.line(image, (x, y - 12), (x, y + 12), color, 1, cv.LINE_AA)
        for cap in (y - 12, y + 12):
            cv.line(image, (x - 5, cap), (x + 5, cap), color, 1, cv.LINE_AA)
        cv.circle(image, (x, y), 4, color, -1, cv.LINE_AA)
    if alpha:
        image[:, :, 3] = np.where(np.any(image[:, :, :3] < 250, axis=2), 255, 0)
    _, png = cv.imencode('.png', image)
    with mu.open() as doc:
        page = doc.new_page(width=340, height=210)
        page.insert_text((20, 195), 'Labels stay unchanged')
        page.insert_image(mu.Rect(20, 20, 320, 180), stream=png.tobytes())
        page.set_rotation(rotation)
        bbox = mu.Rect(20, 20, 320, 180) * page.rotation_matrix
        return doc.tobytes(), list(bbox)


class LinearChartTests(unittest.TestCase):
    def test_move_and_insert_are_straight_and_original_is_immutable(self):
        raw, box = fixture()
        scene = scenes.prepare_scene(raw, 0, box)
        self.assertEqual(len(scene['linearTracks']), 1)
        before = copy.deepcopy(scene)
        track = scene['linearTracks'][0]
        knot = min(track['knots'], key=lambda k: abs(k['x'] - 100))
        op = {'id': 'drag-1', 'kind': 'linear-edit', 'seriesId': track['id'],
              'knotId': knot['id'], 'target': [knot['x'], knot['y'] + 25]}
        edited = evaluate(scene, [op])['scene']
        output, _ = paint.export_scene(raw, scene, edited)
        self.assertEqual(_verify_output(raw, output, scene), [])
        self.assertEqual(scene, before)
        self.assertEqual(paint.export_scene(raw, scene, evaluate(scene, [])['scene'])[0], raw)
        for dpi in (72, 144, 216, 288):
            rgb = cv.imdecode(np.frombuffer(paint.render_png(output, 0, box, dpi), np.uint8), cv.IMREAD_COLOR)
            # Old marker and error-bar ink must disappear at several render scales.
            factor = dpi / 72
            x, y = round(knot['x'] * factor), round(knot['y'] * factor)
            patch = rgb[y-round(8*factor):y+round(8*factor)+1, x-round(3*factor):x+round(3*factor)+1]
            chroma = patch.max(axis=2).astype(int) - patch.min(axis=2)
            self.assertLess(int(chroma.max()), 10)
            self.assertGreaterEqual(int(patch.min()), 245, 'old marker leaves a gray matte outline')
        public = _public(scene)
        self.assertNotIn('sourceMaskPng', public['linearTracks'][0])
        self.assertIn('linearBasePng', public)
        inserted = evaluate(scene, [{**op, 'id': 'drag-2', 'knotId': None, 'target': [135, 40]}])['scene']
        self.assertEqual(len(inserted['linearTracks'][0]['knots']), len(track['knots']) + 1)
        self.assertEqual(_verify_output(raw, paint.export_scene(raw, scene, inserted)[0], scene), [])

    def test_straight_alpha_masks_do_not_alias_or_share_different_sprite_masks(self):
        with mu.open() as doc:
            page = doc.new_page(width=80, height=40)
            refs = []
            for i in range(2):
                image = np.full((20, 20, 4), 255, np.uint8)
                image[:, :, :3] = (200, 80, 20)
                image[:, :, 3] = 0
                image[2+i*8:8+i*8, 2:8, 3] = 255
                _, png = cv.imencode('.png', image)
                refs.append(_insert_rgba(page, mu.Rect(i*40, 0, i*40+20, 20), png.tobytes()))
            self.assertNotEqual(refs[0], refs[1])
            masks = [doc.xref_get_key(xref, 'SMask')[1] for xref in refs]
            self.assertNotEqual(*masks)
            pixel = page.get_pixmap(alpha=False)
            a = np.frombuffer(pixel.samples, np.uint8).reshape(pixel.height, pixel.width, 3)
            self.assertGreater(int(a[5, 5].max()) - int(a[5, 5].min()), 100)
            self.assertTrue(np.all(a[5, 45] == 255))
            self.assertGreater(int(a[13, 45].max()) - int(a[13, 45].min()), 100)

    def test_mixed_operation_modes_are_explicitly_rejected(self):
        raw, box = fixture(); scene = scenes.prepare_scene(raw, 0, box)
        track = scene['linearTracks'][0]; k = track['knots'][1]
        ops = [{'id': 'a', 'kind': 'linear-edit', 'seriesId': track['id'], 'knotId': k['id'], 'target': [k['x'], k['y']+1]},
               {'id': 'b', 'kind': 'move', 'seriesId': scene['series'][0]['id'], 'range': [0, 1], 'dx': 0, 'dy': 1}]
        with self.assertRaisesRegex(ValueError, 'mixed linear'):
            evaluate(scene, ops)

    def test_rebind_retains_linear_edits_and_previous_text_changes(self):
        from paper_native_worker import _export_chart
        raw, box = fixture(); scene = scenes.prepare_scene(raw, 0, box)
        track = scene['linearTracks'][0]; knot = track['knots'][1]
        op = {'id': 'move', 'kind': 'linear-edit', 'seriesId': track['id'], 'knotId': knot['id'],
              'target': [knot['x'], knot['y'] + 25]}
        edited = evaluate(scene, [op])['scene']
        with mu.open(stream=raw, filetype='pdf') as doc:
            doc[0].insert_text((200, 195), 'Earlier edit')
            override = doc.tobytes()
        output, report, pages, issues = _export_chart([raw, scene, edited, override, None])
        self.assertEqual(issues, [])
        self.assertEqual(report['mode'], 'source-linear')
        self.assertEqual(pages, 1)
        with mu.open(stream=output, filetype='pdf') as doc:
            self.assertIn('Earlier edit', doc[0].get_text())
        self.assertNotEqual(paint.render_png(output, 0, box, 144), paint.render_png(override, 0, box, 144))

    def test_native_prepare_preview_export_and_undo(self):
        from paper_chart_edit_service import ChartEditService, SCHEMA
        from paper_evidence import EvidenceStore
        raw, box = fixture(alpha=True)
        digest = hashlib.sha256(raw).hexdigest()
        store = EvidenceStore(); pid = store.prepare(raw, digest)['paperId']
        service = ChartEditService(store)
        scene = service.prepare({'paperId': pid, 'fileHash': digest, 'pageIndex': 0, 'bbox': box})
        track = scene['linearTracks'][0]; knot = track['knots'][1]
        plan = {'schema': SCHEMA, 'paperId': pid, 'fileHash': digest, 'sceneId': scene['sceneId'], 'revision': 1,
                'operations': [{'id': 'drag', 'kind': 'linear-edit', 'seriesId': track['id'], 'knotId': knot['id'],
                                'target': [knot['x'], knot['y'] + 20]}]}
        self.assertTrue(service.preview(plan)['image'])
        result = service.export(plan)
        self.assertEqual(result['verification']['status'], 'passed')
        self.assertEqual(result['changes'][0]['after']['series'][0]['points'][1]['y'], knot['y'] + 20)
        self.assertEqual(base64.b64decode(service.export({**plan, 'revision': 2, 'operations': []})['file']), raw)
        self.assertEqual(store.source_bytes(pid, digest), raw)

    def test_rotated_scene_uses_same_visible_coordinates(self):
        raw, box = fixture(rotation=180)
        scene = scenes.prepare_scene(raw, 0, box)
        track = scene['linearTracks'][0]; knot = track['knots'][1]
        edited = evaluate(scene, [{'id': 'drag', 'kind': 'linear-edit', 'seriesId': track['id'], 'knotId': knot['id'],
                                   'target': [knot['x'], knot['y'] + 20]}])['scene']
        output, _ = paint.export_scene(raw, scene, edited)
        self.assertEqual(_verify_output(raw, output, scene), [])
        self.assertNotEqual(paint.render_png(raw, 0, box, 144), paint.render_png(output, 0, box, 144))

    def test_preview_background_and_pdf_cleanup_keep_observed_neutral_pixels(self):
        from paper_chart_linear_paint import _clear_overlay
        raw, box = fixture(); scene = scenes.prepare_scene(raw, 0, box)
        scale = scene['linearScale']
        original = cv.imdecode(np.frombuffer(paint.render_png(raw, 0, box, scene['dpi'] * scale), np.uint8), cv.IMREAD_COLOR)
        masks = [cv.imdecode(np.frombuffer(base64.b64decode(t['sourceMaskPng']), np.uint8), cv.IMREAD_GRAYSCALE) > 0
                 for t in scene['linearTracks']]
        mask = np.logical_or.reduce(masks)
        neutral = (original.max(axis=2).astype(int) - original.min(axis=2) <= 4) & mask & (original.min(axis=2) < 254)
        self.assertGreater(int(neutral.sum()), 0)
        preview = cv.imdecode(np.frombuffer(base64.b64decode(scene['linearBasePng']), np.uint8), cv.IMREAD_COLOR)
        overlay = cv.imdecode(np.frombuffer(_clear_overlay(raw, scene), np.uint8), cv.IMREAD_UNCHANGED)
        self.assertTrue(np.array_equal(preview[neutral], original[neutral]))
        self.assertTrue(np.array_equal(overlay[:, :, :3][neutral], original[neutral]))


if __name__ == '__main__':
    unittest.main()

"""Nested/shared raster graph edits. Fixtures are generated; no private PDF is read."""
import copy
import io
import json
import sys
import unittest
from pathlib import Path

import pikepdf
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import paper_chart_paint as paint
from paper_chart_scene import prepare_scene
from paper_chart_edit_service import _verify_output
from test_paper_chart_raster_edit import chart_image, embed


def nested_graph(depth=2, inherited=False):
    pdf = pikepdf.open(io.BytesIO(embed(chart_image())[0]))
    page = pdf.pages[0]
    resources = page.Resources
    root_resources = pikepdf.Dictionary({key: resources[key] for key in resources.keys()})
    data = page.Contents.read_bytes()
    root_xobjects = pikepdf.Dictionary({name: resources.XObject[name] for name in resources.XObject.keys()})
    for level in range(depth):
        form = pdf.make_stream(data)
        form.Type, form.Subtype = pikepdf.Name.XObject, pikepdf.Name.Form
        form.BBox = pikepdf.Array([0, 0, 160, 120])
        form.Matrix = pikepdf.Array([1, 0, 0, 1, 0, 0])
        if not inherited:
            form.Resources = resources
        name = '/Layer%d' % level
        root_xobjects[pikepdf.Name(name)] = form
        resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary({name: form}))
        data = (name + ' Do').encode('ascii')
    page.MediaBox = pikepdf.Array([0, 0, 400, 240])
    root_resources.XObject = root_xobjects
    page.Resources = root_resources if inherited else resources
    page.Contents = pdf.make_stream(b'q 1 0 0 1 20 100 cm ' + data + b' Q\nq 1 0 0 1 220 100 cm ' + data + b' Q')
    control = pdf.add_blank_page(page_size=(400, 240))
    control.Resources = page.Resources
    control.Contents = pdf.make_stream(b'q 1 0 0 1 20 100 cm ' + data + b' Q')
    out = io.BytesIO()
    pdf.save(out)
    pdf.close()
    return out.getvalue()


def changed_scene(built, series_index=0):
    edited = copy.deepcopy(built)
    series = edited['series'][series_index]
    middle = len(series['points']) // 2
    for point in series['points'][max(0, middle - 2):middle + 3]:
        point['y'] -= 5
    return edited


class NestedRasterGraphTests(unittest.TestCase):
    def test_nested_shared_graph_survives_worker_json_boundary(self):
        for depth in (1, 2, 3):
            with self.subTest(depth=depth):
                raw = nested_graph(depth)
                built = json.loads(json.dumps(prepare_scene(raw, 0, [15, 15, 185, 145])))
                self.assertTrue(built['series'])
                self.assertTrue(all(len(s['sourceBinding']['imageOccurrence']['ancestors']) == depth for s in built['series']))
                output, report = paint.export_scene(raw, built, changed_scene(built))
                self.assertNotEqual(output, raw)
                self.assertTrue(report['formIsolated'])
                self.assertEqual(_verify_output(raw, output, built), [])
                source, result = pymupdf.open(stream=raw, filetype='pdf'), pymupdf.open(stream=output, filetype='pdf')
                try:
                    other = pymupdf.Rect(215, 15, 385, 145)
                    self.assertEqual(source[0].get_pixmap(clip=other).samples, result[0].get_pixmap(clip=other).samples)
                    self.assertEqual(source[2].get_pixmap().samples, result[2].get_pixmap().samples)
                finally:
                    source.close(); result.close()
                self.assertEqual(paint.export_scene(raw, built, built)[0], raw)

    def test_form_resources_can_be_inherited(self):
        raw = nested_graph(2, inherited=True)
        built = json.loads(json.dumps(prepare_scene(raw, 0, [15, 15, 185, 145])))
        self.assertTrue(built['series'])
        output, _ = paint.export_scene(raw, built, changed_scene(built))
        self.assertEqual(_verify_output(raw, output, built), [])

    def test_both_shared_invocations_are_cloned_independently(self):
        raw = nested_graph(2)
        built = json.loads(json.dumps(prepare_scene(raw, 0, [10, 10, 390, 150])))
        occurrences = {json.dumps(s['sourceBinding']['imageOccurrence'], sort_keys=True) for s in built['series']}
        self.assertEqual(len(occurrences), 2)
        edited = copy.deepcopy(built)
        for series in edited['series']:
            middle = len(series['points']) // 2
            series['points'][middle]['y'] -= 4
        output, report = paint.export_scene(raw, built, edited)
        self.assertFalse(report['noop'])
        self.assertEqual(_verify_output(raw, output, built), [])

    def test_structured_form_is_not_cloned_without_parent_tree_mapping(self):
        pdf = pikepdf.open(io.BytesIO(nested_graph(1)))
        pdf.pages[0].Resources.XObject['/Layer0'].StructParents = 0
        out = io.BytesIO(); pdf.save(out); pdf.close()
        with self.assertRaisesRegex(ValueError, '^tagged-form$'):
            prepare_scene(out.getvalue(), 0, [15, 15, 185, 145])


if __name__ == '__main__':
    unittest.main()

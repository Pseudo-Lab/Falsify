import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_shape_core as shape


NODE_HELPER = r"""
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const bundle = readFileSync(process.argv[2], 'utf8');
const payload = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const context = vm.createContext({});
vm.runInContext(bundle, context, {timeout: 5000});
process.stdout.write(context.FalsifyChartShape.applyPlanJSON(JSON.stringify(payload.scene), JSON.stringify(payload.operations)));
"""


def line_scene():
    points = [{'x': index * 10, 'y': 50, 'origin': 'sample'} for index in range(7)]
    return {
        'schema': 'falsify.chart-scene.v1', 'sceneId': 'scene-1', 'sourceFileHash': 'a' * 64,
        'pageIndex': 0, 'bbox': [0, 0, 120, 80], 'width': 220, 'height': 140,
        'plotBbox': [12, 10, 200, 120], 'revision': 0,
        'series': [{'id': 's', 'name': 'Trial', 'color': '#1f77b4', 'style': {'width': 1.5},
                    'binding': {'seqno': 9}, 'points': points},
                   {'id': 'other', 'color': '#d62728', 'style': {'width': 1},
                    'points': [{'x': 20, 'y': 53, 'branch': 'b'}, {'x': 30, 'y': 53, 'branch': 'b'}]}],
    }


def node_apply(scene, operations):
    payload = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
    helper = tempfile.NamedTemporaryFile('w', suffix='.mjs', delete=False, encoding='utf-8')
    try:
        json.dump({'scene': scene, 'operations': operations}, payload, allow_nan=False)
        payload.close()
        helper.write(NODE_HELPER)
        helper.close()
        done = subprocess.run(
            ['node', helper.name, str(shape.BUNDLE), payload.name],
            check=True, capture_output=True, text=True,
        )
    finally:
        payload.close()
        helper.close()
        os.unlink(payload.name)
        os.unlink(helper.name)
    return json.loads(done.stdout)


class ChartShapeCoreTests(unittest.TestCase):
    def test_identity_and_exact_support_boundary(self):
        scene = line_scene()
        same = shape.evaluate(scene, [])
        self.assertEqual(same['scene']['series'][0]['points'], scene['series'][0]['points'])
        self.assertEqual(same['changes'], [])
        self.assertEqual(scene['series'][0]['points'][2]['y'], 50)
        edited = shape.evaluate(scene, [{
            'id': 'd', 'kind': 'deform', 'seriesId': 's', 'center': [20, 50], 'radius': 10, 'dx': 0, 'dy': -8,
        }])
        points = edited['scene']['series'][0]['points']
        self.assertEqual(points[2]['y'], 42)
        self.assertEqual(points[2]['origin'], 'sample')
        self.assertEqual(points[1]['y'], 50)
        self.assertEqual(points[3]['x'], 30)
        self.assertEqual(points[3]['y'], 50)
        self.assertEqual(edited['scene']['series'][1]['points'], scene['series'][1]['points'])
        self.assertEqual(scene['series'][0]['points'][2]['y'], 50)
        self.assertEqual(edited['changes'][0]['indexes'], [2])

    def test_python_matches_the_javascript_bundle(self):
        scene = line_scene()
        scene['series'][0]['points'][4]['y'] = 52.5
        operations = [
            {'id': 'd', 'kind': 'deform', 'seriesId': 's', 'center': [20, 50], 'radius': 30, 'dx': 1, 'dy': -8},
            {'id': 'm', 'kind': 'move', 'seriesId': 's', 'range': [4, 5], 'dx': 3, 'dy': -2},
            {'id': 'r', 'kind': 'resize', 'seriesId': 's', 'range': [1, 3], 'anchor': [20, 50], 'scaleX': 2, 'scaleY': 1},
            {'id': 'v', 'kind': 'set-values', 'seriesId': 's', 'points': [{'index': 0, 'x': 1, 'y': 49}]},
        ]
        self.assertEqual(shape.evaluate(scene, operations), node_apply(scene, operations))
        self.assertEqual(scene['series'][0]['points'][0]['x'], 0)

    def test_invalid_radius_is_rejected(self):
        with self.assertRaises(ValueError) as caught:
            shape.evaluate(line_scene(), [{
                'id': 'd', 'kind': 'deform', 'seriesId': 's', 'center': [20, 50], 'radius': 0, 'dx': 0, 'dy': -8,
            }])
        self.assertIn('chart_shape_invalid', str(caught.exception))


if __name__ == '__main__':
    unittest.main()

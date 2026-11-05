"""Scene preparation for one synthetic line/cubic page. No server and no private PDF."""
import base64
import io
import sys
import unittest
from pathlib import Path

import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_scene as scene


def build():
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
    other.draw_line((20, 40), (80, 90), color=(0, 0, 0), width=2)
    raw = doc.tobytes()
    doc.close()
    return raw


def png(data):
    if isinstance(data, str):
        data = base64.b64decode(data)
    return Image.open(io.BytesIO(data)).convert('RGB')


def near(image, x, y, pred, radius=2):
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            xx, yy = int(x) + dx, int(y) + dy
            if 0 <= xx < image.width and 0 <= yy < image.height and pred(image.getpixel((xx, yy))):
                return True
    return False


def red(pixel):
    return pixel[0] > 180 and pixel[1] < 90 and pixel[2] < 90


def blue(pixel):
    return pixel[2] > 180 and pixel[0] < 90 and pixel[1] < 90


def gray(pixel):
    return max(pixel) - min(pixel) < 20 and 140 < pixel[0] < 220


def _line_distance(point, start, end):
    span = ((end['x'] - start['x']) ** 2 + (end['y'] - start['y']) ** 2) ** 0.5
    if span < 1e-6:
        return 0
    area = abs((end['x'] - start['x']) * (start['y'] - point['y']) - (start['x'] - point['x']) * (end['y'] - start['y']))
    return area / span


def _bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return (u ** 3 * p0[0] + 3 * u ** 2 * t * p1[0] + 3 * u * t ** 2 * p2[0] + t ** 3 * p3[0],
            u ** 3 * p0[1] + 3 * u ** 2 * t * p1[1] + 3 * u * t ** 2 * p2[1] + t ** 3 * p3[1])


def _nearest(points, target):
    return min(((point['x'] - target[0]) ** 2 + (point['y'] - target[1]) ** 2) ** 0.5 for point in points)


class SceneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = build()
        cls.scene = scene.prepare_scene(cls.raw, 0, [0, 0, 400, 300])

    def test_schema_and_y_down_points(self):
        built = self.scene
        self.assertEqual(built['schema'], 'falsify.chart-scene.v1')
        self.assertEqual(built['revision'], 0)
        self.assertEqual(built['pageIndex'], 0)
        self.assertEqual(built['width'], 400)
        self.assertEqual(built['height'], 300)
        self.assertEqual(len(built['sourceFileHash']), 64)
        colors = [item['color'] for item in built['series']]
        self.assertEqual(colors, ['#ff0000', '#008000', '#008000', '#0000ff'])
        red_series = built['series'][0]
        self.assertEqual(red_series['sourceBinding']['kind'], 'native-path')
        self.assertNotIn('operatorIndex', red_series['sourceBinding'])
        ends = red_series['points']
        self.assertGreater(len(ends), 2)
        self.assertEqual((round(ends[0]['x']), round(ends[0]['y'])), (60, 240))
        self.assertEqual((round(ends[-1]['x']), round(ends[-1]['y'])), (340, 70))
        self.assertGreater(ends[0]['y'], ends[-1]['y'])
        self.assertTrue(all(point['origin'] == 'pdf-vector' for point in ends))
        self.assertTrue(all(point['role'] != 'curve-control' for point in ends))
        self.assertEqual([command['op'] for command in red_series['sourceBinding']['commands']], ['m', 'l'])
        for point in ends[1:-1]:
            self.assertLess(_line_distance(point, ends[0], ends[-1]), 0.75)
        cubic = built['series'][3]
        self.assertGreater(len(cubic['points']), 4)
        self.assertEqual(cubic['points'][0]['role'], 'source-endpoint')
        self.assertEqual(cubic['points'][-1]['role'], 'source-endpoint')
        self.assertTrue(all(point['role'] != 'curve-control' for point in cubic['points']))
        self.assertIn('c', [command['op'] for command in cubic['sourceBinding']['commands']])
        cubic_command = next(command for command in cubic['sourceBinding']['commands'] if command['op'] == 'c')
        self.assertEqual(len(cubic_command['operands']), 6)
        self.assertLess(_nearest(cubic['points'], _bezier((60, 200), (120, 40), (250, 260), (340, 90), 0.5)), 1.5)
        self.assertGreater(_nearest(cubic['points'], (120, 40)), 8)
        self.assertEqual(cubic['style']['dashes'], [3, 2, 0])
        self.assertGreater(cubic['style']['width'], 2)
        # Both fragments of one paint share MuPDF's seqno, so seqno cannot name a fragment.
        self.assertEqual(built['series'][1]['sourceBinding']['muSeqno'], built['series'][2]['sourceBinding']['muSeqno'])
        self.assertNotEqual(red_series['sourceBinding']['muSeqno'], built['series'][1]['sourceBinding']['muSeqno'])

    def test_background_removes_curves_and_keeps_grid_and_text(self):
        original, background = png(self.scene['originalPng']), png(self.scene['backgroundPng'])
        self.assertEqual(original.size, background.size)
        self.assertTrue(near(original, 200, 155, red))
        self.assertFalse(near(background, 200, 155, red, radius=3))
        self.assertTrue(near(original, 60, 200, blue))
        self.assertFalse(near(background, 60, 200, blue, radius=4))
        self.assertTrue(near(original, 80, 140, gray))
        self.assertTrue(near(background, 80, 140, gray))
        self.assertEqual(original.getpixel((80, 140)), background.getpixel((80, 140)))
        dark = next((x, y) for y in range(12, 36) for x in range(36, 90)
                    if original.getpixel((x, y))[0] < 40)
        self.assertEqual(original.getpixel(dark), background.getpixel(dark))
        changed = sum(original.getpixel((x, y)) != background.getpixel((x, y))
                      for y in range(original.height) for x in range(original.width))
        self.assertGreater(changed, 50)
        self.assertLess(changed / (original.width * original.height), 0.12)


if __name__ == '__main__':
    unittest.main()

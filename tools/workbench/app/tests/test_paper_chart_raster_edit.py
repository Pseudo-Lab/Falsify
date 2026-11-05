"""Raster grid-crossing edits. The chart image is synthetic; no private paper is read."""
import copy
import io
import sys
import unittest
import zlib
from pathlib import Path

import cv2
import numpy as np
import pikepdf
import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import paper_chart_paint as paint
import paper_chart_raster_edit as raster
import paper_chart_scene as scene

RED = (220, 30, 30)
GRID = (180, 180, 180)


def chart_image():
    image = np.full((120, 160, 3), 255, np.uint8)
    for y in (30, 60, 90):
        cv2.line(image, (0, y), (159, y), GRID, 1, lineType=cv2.LINE_8)
    for x in (40, 80, 120):
        cv2.line(image, (x, 0), (x, 119), GRID, 1, lineType=cv2.LINE_8)
    image[4:16, 4:24] = (0, 0, 0)
    cv2.line(image, (50, 100), (150, 24), RED, 3, lineType=cv2.LINE_8)
    return image


def crossing(image):
    mask = raster.color_mask(image, RED)
    for y in (30, 60, 90):
        xs = np.where(mask[y])[0]
        if len(xs):
            return int(xs[len(xs) // 2]), y
    raise AssertionError('curve does not cross a grid row')


def embed(image):
    height, width = image.shape[:2]
    pdf = pikepdf.new()
    samples = np.ascontiguousarray(image).tobytes()
    stream = pdf.make_stream(zlib.compress(samples))
    stream.Type = pikepdf.Name.XObject
    stream.Subtype = pikepdf.Name.Image
    stream.Width = width
    stream.Height = height
    stream.ColorSpace = pikepdf.Name.DeviceRGB
    stream.BitsPerComponent = 8
    stream.Filter = pikepdf.Name.FlateDecode
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                                                BaseFont=pikepdf.Name.Helvetica))

    def add(target):
        page = pdf.add_blank_page(page_size=(width, height))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font),
                                            XObject=pikepdf.Dictionary(Im1=target))
        page.Contents = pdf.make_stream(
            ('q\n%d 0 0 %d 0 0 cm\n/Im1 Do\nQ\nBT /F1 12 Tf 8 14 Td (Keep) Tj ET\n' % (width, height)).encode('ascii'))

    add(stream)
    add(stream)
    buf = io.BytesIO()
    pdf.save(buf, deterministic_id=True)
    return buf.getvalue(), samples


def image_samples(raw, page_index):
    pdf = pikepdf.open(io.BytesIO(raw))
    try:
        data = pdf.pages[page_index].Contents.read_bytes()
        resources = pdf.pages[page_index].Resources.XObject
        name = '/Im1'
        for key in resources.keys():
            if b'/' + str(key).lstrip('/').encode('ascii') in data and str(key).startswith('/ChartIm'):
                name = str(key)
                break
        if page_index == 0 and b'/ChartIm' in data:
            name = next(str(key) for key in resources.keys() if str(key).startswith('/ChartIm'))
        stream = resources[name]
        return stream.read_bytes(), int(stream.Width), int(stream.Height), pdf.pages[page_index].Contents.read_bytes()
    finally:
        pdf.close()


class RasterPixelTests(unittest.TestCase):
    def test_grid_crossing_restores_and_keeps_nonmask_pixels(self):
        image = chart_image()
        x, y = crossing(image)
        self.assertEqual(tuple(int(channel) for channel in image[y, x]), RED)
        traced = raster.trace_series(image)
        self.assertEqual(len(traced), 1)
        self.assertEqual(traced[0]['color'], RED)
        self.assertGreaterEqual(traced[0]['width'], 3)
        moved = [(point[0], point[1] - 36) for point in traced[0]['points']]
        edited = raster.edit_raster(image, traced[0]['points'], moved, RED, traced[0]['width'])
        self.assertEqual(edited.shape, image.shape)
        self.assertEqual(tuple(int(channel) for channel in edited[y, x]), GRID)
        old_mask = raster.color_mask(image, RED)
        new_mask = raster.color_mask(edited, RED)
        unchanged = ~old_mask & ~new_mask
        self.assertTrue(np.array_equal(image[unchanged], edited[unchanged]))
        self.assertTrue(np.array_equal(image[4:16, 4:24], edited[4:16, 4:24]))
        self.assertEqual(tuple(int(channel) for channel in image[10, 10]), (0, 0, 0))
        self.assertFalse(new_mask[y, x])
        same = raster.edit_raster(image, traced[0]['points'], traced[0]['points'], RED, traced[0]['width'])
        self.assertTrue(np.array_equal(same, image))

    def test_same_color_branch_and_unmoved_span_keep_original_pixels(self):
        image = chart_image()
        cv2.line(image, (12, 18), (28, 100), RED, 3, lineType=cv2.LINE_8)
        traced = raster.trace_series(image)
        self.assertEqual(len(traced), 2)
        self.assertEqual({item['branch'] for item in traced}, {'b0', 'b1'})
        long = max(traced, key=lambda item: max(point[0] for point in item['points']) - min(point[0] for point in item['points']))
        short = next(item for item in traced if item is not long)
        self.assertLess(max(point[0] for point in short['points']), 40)
        moved = []
        for point in long['points']:
            if 80 <= point[0] <= 120:
                moved.append((point[0], point[1] - 24))
            else:
                moved.append(point)
        edited = raster.edit_raster(image, long['points'], moved, RED, long['width'])
        start = min(long['points'], key=lambda point: point[0])
        sx, sy = int(round(start[0])), int(round(start[1]))
        self.assertEqual(tuple(int(channel) for channel in image[sy, sx]), tuple(int(channel) for channel in edited[sy, sx]))
        for y, x in zip(*np.where(raster.color_mask(image, RED))):
            if x < 36:
                self.assertEqual(tuple(int(channel) for channel in image[y, x]), tuple(int(channel) for channel in edited[y, x]))
        self.assertTrue(np.array_equal(image[4:16, 4:24], edited[4:16, 4:24]))


class RasterPdfTests(unittest.TestCase):
    def test_noop_and_edited_pdf_keep_resolution_text_and_other_use(self):
        image = chart_image()
        raw, samples = embed(image)
        x, y = crossing(image)
        built = scene.prepare_scene(raw, 0, [0, 0, 160, 120], {'plotBbox': [32, 0, 160, 110]})
        self.assertEqual(len(built['series']), 1)
        self.assertEqual(built['series'][0]['sourceBinding']['kind'], 'raster-image')
        self.assertEqual(built['series'][0]['sourceBinding']['imageSize'], [160, 120])
        self.assertEqual(built['width'], 160)
        self.assertEqual(built['height'], 120)
        output, report = paint.export_scene(raw, built, copy.deepcopy(built))
        self.assertTrue(report['noop'])
        self.assertEqual(output, raw)
        edited = copy.deepcopy(built)
        for point in edited['series'][0]['points']:
            point['y'] = float(point['y']) - 36
        edited['series'][0]['sourceBinding']['operatorIndex'] = 0
        output, report = paint.export_scene(raw, built, edited)
        self.assertFalse(report['noop'])
        self.assertTrue(report['formIsolated'])
        new_samples, width, height, page = image_samples(output, 0)
        other_samples, other_w, other_h, other_page = image_samples(output, 1)
        self.assertEqual((width, height), (160, 120))
        self.assertEqual((other_w, other_h), (160, 120))
        self.assertEqual(other_samples, samples)
        self.assertIn(b'(Keep) Tj', page)
        self.assertIn(b'(Keep) Tj', other_page)
        self.assertNotIn(b'/ChartIm', other_page)
        edited_image = np.frombuffer(new_samples, dtype=np.uint8).reshape((120, 160, 3))
        self.assertEqual(tuple(int(channel) for channel in edited_image[y, x]), GRID)
        self.assertTrue(np.array_equal(edited_image[4:16, 4:24], image[4:16, 4:24]))
        old_mask = raster.color_mask(image, RED)
        new_mask = raster.color_mask(edited_image, RED)
        unchanged = ~old_mask & ~new_mask
        self.assertTrue(np.array_equal(image[unchanged], edited_image[unchanged]))
        doc = pymupdf.open(stream=output, filetype='pdf')
        source = pymupdf.open(stream=raw, filetype='pdf')
        try:
            self.assertEqual(doc[0].get_text('text'), source[0].get_text('text'))
            self.assertEqual(doc[1].get_text('text'), 'Keep\n')
            pix = doc[0].get_pixmap(dpi=72, alpha=False)
            self.assertEqual((pix.width, pix.height), (160, 120))
            self.assertEqual(pix.pixel(x, y), GRID)
        finally:
            doc.close()
            source.close()

    def test_icc_image_and_scaled_stroke_width(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from chart_shape_fixture import chart_pdf
        raw = chart_pdf()
        built = scene.prepare_scene(raw, 1, [45, 55, 385, 265])
        self.assertGreaterEqual(len(built['series']), 1)
        series = built['series'][0]
        self.assertEqual(series['sourceBinding']['kind'], 'raster-image')
        self.assertGreater(len(series['points']), 20)
        self.assertTrue(all(point.get('branch') for point in series['points']))
        # 680px image in a 340pt box: a 3px stroke is about 1.5 crop pixels, not 3.
        self.assertGreater(series['style']['width'], 0.8)
        self.assertLess(series['style']['width'], 2.4)
        edited = copy.deepcopy(built)
        middle = len(edited['series'][0]['points']) // 2
        for point in edited['series'][0]['points'][max(0, middle - 8):middle + 9]:
            point['y'] = float(point['y']) - 10
        output, report = paint.export_scene(raw, built, edited)
        self.assertFalse(report['noop'])
        pdf = pikepdf.open(io.BytesIO(output))
        try:
            resources = pdf.pages[1].Resources.XObject
            clone = next(resources[key] for key in resources.keys() if str(key).startswith('/ChartIm'))
            self.assertEqual(str(clone.ColorSpace[0]), '/ICCBased')
            self.assertEqual(clone.ColorSpace[1].read_bytes(), next(resources[k] for k in resources.keys() if not str(k).startswith('/ChartIm')).ColorSpace[1].read_bytes())
            self.assertEqual(int(clone.BitsPerComponent), 8)
            self.assertIsNone(clone.get('/Decode'))
            self.assertEqual(int(clone.Width), 680)
            self.assertEqual(int(clone.Height), 420)
            self.assertEqual(len(clone.read_bytes()), 680 * 420 * 3)
            untouched = pdf.pages[0].Resources.get('/XObject')
            if untouched is not None:
                self.assertFalse(any(str(key).startswith('/ChartIm') for key in untouched.keys()))
        finally:
            pdf.close()
        doc = pymupdf.open(stream=output, filetype='pdf')
        source = pymupdf.open(stream=raw, filetype='pdf')
        try:
            self.assertEqual(doc[1].get_text('text'), source[1].get_text('text'))
            self.assertEqual(doc[0].get_pixmap(alpha=False).samples, source[0].get_pixmap(alpha=False).samples)
            self.assertEqual(doc[2].get_text('text'), source[2].get_text('text'))
        finally:
            doc.close()
            source.close()


class WorkingResolutionTests(unittest.TestCase):
    def test_antialias_shades_share_one_source_ink_palette(self):
        colors = [(20+i,100+i,185+i) for i in range(20)]
        image = np.full((100,200,3),255,np.uint8)
        for i,color in enumerate(colors):
            image[10+i*3:12+i*3,20:180]=color
        palette = raster._colors(image)
        self.assertEqual(len(palette),1)
        self.assertIn(palette[0],colors)

    def test_large_source_traces_in_bounded_crop_and_maps_back(self):
        image = np.full((1800,2600,3),255,np.uint8)
        cv2.line(image,(400,1250),(2200,350),RED,5)
        traced = raster.trace_series(image,[350,300,2250,1300])
        self.assertEqual(len(traced),1)
        points = traced[0]['points']
        self.assertGreater(len(points),10)
        self.assertLess(max(abs(y-(1450-.5*x)) for x,y in points),6)
        self.assertLess(min(x for x,y in points),410)
        self.assertGreater(max(x for x,y in points),2190)


if __name__ == '__main__':
    unittest.main()

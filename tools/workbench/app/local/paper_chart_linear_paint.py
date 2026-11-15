"""Erase original data ink locally, draw straight PDF paths and move source glyphs."""
import base64


def _insert_rgba(page, rect, png):
    """Keep straight RGB samples separate from alpha to avoid premultiplied halos."""
    import cv2 as cv
    import numpy as np
    image = cv.imdecode(np.frombuffer(png, np.uint8), cv.IMREAD_UNCHANGED)
    doc = page.parent
    xref = doc.get_new_xref()
    mask = doc.get_new_xref()
    height, width = image.shape[:2]
    doc.update_object(xref, f'<</Type/XObject/Subtype/Image/Width {width}/Height {height}'
                      '/ColorSpace/DeviceRGB/BitsPerComponent 8>>')
    doc.update_stream(xref, cv.cvtColor(image[:, :, :3], cv.COLOR_BGR2RGB).tobytes(), compress=True)
    doc.update_object(mask, f'<</Type/XObject/Subtype/Image/Width {width}/Height {height}'
                      '/ColorSpace/DeviceGray/BitsPerComponent 8>>')
    doc.update_stream(mask, image[:, :, 3].tobytes(), compress=True)
    doc.xref_set_key(xref, 'SMask', f'{mask} 0 R')
    page.insert_image(rect, xref=xref, keep_proportion=False, rotate=page.rotation, overlay=True)
    return xref


def changed(before, after):
    def geometry(scene):
        return [(t['id'], t['knots']) for t in scene.get('linearTracks', [])]
    return geometry(before) != geometry(after)


def _source_points(track):
    return {k['id']: k for k in track['sourceKnots']}


def _target_box(decoration, track):
    source = _source_points(track)[decoration['knotId']]
    target = next(k for k in track['knots'] if k['id'] == decoration['knotId'])
    dx, dy = target['x'] - source['x'], target['y'] - source['y']
    box = decoration['bbox']
    return [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy]


def _page_rect(box, scene, page, mu):
    x, y = scene['bbox'][:2]
    scale = 72 / scene['dpi']
    return mu.Rect(x + box[0] * scale, y + box[1] * scale,
                   x + box[2] * scale, y + box[3] * scale) * page.derotation_matrix


def _draw_track(page, scene, track, mu):
    scale = 72 / scene['dpi']
    x, y = scene['bbox'][:2]
    points = [mu.Point(x + k['x'] * scale, y + k['y'] * scale) * page.derotation_matrix for k in track['knots']]
    color = tuple(int(track['color'][i:i + 2], 16) / 255 for i in (1, 3, 5))
    shape = page.new_shape()
    shape.draw_polyline(points)
    shape.finish(color=color, width=track['width'] * scale, closePath=False, lineCap=0, lineJoin=0)
    shape.commit(overlay=True)
    for decoration in track['decorations']:
        _insert_rgba(page, _page_rect(_target_box(decoration, track), scene, page, mu),
                     base64.b64decode(decoration['png']))


def _clear_overlay(raw, scene):
    import cv2 as cv
    import numpy as np
    import paper_chart_paint as paint
    from paper_chart_linear import _rgb
    from paper_chart_background import restore_background
    scale = scene['linearScale']
    rgb = _rgb(paint.render_png(raw, scene['pageIndex'], scene['bbox'], scene['dpi'] * scale), cv, np)
    masks = [cv.imdecode(np.frombuffer(base64.b64decode(t['sourceMaskPng']), np.uint8), cv.IMREAD_GRAYSCALE) > 0
             for t in scene['linearTracks']]
    mask = np.logical_or.reduce(masks)
    restored = restore_background(rgb, mask)
    # Copy visible neutral paint through the expanded AA cleanup corridor unchanged.
    rgba = np.dstack([cv.cvtColor(restored, cv.COLOR_RGB2BGR), mask.astype(np.uint8) * 255])
    ok, png = cv.imencode('.png', rgba)
    if not ok:
        raise ValueError('bad-image')
    return png.tobytes()


def export_linear(raw, scene, edited):
    import pymupdf as mu
    import paper_chart_paint as paint
    with mu.open(stream=raw, filetype='pdf') as doc:
        page = doc[scene['pageIndex']]
        _insert_rgba(page, mu.Rect(scene['bbox']) * page.derotation_matrix,
                     _clear_overlay(raw, scene))
        for track in edited['linearTracks']:
            _draw_track(page, scene, track, mu)
        output = doc.tobytes(garbage=0, deflate=True)
    changed_ids = [a['id'] for a, b in zip(scene['linearTracks'], edited['linearTracks']) if a['knots'] != b['knots']]
    return output, paint._report(False, changed_ids, True, 'source-linear')

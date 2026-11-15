"""Chart scene preparation for falsify.chart-scene.v1.

prepare_scene(source, page_index, bbox, options=None) -> scene

Points are crop pixels, top-left origin, y downward. Native bindings are geometry
fingerprints of the source paint. MuPDF seqno and any caller operator index are
not addresses. Axis-aligned strokes stay in the background with text and grids.
backgroundPng is the crop with editable series removed. originalPng is the crop
as painted. render_scene and export_scene live in paper_chart_paint.
"""
import base64
import hashlib
import math

SCHEMA = 'falsify.chart-scene.v1'


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _bbox(bbox):
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4 or not all(_finite(value) for value in bbox):
        raise ValueError('bad-bbox')
    box = [float(value) for value in bbox]
    if not (box[0] < box[2] and box[1] < box[3]):
        raise ValueError('bad-bbox')
    return box


def _dpi(options):
    dpi = 72 if not isinstance(options, dict) or options.get('dpi') is None else options.get('dpi')
    if isinstance(dpi, bool) or not _finite(dpi) or dpi <= 0:
        raise ValueError('bad-dpi')
    return float(dpi)


def _plot(options, width, height):
    if not isinstance(options, dict) or options.get('plotBbox') is None:
        return [0, 0, width, height]
    box = options.get('plotBbox')
    if not isinstance(box, (list, tuple)) or len(box) != 4 or not all(_finite(value) for value in box):
        raise ValueError('bad-plot')
    plot = [float(value) for value in box]
    if not (plot[0] < plot[2] and plot[1] < plot[3]):
        raise ValueError('bad-plot')
    return plot


def _png_size(png):
    if png[12:16] != b'IHDR':
        raise ValueError('bad-png')
    import struct
    return struct.unpack('>II', png[16:24])


def prepare_scene(source, page_index, bbox, options=None):
    """Build a chart scene from one PDF page crop. The source bytes are not modified."""
    import paper_chart_paint as paint
    if type(page_index) is not int or page_index < 0:
        raise ValueError('bad-page')
    if not isinstance(source, (bytes, bytearray)):
        raise ValueError('bad-source')
    raw = bytes(source)
    box = _bbox(bbox)
    dpi = _dpi(options)
    width, height = paint.crop_size(box, dpi)
    plot = _plot(options, width, height)
    series = paint.series_for_crop(raw, page_index, box, dpi, plot)
    from paper_chart_curve_links import curve_links
    links = curve_links(series, dpi)
    original = paint.render_png(raw, page_index, box, dpi)
    if _png_size(original) != (width, height):
        width, height = _png_size(original)
    if series:
        stripped = paint.strip_series(raw, page_index, box, dpi, series, curve_links=links)
        background = paint.render_png(stripped, page_index, box, dpi)
    else:
        background = original
    digest = hashlib.sha256(raw).hexdigest()
    scene_id = hashlib.sha256(('%s\n%s\n%s\n%s' % (digest, page_index, ','.join('%.4f' % v for v in box), dpi)).encode('ascii')).hexdigest()
    scene = {
        'schema': SCHEMA,
        'sceneId': scene_id,
        'sourceFileHash': digest,
        'pageIndex': page_index,
        'bbox': box,
        'width': width,
        'height': height,
        'plotBbox': plot,
        'revision': 0,
        'dpi': dpi,
        'backgroundPng': base64.b64encode(background).decode('ascii'),
        'originalPng': base64.b64encode(original).decode('ascii'),
        'series': series,
        'curveLinks': links,
    }
    from paper_chart_linear import augment
    return augment(raw, scene)

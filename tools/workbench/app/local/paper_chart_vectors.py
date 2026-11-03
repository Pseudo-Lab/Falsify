"""Native PDF line and cubic strokes for one calibrated chart crop.

Public API:
  rows_from_geometry(geometry) -> (columns, rows, numeric_cells)
  prefer_native_paths(source_bytes, *, page_index, crop, dpi, width, height,
      raster, calibration=None, series=None, plot_bbox=None) -> chart-data dict

The reader uses PyMuPDF Page.get_drawings(extended=True) and paper_digitizer._axis.
It does not import paper_chart, cv2, numpy, or torch. Source bytes are only read.

A stroke replaces raster samples only when axis calibration is usable, its color
matches one series, and the path is a visible line/cubic inside a rectangular clip.
Matching uses effectiveColor when the candidate has one, and keeps requestedColor.
Line vertices and cubic endpoints are origin 'pdf-vector-calibrated'. Interior
cubic samples are adaptive de Casteljau points, origin 'curve-interpolated', and
are not measured observations. Their pixel error is bounded by 0.25px unless the
shared point budget forces a recorded larger bound. Control points stay in
sourceStroke.commands, in unrotated page points. Canonical sourcePoint is the
public page.rect point; sourcePagePoint keeps the unrotated point. The 480-point
and 64-series caps cover accepted components and any retained raster series.
Rectangle frames, gridlines, ticks, legends, zero-opacity strokes, strokes
covered by a later opaque fill, and strokes whose bounds meet a later image
fall back to the raster result. A background image painted before the stroke
does not hide it. Closed data curves and stair-step or flat data strokes are
kept. Drawings outside the crop do not consume the page budget.
provenance.method is left unchanged; provenance.vector is 'pdf-native-path'.
"""
import copy
import hashlib
import math

_COLOR_DISTANCE = 31
_MAX_DRAWINGS = 400
_MAX_SERIES = 64
_POINT_BUDGET = 480
_PIXEL_TOLERANCE = 0.25
_COVERING = ('fill-image', 'fill-imgmask', 'fill-shade', 'fill-path')
_STALE_ISSUES = {
    'curves-not-found', 'cartesian-axes-not-found', 'colored-continuous-curves-not-found',
    'axis-calibration-required',
}
_CELL_META = ('role', 'requestedColor', 'effectiveColor')


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def rows_from_geometry(geometry):
    """Table rows for one chart geometry. Missing point.origin is pixel-calibrated."""
    ambiguous = any(series['axisBinding'] == 'ambiguous' for series in geometry['series'])
    columns = ['series', 'axis', 'x', 'y'] if not ambiguous else ['series', 'axis', 'x', 'y(left)', 'y(right)']
    rows, numeric = [], []
    for series in geometry['series']:
        for point in series['points']:
            if ambiguous:
                candidates = point['valueCandidates']
                values = [point['x'], candidates.get('left'), candidates.get('right')]
            else:
                values = [point['x'], point.get('y')]
            row = [series['id'], series['axisBinding']] + [None if value is None else format(value, '.8g') for value in values]
            index = len(rows)
            rows.append(row)
            for column, value in enumerate(values, 2):
                if value is None:
                    continue
                origin = point.get('origin')
                cell = {'row': index, 'column': column, 'raw': row[column], 'value': value, 'unit': None,
                        'origin': origin if isinstance(origin, str) and origin else 'pixel-calibrated',
                        'sourcePixel': [point['xPixel'], point['yPixel']]}
                if column == 3 and not ambiguous:
                    cell['pixelInterval'] = point.get('pixelInterval')
                for key in _CELL_META:
                    if key in point:
                        cell[key] = point[key]
                if point.get('sourcePointSpace') == 'page-rect' and isinstance(point.get('sourcePoint'), list):
                    cell['sourcePoint'] = list(point['sourcePoint'])
                    cell['sourcePointSpace'] = 'page-rect'
                    native_point = point.get('sourcePagePoint')
                    if isinstance(native_point, list):
                        cell['sourcePagePoint'] = list(native_point)
                numeric.append(cell)
    return columns, rows, numeric


def prefer_native_paths(source_bytes, *, page_index, crop, dpi, width, height, raster,
                        calibration=None, series=None, plot_bbox=None):
    """Prefer matching native strokes. The same raster object is returned when nothing is applied."""
    if not _can_attempt(raster, calibration, series, page_index, crop, dpi, width, height):
        return raster
    if not isinstance(source_bytes, (bytes, bytearray)):
        return raster
    raw = bytes(source_bytes)
    try:
        page = _read_page(raw, page_index)
    except Exception:
        return raster
    if page is None or page.get('overflow'):
        return raster
    if _pixmap_size(crop, dpi) != (width, height):
        return raster
    geometry = raster.get('geometry') if isinstance(raster.get('geometry'), dict) else None
    converters = _converters(geometry, calibration if isinstance(calibration, dict) else None, width, height)
    if not converters:
        return raster
    candidates = _candidates(geometry, series, converters)
    if not candidates:
        return raster
    original_series = geometry.get('series') if isinstance(geometry, dict) else []
    accepted, rejected = _match_page(page, candidates, converters, crop, dpi, width, height, plot_bbox or _plot_bbox(geometry), original_series)
    if not accepted and not rejected:
        return raster
    working = copy.deepcopy(raster)
    _apply(working, accepted, rejected, converters, calibration, {
        'sha256': hashlib.sha256(raw).hexdigest(), 'pageIndex': page_index, 'crop': list(crop),
        'dpi': dpi, 'rotation': page['rotation'],
    })
    return working


def _can_attempt(raster, calibration, series, page_index, crop, dpi, width, height):
    if not isinstance(raster, dict) or raster.get('schema') != 'falsify.chart-data.v1':
        return False
    if type(page_index) is not int or page_index < 0:
        return False
    if isinstance(dpi, bool) or not _finite(dpi) or dpi <= 0:
        return False
    if type(width) is not int or type(height) is not int or width < 1 or height < 1:
        return False
    if not isinstance(crop, (list, tuple)) or len(crop) != 4 or not all(_finite(v) for v in crop):
        return False
    if not (crop[0] < crop[2] and crop[1] < crop[3]):
        return False
    geometry = raster.get('geometry') if isinstance(raster.get('geometry'), dict) else None
    axes = geometry.get('axes') if isinstance(geometry, dict) else None
    if isinstance(axes, dict) and ('x' in axes or 'left' in axes or 'right' in axes):
        return True
    return isinstance(calibration, dict) and isinstance(series, list) and bool(series)


def _pixmap_size(clip, dpi):
    zoom = dpi / 72
    return (math.ceil(clip[2] * zoom) - math.floor(clip[0] * zoom),
            math.ceil(clip[3] * zoom) - math.floor(clip[1] * zoom))


def _plot_bbox(geometry):
    if not isinstance(geometry, dict):
        return None
    box = geometry.get('plotBbox')
    if isinstance(box, (list, tuple)) and len(box) == 4 and all(_finite(v) for v in box):
        return list(box)
    return None


def _read_page(raw, page_index):
    import pymupdf
    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        if page_index >= doc.page_count:
            return None
        page = doc[page_index]
        drawings = page.get_drawings(extended=True)
        matrix = page.rotation_matrix
        return {'overflow': False, 'rotation': page.rotation % 360,
                'matrix': (matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f),
                'bboxlog': _bboxlog(page),
                'drawings': [_freeze(item) for item in drawings]}
    finally:
        doc.close()


def _freeze(drawing):
    items = []
    for item in drawing.get('items') or []:
        points = []
        for value in item[1:]:
            if hasattr(value, 'x0'):
                points.append((float(value.x0), float(value.y0), float(value.x1), float(value.y1)))
            elif hasattr(value, 'x') and hasattr(value, 'y'):
                points.append((float(value.x), float(value.y)))
            else:
                points.append(value)
        items.append((item[0], points))
    rect, scissor = drawing.get('rect'), drawing.get('scissor')
    color = drawing.get('color')
    seqno = drawing.get('seqno')
    return {'type': drawing.get('type'), 'level': drawing.get('level') or 0,
            'seqno': seqno if type(seqno) is int else None,
            'color': tuple(float(channel) for channel in color) if color else None,
            'width': drawing.get('width'), 'dashes': drawing.get('dashes'),
            'closePath': bool(drawing.get('closePath')), 'lineCap': drawing.get('lineCap'),
            'lineJoin': drawing.get('lineJoin'), 'opacity': drawing.get('stroke_opacity'),
            'items': items,
            'rect': None if rect is None else (float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)),
            'scissor': None if scissor is None else (float(scissor.x0), float(scissor.y0), float(scissor.x1), float(scissor.y1)),
            'simpleClip': drawing.get('type') == 'clip' and len(items) == 1 and items[0][0] == 're'}


def _two_point(axis, extent):
    if not isinstance(axis, dict) or axis.get('scale') not in ('linear', 'log'):
        return None
    if set(axis) == {'scale', 'points'}:
        return {'scale': axis['scale'], 'points': [{'pixel': point['pixel'], 'value': point['value']}
                                                    for point in axis['points']]}
    ticks = [tick for tick in axis.get('usedTicks') or [] if isinstance(tick, dict) and 'pixel' in tick]
    if len(ticks) < 2:
        return None
    first, last = sorted(ticks, key=lambda tick: tick['pixel'])[0], sorted(ticks, key=lambda tick: tick['pixel'])[-1]
    if _finite(axis.get('slope')) and _finite(axis.get('intercept')):
        def value_at(pixel):
            value = axis['slope'] * pixel + axis['intercept']
            return 10 ** value if axis['scale'] == 'log' else value
        try:
            points = [{'pixel': first['pixel'], 'value': value_at(first['pixel'])},
                      {'pixel': last['pixel'], 'value': value_at(last['pixel'])}]
        except OverflowError:
            return None
    elif 'value' in first and 'value' in last:
        points = [{'pixel': first['pixel'], 'value': first['value']}, {'pixel': last['pixel'], 'value': last['value']}]
    else:
        return None
    if extent is None:
        return None
    return {'scale': axis['scale'], 'points': points}


def _bind(axis, extent):
    built = _two_point(axis, extent)
    if not built:
        return None
    from paper_digitizer import _axis
    try:
        return _axis(built, extent), built
    except (ValueError, OverflowError):
        return None


def _converters(geometry, calibration, width, height):
    axes = geometry.get('axes') if isinstance(geometry, dict) else {}
    if not isinstance(axes, dict):
        axes = {}
    explicit_x = calibration.get('x') if isinstance(calibration, dict) else None
    explicit_y = calibration.get('y') if isinstance(calibration, dict) else None
    x_pair = _bind(explicit_x, width) or _bind(axes.get('x'), width)
    if not x_pair:
        return None
    out = {}
    for side, explicit in (('left', explicit_y), ('right', None)):
        pair = _bind(explicit, height) or _bind(axes.get(side), height)
        if pair:
            out[side] = {'x': x_pair[0], 'y': pair[0], 'xAxis': x_pair[1], 'yAxis': pair[1]}
    return out or None


def _hex(color):
    if not isinstance(color, str) or len(color) != 7 or color[0] != '#':
        return None
    text = color.lower()
    if any(char not in '0123456789abcdef' for char in text[1:]):
        return None
    return text


def _rgb(color):
    if not color:
        return None
    channels = list(color)
    if len(channels) == 1:
        channels = channels * 3
    if len(channels) != 3 or not all(_finite(channel) for channel in channels):
        return None
    return tuple(max(0, min(255, int(round(channel * 255)))) for channel in channels)


def _hex_rgb(color):
    text = _hex(color)
    if text is None:
        return None
    return tuple(int(text[index:index + 2], 16) for index in (1, 3, 5))


def _distance(left, right):
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(left, right)))


def _match_color(item):
    """Stroke match key. effectiveColor wins when the raster recorded one."""
    if not isinstance(item, dict):
        return None
    return _hex(item.get('effectiveColor')) or _hex(item.get('color'))


def _requested_color(item):
    if not isinstance(item, dict):
        return None
    return _hex(item.get('requestedColor')) or _hex(item.get('color'))


def _candidates(geometry, series, converters):
    pool = []
    if isinstance(geometry, dict):
        for item in geometry.get('series') or []:
            if isinstance(item, dict) and item.get('axisBinding') in converters and _match_color(item):
                pool.append(item)
    pool_rgbs = [_hex_rgb(_match_color(item)) for item in pool]
    def crowded(rgb, group):
        return sum(_distance(rgb, other) <= _COLOR_DISTANCE for other in group) > 1
    chosen = [item for item, rgb in zip(pool, pool_rgbs) if not crowded(rgb, pool_rgbs)]
    blocked = [rgb for rgb in pool_rgbs if crowded(rgb, pool_rgbs)]
    chosen_rgbs = [_hex_rgb(_match_color(item)) for item in chosen]
    pending = []
    if isinstance(series, list) and 'left' in converters:
        for item in series:
            rgb = _hex_rgb(_match_color(item)) if isinstance(item, dict) else None
            if rgb is None or not isinstance(item.get('id'), str):
                continue
            if any(_distance(rgb, other) <= _COLOR_DISTANCE for other in chosen_rgbs + blocked):
                continue
            pending.append((item, rgb))
    pending_rgbs = [rgb for _item, rgb in pending]
    for item, rgb in pending:
        if crowded(rgb, pending_rgbs) or item['id'] in {series_item.get('id') for series_item in chosen}:
            continue
        chosen.append({'id': item['id'], 'name': item.get('name'), 'color': _hex(item.get('color')) or _match_color(item),
                       'requestedColor': _requested_color(item), 'effectiveColor': _match_color(item),
                       'axisBinding': 'left', 'points': []})
    return chosen


def _series_budget(count):
    """Point cap for one accepted component once the 480-point budget is shared."""
    count = max(1, min(_MAX_SERIES, count))
    return max(2, _POINT_BUDGET // count)


def _bboxlog(page):
    log = []
    for item in page.get_bboxlog() or []:
        if len(item) < 2 or item[1] is None:
            continue
        rect = tuple(item[1])
        if len(rect) != 4:
            continue
        log.append((item[0], tuple(float(value) for value in rect)))
    return log


def _covers(outer, inner, margin=1.0):
    if outer is None or inner is None or len(outer) != 4 or len(inner) != 4:
        return False
    return (outer[0] <= inner[0] + margin and outer[1] <= inner[1] + margin
            and outer[2] >= inner[2] - margin and outer[3] >= inner[3] - margin)


def _intersects(outer, inner):
    if outer is None or inner is None or len(outer) != 4 or len(inner) != 4:
        return False
    return not (outer[2] < inner[0] or inner[2] < outer[0] or outer[3] < inner[1] or inner[3] < outer[1])


def _occluded(drawing, page):
    """A later image or opaque fill that covers this stroke hides it. Earlier paint does not."""
    log = page.get('bboxlog') or []
    rect = drawing.get('rect')
    seq = drawing.get('seqno')
    if rect is None or not isinstance(seq, int) or seq < 0 or seq >= len(log):
        return False
    end = seq
    if log[seq][0] != 'stroke-path':
        for index in range(seq, min(len(log), seq + 3)):
            if log[index][0] == 'stroke-path':
                end = index
                break
    for index in range(end + 1, len(log)):
        code, other = log[index]
        if code in ('fill-image', 'fill-imgmask'):
            if _intersects(other, rect):
                return True
            continue
        if code not in ('fill-path', 'fill-shade') or not _covers(other, rect):
            continue
        if drawing['type'] == 'fs' and code == 'fill-path' and index <= seq + 1 and _covers(rect, other):
            continue
        return True
    return False


def _native_room(kept, original_series):
    """Point and series room left after reserving raster series that are no longer replaced."""
    replaced = {item['candidate'].get('id') for item in kept}
    retained = [series for series in original_series or []
                if isinstance(series, dict) and series.get('id') not in replaced]
    retained_points = sum(len(series.get('points') or []) for series in retained)
    point_budget = max(0, _POINT_BUDGET - min(retained_points, _POINT_BUDGET))
    series_room = max(0, _MAX_SERIES - min(len(retained), _MAX_SERIES))
    return point_budget, series_room


def _match_page(page, candidates, converters, crop, dpi, width, height, plot_bbox, original_series=()):
    accepted, rejected, stack = {}, [], []
    palette = [(item, _hex_rgb(_match_color(item))) for item in candidates]
    relevant = 0
    pending = []
    for drawing in page['drawings']:
        level = drawing['level']
        while stack and stack[-1]['level'] >= level:
            stack.pop()
        if drawing['type'] == 'clip':
            stack.append(drawing)
            continue
        if drawing['type'] not in ('s', 'fs') or drawing.get('opacity') == 0:
            continue
        if _rect_outside(drawing.get('rect'), page['matrix'], crop):
            continue
        native = _rgb(drawing['color'])
        if native is None:
            continue
        matched = [item for item, rgb in palette if rgb is not None and _distance(native, rgb) <= _COLOR_DISTANCE]
        if len(matched) != 1:
            continue
        commands = _split(drawing['items'])
        if not commands:
            continue
        relevant += 1
        if relevant > _MAX_DRAWINGS:
            rejected.append(_rejection('drawing-budget', drawing, commands, page))
            break
        if _clip_uncertain(stack, drawing['rect']):
            rejected.append(_rejection('clip-uncertain', drawing, commands, page))
            continue
        if _occluded(drawing, page):
            continue
        for component in commands:
            if _rectangle_frame(component, drawing['closePath']) or _too_small(component):
                continue
            pending.append({'candidate': matched[0], 'component': component, 'drawing': drawing, 'native': native})
    kept = []
    for item in pending:
        samples, _gate = _samples(item['component'], page['matrix'], crop, dpi, 32, item['drawing']['closePath'])
        located = _locate(samples, page['matrix'], crop, dpi, width, height)
        if located is None:
            rejected.append(_rejection('outside-crop', item['drawing'], [item['component']], page))
            continue
        if not _overlaps(located, plot_bbox):
            continue
        if _grid_or_tick(item['component'], located, plot_bbox, item['candidate'], width, height):
            continue
        kept.append(item)
    dropped = None
    point_budget, series_room = _native_room(kept, original_series)
    while kept and (len(kept) > series_room or point_budget < 2 * len(kept)):
        dropped = kept.pop()
        point_budget, series_room = _native_room(kept, original_series)
    if dropped is not None:
        rejected.append(_rejection('series-cap', dropped['drawing'], [dropped['component']], page))
    budget = min(_series_budget(len(kept)), point_budget // len(kept)) if kept else 0
    for item in kept:
        samples, sampling = _samples(item['component'], page['matrix'], crop, dpi, budget, item['drawing']['closePath'])
        located = _locate(samples, page['matrix'], crop, dpi, width, height)
        if located is None:
            rejected.append(_rejection('outside-crop', item['drawing'], [item['component']], page))
            continue
        accepted.setdefault(item['candidate'].get('id'), []).append({
            'candidate': item['candidate'], 'component': item['component'], 'samples': located,
            'drawing': item['drawing'], 'native': item['native'], 'sampling': sampling,
            'matrix': page['matrix'],
        })
    return accepted, rejected


def _split(items):
    if not items or any(op not in ('l', 'c') for op, _points in items):
        return None
    parts, current = [], []
    for op, points in items:
        if len(points) != (2 if op == 'l' else 4):
            return None
        if current and _dist(_end(current[-1]), points[0]) > 0.05:
            parts.append(current)
            current = []
        current.append((op, points))
    if current:
        parts.append(current)
    return parts or None


def _end(command):
    return command[1][-1]


def _dist(left, right):
    return math.hypot(left[0] - right[0], left[1] - right[1])


def _clip_uncertain(stack, rect):
    if not stack:
        return False
    if rect is None:
        return True
    for clip in stack:
        scissor = clip['scissor']
        if not clip['simpleClip'] or scissor is None:
            return True
        if not (rect[0] >= scissor[0] - 0.25 and rect[1] >= scissor[1] - 0.25
                and rect[2] <= scissor[2] + 0.25 and rect[3] <= scissor[3] + 0.25):
            return True
    return False


def _segment_aligned(op, points):
    if op != 'l':
        return False
    return abs(points[0][0] - points[1][0]) <= 0.75 or abs(points[0][1] - points[1][1]) <= 0.75


def _axis_aligned(component):
    return bool(component) and all(_segment_aligned(op, points) for op, points in component)


def _is_closed(component, close_flag):
    if close_flag:
        return True
    if not component:
        return False
    return _dist(component[0][1][0], _end(component[-1])) <= 0.05


def _unique_coords(values):
    found = []
    for value in values:
        if not any(abs(value - kept) <= 0.75 for kept in found):
            found.append(value)
    return found


def _rectangle_frame(component, close_flag):
    """Axis-aligned closed rectangle, including a plot frame or legend swatch."""
    if not _axis_aligned(component):
        return False
    xs, ys = [], []
    for _op, points in component:
        xs.extend((points[0][0], points[1][0]))
        ys.extend((points[0][1], points[1][1]))
    unique_x, unique_y = _unique_coords(xs), _unique_coords(ys)
    if len(unique_x) != 2 or len(unique_y) != 2:
        return False
    if max(unique_x) - min(unique_x) < 8 or max(unique_y) - min(unique_y) < 8:
        return False
    return _is_closed(component, close_flag) or len(component) >= 4


def _too_small(component):
    points = [points[0] for _op, points in component] + [_end(command) for command in component]
    width = max(point[0] for point in points) - min(point[0] for point in points)
    height = max(point[1] for point in points) - min(point[1] for point in points)
    return max(width, height) < 8


def _raster_shape(candidate):
    points = [point for point in (candidate.get('points') or [])
              if isinstance(point, dict) and _finite(point.get('xPixel')) and _finite(point.get('yPixel'))]
    if len(points) < 2:
        return 'unspecified'
    axis = all(abs(left['xPixel'] - right['xPixel']) <= 1.5 or abs(left['yPixel'] - right['yPixel']) <= 1.5
               for left, right in zip(points, points[1:]))
    if not axis:
        return 'curve'
    ys = [point['yPixel'] for point in points]
    xs = [point['xPixel'] for point in points]
    if max(ys) - min(ys) <= 1.5 or max(xs) - min(xs) <= 1.5:
        return 'flat'
    return 'step'


def _on_line(located, candidate):
    points = [point for point in (candidate.get('points') or [])
              if isinstance(point, dict) and _finite(point.get('xPixel')) and _finite(point.get('yPixel'))]
    if len(points) < 2:
        return False
    xs = [pixel[0] for pixel, _origin, _role, _source in located]
    ys = [pixel[1] for pixel, _origin, _role, _source in located]
    if max(ys) - min(ys) <= 1.5:
        y = sum(ys) / len(ys)
        return all(abs(point['yPixel'] - y) <= 2 for point in points)
    if max(xs) - min(xs) <= 1.5:
        x = sum(xs) / len(xs)
        return all(abs(point['xPixel'] - x) <= 2 for point in points)
    return False


def _grid_or_tick(component, located, plot_bbox, candidate, width, height):
    """Drop boundary ticks, frame edges, and gridlines that are not the raster series."""
    if not _axis_aligned(component):
        return False
    box = plot_bbox or [0, 0, width, height]
    if len(box) != 4 or not all(_finite(value) for value in box):
        return False
    px0, py0, px1, py1 = box
    span_x, span_y = px1 - px0, py1 - py0
    if span_x <= 0 or span_y <= 0:
        return False
    xs = [pixel[0] for pixel, _origin, _role, _source in located]
    ys = [pixel[1] for pixel, _origin, _role, _source in located]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    wide, tall = x1 - x0, y1 - y0
    spans = wide >= 0.75 * span_x or tall >= 0.75 * span_y
    short = max(wide, tall) <= 0.12 * max(span_x, span_y)
    on_boundary = (
        (abs(y0 - py0) <= 2 and abs(y1 - py0) <= 2) or (abs(y0 - py1) <= 2 and abs(y1 - py1) <= 2)
        or (abs(x0 - px0) <= 2 and abs(x1 - px0) <= 2) or (abs(x0 - px1) <= 2 and abs(x1 - px1) <= 2))
    if on_boundary and spans:
        return True
    if len(component) == 1 and short and on_boundary:
        return True
    evidence = _raster_shape(candidate)
    if len(component) == 1 and spans and evidence in ('curve', 'step') and not _on_line(located, candidate):
        return True
    return False


def _rect_outside(rect, matrix, crop):
    if rect is None:
        return False
    corners = ((rect[0], rect[1]), (rect[2], rect[1]), (rect[0], rect[3]), (rect[2], rect[3]))
    mapped = [_map_point(corner, matrix) for corner in corners]
    xs = [point[0] for point in mapped]
    ys = [point[1] for point in mapped]
    return max(xs) < crop[0] - 0.75 or min(xs) > crop[2] + 0.75 or max(ys) < crop[1] - 0.75 or min(ys) > crop[3] + 0.75


def _perp(point, start, end):
    dx, dy = end[0] - start[0], end[1] - start[1]
    span = math.hypot(dx, dy)
    if span == 0:
        return math.hypot(point[0] - start[0], point[1] - start[1])
    return abs(dx * (point[1] - start[1]) - dy * (point[0] - start[0])) / span


def _split_bezier(points):
    p0, p1, p2, p3 = points
    def mid(left, right):
        return ((left[0] + right[0]) / 2, (left[1] + right[1]) / 2)
    p01, p12, p23 = mid(p0, p1), mid(p1, p2), mid(p2, p3)
    p012, p123 = mid(p01, p12), mid(p12, p23)
    center = mid(p012, p123)
    return (p0, p01, p012, center), (center, p123, p23, p3)


def _curve_bound(pixels):
    return 0.75 * max(_perp(pixels[1], pixels[0], pixels[3]), _perp(pixels[2], pixels[0], pixels[3]))


def _flatten_cubic(controls, matrix, clip, dpi, budget):
    """Adaptive de Casteljau until the pixel chord bound is within tolerance or the budget stops."""
    pdf0 = tuple(tuple(point) for point in controls)
    pix0 = tuple(_pixel(_map_point(point, matrix), clip, dpi) for point in pdf0)
    segments = [(pdf0, pix0, _curve_bound(pix0))]
    for _guard in range(64):
        index = max(range(len(segments)), key=lambda item: segments[item][2])
        if segments[index][2] <= _PIXEL_TOLERANCE or len(segments) + 1 >= max(2, budget):
            break
        pdf4, pix4, _bound = segments.pop(index)
        left_pdf, right_pdf = _split_bezier(pdf4)
        left_pix, right_pix = _split_bezier(pix4)
        segments[index:index] = [(left_pdf, left_pix, _curve_bound(left_pix)), (right_pdf, right_pix, _curve_bound(right_pix))]
    points = [(pdf0[0], 'pdf-vector-calibrated', 'source-endpoint')]
    last = len(segments) - 1
    for index, (pdf4, _pix4, _bound) in enumerate(segments):
        end = pdf0[3] if index == last else pdf4[3]
        if index == last:
            origin, role = 'pdf-vector-calibrated', 'source-endpoint'
        else:
            origin, role = 'curve-interpolated', 'curve-sample'
        if _dist(points[-1][0], end) > 1e-6:
            points.append((end, origin, role))
    return points, max(segment[2] for segment in segments)


def _push(out, point, origin, role):
    if out and _dist(out[-1][0], point) <= 1e-6:
        return
    out.append((point, origin, role))


def _samples(component, matrix, clip, dpi, budget, close_flag):
    out = []
    method = 'source-vertices'
    worst = 0.0
    limit = max(2, budget)
    for op, points in component:
        if op == 'l':
            if len(out) + 1 >= limit and len(out) >= 2:
                worst = max(worst, _pixel_span(points[0], points[1], matrix, clip, dpi))
                method = 'source-vertices'
                continue
            _push(out, points[0], 'pdf-vector-calibrated', 'source-endpoint')
            _push(out, points[1], 'pdf-vector-calibrated', 'source-endpoint')
            continue
        method = 'de-casteljau'
        remaining = limit - len(out)
        if remaining < 2:
            pixels = tuple(_pixel(_map_point(point, matrix), clip, dpi) for point in points)
            worst = max(worst, _curve_bound(pixels))
            if out and _dist(out[-1][0], points[-1]) > 1e-6:
                out[-1] = (tuple(points[-1]), 'pdf-vector-calibrated', 'source-endpoint')
            continue
        flat, bound = _flatten_cubic(points, matrix, clip, dpi, remaining)
        worst = max(worst, bound)
        for point, origin, role in flat:
            _push(out, point, origin, role)
    closed = _is_closed(component, close_flag)
    if close_flag and out and _dist(out[-1][0], out[0][0]) > 1e-6:
        if len(out) >= limit:
            worst = max(worst, _pixel_span(out[-1][0], out[0][0], matrix, clip, dpi))
            out[-1] = (out[0][0], 'pdf-vector-calibrated', 'source-endpoint')
        else:
            _push(out, out[0][0], 'pdf-vector-calibrated', 'source-endpoint')
    if len(out) > limit:
        worst = max(worst, _PIXEL_TOLERANCE + 1.0)
        out = out[:limit - 1] + [out[-1]]
    within = worst <= _PIXEL_TOLERANCE + 1e-9
    return out, {'method': method, 'tolerancePixels': _PIXEL_TOLERANCE, 'maxDeviationPixels': worst,
                 'withinTolerance': within, 'closed': closed}


def _pixel_span(start, end, matrix, clip, dpi):
    left = _pixel(_map_point(start, matrix), clip, dpi)
    right = _pixel(_map_point(end, matrix), clip, dpi)
    return math.hypot(left[0] - right[0], left[1] - right[1])


def _map_point(point, matrix):
    a, b, c, d, e, f = matrix
    x, y = point
    return (a * x + c * y + e, b * x + d * y + f)


def _pixel(point, clip, dpi):
    zoom = dpi / 72
    return (point[0] * zoom - math.floor(clip[0] * zoom), point[1] * zoom - math.floor(clip[1] * zoom))


def _locate(samples, matrix, clip, dpi, width, height):
    located = []
    for point, origin, role in samples:
        pixel = _pixel(_map_point(point, matrix), clip, dpi)
        if pixel[0] < -0.75 or pixel[1] < -0.75 or pixel[0] > width + 0.75 or pixel[1] > height + 0.75:
            return None
        located.append((pixel, origin, role, point))
    return located or None


def _overlaps(located, plot_bbox):
    if not plot_bbox:
        return True
    xs = [pixel[0] for pixel, _origin, _role, _source in located]
    ys = [pixel[1] for pixel, _origin, _role, _source in located]
    pad = 2
    return not (max(xs) < plot_bbox[0] - pad or min(xs) > plot_bbox[2] + pad
                or max(ys) < plot_bbox[1] - pad or min(ys) > plot_bbox[3] + pad)


def _style(drawing, native, closed=None):
    flag = drawing['closePath'] if closed is None else closed
    return {'color': [channel for channel in drawing['color']], 'width': _jsonish(drawing['width']),
            'dashes': _jsonish(drawing['dashes']), 'lineCap': _jsonish(drawing['lineCap']),
            'lineJoin': _jsonish(drawing['lineJoin']), 'closePath': bool(flag),
            'opacity': _jsonish(drawing['opacity']), 'effectiveColor': '#%02x%02x%02x' % native}


def _commands(component):
    return [{'op': op, 'points': [list(point) for point in points]} for op, points in component]


def _rejection(reason, drawing, components, page):
    native = _rgb(drawing['color']) or (0, 0, 0)
    return {'reason': reason, 'commands': [command for component in components for command in _commands(component)],
            'style': _style(drawing, native)}


def _jsonish(value):
    if value is None or type(value) in (str, int, float, bool):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonish(item) for item in value]
    return str(value)


def _fresh(base, used):
    ident = base
    number = 2
    while ident in used:
        ident = '%s-%d' % (base, number)
        number += 1
    used.add(ident)
    return ident


def _data_points(hit, converters):
    binding = hit['candidate']['axisBinding']
    convert = converters[binding]
    requested, effective = _requested_color(hit['candidate']), hit['style']['effectiveColor']
    points = []
    for pixel, origin, role, source in hit['samples']:
        y_value = convert['y'](pixel[1])
        points.append({'xPixel': pixel[0], 'yPixel': pixel[1], 'x': convert['x'](pixel[0]), 'y': y_value,
                       'valueCandidates': {binding: y_value},
                       'pixelInterval': sorted((convert['y'](pixel[1] - 0.5), convert['y'](pixel[1] + 0.5))),
                       'origin': origin, 'role': role, 'requestedColor': requested, 'effectiveColor': effective,
                       'sourcePoint': list(_map_point(source, hit['matrix'])), 'sourcePointSpace': 'page-rect',
                       'sourcePagePoint': [source[0], source[1]]})
    return points


def _materialize(candidate, hits, converters, used, meta):
    built = []
    for hit in hits:
        style = _style(hit['drawing'], hit['native'], hit['sampling']['closed'])
        hit['style'] = style
        try:
            points = _data_points(hit, converters)
        except (ValueError, OverflowError):
            continue
        if len(points) < 2:
            continue
        base = candidate.get('id') or 'series'
        sampling = dict(hit['sampling'])
        sampling.update(sourceCommands=len(hit['component']), returnedPoints=len(points),
                        curveSamples=sum(point['origin'] == 'curve-interpolated' for point in points))
        built.append({'id': _fresh(base, used),
                      'name': candidate.get('name'), 'color': style['effectiveColor'],
                      'requestedColor': _requested_color(candidate), 'effectiveColor': style['effectiveColor'],
                      'axisBinding': candidate['axisBinding'], 'points': points, 'gapsPixels': [], 'segments': [],
                      'traceAmbiguous': False, 'pointKind': 'source-vector', 'sampling': sampling,
                      'sourceStroke': {'pageIndex': meta['pageIndex'], 'sourceSha256': meta['sha256'],
                                       'crop': list(meta['crop']), 'dpi': meta['dpi'], 'rotation': meta['rotation'],
                                       'space': 'unrotated-page-points', 'commands': _commands(hit['component']),
                                       'style': {key: value for key, value in style.items() if key != 'effectiveColor'}}})
    return built


def _fit_output(rebuilt):
    """Keep the final mixed series inside 64 series and 480 points. Raster points yield first."""
    changed = False
    while len(rebuilt) > _MAX_SERIES:
        rebuilt.pop()
        changed = True
    overflow = sum(len(series.get('points') or []) for series in rebuilt) - _POINT_BUDGET
    if overflow <= 0:
        return changed
    for series in reversed(list(rebuilt)):
        if series.get('pointKind') == 'source-vector':
            continue
        points = list(series.get('points') or [])
        if not points:
            continue
        if len(points) <= overflow:
            overflow -= len(points)
            series['points'] = []
        else:
            series['points'] = points[:len(points) - overflow]
            overflow = 0
        changed = True
        if overflow <= 0:
            break
    if overflow > 0:
        for series in reversed(list(rebuilt)):
            if series.get('pointKind') != 'source-vector':
                continue
            points = list(series.get('points') or [])
            extra = len(points) - 2
            if extra <= 0:
                continue
            drop = min(overflow, extra)
            series['points'] = points[:len(points) - drop - 1] + [points[-1]]
            sampling = series.get('sampling')
            if isinstance(sampling, dict):
                sampling['withinTolerance'] = False
                sampling['returnedPoints'] = len(series['points'])
            overflow -= drop
            changed = True
            if overflow <= 0:
                break
    rebuilt[:] = [series for series in rebuilt if len(series.get('points') or []) >= 1]
    return changed


def _apply(working, accepted, rejected, converters, calibration, meta):
    geometry = working.get('geometry') if isinstance(working.get('geometry'), dict) else None
    if geometry is None:
        geometry = {'schema': 'falsify.chart-geometry.v1', 'issues': [], 'axes': {}, 'series': []}
        working['geometry'] = geometry
    original = list(geometry.get('series') or [])
    used, rebuilt, native, seen = {series.get('id') for series in original}, [], False, set()
    for series in original:
        hits = accepted.get(series.get('id'), [])
        seen.add(series.get('id'))
        if hits:
            used.discard(series.get('id'))
        if not hits:
            rebuilt.append(series)
            used.add(series.get('id'))
            continue
        materialized = _materialize(series, hits, converters, used, meta)
        if not materialized:
            rebuilt.append(series)
            used.add(series.get('id'))
            continue
        native = True
        rebuilt.extend(materialized)
    for ident, hits in accepted.items():
        if ident in seen or not hits:
            continue
        materialized = _materialize(hits[0]['candidate'], hits, converters, used, meta)
        if materialized:
            native = True
            rebuilt.extend(materialized)
    if native:
        if 'x' not in (geometry.get('axes') or {}) and 'left' in converters:
            geometry['axes'] = {'x': converters['left']['xAxis'], 'left': converters['left']['yAxis']}
            geometry['calibrationSource'] = geometry.get('calibrationSource') or 'caller-selected'
        geometry['series'] = rebuilt
        geometry['vectorSource'] = {'sha256': meta['sha256'], 'pageIndex': meta['pageIndex'], 'crop': list(meta['crop']),
                                     'dpi': meta['dpi'], 'rotation': meta['rotation'], 'space': 'page-rect'}
        extra = []
        if _fit_output(rebuilt):
            extra.append('sampling-point-limit')
        if any(item.get('pointKind') == 'source-vector' and item.get('sampling', {}).get('withinTolerance') is False for item in rebuilt):
            extra.append('sampling-point-limit')
        if any(item.get('reason') == 'drawing-budget' for item in rejected):
            extra.append('vector-drawing-budget')
        if any(item.get('reason') == 'series-cap' for item in rejected):
            extra.append('vector-series-cap')
        geometry['issues'] = [issue for issue in geometry.get('issues') or [] if issue not in _STALE_ISSUES]
        for code in extra:
            if code not in geometry['issues']:
                geometry['issues'].append(code)
        geometry['status'] = 'partial' if geometry['issues'] else 'ready'
        if rebuilt and all(series.get('pointKind') == 'source-vector' for series in rebuilt):
            geometry['pointKind'] = 'source-vector'
        if rejected:
            geometry['rejectedVectors'] = rejected
        columns, rows, numeric = rows_from_geometry(geometry)
        provenance = dict(working.get('provenance') or {})
        provenance['vector'] = 'pdf-native-path'
        provenance['vectorReader'] = 'pymupdf-get-drawings-extended'
        chart_issues = [issue for issue in working.get('issues') or [] if issue not in _STALE_ISSUES]
        for code in extra:
            if code not in chart_issues:
                chart_issues.append(code)
        working.update(columns=columns, rows=rows, numericCells=numeric, provenance=provenance, issues=chart_issues)
        working['status'] = 'partial' if working['issues'] else 'ready'
        if geometry.get('pointKind') == 'source-vector':
            working['pointKind'] = 'source-vector'
        _set_chart_axes(working, geometry)
        if working.get('chartType') in (None, 'unknown'):
            working['chartType'] = 'xy'
        return
    if rejected:
        target = geometry if isinstance(working.get('geometry'), dict) else working
        target['rejectedVectors'] = rejected


def _set_chart_axes(working, geometry):
    axes = geometry.get('axes') or {}
    if 'x' not in axes or 'scale' not in axes['x']:
        return
    y_axes = [side for side in ('left', 'right') if isinstance(axes.get(side), dict) and 'scale' in axes[side]]
    if not y_axes:
        return
    old = working.get('axes') if isinstance(working.get('axes'), dict) else {}
    def pack(side, scale):
        prev = old.get(side) if isinstance(old.get(side), dict) else {}
        return {'label': prev.get('label'), 'scale': scale, 'unit': prev.get('unit')}
    working['axes'] = {'x': pack('x', axes['x']['scale']),
                       'y': pack('y', axes[y_axes[0]]['scale'] if len(y_axes) == 1 else 'multiple')}

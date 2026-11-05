"""Source-style bar and scatter marks for falsify.chart-scene.v1.

prepare_marks(source, page_index, bbox, options=None) -> scene or []
export_marks(source, scene, edited) -> (pdf_bytes, report)

The scene uses schema falsify.chart-scene.v1 and mode "marks". Each series has
kind "bar" or "scatter", plus baseline, radius and orientation. Points are crop
pixels, top-left origin, y downward. A bar point is the value end: dragging it
changes only that end. Baseline, width and the other axis stay at the source
operands. A scatter point is the marker center; both axes move and the radius
stays. sourceBinding is private and addresses a top-level content occurrence by
source hash plus token indexes. MuPDF seqno is not read or written.

prepare_marks returns [] when the crop has no unambiguous filled bar or circle.
Curve-only pages, form XObjects, images and stroke axes stay on the existing
curve and image routes. No-op export returns the original PDF bytes. An edit
rewrites only the changed numeric operands and does not paint a white eraser.

Limits: top-level content only; one filled rectangle or one kappa circle per
path; axis-aligned in the displayed page; vertical or horizontal baseline;
near-white and page-sized fills skipped; shared or complex paths not claimed.
"""
import hashlib
import io
import math

import paper_chart_paint as paint

SCHEMA = 'falsify.chart-scene.v1'
REPORT_SCHEMA = 'falsify.chart-marks-report.v1'
_LIMITS = (
    'top-level-filled-rect-and-circle',
    'axis-aligned-display-rect',
    'vertical-or-horizontal-baseline',
    'similar-marker-radius',
    'no-white-erase',
    'seqno-not-operator-index',
    'source-hash-and-token-occurrence',
    'form-xobject-not-claimed',
    'curve-and-image-routes-unchanged',
    'near-white-fill-skipped',
    'bar-width-and-baseline-fixed',
    'scatter-radius-fixed',
)
_KAPPA = 0.5522847498307936
_FILL = {'f', 'F', 'f*'}
_FILL_STROKE = {'b', 'B', 'b*', 'B*'}
_PAINT = _FILL | _FILL_STROKE
_STROKE = {'S', 's'}
_END = _PAINT | _STROKE | {'n', 'W', 'W*'}
_EDGE = 0.8
_AXIS_HIT = 1.2
_MIN_EDGE = 2.0
_MAX_RADIUS = 36.0


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
        return [0.0, 0.0, float(width), float(height)]
    box = options.get('plotBbox')
    if not isinstance(box, (list, tuple)) or len(box) != 4 or not all(_finite(value) for value in box):
        raise ValueError('bad-plot')
    plot = [float(value) for value in box]
    if not (plot[0] < plot[2] and plot[1] < plot[3]):
        raise ValueError('bad-plot')
    return plot


def _png_size(png):
    if len(png) < 24 or png[12:16] != b'IHDR':
        raise ValueError('bad-png')
    import struct
    return struct.unpack('>II', png[16:24])


def _display_matrix(page):
    matrix = page.transformation_matrix
    page_tm = (float(matrix.a), float(matrix.b), float(matrix.c), float(matrix.d), float(matrix.e), float(matrix.f))
    if int(page.rotation or 0) % 360 == 0:
        return page_tm
    rot = page.rotation_matrix
    rot_tm = (float(rot.a), float(rot.b), float(rot.c), float(rot.d), float(rot.e), float(rot.f))
    return paint._mul(page_tm, rot_tm)


def _gstate():
    return {'ctm': (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), 'fill': (0.0, 0.0, 0.0), 'known': True, 'opacity': 1.0}


def _copy_state(state):
    return {'ctm': state['ctm'], 'fill': state['fill'], 'known': state['known'], 'opacity': state['opacity']}


def _rgb_of(fill):
    return tuple(max(0.0, min(1.0, float(channel))) for channel in fill)


def _near_white(fill):
    return min(fill) >= 0.97


def _cmyk(operands):
    nums = paint._nums(operands, 4)
    if not nums:
        return None
    c, m, y, k = (item[2] for item in nums)
    return (1.0 - min(1.0, c + k), 1.0 - min(1.0, m + k), 1.0 - min(1.0, y + k))


def _intersects(box, other, pad=0.5):
    return not (box[2] < other[0] - pad or box[0] > other[2] + pad or box[3] < other[1] - pad or box[1] > other[3] + pad)


def _axis_aligned(points):
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    for point in points:
        if min(abs(point[0] - x0), abs(point[0] - x1)) > _EDGE:
            return None
        if min(abs(point[1] - y0), abs(point[1] - y1)) > _EDGE:
            return None
    if (x1 - x0) < _MIN_EDGE or (y1 - y0) < _MIN_EDGE:
        return None
    return x0, y0, x1, y1


def _new_sub(state):
    return {'ops': [], 'ctm': state['ctm'], 'complex': False}


def _mark_graphics(word, operands, state, note_ctm):
    if word == 'cm':
        nums = paint._nums(operands, 6)
        if nums:
            state['ctm'] = paint._mul(tuple(item[2] for item in nums), state['ctm'])
            note_ctm()
    elif word == 'rg':
        nums = paint._nums(operands, 3)
        if nums:
            state['fill'] = tuple(item[2] for item in nums)
            state['known'] = True
    elif word == 'g':
        nums = paint._nums(operands, 1)
        if nums:
            state['fill'] = (nums[0][2], nums[0][2], nums[0][2])
            state['known'] = True
    elif word == 'k':
        fill = _cmyk(operands)
        if fill:
            state['fill'] = fill
            state['known'] = True
    elif word == 'ca':
        nums = paint._nums(operands, 1)
        if nums:
            state['opacity'] = nums[0][2]
    elif word in ('scn', 'SCN', 'sc', 'SC'):
        state['known'] = False


def _parse_stream(pk, tokens, display_tm, content_index):
    state, stack = _gstate(), []
    current, subs = None, []
    marks, strokes = [], []

    def close_sub():
        nonlocal current
        if current and current['ops']:
            subs.append(current)
        current = None

    def ensure():
        nonlocal current
        if current is None:
            current = _new_sub(state)

    def note_ctm():
        if current is not None and any(abs(left - right) > 1e-6 for left, right in zip(current['ctm'], state['ctm'])):
            current['complex'] = True

    def cubic_command(operands, op_index):
        if current is not None:
            nums = paint._nums(operands, 6)
            if nums:
                note_ctm()
                current['ops'].append(('c', [(item[2], item[1]) for item in nums], op_index))

    def rectangle_command(operands, op_index):
        nums = paint._nums(operands, 4)
        close_sub()
        if nums:
            ensure()
            current['ops'].append(('re', [item[2] for item in nums], [item[1] for item in nums], op_index))
            close_sub()

    def path_command(word, operands, op_index):
        nonlocal current
        if word == 'm':
            nums = paint._nums(operands, 2)
            close_sub()
            if nums:
                ensure()
                current['ops'].append(('m', nums[0][2], nums[1][2], nums[0][1], nums[1][1], op_index))
        elif word == 'l' and current is not None:
            nums = paint._nums(operands, 2)
            if nums:
                note_ctm()
                current['ops'].append(('l', nums[0][2], nums[1][2], nums[0][1], nums[1][1], op_index))
        elif word == 'c':
            cubic_command(operands, op_index)
        elif word == 're':
            rectangle_command(operands, op_index)
        elif word == 'h':
            target = current if current and current['ops'] else (subs[-1] if subs else None)
            if target is not None:
                target['ops'].append(('h', op_index))
        elif word in ('v', 'y'):
            ensure()
            current['complex'] = True

    for word, operands, op_index in paint._commands(pk, tokens):
        if word == 'q':
            close_sub()
            stack.append(_copy_state(state))
            subs = []
        elif word == 'Q' and stack:
            close_sub()
            state = stack.pop()
            subs = []
        elif word in ('cm', 'rg', 'g', 'k', 'ca', 'scn', 'SCN', 'sc', 'SC'):
            _mark_graphics(word, operands, state, note_ctm)
        elif word in ('m', 'l', 'c', 're', 'h', 'v', 'y'):
            path_command(word, operands, op_index)
        elif word in _END:
            close_sub()
            if word in _PAINT:
                _consider(subs, state, display_tm, content_index, op_index, marks)
            elif word in _STROKE:
                _consider_stroke(subs, display_tm, strokes)
            subs = []
        elif current and current['ops']:
            current['complex'] = True
    return marks, strokes


def _full(ctm, display_tm):
    return paint._mul(ctm, display_tm)


def _map(matrix, point):
    return paint._apply(matrix, point[0], point[1])


def _drop_indexes(sub, paint_index):
    drops = {paint_index}
    for op in sub['ops']:
        kind = op[0]
        if kind == 'm' or kind == 'l':
            drops.update((op[3], op[4], op[5]))
        elif kind == 'c':
            drops.update(index for _, index in op[1])
            drops.add(op[2])
        elif kind == 're':
            drops.update(op[2])
            drops.add(op[3])
        elif kind == 'h':
            drops.add(op[1])
    return drops


def _rect_from_re(op, matrix):
    x, y, w, h = op[1]
    corners = [((x, y), 'c00'), ((x + w, y), 'c10'), ((x, y + h), 'c01'), ((x + w, y + h), 'c11')]
    display = []
    stored = []
    for user, name in corners:
        shown = _map(matrix, user)
        display.append(shown)
        stored.append({'name': name, 'user': [user[0], user[1]], 'display': [shown[0], shown[1]]})
    box = _axis_aligned(display)
    if box is None:
        return None
    return {
        'mode': 're',
        'box': box,
        'corners': stored,
        're': {'x': x, 'y': y, 'w': w, 'h': h, 'indexes': list(op[2]), 'op': op[3]},
        'matrix': list(matrix),
    }


def _rect_from_path(ops, matrix):
    body = [op for op in ops if op[0] != 'h']
    if len(body) != 4 or body[0][0] != 'm' or any(op[0] != 'l' for op in body[1:]):
        return None
    names = ('c00', 'c10', 'c11', 'c01')
    stored, display = [], []
    for op, name in zip(body, names):
        user = (op[1], op[2])
        shown = _map(matrix, user)
        display.append(shown)
        stored.append({
            'name': name,
            'user': [user[0], user[1]],
            'display': [shown[0], shown[1]],
            'ix': op[3],
            'iy': op[4],
        })
    box = _axis_aligned(display)
    if box is None:
        return None
    return {'mode': 'path', 'box': box, 'corners': stored, 'matrix': list(matrix)}


def _valid_circle_controls(controls, ring, cx, cy, radius):
    for index, (c1, c2, end) in enumerate(controls):
        expected = _kappa_controls(ring[index], end, (cx, cy), radius)
        if expected is None:
            return False
        limit = max(0.6, radius * 0.08)
        if paint._dist(c1, expected[0]) > limit or paint._dist(c2, expected[1]) > limit:
            return False
    return True


def _circle_parts(body):
    start = (body[0][1], body[0][2])
    curves = body[1:]
    ends = [start]
    controls = []
    for op in curves:
        nums = op[1]
        if len(nums) != 6:
            return None
        c1 = (nums[0][0], nums[1][0])
        c2 = (nums[2][0], nums[3][0])
        end = (nums[4][0], nums[5][0])
        controls.append((c1, c2, end))
        ends.append(end)
    return start, curves, ends, controls


def _circle_display(ring, matrix):
    shown = [_map(matrix, point) for point in ring]
    sxs = [point[0] for point in shown]
    sys = [point[1] for point in shown]
    rx = (max(sxs) - min(sxs)) / 2.0
    ry = (max(sys) - min(sys)) / 2.0
    if abs(rx - ry) > max(0.6, ((rx + ry) / 2.0) * 0.08):
        return None
    return sxs, sys, rx, ry


def _circle_geometry(ends):
    ring = ends[:4]
    cx = sum(point[0] for point in ring) / 4.0
    cy = sum(point[1] for point in ring) / 4.0
    radii = [paint._dist(point, (cx, cy)) for point in ring]
    radius = sum(radii) / 4.0
    if not (_MIN_EDGE / 2.0 <= radius <= _MAX_RADIUS):
        return None
    if max(abs(item - radius) for item in radii) > max(0.6, radius * 0.08):
        return None
    return ring, cx, cy, radius


def _circle_from_path(ops, matrix):
    body = [op for op in ops if op[0] != 'h']
    if len(body) != 5 or body[0][0] != 'm' or any(op[0] != 'c' for op in body[1:]):
        return None
    parts = _circle_parts(body)
    if parts is None: return None
    start, curves, ends, controls = parts
    if paint._dist(ends[-1], start) > _EDGE:
        return None
    geometry = _circle_geometry(ends)
    if geometry is None: return None
    ring, cx, cy, radius = geometry
    if not _valid_circle_controls(controls, ring, cx, cy, radius):
        return None
    display = _circle_display(ring, matrix)
    if display is None: return None
    sxs, sys, rx, ry = display
    center = _map(matrix, (cx, cy))
    # Rebuild operand axes from the actual number order, not from a parity guess.
    operands = [('x', body[0][3], body[0][1]), ('y', body[0][4], body[0][2])]
    for op in curves:
        for offset, (value, index) in enumerate(op[1]):
            operands.append(('x' if offset % 2 == 0 else 'y', index, value))
    return {
        'mode': 'circle',
        'center_user': [cx, cy],
        'center_display': [center[0], center[1]],
        'radius_user': radius,
        'radius_display': (rx + ry) / 2.0,
        'box': (min(sxs), min(sys), max(sxs), max(sys)),
        'operands': [{'axis': axis, 'index': index, 'value': value} for axis, index, value in operands],
        'matrix': list(matrix),
    }


def _kappa_controls(start, end, center, radius):
    ax, ay = start[0] - center[0], start[1] - center[1]
    ex, ey = end[0] - center[0], end[1] - center[1]
    cross = ax * ey - ay * ex
    if abs(cross) < radius * radius * 0.35:
        return None
    if cross > 0:
        tax, tay = -ay, ax
        tex, tey = -ey, ex
    else:
        tax, tay = ay, -ax
        tex, tey = ey, -ex
    b1 = (start[0] + _KAPPA * tax, start[1] + _KAPPA * tay)
    b2 = (end[0] - _KAPPA * tex, end[1] - _KAPPA * tey)
    return b1, b2


def _consider(subs, state, display_tm, content_index, paint_index, marks):
    if len(subs) != 1 or not state['known']:
        return
    if state['opacity'] is not None and state['opacity'] <= 0.01:
        return
    sub = subs[0]
    if sub['complex']:
        return
    fill = _rgb_of(state['fill'])
    if _near_white(fill):
        return
    matrix = _full(sub['ctm'], display_tm)
    ops = sub['ops']
    shaped = None
    if len(ops) >= 1 and ops[0][0] == 're' and all(op[0] in ('re', 'h') for op in ops):
        shaped = _rect_from_re(ops[0], matrix)
        kind = 'bar'
    else:
        shaped = _rect_from_path(ops, matrix)
        kind = 'bar' if shaped else None
        if shaped is None:
            shaped = _circle_from_path(ops, matrix)
            kind = 'scatter' if shaped else None
    if not shaped:
        return
    shaped.update({
        'kind': kind,
        'fill': fill,
        'color': paint._hex(fill),
        'opacity': float(state['opacity']),
        'content': content_index,
        'paint': paint_index,
        'drops': sorted(_drop_indexes(sub, paint_index)),
    })
    marks.append(shaped)


def _consider_stroke(subs, display_tm, strokes):
    if len(subs) != 1 or subs[0]['complex']:
        return
    ops = [op for op in subs[0]['ops'] if op[0] != 'h']
    if len(ops) < 2 or ops[0][0] != 'm':
        return
    matrix = _full(subs[0]['ctm'], display_tm)
    start = _map(matrix, (ops[0][1], ops[0][2]))
    for op in ops[1:]:
        if op[0] != 'l':
            return
        end = _map(matrix, (op[1], op[2]))
        if abs(start[1] - end[1]) <= _EDGE and abs(start[0] - end[0]) >= 12:
            y = (start[1] + end[1]) / 2.0
            strokes.append({'orient': 'h', 'y': y, 'x0': min(start[0], end[0]), 'x1': max(start[0], end[0]),
                            'length': abs(end[0] - start[0])})
        elif abs(start[0] - end[0]) <= _EDGE and abs(start[1] - end[1]) >= 12:
            x = (start[0] + end[0]) / 2.0
            strokes.append({'orient': 'v', 'x': x, 'y0': min(start[1], end[1]), 'y1': max(start[1], end[1]),
                            'length': abs(end[1] - start[1])})
        start = end


def _clusters(pairs):
    ordered = sorted(pairs, key=lambda item: item[0])
    groups = []
    for coord, index in ordered:
        if groups and abs(coord - groups[-1]['coord']) <= _EDGE:
            groups[-1]['values'].append(coord)
            groups[-1]['members'].add(index)
            groups[-1]['coord'] = sum(groups[-1]['values']) / len(groups[-1]['values'])
        else:
            groups.append({'coord': coord, 'values': [coord], 'members': {index}})
    for group in groups:
        group['count'] = len(group['members'])
    return groups


def _edge_group(groups, rect_index, coord):
    for group in groups:
        if rect_index in group['members'] and abs(group['coord'] - coord) <= _EDGE + 0.2:
            return group
    return None


def _edge_candidates(axis, edges, groups, index, strokes, direction, start, end):
    candidates = []
    first, last = edges
    for edge in edges:
        group = _edge_group(groups, index, edge)
        shared = bool(group and group['count'] >= 2)
        near = _near_axis(strokes, direction, edge, start, end)
        other = last if abs(edge - first) <= _EDGE else first
        if (shared or near) and abs(other - edge) > _AXIS_HIT + _EDGE:
            candidates.append((axis, edge, (2 if shared else 0) + (1 if near else 0)))
    return candidates


def _baseline_candidates(index, rect, horizontal, vertical, strokes):
    x0, y0, x1, y1 = rect['box']
    candidates = []
    candidates.extend(_edge_candidates('y', (y0,y1), horizontal, index, strokes, 'h', x0, x1))
    candidates.extend(_edge_candidates('x', (x0,x1), vertical, index, strokes, 'v', y0, y1))
    if not candidates:
        candidates.append(('y', y1, 0))
    return candidates


def _baseline_geometry(axis, baseline, rect):
    x0, y0, x1, y1 = rect['box']
    if axis == 'y':
        value = y0 if abs(y0 - baseline) > abs(y1 - baseline) else y1
        center, width = (x0 + x1) / 2.0, x1 - x0
    else:
        value = x0 if abs(x0 - baseline) > abs(x1 - baseline) else x1
        center, width = (y0 + y1) / 2.0, y1 - y0
    return value, center, width


def _assign_baselines(rects, strokes):
    horizontal = _clusters([(rect['box'][1], index) for index, rect in enumerate(rects)]
                           + [(rect['box'][3], index) for index, rect in enumerate(rects)])
    vertical = _clusters([(rect['box'][0], index) for index, rect in enumerate(rects)]
                         + [(rect['box'][2], index) for index, rect in enumerate(rects)])
    kept = []
    for index, rect in enumerate(rects):
        x0, y0, x1, y1 = rect['box']
        candidates = _baseline_candidates(index, rect, horizontal, vertical, strokes)
        best = max(item[2] for item in candidates)
        tied = [item for item in candidates if item[2] == best]
        axes = {item[0] for item in tied}
        coords = {round(item[1], 2) for item in tied}
        if len(axes) > 1 or len(coords) > 1:
            continue
        axis, baseline, _score = tied[0]
        value, center, width = _baseline_geometry(axis, baseline, rect)
        if abs(value - baseline) < _MIN_EDGE:
            continue
        rect['axis'] = axis
        rect['baseline'] = baseline
        rect['value'] = value
        rect['center'] = center
        rect['width'] = width
        rect['orientation'] = 'vertical' if axis == 'y' else 'horizontal'
        kept.append(rect)
    return kept


def _near_axis(strokes, orient, coord, start, end):
    for stroke in strokes:
        if stroke['orient'] != orient:
            continue
        if orient == 'h':
            if abs(stroke['y'] - coord) > _AXIS_HIT:
                continue
            if stroke['x1'] < start - 1 or stroke['x0'] > end + 1:
                continue
            overlap = min(stroke['x1'], end) - max(stroke['x0'], start)
            if overlap >= min(8.0, (end - start) * 0.5):
                return True
        else:
            if abs(stroke['x'] - coord) > _AXIS_HIT:
                continue
            if stroke['y1'] < start - 1 or stroke['y0'] > end + 1:
                continue
            overlap = min(stroke['y1'], end) - max(stroke['y0'], start)
            if overlap >= min(8.0, (end - start) * 0.5):
                return True
    return False


def _load(raw, page_index, bbox):
    pk, mu = paint._deps()
    doc = mu.open(stream=raw, filetype='pdf')
    try:
        if page_index >= doc.page_count:
            raise ValueError('bad-page')
        display_tm = _display_matrix(doc[page_index])
    finally:
        doc.close()
    pdf = pk.open(io.BytesIO(raw))
    try:
        page = pdf.pages[page_index]
        streams = []
        marks, strokes = [], []
        for content_index, stream in enumerate(paint._contents(pk, page)):
            data = stream.read_bytes()
            tokens = paint._tokens(pk, data)
            streams.append(tokens)
            found, lines = _parse_stream(pk, tokens, display_tm, content_index)
            marks.extend(found)
            strokes.extend(lines)
    finally:
        pdf.close()
    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    rects = []
    circles = []
    for mark in marks:
        if not _intersects(mark['box'], bbox):
            continue
        box_area = (mark['box'][2] - mark['box'][0]) * (mark['box'][3] - mark['box'][1])
        if mark['kind'] == 'bar' and area > 0 and box_area > area * 0.85:
            continue
        if mark['kind'] == 'bar':
            rects.append(mark)
        else:
            circles.append(mark)
    return streams, _assign_baselines(rects, strokes), circles


def _crop_point(point, bbox, dpi):
    return paint._view_to_crop(point, bbox, dpi)


def _crop_span(p0, p1, bbox, dpi, axis):
    a = _crop_point(p0, bbox, dpi)
    b = _crop_point(p1, bbox, dpi)
    return abs(a[0] - b[0]) if axis == 'x' else abs(a[1] - b[1])


def _bar_point(mark, bbox, dpi):
    x0, y0, x1, y1 = mark['box']
    if mark['axis'] == 'y':
        center = _crop_point((mark['center'], mark['value']), bbox, dpi)
        baseline = _crop_point((mark['center'], mark['baseline']), bbox, dpi)[1]
        width = _crop_span((x0, mark['value']), (x1, mark['value']), bbox, dpi, 'x')
        return {
            'x': center[0], 'y': center[1], 'baseline': baseline, 'width': width,
            'axis': 'y', 'role': 'bar-top', 'origin': 'pdf-vector',
        }
    center = _crop_point((mark['value'], mark['center']), bbox, dpi)
    baseline = _crop_point((mark['baseline'], mark['center']), bbox, dpi)[0]
    width = _crop_span((mark['value'], y0), (mark['value'], y1), bbox, dpi, 'y')
    return {
        'x': center[0], 'y': center[1], 'baseline': baseline, 'width': width,
        'axis': 'x', 'role': 'bar-top', 'origin': 'pdf-vector',
    }


def _scatter_point(mark, bbox, dpi):
    center = _crop_point(tuple(mark['center_display']), bbox, dpi)
    radius = _crop_span(
        (mark['center_display'][0] - mark['radius_display'], mark['center_display'][1]),
        (mark['center_display'][0] + mark['radius_display'], mark['center_display'][1]),
        bbox, dpi, 'x',
    ) / 2.0
    return {
        'x': center[0], 'y': center[1], 'radius': radius,
        'role': 'scatter-point', 'origin': 'pdf-vector',
    }


def _mark_binding(mark):
    binding = {
        'content': mark['content'],
        'paint': mark['paint'],
        'mode': mark['mode'],
        'matrix': [float(value) for value in mark['matrix']],
        'drops': list(mark['drops']),
        'color': mark['color'],
    }
    if mark['kind'] == 'bar':
        binding.update({
            'axis': mark['axis'],
            'baseline': mark['baseline'],
            'value': mark['value'],
            'center': mark['center'],
            'width': mark['width'],
            'corners': mark['corners'],
        })
        if mark['mode'] == 're':
            binding['re'] = mark['re']
    else:
        binding.update({
            'centerUser': mark['center_user'],
            'centerDisplay': mark['center_display'],
            'radiusUser': mark['radius_user'],
            'operands': mark['operands'],
        })
    return binding


def _fingerprint(kind, color, bindings):
    payload = repr((kind, color, bindings)).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()


def _group_key(mark):
    if mark['kind'] == 'bar':
        return ('bar', mark['color'], mark['orientation'], round(mark['baseline'], 2), round(mark['width'], 2),
                round(mark['opacity'], 3))
    return ('scatter', mark['color'], round(mark['radius_display'], 1), round(mark['opacity'], 3))


def _series_from(marks, bbox, dpi, number):
    kind = marks[0]['kind']
    bindings = [_mark_binding(mark) for mark in marks]
    if kind == 'bar':
        points = [_bar_point(mark, bbox, dpi) for mark in marks]
        orientation = marks[0]['orientation']
        baseline = points[0]['baseline']
        radius = None
        width = points[0]['width']
    else:
        points = [_scatter_point(mark, bbox, dpi) for mark in marks]
        orientation = None
        baseline = None
        radius = points[0]['radius']
        width = None
    color = marks[0]['color']
    return {
        'id': 'series-%d' % number,
        'name': None,
        'kind': kind,
        'color': color,
        'baseline': baseline,
        'radius': radius,
        'orientation': orientation,
        'style': {
            'fill': color,
            'opacity': marks[0]['opacity'],
            'width': width,
            'radius': radius,
            'baseline': baseline,
            'orientation': orientation,
        },
        'points': points,
        'sourceBinding': {
            'kind': 'native-bar' if kind == 'bar' else 'native-scatter',
            'space': 'crop-pixels',
            'fingerprint': _fingerprint(kind, color, bindings),
            'marks': bindings,
        },
    }


def _in_plot(point, plot, kind):
    if kind == 'bar':
        if point['axis'] == 'y':
            box = [point['x'] - point['width'] / 2.0, min(point['y'], point['baseline']),
                   point['x'] + point['width'] / 2.0, max(point['y'], point['baseline'])]
        else:
            box = [min(point['x'], point['baseline']), point['y'] - point['width'] / 2.0,
                   max(point['x'], point['baseline']), point['y'] + point['width'] / 2.0]
    else:
        radius = point['radius']
        box = [point['x'] - radius, point['y'] - radius, point['x'] + radius, point['y'] + radius]
    return _intersects(box, plot, 0.5)


def _build_series(rects, circles, bbox, dpi, plot):
    grouped = {}
    order = []
    for mark in sorted(rects + circles, key=lambda item: (item['content'], item['paint'])):
        key = _group_key(mark)
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append(mark)
    series = []
    for key in order:
        built = _series_from(grouped[key], bbox, dpi, len(series) + 1)
        kept_points = []
        kept_marks = []
        for point, binding in zip(built['points'], built['sourceBinding']['marks']):
            if _in_plot(point, plot, built['kind']):
                kept_points.append(point)
                kept_marks.append(binding)
        if not kept_points:
            continue
        built['points'] = kept_points
        built['sourceBinding']['marks'] = kept_marks
        built['sourceBinding']['fingerprint'] = _fingerprint(built['kind'], built['color'], kept_marks)
        if built['kind'] == 'bar':
            built['baseline'] = kept_points[0]['baseline']
            built['style']['baseline'] = built['baseline']
            built['style']['width'] = kept_points[0]['width']
        else:
            built['radius'] = kept_points[0]['radius']
            built['style']['radius'] = built['radius']
        series.append(built)
    for index, item in enumerate(series, start=1):
        item['id'] = 'series-%d' % index
    return series


def _ambiguous(marks):
    seen = {}
    blocked = set()
    for mark in marks:
        for index in mark['drops']:
            key = (mark['content'], index)
            if key in seen:
                blocked.add(id(seen[key]))
                blocked.add(id(mark))
            else:
                seen[key] = mark
    return [mark for mark in marks if id(mark) not in blocked]


def prepare_marks(source, page_index, bbox, options=None):
    """Return a marks scene, or [] when no bar or scatter mark is bound.

    Curve-only crops, form XObjects and images return []. The returned scene
    has mode "marks" so a dispatcher can mount FalsifyChartMarkEditor.
    """
    if type(page_index) is not int or isinstance(page_index, bool) or page_index < 0:
        raise ValueError('bad-page')
    if not isinstance(source, (bytes, bytearray)):
        raise ValueError('bad-source')
    raw = bytes(source)
    box = _bbox(bbox)
    dpi = _dpi(options)
    width, height = paint.crop_size(box, dpi)
    plot = _plot(options, width, height)
    _streams, rects, circles = _load(raw, page_index, box)
    rects = _ambiguous(rects)
    circles = _ambiguous(circles)
    series = _build_series(rects, circles, box, dpi, plot)
    if not series:
        return []
    original = paint.render_png(raw, page_index, box, dpi)
    png_w, png_h = _png_size(original)
    if (png_w, png_h) != (width, height):
        width, height = png_w, png_h
    stripped = _strip(raw, page_index, series)
    background = paint.render_png(stripped, page_index, box, dpi)
    digest = hashlib.sha256(raw).hexdigest()
    scene_id = hashlib.sha256(('%s\n%s\n%s\n%s\nmarks' % (
        digest, page_index, ','.join('%.4f' % value for value in box), dpi)).encode('ascii')).hexdigest()
    import base64
    return {
        'schema': SCHEMA,
        'mode': 'marks',
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
        'limits': list(_LIMITS),
    }


def _strip(raw, page_index, series):
    parsed = _streams_of(raw, page_index)
    edits = {}
    for item in series:
        for mark in item['sourceBinding']['marks']:
            bucket = edits.setdefault(mark['content'], {'replacements': {}, 'drops': set()})
            bucket['drops'].update(mark['drops'])
    if not edits:
        return raw
    return _apply_streams(raw, page_index, parsed, edits)


def _streams_of(raw, page_index):
    pk, _mu = paint._deps()
    pdf = pk.open(io.BytesIO(raw))
    try:
        page = pdf.pages[page_index]
        return [paint._tokens(pk, stream.read_bytes()) for stream in paint._contents(pk, page)]
    finally:
        pdf.close()


def _apply_streams(raw, page_index, streams, edits):
    pk, _mu = paint._deps()
    pdf = pk.open(io.BytesIO(raw))
    try:
        page = pdf.pages[page_index]
        for content_index, edit in edits.items():
            if not edit['replacements'] and not edit['drops']:
                continue
            data = paint._join(streams[content_index], edit['replacements'], edit['drops'])
            paint._write_content(pk, pdf, page, content_index, data)
        return paint._save(pk, pdf)
    finally:
        pdf.close()


def _check(source, scene):
    if not isinstance(scene, dict) or scene.get('schema') != SCHEMA or scene.get('mode') != 'marks':
        raise ValueError('bad-scene')
    if scene.get('sourceFileHash') != hashlib.sha256(bytes(source)).hexdigest():
        raise ValueError('source-mismatch')
    if type(scene.get('pageIndex')) is not int:
        raise ValueError('bad-page')


def _series_points_changed(left, right, eps):
    changed = False
    if left.get('kind') not in ('bar', 'scatter') or right.get('kind') != left.get('kind'):
        raise ValueError('bad-scene')
    lp, rp = left.get('points') or [], right.get('points') or []
    if len(lp) != len(rp) or len(lp) != len(left.get('sourceBinding', {}).get('marks') or []):
        raise ValueError('point-topology')
    for a, b in zip(lp, rp):
        if not _finite(b.get('x')) or not _finite(b.get('y')):
            raise ValueError('bad-scene')
        if abs(float(a['x']) - float(b['x'])) > eps or abs(float(a['y']) - float(b['y'])) > eps:
            changed = True
    return changed


def _same_points(original, edited, eps=1e-3):
    if [item.get('id') for item in original] != [item.get('id') for item in edited]:
        raise ValueError('point-topology')
    changed = False
    for left, right in zip(original, edited):
        if _series_points_changed(left, right, eps): changed = True
    return not changed


def _token_float(tokens, index):
    try:
        return float(tokens[index][1].decode('latin1'))
    except (IndexError, UnicodeError, ValueError):
        raise ValueError('mark-not-found') from None


def _put(replacements, tokens, index, value):
    text = paint._format_num(value)
    raw = tokens[index][1]
    if raw.decode('latin1') != text:
        replacements[index] = text


def _expect(tokens, index, value):
    if abs(_token_float(tokens, index) - float(value)) > 0.05:
        raise ValueError('mark-not-found')


def _value_corners(mark, new_value):
    axis = mark['axis']
    updated = []
    for corner in mark['corners']:
        dx, dy = corner['display']
        coord = dy if axis == 'y' else dx
        on_value = abs(coord - mark['value']) <= abs(coord - mark['baseline'])
        if on_value:
            if axis == 'y':
                dy = new_value
            else:
                dx = new_value
        updated.append((corner, (dx, dy)))
    return updated


def _rewrite_bar(mark, point, bbox, dpi, replacements, tokens):
    if mark['axis'] == 'y':
        new_value = paint._crop_to_view((0.0, point['y']), bbox, dpi)[1]
    else:
        new_value = paint._crop_to_view((point['x'], 0.0), bbox, dpi)[0]
    if abs(new_value - float(mark['value'])) <= 0.04:
        return False
    inverse = paint._invert(tuple(mark['matrix']))
    moved = _value_corners(mark, new_value)
    user = {corner['name']: _map(inverse, display) for corner, display in moved}
    if mark['mode'] == 're':
        spec = mark['re']
        for index, value in zip(spec['indexes'], (spec['x'], spec['y'], spec['w'], spec['h'])):
            _expect(tokens, index, value)
        origin = user['c00']
        width = user['c10'][0] - origin[0]
        height = user['c01'][1] - origin[1]
        if abs(user['c10'][1] - origin[1]) > 0.08 or abs(user['c01'][0] - origin[0]) > 0.08:
            raise ValueError('mark-geometry')
        if abs((origin[0] + width) - user['c11'][0]) > 0.08 or abs((origin[1] + height) - user['c11'][1]) > 0.08:
            raise ValueError('mark-geometry')
        for index, value in zip(spec['indexes'], (origin[0], origin[1], width, height)):
            _put(replacements, tokens, index, value)
        return True
    for corner in mark['corners']:
        _expect(tokens, corner['ix'], corner['user'][0])
        _expect(tokens, corner['iy'], corner['user'][1])
    changed = False
    for corner in mark['corners']:
        point_user = user[corner['name']]
        before = (corner['user'][0], corner['user'][1])
        if paint._dist(before, point_user) > 0.02:
            changed = True
        _put(replacements, tokens, corner['ix'], point_user[0])
        _put(replacements, tokens, corner['iy'], point_user[1])
    return changed


def _rewrite_scatter(mark, point, bbox, dpi, replacements, tokens):
    display = paint._crop_to_view((point['x'], point['y']), bbox, dpi)
    inverse = paint._invert(tuple(mark['matrix']))
    user = _map(inverse, display)
    old = mark['centerUser']
    delta = (user[0] - old[0], user[1] - old[1])
    if abs(delta[0]) <= 0.04 and abs(delta[1]) <= 0.04:
        return False
    for operand in mark['operands']:
        _expect(tokens, operand['index'], operand['value'])
    for operand in mark['operands']:
        value = operand['value'] + (delta[0] if operand['axis'] == 'x' else delta[1])
        _put(replacements, tokens, operand['index'], value)
    return True


def _scene_box(scene):
    box = scene.get('bbox')
    dpi = scene.get('dpi') or 72
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError('bad-scene')
    return [float(value) for value in box], float(dpi)


def _edit_mark_series(series, edited_by_id, streams, bbox, dpi, edits, changed):
    current = edited_by_id.get(series.get('id'))
    if current is None:
        raise ValueError('point-topology')
    bindings = series['sourceBinding']['marks']
    series_changed = False
    for mark, before, after in zip(bindings, series['points'], current['points']):
        if abs(float(before['x']) - float(after['x'])) <= 1e-3 and abs(float(before['y']) - float(after['y'])) <= 1e-3:
            continue
        if mark['content'] >= len(streams):
            raise ValueError('mark-not-found')
        tokens = streams[mark['content']]
        bucket = edits.setdefault(mark['content'], {'replacements': {}, 'drops': set()})
        if series['kind'] == 'bar':
            wrote = _rewrite_bar(mark, after, bbox, dpi, bucket['replacements'], tokens)
        else:
            wrote = _rewrite_scatter(mark, after, bbox, dpi, bucket['replacements'], tokens)
        series_changed = series_changed or wrote
    if series_changed:
        changed.append(series['id'])


def export_marks(source, scene, edited):
    """Rewrite bound bar and scatter operands. Identical points return the original bytes."""
    if not isinstance(source, (bytes, bytearray)):
        raise ValueError('bad-source')
    raw = bytes(source)
    _check(raw, scene)
    if not isinstance(edited, dict) or not isinstance(edited.get('series'), list):
        raise ValueError('bad-scene')
    original = scene.get('series') or []
    if _same_points(original, edited.get('series') or []):
        return raw, _report(True, [], 'unchanged')
    if not original:
        return raw, _report(True, [], 'empty')
    bbox, dpi = _scene_box(scene)
    streams = _streams_of(raw, scene['pageIndex'])
    edits = {}
    changed = []
    edited_by_id = {item.get('id'): item for item in edited['series']}
    for series in original:
        _edit_mark_series(series, edited_by_id, streams, bbox, dpi, edits, changed)
    if not any(edit['replacements'] for edit in edits.values()):
        return raw, _report(True, [], 'unchanged')
    output = _apply_streams(raw, scene['pageIndex'], streams, edits)
    return output, _report(False, changed, 'native-marks')


def _report(noop, changed, mode):
    return {
        'schema': REPORT_SCHEMA,
        'noop': noop,
        'mode': mode,
        'changedSeries': list(changed),
        'limits': list(_LIMITS),
    }

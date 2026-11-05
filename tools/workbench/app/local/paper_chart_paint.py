"""Native and raster chart paint for falsify.chart-scene.v1.

render_scene(source, scene, edited_scene) -> {png, width, height, noop, mime}
export_scene(source, scene, edited_scene) -> (pdf_bytes, report)

No-op returns the original PDF bytes. Editor points are dense samples on the
painted curve; the original path commands stay in sourceBinding. A rigid move
rewrites the source coordinate tokens. A bump replaces only the changed path
fragment with the resampled samples and leaves every other operator, clip,
paint style, and shared invocation in place. Raster samples are decoded with
pikepdf's image decoder, and an edit rewrites only the selected curve's changed
corridor. MuPDF drawing seqno is recorded only as muSeqno and is never an
operator address. Shared Form and Image XObjects are cloned for the edited
invocation; the original object and every other Do keep their bytes. Unaffected
path fragments, grids, text, and other series stay in the content stream. This
path does not paint a white rectangle over the old curve.
"""
import hashlib
import io
import math
import zlib

REPORT_SCHEMA = 'falsify.chart-paint-report.v1'
_LIMITS = (
    'on-curve-samples',
    'axis-aligned-not-series',
    'no-white-erase',
    'seqno-not-operator-index',
    'shared-form-clone',
    'local-raster-corridor',
)
_SAMPLE_SPACING = 4.0
_SKIP_WORDS = {
    'BT', 'ET', 'Tj', 'TJ', "'", '"', 'Td', 'TD', 'Tm', 'T*', 'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts',
    'ri', 'cs', 'CS', 'sc', 'SC', 'scn', 'SCN', 'gs', 'MP', 'DP', 'BMC', 'BDC', 'EMC', 'BX', 'EX',
}
_STROKE = {'S', 's', 'B', 'B*', 'b', 'b*'}
_CONSUME = _STROKE | {'n', 'f', 'F', 'f*', 'W', 'W*'}


def _deps():
    try:
        import pikepdf
        import pymupdf
    except ImportError:
        raise ValueError('dependency-unavailable') from None
    return pikepdf, pymupdf


def crop_size(bbox, dpi):
    zoom = float(dpi) / 72.0
    return (math.ceil(bbox[2] * zoom) - math.floor(bbox[0] * zoom),
            math.ceil(bbox[3] * zoom) - math.floor(bbox[1] * zoom))


def _apply(matrix, x, y):
    a, b, c, d, e, f = matrix
    return (a * x + c * y + e, b * x + d * y + f)


def _invert(matrix):
    a, b, c, d, e, f = matrix
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError('singular-transform')
    return (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)


def _mul(left, right):
    """Apply left, then right. PDF cm M on CTM C is _mul(M, C)."""
    a, b, c, d, e, f = left
    A, B, C, D, E, F = right
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)


def _view_to_crop(point, bbox, dpi):
    zoom = float(dpi) / 72.0
    return (point[0] * zoom - math.floor(bbox[0] * zoom), point[1] * zoom - math.floor(bbox[1] * zoom))


def _crop_to_view(point, bbox, dpi):
    zoom = float(dpi) / 72.0
    return ((float(point[0]) + math.floor(bbox[0] * zoom)) / zoom,
            (float(point[1]) + math.floor(bbox[1] * zoom)) / zoom)


def _hex(rgb):
    return '#%02x%02x%02x' % tuple(max(0, min(255, int(round(channel * 255.0)))) for channel in rgb)


def _parse_hex(text):
    if not isinstance(text, str) or len(text) != 7 or text[0] != '#':
        raise ValueError('bad-color')
    try:
        return tuple(int(text[index:index + 2], 16) for index in (1, 3, 5))
    except ValueError:
        raise ValueError('bad-color') from None


def _format_num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('bad-coordinate')
    nearest = round(value)
    if abs(value - nearest) <= 1e-6:
        return str(int(nearest))
    text = ('%.4f' % value).rstrip('0').rstrip('.')
    return '0' if text in ('', '-', '-0') else text


def _dist(left, right):
    return math.hypot(left[0] - right[0], left[1] - right[1])


def _point_of(value):
    if hasattr(value, 'x') and hasattr(value, 'y'):
        return (float(value.x), float(value.y))
    if isinstance(value, (list, tuple)) and len(value) >= 2 and not hasattr(value, 'x0'):
        return (float(value[0]), float(value[1]))
    return None


def _drawing_items(drawing):
    items = []
    for item in drawing.get('items') or []:
        op = item[0]
        points = []
        for value in item[1:]:
            point = _point_of(value)
            if point is not None:
                points.append(point)
            elif hasattr(value, 'x0'):
                points.append((float(value.x0), float(value.y0), float(value.x1), float(value.y1)))
        items.append((op, points))
    return items


def _freeze_drawing(drawing):
    items = _drawing_items(drawing)
    color = drawing.get('color')
    seqno = drawing.get('seqno')
    cap = drawing.get('lineCap')
    join = drawing.get('lineJoin')
    if isinstance(cap, (list, tuple)):
        if join is None and len(cap) >= 2:
            join = cap[1]
        cap = cap[0] if cap else 0
    return {
        'type': drawing.get('type'),
        'seqno': seqno if type(seqno) is int else None,
        'color': None if not color else tuple(float(channel) for channel in color),
        'width': None if drawing.get('width') is None else float(drawing.get('width')),
        'dashes': drawing.get('dashes'),
        'opacity': drawing.get('stroke_opacity'),
        'lineCap': None if cap is None else int(cap) if not isinstance(cap, float) else cap,
        'lineJoin': None if join is None else join,
        'items': items,
    }


def _drawing_subpaths(drawing):
    current, subs = [], []
    for op, points in drawing['items']:
        if op == 'l' and len(points) >= 2:
            start, end = points[0], points[1]
            if current and _dist(current[-1], start) > 0.8:
                subs.append(current)
                current = [start, end]
            elif not current:
                current = [start, end]
            else:
                current.append(end)
        elif op == 'c' and len(points) >= 4:
            if current and _dist(current[-1], points[0]) > 0.8:
                subs.append(current)
                current = list(points[:4])
            elif not current:
                current = list(points[:4])
            else:
                current.extend(points[1:4])
        elif current:
            subs.append(current)
            current = []
    if current:
        subs.append(current)
    return subs


def _style_from_drawing(sub, drawings):
    for drawing in drawings:
        if drawing['type'] != 's' or not drawing['color']:
            continue
        for candidate in _drawing_subpaths(drawing):
            if len(candidate) != len(sub['view']):
                continue
            if all(_dist(left, right) <= 0.8 for left, right in zip(candidate, sub['view'])):
                sub['muSeqno'] = drawing['seqno']
                if drawing['lineCap'] is not None:
                    sub['lineCap'] = drawing['lineCap']
                if drawing['lineJoin'] is not None:
                    sub['lineJoin'] = drawing['lineJoin']
                if drawing['opacity'] is not None:
                    sub['opacity'] = float(drawing['opacity'])
                return


def _tokens(pk, data):
    scratch = pk.new()
    try:
        scratch.add_blank_page()
        page = scratch.pages[0]
        page.obj.Contents = scratch.make_stream(data)
        found = []

        class _Collect(pk.TokenFilter):
            def handle_token(self, token):
                if token.type_ != pk.TokenType.eof:
                    found.append((token.type_, bytes(token.raw_value)))
                return token

        page.get_filtered_contents(_Collect())
        if b''.join(raw for _, raw in found) != data:
            raise ValueError('malformed-pdf')
        return found
    finally:
        scratch.close()


def _commands(pk, tokens):
    number = {pk.TokenType.integer, pk.TokenType.real}
    skip = {pk.TokenType.space, pk.TokenType.comment}
    ops, buf, array = [], [], None
    index = 0
    while index < len(tokens):
        kind, raw = tokens[index]
        if kind in skip:
            index += 1
            continue
        if kind == pk.TokenType.array_open:
            array = []
            index += 1
            continue
        if kind == pk.TokenType.array_close:
            buf.append(('array', array))
            array = None
            index += 1
            continue
        if array is not None:
            if kind in number:
                array.append(float(raw))
            index += 1
            continue
        if kind == pk.TokenType.word:
            ops.append((raw.decode('latin1'), buf, index))
            buf = []
            index += 1
            continue
        if kind in number:
            buf.append(('num', index, float(raw)))
        elif kind == pk.TokenType.name_:
            buf.append(('name', index, raw.decode('latin1')))
        else:
            buf.append(('other', index, raw))
        index += 1
    return ops


def _nums(operands, count):
    nums = [item for item in operands if item[0] == 'num']
    if len(nums) < count:
        return None
    return nums[:count]


def _axis_data(sub):
    """True when the stroke is a data curve rather than an axis, grid, or tick."""
    for segment in sub['segments']:
        if segment[0] == 'l':
            if abs(segment[1][0] - segment[2][0]) > 0.8 and abs(segment[1][1] - segment[2][1]) > 0.8:
                return True
        elif segment[0] == 'c' and _curve_deviation(segment[1:]) > 0.75:
            return True
    return False


def _curve_deviation(points):
    start, end = points[0], points[3]
    return max(_segment_distance(points[1], start, end), _segment_distance(points[2], start, end))


def _segment_distance(point, start, end):
    span = _dist(start, end)
    if span < 1e-6:
        return _dist(point, start)
    area = abs((end[0] - start[0]) * (start[1] - point[1]) - (start[0] - point[0]) * (end[1] - start[1]))
    return area / span


def _split_bezier(points):
    p0, p1, p2, p3 = points

    def mid(left, right):
        return ((left[0] + right[0]) / 2.0, (left[1] + right[1]) / 2.0)

    p01, p12, p23 = mid(p0, p1), mid(p1, p2), mid(p2, p3)
    p012, p123 = mid(p01, p12), mid(p12, p23)
    center = mid(p012, p123)
    return (p0, p01, p012, center), (center, p123, p23, p3)


def _flatten_bezier(p0, p1, p2, p3, tol=0.75, spacing=_SAMPLE_SPACING):
    """On-curve samples. The control polygon is not returned."""
    out = []

    def rec(a, b, c, d, t0, t1, depth):
        span = _dist(a, d)
        bent = _segment_distance(b, a, d) > tol or _segment_distance(c, a, d) > tol
        if depth < 12 and span > 0.4 and (bent or span > spacing):
            left, right = _split_bezier((a, b, c, d))
            mid = (t0 + t1) / 2.0
            rec(left[0], left[1], left[2], left[3], t0, mid, depth + 1)
            rec(right[0], right[1], right[2], right[3], mid, t1, depth + 1)
        else:
            out.append((d, t1))

    rec(p0, p1, p2, p3, 0.0, 1.0, 0)
    return out


def _push_sample(samples, view, segment, t, role):
    if samples and samples[-1]['segment'] == segment and _dist(samples[-1]['view'], view) <= 0.05:
        samples[-1] = {'view': view, 'segment': segment, 't': t, 'role': role}
        return
    samples.append({'view': view, 'segment': segment, 't': t, 'role': role})


def _on_curve_samples(sub):
    """Dense samples on the painted curve, including interior points of a two-endpoint line."""
    if len(sub.get('view') or []) < 1:
        return []
    samples = []
    _push_sample(samples, sub['view'][0], 0, 0.0, 'source-endpoint')
    for index, segment in enumerate(sub['segments']):
        if segment[0] == 'l':
            start, end = segment[1], segment[2]
            steps = max(1, int(math.ceil(_dist(start, end) / _SAMPLE_SPACING)))
            for step in range(1, steps + 1):
                t = step / float(steps)
                view = (start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t)
                role = 'source-endpoint' if step == steps else 'curve-sample'
                _push_sample(samples, view, index, t, role)
        elif segment[0] == 'c':
            for view, t in _flatten_bezier(segment[1], segment[2], segment[3], segment[4]):
                role = 'source-endpoint' if t >= 1.0 - 1e-6 else 'curve-sample'
                _push_sample(samples, view, index, t, role)
    if len(samples) < 2 and len(sub['view']) >= 2:
        _push_sample(samples, sub['view'][-1], 0, 1.0, 'source-endpoint')
    return samples


def _path_id(sub):
    parent = sub.get('parent') or {}
    identity = (
        sub.get('stream_id'), sub.get('objgen'),
        tuple(index for _, index in sub.get('ops') or []),
        parent.get('stream_id'), parent.get('name_index'),
    )
    return hashlib.sha256(repr(identity).encode('utf-8')).hexdigest()[:24]


def _command_binding(sub):
    commands = []
    cursor = 0
    for op, _op_index in sub['ops']:
        count = 1 if op in ('m', 'l') else 3 if op == 'c' else 0
        operands = []
        for point in sub['points'][cursor:cursor + count]:
            operands.extend([float(point['x']), float(point['y'])])
        cursor += count
        if count:
            commands.append({'op': op, 'operands': operands})
    return commands


def _intersects(points, box, pad=1.0):
    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return not (max(xs) < box[0] - pad or min(xs) > box[2] + pad or max(ys) < box[1] - pad or min(ys) > box[3] + pad)


def _dash_value(operands):
    arrays = [item for item in operands if item[0] == 'array']
    phase = [item for item in operands if item[0] == 'num']
    if not arrays:
        return None
    pattern = arrays[0][1]
    if not pattern and (not phase or abs(phase[0][2]) < 1e-9):
        return None
    values = [float(item) for item in pattern]
    if phase:
        values.append(float(phase[0][2]))
    return values


def _gstate():
    return {'ctm': (1.0, 0.0, 0.0, 1.0, 0.0, 0.0), 'rgb': (0.0, 0.0, 0.0), 'width': 1.0,
            'dashes': None, 'cap': 0, 'join': 0, 'opacity': 1.0}


def _contents(pk, page):
    contents = page.obj.get('/Contents')
    if contents is None:
        return []
    if isinstance(contents, pk.Array):
        return list(contents)
    return [contents]


def _lookup(resources, name):
    if resources is None:
        return None
    xobjects = resources.get('/XObject')
    if xobjects is None:
        return None
    found = xobjects.get(name)
    if found is None and not str(name).startswith('/'):
        found = xobjects.get('/' + str(name))
    return found


def _matrix_of(obj):
    matrix = obj.get('/Matrix') if obj is not None else None
    if matrix is None:
        return (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    return tuple(float(value) for value in matrix)


def _update_stroke_style(word, operands, state):
    if word == 'w':
        nums = _nums(operands, 1)
        if nums:
            state['width'] = nums[0][2]
    elif word == 'd':
        state['dashes'] = _dash_value(operands)
    elif word == 'J':
        nums = _nums(operands, 1)
        if nums:
            state['cap'] = int(round(nums[0][2]))
    elif word == 'j':
        nums = _nums(operands, 1)
        if nums:
            state['join'] = int(round(nums[0][2]))
    elif word == 'CA':
        nums = _nums(operands, 1)
        if nums:
            state['opacity'] = nums[0][2]


def _update_graphics_state(word, operands, state):
    if word == 'cm':
        nums = _nums(operands, 6)
        if nums:
            state['ctm'] = _mul(tuple(item[2] for item in nums), state['ctm'])
    elif word == 'RG':
        nums = _nums(operands, 3)
        if nums:
            state['rgb'] = tuple(item[2] for item in nums)
    elif word == 'G':
        nums = _nums(operands, 1)
        if nums:
            state['rgb'] = (nums[0][2], nums[0][2], nums[0][2])
    else:
        _update_stroke_style(word, operands, state)


def _parse_streams(pk, pdf, page_index, page_tm):
    page = pdf.pages[page_index]
    resources = page.obj.get('/Resources')
    streams, subpaths, images = {}, [], []

    def walk(data, stream_resources, ctm, stream_id, objgen, parent, depth, ancestors):
        # The same Form stream is interpreted once per Do. Token indexes stay shared;
        # the invocation CTM and Do name index do not.
        if depth > 3 or (objgen is not None and objgen in ancestors):
            return
        if stream_id not in streams:
            streams[stream_id] = _tokens(pk, data)
        tokens = streams[stream_id]
        state, stack = _gstate(), []
        state['ctm'] = ctm
        path, current = [], None

        def flush():
            nonlocal current
            if current and len(current['view']) >= 2:
                path.append(current)
            current = None

        def begin(x, y, ix, iy, role):
            nonlocal current
            view_ctm = state['ctm']
            user = _apply(view_ctm, x, y)
            view = _apply(page_tm, user[0], user[1])
            if current is None:
                current = {'view': [], 'points': [], 'segments': [], 'ops': [], 'ctm': view_ctm,
                           'stream_id': stream_id, 'objgen': objgen, 'parent': parent}
            current['view'].append(view)
            current['points'].append({'x': x, 'y': y, 'ix': ix, 'iy': iy, 'ctm': view_ctm, 'role': role, 'user': user})

        def invoke(operands):
            names = [item for item in operands if item[0] == 'name']
            if not names:
                return
            target = _lookup(stream_resources, names[0][2])
            if target is None or not hasattr(target, 'read_bytes'):
                return
            subtype = str(target.get('/Subtype'))
            if subtype == '/Form':
                child_resources = target.get('/Resources')
                child = child_resources if child_resources is not None else stream_resources
                child_id = ('obj', tuple(target.objgen))
                walk(target.read_bytes(), child, _mul(_matrix_of(target), state['ctm']), child_id,
                     tuple(target.objgen), {'stream_id': stream_id, 'name_index': names[0][1], 'name': names[0][2]},
                     depth + 1, ancestors | ({objgen} if objgen is not None else set()))
            elif subtype == '/Image':
                images.append(_image_record(pk, target, names[0], state['ctm'], page_tm, stream_id))

        def consume(word):
            nonlocal path
            if word in ('s', 'b', 'b*') and current is not None:
                current['closed'] = True
            flush()
            if word in _STROKE:
                for sub in path:
                    sub.update({'rgb': state['rgb'], 'width': state['width'], 'dashes': state['dashes'],
                                'lineCap': state['cap'], 'lineJoin': state['join'], 'opacity': state['opacity'],
                                'muSeqno': None})
                    sub['path_id'] = _path_id(sub)
                    subpaths.append(sub)
            path = []

        def draw(word, operands, op_index):
            nonlocal current
            if word == 'm':
                nums = _nums(operands, 2)
                if nums:
                    flush()
                    begin(nums[0][2], nums[1][2], nums[0][1], nums[1][1], 'source-endpoint')
                    current['ops'].append(('m', op_index))
            elif word == 'l' and current is not None:
                nums = _nums(operands, 2)
                if nums:
                    start = current['view'][-1]
                    begin(nums[0][2], nums[1][2], nums[0][1], nums[1][1], 'source-endpoint')
                    current['segments'].append(('l', start, current['view'][-1]))
                    current['ops'].append(('l', op_index))
            elif word == 'c' and current is not None:
                nums = _nums(operands, 6)
                if nums:
                    start = current['view'][-1]
                    begin(nums[0][2], nums[1][2], nums[0][1], nums[1][1], 'curve-control')
                    begin(nums[2][2], nums[3][2], nums[2][1], nums[3][1], 'curve-control')
                    begin(nums[4][2], nums[5][2], nums[4][1], nums[5][1], 'source-endpoint')
                    current['segments'].append(('c', start, current['view'][-3], current['view'][-2], current['view'][-1]))
                    current['ops'].append(('c', op_index))
            elif word == 'h' and current is not None:
                current['closed'] = True

        for word, operands, op_index in _commands(pk, tokens):
            if word == 'q':
                stack.append({key: value for key, value in state.items()})
            elif word == 'Q' and stack:
                state = stack.pop()
            elif word in ('cm', 'RG', 'G', 'w', 'd', 'J', 'j', 'CA'):
                _update_graphics_state(word, operands, state)
            elif word in ('m', 'l', 'c', 'h'):
                draw(word, operands, op_index)
            elif word == 'Do':
                invoke(operands)
            elif word in _CONSUME:
                consume(word)
        flush()

    for content_index, stream in enumerate(_contents(pk, page)):
        walk(stream.read_bytes(), resources, (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
             ('page', page_index, content_index), None, None, 0, set())
    return {'streams': streams, 'subpaths': subpaths, 'images': images, 'resources': resources}


def _decoded_rgb(pk, target):
    """RGB bytes for DeviceRGB, ICCBased, Gray, CMYK, and JPEG images."""
    try:
        image = pk.PdfImage(target)
        pil = image.as_pil_image()
    except Exception:
        return None
    if getattr(pil, 'mode', None) != 'RGB':
        pil = pil.convert('RGB')
    data = pil.tobytes()
    if len(data) != pil.width * pil.height * 3:
        return None
    return data, int(pil.width), int(pil.height)


def _image_record(pk, target, name, ctm, page_tm, stream_id):
    from paper_chart_image_samples import decode_image
    decoded = decode_image(pk,target)
    width, height = int(target.get('/Width',0)), int(target.get('/Height',0))
    return {'name': name[2], 'name_index': name[1], 'objgen': tuple(target.objgen), 'ctm': ctm,
            'page_tm': page_tm, 'width': decoded['width'] if decoded else width,
            'height': decoded['height'] if decoded else height,
            'samples': decoded['samples'] if decoded else None,
            'alpha': decoded['alpha'] if decoded else None,
            'preserveRgbSpace': decoded['preserveRgbSpace'] if decoded else False,
            'jpegSource': '/DCTDecode' in str(target.get('/Filter')),
            'skipEdit': decoded is None and (target.get('/SMask') is not None or target.get('/Mask') is not None),
            'stream_id': stream_id}


def _decode_mu(mu, raw, image):
    """PyMuPDF fallback when pikepdf.PdfImage cannot decode the XObject."""
    objgen = image.get('objgen')
    if not objgen or not objgen[0]:
        return None
    doc = None
    try:
        doc = mu.open(stream=raw, filetype='pdf')
        pix = mu.Pixmap(doc, int(objgen[0]))
        if pix.n != 3 or pix.alpha:
            pix = mu.Pixmap(mu.csRGB, pix)
        data = bytes(pix.samples)
        if len(data) != pix.width * pix.height * 3:
            return None
        if image.get('width') not in (None, pix.width) or image.get('height') not in (None, pix.height):
            return None
        return data, int(pix.width), int(pix.height)
    except Exception:
        return None
    finally:
        if doc is not None:
            doc.close()


def _load(raw, page_index):
    pk, mu = _deps()
    doc = mu.open(stream=raw, filetype='pdf')
    try:
        if page_index >= doc.page_count:
            raise ValueError('bad-page')
        page = doc[page_index]
        matrix = page.transformation_matrix
        page_tm = (float(matrix.a), float(matrix.b), float(matrix.c), float(matrix.d), float(matrix.e), float(matrix.f))
        rotate = page.rotation_matrix
        rotation = tuple(float(value) for value in rotate)
        drawings = [_freeze_drawing(item) for item in page.get_drawings(extended=True)]
    finally:
        doc.close()
    pdf = pk.open(io.BytesIO(raw))
    try:
        parsed = _parse_streams(pk, pdf, page_index, page_tm)
    finally:
        pdf.close()
    parsed['page_tm'] = page_tm
    parsed['drawings'] = drawings
    for sub in parsed['subpaths']:
        _style_from_drawing(sub, drawings)
        sub['view'] = [_apply(rotation, *point) for point in sub['view']]
        sub['segments'] = [(segment[0], *(_apply(rotation, *point) for point in segment[1:]))
                           for segment in sub['segments']]
    parsed['page_tm'] = _mul(page_tm, rotation)
    for image in parsed['images']:
        image['page_tm'] = parsed['page_tm']
        if image.get('skipEdit') or (image.get('samples') and not image.get('jpegSource')):
            continue
        decoded = _decode_mu(mu, raw, image)
        if not decoded:
            continue
        data, width, height = decoded
        image['samples'] = data
        image['width'] = width
        image['height'] = height
    return parsed


def _public_series(parsed, bbox, dpi, plot):
    import paper_chart_raster_edit as raster
    native = []
    for sub in parsed['subpaths']:
        if sub['opacity'] is not None and sub['opacity'] <= 0.01:
            continue
        if sub['width'] is not None and sub['width'] <= 0:
            continue
        if not _axis_data(sub):
            continue
        samples = _on_curve_samples(sub)
        if len(samples) < 2:
            continue
        crop_points = [_view_to_crop(sample['view'], bbox, dpi) for sample in samples]
        if not _intersects([sample['view'] for sample in samples], bbox):
            continue
        if plot and not _intersects(crop_points, plot, 1.5):
            continue
        native.append(_native_public(sub, samples, bbox, dpi, parsed['page_tm'], len(native) + 1))
    if native:
        return native
    return _raster_public(parsed, bbox, dpi, plot, raster)


def _native_public(sub, samples, bbox, dpi, page_tm, number):
    points = []
    for sample in samples:
        crop = _view_to_crop(sample['view'], bbox, dpi)
        user = _apply(_invert(page_tm), sample['view'][0], sample['view'][1])
        points.append({'x': crop[0], 'y': crop[1], 'origin': 'pdf-vector', 'role': sample['role'],
                       'segment': sample['segment'], 't': sample['t'],
                       'sourcePagePoint': [user[0], user[1]]})
    commands = _command_binding(sub)
    fingerprint = hashlib.sha256(repr((
        sub.get('path_id'), commands,
        tuple(round(channel, 3) for channel in sub['rgb']), round(float(sub['width']), 3),
    )).encode('utf-8')).hexdigest()
    return {
        'id': 'series-%d' % number,
        'name': None,
        'color': _hex(sub['rgb']),
        'style': {'width': float(sub['width']), 'dashes': sub['dashes'], 'opacity': float(sub['opacity']),
                  'lineCap': sub['lineCap'], 'lineJoin': sub['lineJoin'], 'closed': bool(sub.get('closed'))},
        'points': points,
        'sourceBinding': {'kind': 'native-path', 'fingerprint': fingerprint, 'space': 'crop-pixels',
                          'muSeqno': sub.get('muSeqno'), 'pathId': sub.get('path_id'),
                          'commands': commands},
    }


def _raster_public(parsed, bbox, dpi, plot, raster):
    series = []
    for image in parsed['images']:
        if not image['samples'] or not image['width']:
            continue
        cv = _raster_array(image)
        if image.get('alpha') is not None:
            import numpy as np
            cv = cv.copy()
            cv[np.frombuffer(image['alpha'],dtype=np.uint8).reshape(image['height'],image['width']) < 4] = 255
        traced = raster.trace_series(cv, _plot_in_image(image, bbox, dpi, plot))
        scale = _mean_scale(image, bbox, dpi)
        for item in traced:
            points = []
            for index, point in enumerate(item['points']):
                crop = _image_index_to_crop(point, image, bbox, dpi)
                if plot and not (plot[0] - 1.5 <= crop[0] <= plot[2] + 1.5 and plot[1] - 1.5 <= crop[1] <= plot[3] + 1.5):
                    continue
                role = 'source-endpoint' if index in (0, len(item['points']) - 1) else 'curve-sample'
                points.append({'x': crop[0], 'y': crop[1], 'origin': 'raster-sample', 'role': role,
                               'branch': item.get('branch')})
            if len(points) < 2:
                continue
            color = '#%02x%02x%02x' % item['color']
            fingerprint = hashlib.sha256(repr((color, item.get('branch'), [(round(point['x'], 3), round(point['y'], 3)) for point in points])).encode('ascii')).hexdigest()
            series.append({
                'id': 'series-%d' % (len(series) + 1),
                'name': None,
                'color': color,
                'style': {'width': float(item['width']) * scale, 'dashes': None, 'opacity': 1.0, 'lineCap': 0, 'lineJoin': 0},
                'points': points,
                'sourceBinding': {'kind': 'raster-image', 'fingerprint': fingerprint, 'space': 'crop-pixels',
                                  'color': list(item['color']), 'imageSize': [image['width'], image['height']],
                                  'branch': item.get('branch'),
                                  'imageOccurrence': {'objgen': list(image['objgen']), 'stream': list(image['stream_id']), 'nameIndex': image['name_index']}},
            })
    return series


def _raster_array(image):
    import numpy as np
    return np.frombuffer(image['samples'], dtype=np.uint8).reshape((image['height'], image['width'], 3))


def _image_index_to_crop(point, image, bbox, dpi):
    unit_x = float(point[0]) / float(image['width'])
    unit_y = 1.0 - float(point[1]) / float(image['height'])
    user = _apply(image['ctm'], unit_x, unit_y)
    view = _apply(image['page_tm'], user[0], user[1])
    return _view_to_crop(view, bbox, dpi)


def _crop_to_image_index(point, image, bbox, dpi):
    view = _crop_to_view(point, bbox, dpi)
    user = _apply(_invert(image['page_tm']), view[0], view[1])
    unit = _apply(_invert(image['ctm']), user[0], user[1])
    return (unit[0] * image['width'], (1.0 - unit[1]) * image['height'])


def _image_scales(image, bbox, dpi):
    origin = _image_index_to_crop((0.0, 0.0), image, bbox, dpi)
    right = _image_index_to_crop((1.0, 0.0), image, bbox, dpi)
    down = _image_index_to_crop((0.0, 1.0), image, bbox, dpi)
    return _dist(origin, right), _dist(origin, down)


def _mean_scale(image, bbox, dpi):
    """Crop pixels per image pixel. Line width in the scene is in crop pixels."""
    sx, sy = _image_scales(image, bbox, dpi)
    scale = (sx + sy) / 2.0
    if not math.isfinite(scale) or scale < 1e-9:
        raise ValueError('singular-transform')
    return scale


def _plot_in_image(image, bbox, dpi, plot):
    if not plot:
        return None
    corners = [_crop_to_image_index((plot[0], plot[1]), image, bbox, dpi),
               _crop_to_image_index((plot[2], plot[3]), image, bbox, dpi)]
    xs = [point[0] for point in corners]
    ys = [point[1] for point in corners]
    return [math.floor(min(xs)), math.floor(min(ys)), math.ceil(max(xs)), math.ceil(max(ys))]


def series_for_crop(source, page_index, bbox, dpi, plot):
    return _public_series(_load(bytes(source), page_index), bbox, dpi, plot)


def render_png(source, page_index, bbox, dpi):
    pk, mu = _deps()
    doc = mu.open(stream=bytes(source), filetype='pdf')
    try:
        if page_index >= doc.page_count:
            raise ValueError('bad-page')
        pix = doc[page_index].get_pixmap(clip=mu.Rect(*bbox), dpi=int(round(dpi)), alpha=False)
        return pix.tobytes('png')
    finally:
        doc.close()


def _hash(source):
    return hashlib.sha256(bytes(source)).hexdigest()


def _same_series(scene, edited, eps=1e-4):
    left, right = scene.get('series') or [], edited.get('series') or []
    if [item.get('id') for item in left] != [item.get('id') for item in right]:
        return False
    for original, changed in zip(left, right):
        if len(original.get('points') or []) != len(changed.get('points') or []):
            return False
        for a, b in zip(original['points'], changed['points']):
            if abs(float(a['x']) - float(b['x'])) > eps or abs(float(a['y']) - float(b['y'])) > eps:
                return False
    return True


def _bound_native_path(subpaths, series):
    path_id = (series.get('sourceBinding') or {}).get('pathId')
    if path_id:
        found = [sub for sub in subpaths if sub.get('path_id') == path_id]
        if len(found) == 1:
            return found[0]
        if len(found) > 1:
            raise ValueError('ambiguous-path')
    return None


def _match_native(subpaths, series, bbox, dpi):
    bound = _bound_native_path(subpaths, series)
    if bound is not None:
        return bound
    color = _parse_hex(series['color'])
    target = [(float(point['x']), float(point['y'])) for point in series.get('points') or []]
    found = []
    for sub in subpaths:
        rgb = _parse_hex(_hex(sub['rgb']))
        if max(abs(color[index] - rgb[index]) for index in range(3)) > 2:
            continue
        samples = [_view_to_crop(sample['view'], bbox, dpi) for sample in _on_curve_samples(sub)]
        if len(samples) != len(target):
            continue
        if all(_dist(left, right) <= 0.8 for left, right in zip(samples, target)):
            found.append(sub)
    if not found:
        raise ValueError('path-not-found')
    if len(found) > 1:
        raise ValueError('ambiguous-path')
    return found[0]


def _uniform_delta(original, edited, eps=0.2):
    if len(original) != len(edited) or len(original) < 2:
        return None
    dx = float(edited[0]['x']) - float(original[0]['x'])
    dy = float(edited[0]['y']) - float(original[0]['y'])
    for left, right in zip(original, edited):
        if abs(float(right['x']) - float(left['x']) - dx) > eps or abs(float(right['y']) - float(left['y']) - dy) > eps:
            return None
    if abs(dx) <= 1e-6 and abs(dy) <= 1e-6:
        return None
    return dx, dy


def _moved_point(left, right, eps=1e-3):
    return abs(float(left['x']) - float(right['x'])) > eps or abs(float(left['y']) - float(right['y'])) > eps


def _colinear_points(points, eps=0.75):
    if len(points) < 2:
        return False
    start = (float(points[0]['x']), float(points[0]['y']))
    end = (float(points[-1]['x']), float(points[-1]['y']))
    return all(_segment_distance((float(point['x']), float(point['y'])), start, end) <= eps for point in points)


def _editor_groups(points):
    groups = []
    for index, point in enumerate(points):
        segment = point.get('segment')
        if segment is None:
            segment = 0
        if not groups or groups[-1]['segment'] != segment:
            groups.append({'segment': segment, 'indexes': [index]})
        else:
            groups[-1]['indexes'].append(index)
    return groups


def _span_indexes(groups, position):
    indexes = list(groups[position]['indexes'])
    if position > 0:
        indexes = [groups[position - 1]['indexes'][-1]] + indexes
    return indexes


def _pdf_segments(sub):
    cursor = 0
    found = []
    for op, op_index in sub['ops']:
        if op == 'm':
            cursor += 1
            continue
        if op == 'l':
            found.append({'op': op, 'op_index': op_index, 'start': cursor - 1, 'end': cursor, 'points': [cursor]})
            cursor += 1
        elif op == 'c':
            found.append({'op': op, 'op_index': op_index, 'start': cursor - 1, 'end': cursor + 2,
                          'points': [cursor, cursor + 1, cursor + 2]})
            cursor += 3
    return found


def _operand_from_crop(crop, ctm, page_tm, bbox, dpi):
    view = _crop_to_view(crop, bbox, dpi)
    user = _apply(_invert(page_tm), view[0], view[1])
    return _apply(_invert(ctm), user[0], user[1])


def _set_point_token(bucket, point, crop, page_tm, bbox, dpi):
    operand = _operand_from_crop(crop, point['ctm'], page_tm, bbox, dpi)
    bucket['replacements'][point['ix']] = _format_num(operand[0])
    bucket['replacements'][point['iy']] = _format_num(operand[1])


def _splice(bucket, indexes, data):
    indexes = [index for index in indexes if isinstance(index, int)]
    if not indexes:
        raise ValueError('malformed-pdf')
    first = min(indexes)
    bucket['drops'].update(index for index in indexes if index != first)
    bucket['replacements'][first] = data


def _shift_controls(bucket, sub, delta, page_tm, bbox, dpi):
    zoom = float(dpi) / 72.0
    view_delta = (delta[0] / zoom, delta[1] / zoom)
    for point, view in zip(sub['points'], sub['view']):
        moved = (view[0] + view_delta[0], view[1] + view_delta[1])
        user = _apply(_invert(page_tm), moved[0], moved[1])
        operand = _apply(_invert(point['ctm']), user[0], user[1])
        bucket['replacements'][point['ix']] = _format_num(operand[0])
        bucket['replacements'][point['iy']] = _format_num(operand[1])


def _resample_commands(points, ctm, page_tm, bbox, dpi, move=True):
    parts = []
    for index, point in enumerate(points):
        if index == 0 and not move:
            continue
        operand = _operand_from_crop((point['x'], point['y']), ctm, page_tm, bbox, dpi)
        op = 'm' if index == 0 else 'l'
        parts.append('%s %s %s' % (_format_num(operand[0]), _format_num(operand[1]), op))
    if not parts:
        raise ValueError('point-topology')
    return ' '.join(parts).encode('ascii')


def _resample_path(bucket, sub, points, page_tm, bbox, dpi):
    if len(points) < 2:
        raise ValueError('point-topology')
    indexes = []
    for point in sub['points']:
        indexes.extend([point['ix'], point['iy']])
    for _op, op_index in sub['ops']:
        indexes.append(op_index)
    ctm = sub['points'][0]['ctm']
    _splice(bucket, indexes, _resample_commands(points, ctm, page_tm, bbox, dpi, move=True))


def _rewrite_segment(bucket, sub, original_points, edited_points, page_tm, bbox, dpi, groups, original_groups, ctm, position, pdf_segment):
    span = _span_indexes(groups, position)
    original_span = _span_indexes(original_groups, position)
    if all(not _moved_point(original_points[left], edited_points[right]) for left, right in zip(original_span, span)):
        return
    edited_span = [edited_points[index] for index in span]
    if pdf_segment['op'] == 'l' and _colinear_points(edited_span):
        _set_point_token(bucket, sub['points'][pdf_segment['start']], (edited_span[0]['x'], edited_span[0]['y']), page_tm, bbox, dpi)
        _set_point_token(bucket, sub['points'][pdf_segment['end']], (edited_span[-1]['x'], edited_span[-1]['y']), page_tm, bbox, dpi)
        return
    indexes = [pdf_segment['op_index']]
    for point_index in pdf_segment['points']:
        point = sub['points'][point_index]
        indexes.extend([point['ix'], point['iy']])
    _splice(bucket, indexes, _resample_commands(edited_span, ctm, page_tm, bbox, dpi, move=False))
    if position == 0 and _moved_point(original_points[span[0]], edited_points[span[0]]):
        _set_point_token(bucket, sub['points'][pdf_segment['start']], (edited_span[0]['x'], edited_span[0]['y']), page_tm, bbox, dpi)


def _rewrite_subpath(bucket, sub, original_points, edited_points, page_tm, bbox, dpi):
    if len(edited_points) < 2:
        raise ValueError('point-topology')
    delta = _uniform_delta(original_points, edited_points)
    if delta is not None:
        _shift_controls(bucket, sub, delta, page_tm, bbox, dpi)
        return
    pdf_segments = _pdf_segments(sub)
    groups = _editor_groups(edited_points)
    original_groups = _editor_groups(original_points)
    aligned = (len(original_points) == len(edited_points) and len(groups) == len(pdf_segments)
               and len(original_groups) == len(pdf_segments)
               and all(len(_span_indexes(groups, index)) == len(_span_indexes(original_groups, index))
                       for index in range(len(pdf_segments))))
    if not aligned:
        _resample_path(bucket, sub, edited_points, page_tm, bbox, dpi)
        return
    ctm = sub['points'][0]['ctm']
    for position, pdf_segment in enumerate(pdf_segments):
        _rewrite_segment(bucket, sub, original_points, edited_points, page_tm, bbox, dpi, groups, original_groups, ctm, position, pdf_segment)


def _score_image(image, color, bbox, dpi, scene_points):
    if not image['samples']:
        return -1
    hits = 0
    samples = image['samples']
    width, height = image['width'], image['height']
    for point in scene_points:
        ix, iy = _crop_to_image_index((point['x'], point['y']), image, bbox, dpi)
        x, y = int(round(ix)), int(round(iy))
        if not (0 <= x < width and 0 <= y < height):
            continue
        offset = (y * width + x) * 3
        pixel = samples[offset:offset + 3]
        if pixel and max(abs(pixel[channel] - color[channel]) for channel in range(3)) <= 18:
            hits += 1
    return hits


def _match_image(images, series, bbox, dpi):
    color = series['sourceBinding'].get('color')
    if not color:
        color = _parse_hex(series['color'])
    color = tuple(int(channel) for channel in color)
    occurrence = series.get('sourceBinding',{}).get('imageOccurrence')
    if occurrence:
        matches = [image for image in images if list(image['objgen'])==occurrence.get('objgen') and list(image['stream_id'])==occurrence.get('stream') and image['name_index']==occurrence.get('nameIndex')]
        if len(matches)==1:
            return matches[0], color
        raise ValueError('path-not-found')
    ranked = []
    for image in images:
        score = _score_image(image, color, bbox, dpi, series['points'])
        if score > 0:
            ranked.append((score, image))
    if not ranked:
        raise ValueError('path-not-found')
    ranked.sort(key=lambda item: -item[0])
    if len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
        raise ValueError('ambiguous-path')
    return ranked[0][1], color


def _join(tokens, replacements, drops):
    parts = []
    for index, (_, raw) in enumerate(tokens):
        if index in drops:
            continue
        if index in replacements:
            value = replacements[index]
            parts.append(value if isinstance(value, bytes) else str(value).encode('ascii'))
        else:
            parts.append(raw)
    return b''.join(parts)


def _drop_native_path(bucket, sub):
    for point in sub['points']:
        bucket['drops'].add(point['ix'])
        bucket['drops'].add(point['iy'])
    for _, op_index in sub['ops']:
        bucket['drops'].add(op_index)


def _changed_native_series(original, edited, drop):
    current = original if drop else edited and next((item for item in edited['series'] if item.get('id') == original['id']), None)
    if current is None:
        return None
    if not drop and len(current.get('points') or []) < 2:
        raise ValueError('point-topology')
    if not drop and _same_series({'series': [original]}, {'series': [current]}):
        return None
    return current


def _native_edits(parsed, scene, edited, bbox, dpi, drop):
    by_id = {item['id']: item for item in scene['series']}
    edits = {}
    changed = []
    for original in scene['series']:
        if original.get('sourceBinding', {}).get('kind') != 'native-path':
            raise ValueError('mixed-scene')
        current = _changed_native_series(original, edited, drop)
        if current is None:
            continue
        sub = _match_native(parsed['subpaths'], original, bbox, dpi)
        bucket = edits.setdefault(id(sub), {'sub': sub, 'replacements': {}, 'drops': set()})
        if drop:
            _drop_native_path(bucket, sub)
            changed.append(original['id'])
            continue
        _rewrite_subpath(bucket, sub, original['points'], current['points'], parsed['page_tm'], bbox, dpi)
        if bucket['replacements'] or bucket['drops']:
            changed.append(original['id'])
        elif not bucket['replacements'] and not bucket['drops']:
            edits.pop(id(sub), None)
    if not by_id:
        raise ValueError('path-not-found')
    return edits, changed


def _group_native(edits):
    """Group path edits by the content stream or the Form invocation that owns them."""
    streams, clones = {}, {}
    for bucket in edits.values():
        sub = bucket['sub']
        if sub['objgen'] is None:
            target = streams.setdefault(sub['stream_id'], {'replacements': {}, 'drops': set()})
            target['replacements'].update(bucket['replacements'])
            target['drops'].update(bucket['drops'])
            continue
        parent = sub['parent']
        if parent is None or parent['stream_id'][0] != 'page':
            raise ValueError('nested-form')
        key = (sub['objgen'], parent['stream_id'], parent['name_index'])
        clone = clones.setdefault(key, {'objgen': sub['objgen'], 'stream_id': sub['stream_id'],
                                        'parent': parent, 'replacements': {}, 'drops': set()})
        clone['replacements'].update(bucket['replacements'])
        clone['drops'].update(bucket['drops'])
    return streams, clones


def _fresh_name(existing, blobs, prefix):
    number = 1
    while True:
        name = '%s%d' % (prefix, number)
        token = b'/' + name.encode('ascii')
        if ('/' + name) not in existing and all(token not in blob for blob in blobs):
            existing.add('/' + name)
            return name
        number += 1


def _copy_stream(pk, pdf, original, data):
    stream = pdf.make_stream(zlib.compress(data))
    stream.Filter = pk.Name.FlateDecode
    for key in original.keys():
        if str(key) not in ('/Length', '/Filter', '/DecodeParms'):
            stream[key] = original.get(key)
    return stream


def _copy_image_stream(pk, pdf, original, data, width, height, alpha=None, preserve_rgb_space=False):
    from paper_chart_image_samples import build_image_stream
    return build_image_stream(pk,pdf,original,data,width,height,alpha,preserve_rgb_space)


def _isolate(pk, owner, additions):
    resources = owner.get('/Resources')
    resources = resources if isinstance(resources, pk.Dictionary) else pk.Dictionary()
    xobjects = resources.get('/XObject')
    xobjects = xobjects if isinstance(xobjects, pk.Dictionary) else pk.Dictionary()
    copied_x = pk.Dictionary({key: xobjects.get(key) for key in xobjects.keys()})
    for name, stream in additions:
        copied_x[pk.Name('/' + name)] = stream
    copied = pk.Dictionary({key: resources.get(key) for key in resources.keys()})
    copied.XObject = copied_x
    owner.Resources = copied


def _object(pdf, objgen):
    getter = getattr(pdf, 'get_object', None)
    if getter is not None:
        try:
            return getter(objgen)
        except Exception:
            pass
    for obj in pdf.objects:
        if tuple(obj.objgen) == tuple(objgen):
            return obj
    raise ValueError('missing-object')


def _write_content(pk, pdf, page, content_index, data):
    stream = pdf.make_stream(zlib.compress(data))
    stream.Filter = pk.Name.FlateDecode
    contents = page.obj.get('/Contents')
    if isinstance(contents, pk.Array):
        array = pk.Array(list(contents))
        array[content_index] = stream
        page.Contents = array
    else:
        page.Contents = stream


def _save(pk, pdf):
    buf = io.BytesIO()
    pdf.save(buf, compress_streams=False, stream_decode_level=pk.StreamDecodeLevel.none,
             fix_metadata_version=False, deterministic_id=True)
    return buf.getvalue()


def _apply_pdf(raw, page_index, parsed, stream_edits, clones, name_prefix):
    pk, mu = _deps()
    pdf = pk.open(io.BytesIO(raw))
    try:
        page = pdf.pages[page_index]
        existing = set()
        xobjects = page.obj.get('/Resources')
        if xobjects is not None and xobjects.get('/XObject') is not None:
            existing = {str(key) for key in xobjects.get('/XObject').keys()}
        blobs = [b''.join(raw for _, raw in tokens) for tokens in parsed['streams'].values()]
        additions = []
        parent_reps = {}
        for clone in clones.values():
            name = _fresh_name(existing, blobs, name_prefix)
            parent = clone['parent']
            parent_reps.setdefault(parent['stream_id'], {})[parent['name_index']] = b'/' + name.encode('ascii')
            original = _object(pdf, clone['objgen'])
            data = _join(parsed['streams'][clone['stream_id']], clone['replacements'], clone['drops'])
            additions.append((name, _copy_stream(pk, pdf, original, data)))
        if additions:
            _isolate(pk, page.obj, additions)
        content_ids = {key for key in stream_edits if key[0] == 'page'}
        content_ids.update(key for key in parent_reps if key[0] == 'page')
        for stream_id in content_ids:
            replacements = {}
            drops = set()
            if stream_id in stream_edits:
                replacements.update(stream_edits[stream_id]['replacements'])
                drops.update(stream_edits[stream_id]['drops'])
            replacements.update(parent_reps.get(stream_id, {}))
            _write_content(pk, pdf, page, stream_id[2], _join(parsed['streams'][stream_id], replacements, drops))
        return _save(pk, pdf)
    finally:
        pdf.close()


def _scene_box(scene):
    box = scene.get('bbox')
    dpi = scene.get('dpi') or 72
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError('bad-scene')
    return [float(value) for value in box], float(dpi)


def _check_scene(source, scene):
    if not isinstance(scene, dict) or scene.get('schema') != 'falsify.chart-scene.v1':
        raise ValueError('bad-scene')
    if scene.get('sourceFileHash') != _hash(source):
        raise ValueError('source-mismatch')
    if type(scene.get('pageIndex')) is not int:
        raise ValueError('bad-page')


def strip_series(source, page_index, bbox, dpi, series):
    scene = {'schema': 'falsify.chart-scene.v1', 'sourceFileHash': _hash(source), 'pageIndex': page_index,
             'bbox': list(bbox), 'dpi': dpi, 'series': series}
    pdf, _report = _export(bytes(source), scene, scene, drop=True)
    return pdf


def _export(raw, scene, edited, drop):
    _check_scene(raw, scene)
    if not drop and _same_series(scene, edited):
        return (raw if isinstance(raw, bytes) else bytes(raw), _report(True, [], False, 'unchanged'))
    kinds = {item.get('sourceBinding', {}).get('kind') for item in scene.get('series') or []}
    if kinds == {'native-path'}:
        return _export_native(raw, scene, edited, drop)
    if kinds == {'raster-image'}:
        return _export_raster(raw, scene, edited, drop)
    if not kinds:
        return (raw if isinstance(raw, bytes) else bytes(raw), _report(True, [], False, 'empty'))
    raise ValueError('mixed-scene')


def _report(noop, changed, isolated, mode):
    return {'schema': REPORT_SCHEMA, 'noop': noop, 'mode': mode, 'changedSeries': list(changed),
            'formIsolated': bool(isolated), 'limits': list(_LIMITS)}


def _export_native(raw, scene, edited, drop):
    parsed = _load(raw, scene['pageIndex'])
    bbox, dpi = _scene_box(scene)
    edits, changed = _native_edits(parsed, scene, edited, bbox, dpi, drop)
    if not edits:
        return raw, _report(True, [], False, 'native')
    streams, clones = _group_native(edits)
    output = _apply_pdf(raw, scene['pageIndex'], parsed, streams, clones, 'ChartFm')
    return output, _report(False, changed, bool(clones), 'native')


def _branch_runs(points):
    runs = []
    for index, point in enumerate(points):
        ident = point.get('branch') if isinstance(point, dict) else None
        if not runs or runs[-1][0] != ident:
            runs.append((ident, [index]))
        else:
            runs[-1][1].append(index)
    return runs


def _image_points(points, image, bbox, dpi):
    return [_crop_to_image_index((point['x'], point['y']), image, bbox, dpi) for point in points]


def _edit_raster_runs(raster, array, original, current, image, bbox, dpi, color, width):
    """Edit each explicit branch on its own so a gap is not stroked over."""
    old_points = original['points']
    if current is None:
        for _ident, indexes in _branch_runs(old_points):
            array = raster.edit_raster(array, _image_points([old_points[index] for index in indexes], image, bbox, dpi),
                                       None, color, width)
        return array
    new_points = current['points']
    if len(new_points) != len(old_points):
        return raster.edit_raster(array, _image_points(old_points, image, bbox, dpi),
                                  _image_points(new_points, image, bbox, dpi), color, width)
    for _ident, indexes in _branch_runs(old_points):
        array = raster.edit_raster(
            array,
            _image_points([old_points[index] for index in indexes], image, bbox, dpi),
            _image_points([new_points[index] for index in indexes], image, bbox, dpi),
            color, width)
    return array


def _edit_raster_clone(array, alpha, original, current, color, image, bbox, dpi, scale, raster):
    style = (current or original).get('style') or {}
    crop_width = float(style.get('width') or original.get('style', {}).get('width') or 1)
    width = crop_width / scale
    if alpha is not None:
        from paper_chart_image_samples import edit_alpha
        old_points = original['points']
        new_points = None if current is None else current['points']
        runs = _branch_runs(old_points) if new_points is None or len(new_points)==len(old_points) else [(None,list(range(len(old_points))))]
        for _, indexes in runs:
            old = _image_points([old_points[i] for i in indexes],image,bbox,dpi)
            new = None if new_points is None else _image_points([new_points[i] for i in indexes],image,bbox,dpi)
            alpha = edit_alpha(array,alpha,old,new,color,width)
    array = _edit_raster_runs(raster, array, original, current, image, bbox, dpi, color, width)
    return array, alpha


def _raster_clones(clones, bbox, dpi, raster, np):
    stream_clones = {}
    for key, clone in clones.items():
        image = clone['image']
        array = _raster_array(image).copy()
        alpha = None if image.get('alpha') is None else np.frombuffer(image['alpha'],dtype=np.uint8).reshape(image['height'],image['width']).copy()
        scale = _mean_scale(image, bbox, dpi)
        for original, current, color in clone['edits']:
            array, alpha = _edit_raster_clone(array, alpha, original, current, color, image, bbox, dpi, scale, raster)
        patch = alpha is None
        if patch:
            # Keep the original opaque image paint and overlay only changed
            # source pixels. JPEG decoder/interpolation differences must not
            # repaint captions, axes or the rest of a shared figure.
            import cv2
            changed_mask = np.any(array != _raster_array(image),axis=2).astype(np.uint8)
            alpha = cv2.dilate(changed_mask,np.ones((3,3),np.uint8))*255
        samples = np.ascontiguousarray(array, dtype=np.uint8).tobytes()
        if len(samples) != image['width'] * image['height'] * 3:
            raise ValueError('bad-image')
        stream_clones[key] = {'objgen': image['objgen'], 'stream_id': image['stream_id'],
                              'parent': {'stream_id': image['stream_id'], 'name_index': image['name_index']},
                              'width': image['width'], 'height': image['height'],
                              'replacements': {}, 'drops': set(), 'samples': samples,
                              'alpha': None if alpha is None else alpha.tobytes(),
                              'preserveRgbSpace': image.get('preserveRgbSpace',False),
                              'patch':patch, 'originalName':image['name']}
    return stream_clones


def _export_raster(raw, scene, edited, drop):
    import numpy as np
    import paper_chart_raster_edit as raster
    parsed = _load(raw, scene['pageIndex'])
    bbox, dpi = _scene_box(scene)
    clones = {}
    changed = []
    for original in scene['series']:
        current = original if drop else next((item for item in edited['series'] if item.get('id') == original['id']), None)
        if current is None:
            continue
        if not drop and len(current.get('points') or []) < 2:
            raise ValueError('point-topology')
        if not drop and _same_series({'series': [original]}, {'series': [current]}):
            continue
        image, color = _match_image(parsed['images'], original, bbox, dpi)
        if image['stream_id'][0] != 'page':
            raise ValueError('nested-form')
        key = (image['objgen'], image['stream_id'], image['name_index'])
        clone = clones.setdefault(key, {'image': image, 'edits': []})
        clone['edits'].append((original, None if drop else current, color))
        changed.append(original['id'])
    if not clones:
        return raw, _report(True, [], False, 'raster')
    stream_clones = _raster_clones(clones, bbox, dpi, raster, np)
    # Image bytes are not content-stream tokens. Build the clone stream from samples.
    output = _apply_images(raw, scene['pageIndex'], parsed, stream_clones)
    return output, _report(False, changed, True, 'raster')


def _apply_images(raw, page_index, parsed, clones):
    pk, mu = _deps()
    pdf = pk.open(io.BytesIO(raw))
    try:
        page = pdf.pages[page_index]
        xobjects = page.obj.get('/Resources')
        existing = set()
        if xobjects is not None and xobjects.get('/XObject') is not None:
            existing = {str(key) for key in xobjects.get('/XObject').keys()}
        blobs = [b''.join(raw_token for _, raw_token in tokens) for tokens in parsed['streams'].values()]
        additions = []
        replacements = {}
        for clone in clones.values():
            name = _fresh_name(existing, blobs, 'ChartIm')
            parent = clone['parent']
            paint_name = b'/' + name.encode('ascii')
            if clone.get('patch'):
                paint_name = clone['originalName'].encode('latin1') + b' Do ' + paint_name
            replacements.setdefault(parent['stream_id'], {})[parent['name_index']] = paint_name
            original = _object(pdf, clone['objgen'])
            additions.append((name, _copy_image_stream(pk, pdf, original, clone['samples'], clone['width'], clone['height'], clone.get('alpha'), clone.get('preserveRgbSpace',False))))
        _isolate(pk, page.obj, additions)
        for stream_id, reps in replacements.items():
            _write_content(pk, pdf, page, stream_id[2], _join(parsed['streams'][stream_id], reps, set()))
        return _save(pk, pdf)
    finally:
        pdf.close()


def export_scene(source, scene, edited_scene):
    """Return PDF bytes and a paint report. Identical series points return the original bytes."""
    if not isinstance(source, (bytes, bytearray)):
        raise ValueError('bad-source')
    if not isinstance(edited_scene, dict):
        raise ValueError('bad-scene')
    return _export(bytes(source), scene, edited_scene, drop=False)


def render_scene(source, scene, edited_scene):
    """Render the crop after export. A no-op renders the original source."""
    pdf, report = export_scene(source, scene, edited_scene)
    bbox, dpi = _scene_box(scene)
    png = render_png(pdf, scene['pageIndex'], bbox, dpi)
    return {'png': png, 'width': scene.get('width'), 'height': scene.get('height'),
            'noop': report['noop'], 'mime': 'image/png', 'report': report}

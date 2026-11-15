"""Source-derived piecewise-linear editing tracks. Coordinates remain crop pixels."""
import base64
import heapq
import math


def _png(image, cv):
    ok, raw = cv.imencode('.png', image)
    if not ok:
        raise ValueError('bad-image')
    return base64.b64encode(raw.tobytes()).decode('ascii')


def _rgb(png, cv, np):
    return cv.cvtColor(cv.imdecode(np.frombuffer(png, np.uint8), cv.IMREAD_COLOR), cv.COLOR_BGR2RGB)


def _groups(scene):
    from paper_chart_curve_links import linked_ids
    seen = set()
    for series in scene['series']:
        if series['id'] in seen:
            continue
        ids = linked_ids(scene.get('curveLinks', []), series['id'])
        seen.update(ids)
        members = [s for s in scene['series'] if s['id'] in ids]
        points = [p for s in members for p in s['points']]
        if not points:
            continue
        bounds = [min(p['x'] for p in points), min(p['y'] for p in points),
                  max(p['x'] for p in points), max(p['y'] for p in points)]
        if bounds[2] - bounds[0] >= max(20, scene['width'] * .18):
            yield members, bounds


def _join(graph, points, a, b):
    length = math.hypot(points[a]['x'] - points[b]['x'], points[a]['y'] - points[b]['y'])
    graph[a].append((b, length))
    graph[b].append((a, length))


def _graph(scene, members):
    points, graph = {}, {}
    for s in members:
        for i, point in enumerate(s['points']):
            points[(s['id'], i)] = point
            graph[(s['id'], i)] = []
        for i in range(1, len(s['points'])):
            if s['points'][i].get('branch') == s['points'][i - 1].get('branch'):
                _join(graph, points, (s['id'], i - 1), (s['id'], i))
    for a, b in scene.get('curveLinks', []):
        if tuple(a) in points and tuple(b) in points:
            _join(graph, points, tuple(a), tuple(b))
    return graph, points


def _path(scene, members):
    graph, points = _graph(scene, members)
    start = min(points, key=lambda k: points[k]['x'])
    end = max(points, key=lambda k: points[k]['x'])
    distances, previous, pending = {start: 0}, {}, [(0, start)]
    while pending:
        distance, key = heapq.heappop(pending)
        if key == end:
            break
        if distance != distances[key]:
            continue
        for next_key, length in graph[key]:
            candidate = distance + length
            if candidate < distances.get(next_key, math.inf):
                distances[next_key], previous[next_key] = candidate, key
                heapq.heappush(pending, (candidate, next_key))
    route, key = [], end
    while key in previous:
        route.append(points[key])
        key = previous[key]
    route.append(points[start])
    return list(reversed(route))


def _color(rgb, members, scale, cv, np):
    points = [p for s in members for p in s['points']]
    xs = np.clip(np.round([p['x'] * scale for p in points]).astype(int), 0, rgb.shape[1] - 1)
    ys = np.clip(np.round([p['y'] * scale for p in points]).astype(int), 0, rgb.shape[0] - 1)
    pixels = rgb[ys, xs]
    chroma = pixels.max(axis=1).astype(int) - pixels.min(axis=1).astype(int)
    selected = pixels[chroma >= max(25, float(np.percentile(chroma, 85)))]
    return tuple(int(c) for c in np.median(selected, axis=0)) if len(selected) else tuple(int(members[0]['color'][i:i + 2], 16) for i in (1, 3, 5))


def _mask(rgb, color, bounds, scale, cv, np):
    from paper_chart_raster_edit import color_mask
    mask = color_mask(rgb, color)
    box = [int(bounds[0] * scale) - 4, int(bounds[1] * scale) - 10,
           int(bounds[2] * scale) + 5, int(bounds[3] * scale) + 11]
    region = np.zeros(mask.shape, np.uint8)
    cv.rectangle(region, (max(0, box[0]), max(0, box[1])),
                 (min(mask.shape[1] - 1, box[2]), min(mask.shape[0] - 1, box[3])), 1, -1)
    return mask & region.astype(bool)


def _markers(mask, scale, cv, np):
    distance = cv.distanceTransform(mask.astype(np.uint8), cv.DIST_L2, 5)
    # Filled marker interiors are wider than both the line and error-bar caps.
    nonzero = distance[distance > 0]
    threshold = max(2.1, float(np.median(nonzero)) * 1.8, float(distance.max()) * .67) if nonzero.size else 2.1
    count, labels, _, _ = cv.connectedComponentsWithStats((distance >= threshold).astype(np.uint8), 8)
    found = []
    for label in range(1, count):
        ys, xs = np.where(labels == label)
        i = int(np.argmax(distance[ys, xs]))
        found.append({'x': float(xs[i]) / scale, 'y': float(ys[i]) / scale,
                      'radius': float(distance[ys[i], xs[i]]) / scale, 'origin': 'visible-marker'})
    return sorted(found, key=lambda p: p['x'])


def _simplified(path, cv, np):
    from paper_chart_sampling import _simplify_indices
    return [dict(path[i], origin='path-vertex') for i in _simplify_indices(path, .55, cv, np)]


def _knots(path, markers, cv, np):
    if len(markers) < 2:
        return _simplified(path, cv, np)
    points = [dict(p) for p in markers]
    for endpoint in (path[0], path[-1]):
        if min(abs(p['x'] - endpoint['x']) for p in points) > 3:
            points.append(dict(endpoint, origin='path-vertex'))
    return sorted(points, key=lambda p: p['x'])


def _linear(path, knots, np):
    if not 2 <= len(knots) <= 64:
        return False
    xs = np.array([k['x'] for k in knots])
    if np.any(np.diff(xs) <= .4):
        return False
    first = min(range(len(path)), key=lambda i: math.hypot(path[i]['x'] - knots[0]['x'], path[i]['y'] - knots[0]['y']))
    last = min(range(len(path)), key=lambda i: math.hypot(path[i]['x'] - knots[-1]['x'], path[i]['y'] - knots[-1]['y']))
    path = path[min(first, last):max(first, last) + 1]
    samples = [p for p in path if xs[0] <= p['x'] <= xs[-1]
               and min(math.hypot(p['x'] - k['x'], p['y'] - k['y']) for k in knots) > 2]
    if not samples:
        return False
    fitted = np.interp([p['x'] for p in samples], xs, [k['y'] for k in knots])
    error = np.abs(fitted - [p['y'] for p in samples])
    return float(np.percentile(error, 95)) <= .9


def _width(rgb, color, knots, scale, cv, np):
    ink = 255 - np.array(color, np.float32)
    denominator = max(1, float(ink @ ink))
    widths = []
    offsets = np.arange(-8, 8.25, .25, dtype=np.float32)
    for a, b in zip(knots, knots[1:]):
        dx, dy = b['x'] - a['x'], b['y'] - a['y']
        length = math.hypot(dx, dy)
        if length < 4:
            continue
        for fraction in (.35, .55, .75):
            x = (a['x'] + dx * fraction) * scale - dy / length * offsets
            y = (a['y'] + dy * fraction) * scale + dx / length * offsets
            pixels = cv.remap(rgb, x.reshape(1, -1), y.reshape(1, -1), cv.INTER_LINEAR, borderMode=cv.BORDER_CONSTANT, borderValue=(255, 255, 255))[0]
            coverage = np.clip((255 - pixels.astype(np.float32)) @ ink / denominator, 0, 1)
            widths.append(float(coverage.sum()) * .25 / scale)
    return float(np.clip(np.median(widths), .15, 4)) if widths else .5


def _straight_support(mask, knots, scale, cv, np):
    distance = cv.distanceTransform((~mask).astype(np.uint8), cv.DIST_L2, 5)
    samples = []
    for a, b in zip(knots, knots[1:]):
        count = max(4, math.ceil(math.hypot(a['x'] - b['x'], a['y'] - b['y']) * scale))
        t = np.linspace(.1, .9, count, dtype=np.float32)
        x = (a['x'] + (b['x'] - a['x']) * t) * scale
        y = (a['y'] + (b['y'] - a['y']) * t) * scale
        samples.extend(cv.remap(distance, x.reshape(1, -1), y.reshape(1, -1), cv.INTER_LINEAR)[0].tolist())
    return bool(samples) and float(np.percentile(samples, 85)) / scale <= .5


def _layer(rgb, mask, cv, np, color=None):
    if color is None:
        pixels, alpha = rgb, mask.astype(np.uint8) * 255
    else:
        chroma = rgb.max(axis=2).astype(float) - rgb.min(axis=2).astype(float)
        alpha = np.round(np.clip(chroma / max(1, max(color) - min(color)), 0, 1) * mask * 255).astype(np.uint8)
        pixels = np.empty_like(rgb)
        pixels[:] = color
    rgba = np.dstack([cv.cvtColor(pixels, cv.COLOR_RGB2BGR), alpha])
    return _png(rgba, cv)


def _decorations(rgb, mask, knots, width, scale, color, cv, np):
    line = np.zeros(mask.shape, np.uint8)
    points = np.round([[k['x'] * scale, k['y'] * scale] for k in knots]).astype(np.int32)
    cv.polylines(line, [points], False, 1, max(1, math.ceil(width * scale) + 2))
    decorations = mask & ~line.astype(bool)
    for knot in knots:
        if knot.get('radius'):
            circle = np.zeros(mask.shape, np.uint8)
            cv.circle(circle, (round(knot['x'] * scale), round(knot['y'] * scale)), math.ceil(knot['radius'] * scale + 1), 1, -1)
            decorations |= mask & circle.astype(bool)
    ys, xs = np.where(decorations)
    nearest = np.abs(xs[:, None] / scale - np.array([k['x'] for k in knots])).argmin(axis=1)
    result = []
    for i, knot in enumerate(knots):
        x, y = xs[nearest == i], ys[nearest == i]
        if not len(x):
            continue
        box = [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1]
        selected = np.zeros((box[3] - box[1], box[2] - box[0]), bool)
        selected[y - box[1], x - box[0]] = True
        result.append({'knotId': knot['id'], 'bbox': [v / scale for v in box],
                       'png': _layer(rgb[box[1]:box[3], box[0]:box[2]], selected, cv, np, color)})
    return result


def _track(scene, members, bounds, rgb, scale, index, cv, np):
    path = _path(scene, members)
    color = _color(rgb, members, scale, cv, np)
    # Achromatic data can share ink with axes and text; retain its source-bound editor.
    if max(color) - min(color) < 20:
        return None
    mask = _mask(rgb, color, bounds, scale, cv, np)
    markers = _markers(mask, scale, cv, np)
    knots = _knots(path, markers, cv, np)
    if not 2 <= len(knots) <= 64 or any(b['x'] - a['x'] <= .4 for a, b in zip(knots, knots[1:])):
        return None
    supported = _straight_support(mask, knots, scale, cv, np) if len(markers) >= 2 else _linear(path, knots, np)
    if not supported:
        return None
    if len(markers) < 2 and len(knots) > 4:
        return None
    for i, knot in enumerate(knots):
        knot['id'] = 'k%d' % i
    width = _width(rgb, color, knots, scale, cv, np)
    erased = cv.dilate(mask.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    track = {'id': 'line-%d' % index, 'memberIds': [s['id'] for s in members],
             'color': '#%02x%02x%02x' % color, 'width': width,
             'knots': knots, 'sourceKnots': [dict(k) for k in knots],
             'inkPng': _layer(rgb, mask, cv, np, color), 'sourceMaskPng': _png(erased.astype(np.uint8) * 255, cv),
             'decorations': _decorations(rgb, mask, knots, width, scale, color, cv, np)}
    return track, erased


def augment(raw, scene):
    """Add a linear editor only when the visible main tracks support straight joins."""
    import cv2 as cv
    import numpy as np
    import paper_chart_paint as paint
    from paper_chart_background import restore_background
    groups = list(_groups(scene))
    if not groups or len(groups) > 12:
        return scene
    scale = min(4, 1800 / max(scene['width'], scene['height']))
    rgb = _rgb(paint.render_png(raw, scene['pageIndex'], scene['bbox'], scene['dpi'] * scale), cv, np)
    tracks, masks = [], []
    for members, bounds in groups:
        built = _track(scene, members, bounds, rgb, scale, len(tracks) + 1, cv, np)
        if built is None:
            return scene
        track, mask = built
        tracks.append(track)
        masks.append(mask)
    cleared = np.logical_or.reduce(masks)
    base = restore_background(rgb, cleared)
    scene['linearTracks'] = tracks
    scene['linearBasePng'] = _png(cv.cvtColor(base, cv.COLOR_RGB2BGR), cv)
    scene['linearScale'] = scale
    return scene


def rebind_linear(scene, edited, fresh, fresh_edited):
    """Carry semantic edits onto a PDF that already contains another region's edits."""
    import copy
    from paper_chart_linear_paint import changed
    if not changed(scene, edited):
        return
    def key(track):
        return track['color'], tuple((k['x'], k['y']) for k in track['sourceKnots'])
    remaining = list(zip(scene['linearTracks'], edited['linearTracks']))
    if len(fresh.get('linearTracks', [])) != len(remaining):
        raise ValueError('chart_region_changed')
    for index, target in enumerate(fresh['linearTracks']):
        match = next((i for i, (original, _) in enumerate(remaining) if key(original) == key(target)), None)
        if match is None:
            raise ValueError('chart_region_changed')
        _, modified = remaining.pop(match)
        fresh_edited['linearTracks'][index]['knots'] = copy.deepcopy(modified['knots'])

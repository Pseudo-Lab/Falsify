"""Raster chart curve edits that keep pixels outside the selected corridor.

Public API:
  color_mask(image, color, tolerance=18) -> bool ndarray
  restore_under_mask(image, mask) -> RGB ndarray
  paint_polyline(image, points, color, width) -> RGB ndarray
  edit_raster(image, points, new_points, color, width, tolerance=18) -> RGB ndarray
  trace_series(image, plot_bbox=None, tolerance=18) -> list of series dicts

image is HxWx3 uint8, row 0 at the top. points are pixel indexes in that array,
which are also crop pixels when the chart image is placed 1:1. trace_series asks
the existing PlotTracer findLines core for each saturated color. It does not
invent a second tracer. Editing retains the upstream skeleton graph's short
joins and junctions; numerical measurement keeps its separate findLines route.

edit_raster clears only the color pixels in a corridor around the changed span
of the selected polyline, then paints that span. Other curves of the same color
and the unmoved part of this curve keep their original pixels. Grid crossings
under the cleared span are restored from unmasked neighbors. Pillow is not
required; OpenCV draws the new span with LINE_8 so the color is exact.
"""
import math

_TOLERANCE = 18
_MIN_PIXELS = 12
_SEEK = 8
_CORE = None


def _deps():
    try:
        import cv2
        import numpy as np
    except ImportError:
        raise ValueError('dependency-unavailable') from None
    return cv2, np


def _rgb(image):
    cv2, np = _deps()
    array = np.asarray(image)
    if array.ndim != 3 or array.shape[2] != 3 or array.dtype != np.uint8:
        raise ValueError('bad-image')
    return array


def color_mask(image, color, tolerance=_TOLERANCE):
    """Source ink and its antialiased mixes with white; exclude achromatic grids."""
    cv2, np = _deps()
    array = _rgb(image)
    import paper_chart_dark_curve as dark
    if dark.is_neutral_dark_color(color):
        return dark.dark_neutral_ink_mask(array, color, tolerance, np)
    target = np.array([int(color[0]), int(color[1]), int(color[2])], dtype=np.int16)
    delta = np.max(np.abs(array.astype(np.int16) - target), axis=2)
    ink = 255.0 - target.astype(np.float32)
    pixels = array.astype(np.float32)
    coverage = np.sum((255.0 - pixels) * ink, axis=2) / max(float(np.dot(ink, ink)), 1.0)
    residual = np.max(np.abs(pixels - (255.0 - coverage[:, :, None] * ink)), axis=2)
    chroma = pixels.max(axis=2) - pixels.min(axis=2)
    mixed = (coverage >= .08) & (coverage <= 1.5) & (residual <= int(tolerance)) & (chroma >= 10)
    hsv = cv2.cvtColor(array, cv2.COLOR_RGB2HSV)
    hue = int(cv2.cvtColor(np.uint8([[color]]), cv2.COLOR_RGB2HSV)[0, 0, 0])
    difference = np.abs(hsv[:, :, 0].astype(np.int16) - hue)
    shades = (np.minimum(difference, 180 - difference) <= 5) & (hsv[:, :, 1] >= 30) & (chroma >= 10)
    return (delta <= int(tolerance)) | mixed | shades


def _seek(image, mask, y, x, dy, dx):
    height, width = mask.shape
    for step in range(1, _SEEK + 1):
        yy, xx = y + dy * step, x + dx * step
        if not (0 <= yy < height and 0 <= xx < width):
            return None
        if not mask[yy, xx]:
            return image[yy, xx]
    return None


def _gray(pixel):
    if pixel is None:
        return False
    channels = [int(pixel[0]), int(pixel[1]), int(pixel[2])]
    return max(channels) - min(channels) <= 14 and 100 <= sum(channels) / 3 <= 230


def _same_grid(left, right):
    if not (_gray(left) and _gray(right)):
        return False
    return max(abs(int(left[index]) - int(right[index])) for index in range(3)) <= 12


def restore_under_mask(image, mask):
    """Replace mask pixels with the grid line they interrupted, or the nearby plain color.

    Neighbors are read from the original image, so a restored pixel is not reused as evidence.
    """
    cv2, np = _deps()
    array = _rgb(image)
    mask = np.asarray(mask, dtype=bool)
    if mask.shape != array.shape[:2]:
        raise ValueError('bad-mask')
    out = array.copy()
    ys, xs = np.where(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        left, right = _seek(array, mask, y, x, 0, -1), _seek(array, mask, y, x, 0, 1)
        up, down = _seek(array, mask, y, x, -1, 0), _seek(array, mask, y, x, 1, 0)
        if _same_grid(left, right):
            out[y, x] = left
        elif _same_grid(up, down):
            out[y, x] = up
        else:
            for pixel in (left, right, up, down):
                if pixel is not None and int(max(pixel)) - int(min(pixel)) <= 14:
                    out[y, x] = pixel
                    break
            else:
                out[y, x] = np.array([255, 255, 255], dtype=np.uint8)
    return out


def paint_polyline(image, points, color, width):
    """Draw a LINE_8 polyline. The source array is not modified."""
    cv2, np = _deps()
    array = _rgb(image)
    out = array.copy()
    if not points:
        return out
    coords = []
    for point in points:
        if len(point) < 2 or not all(math.isfinite(float(point[index])) for index in range(2)):
            raise ValueError('bad-coordinate')
        coords.append([int(round(float(point[0]))), int(round(float(point[1])))])
    thickness = max(1, int(round(float(width))))
    paint = (int(color[0]), int(color[1]), int(color[2]))
    pts = np.array(coords, dtype=np.int32).reshape(-1, 1, 2)
    if len(coords) == 1:
        cv2.circle(out, (coords[0][0], coords[0][1]), max(0, thickness // 2), paint, -1, lineType=cv2.LINE_8)
    else:
        cv2.polylines(out, [pts], False, paint, thickness, lineType=cv2.LINE_8)
    return out


def _changed_spans(points, new_points, eps=1e-4):
    """Inclusive index spans of points that moved, expanded by one sample so joins stay covered."""
    if not points:
        return []
    if new_points is None or len(points) != len(new_points):
        return [(0, len(points) - 1)]
    changed = []
    for index, (left, right) in enumerate(zip(points, new_points)):
        if abs(float(left[0]) - float(right[0])) > eps or abs(float(left[1]) - float(right[1])) > eps:
            changed.append(index)
    if not changed:
        return []
    spans = []
    start = previous = changed[0]
    for index in changed[1:]:
        if index <= previous + 1:
            previous = index
            continue
        spans.append((start, previous))
        start = previous = index
    spans.append((start, previous))
    last = len(points) - 1
    return [(max(0, begin - 1), min(last, end + 1)) for begin, end in spans]


def _corridor(shape, polylines, radius):
    cv2, np = _deps()
    layer = np.zeros(shape, np.uint8)
    thickness = max(1, int(math.ceil(float(radius) * 2.0)))
    for poly in polylines:
        coords = [[int(round(float(point[0]))), int(round(float(point[1])))] for point in poly]
        if not coords:
            continue
        if len(coords) == 1:
            cv2.circle(layer, (coords[0][0], coords[0][1]), max(1, thickness // 2), 1, -1, lineType=cv2.LINE_8)
        else:
            pts = np.array(coords, dtype=np.int32).reshape(-1, 1, 2)
            cv2.polylines(layer, [pts], False, 1, thickness, lineType=cv2.LINE_8)
    return layer.astype(bool)


def _ink_and_structural_guard(array, color, tolerance, cv2, np):
    import paper_chart_dark_curve as dark
    ink = color_mask(array, color, tolerance)
    if not dark.is_neutral_dark_color(color):
        return ink, None
    struct = dark.structural_neutral_mask(array, cv2, np)
    return ink & (~struct), struct


def _apply_structural_guard(out, array, guard, soft=None, alpha=None):
    if guard is not None and bool(guard.any()):
        out[guard] = array[guard]
        if soft is not None and alpha is not None:
            soft[guard] = alpha[guard][:, None]
    return out


def edit_raster(image, points, new_points, color, width, tolerance=_TOLERANCE):
    """Restore the changed span of this curve, then paint its new samples.

    The mask is the selected polyline's corridor intersected with the color.
    Pixels outside that mask, including other strokes of the same color and the
    unmoved samples of this stroke, stay byte-identical.
    """
    cv2, np = _deps()
    array = _rgb(image)
    if _same_points(points, new_points):
        return array.copy()
    spans = _changed_spans(points, new_points)
    if not spans:
        return array.copy()
    ink, guard = _ink_and_structural_guard(array, color, tolerance, cv2, np)
    pieces = [points[begin:end + 1] for begin, end in spans if end >= begin]
    mask = _corridor(array.shape[:2], pieces, max(1.0, float(width) * 0.5 + 2.0)) & ink
    base = restore_under_mask(array, mask)
    if new_points is None:
        return _apply_structural_guard(base, array, guard)
    if len(points) != len(new_points):
        return _apply_structural_guard(paint_polyline(base, new_points, color, width), array, guard)
    out = base
    for begin, end in spans:
        out = paint_polyline(out, new_points[begin:end + 1], color, width)
    return _apply_structural_guard(out, array, guard)


def _same_points(points, new_points, eps=1e-4):
    if new_points is None or len(points) != len(new_points):
        return False
    for left, right in zip(points, new_points):
        if abs(float(left[0]) - float(right[0])) > eps or abs(float(left[1]) - float(right[1])) > eps:
            return False
    return True


def edit_batch(image, edits, alpha=None):
    """Clear all changed source corridors before drawing any destination stroke."""
    cv2, np = _deps()
    array = _rgb(image)
    masks, paints = {}, []
    for points, current, color, width in edits:
        if _same_points(points, current):
            continue
        spans = _changed_spans(points, current)
        radius = max(1.0, float(width) * .5 + 2)
        corridor = _batch_corridor(array.shape[:2], points, spans, radius, current is not None)
        key = tuple(color)
        masks[key] = masks.get(key, np.zeros(array.shape[:2], dtype=bool)) | corridor
        if current is not None:
            ranges = spans if len(points) == len(current) else [(0, len(current) - 1)]
            paints.extend((current[a:b + 1], color, width) for a, b in ranges)
    cleared = np.zeros(array.shape[:2], dtype=bool)
    combined_guard = np.zeros(array.shape[:2], dtype=bool)
    opacity = {}
    for color, corridor in masks.items():
        ink, guard = _ink_and_structural_guard(array, color, _TOLERANCE, cv2, np)
        cleared |= corridor & ink
        if guard is not None:
            combined_guard |= guard
        if alpha is not None:
            samples = alpha[ink & (alpha > 0)]
            opacity[color] = int(np.median(samples)) if samples.size else 255
    out = restore_under_mask(array, cleared)
    soft = None if alpha is None else restore_under_mask(np.repeat(alpha[:, :, None], 3, axis=2), cleared)
    for points, color, width in paints:
        out = paint_polyline(out, points, color, width)
        if soft is not None:
            soft = paint_polyline(soft, points, (opacity[tuple(color)],) * 3, width)
    _apply_structural_guard(out, array, combined_guard, soft=soft, alpha=alpha)
    return out if soft is None else (out, soft[:, :, 0].copy())


def _trim_cap(mask, point, inside, radius):
    """An erasure's extra clearance must not eat the unchanged line past a join."""
    _, np = _deps()
    x, y = point
    x0, y0 = max(0, int(x - radius - 1)), max(0, int(y - radius - 1))
    x1, y1 = min(mask.shape[1], int(x + radius + 2)), min(mask.shape[0], int(y + radius + 2))
    if x1 <= x0 or y1 <= y0:
        return
    yy, xx = np.ogrid[y0:y1, x0:x1]
    behind = (xx - x) * (inside[0] - x) + (yy - y) * (inside[1] - y) < 0
    mask[y0:y1, x0:x1][behind] = False


def _batch_corridor(shape, points, spans, radius, trim):
    _, np = _deps()
    mask = np.zeros(shape, dtype=bool)
    for a, b in spans:
        piece = _corridor(shape, [points[a:b + 1]], radius)
        if trim and b > a:
            if a > 0:
                _trim_cap(piece, points[a], points[a + 1], radius)
            if b < len(points) - 1:
                _trim_cap(piece, points[b], points[b - 1], radius)
        mask |= piece
    return mask


def _colors(image):
    cv2, np = _deps()
    array = _rgb(image)
    chroma = array.max(axis=2).astype(np.int16) - array.min(axis=2).astype(np.int16)
    bright = array.max(axis=2) > 80
    selected = (chroma > 40) & bright
    if not np.any(selected):
        return []
    quantized = (array // 16) * 16
    flat = quantized.reshape(-1, 3)
    chosen = selected.reshape(-1)
    buckets = {}
    for pixel in flat[chosen]:
        key = (int(pixel[0]), int(pixel[1]), int(pixel[2]))
        buckets[key] = buckets.get(key, 0) + 1
    found = []
    hues = []
    for key, count in sorted(buckets.items(), key=lambda item: -item[1]):
        if count < _MIN_PIXELS:
            continue
        members = array[selected & np.all(quantized == np.array(key, dtype=np.uint8), axis=2)]
        median = np.median(members.reshape(-1, 3), axis=0)
        nearest = int(np.argmin(np.max(np.abs(members.astype(np.float32)-median), axis=1)))
        color = tuple(int(channel) for channel in members[nearest])
        hue = int(cv2.cvtColor(np.uint8([[color]]), cv2.COLOR_RGB2HSV)[0, 0, 0])
        # Reuse the chart geometry palette rule: antialias shades of one ink
        # must not each trigger a separate full tracing run. Keep source RGB.
        if any(min(abs(hue-old), 180-abs(hue-old)) < 9 for old in hues):
            continue
        hues.append(hue)
        found.append(color)
    return found


def _tracer():
    global _CORE
    if _CORE is None:
        try:
            from paper_plottracer import Core
        except ImportError:
            raise ValueError('dependency-unavailable') from None
        _CORE = Core()
    return _CORE


def _dedupe(points):
    kept = []
    for point in points:
        x, y = float(point[0]), float(point[1])
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        if kept and math.hypot(x - kept[-1][0], y - kept[-1][1]) < 0.35:
            continue
        kept.append((x, y))
    return kept


def _stroke_width(mask, points):
    """Median diameter of this color mask at the traced centreline. Not a second tracer."""
    cv2, np = _deps()
    dist = cv2.distanceTransform(np.asarray(mask, dtype=np.uint8), cv2.DIST_L2, 3)
    height, width = mask.shape
    samples = []
    for x, y in points:
        xi, yi = int(round(x)), int(round(y))
        best = 0.0
        for yy in range(yi - 1, yi + 2):
            for xx in range(xi - 1, xi + 2):
                if 0 <= xx < width and 0 <= yy < height:
                    best = max(best, float(dist[yy, xx]))
        if best > 0:
            samples.append(best * 2.0)
    if not samples:
        return 1.0
    samples.sort()
    # LINE_8 paints 2*r+1 pixel support for a non-hairline stroke. Convert the
    # measured support back to its even thickness rather than adding it twice.
    return float(max(1, 2 * int(samples[len(samples) // 2] / 2)))


def _trace_color(array, color, window, tolerance, *, custom_ink=None):
    cv2, np = _deps()
    height, width = array.shape[:2]
    ink = (custom_ink if custom_ink is not None else color_mask(array, color, tolerance)) & window
    if int(ink.sum()) < _MIN_PIXELS:
        return []
    # Trace only the selected image window, at a bounded working resolution.
    # The source-resolution samples stay intact for export; map centres back.
    ys, xs = np.where(window)
    if not len(xs):
        return []
    x0, x1 = max(0, int(xs.min())-2), min(width, int(xs.max())+3)
    y0, y1 = max(0, int(ys.min())-2), min(height, int(ys.max())+3)
    local = np.full_like(array[y0:y1, x0:x1], 255)
    # Exclude achromatic grids/text, retaining the source ink's pale edge mixes.
    # Passing a strict RGB-only binary mask here used to shatter thin lines.
    local[ink[y0:y1, x0:x1]] = color
    local_h, local_w = local.shape[:2]
    scale = min(1.0, 1200.0/max(local_w, local_h))
    tw, th = max(1, round(local_w*scale)), max(1, round(local_h*scale))
    if scale < 1:
        local = cv2.resize(local, (tw, th), interpolation=cv2.INTER_AREA)
    rgba = np.concatenate([local, np.full((th, tw, 1), 255, np.uint8)], axis=2)
    region = {'x': -8, 'y': -8, 'width': tw + 16, 'height': th + 16, 'route': 'edit-network'}
    traced = _tracer().trace(rgba.tobytes(), tw, th, [{'id': 'series', 'rgb': list(color)}], region, True)
    series = (traced.get('series') or [{}])[0]
    found = []
    for line in series.get('lines') or []:
        points = _dedupe(line.get('points') or [])
        if points:
            points[-1] = tuple(line['points'][-1])
        # A gap already bridged confidently by findLines is one editing curve.
        for run in [points]:
            if len(run) >= 2:
                found.append({'points': [((x+.5)*local_w/tw-.5+x0, (y+.5)*local_h/th-.5+y0) for x,y in run],
                              'nodes': line.get('nodes', [None, None]), 'endKinds': line.get('endKinds', [None, None])})
    return found


def _append_traced_color(series, array, color, window, tolerance, bounds, ink, custom_ink=None):
    x0, y0, x1, y1 = bounds
    for edge in _trace_color(array, color, window, tolerance, custom_ink=custom_ink):
        points = edge['points']
        kept = [point for point in points if x0 - 1 <= point[0] <= x1 + 1 and y0 - 1 <= point[1] <= y1 + 1]
        if len(kept) < 2:
            continue
        series.append({
            'color': color,
            'width': _stroke_width(ink, kept),
            'points': kept,
            'branch': 'b%d' % len(series),
            'pixels': int(ink.sum()),
            'nodes': edge['nodes'],
            'endKinds': edge['endKinds'],
        })


def trace_series(image, plot_bbox=None, tolerance=_TOLERANCE):
    """Source-bound graph edges; junction identities keep their editing connected."""
    cv2, np = _deps()
    import paper_chart_dark_curve as dark
    array = _rgb(image)
    height, width = array.shape[:2]
    x0, y0, x1, y1 = (0, 0, width, height) if not plot_bbox else [int(v) for v in plot_bbox]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    window = np.zeros((height, width), dtype=bool)
    window[y0:y1, x0:x1] = True
    bounds = (x0, y0, x1, y1)
    series = []
    chromatic = _colors(array[y0:y1, x0:x1])
    for color in chromatic:
        ink = np.max(np.abs(array.astype(np.int16) - np.array(color, np.int16)), axis=2) <= tolerance
        _append_traced_color(series, array, color, window, tolerance, bounds, ink)
    found_dark = dark.extract_dark_neutral_curve(array, window, chromatic, _MIN_PIXELS, cv2, np)
    if found_dark is not None:
        dark_color, dark_mask = found_dark
        _append_traced_color(series, array, dark_color, window, tolerance, bounds, dark_mask, custom_ink=dark_mask)
    return series

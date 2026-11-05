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
invent a second tracer. Gaps come back as separate series with an explicit
branch id, and the samples stay dense enough for an interior bump.

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
    """True where every channel is within tolerance of color. The input is not modified."""
    cv2, np = _deps()
    array = _rgb(image)
    target = np.array([int(color[0]), int(color[1]), int(color[2])], dtype=np.int16)
    delta = np.max(np.abs(array.astype(np.int16) - target), axis=2)
    return delta <= int(tolerance)


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


def _changed_spans(points, new_points, eps=0.2):
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
    ink = color_mask(array, color, tolerance)
    pieces = [points[begin:end + 1] for begin, end in spans if end >= begin]
    mask = _corridor(array.shape[:2], pieces, max(1.0, float(width) * 0.5 + 2.0)) & ink
    base = restore_under_mask(array, mask)
    if new_points is None:
        return base
    if len(points) != len(new_points):
        return paint_polyline(base, new_points, color, width)
    out = base
    for begin, end in spans:
        out = paint_polyline(out, new_points[begin:end + 1], color, width)
    return out


def _same_points(points, new_points, eps=1e-4):
    if new_points is None or len(points) != len(new_points):
        return False
    for left, right in zip(points, new_points):
        if abs(float(left[0]) - float(right[0])) > eps or abs(float(left[1]) - float(right[1])) > eps:
            return False
    return True


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


def _near(point, other, tol=1.5):
    return abs(float(point[0]) - float(other[0])) <= tol and abs(float(point[1]) - float(other[1])) <= tol


def _split_gaps(points, gaps):
    """Split one traced line at the gaps PlotTracer already recorded."""
    if len(points) < 2:
        return []
    cuts = []
    for gap in gaps or []:
        if not isinstance(gap, (list, tuple)) or len(gap) < 2:
            continue
        left, right = gap[0], gap[1]
        for index in range(len(points) - 1):
            if _near(points[index], left) and _near(points[index + 1], right):
                cuts.append(index + 1)
    runs = []
    start = 0
    for cut in sorted(set(cuts)):
        if cut - start >= 2:
            runs.append(points[start:cut])
        start = cut
    if len(points) - start >= 2:
        runs.append(points[start:])
    return runs


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
    return max(1.0, samples[len(samples) // 2])


def _trace_color(array, color, window, tolerance):
    cv2, np = _deps()
    height, width = array.shape[:2]
    ink = color_mask(array, color, tolerance) & window
    if int(ink.sum()) < _MIN_PIXELS:
        return []
    # Trace only the selected image window, at a bounded working resolution.
    # The source-resolution samples stay intact for export; map centres back.
    ys, xs = np.where(window)
    if not len(xs):
        return []
    x0, x1 = max(0, int(xs.min())-2), min(width, int(xs.max())+3)
    y0, y1 = max(0, int(ys.min())-2), min(height, int(ys.max())+3)
    local = ink[y0:y1, x0:x1]
    local_h, local_w = local.shape
    scale = min(1.0, 1200.0/max(local_w, local_h))
    tw, th = max(1, round(local_w*scale)), max(1, round(local_h*scale))
    if scale < 1:
        local = cv2.resize(local.astype(np.float32), (tw, th), interpolation=cv2.INTER_AREA) > .2
    isolated = np.full((th, tw, 3), 255, dtype=np.uint8)
    isolated[local] = color
    rgba = np.concatenate([isolated, np.full((th, tw, 1), 255, np.uint8)], axis=2)
    region = {'x': -8, 'y': -8, 'width': tw + 16, 'height': th + 16}
    traced = _tracer().trace(rgba.tobytes(), tw, th, [{'id': 'series', 'rgb': list(color)}], region, True)
    series = (traced.get('series') or [{}])[0]
    found = []
    for line in series.get('lines') or []:
        points = _dedupe(line.get('points') or [])
        for run in _split_gaps(points, line.get('gaps')):
            if len(run) >= 2:
                found.append([((x+.5)*local_w/tw-.5+x0, (y+.5)*local_h/th-.5+y0) for x,y in run])
    return found


def trace_series(image, plot_bbox=None, tolerance=_TOLERANCE):
    """One dense polyline per PlotTracer line. Same-color branches stay separate."""
    cv2, np = _deps()
    array = _rgb(image)
    height, width = array.shape[:2]
    x0, y0, x1, y1 = (0, 0, width, height) if not plot_bbox else [int(v) for v in plot_bbox]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    window = np.zeros((height, width), dtype=bool)
    window[y0:y1, x0:x1] = True
    series = []
    for color in _colors(array[y0:y1, x0:x1]):
        ink = color_mask(array, color, tolerance)
        for points in _trace_color(array, color, window, tolerance):
            kept = [point for point in points if x0 - 1 <= point[0] <= x1 + 1 and y0 - 1 <= point[1] <= y1 + 1]
            if len(kept) < 2:
                continue
            series.append({
                'color': color,
                'width': _stroke_width(ink, kept),
                'points': kept,
                'branch': 'b%d' % len(series),
                'pixels': int(ink.sum()),
            })
    return series

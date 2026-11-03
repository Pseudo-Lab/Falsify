"""Sample one observed chart trace in local ROI pixels.

``sample_trace`` keeps original column records. It never interpolates a new y
and never connects columns across a missing x. Axis calibration, including
log scales, stays with the caller.

``segments`` are inclusive ``[start, end]`` index pairs into ``points``. Each
pair is one gap-free observed run. Draw ``points[start]`` through
``points[end]`` and do not join one pair to the next.

``maxDeviationPixels`` is the largest perpendicular pixel distance from an
observed column to the polyline of kept points in the same run. When that
error exceeds ``tolerance_px`` by more than 0.001, or a run cannot keep any
point inside ``max_points``, ``issues`` contains ``sampling-point-limit``.
"""

import math

_MEASURE_SLACK = 1e-3
_REPAIR_SLACK = 1e-4


def sample_trace(columns, *, x_ticks=(), max_points=256, tolerance_px=0.75):
    """Return source-backed points for one trace.

    Parameters
    ----------
    columns:
        Observed records for a single trace, each with ``x``, ``y``, ``low``
        and ``high`` in local ROI pixels. One record is one source column.
    x_ticks:
        Tick x positions in the same pixel space. Each tick keeps the nearest
        observed column when the point budget still has room after the
        tolerance-limited shape.
    max_points:
        Caller-supplied budget for this trace.
    tolerance_px:
        Perpendicular pixel tolerance for noncritical points.
    """
    import cv2 as cv
    import numpy as np

    records = _sorted_records(columns)
    limit = max(0, int(max_points))
    tolerance = max(0.0, float(tolerance_px))
    if not records or limit == 0:
        deviation = _omission_extent(records) if records else 0.0
        issues = ['sampling-point-limit'] if records else []
        return _result([], [], issues, deviation)
    spans = _spans(records)
    chosen = _fit(records, spans, tolerance, limit, cv, np)
    if chosen is None:
        chosen = _subsample_endpoints(spans, limit)
    kept = set(chosen)
    _repair(records, spans, kept, tolerance, limit)
    for anchor in _anchors(records, x_ticks):
        if anchor in kept:
            continue
        if len(kept) >= limit:
            break
        kept.add(anchor)
    order = sorted(kept)
    if len(order) > limit:
        order = _even_subset(order, limit)
        kept = set(order)
    deviation, _ = _max_deviation(records, spans, kept)
    uncovered = any(all(index not in kept for index in range(start, end + 1)) for start, end in spans)
    issues = ['sampling-point-limit'] if uncovered or deviation > tolerance + _MEASURE_SLACK else []
    return _result([records[index] for index in order], _segment_ranges(order, spans), issues, deviation)


def _result(points, segments, issues, deviation):
    return {
        'points': points,
        'segments': segments,
        'issues': issues,
        'maxDeviationPixels': float(deviation),
    }


def _sorted_records(columns):
    paired = list(enumerate(columns))
    paired.sort(key=lambda item: (float(item[1]['x']), item[0]))
    return [item[1] for item in paired]


def _spans(records):
    start = 0
    spans = []
    for index in range(1, len(records)):
        if float(records[index]['x']) - float(records[index - 1]['x']) > 1.0:
            spans.append((start, index - 1))
            start = index
    spans.append((start, len(records) - 1))
    return spans


def _anchors(records, ticks):
    if not records:
        return []
    xs = [float(record['x']) for record in records]
    found = []
    seen = set()
    for tick in ticks:
        target = float(tick)
        best = min(range(len(xs)), key=lambda index: (abs(xs[index] - target), index))
        if best not in seen:
            seen.add(best)
            found.append(best)
    return found


def _fit(records, spans, tolerance, limit, cv, np):
    endpoints = 0
    upper = tolerance
    for start, end in spans:
        endpoints += 1 if start == end else 2
        upper = max(upper, _chord_deviation(records, start, end))
    if endpoints > limit:
        return None
    initial = _dp_all(records, spans, tolerance, cv, np)
    if len(initial) <= limit:
        return initial
    upper = max(upper, tolerance) + 1.0
    best = None
    for _ in range(12):
        rough = _dp_all(records, spans, upper, cv, np)
        if len(rough) <= limit:
            best = rough
            break
        upper *= 2.0
    if best is None:
        return None
    lower = tolerance
    for _ in range(32):
        mid = (lower + upper) / 2.0
        got = _dp_all(records, spans, mid, cv, np)
        if len(got) <= limit:
            best = got
            upper = mid
        else:
            lower = mid
    return best


def _dp_all(records, spans, epsilon, cv, np):
    chosen = []
    for start, end in spans:
        local = _simplify_indices(records[start:end + 1], epsilon, cv, np)
        chosen.extend(start + offset for offset in local)
    return chosen


def _simplify_indices(points, epsilon, cv, np):
    count = len(points)
    if count <= 2:
        return list(range(count))
    contour = np.asarray([[[float(point['x']), float(point['y'])]] for point in points], dtype=np.float32)
    approx = cv.approxPolyDP(contour, float(max(epsilon, 0.0)), False).reshape(-1, 2)
    chosen = []
    cursor = 0
    for raw_x, raw_y in approx:
        best = None
        best_distance = None
        for index in range(cursor, count):
            dx = float(points[index]['x']) - float(raw_x)
            dy = float(points[index]['y']) - float(raw_y)
            distance = dx * dx + dy * dy
            if best is None or distance < best_distance:
                best = index
                best_distance = distance
        if best is None:
            break
        chosen.append(best)
        cursor = best + 1
    if not chosen or chosen[0] != 0:
        chosen.insert(0, 0)
    if chosen[-1] != count - 1:
        chosen.append(count - 1)
    deduped = []
    for index in chosen:
        if not deduped or deduped[-1] != index:
            deduped.append(index)
    return deduped


def _repair(records, spans, kept, tolerance, limit):
    while len(kept) < limit:
        deviation, index = _max_deviation(records, spans, kept)
        if index is None or index in kept or deviation <= tolerance + _REPAIR_SLACK:
            break
        kept.add(index)


def _subsample_endpoints(spans, limit):
    endpoints = []
    for start, end in spans:
        endpoints.append(start)
        if end != start:
            endpoints.append(end)
    return _even_subset(endpoints, limit)


def _even_subset(indices, limit):
    if limit <= 0 or not indices:
        return []
    if len(indices) <= limit:
        return list(indices)
    if limit == 1:
        return [indices[0]]
    last = len(indices) - 1
    picked = []
    seen = set()
    for step in range(limit):
        index = indices[int(round(step * last / (limit - 1)))]
        if index not in seen:
            seen.add(index)
            picked.append(index)
    return picked


def _segment_ranges(order, spans):
    if not order:
        return []
    span_of = {}
    for span_index, (start, end) in enumerate(spans):
        for index in range(start, end + 1):
            span_of[index] = span_index
    ranges = []
    run_start = 0
    current = span_of[order[0]]
    for position, index in enumerate(order):
        span_index = span_of[index]
        if span_index != current:
            ranges.append([run_start, position - 1])
            run_start = position
            current = span_index
    ranges.append([run_start, len(order) - 1])
    return ranges


def _omission_extent(records):
    if len(records) <= 1:
        return 0.0
    return max(_euclid(records[index], records[0]) for index in range(len(records)))


def _chord_deviation(records, start, end):
    if end - start < 2:
        return 0.0
    return max(_perp(records[index], records[start], records[end]) for index in range(start + 1, end))


def _max_deviation(records, spans, kept):
    worst = 0.0
    worst_index = None
    for start, end in spans:
        chosen = [index for index in range(start, end + 1) if index in kept]
        if not chosen:
            for index in range(start, end + 1):
                distance = _euclid(records[index], records[start])
                if distance > worst:
                    worst = distance
                    worst_index = index
            continue
        for index in range(start, end + 1):
            if index in kept:
                continue
            distance = _distance_to_polyline(records, index, chosen)
            if distance > worst:
                worst = distance
                worst_index = index
    return worst, worst_index


def _distance_to_polyline(records, index, chosen):
    left = None
    right = None
    for key in chosen:
        if key <= index:
            left = key
        elif right is None:
            right = key
    if left is not None and right is not None:
        return _perp(records[index], records[left], records[right])
    anchor = left if left is not None else right
    if anchor is None or anchor == index:
        return 0.0
    return _euclid(records[index], records[anchor])


def _perp(point, start, end):
    ax, ay = float(start['x']), float(start['y'])
    bx, by = float(end['x']), float(end['y'])
    px, py = float(point['x']), float(point['y'])
    dx, dy = bx - ax, by - ay
    span = math.hypot(dx, dy)
    if span == 0.0:
        return math.hypot(px - ax, py - ay)
    return abs(dx * (py - ay) - dy * (px - ax)) / span


def _euclid(left, right):
    return math.hypot(float(left['x']) - float(right['x']), float(left['y']) - float(right['y']))

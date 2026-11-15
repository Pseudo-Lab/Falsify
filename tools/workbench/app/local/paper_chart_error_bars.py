"""Detect vertical and horizontal confidence-interval error bars on chart images."""


def _foreground_roi_mask(image, frame, ocr_lines, np):
    left, top, right, bottom = frame
    roi = image[top + 2:bottom - 1, left + 2:right - 1]
    fg = roi.min(axis=2) < 205
    fg[(fg.sum(axis=1) > (right - left) * 0.55), :] = False
    fg[:, (fg.sum(axis=0) > (bottom - top) * 0.55)] = False
    _mask_ocr_regions(fg, frame, ocr_lines)
    return fg


def _mask_ocr_regions(mask, frame, ocr_lines):
    left, top, right, bottom = frame
    roi_h, roi_w = mask.shape
    for line in ocr_lines or ():
        box = line.get('bbox') if isinstance(line, dict) else None
        if not isinstance(box, list) or len(box) != 4:
            continue
        x0, y0, x1, y1 = [int(v) for v in box]
        if x1 <= left or x0 >= right or y1 <= top or y0 >= bottom:
            continue
        ry0 = max(0, y0 - top - 3)
        ry1 = min(roi_h, y1 - top + 1)
        rx0 = max(0, x0 - left - 3)
        rx1 = min(roi_w, x1 - left + 1)
        mask[ry0:ry1, rx0:rx1] = False


def _horizontal_run_widths(fg, np):
    h, w = fg.shape
    widths = np.zeros((h, w), dtype=np.int32)
    for r in range(h):
        row = fg[r]
        if not row.any():
            continue
        edges = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
        starts = np.flatnonzero(edges == 1)
        ends = np.flatnonzero(edges == -1)
        for s, e in zip(starts, ends):
            widths[r, s:e] = e - s
    return widths


def _cluster_peak_columns(col_scores, max_gap=2):
    active = [i for i, v in enumerate(col_scores) if v >= 8]
    if not active:
        return []
    clusters = [[active[0]]]
    for c in active[1:]:
        if c - clusters[-1][-1] <= max_gap:
            clusters[-1].append(c)
        else:
            clusters.append([c])
    peaks = []
    n = len(col_scores)
    for cluster in clusters:
        best = max(cluster, key=lambda c: col_scores[c])
        flank_lo = max(col_scores[max(0, cluster[0] - 6):cluster[0]], default=0)
        flank_hi = max(col_scores[min(n, cluster[-1] + 1):min(n, cluster[-1] + 7)], default=0)
        if len(cluster) <= 7 or col_scores[best] >= max(flank_lo, flank_hi) + 12:
            peaks.append(best)
    return peaks


def _contiguous_segments(flags, max_gap=10):
    segs = []
    start = None
    last = None
    for idx, val in enumerate(flags):
        if val:
            if start is None:
                start = idx
            last = idx
        elif start is not None and idx - last > max_gap:
            segs.append((start, last))
            start = None
    if start is not None:
        segs.append((start, last))
    return segs


def _cap_bounds(fg, widths, col, r0, r1, h, w):
    top = r0
    has_top_cap = False
    for r in range(max(0, r0 - 3), min(h, r0 + 4)):
        if fg[r, max(0, col - 2):min(w, col + 3)].any() and 5 <= widths[r, max(0, col - 2):min(w, col + 3)].max() <= 28:
            top = min(top, r)
            has_top_cap = True
    bot = r1
    has_bot_cap = False
    for r in range(max(0, r1 - 3), min(h, r1 + 4)):
        if fg[r, max(0, col - 2):min(w, col + 3)].any() and 5 <= widths[r, max(0, col - 2):min(w, col + 3)].max() <= 28:
            bot = max(bot, r)
            has_bot_cap = True
    return top, bot, has_top_cap, has_bot_cap


def _stem_vertically_isolated(fg, col, r0, r1, w):
    inner0, inner1 = r0 + 3, r1 - 2
    if inner1 <= inner0:
        return False
    isolated = 0
    total = inner1 - inner0
    left_lo, left_hi = max(0, col - 6), max(0, col - 2)
    right_lo, right_hi = min(w, col + 3), min(w, col + 7)
    for r in range(inner0, inner1):
        has_flank = bool(fg[r, left_lo:left_hi].any()) or bool(fg[r, right_lo:right_hi].any())
        if not has_flank:
            isolated += 1
    return isolated >= max(4, int(total * 0.5))


def _extract_whisker_from_seg(fg, narrow, widths, col, r0, r1, h, w):
    span = r1 - r0 + 1
    if span < 10 or span >= int(h * 0.65):
        return None
    c0, c1 = max(0, col - 1), min(w, col + 2)
    narrow_rows = int(narrow[r0:r1 + 1, c0:c1].any(axis=1).sum())
    if narrow_rows < max(8, int(span * 0.5)):
        return None
    if not _stem_vertically_isolated(fg, col, r0, r1, w):
        return None
    top, bot, has_top_cap, has_bot_cap = _cap_bounds(fg, widths, col, r0, r1, h, w)
    if not (has_top_cap or has_bot_cap) and narrow_rows < 14:
        return None
    w_band = widths[r0:r1 + 1, c0:c1]
    max_local_w = int(w_band.max()) if w_band.size else 0
    if max_local_w > 28:
        return None
    return (col, top, bot, has_top_cap or has_bot_cap)


def _find_axis_whiskers(fg, origin_x, origin_y, np, *, horizontal=False):
    work = fg.T if horizontal else fg
    h, w = work.shape
    widths = _horizontal_run_widths(work, np)
    narrow = work & (widths >= 1) & (widths <= 5)
    col_scores = [int(narrow[:, c].sum()) for c in range(w)]
    bars = []
    for col in _cluster_peak_columns(col_scores):
        c0, c1 = max(0, col - 1), min(w, col + 2)
        col_flags = narrow[:, c0:c1].any(axis=1).tolist()
        for r0, r1 in _contiguous_segments(col_flags):
            found = _extract_whisker_from_seg(work, narrow, widths, col, r0, r1, h, w)
            if found is None:
                continue
            c_idx, top, bot, capped = found
            bars.append(_build_whisker_record(c_idx, top, bot, capped, origin_x, origin_y, horizontal))
    return bars


def _build_whisker_record(pos, start, end, capped, origin_x, origin_y, horizontal):
    if horizontal:
        return {
            'orientation': 'horizontal',
            'xPixel': float(origin_x + (start + end) * 0.5),
            'yPixel': float(origin_y + pos),
            'pixelLower': float(origin_x + start),
            'pixelUpper': float(origin_x + end),
            'capped': bool(capped),
        }
    return {
        'orientation': 'vertical',
        'xPixel': float(origin_x + pos),
        'yPixel': float(origin_y + (start + end) * 0.5),
        'pixelLower': float(origin_y + end),
        'pixelUpper': float(origin_y + start),
        'capped': bool(capped),
    }


def detect_error_bars(image, frame, ocr_lines, np):
    """Detect vertical and horizontal CI error bars inside the plot frame."""
    if image is None or frame is None:
        return []
    fg = _foreground_roi_mask(image, frame, ocr_lines, np)
    origin_x, origin_y = frame[0] + 2, frame[1] + 2
    vertical = _find_axis_whiskers(fg, origin_x, origin_y, np, horizontal=False)
    horizontal = _find_axis_whiskers(fg, origin_x, origin_y, np, horizontal=True)
    return vertical + horizontal


def build_whisker_exclusion_mask(image, frame, error_bars, np):
    """Return boolean ROI mask True where pure whisker stems/caps should not skew traces."""
    left, top, right, bottom = frame
    roi_h, roi_w = max(0, (bottom - 1) - (top + 2)), max(0, (right - 1) - (left + 2))
    excl = np.zeros((roi_h, roi_w), dtype=bool)
    if not error_bars or roi_h <= 0 or roi_w <= 0:
        return excl
    fg = image[top + 2:bottom - 1, left + 2:right - 1].min(axis=2) < 205
    widths = _horizontal_run_widths(fg, np)
    origin_x, origin_y = left + 2, top + 2
    for bar in error_bars:
        if bar.get('orientation') != 'vertical':
            continue
        col = int(round(bar['xPixel'] - origin_x))
        r0 = max(0, int(round(bar['pixelUpper'] - origin_y)))
        r1 = min(roi_h - 1, int(round(bar['pixelLower'] - origin_y)))
        _mark_vertical_whisker_excl(excl, fg, widths, col, r0, r1, roi_w)
    return excl


def _mark_vertical_whisker_excl(excl, fg, widths, col, r0, r1, roi_w):
    for r in range(r0, r1 + 1):
        has_left = col >= 4 and bool(fg[r, max(0, col - 5):max(0, col - 2)].any())
        has_right = col + 4 < roi_w and bool(fg[r, min(roi_w, col + 3):min(roi_w, col + 6)].any())
        is_cap = r <= r0 + 2 or r >= r1 - 2
        if is_cap and widths[r, max(0, col)] <= 28:
            excl[r, max(0, col - 10):min(roi_w, col + 11)] = True
        elif not (has_left and has_right) and widths[r, max(0, col)] <= 5:
            excl[r, max(0, col - 3):min(roi_w, col + 4)] = True


def _match_point_for_bar(bar, series_list, frame_span, max_x_dist=14):
    best = None
    best_dist = None
    tol = max(max_x_dist, int(frame_span * 0.04))
    for series in series_list or []:
        for pt in series.get('points', []):
            dist = _bar_point_distance(bar, pt, tol)
            if dist is None:
                continue
            if best_dist is None or dist < best_dist:
                best_dist = dist
                best = (series, pt)
    return best


def _bar_point_distance(bar, pt, tol):
    px, py = pt.get('xPixel'), pt.get('yPixel')
    if px is None or py is None:
        return None
    if bar['orientation'] == 'vertical':
        dx = abs(float(px) - bar['xPixel'])
        if dx > tol:
            return None
        if float(py) < bar['pixelUpper'] - 8 or float(py) > bar['pixelLower'] + 8:
            return None
        return dx + abs(float(py) - bar['yPixel']) * 0.1
    dy = abs(float(py) - bar['yPixel'])
    if dy > tol:
        return None
    if float(px) < bar['pixelLower'] - 8 or float(px) > bar['pixelUpper'] + 8:
        return None
    return dy + abs(float(px) - bar['xPixel']) * 0.1


def _calibrate_bar_bounds(bar, axes, axis_value, binding):
    if bar['orientation'] == 'vertical':
        side = binding if binding in axes else ('left' if 'left' in axes else ('right' if 'right' in axes else None))
    else:
        side = 'x' if 'x' in axes else None
    if not side:
        return None, None
    v_a = axis_value(axes[side], bar['pixelUpper'])
    v_b = axis_value(axes[side], bar['pixelLower'])
    return min(v_a, v_b), max(v_a, v_b)


def attach_error_bars(result, axes, axis_value, error_bars):
    """Pair detected error bars with points and attach ciBounds + geometry['errorBars']."""
    if not error_bars:
        return
    frame = result.get('plotBbox') or [0, 0, 100, 100]
    span = max(1, frame[2] - frame[0])
    attached = []
    for bar in error_bars:
        match = _match_point_for_bar(bar, result.get('series'), span)
        binding = match[0].get('axisBinding') if match else None
        lo, hi = _calibrate_bar_bounds(bar, axes, axis_value, binding)
        entry = dict(bar)
        entry['lower'] = lo
        entry['upper'] = hi
        if match is not None:
            series, pt = match
            entry['seriesId'] = series.get('id')
            pt['ciBounds'] = {
                'orientation': bar['orientation'],
                'lower': lo,
                'upper': hi,
                'pixelLower': bar['pixelLower'],
                'pixelUpper': bar['pixelUpper'],
            }
        attached.append(entry)
    result['errorBars'] = attached

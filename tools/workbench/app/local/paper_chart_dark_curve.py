"""Separate dark-neutral interior curves from axes, gridlines, ticks, and text."""


def is_neutral_dark_color(color):
    """Return True when an RGB triplet represents black or dark-neutral ink."""
    if not color or len(color) < 3:
        return False
    r, g, b = int(color[0]), int(color[1]), int(color[2])
    return (max(r, g, b) - min(r, g, b)) <= 45 and max(r, g, b) <= 145


def neutral_dark_pixels(array, np):
    """Boolean mask of dark-neutral pixels (black, charcoal, dark gray)."""
    hi = array.max(axis=2).astype(np.int16)
    lo = array.min(axis=2).astype(np.int16)
    return ((hi - lo) <= 45) & (hi <= 145)


def dark_neutral_ink_mask(array, color, tolerance, np):
    """Match a dark-neutral target color and its dark anti-aliased edge pixels."""
    target = np.array([int(color[0]), int(color[1]), int(color[2])], dtype=np.int16)
    hi = array.max(axis=2).astype(np.int16)
    lo = array.min(axis=2).astype(np.int16)
    delta = np.max(np.abs(array.astype(np.int16) - target), axis=2)
    neutral = (hi - lo) <= 45
    return neutral & ((delta <= int(tolerance)) | (hi <= min(165, int(target.max()) + 45)))


def _longest_1d_runs(mask, axis, np):
    h, w = mask.shape
    lengths = []
    if axis == 1:
        for r in range(h):
            lengths.append(_row_max_run(mask[r], np))
    else:
        for c in range(w):
            lengths.append(_row_max_run(mask[:, c], np))
    return lengths


def _row_max_run(line, np):
    if not line.any():
        return 0
    edges = np.diff(np.concatenate(([0], line.astype(np.int8), [0])))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    return int((ends - starts).max()) if len(starts) else 0


def _long_axis_lines_mask(neutral, region, chroma_fg, cv2, np):
    y0, y1, x0, x1 = region
    roi_h, roi_w = max(1, y1 - y0), max(1, x1 - x0)
    sub = neutral[y0:y1, x0:x1]
    chr_sub = chroma_fg[y0:y1, x0:x1]
    # Bridge tiny gaps and colored-curve crossings when detecting straight axes/gridlines
    h_cross = (cv2.morphologyEx(sub.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((1, 31), np.uint8)) > 0) & chr_sub
    v_cross = (cv2.morphologyEx(sub.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((31, 1), np.uint8)) > 0) & chr_sub
    h_closed = cv2.morphologyEx((sub | h_cross).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((1, 5), np.uint8)) > 0
    v_closed = cv2.morphologyEx((sub | v_cross).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 1), np.uint8)) > 0
    h_runs = _longest_1d_runs(h_closed, 1, np)
    v_runs = _longest_1d_runs(v_closed, 0, np)
    h_mask = np.zeros_like(neutral, dtype=bool)
    v_mask = np.zeros_like(neutral, dtype=bool)
    min_h = max(24, int(roi_w * 0.48))
    min_v = max(24, int(roi_h * 0.48))
    h_rows = [r for r, length in enumerate(h_runs) if length >= min_h]
    v_cols = [c for c, length in enumerate(v_runs) if length >= min_v]
    for r in h_rows:
        h_mask[y0 + r, x0:x1] |= sub[r]
    for c in v_cols:
        v_mask[y0:y1, x0 + c] |= sub[:, c]
    return h_mask, v_mask, [y0 + r for r in h_rows], [x0 + c for c in v_cols]


def _margin_exclusion(shape, h_rows, v_cols, neutral, np):
    h, w = shape
    margin = np.zeros(shape, dtype=bool)
    if v_cols:
        left_ax = min(v_cols)
        if left_ax < int(w * 0.45):
            margin[:, :max(0, left_ax)] = True
        right_ax = max(v_cols)
        if right_ax > int(w * 0.6) and right_ax - left_ax > int(w * 0.3):
            margin[:, min(w, right_ax + 1):] = True
    if h_rows:
        top_ax = min(h_rows)
        if top_ax < int(h * 0.4) and len(h_rows) >= 2 and (max(h_rows) - top_ax) > int(h * 0.3):
            margin[:max(0, top_ax), :] = True
        bot_ax = max(h_rows)
        if bot_ax > int(h * 0.55):
            margin[min(h, bot_ax + 1):, :] = True
    return margin & neutral


def _tick_stubs_mask(neutral, axes_mask, h_rows, v_cols, cv2, np):
    h, w = neutral.shape
    band = min(20, max(9, int(min(h, w) * 0.04)))
    outer = band + 1
    near = np.zeros((h, w), dtype=bool)
    for r in h_rows:
        near[max(0, r - outer):min(h, r + outer + 1), :] = True
    for c in v_cols:
        near[:, max(0, c - outer):min(w, c + outer + 1)] = True
    # Ticks terminate strictly inside `band`, whereas curves cross through `outer`
    band_dark = (neutral & near) & (~axes_mask)
    edge_band = np.zeros((h, w), dtype=bool)
    for r in h_rows:
        for row in (r - outer, r + outer):
            if 0 <= row < h:
                edge_band[row, :] = True
    for c in v_cols:
        for col in (c - outer, c + outer):
            if 0 <= col < w:
                edge_band[:, col] = True
    nlabels, labels = cv2.connectedComponents(band_dark.astype(np.uint8), connectivity=8)
    touching_outside = set(int(v) for v in np.unique(labels[band_dark & edge_band]))
    stubs = np.zeros((h, w), dtype=bool)
    for k in range(1, nlabels):
        if k not in touching_outside:
            stubs[labels == k] = True
    return stubs


def _non_curve_component_mask(candidate, region_shape, cv2, np):
    roi_h, roi_w = region_shape
    nlabels, labels, stats, _ = cv2.connectedComponentsWithStats(candidate.astype(np.uint8), connectivity=8)
    rejected = np.zeros_like(candidate, dtype=bool)
    small_limit = max(18, int(min(roi_h, roi_w) * 0.055))
    solid_limit = max(36, int(max(roi_h, roi_w) * 0.16))
    for k in range(1, nlabels):
        bw = int(stats[k, cv2.CC_STAT_WIDTH])
        bh = int(stats[k, cv2.CC_STAT_HEIGHT])
        area = int(stats[k, cv2.CC_STAT_AREA])
        fill_ratio = area / max(1, bw * bh)
        is_glyph_or_speck = bw <= small_limit and bh <= small_limit
        is_solid_block = max(bw, bh) <= solid_limit and fill_ratio >= 0.60 and min(bw, bh) >= 6
        if is_glyph_or_speck or is_solid_block:
            rejected[labels == k] = True
    return rejected


def _restore_gridline_crossings(h_mask, v_mask, remaining, np):
    h, w = remaining.shape
    keep = np.zeros((h, w), dtype=bool)
    if bool(h_mask.any()):
        above = np.zeros((h, w), dtype=bool)
        below = np.zeros((h, w), dtype=bool)
        for dy in (1, 2, 3):
            for dx in range(-3, 4):
                _shift_or(above, remaining, dy, dx)
                _shift_or(below, remaining, -dy, dx)
        keep |= h_mask & above & below
    if bool(v_mask.any()):
        left = np.zeros((h, w), dtype=bool)
        right = np.zeros((h, w), dtype=bool)
        for dx in (1, 2, 3):
            for dy in range(-3, 4):
                _shift_or(left, remaining, dy, dx)
                _shift_or(right, remaining, dy, -dx)
        keep |= v_mask & left & right
    return keep


def _shift_or(dst, src, dy, dx):
    h, w = src.shape
    sy0, sy1 = max(0, -dy), h - max(0, dy)
    sx0, sx1 = max(0, -dx), w - max(0, dx)
    dy0, dy1 = max(0, dy), h - max(0, -dy)
    dx0, dx1 = max(0, dx), w - max(0, -dx)
    if sy1 > sy0 and sx1 > sx0:
        dst[dy0:dy1, dx0:dx1] |= src[sy0:sy1, sx0:sx1]


def structural_neutral_mask(array, cv2, np, plot_bbox=None):
    """Mask out dark-neutral axes, gridlines, ticks, margin text, glyphs, and solid blocks."""
    h, w = array.shape[:2]
    if plot_bbox:
        x0, y0, x1, y1 = [int(v) for v in plot_bbox]
        region = (max(0, y0), min(h, y1), max(0, x0), min(w, x1))
    else:
        region = (0, h, 0, w)
    neutral = neutral_dark_pixels(array, np)
    hi = array.max(axis=2).astype(np.int16)
    lo = array.min(axis=2).astype(np.int16)
    chroma_fg = ((hi - lo) > 45) & (lo < 220)
    h_mask, v_mask, h_rows, v_cols = _long_axis_lines_mask(neutral, region, chroma_fg, cv2, np)
    axes_mask = h_mask | v_mask
    margin = _margin_exclusion((h, w), h_rows, v_cols, neutral, np)
    ticks = _tick_stubs_mask(neutral, axes_mask, h_rows, v_cols, cv2, np)
    base_structural = axes_mask | margin | ticks
    remaining_before_bridge = neutral & (~base_structural)
    crossings = _restore_gridline_crossings(h_mask, v_mask, remaining_before_bridge, np)
    structural = (base_structural & (~crossings)) | margin | ticks
    remaining = neutral & (~structural)
    roi_h = max(1, region[1] - region[0])
    roi_w = max(1, region[3] - region[2])
    structural |= _non_curve_component_mask(remaining, (roi_h, roi_w), cv2, np)
    return structural


def extract_dark_neutral_curve(array, window, existing_colors, min_pixels, cv2, np):
    """Return (color, mask) for an interior dark-neutral continuous curve, or None."""
    y0, y1, x0, x1 = _window_bounds(window, np)
    if x1 <= x0 or y1 <= y0:
        return None
    structural = structural_neutral_mask(array, cv2, np, plot_bbox=(x0, y0, x1, y1))
    curve_mask = neutral_dark_pixels(array, np) & window & (~structural)
    if int(curve_mask.sum()) < min_pixels:
        return None
    ys, xs = np.where(curve_mask)
    if int(xs.max() - xs.min()) < max(24, int((x1 - x0) * 0.12)):
        return None
    median = np.median(array[curve_mask].reshape(-1, 3), axis=0)
    color = tuple(int(round(v)) for v in median)
    if any(max(abs(color[i] - c[i]) for i in range(3)) <= 24 for c in existing_colors):
        return None
    return color, curve_mask


def _window_bounds(window, np):
    ys, xs = np.where(window)
    if not len(xs):
        return 0, 0, 0, 0
    return int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1

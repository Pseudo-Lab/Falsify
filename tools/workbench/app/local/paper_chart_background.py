"""Remove colored chart ink without erasing visible grids or inventing missing ones."""


def ink_mask(image, mask):
    import numpy as np
    from paper_chart_raster_edit import _rgb
    array = _rgb(image)
    mask = np.asarray(mask, dtype=bool)
    if mask.shape != array.shape[:2]:
        raise ValueError('bad-mask')
    chroma = array.max(axis=2).astype(int) - array.min(axis=2)
    # Expanded cleanup corridors must leave already visible neutral paint intact.
    return mask & (chroma > 4)


def _axis_samples(array, mask, ys, xs, np):
    """Nearest original pixel beyond each masked run; independent of render scale."""
    width = mask.shape[1]
    index = np.arange(width, dtype=np.int32)[None, :]
    left = np.maximum.accumulate(np.where(mask, -1, index), axis=1)[ys, xs]
    right = np.minimum.accumulate(np.where(mask, width, index)[:, ::-1], axis=1)[:, ::-1][ys, xs]
    return ((array[ys, np.clip(left, 0, width - 1)], left >= 0),
            (array[ys, np.clip(right, 0, width - 1)], right < width))


def _neutral(pixels, np):
    return pixels.max(axis=-1).astype(int) - pixels.min(axis=-1) <= 4


def _pair(left, right, np):
    a, available_a = left
    b, available_b = right
    matching = np.abs(a.astype(int) - b.astype(int)).max(axis=1) <= 8
    # Pure white is plain background. Light grid AA and black axes are eligible.
    stroke = (a.max(axis=1) < 254) & (b.max(axis=1) < 254)
    return available_a & available_b & _neutral(a, np) & _neutral(b, np) & matching & stroke


def _plain_fill(array, mask, count, np):
    visible = array[(~mask) & _neutral(array, np)]
    background = np.median(visible, axis=0).round().astype(np.uint8) if visible.size else np.uint8([255, 255, 255])
    return np.tile(background, (count, 1))


def restore_background(image, mask):
    """Keep visible neutral pixels; connect hidden strokes only with bilateral evidence.

    Every observation is from the immutable input. No grid spacing or axis model is
    inferred, and unmasked gaps stay untouched. A one-sided stroke is not extended.
    """
    import numpy as np
    from paper_chart_raster_edit import _rgb
    array = _rgb(image)
    mask = ink_mask(array, mask)
    out = array.copy()
    ys, xs = np.where(mask)
    if not len(xs):
        return out
    left, right = _axis_samples(array, mask, ys, xs, np)
    up, down = _axis_samples(array.transpose(1, 0, 2), mask.T, xs, ys, np)
    fill = _plain_fill(array, mask, len(xs), np)
    vertical, horizontal = _pair(up, down, np), _pair(left, right, np)
    fill[vertical] = up[0][vertical]
    fill[horizontal] = left[0][horizontal]
    out[ys, xs] = fill
    return out

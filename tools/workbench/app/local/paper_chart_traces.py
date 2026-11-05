"""Track separate observed bands in a chart's one-color foreground mask."""
def _prediction(track, x):
    history = track['columns'][-8:]
    last = history[-1]
    if len(history) < 2:
        return last['y'], 0.0
    mx = sum(p['x'] for p in history) / len(history)
    my = sum(p['y'] for p in history) / len(history)
    spread = sum((p['x'] - mx) ** 2 for p in history)
    slope = sum((p['x'] - mx) * (p['y'] - my) for p in history) / spread if spread else 0.0
    return last['y'] + slope * (x - last['x']), slope


def _column_bands(ink, x, np):
    ys = np.flatnonzero(ink[:, x])
    bands = []
    for group in np.split(ys, np.where(np.diff(ys) > 1)[0] + 1):
        if len(group):
            low, high = int(group[0]), int(group[-1])
            bands.append({'x': int(x), 'y': (low + high) / 2, 'low': low, 'high': high})
    return bands


def _shared_bands(bands, active, predictions, tracks):
    shared, held = set(), set()
    for b, band in enumerate(bands):
        owners = [index for index in active
                  if band['low'] - 2 <= predictions[index][0] <= band['high'] + 2]
        if len(owners) > 1:
            # Distinct nearby runs can still be assigned independently.
            # Only reserve a band when it covers both predicted centers.
            alternatives = [other for j, other in enumerate(bands) if j != b
                            and any(abs(other['y'] - predictions[i][0]) < abs(band['y'] - predictions[i][0]) for i in owners)]
            if alternatives: continue
            shared.add(b)
            held.update(owners)
            for index in owners: tracks[index]['ambiguous'] = True
    return shared, held


def _track_choices(active, held, predictions, tracks, x, height, bands, shared):
    choices = []
    for index in active:
        if index in held: continue
        predicted, slope = predictions[index]
        last = tracks[index]['columns'][-1]
        distance = x - last['x']
        gate = max(6.0, height * .045) + abs(slope) * distance * .5
        for b, band in enumerate(bands):
            if b in shared: continue
            error = abs(band['y'] - predicted)
            if error <= gate:
                cost = error + .08 * abs(band['y'] - last['y'])
                choices.append((cost, index, b))
    return choices


def _assign_bands(held, shared, choices, tracks, bands, x):
    used_tracks, used_bands = set(held), set(shared)
    for _, index, b in sorted(choices):
        if index in used_tracks or b in used_bands: continue
        track = tracks[index]
        previous = track['columns'][-1]['x']
        if x > previous + 1: track['gaps'].append([previous + 1, x - 1])
        track['columns'].append(bands[b])
        used_tracks.add(index); used_bands.add(b)
    return used_bands


def _start_tracks(bands, used_bands, active, tracks, issues):
    for b, band in enumerate(bands):
        if b in used_bands: continue
        if len(active) >= 64:
            if 'trace-count-limit' not in issues: issues.append('trace-count-limit')
            continue
        tracks.append({'columns': [band], 'gaps': [], 'ambiguous': False})
        active.append(len(tracks) - 1)


def trace_mask(mask, *, max_gap=12, min_columns=12):
    """Return source-backed column bands. Gaps and shared junctions stay unfilled.

    Coordinates are local mask pixels. Distinct y-runs never share a centroid.
    A shared junction is omitted from both tracks while their slope histories
    remain independent; continuation identity is explicitly ambiguous.
    """
    import numpy as np
    ink = np.asarray(mask, dtype=bool)
    if ink.ndim != 2 or max_gap < 1 or min_columns < 1:
        raise ValueError('invalid-trace-mask')
    height, width = ink.shape
    tracks, active, issues = [], [], []
    for x in np.flatnonzero(ink.any(axis=0)).tolist():
        bands = _column_bands(ink, x, np)
        if len(bands) > 64:
            if 'trace-count-limit' not in issues: issues.append('trace-count-limit')
            continue
        active = [index for index in active if x - tracks[index]['columns'][-1]['x'] <= max_gap]
        predictions = {index: _prediction(tracks[index], x) for index in active}
        shared, held = _shared_bands(bands, active, predictions, tracks)
        choices = _track_choices(active, held, predictions, tracks, x, height, bands, shared)
        used_bands = _assign_bands(held, shared, choices, tracks, bands, x)
        _start_tracks(bands, used_bands, active, tracks, issues)
    kept = [track for track in tracks if len(track['columns']) >= min_columns]
    if any(track['ambiguous'] for track in kept): issues.append('curve-junction-ambiguous')
    return {'traces': kept, 'issues': issues}

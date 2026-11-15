"""Editing adjacency from PlotTracer junctions and exact composite tile cuts."""
import math


def curve_links(series, dpi):
    """Keep stroke ownership separate; join only shared graph node identities."""
    junctions = {}
    for s in series:
        binding = s.get('sourceBinding', {})
        if binding.get('kind') != 'raster-image':
            continue
        space = binding.get('networkSpace') or repr(binding.get('imageOccurrence'))
        nodes = binding.get('networkNodes', [None, None])
        for side, index in enumerate((0, len(s['points']) - 1)):
            node = nodes[side]
            if node is not None:
                junctions.setdefault((s['color'], space, node), []).append([s['id'], index])
    links = [[ends[0], end] for ends in junctions.values() for end in ends[1:]]
    _close_ink_gaps(series, links, 1.6 * dpi / 72)
    return links


def _free_ends(series):
    points = series['points']
    kinds = series.get('sourceBinding', {}).get('networkEndKinds', [None, None])
    for side, index in enumerate((0, len(points) - 1)):
        if kinds[side] != 'end':
            continue
        inside = points[index + (1 if side == 0 else -1) * min(5, len(points) - 1)]
        point = points[index]
        yield index, point, (point['x'] - inside['x'], point['y'] - inside['y'])


def _gap_candidate(end, target, tolerance, np):
    index, point, direction = end
    points = np.array([[p['x'], p['y']] for p in target['points']])
    vectors = points - [point['x'], point['y']]
    distances = np.hypot(vectors[:, 0], vectors[:, 1])
    nearest = int(distances.argmin())
    distance = float(distances[nearest])
    length = math.hypot(*direction) * distance
    if distance > tolerance or not length or float(np.dot(vectors[nearest], direction)) < .2 * length:
        return None
    return distance, [target['id'], nearest]


def _close_ink_gaps(series, links, tolerance):
    """Subpixel/AA breaks need one short, forward continuation, not a color merge."""
    import numpy as np
    for source in series:
        for end in _free_ends(source):
            related = linked_ids(links, source['id'])
            candidates = [_gap_candidate(end, target, tolerance, np) for target in series
                          if target['id'] not in related and target['color'] == source['color']]
            candidates = [c for c in candidates if c is not None]
            if candidates:
                _, target = min(candidates, key=lambda c: c[0])
                links.append([[source['id'], end[0]], target])


def linked_ids(links, series_id):
    """Small connected component used to route changed paint into adjacent tiles."""
    neighbors = {}
    for left, right in links:
        neighbors.setdefault(left[0], set()).add(right[0])
        neighbors.setdefault(right[0], set()).add(left[0])
    found, pending = {series_id}, [series_id]
    while pending:
        for ident in neighbors.get(pending.pop(), set()) - found:
            found.add(ident)
            pending.append(ident)
    return found

"""Trace a chart as one visible raster, retain each original image occurrence."""
import hashlib


def _frame(images, bbox, dpi, paint):
    width, height = paint.crop_size(bbox, dpi)
    scales = [paint._mean_scale(image, bbox, dpi) for image in images]
    factor = min(4.0, 1200 / max(width, height), 1 / min(scales))
    return max(1, round(width * factor)), max(1, round(height * factor)), factor


def _matrix(image, bbox, dpi, factor, paint, np):
    p = paint._image_index_to_crop((0, 0), image, bbox, dpi)
    x = paint._image_index_to_crop((1, 0), image, bbox, dpi)
    y = paint._image_index_to_crop((0, 1), image, bbox, dpi)
    return np.array([[factor * (x[0] - p[0]), factor * (y[0] - p[0]), factor * p[0]],
                     [factor * (x[1] - p[1]), factor * (y[1] - p[1]), factor * p[1]]], np.float64)


def _composite(images, bbox, dpi, paint, raster):
    cv, np = raster._deps()
    width, height, factor = _frame(images, bbox, dpi, paint)
    pixels = np.full((height, width, 3), 255, np.uint8)
    owners = np.full((height, width), -1, np.int32)
    for index, image in enumerate(images):
        matrix = _matrix(image, bbox, dpi, factor, paint, np)
        size = (width, height)
        rgb = cv.warpAffine(paint._raster_array(image), matrix, size, flags=cv.INTER_NEAREST, borderValue=(255, 255, 255))
        alpha = np.full((image['height'], image['width']), 255, np.uint8)
        if image.get('alpha') is not None:
            alpha = np.frombuffer(image['alpha'], np.uint8).reshape(alpha.shape)
        present = cv.warpAffine(alpha, matrix, size, flags=cv.INTER_NEAREST, borderValue=0) > 4
        pixels[present] = rgb[present]
        owners[present] = index
    return pixels, owners, factor


def _owner(point, owners):
    x, y = int(round(point[0])), int(round(point[1]))
    x = min(max(0, x), owners.shape[1] - 1)
    y = min(max(0, y), owners.shape[0] - 1)
    return int(owners[y, x])


def _parts(edge, edge_index, owners):
    points = edge['points']
    owner = _owner(points[0], owners)
    node = edge['nodes'][0]
    kind = edge['endKinds'][0]
    kept = [points[0]]
    for index in range(1, len(points)):
        next_owner = _owner(points[index], owners)
        if next_owner != owner:
            previous, current = points[index - 1], points[index]
            seam = ((previous[0] + current[0]) / 2, (previous[1] + current[1]) / 2)
            cut = 'edge-%d-cut-%d' % (edge_index, index)
            yield owner, kept + [seam], [node, cut], [kind, 'junc']
            kept, owner, node, kind = [seam], next_owner, cut, 'junc'
        kept.append(points[index])
    yield owner, kept, [node, edge['nodes'][1]], [kind, edge['endKinds'][1]]


def _public(edge, points, nodes, kinds, image, bbox, dpi, factor, number, paint):
    branch = 'b%d' % number
    samples = [{'x': x / factor, 'y': y / factor, 'origin': 'raster-sample',
                'role': 'curve-sample', 'branch': branch} for x, y in points]
    samples[0]['role'] = samples[-1]['role'] = 'source-endpoint'
    color = '#%02x%02x%02x' % edge['color']
    fingerprint = hashlib.sha256(repr((color, nodes, samples)).encode('ascii')).hexdigest()
    return {'id': 'series-%d' % number, 'name': None, 'color': color, 'points': samples,
            'style': {'width': edge['width'] / factor, 'dashes': None, 'opacity': 1.0, 'lineCap': 0, 'lineJoin': 0},
            'sourceBinding': {'kind': 'raster-image', 'fingerprint': fingerprint, 'space': 'crop-pixels',
                              'color': list(edge['color']), 'imageSize': [image['width'], image['height']],
                              'branch': branch, 'networkNodes': nodes, 'networkSpace': 'composite',
                              'networkEndKinds': kinds,
                              'imageOccurrence': paint._image_occurrence(image)}}


def build(parsed, bbox, dpi, plot):
    import paper_chart_paint as paint
    import paper_chart_raster_edit as raster
    images = [image for image in parsed['images'] if image['samples'] and image['width']]
    if not images:
        return []
    pixels, owners, factor = _composite(images, bbox, dpi, paint, raster)
    box = None if plot is None else [v * factor for v in plot]
    series = []
    for edge_index, edge in enumerate(raster.trace_series(pixels, box)):
        for owner, points, nodes, kinds in _parts(edge, edge_index, owners):
            if owner < 0 or len(points) < 2:
                continue
            series.append(_public(edge, points, nodes, kinds, images[owner], bbox, dpi, factor, len(series) + 1, paint))
    return series

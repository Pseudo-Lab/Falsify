"""Source-bound XY calibration. Coordinates are selected by the caller, not inferred.

Two tick positions calibrate each axis, as in WebPlotDigitizer's XY workflow.
Linear axes interpolate values; logarithmic axes interpolate log10(values).
No source point, tick or scale is guessed. Raw calibration and pixel points stay
in the result. Pixel uncertainty describes raster resolution, not axis accuracy.
"""
import hashlib
import json
import math


def _number(n):
    return type(n) in (int, float) and math.isfinite(n)


def _axis(axis, extent):
    if not isinstance(axis, dict) or set(axis) != {'scale', 'points'} or axis['scale'] not in ('linear', 'log'):
        raise ValueError('digitizer_axis_invalid')
    ticks = axis['points']
    if not isinstance(ticks, list) or len(ticks) != 2:
        raise ValueError('digitizer_axis_invalid')
    for tick in ticks:
        if not isinstance(tick, dict) or set(tick) != {'pixel', 'value'} or not all(_number(tick[k]) for k in tick):
            raise ValueError('digitizer_axis_invalid')
        if not 0 <= tick['pixel'] <= extent or axis['scale'] == 'log' and tick['value'] <= 0:
            raise ValueError('digitizer_axis_invalid')
    p0, p1 = (tick['pixel'] for tick in ticks)
    v0, v1 = (tick['value'] for tick in ticks)
    if p0 == p1 or v0 == v1: raise ValueError('digitizer_axis_invalid')
    if axis['scale'] == 'log': v0, v1 = math.log10(v0), math.log10(v1)
    slope = (v1 - v0) / (p1 - p0)
    def convert(pixel):
        value = v0 + (pixel-p0)*slope
        try: value = 10 ** value if axis['scale'] == 'log' else value
        except OverflowError: raise ValueError('digitizer_value_out_of_range') from None
        if not math.isfinite(value): raise ValueError('digitizer_value_out_of_range')
        return value
    return convert


def digitize(store, paper_id, file_hash, page_index, image_sha256, calibration, points, bbox=None, dpi=120):
    """Calibrate points on exactly one rendered original image and retain the result."""
    if store.status(paper_id)['fileHash'] != file_hash: raise ValueError('analysis_hash_mismatch')
    image = store.render_region(paper_id, page_index, bbox=bbox, dpi=dpi)
    if image_sha256 != image['sha256']: raise ValueError('digitizer_image_mismatch')
    if not isinstance(calibration, dict) or set(calibration) != {'x', 'y'}: raise ValueError('digitizer_axis_invalid')
    x = _axis(calibration['x'], image['width']); y = _axis(calibration['y'], image['height'])
    if not isinstance(points, list) or not 1 <= len(points) <= 5000: raise ValueError('digitizer_points_invalid')
    rows, numeric = [], []
    for row, point in enumerate(points):
        if not isinstance(point, list) or len(point) != 2 or not all(_number(n) for n in point): raise ValueError('digitizer_points_invalid')
        if not 0 <= point[0] <= image['width'] or not 0 <= point[1] <= image['height']: raise ValueError('digitizer_points_invalid')
        values = [x(point[0]), y(point[1])]
        rows.append([str(value) for value in values])
        for col, (value, convert) in enumerate(zip(values, (x, y))):
            limits = sorted([convert(point[col]-0.5), convert(point[col]+0.5)])
            numeric.append({'row':row, 'column':col, 'raw':str(value), 'value':value, 'unit':None,
                            'origin':'pixel-calibrated', 'pixelInterval':limits})
    data = {'schema':'falsify.chart-data.v1', 'status':'ready',
            'image':{k:image[k] for k in ('sha256','width','height')},
            'columns':['x','y'], 'rows':rows, 'numericCells':numeric, 'title':None, 'chartType':'xy',
            'axes':{k:{'label':None, 'unit':None, 'scale':calibration[k]['scale']} for k in ('x','y')},
            'calibration':calibration, 'pixelPoints':points, 'issues':[], 'rawOutput':'',
            'sourcePoints':[[image['bbox'][0]+p[0]/image['width']*(image['bbox'][2]-image['bbox'][0]),
                             image['bbox'][1]+p[1]/image['height']*(image['bbox'][3]-image['bbox'][1])] for p in points],
            'provenance':{'engine':'xy-calibration', 'version':'1', 'method':'caller-selected-ticks-and-points',
                          'model':None, 'coordinateSpace':'input-image-pixels'}}
    key = hashlib.sha256(json.dumps([file_hash,page_index,image_sha256,calibration,points],sort_keys=True).encode()).hexdigest()
    entry = {'paperId':paper_id, 'fileHash':file_hash, 'kind':'chart', 'pageIndex':page_index, 'bbox':image['bbox'],
             'language':'en', 'inputImage':{k:image[k] for k in ('sha256','width','height')} | {'dpi':dpi}, 'data':data}
    return store.find_analysis(paper_id,key) or store.add_analysis(paper_id,entry,key)

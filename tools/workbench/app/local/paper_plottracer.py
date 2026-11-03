"""Pinned PlotTracer JS core in embedded V8. No Node process or chart model.

Original pixels, explicit/OCR calibration and dense curve samples remain distinct
from statistical observations. The JS bundle contains the upstream algorithms;
this module validates inputs and adapts existing paper-evidence contracts.
"""
import io
import json
import math
from pathlib import Path

UPSTREAM = 'dcc28a5da453ff5c4e7cadd4478523560d15c0dc'
WPD_COMMIT = '3a3ecb11606945d0701c8a488777e6861be70056'
BUNDLE = Path(__file__).resolve().parents[1] / 'dist/plottracer-vendor/engine.js'
MAX_PIXELS = 12_000_000


def _finite(v):
    return type(v) in (int, float) and math.isfinite(v)


def validate_options(options):
    if not isinstance(options, dict) or set(options) - {'imageSha256', 'calibration', 'series', 'plotBbox'}:
        raise ValueError('chart_options_invalid')
    sha = options.get('imageSha256')
    if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
        raise ValueError('chart_image_mismatch')
    calibration = options.get('calibration')
    if not isinstance(calibration, dict) or set(calibration) != {'x', 'y'}:
        raise ValueError('digitizer_axis_invalid')
    for axis in calibration.values():
        if not isinstance(axis, dict) or set(axis) != {'scale', 'points'} or axis['scale'] not in ('linear', 'log'):
            raise ValueError('digitizer_axis_invalid')
        points = axis['points']
        if not isinstance(points, list) or len(points) != 2:
            raise ValueError('digitizer_axis_invalid')
        for point in points:
            if not isinstance(point, dict) or set(point) != {'pixel', 'value'} or not all(_finite(v) for v in point.values()):
                raise ValueError('digitizer_axis_invalid')
            if point['pixel'] < 0 or axis['scale'] == 'log' and point['value'] <= 0:
                raise ValueError('digitizer_axis_invalid')
        if points[0]['pixel'] == points[1]['pixel'] or points[0]['value'] == points[1]['value']:
            raise ValueError('digitizer_axis_invalid')
    series = options.get('series')
    if not isinstance(series, list) or not 1 <= len(series) <= 8:
        raise ValueError('chart_series_invalid')
    seen = set()
    for item in series:
        if not isinstance(item, dict) or set(item) - {'id', 'color', 'name'}:
            raise ValueError('chart_series_invalid')
        ident, color, name = item.get('id'), item.get('color'), item.get('name', '')
        if not isinstance(ident, str) or not 1 <= len(ident) <= 80 or ident in seen or any(ord(c) < 32 for c in ident):
            raise ValueError('chart_series_invalid')
        seen.add(ident)
        if not isinstance(color, str) or len(color) != 7 or color[0] != '#' or any(c not in '0123456789abcdefABCDEF' for c in color[1:]):
            raise ValueError('chart_series_invalid')
        if not isinstance(name, str) or len(name) > 160:
            raise ValueError('chart_series_invalid')
    box = options.get('plotBbox')
    if box is not None and (not isinstance(box, list) or len(box) != 4 or not all(_finite(v) for v in box) or box[0] < 0 or box[1] < 0 or box[2] <= box[0] or box[3] <= box[1]):
        raise ValueError('chart_region_invalid')
    return options


class Core:
    def __init__(self):
        from py_mini_racer import MiniRacer
        self.context = MiniRacer()
        self.context.set_hard_memory_limit(512 * 1024 * 1024)
        try:
            self.context.eval(BUNDLE.read_text(encoding='utf-8'), timeout_sec=10)
        except Exception:
            self.close()
            raise

    def close(self):
        self.context.close()

    def trace(self, rgba, width, height, colors, region, find_lines=True):
        colors = [{**color, 'mode': 'lines' if find_lines else 'color'} for color in colors]
        result = self.context.call('FalsifyPlotTracer.trace', rgba.decode('latin1'), width, height,
                                   json.dumps(colors), json.dumps(region), max(3, 480//max(1, len(colors))), timeout_sec=20)
        return json.loads(result) if isinstance(result, str) else result

    def convert(self, calibration, points):
        result = self.context.call('FalsifyPlotTracer.calibrate', json.dumps(calibration), json.dumps(points), timeout_sec=10)
        result = json.loads(result) if isinstance(result, str) else result
        points = result['points']
        if not isinstance(points, list) or any(not isinstance(p, list) or len(p) != 2 or not all(_finite(v) for v in p) for p in points):
            raise ValueError('digitizer_value_out_of_range')
        return points


def _calibration(axis):
    ticks = sorted(axis['usedTicks'], key=lambda t: t['pixel'])
    return {'scale': axis['scale'], 'points': [{'pixel': t['pixel'], 'value': t['value']} for t in (ticks[0], ticks[-1])]}


def _sample_path(path, budget):
    """Reuse the existing OpenCV polyline reducer in original path order."""
    if len(path) <= budget:
        return path, None, list(range(len(path)))
    import cv2 as cv
    import numpy as np
    from paper_chart_sampling import _simplify_indices, _max_deviation
    records = [{'x': p[0], 'y': p[1]} for p in path]
    tolerance = .75
    chosen = _simplify_indices(records, tolerance, cv, np)
    while len(chosen) > budget:
        tolerance *= 2
        chosen = _simplify_indices(records, tolerance, cv, np)
    deviation, _ = _max_deviation(records, [(0, len(records)-1)], set(chosen))
    return [path[i] for i in chosen], {'issues': ['sampling-point-limit'] if deviation > .751 else [], 'maxDeviationPixels': deviation}, chosen


def _hex(rgb):
    return '#' + ''.join(f'{int(v):02x}' for v in rgb)


def _plain_axis(axis):
    return {'scale': axis['scale'], 'points': [{'pixel': float(point['pixel']), 'value': float(point['value'])} for point in axis['points']]}


def trace_geometry(png_bytes, *, manual=None, ocr_lines=None):
    import hashlib
    from PIL import Image
    result = {'schema': 'falsify.chart-geometry.v1', 'status': 'unavailable',
              'image': {'sha256': hashlib.sha256(png_bytes).hexdigest(), 'width': None, 'height': None},
              'plotBbox': None, 'axes': {}, 'series': [], 'issues': [],
              'provenance': {'engine': 'plottracer', 'revision': UPSTREAM, 'method': 'oss-pixel-calibration',
                             'wpdCommit': WPD_COMMIT, 'adapter': 'falsify-plottracer', 'policy': 'auto-route-v1',
                             'bundleSha256': hashlib.sha256(BUNDLE.read_bytes()).hexdigest()},
              'pointKind': 'curve-sample'}
    with Image.open(io.BytesIO(png_bytes)) as opened:
        width, height = opened.size
        if width * height > MAX_PIXELS:
            raise ValueError('chart_image_limit')
        image = opened.convert('RGBA')
    result['image'].update(width=width, height=height)
    if manual is not None:
        validate_options(manual)
        if manual['imageSha256'] != result['image']['sha256']:
            raise ValueError('chart_image_mismatch')
        from paper_digitizer import _axis
        _axis(manual['calibration']['x'], width)
        _axis(manual['calibration']['y'], height)
        # Upstream calibrationBoxRegion's default: the window between ticks.
        xp = [p['pixel'] for p in manual['calibration']['x']['points']]
        yp = [p['pixel'] for p in manual['calibration']['y']['points']]
        box = manual.get('plotBbox', [min(xp), min(yp), max(xp), max(yp)])
        if box[2] > width or box[3] > height:
            raise ValueError('chart_region_invalid')
        xcal, ycals = manual['calibration']['x'], {'left': manual['calibration']['y']}
        colors = [{'id': s['id'], 'name': s.get('name', s['id']), 'rgb': [int(s['color'][i:i+2], 16) for i in (1, 3, 5)], 'axisBinding': 'left'} for s in manual['series']]
        result['calibrationSource'] = 'caller-selected'
        result['axes'] = {'x': xcal, 'left': ycals['left']}
    else:
        import cv2 as cv
        import numpy as np
        import paper_chart_geometry as geometry
        pixels = np.array(image.convert('RGB'))
        bgr = cv.cvtColor(pixels, cv.COLOR_RGB2BGR)
        frame = geometry._frame(cv.cvtColor(bgr, cv.COLOR_BGR2GRAY), cv, np)
        if frame is None:
            result['issues'] = ['cartesian-axes-not-found', 'axis-calibration-required']
            return result
        box = list(frame)
        if ocr_lines is None:
            import paper_ocr
            issues = []
            ok, ocr_lines, _ = paper_ocr._default_lines(png_bytes, 'en', issues, {})
            if not ok:
                result['issues'] = ['axis-ocr-unavailable', 'axis-calibration-required', *issues]
                return result
        ticks = geometry._ticks(ocr_lines, frame, width, height, bgr, cv, np)
        left, top, right, bottom = frame
        for side in ('x', 'left', 'right'):
            axis = geometry.fit_axis(ticks[side], right-left if side == 'x' else bottom-top)
            if axis:
                hues = [geometry._hue_color(bgr, t['bbox'], cv, np) for t in axis['usedTicks']]
                colors_found = [h for h in hues if h is not None]
                axis['hue'] = float(np.median(colors_found)) if colors_found else None
                result['axes'][side] = axis
                if axis['rejectedTicks']:
                    result['issues'].append('axis-ocr-outlier-'+side)
        axes = result['axes']
        if 'x' not in axes or not any(s in axes for s in ('left', 'right')):
            result['plotBbox'] = box
            result['issues'].append('axis-calibration-required')
            return result
        xcal = _calibration(axes['x'])
        ycals = {s: _calibration(axes[s]) for s in ('left', 'right') if s in axes}
        hsv = cv.cvtColor(bgr, cv.COLOR_BGR2HSV)
        roi = hsv[top+2:bottom-1, left+2:right-1]
        colored = (roi[:, :, 1] > 90) & (roi[:, :, 2] > 70)
        counts = np.bincount(roi[:, :, 0][colored], minlength=180)
        selected = []
        for hue in np.argsort(counts)[::-1].tolist():
            if counts[hue] < 20 or any(min(abs(hue-h), 180-abs(hue-h)) < 9 for h in selected):
                continue
            selected.append(hue)
            if len(selected) == 8:
                break
        colors = []
        rgb_roi = pixels[top+2:bottom-1, left+2:right-1]
        for hue in [*selected, None]:
            if hue is None:
                mask = (roi[:, :, 1] < 50) & (roi[:, :, 2] < 125)
                mask[(mask.sum(axis=1) > (right-left)*.75), :] = False
                mask[:, (mask.sum(axis=0) > (bottom-top)*.75)] = False
            else:
                delta = np.abs(roi[:, :, 0].astype(int)-hue)
                mask = colored & ((delta < 6) | (delta > 174))
            if mask.sum() < 20:
                continue
            rgb = np.median(rgb_roi[mask], axis=0).astype(int).tolist()
            binding = next(iter(ycals)) if len(ycals) == 1 else 'ambiguous'
            if len(ycals) == 2 and hue is not None:
                matches = [s for s in ycals if axes[s].get('hue') is not None and min(abs(hue-axes[s]['hue']), 180-abs(hue-axes[s]['hue'])) < 10]
                if len(matches) == 1:
                    binding = matches[0]
            colors.append({'id': 'color-'+str(len(colors)+1), 'rgb': rgb, 'axisBinding': binding, 'hue': hue})
        box = [left+2, top+2, right-1, bottom-1]
        result['calibrationSource'] = 'ocr-ticks'
    result['plotBbox'] = box
    region = {'x': float(box[0]), 'y': float(box[1]), 'width': float(box[2]-box[0]), 'height': float(box[3]-box[1]),
              'route': 'auto', 'manual': manual is not None}
    trace_colors = []
    for source in colors:
        item = {'id': source['id'], 'rgb': [int(v) for v in source['rgb']]}
        binding = source.get('axisBinding')
        if binding in ycals:
            item['calibration'] = {'x': _plain_axis(xcal), 'y': _plain_axis(ycals[binding])}
        trace_colors.append(item)
    core = Core()
    try:
        raw = core.trace(image.tobytes(), width, height, trace_colors, region, find_lines=manual is None)
        candidates = []
        for source, traced in zip(colors, raw.get('series', [])):
            if 'accepted' in traced:
                # Topology stays on findLines. Isolated curves use WPD or the
                # measured column runs. Nearest-neighbour order is not a fallback.
                # Short supported branches are already in accepted; do not drop
                # them again with a width fraction.
                accepted = [line for line in traced['accepted'] if len(line.get('points', [])) >= 2]
            else:
                lines = [line for line in traced.get('lines', []) if len(line.get('points', [])) >= 2]
                pixels = traced.get('pixels', [])
                accepted = lines or ([{'points': pixels, 'roles': [], 'gaps': [], 'colorTraceFallback': True}] if len(pixels) >= 2 else [])
            for line in accepted:
                candidates.append((source, line, traced))
        budget = max(3, 480 // max(1, len(candidates)))
        for source, line, traced in candidates[:64]:
            path, reduction, indices = _sample_path(line['points'], budget)
            if len(path) < 2:
                continue
            converted = {side: core.convert({'x': xcal, 'y': cal}, path) for side, cal in ycals.items()}
            binding = source['axisBinding']
            intervals = core.convert({'x': xcal, 'y': ycals[binding]}, [[xp, y] for xp, yp in path for y in (yp-.5, yp+.5)]) if binding != 'ambiguous' else []
            roles = line.get('roles') or []
            origins = line.get('origins') or []
            ink_support = line.get('inkSupport') or []
            points = []
            for index, (xp, yp) in enumerate(path):
                src = indices[index]
                values = {side: values[index][1] for side, values in converted.items()}
                role = roles[src] if src < len(roles) and roles[src] else 'measured'
                origin = origins[src] if src < len(origins) and origins[src] else ('curve-interpolated' if role == 'bridged' else 'pixel-calibrated')
                point = {'xPixel': xp, 'yPixel': yp, 'x': next(iter(converted.values()))[index][0], 'valueCandidates': values,
                         'origin': origin, 'role': role}
                if src < len(ink_support):
                    point['inkSupport'] = bool(ink_support[src])
                if binding != 'ambiguous':
                    point['y'] = values[binding]
                    point['pixelInterval'] = sorted(v[1] for v in intervals[index*2:index*2+2])
                points.append(point)
            ambiguous = bool(traced.get('ambiguous')) or bool(traced.get('unresolved')) or binding == 'ambiguous'
            sampling = {'observedColumns': len(line['points']), 'returnedPoints': len(points), 'tolerancePixels': .75, 'maxDeviationPixels': reduction.get('maxDeviationPixels') if reduction else 0}
            requested = traced.get('requestedRgb') or source['rgb']
            effective = traced.get('effectiveRgb') or source['rgb']
            series = {'id': 'series-'+str(len(result['series'])+1), 'name': source.get('name'),
                'color': _hex(effective), 'hue': source.get('hue'),
                'axisBinding': binding, 'points': points, 'gapsPixels': line.get('gaps', []), 'segments': [],
                'traceAmbiguous': ambiguous, 'sampling': sampling, 'pointKind': 'curve-sample',
                'upstreamRoles': list(dict.fromkeys(role for role in roles if role))}
            if traced.get('route'):
                series['traceRoute'] = traced['route']
                series['requestedColor'] = _hex(requested)
                series['effectiveColor'] = _hex(effective)
            if line.get('algorithm'):
                series['traceAlgorithm'] = line['algorithm']
            if traced.get('unresolved'):
                series['unresolvedEvidence'] = traced['unresolved']
            if traced.get('diagnostics'):
                series['traceDiagnostics'] = traced['diagnostics']
            if line.get('closed'):
                series['traceClosed'] = True
            result['series'].append(series)
            if binding == 'ambiguous' and 'series-axis-ambiguous' not in result['issues']:
                result['issues'].append('series-axis-ambiguous')
            if reduction:
                result['issues'].extend(code for code in reduction.get('issues', []) if code not in result['issues'])
        if not result['series']:
            result['issues'].append('curves-not-found')
            return result
        result['status'] = 'partial' if result['issues'] else 'ready'
        return result
    finally:
        core.close()

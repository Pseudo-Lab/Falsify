"""Source-bound chart editing for human UI and RED MCP. The BLUE evidence MCP stays read-only."""
import base64
import copy
import hashlib
import importlib.util
import json
import math
import secrets
import threading
import time

ROUTES = ('/api/paper/chart/prepare', '/api/paper/chart/preview', '/api/paper/chart/export')
SCHEMA = 'falsify.chart-edit-plan.v1'
MAX_OPERATIONS = 200
MAX_PLAN_BYTES = 1_000_000


def capability():
    available = all(importlib.util.find_spec(name) is not None for name in (
        "pymupdf", "pikepdf", "PIL", "numpy", "cv2", "py_mini_racer"))
    return {"available": available, "schema": SCHEMA}


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _b64(raw):
    return base64.b64encode(raw).decode('ascii')


def _public(scene):
    """Expose geometry and rendering data, keep source token bindings in the server."""
    keys = ('schema', 'sceneId', 'sourceFileHash', 'pageIndex', 'bbox', 'width', 'height',
            'plotBbox', 'axes', 'calibration', 'revision', 'backgroundPng', 'originalPng', 'issues', 'mode')
    result = {k: copy.deepcopy(scene[k]) for k in keys if k in scene}
    result['series'] = [{k: copy.deepcopy(s[k]) for k in ('id', 'name', 'kind', 'color', 'style', 'points', 'baseline', 'radius', 'orientation')
                         if k in s} for s in scene.get('series', [])]
    for k in ('backgroundPng', 'originalPng'):
        if isinstance(result.get(k), bytes):
            result[k] = _b64(result[k])
    return result


def _prepare_backend(raw, index, bbox, options=None, preferred=None):
    from paper_chart_scene import prepare_scene
    if preferred == 'marks':
        from paper_chart_marks import prepare_marks
        scene = prepare_marks(raw, index, bbox, options=options)
        if not scene:
            raise ValueError('chart_region_changed')
        return scene
    scene = prepare_scene(raw, index, bbox, options=options)
    # An open data curve takes priority over its circular marker decorations.
    open_curve = any(len(s.get('points', [])) > 1 and
        math.hypot(s['points'][-1]['x']-s['points'][0]['x'],
                   s['points'][-1]['y']-s['points'][0]['y']) > 8 for s in scene.get('series', []))
    if preferred is None and not open_curve:
        from paper_chart_marks import prepare_marks
        marks = prepare_marks(raw, index, bbox, options=options)
        if marks:
            return marks
    scene['mode'] = 'curve'
    return scene


def _verify_output(source, output, scene, *, regions=None):
    """Check page count, extracted words and pixels outside the selected crop."""
    import pymupdf
    from PIL import Image, ImageChops, ImageDraw
    issues = []
    visual = regions is not None
    if regions is None:
        regions = [(scene['pageIndex'], scene['bbox'])]
    with pymupdf.open(stream=source, filetype='pdf') as before, pymupdf.open(stream=output, filetype='pdf') as after:
        if len(before) != len(after):
            return [{'code': 'page-count-changed'}]
        for index in range(len(before)):
            left, right = before[index], after[index]
            if visual:
                def outside_text(page):
                    boxes = [pymupdf.Rect(b) for p, b in regions if p == index]
                    chars = []
                    for block in page.get_text('rawdict').get('blocks', []):
                        for line in block.get('lines', []):
                            for span in line.get('spans', []):
                                for char in span.get('chars', []):
                                    rect = pymupdf.Rect(char['bbox']) * page.rotation_matrix
                                    center = (rect.tl + rect.br) / 2
                                    if not any(center in box for box in boxes):
                                        chars.append(char['c'])
                    return ''.join(chars)
                text_changed = outside_text(left) != outside_text(right)
            else:
                text_changed = left.get_text() != right.get_text()
            if text_changed:
                issues.append({'code': 'source-text-changed', 'pageIndex': index})
            a, b = left.get_pixmap(alpha=False), right.get_pixmap(alpha=False)
            if (a.width, a.height, a.n) != (b.width, b.height, b.n):
                issues.append({'code': 'page-geometry-changed', 'pageIndex': index})
                continue
            delta = ImageChops.difference(Image.frombytes('RGB', (a.width, a.height), a.samples),
                                         Image.frombytes('RGB', (b.width, b.height), b.samples))
            for page_index, bbox in regions:
                if index == page_index:
                    x0, y0, x1, y1 = bbox
                    # One antialiased pixel at the selected boundary belongs to the edit.
                    ImageDraw.Draw(delta).rectangle((math.floor(x0)-1, math.floor(y0)-1,
                                                    math.ceil(x1)+1, math.ceil(y1)+1), fill=(0,0,0))
            if any(high > 2 for low, high in delta.getextrema()):
                issues.append({'code': 'outside-region-pixels-changed', 'pageIndex': index})
    return issues


class ChartEditService:
    def __init__(self, store=None, ttl=1800, max_scenes=8, clock=time.monotonic):
        self.store = store
        self.ttl, self.max_scenes, self.clock = ttl, max_scenes, clock
        self.scenes = {}
        self.lock = threading.RLock()

    def _source(self, paper_id, digest):
        if not isinstance(paper_id, str) or not 1 <= len(paper_id) <= 160:
            raise ValueError('chart_source_invalid')
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('chart_source_invalid')
        if self.store is None:
            from paper_evidence import default_store
            store = default_store
        else:
            store = self.store
        try:
            raw = store.source_bytes(paper_id, digest)
        except KeyError:
            raise ValueError('chart_source_expired') from None
        if _sha(raw) != digest:
            raise ValueError('chart_source_mismatch')
        return raw

    def _authority(self, paper_id, digest, raw):
        from contextlib import contextmanager
        from paper_evidence import default_store
        store = self.store if self.store is not None else default_store
        @contextmanager
        def authority():
            try:
                if hasattr(store, 'source_authority'):
                    with store.source_authority(paper_id, digest, raw): yield
                else:
                    if self._source(paper_id, digest) != raw: raise ValueError('chart_source_mismatch')
                    yield
            except KeyError:
                raise ValueError('chart_source_expired') from None
        return authority()

    def _validate_region(self, index, bbox):
        if type(index) is not int or index < 0 or not isinstance(bbox, list) or len(bbox) != 4:
            raise ValueError('chart_region_invalid')
        if any(type(x) not in (int, float) or not math.isfinite(x) for x in bbox) or bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            raise ValueError('chart_region_invalid')

    def _prepare_region(self, data):
        index, bbox = data.get('pageIndex'), data.get('bbox')
        self._validate_region(index, bbox)
        options = data.get('options')
        if options is not None and not isinstance(options, dict):
            raise ValueError('chart_prepare_invalid')
        dpi = (options or {}).get('dpi', 72)
        if type(dpi) not in (int, float) or not math.isfinite(dpi) or not 12 <= dpi <= 300:
            raise ValueError('chart_region_invalid')
        if (bbox[2]-bbox[0])*(bbox[3]-bbox[1])*(dpi/72)**2 > 16_000_000:
            raise ValueError('chart_region_invalid')
        return index, bbox, options

    def prepare(self, data, *, cancelled=None):
        from paper_native_worker import budget, check
        deadline = budget()
        if not isinstance(data, dict) or set(data) - {'paperId', 'fileHash', 'pageIndex', 'bbox', 'options'}:
            raise ValueError('chart_prepare_invalid')
        paper_id, digest = data.get('paperId'), data.get('fileHash')
        raw = self._source(paper_id, digest)
        index, bbox, options = self._prepare_region(data)
        from paper_native_worker import run
        scene = run('chart_prepare', [raw, index, bbox, options, None], cancelled=cancelled, deadline=deadline)
        scene = copy.deepcopy(scene)
        scene.update(schema='falsify.chart-scene.v1', sceneId=secrets.token_hex(16),
                     sourceFileHash=digest, pageIndex=index, bbox=bbox[:], revision=0)
        result = {**_public(scene), 'paperId': paper_id, 'fileHash': digest}
        now = self.clock()
        with self._authority(paper_id, digest, raw), self.lock:
            check(deadline, cancelled)
            for key in list(self.scenes):
                if self.scenes[key]['expires'] <= now:
                    del self.scenes[key]
            while len(self.scenes) >= self.max_scenes:
                del self.scenes[min(self.scenes, key=lambda k: self.scenes[k]['expires'])]
            self.scenes[scene['sceneId']] = {'scene': scene, 'paperId': paper_id, 'options': copy.deepcopy(data.get('options')), 'expires': now + self.ttl}
        return result

    def _validate_operations(self, ops):
        ids = [op.get('id') if isinstance(op, dict) else None for op in ops]
        if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
            raise ValueError('chart_plan_invalid')
        try:
            if len(json.dumps(ops, ensure_ascii=False, allow_nan=False).encode('utf-8')) > MAX_PLAN_BYTES:
                raise ValueError('chart_operation_limit')
        except (TypeError, OverflowError):
            raise ValueError('chart_plan_invalid') from None

    def _plan_request(self, data):
        if not isinstance(data, dict) or set(data) - {'schema', 'paperId', 'fileHash', 'sceneId', 'revision', 'operations'} or data.get('schema') != SCHEMA:
            raise ValueError('chart_plan_invalid')
        revision = data.get('revision')
        if type(revision) is not int or not 0 <= revision <= 1_000_000_000:
            raise ValueError('chart_revision_invalid')
        ops = data.get('operations')
        if not isinstance(ops, list) or len(ops) > MAX_OPERATIONS:
            raise ValueError('chart_operation_limit')
        self._validate_operations(ops)
        return revision, ops

    def _plan(self, data, *, deadline=None, cancelled=None):
        revision, ops = self._plan_request(data)
        raw = self._source(data.get('paperId'), data.get('fileHash'))
        scene_id = data.get('sceneId')
        if not isinstance(scene_id, str):
            raise ValueError('chart_scene_expired')
        with self.lock:
            entry = self.scenes.get(scene_id)
            if not entry or entry['expires'] <= self.clock():
                self.scenes.pop(scene_id, None)
                raise ValueError('chart_scene_expired')
            if entry['paperId'] != data['paperId'] or entry['scene']['sourceFileHash'] != data['fileHash']:
                raise ValueError('chart_source_mismatch')
            scene = copy.deepcopy(entry['scene'])
        from paper_native_worker import run
        edited = run('chart_evaluate', [scene, ops], cancelled=cancelled, deadline=deadline)
        # Some adapters return the scene inside a result envelope.
        if isinstance(edited, dict) and isinstance(edited.get('scene'), dict):
            edited = edited['scene']
        if not isinstance(edited, dict) or not isinstance(edited.get('series'), list):
            raise ValueError('chart_geometry_invalid')
        edited['revision'] = revision
        return raw, scene, edited

    def preview(self, data, *, cancelled=None):
        from paper_native_worker import budget
        deadline = budget()
        raw, scene, edited = self._plan(data, deadline=deadline, cancelled=cancelled)
        from paper_native_worker import run
        result = run('chart_preview', [raw, scene, edited], cancelled=cancelled, deadline=deadline)
        png = result['png'] if isinstance(result, dict) else result
        if not isinstance(png, bytes) or not png.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('chart_preview_invalid')
        response = {'schema': 'falsify.chart-preview.v1', 'sceneId': scene['sceneId'],
                'fileHash': data['fileHash'], 'paperId': data['paperId'], 'revision': data['revision'],
                'image': _b64(png), 'sha256': _sha(png), 'scene': _public(edited),
                'issues': result.get('issues', []) if isinstance(result, dict) else []}
        self._check_publication(data, raw, scene, deadline, cancelled)
        return response

    def export(self, data, *, author='human', source_override=None, cancelled=None):
        from paper_native_worker import budget
        deadline = budget()
        raw, scene, edited = self._plan(data, deadline=deadline, cancelled=cancelled)
        options = None
        if source_override is not None and source_override != raw:
            with self.lock:
                entry = self.scenes.get(data['sceneId'])
                if not entry or entry['expires'] <= self.clock(): raise ValueError('chart_scene_expired')
                options = copy.deepcopy(entry['options'])
        from paper_native_worker import run
        output, report, pages, issues = run('chart_export', [raw, scene, edited, source_override, options], cancelled=cancelled, deadline=deadline)
        changes = [] if scene['series'] == edited['series'] else [{
            'id': 'chart-' + scene['sceneId'], 'kind': 'chart-shape', 'assetKind': 'graph',
            'pageIndex': scene['pageIndex'], 'bbox': scene['bbox'], 'author': author,
            'before': {'series': _public(scene)['series']}, 'after': {'series': _public(edited)['series']},
            'operations': copy.deepcopy(data['operations'])}]
        response = {'schema': 'falsify.visual-edit-export.v1', 'sourceSha256': data['fileHash'],
                'outputSha256': _sha(output), 'file': _b64(output), 'pageCount': pages,
                'revision': data['revision'], 'sceneId': scene['sceneId'], 'changes': changes,
                'verification': {'status': 'warning' if issues else 'passed', 'issues': issues,
                    'checks': ['page-count', 'extracted-text', 'outside-region-pixels'],
                    'scope': 'source-preservation', 'curveFidelity': 'not-independently-verified'},
                'report': report}
        self._check_publication(data, raw, scene, deadline, cancelled)
        return response

    def _check_publication(self, data, raw, scene, deadline, cancelled):
        from paper_native_worker import check
        with self._authority(data['paperId'], data['fileHash'], raw), self.lock:
            check(deadline, cancelled)
            entry = self.scenes.get(data['sceneId'])
            if not entry or entry['expires'] <= self.clock() or entry['scene'] != scene:
                raise ValueError('chart_scene_expired')
            if entry['paperId'] != data['paperId']:
                raise ValueError('chart_source_mismatch')


default_service = ChartEditService()

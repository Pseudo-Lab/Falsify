"""Bounded, short-lived native PDF operations with no store authority in the child."""
import base64, hashlib, json, os, re, subprocess, sys, threading, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from paper_enrichment import _stop
MAX_REQUEST = 80 * 1024 * 1024
MAX_RESPONSE = 100 * 1024 * 1024
TIMEOUT = 60
_IN_WORKER = False

def check(deadline, cancelled=None):
    if cancelled is not None and cancelled.is_set(): raise ValueError("native_cancelled")
    if time.monotonic() >= deadline: raise ValueError("native_timeout")

def budget():
    return time.monotonic() + TIMEOUT

def _pack(value):
    if isinstance(value, bytes):
        return {'__native_bytes__': base64.b64encode(value).decode('ascii'), 'size': len(value), 'sha256': hashlib.sha256(value).hexdigest()}
    if isinstance(value, dict): return {k: _pack(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)): return [_pack(v) for v in value]
    return value

def _unpack(value):
    if isinstance(value, dict):
        if set(value) == {'__native_bytes__', 'size', 'sha256'}:
            raw = base64.b64decode(value['__native_bytes__'], validate=True)
            if len(raw) != value['size'] or hashlib.sha256(raw).hexdigest() != value['sha256']: raise ValueError('native_output_invalid')
            return raw
        return {k: _unpack(v) for k, v in value.items()}
    if isinstance(value, list): return [_unpack(v) for v in value]
    return value

def _worker_response(chunks):
    try: response = json.loads(b''.join(chunks).decode('utf-8'))
    except (ValueError, UnicodeDecodeError): raise ValueError('native_output_invalid') from None
    if not isinstance(response, dict) or type(response.get('ok')) is not bool:
        raise ValueError('native_output_invalid')
    if not response['ok']:
        error = response.get('error')
        raise ValueError(error if isinstance(error, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,80}', error) else 'native_worker_failed')
    try: data = _unpack(response['data'])
    except (KeyError, TypeError, ValueError): raise ValueError('native_output_invalid') from None
    return data


def _wait_worker(process, finished, errors, deadline, cancelled):
    while not finished.wait(.1):
        if cancelled is not None and cancelled.is_set(): raise ValueError('native_cancelled')
        if time.monotonic() >= deadline: raise ValueError('native_timeout')
    if cancelled is not None and cancelled.is_set(): raise ValueError('native_cancelled')
    if time.monotonic() >= deadline: raise ValueError('native_timeout')
    if errors: raise ValueError('native_output_invalid')
    while process.poll() is None:
        check(deadline, cancelled)
        try: process.wait(timeout=min(.1, max(0, deadline - time.monotonic())))
        except subprocess.TimeoutExpired: pass


def _cleanup_worker(process, writer, reader):
    _stop(process)
    if process.poll() is None: process.wait(timeout=10)
    for thread in (writer, reader):
        if thread.ident is not None: thread.join(timeout=10)
    if not writer.is_alive() and not reader.is_alive():
        for pipe in (process.stdin, process.stdout):
            if pipe is not None and not pipe.closed: pipe.close()

def run(operation, args, *, cancelled=None, timeout=TIMEOUT, deadline=None):
    if _IN_WORKER:
        return _dispatch(operation, args)
    started = time.monotonic()
    deadline = min(deadline, started + timeout) if deadline is not None else started + timeout
    check(deadline, cancelled)
    encoded = json.dumps({'operation': operation, 'args': _pack(args)}, allow_nan=False).encode('utf-8')
    if len(encoded) > MAX_REQUEST: raise ValueError('native_input_limit')
    if cancelled is not None and cancelled.is_set(): raise ValueError('native_cancelled')
    if time.monotonic() >= deadline: raise ValueError('native_timeout')
    process = subprocess.Popen([sys.executable, '-I', str(HERE / 'paper_native_worker.py'), '--worker'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), shell=False)
    finished = threading.Event(); chunks = []; errors = []
    def write_input():
        try:
            process.stdin.write(encoded)
            process.stdin.close()
        except (OSError, ValueError): pass
    def read_output():
        try:
            size = 0
            while True:
                chunk = process.stdout.read(min(65536, MAX_RESPONSE + 1 - size))
                if not chunk: break
                chunks.append(chunk); size += len(chunk)
                if size > MAX_RESPONSE:
                    errors.append(ValueError('native_output_invalid')); break
        except Exception as exc: errors.append(exc)
        finally: finished.set()
    writer = threading.Thread(target=write_input, daemon=True)
    reader = threading.Thread(target=read_output, daemon=True)
    try:
        writer.start(); reader.start()
        _wait_worker(process, finished, errors, deadline, cancelled)
        if process.returncode: raise ValueError('native_worker_failed')
        data = _worker_response(chunks)
        if cancelled is not None and cancelled.is_set(): raise ValueError('native_cancelled')
        if time.monotonic() >= deadline: raise ValueError('native_timeout')
        return data
    finally:
        _cleanup_worker(process, writer, reader)


def _render_evidence(args):
    import pymupdf
    from paper_evidence import EvidenceStore, _pixel_size
    raw, index, bbox, dpi, pixel_limit = args
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        page = doc[index]
        clip = EvidenceStore()._clip(page.rect, bbox)
        width, height = _pixel_size(clip, dpi)
        if width * height > pixel_limit: raise ValueError('pixels')
        pix = page.get_pixmap(clip=pymupdf.Rect(clip), dpi=dpi, alpha=False)
        if pix.width * pix.height > pixel_limit: raise ValueError('pixels')
        return [clip, pix.tobytes('png'), pix.width, pix.height]


def _rebind_chart(source_override, scene, edited, options):
    from paper_chart_edit_service import _prepare_backend
    import copy
    fresh = _prepare_backend(source_override, scene['pageIndex'], scene['bbox'], options=options, preferred=scene.get('mode','curve'))
    key = lambda series: json.dumps({'color': series.get('color'), 'style': series.get('style'),
        'points': [[p['x'], p['y']] for p in series['points']]}, sort_keys=True)
    original = {}
    for i, series in enumerate(scene['series']): original.setdefault(key(series), []).append(i)
    fresh_edited = copy.deepcopy(fresh)
    if len(fresh['series']) != len(scene['series']): raise ValueError('chart_region_changed')
    for i, current in enumerate(fresh['series']):
        matches = original.get(key(current), [])
        if not matches: raise ValueError('chart_region_changed')
        fresh_edited['series'][i]['points'] = copy.deepcopy(edited['series'][matches.pop(0)]['points'])
    return source_override, fresh, fresh_edited


def _export_chart(args):
    from paper_chart_edit_service import _verify_output
    import pymupdf
    raw, scene, edited, source_override, options = args
    if source_override is not None and source_override != raw:
        raw, scene, edited = _rebind_chart(source_override, scene, edited, options)
    if scene.get('mode') == 'marks':
        from paper_chart_marks import export_marks
        output, report = export_marks(raw, scene, edited)
    else:
        from paper_chart_paint import export_scene
        output, report = export_scene(raw, scene, edited)
    if not isinstance(output, bytes) or not output.startswith(b'%PDF-'): raise ValueError('chart_export_invalid')
    with pymupdf.open(stream=output, filetype='pdf') as doc: pages = len(doc)
    issues = list(report.get('issues', [])) if isinstance(report, dict) else []
    issues.extend(_verify_output(raw, output, scene))
    return [output, report, pages, issues]


def _dispatch(operation, args):
    if operation == 'chart_prepare':
        import pymupdf
        from paper_chart_edit_service import _prepare_backend
        raw, index, bbox, options, preferred = args
        with pymupdf.open(stream=raw, filetype='pdf') as doc:
            if index >= len(doc) or not doc[index].rect.contains(pymupdf.Rect(bbox)): raise ValueError('chart_region_invalid')
        return _prepare_backend(raw, index, bbox, options=options, preferred=preferred)
    if operation == 'evidence_extract':
        from paper_evidence import EvidenceStore
        raw, digest = args
        return EvidenceStore()._extract(raw, digest)
    if operation == 'evidence_render':
        return _render_evidence(args)
    if operation == 'chart_evaluate':
        from paper_chart_shape_core import evaluate
        return evaluate(*args)
    if operation == 'chart_preview':
        from paper_chart_paint import render_scene, render_png
        raw, scene, edited = args
        if scene.get('mode') == 'marks':
            from paper_chart_marks import export_marks
            output, report = export_marks(raw, scene, edited)
            return {'png': render_png(output, scene['pageIndex'], scene['bbox'], scene.get('dpi', 72)), 'report': report}
        return render_scene(raw, scene, edited)
    if operation == 'chart_export':
        return _export_chart(args)
    if operation == 'chart_vectors':
        from paper_chart_vectors import prefer_native_paths
        return prefer_native_paths(args[0], **args[1])
    if operation == 'visual_export':
        from paper_visual_edit import _export_visual_native
        from paper_chart_edit_service import default_service
        request, raw, items, scenes = args
        class Snapshot:
            def source_bytes(self, paper_id, digest):
                if paper_id != request['paperId'] or hashlib.sha256(raw).hexdigest() != digest: raise ValueError('visual_source_mismatch')
                return raw
            def read_item(self, paper_id, item_id): return items[item_id]
            def render_region(self, paper_id, index, bbox=None, dpi=120):
                clip, png, width, height = _dispatch('evidence_render', [raw, index, bbox, dpi, 2_000_000])
                return {'sha256': hashlib.sha256(png).hexdigest()}
        store = Snapshot()
        default_service.store = store
        default_service.scenes = scenes
        return _export_visual_native(request, store=store)
    if operation == 'verify':
        from paper_chart_edit_service import _verify_output
        return _verify_output(args[0], args[1], None, regions=args[2])
    raise ValueError('native_operation_invalid')

def _worker():
    global _IN_WORKER
    _IN_WORKER = True
    sys.modules['paper_native_worker'] = sys.modules[__name__]
    sys.path.insert(0, str(HERE))
    try:
        request = json.loads(sys.stdin.buffer.read(MAX_REQUEST + 1).decode('utf-8'))
        data = _dispatch(request['operation'], _unpack(request['args']))
        response = {'ok': True, 'data': _pack(data)}
    except ValueError as exc:
        code = str(exc)
        response = {'ok': False, 'error': code if re.fullmatch(r'[a-z][a-z0-9_]{0,80}', code) else 'native_worker_failed'}
    except Exception: response = {'ok': False, 'error': 'native_worker_failed'}
    sys.stdout.buffer.write(json.dumps(response, allow_nan=False).encode('utf-8'))

if __name__ == '__main__' and sys.argv[1:] == ['--worker']: _worker()

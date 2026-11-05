"""Temporary OCR/chart analyses. Heavy models run in a short-lived child process."""
import base64
import copy
import hashlib
import json
import math
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMAS = {'ocr': 'falsify.ocr-page.v1', 'chart': 'falsify.chart-data.v1'}
MODEL_REVISIONS = {'ocr': 'rapidocr-3.10.0-img2table-2.0.0-spacing-1', 'chart': 'plottracer-dcc28a5-vector-2'}
RUNTIME_CONFIG = Path.home() / '.falsify' / 'paper-analysis-runtime.json'
MODEL_GATE = threading.Semaphore(1)


def runtime_python():
    configured = os.environ.get('FALSIFY_PAPER_ANALYSIS_PYTHON')
    if not configured and RUNTIME_CONFIG.is_file():
        try: configured = json.loads(RUNTIME_CONFIG.read_text(encoding='utf-8'))['python']
        except (ValueError, KeyError, OSError, TypeError): pass
    if configured:
        path = Path(configured)
        if not path.is_absolute() or not path.is_file(): raise ValueError('analysis_runtime_missing')
        return str(path)
    return sys.executable


def capability():
    try: runtime_python(); configured = bool(os.environ.get('FALSIFY_PAPER_ANALYSIS_PYTHON') or RUNTIME_CONFIG.is_file())
    except ValueError: configured = False
    return {'schema': 'falsify.paper-analysis.v1', 'supported': True, 'runtimeConfigured': configured,
            'kinds': ['ocr', 'chart'], 'modelResidency': 'per-request-child'}


def store_default():
    from paper_evidence import default_store
    return default_store


def _validate_options(data):
    if data.get('language', 'en') not in ('en', 'ko'): raise ValueError('analysis_language_invalid')
    if 'chartOptions' in data:
        if data['kind'] != 'chart': raise ValueError('analysis_request_invalid')
        from paper_plottracer import validate_options
        validate_options(data['chartOptions'])
    if 'requestId' in data and (not isinstance(data['requestId'], str) or not re.fullmatch(r'[a-f0-9]{32}', data['requestId'])):
        raise ValueError('analysis_request_id_invalid')
    box = data.get('bbox')
    if box is not None and (not isinstance(box, list) or len(box) != 4 or any(type(n) not in (int, float) or not math.isfinite(n) for n in box) or box[2] <= box[0] or box[3] <= box[1]):
        raise ValueError('analysis_region_invalid')
    return box


def validate(data, store=None):
    keys = {'paperId', 'fileHash', 'kind', 'pageIndex', 'bbox', 'language', 'requestId', 'chartOptions'}
    if not isinstance(data, dict) or not {'paperId', 'fileHash', 'kind', 'pageIndex'} <= set(data) or set(data) - keys:
        raise ValueError('analysis_request_invalid')
    if not isinstance(data['kind'], str) or data['kind'] not in SCHEMAS or type(data['pageIndex']) is not int or data['pageIndex'] < 0:
        raise ValueError('analysis_request_invalid')
    box = _validate_options(data)
    try: summary = (store or store_default()).status(data['paperId'])
    except (KeyError, TypeError): raise ValueError('paper_evidence_expired_or_missing') from None
    if data['fileHash'] != summary['fileHash']: raise ValueError('analysis_hash_mismatch')
    if data['pageIndex'] >= summary['pageCount']: raise ValueError('analysis_page_invalid')
    return {**data, 'bbox': box, 'language': data.get('language', 'en')}


def fingerprint(data):
    content = {k: v for k, v in data.items() if k != 'requestId'}
    return hashlib.sha256(json.dumps({**content, 'engineRevision': MODEL_REVISIONS[data['kind']]}, sort_keys=True).encode()).hexdigest()


def _stop(process):
    if process.poll() is not None: return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    else: process.kill()


def run_child(kind, png, language, cancelled, timeout=600, chart_options=None):
    """Fixed script/argv, private stdin, no shell or retained model process."""
    while not MODEL_GATE.acquire(timeout=0.25):
        if cancelled.is_set(): raise ValueError('analysis_cancelled')
    try:
        return _run_child(kind, png, language, cancelled, timeout, chart_options)
    finally:
        MODEL_GATE.release()


def _child_response(process, response):
    stdout, _ = response[0]
    if process.returncode or len(stdout) > 2 * 1024 * 1024: raise ValueError('analysis_worker_failed')
    try: envelope = json.loads(stdout.decode('utf-8'))
    except (ValueError, UnicodeDecodeError): raise ValueError('analysis_output_invalid') from None
    if not envelope.get('ok'): raise ValueError(envelope.get('error', 'analysis_worker_failed'))
    return envelope['data']


def _run_child(kind, png, language, cancelled, timeout, chart_options=None):
    if cancelled.is_set(): raise ValueError('analysis_cancelled')
    keep = ('PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
            'USERNAME', 'USER', 'LOGNAME', 'APPDATA', 'LOCALAPPDATA', 'HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'FALSIFY_MODEL_OFFLINE')
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update({'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'OMP_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2', 'TOKENIZERS_PARALLELISM': 'false'})
    if kind == 'chart': env['HF_HUB_OFFLINE'] = '1'
    encoded = json.dumps({'kind': kind, 'language': language, 'png': base64.b64encode(png).decode('ascii'), 'chartOptions':chart_options}).encode()
    process = subprocess.Popen([runtime_python(), '-I', str(HERE / 'paper_enrichment.py'), '--worker'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), shell=False)
    started = time.monotonic()
    finished = threading.Event()
    response, errors = [], []

    def exchange():
        try:
            response.append(process.communicate(input=encoded))
        except Exception as error:
            errors.append(error)
        finally:
            finished.set()

    # Keep one exchange alive until stdin reaches EOF. Retrying communicate
    # after a short timeout can strand a partial stdin write on POSIX.
    transport = threading.Thread(target=exchange, daemon=True)
    try:
        transport.start()
        while not finished.wait(0.1):
            if cancelled.is_set(): raise ValueError('analysis_cancelled')
            if time.monotonic() - started > timeout: raise ValueError('analysis_timeout')
        if cancelled.is_set(): raise ValueError('analysis_cancelled')
        if errors: raise ValueError('analysis_worker_failed') from errors[0]
        return _child_response(process, response)
    finally:
        _stop(process)
        if process.poll() is None: process.wait(timeout=10)
        if transport.ident is not None: transport.join(timeout=10)
        if not transport.is_alive():
            for pipe in (process.stdin, process.stdout):
                if pipe is not None and not pipe.closed: pipe.close()


def _map_boxes(data, region, width, height):
    """Keep raw image-pixel coordinates and provide a separately named PDF coordinate."""
    def mapped(box):
        if not isinstance(box, list) or len(box) != 4 or any(type(n) not in (int, float) or not math.isfinite(n) for n in box): return None
        if box[2] < box[0] or box[3] < box[1] or box[0] < -1 or box[1] < -1 or box[2] > width + 1 or box[3] > height + 1: return None
        return [round(region[0] + box[0] / width * (region[2]-region[0]), 4),
                round(region[1] + box[1] / height * (region[3]-region[1]), 4),
                round(region[0] + box[2] / width * (region[2]-region[0]), 4),
                round(region[1] + box[3] / height * (region[3]-region[1]), 4)]
    out = copy.deepcopy(data)
    for entry in out.get('lines', []) + out.get('tables', []):
        entry['sourceBbox'] = mapped(entry.get('bbox'))
        for cell in entry.get('cells', []): cell['sourceBbox'] = mapped(cell.get('bbox'))
        for token in entry.get('tokens',[]):token['sourceBbox']=mapped(token.get('bbox'))
    def point(p):
        box=mapped([p[0],p[1],p[0],p[1]]) if isinstance(p,list) and len(p)==2 else None
        return box[:2] if box else None
    def native_point(item):
        source = item.get('sourcePoint') if isinstance(item, dict) else None
        return item.get('sourcePointSpace') == 'page-rect' and isinstance(source, list) and len(source) == 2 and all(type(n) in (int, float) and not isinstance(n, bool) and math.isfinite(n) for n in source)
    for cell in out.get('numericCells',[]):
        if 'sourcePixel' in cell and not native_point(cell): cell['sourcePoint']=point(cell['sourcePixel'])
    geometry=out.get('geometry')
    if isinstance(geometry,dict):
        geometry['sourcePlotBbox']=mapped(geometry.get('plotBbox'))
        for axis in geometry.get('axes',{}).values():
            for tick in axis.get('ticks',[]):tick['sourceBbox']=mapped(tick.get('bbox'))
        for series in geometry.get('series',[]):
            for item in series.get('points',[]):
                if not native_point(item): item['sourcePoint']=point([item['xPixel'],item['yPixel']])
    return out


def _validate_result(result, request, image):
    if not isinstance(result, dict) or result.get('schema') != SCHEMAS[request['kind']] or result.get('status') not in ('ready', 'partial', 'unavailable'):
        raise ValueError('analysis_output_invalid')
    if result.get('image', {}).get('sha256') != image['sha256'] or result['image'].get('width') != image['width'] or result['image'].get('height') != image['height']:
        raise ValueError('analysis_image_mismatch')


def _require_available(result):
    if result['status'] == 'unavailable':
        if any(code in ('rapidocr-missing','img2table-missing') for code in result.get('issues',[])):
            raise ValueError('analysis_dependency_missing')
        raise ValueError('analysis_engine_unavailable')


def _render_analysis(store, request, cancelled):
    dpi = 200 if request['kind'] == 'ocr' else 150
    while True:
        try: image = store.render_for_analysis(request['paperId'], request['pageIndex'], request['bbox'], dpi=dpi, cancelled=cancelled); break
        except ValueError as error:
            if error.args != ('pixels',) or dpi <= 50: raise
            dpi = int(dpi * 0.75)
    return image, dpi


def _chart_vector_result(store, request, image, dpi, result, options, cancelled):
    from paper_native_worker import run
    spec = options if isinstance(options, dict) else {}
    result = run('chart_vectors', [store.source_bytes(request['paperId'], request['fileHash']),
        {'page_index':request['pageIndex'], 'crop':image['bbox'], 'dpi':dpi, 'width':image['width'],
         'height':image['height'], 'raster':result, 'calibration':spec.get('calibration'),
         'series':spec.get('series'), 'plot_bbox':spec.get('plotBbox')}], cancelled=cancelled)
    return result


def analyze(data, *, store=None, runner=None, cancelled=None, progress=None):
    store = store or store_default()
    request = validate(data, store)
    cancelled = cancelled or threading.Event()
    progress = progress or (lambda _: None)
    key = fingerprint(request)
    cached = store.find_analysis(request['paperId'], key)
    if cached: return cached
    if cancelled.is_set(): raise ValueError('analysis_cancelled')
    progress({'phase': 'rendering', 'kind': request['kind']})
    image, dpi = _render_analysis(store, request, cancelled)
    png = base64.b64decode(image['data'], validate=True)
    progress({'phase': 'recognizing' if request['kind'] == 'ocr' else 'reading-chart', 'kind': request['kind']})
    started = time.monotonic()
    options = request.get('chartOptions')
    if options is not None and options['imageSha256'] != image['sha256']:
        raise ValueError('chart_image_mismatch')
    result = (runner or run_child)(request['kind'], png, request['language'], cancelled, chart_options=options) if options is not None else (runner or run_child)(request['kind'], png, request['language'], cancelled)
    if cancelled.is_set(): raise ValueError('analysis_cancelled')
    _validate_result(result, request, image)
    if request['kind'] == 'chart':
        result = _chart_vector_result(store, request, image, dpi, result, options, cancelled)
    _require_available(result)
    entry = {'paperId': request['paperId'], 'fileHash': request['fileHash'], 'kind': request['kind'],
             'pageIndex': request['pageIndex'], 'bbox': image['bbox'], 'language': request['language'],
             'inputImage': {k: image[k] for k in ('sha256', 'width', 'height')} | {'dpi': dpi},
             'elapsedMs': round((time.monotonic()-started)*1000),
             'data': _map_boxes(result, image['bbox'], image['width'], image['height'])}
    progress({'phase': 'completed', 'kind': request['kind']})
    return store.add_analysis(request['paperId'], entry, key)


class AnalysisJobs:
    def __init__(self, store=None, runner=None, retention=3600):
        self.store, self.runner, self.retention = store, runner, retention
        self.jobs, self.lock = {}, threading.RLock()

    def _public(self, job, alias=None):
        result = copy.deepcopy({k: v for k, v in job.items() if k not in ('cancel', 'fingerprint', 'finished')})
        if alias: result['id'] = alias
        return result

    def submit(self, data, admit=lambda: True, release=lambda: None):
        request = validate(data, self.store)
        key = fingerprint(request)
        request_id = request.get('requestId') or secrets.token_hex(16)
        with self.lock:
            now = time.monotonic()
            self.jobs = {k: v for k, v in self.jobs.items() if v.get('finished', now) >= now-self.retention}
            if request_id in self.jobs:
                job = self.jobs[request_id]
                if job['fingerprint'] != key: raise ValueError('analysis_request_id_conflict')
                return self._public(job, request_id)
            existing = next((job for job in self.jobs.values() if job['fingerprint'] == key and job['state'] in ('running', 'completed')), None)
            if existing:
                if len(self.jobs) >= 32: raise ValueError('analysis_job_limit')
                self.jobs[request_id] = existing
                return self._public(existing, request_id)
            if len(self.jobs) >= 32: raise ValueError('analysis_job_limit')
            if not admit(): raise ValueError('companion_busy')
            job = {'id': request_id, 'state': 'running', 'paperId': request['paperId'], 'fileHash': request['fileHash'],
                   'kind': request['kind'], 'progress': {'phase': 'starting'}, 'fingerprint': key, 'cancel': threading.Event()}
            self.jobs[job['id']] = job
            thread = threading.Thread(target=self._work, args=(job, request, release), daemon=True)
            try: thread.start()
            except Exception:
                self.jobs.pop(job['id']); release(); raise
            return self._public(job)

    def _work(self, job, request, release):
        def progress(value):
            with self.lock: job['progress'] = value
        try:
            result = analyze(request, store=self.store, runner=self.runner, cancelled=job['cancel'], progress=progress)
            with self.lock:
                if job['cancel'].is_set(): job['state'] = 'cancelled'
                else: job.update(state='completed', result=result)
        except Exception as error:
            code = error.args[0] if isinstance(error, ValueError) and error.args else 'analysis_failed'
            if not isinstance(code, str) or not code.replace('_', '').isalnum() or len(code) > 80: code = 'analysis_failed'
            with self.lock: job.update(state='cancelled' if job['cancel'].is_set() else 'failed', error=code)
        finally:
            with self.lock: job['finished'] = time.monotonic()
            release()

    def get(self, job_id):
        with self.lock:
            if job_id not in self.jobs: raise ValueError('analysis_job_missing')
            return self._public(self.jobs[job_id], job_id)

    def cancel(self, job_id):
        with self.lock:
            if job_id not in self.jobs: raise ValueError('analysis_job_missing')
            self.jobs[job_id]['cancel'].set()
            return self._public(self.jobs[job_id], job_id)

    def shutdown(self):
        with self.lock:
            for job in self.jobs.values(): job['cancel'].set()
        # A model child checks cancellation every 250ms and kills its own process
        # tree. Give those threads time to release memory before parent shutdown.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.lock:
                if not any(job['state']=='running' for job in self.jobs.values()): return
            time.sleep(0.05)


def _worker():
    import contextlib
    # -I ignores PYTHONIOENCODING; Windows pipe encoding can otherwise be CP949.
    # The parent decodes this machine-readable response as UTF-8 on every OS.
    sys.stdout.reconfigure(encoding='utf-8')
    sys.path.insert(0, str(HERE))
    try:
        raw = sys.stdin.buffer.read(42 * 1024 * 1024 + 1)
        if len(raw) > 42 * 1024 * 1024: raise ValueError('analysis_input_limit')
        request = json.loads(raw.decode('utf-8'))
        png = base64.b64decode(request['png'], validate=True)
        with contextlib.redirect_stdout(sys.stderr):
            if request['kind'] == 'ocr':
                from paper_ocr import recognize
                result = recognize(png, language=request['language'])
            elif request['kind'] == 'chart':
                from paper_chart import extract_chart
                result = extract_chart(png, options={'chartOptions':request['chartOptions']} if request.get('chartOptions') is not None else None)
            else: raise ValueError('analysis_request_invalid')
        response = {'ok': True, 'data': result}
    except ImportError: response = {'ok': False, 'error': 'analysis_dependency_missing'}
    except Exception: response = {'ok': False, 'error': 'analysis_engine_failed'}
    print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == '__main__' and sys.argv[1:] == ['--worker']: _worker()

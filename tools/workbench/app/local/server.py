"""Loopback-only Falsify UI + authenticated operation-allowlisted broker.

Run from the original checkout: python app/local/server.py
By default the hosted site cannot connect across origins to this server. With an explicit
--web-origin https://<exact-origin> opt-in, that one origin may call the allowlisted API
operations via CORS. Manual mode still prints the process bearer token in this terminal.
Click-pairing (--token-display hidden) does not print it and does not send it to the website:
the launcher approves the fixed origin, then the browser redeems a separate short-lived credential.
"""
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer as _NativeThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
from red_service import run_review, validate_request
from preserve import handle_export
from blue_service import run_review as run_blue_review, validate_request as validate_blue_request
from harness import CLI_AGENTS, EFFORTS, resolve
import cli_backend
import editor_service
import paper_analysis_service
import image_edit_service
import harness_adapter
import harness_profile
import harness_deployment
import subprocess
import pairing
from build_info import WORKBENCH_VERSION
from experiments.selfplay_codex import discover_codex

DIST = Path(__file__).resolve().parents[1] / 'dist'
TOKEN = secrets.token_urlsafe(32)
JOBS = {}
LOCK = threading.Lock()
ACTIVE = threading.BoundedSemaphore(1)
LIFECYCLE_SCHEMA = 'falsify-companion-lifecycle/1'
RESULT_RETENTION = 3600

def companion_instance_descriptor(instance_id):
    """Public per-process identity for reload checks. Not the launcher restart secret."""
    raw = instance_id.encode('utf-8')
    digest = hashlib.sha256(b'falsify.companion-instance.v1\n' + raw).hexdigest()
    if instance_id in digest:
        digest = hashlib.sha256(b'falsify.companion-instance.refold.v1\n' + digest.encode('ascii')).hexdigest()
    descriptor = 'ci1.' + digest
    if instance_id in descriptor:
        raise RuntimeError('companion instance descriptor collided with the launcher id')
    return descriptor

def job_binding(data, role, instance_id):
    """Fields a reload GET must echo. Hashes only; not the pairing secret or the file bytes."""
    _, harness_hash = resolve(data, role)
    source, revision = data.get('sourceHash'), data.get('revision')
    if not isinstance(source, str) or not isinstance(revision, str) or not isinstance(harness_hash, str):
        raise ValueError('작업 식별이 없습니다.')
    return {'sourceHash': source, 'revision': revision, 'harnessHash': harness_hash,
            'companionInstance': companion_instance_descriptor(instance_id)}

def request_bytes_digest(raw):
    """SHA-256 of the exact HTTP body bytes, computed before JSON parsing.
    This is not the sorted idempotency fingerprint and not the browser canonical checksum."""
    if not isinstance(raw, (bytes, bytearray)) or not raw:
        raise ValueError('요청 바이트가 없습니다.')
    return hashlib.sha256(bytes(raw)).hexdigest()

def public_job(job):
    hidden = ('cancel', 'fingerprint', 'created', 'finished')
    return {k: v for k, v in job.items() if k not in hidden}

def drop_expired_jobs(now=None):
    """Finished jobs leave memory after RESULT_RETENTION. A running job has no finished time and stays."""
    now = time.monotonic() if now is None else now
    for key in list(JOBS):
        old = JOBS[key]
        if old.get('finished', float('inf')) < now - RESULT_RETENTION:
            del JOBS[key]

class ThreadingHTTPServer(_NativeThreadingHTTPServer):
    """On Windows SO_REUSEADDR lets a later bind take over a live listener; claim the port exclusively instead.
    Elsewhere keep the stdlib default (normal restart over TIME_WAIT; a live listener still refuses the bind)."""
    if os.name == 'nt': allow_reuse_address = False
    web_origin = None
    pdf_editor = None
    def __init__(self, *args, **kwargs):
        # Per-instance launcher identity and restart state; a restart holds ACTIVE until the server closes.
        self.instance_id = secrets.token_urlsafe(24)
        self.closing = False
        self.restart_reserved = False
        super().__init__(*args, **kwargs)
    def server_bind(self):
        if os.name == 'nt': self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()
    def server_close(self):
        super().server_close()
        with LOCK:
            if self.restart_reserved: self.restart_reserved = False; ACTIVE.release()

def busy_locked(server):
    """Caller holds LOCK. Returns (busy, reserved): reserved means ACTIVE was acquired and the caller owns it.
    Completed results are protected too: any job finished within the retention window counts as busy."""
    if server.closing: return True, False
    if not ACTIVE.acquire(blocking=False): return True, False
    now = time.monotonic()
    if any(job.get('finished', float('inf')) >= now - RESULT_RETENTION for job in JOBS.values()):
        ACTIVE.release(); return True, False
    return False, True
CORS_HEADERS = {'authorization', 'content-type'}
IMAGE_ROUTES = ('/api/paper/images', '/api/paper/images/export')
PROFILE_ROUTE = '/api/harness/profile/propose'
DEPLOY_ROUTE = '/api/harness/deploy'
HOST_LABEL = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?')

def parse_web_origin(value):
    """One exact https origin as browsers serialize it in the Origin header, else ValueError."""
    if not isinstance(value, str) or not value.startswith('https://'): raise ValueError('web origin must be https://host')
    rest = value[len('https://'):]
    host, sep, port = rest.partition(':')
    labels = host.split('.')
    if not host or len(host) > 253 or len(labels) < 2 or not all(HOST_LABEL.fullmatch(label) for label in labels):
        raise ValueError('web origin must be exactly https://host[:port] with a lowercase DNS host (no path, query, fragment, credentials, wildcard or list)')
    if sep:
        if not port.isascii() or not port.isdigit() or port.startswith('0') or not 1 <= int(port) <= 65535 or int(port) == 443:
            raise ValueError('web origin port must be 1–65535 without leading zeros (omit default 443)')
    return value

def cors_route(method, path):
    """Allowlisted API operations a configured web origin may reach.

    Pair redeem/status/revoke are included so the approved origin can finish one-time pairing.
    Pair register, /api/session and launcher routes stay off this list.
    """
    if method == 'GET': return path in ('/api/capabilities', pairing.STATUS_PATH) or re.fullmatch(r'/api/(red|blue)/jobs/.+', path) is not None
    if method == 'POST': return path in ['/api/red/jobs', '/api/blue/jobs', '/api/export', '/api/paper/inspect', *IMAGE_ROUTES, PROFILE_ROUTE, DEPLOY_ROUTE, pairing.REDEEM_PATH, pairing.REVOKE_PATH] or re.fullmatch(r'/api/(red|blue)/jobs/.+/cancel', path) is not None
    return False

def no_duplicates(items):
    result = {}
    for k, v in items:
        if k in result: raise ValueError('중복 JSON 키')
        result[k] = v
    return result

def cli_agents():
    """Install presence and model suggestions only: no paths, accounts or tokens; not an access catalog."""
    def present(discover):
        try:
            discover()
            return True
        except (OSError, ValueError):
            return False
    found = {'codex': present(discover_codex), 'claude': present(cli_backend.discover_claude)}
    return [{'id': key, 'name': agent['name'], 'installed': found[key], 'defaultModel': agent['defaultModel'],
             'models': list(agent['models']), 'efforts': list(EFFORTS)} for key, agent in CLI_AGENTS.items()]

def work(job, data):
    try:
        def progress(p):
            with LOCK: job['progress'] = p
        result = (run_blue_review if job['role'] == 'blue' else run_review)(data, progress, job['cancel'])
        with LOCK:
            job['state'] = 'cancelled' if job['cancel'].is_set() else 'completed'
            if job['state'] == 'completed': job['result'] = result
    except Exception as error:
        with LOCK:
            job['state'] = 'cancelled' if job['cancel'].is_set() else 'failed'
            if isinstance(error, harness_adapter.AdapterFailure):
                failure = error
            else:
                # Only exact first-party service labels are recognized; no stderr parsing.
                message = str(error) if isinstance(error, ValueError) else ''
                cli_codes = {'subscription_login_required': 'auth_required', 'FileNotFoundError': 'executable_missing',
                             'timeout': 'timeout', 'output_limit': 'invalid_output',
                             'response_not_object': 'invalid_output', 'protocol_violation': 'invalid_output'}
                prefixes = ('CLI 검토 중단: ', 'CLI BLUE 중단: ')
                cli_code = next((message[len(prefix):] for prefix in prefixes if message.startswith(prefix)), None)
                failure = harness_adapter.AdapterFailure(cli_codes.get(cli_code, 'unknown')) if cli_code is not None else None
            if failure:
                job['failure'] = failure.payload()
                job['error'] = str(failure)
            else:
                job['error'] = str(error) if isinstance(error, ValueError) else '로컬 실행 오류. CLI 로그인·설치 상태를 확인하세요.'
    finally:
        with LOCK: job['finished'] = time.monotonic()
        ACTIVE.release()

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    def log_message(self, *_): pass  # No papers, tokens, prompts or login diagnostics in access logs.
    def setup(self):
        super().setup(); self.connection.settimeout(15)
    @property
    def origin(self): return 'http://127.0.0.1:' + str(self.server.server_port)
    def host_ok(self): return self.headers.get('Host') == '127.0.0.1:' + str(self.server.server_port)
    @property
    def web_origin(self): return getattr(self.server, 'web_origin', None)
    def from_web_origin(self):
        return self.web_origin is not None and self.host_ok() and self.headers.get('Origin') == self.web_origin
    def cors_ok(self): return self.from_web_origin() and cors_route(self.command, unquote(urlsplit(self.path).path))
    def reply(self, status, payload, mime='application/json; charset=utf-8'):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status); self.send_header('Content-Type', mime); self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store'); self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer'); self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        if self.web_origin is not None:
            self.send_header('Vary', 'Origin')
            if self.cors_ok(): self.send_header('Access-Control-Allow-Origin', self.web_origin)
        self.end_headers(); self.wfile.write(raw)
    def authorized(self):
        if not self.host_ok(): return False
        origin = self.headers.get('Origin')
        if not self.cors_ok() and origin != self.origin and not (self.command == 'GET' and origin is None and self.headers.get('Sec-Fetch-Site') == 'same-origin'): return False
        presented = self.headers.get('Authorization', '')
        if hmac.compare_digest(presented, 'Bearer ' + TOKEN): return True
        # Reconnect credentials authorize only CORS allowlisted routes, never same-origin bootstrap or the launcher.
        if not self.cors_ok(): return False
        store = getattr(self.server, 'pairing', None)
        if store is None or not presented.startswith('Bearer ') or presented.count(' ') != 1: return False
        return store.allows(presented[7:], self.web_origin, self.server.server_port)
    def server_closing(self):
        # Caller holds LOCK. Closing is permanent: requests accepted before shutdown never admit work afterwards,
        # even once server_close has released the restart reservation.
        return getattr(self.server, 'closing', False)
    def launcher_authorized(self):
        """Native launcher only: exact loopback Host, bearer token, launcher marker, and no browser fetch metadata."""
        if not self.host_ok() or 'Origin' in self.headers or 'Sec-Fetch-Site' in self.headers: return False
        if self.headers.get_all('X-Falsify-Launcher') != ['1']: return False
        auth = self.headers.get_all('Authorization') or []
        return len(auth) == 1 and hmac.compare_digest(auth[0].encode('utf-8', 'surrogatepass'), ('Bearer ' + TOKEN).encode())
    def launcher_instance(self):
        if not self.launcher_authorized(): self.reply(403, {'error': 'unauthorized'}); return
        with LOCK:
            busy, reserved = busy_locked(self.server)
            if reserved: ACTIVE.release()
        self.reply(200, {'schema': LIFECYCLE_SCHEMA, 'pid': os.getpid(), 'instanceId': self.server.instance_id,
            'serverPath': str(Path(__file__).resolve()), 'webOrigin': self.web_origin, 'busy': busy})
    def launcher_restart(self):
        if not self.launcher_authorized(): self.reply(403, {'error': 'unauthorized'}); return
        try:
            if self.headers.get_all('Content-Type') != ['application/json']: raise ValueError('application/json required')
            lengths = self.headers.get_all('Content-Length') or []
            if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit(): raise ValueError('Content-Length required')
            size = int(lengths[0])
            if not 1 <= size <= 1024: raise ValueError('body size limit')
            raw = self.rfile.read(size)
            if len(raw) != size: raise ValueError('body truncated')
            data = json.loads(raw.decode('utf-8'), object_pairs_hook=no_duplicates, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
            if not isinstance(data, dict) or set(data) != {'schema', 'instanceId'}: raise ValueError('expected exactly schema and instanceId')
            if data['schema'] != LIFECYCLE_SCHEMA or not isinstance(data['instanceId'], str): raise ValueError('invalid lifecycle request')
        except (ValueError, UnicodeDecodeError): self.reply(400, {'error': 'invalid_request'}); return
        if not hmac.compare_digest(data['instanceId'].encode('utf-8', 'surrogatepass'), self.server.instance_id.encode()):
            self.reply(409, {'error': 'instance_mismatch'}); return
        with LOCK:
            busy, reserved = busy_locked(self.server)
            if reserved: self.server.closing = True; self.server.restart_reserved = True
        if busy: self.reply(409, {'error': 'companion_busy'}); return
        # ACTIVE stays reserved (no new RED/BLUE/export admission) until server_close; shut down after the reply is sent.
        try:
            self.reply(200, {'restarting': True}); self.wfile.flush()
        finally:
            threading.Thread(target=self.server.shutdown, daemon=True).start()
    def do_OPTIONS(self):
        method = self.headers.get('Access-Control-Request-Method', '')
        requested = {h.strip().lower() for h in self.headers.get('Access-Control-Request-Headers', '').split(',') if h.strip()}
        path = unquote(urlsplit(self.path).path)
        if not self.from_web_origin() or not cors_route(method, path) or not requested <= CORS_HEADERS:
            self.reply(403, {'error': 'cross_origin_denied'}); return
        self.send_response(204); self.send_header('Content-Length', '0'); self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff'); self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Vary', 'Origin'); self.send_header('Access-Control-Allow-Origin', self.web_origin)
        self.send_header('Access-Control-Allow-Methods', method); self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Max-Age', '600')
        if self.headers.get('Access-Control-Request-Private-Network') == 'true': self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()
    def do_GET(self):
        if not self.host_ok(): self.reply(403, {'error': 'host_denied'}); return
        path = unquote(urlsplit(self.path).path)
        if path == '/api/session':
            # Token bootstrap stays same-origin only: never for any other Origin, including the configured web origin.
            origin = self.headers.get('Origin')
            if (origin is not None and origin != self.origin) or self.headers.get('Sec-Fetch-Site') != 'same-origin':
                self.reply(403, {'error': 'same_origin_browser_required'}); return
            self.reply(200, {'token': TOKEN, 'mode': 'loopback-only', 'model': 'gpt-6.1-sol'}); return
        if path == '/api/launcher/instance': self.launcher_instance(); return
        if path == pairing.STATUS_PATH: pairing.handle_status(self); return
        if path.startswith('/api/'):
            if not self.authorized(): self.reply(403, {'error': 'unauthorized'}); return
            if path == '/api/capabilities':
                try:
                    import pymupdf
                    pdf = True
                except ImportError: pdf = False
                # Configured companions export only through the probed editor; unconfigured ones keep the legacy path.
                editor = getattr(self.server, 'pdf_editor', None)
                pdf_editor = editor.capability() if editor else editor_service.unconfigured_capability()
                if editor: pdf = pdf_editor['available']
                self.reply(200, {'red': True, 'blue': True, 'pdf': pdf, 'officeLayoutVerifiedExport': False,
                    'model': 'gpt-6.1-sol', 'isolation': 'read-only CLI restrictions; not OS-enforced input-only isolation',
                    'cliSelection': True, 'harnessWrapper': True, 'cliAgents': cli_agents(), 'pdfEditor': pdf_editor,
                    'paperAnalysis': paper_analysis_service.capability(), 'imageEditor': image_edit_service.capability(),
                    'harnessProfileProposal': harness_profile.capability(), 'harnessDeployment': True,
                    'workbenchVersion': WORKBENCH_VERSION,
                    'companionInstance': companion_instance_descriptor(self.server.instance_id)}); return
            with LOCK:
                role = 'blue' if path.startswith('/api/blue/jobs/') else 'red'
                prefix = '/api/' + role + '/jobs/'
                job = JOBS.get(path.removeprefix(prefix)) if path.startswith(prefix) else None
                if job and job['role'] != role: job = None
                response = public_job(job) if job else None
            self.reply(200 if response else 404, response or {'error': 'not_found'}); return
        if self.headers.get('Sec-Fetch-Site') == 'cross-site': self.reply(403, {'error': 'cross_site_denied'}); return
        if path == '/': path = '/index.html'
        target = (DIST / path.lstrip('/')).resolve()
        if not target.is_relative_to(DIST.resolve()) or not target.is_file() or any(part.startswith('.') for part in Path(path).parts) or target.suffix not in ['.html', '.css', '.js', '.mjs', '.json', '.bcmap', '.pfb', '.ttf', '.otf', '.wasm', '.txt']:
            self.reply(404, {'error': 'not_found'}); return
        mime = 'application/javascript' if target.suffix in ['.js', '.mjs'] else mimetypes.guess_type(target)[0] or 'application/octet-stream'
        self.reply(200, target.read_bytes(), mime)
    def do_POST(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/api/launcher/restart': self.launcher_restart(); return
        if path == pairing.REGISTER_PATH: pairing.handle_register(self); return
        if path == pairing.REDEEM_PATH: pairing.handle_redeem(self); return
        if path == pairing.REVOKE_PATH: pairing.handle_revoke(self); return
        if not self.authorized(): self.reply(403, {'error': 'unauthorized'}); return
        path = unquote(urlsplit(self.path).path)
        role = 'blue' if path.startswith('/api/blue/jobs') else 'red'
        prefix = '/api/' + role + '/jobs'
        if path not in ['/api/red/jobs', '/api/blue/jobs', '/api/export', '/api/paper/inspect', *IMAGE_ROUTES, PROFILE_ROUTE, DEPLOY_ROUTE] and not (path.startswith(prefix + '/') and path.endswith('/cancel')):
            self.reply(404, {'error': 'operation_not_allowed'}); return
        try:
            if self.headers.get('Content-Type') != 'application/json': raise ValueError('application/json 필요')
            size = int(self.headers.get('Content-Length', '-1'))
            limit = 40 * 1024 * 1024 if path == '/api/paper/images/export' else 37 * 1024 * 1024 if path in ['/api/export', '/api/paper/inspect', '/api/paper/images'] else 6 * 1024 * 1024
            if not 1 <= size <= limit: raise ValueError('본문 크기 제한 초과')
            raw = self.rfile.read(size)
            if len(raw) != size: raise ValueError('본문 수신 중단')
            body_digest = request_bytes_digest(raw) if path in ('/api/red/jobs', '/api/blue/jobs') else None
            data = json.loads(raw.decode('utf-8'), object_pairs_hook=no_duplicates, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite JSON')))
            if not isinstance(data, dict): raise ValueError('JSON 객체 필요')
            if path.endswith('/cancel'):
                with LOCK:
                    job = JOBS.get(path.split('/')[-2])
                    if not job or job['role'] != role: raise ValueError('작업을 찾을 수 없습니다.')
                    job['cancel'].set()
                    if job['state'] == 'completed': job['state'] = 'cancelled'; job.pop('result', None)
                self.reply(200, {'status': 'cancel_requested'}); return
            if path == '/api/export':
                with LOCK: admitted = not self.server_closing() and ACTIVE.acquire(blocking=False)
                if not admitted: self.reply(409, {'error': '다른 작업을 마친 뒤 내보내세요.'}); return
                editor = getattr(self.server, 'pdf_editor', None)
                try: result = editor.export(data) if editor else handle_export(data)
                finally: ACTIVE.release()
                self.reply(200, result); return
            if path == '/api/paper/inspect':
                # Advisory, explicit-click inspection: validated before admission, gated like export (not a JOB, so retained
                # RED/BLUE results stay protected), never a model call; any helper failure is the fixed unavailable summary.
                request = paper_analysis_service.validate_request(data)
                with LOCK: admitted = not self.server_closing() and ACTIVE.acquire(blocking=False)
                if not admitted: self.reply(409, {'error': 'companion_busy'}); return
                try: result = paper_analysis_service.analyze(request)
                finally: ACTIVE.release()
                self.reply(200, result); return
            if path in IMAGE_ROUTES:
                # Manual RED-only image experiment: bytes, hash and PNG header are validated before admission; the engine runs only
                # in the isolated child, gated like export (not a JOB, never a model call); fixed error codes only.
                export = path == '/api/paper/images/export'
                request = (image_edit_service.validate_export_request if export else image_edit_service.validate_list_request)(data)
                with LOCK: admitted = not self.server_closing() and ACTIVE.acquire(blocking=False)
                if not admitted: self.reply(409, {'error': 'companion_busy'}); return
                try: result = (image_edit_service.export_image if export else image_edit_service.list_images)(request)
                except image_edit_service.ImageEditError as error: self.reply(error.status, error.payload()); return
                finally: ACTIVE.release()
                self.reply(200, result); return
            if path == DEPLOY_ROUTE:
                with LOCK: admitted = not self.server_closing() and ACTIVE.acquire(blocking=False)
                if not admitted: self.reply(409, {'error': 'companion_busy'}); return
                try:
                    try: result = harness_deployment.deploy(data)
                    except (ValueError, OSError, subprocess.SubprocessError):
                        self.reply(400, {'error': 'harness_deployment_failed'}); return
                finally: ACTIVE.release()
                self.reply(200, result); return
            if path == PROFILE_ROUTE:
                # Explicit-click profile draft: validated before admission, gated like inspect (not a JOB), one prompt-only CLI
                # call; the proposed executable is never run here. Fixed error codes only.
                request = harness_profile.validate_request(data)
                with LOCK: admitted = not self.server_closing() and ACTIVE.acquire(blocking=False)
                if not admitted: self.reply(409, {'error': 'companion_busy'}); return
                try: result = harness_profile.propose(request)
                except harness_profile.ProposalError as error: self.reply(error.status, error.payload()); return
                finally: ACTIVE.release()
                self.reply(200, result); return
            (validate_blue_request if role == 'blue' else validate_request)(data)
            binding = job_binding(data, role, self.server.instance_id)
            # Idempotency stays the parsed, key-sorted fingerprint. requestBytesDigest is the pre-parse wire hash.
            fingerprint = json.dumps(data, sort_keys=True, ensure_ascii=False)
            request_id = data['requestId']
            with LOCK:
                drop_expired_jobs()
                existing = JOBS.get(request_id)
                if existing:
                    if existing['role'] != role or existing['fingerprint'] != fingerprint: raise ValueError('같은 요청 ID의 내용이 달라졌습니다.')
                    self.reply(200, {'id': request_id, 'state': existing['state']}); return
                if len(JOBS) >= 16: raise ValueError('메모리 작업 제한. 완료 후 서버를 재시작하세요.')
                if self.server_closing() or not ACTIVE.acquire(blocking=False): self.reply(409, {'error': '이미 실행 중입니다. 재시도는 자동 호출되지 않습니다.'}); return
                job = {'id': request_id, 'role': role, 'state': 'running', 'progress': {'completedCalls': 0}, 'cancel': threading.Event(),
                    'fingerprint': fingerprint, 'requestBytesDigest': body_digest, 'created': time.monotonic(), **binding}
                JOBS[request_id] = job
                threading.Thread(target=work, args=(job, data), daemon=True).start()
            self.reply(202, {'id': request_id, 'state': 'running'})
        except ValueError as error: self.reply(400, {'error': str(error)})
        except Exception: self.reply(500, {'error': '로컬 처리 오류. 파일/설치 상태를 확인하세요.'})

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--port', type=int, default=7816)
    parser.add_argument('--web-origin', help='opt-in: one exact https origin allowed to call the API')
    parser.add_argument('--token-display', choices=('visible', 'hidden'), default='visible', help='visible prints the process token for manual paste; hidden is click-pairing')
    parser.add_argument('--pairing-dir', help='private reconnect-key directory outside this checkout')
    parser.add_argument('--pdf-editor-root', help=f'opt-in: absolute falsify-pdf-editor module root (or {editor_service.ENV_ROOT})')
    parser.add_argument('--pdf-editor-manifest', help=f'absolute patched candidate-manifest.json (or {editor_service.ENV_MANIFEST})')
    parser.add_argument('--pdf-editor-source-root', help=f'absolute pinned editor app source root (or {editor_service.ENV_SOURCE_ROOT})')
    parser.add_argument('--pdf-editor-node', help=f'absolute Node {editor_service.MIN_NODE_MAJOR}+ executable (or {editor_service.ENV_NODE}; default: node on PATH)')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535: parser.error('port must be 1024–65535')
    web_origin = None
    if args.web_origin is not None:
        try: web_origin = parse_web_origin(args.web_origin)
        except ValueError as error: parser.error(str(error))
    if args.pairing_dir is not None and web_origin is None: parser.error('pairing directory requires --web-origin')
    try: editor_config = editor_service.config_from(args.pdf_editor_root, args.pdf_editor_manifest, args.pdf_editor_source_root, args.pdf_editor_node)
    except ValueError as error: parser.error(str(error))
    pairing_store = None
    if web_origin is not None:
        try:
            directory = Path(args.pairing_dir) if args.pairing_dir else pairing.default_pairing_dir()
            pairing_store = pairing.PairingStore(directory).ensure_key()
        except pairing.PairingError as error: parser.error('pairing store refused: ' + error.code)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    server.web_origin = web_origin
    server.pairing = pairing_store
    server.pdf_editor = editor_service.PdfEditorService(editor_config) if editor_config else None
    print(f'Falsify local: http://127.0.0.1:{args.port}/ (loopback only; Ctrl+C to stop)', flush=True)
    if server.pdf_editor:
        print('PDF editor: falsify-pdf-editor configured (capability probe runs in background; no legacy fallback)', flush=True)
        threading.Thread(target=server.pdf_editor.capability, daemon=True).start()
    if web_origin and args.token_display == 'hidden':
        print(f'Web origin enabled: {web_origin}\n'
            '  Click-pairing is active for this exact origin. The process token is not displayed\n'
            '  and is never sent to the website. A short-lived reconnect credential is issued only\n'
            '  after local approval. Manual paste remains available if you start again with the token visible.', flush=True)
    elif web_origin:
        print(f'Web origin enabled: {web_origin}\n'
            '  Trust is origin-level, not path-level: every page on that origin (any repository or path\n'
            '  published under it) that holds the pairing token can run RED/BLUE jobs, PDF export,\n'
            '  advisory PDF inspection and manual image-experiment export here.\n'
            '  The token is never served over HTTP to that origin; paste it into the page yourself.\n'
            f'Pairing token (valid until this server stops; do not share): {TOKEN}', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        with LOCK:
            server.closing = True
            jobs = list(JOBS.values())
        for job in jobs: job['cancel'].set()
        server.server_close()

if __name__ == '__main__': main()

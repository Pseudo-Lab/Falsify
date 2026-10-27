"""Minimal stdio/HTTPS adapter protocol. Trusted user code, NOT an OS sandbox."""
import hashlib
import ipaddress
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import http.client
import ssl
from urllib.parse import urlsplit
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from experiments.selfplay_codex import macos_runtime_path

TIMEOUT_SECONDS = 180
MAX_OUTPUT_BYTES = 150000

# Public diagnostics contain fixed labels only; never include adapter output or exception text.
FAILURES = {
    'settings_mismatch': ('preflight', 'refresh_harness'),
    'executable_missing': ('launch', 'install_executable'),
    'auth_required': ('preflight', 'sign_in'),
    'timeout': ('execution', 'retry_manually'),
    'invalid_output': ('output', 'check_adapter'),
    'process_exit': ('execution', 'check_adapter'),
    'unknown': ('unknown', 'inspect_configuration'),
}

class AdapterFailure(ValueError):
    def __init__(self, code):
        self.code = code if code in FAILURES else 'unknown'
        messages = {'timeout': 'adapter 응답 시간 초과. 자동으로 재시도하지 않습니다.',
                    'process_exit': 'adapter 종료 오류. 출력/비밀정보는 기록하지 않았습니다.'}
        super().__init__(messages.get(self.code, 'Adapter execution failed: ' + self.code))

    def payload(self):
        stage, recovery = FAILURES[self.code]
        return {'schema': 'falsify.adapter-failure.v1', 'code': self.code,
                'stage': stage, 'recovery': recovery}

def check_first_party_settings(harness):
    """Check only a known v035 runner's recorded source hashes, without importing or executing it."""
    adapter, settings = harness.get('adapter', {}), harness.get('settings', {})
    root = Path(__file__).resolve().parents[2]
    runner = root / 'app/examples/evidence_blue_v035/runner.py'
    args = adapter.get('args', [])
    if (adapter.get('type') != 'stdio' or not isinstance(args, list) or len(args) != 1
            or Path(args[0]).resolve() != runner.resolve() or not isinstance(settings, dict)
            or settings.get('diagnosticVersion') != '0.3.5'
            or settings.get('auditSchema') != 'falsify.blue-evidence-audit.v0.3.5'):
        return
    sources = settings.get('inheritedSources')
    if not isinstance(sources, dict): return
    # A mismatch is meaningful only for fixed first-party source paths and valid recorded digests.
    for name in ('experiments/selfplay_codex.py', 'app/local/harness_adapter.py'):
        recorded = sources.get(name)
        if isinstance(recorded, str) and len(recorded) == 64 and all(c in '0123456789abcdef' for c in recorded):
            try: current = hashlib.sha256((root / name).read_bytes()).hexdigest()
            except OSError: continue
            if current != recorded: raise AdapterFailure('settings_mismatch')

def validate_shape(value, schema):
    kind = schema.get('type')
    if kind == 'object':
        if not isinstance(value, dict) or set(value) != set(schema['properties']): raise ValueError('adapter 출력 객체 필드 오류')
        for k, v in value.items(): validate_shape(v, schema['properties'][k])
    elif kind == 'array':
        if not isinstance(value, list) or not schema.get('minItems', 0) <= len(value) <= schema.get('maxItems', 10000): raise ValueError('adapter 출력 배열 제한')
        for v in value: validate_shape(v, schema['items'])
    elif kind == 'string' and not isinstance(value, str): raise ValueError('adapter 출력 문자열 필요')
    elif kind == 'integer' and type(value) is not int: raise ValueError('adapter 출력 정수 필요')
    if 'enum' in schema and value not in schema['enum']: raise ValueError('adapter 출력 enum 오류')

def invocation(harness, prompt, schema, call, max_calls):
    return {'schema': 'falsify.harness-invocation.v1', 'role': harness['role'],
            'prompt': prompt, 'outputSchema': schema, 'settings': harness.get('settings', {}),
            'call': call, 'maxCalls': max_calls}

def run_stdio(argv, stdin, cwd, stdout_path):
    """Run argv once (no shell, no retry) in cwd with stdout captured to stdout_path; returns raw stdout."""
    # No shell interpolation, no inherited account tokens, disposable cwd.
    # This is not isolation: trusted code can access the user's filesystem/network.
    env = {k:v for k,v in os.environ.items() if k.upper() in {
        'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT',
        'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
        'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    }}
    if sys.platform == 'darwin': env['PATH'] = macos_runtime_path()
    # A file avoids pipe backpressure and retains EOF across timed wait polls.
    with tempfile.TemporaryFile() as input_file, open(stdout_path, 'wb') as stdout:
        input_file.write(stdin)
        input_file.seek(0)
        try:
            p = subprocess.Popen(argv, stdin=input_file, stdout=stdout,
                stderr=subprocess.DEVNULL, cwd=cwd, env=env,
                **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}))
        except FileNotFoundError: raise AdapterFailure('executable_missing') from None
        except OSError: raise AdapterFailure('unknown') from None
        try:
            deadline = time.monotonic() + TIMEOUT_SECONDS
            while True:
                if time.monotonic() > deadline: raise AdapterFailure('timeout')
                if os.path.getsize(stdout_path) > MAX_OUTPUT_BYTES: raise AdapterFailure('invalid_output')
                try:
                    p.wait(timeout=.1)
                    break
                except subprocess.TimeoutExpired: pass
            if p.returncode == 124:
                raise AdapterFailure('timeout')
            if p.returncode != 0: raise AdapterFailure('process_exit')
        finally:
            if p.poll() is None:
                if os.name == 'nt': subprocess.run(['taskkill','/PID',str(p.pid),'/T','/F'], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                else: os.killpg(p.pid, signal.SIGKILL)
                p.wait()
    with open(stdout_path, 'rb') as f: return f.read(MAX_OUTPUT_BYTES+1)

def post_https(url, body, content_type='application/json'):
    """One POST to a public HTTPS address (DNS-pinned, no redirects/auth headers/retry); returns raw body."""
    parsed = urlsplit(url)
    try: addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except (TimeoutError, socket.timeout): raise AdapterFailure('timeout') from None
    except OSError: raise AdapterFailure('unknown') from None
    if any(not ipaddress.ip_address(x[4][0]).is_global for x in addresses): raise ValueError('외부 adapter는 공인 HTTPS 주소만 허용합니다.')
    # Connect only to the checked IP; TLS verifies the original host (no DNS rebind).
    connection = None
    try:
        deadline = time.monotonic() + TIMEOUT_SECONDS
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=TIMEOUT_SECONDS)
        sock = socket.create_connection((addresses[0][4][0], parsed.port or 443), timeout=TIMEOUT_SECONDS)
        sock.settimeout(max(.01, deadline-time.monotonic()))
        tls = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname)
        connection.sock = tls
        tls.settimeout(max(.01, deadline-time.monotonic()))
        connection.request('POST', parsed.path or '/', body=body, headers={'Content-Type':content_type})
        tls.settimeout(max(.01, deadline-time.monotonic()))
        r = connection.getresponse()
        if not 200 <= r.status < 300: raise ValueError('HTTP status/redirect rejected')
        parts, count = [], 0
        while count <= MAX_OUTPUT_BYTES:
            remaining = deadline-time.monotonic()
            if remaining <= 0: raise TimeoutError()
            tls.settimeout(remaining)
            part = r.read1(min(8192,MAX_OUTPUT_BYTES+1-count))
            if not part: break
            parts.append(part);count += len(part)
        return b''.join(parts)
    except (TimeoutError, socket.timeout): raise AdapterFailure('timeout') from None
    except Exception: raise AdapterFailure('unknown') from None
    finally:
        if connection: connection.close()

class AdapterBackend:
    def __init__(self, harness, max_calls): self.harness, self.max_calls, self.calls = harness, max_calls, 0
    def infer(self, prompt, schema):
        if self.calls >= self.max_calls: raise ValueError('adapter 호출 예산 초과')
        self.calls += 1
        payload = json.dumps(invocation(self.harness, prompt, schema, self.calls, self.max_calls), ensure_ascii=False).encode()
        adapter = self.harness['adapter']
        check_first_party_settings(self.harness)
        if adapter['type'] == 'stdio':
            with tempfile.TemporaryDirectory(prefix='falsify-harness-') as cwd:
                raw = run_stdio([adapter['executable'], *adapter['args']], payload+b'\n', cwd, os.path.join(cwd, 'response.json'))
        else:
            raw = post_https(adapter['url'], payload)
        try:
            if len(raw) > MAX_OUTPUT_BYTES: raise ValueError()
            response = json.loads(raw)
            validate_shape(response, schema)
        except (ValueError, TypeError, UnicodeError): raise AdapterFailure('invalid_output') from None
        return {'status':'ok','response':response}

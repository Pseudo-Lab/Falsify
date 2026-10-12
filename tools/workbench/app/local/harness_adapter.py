"""Minimal stdio/HTTPS adapter protocol. Trusted user code, NOT an OS sandbox."""
import ipaddress
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import http.client
import ssl
from urllib.parse import urlsplit

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

class AdapterBackend:
    def __init__(self, harness, max_calls): self.harness, self.max_calls, self.calls = harness, max_calls, 0
    def infer(self, prompt, schema):
        if self.calls >= self.max_calls: raise ValueError('adapter 호출 예산 초과')
        self.calls += 1
        payload = json.dumps({'schema': 'falsify.harness-invocation.v1', 'role': self.harness['role'],
            'prompt': prompt, 'outputSchema': schema, 'settings': self.harness.get('settings', {}),
            'call': self.calls, 'maxCalls': self.max_calls}, ensure_ascii=False).encode()
        adapter = self.harness['adapter']
        if adapter['type'] == 'stdio':
            # No shell interpolation, no inherited account tokens, disposable cwd.
            # This is not isolation: trusted code can access the user's filesystem/network.
            env = {k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','PATHEXT'}}
            with tempfile.TemporaryDirectory(prefix='falsify-harness-') as cwd:
                output = os.path.join(cwd, 'response.json')
                with open(output, 'wb') as stdout:
                    p = subprocess.Popen([adapter['executable'], *adapter['args']], stdin=subprocess.PIPE, stdout=stdout,
                        stderr=subprocess.DEVNULL, cwd=cwd, env=env,
                        **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}))
                    try:
                        deadline = time.monotonic() + 180
                        initial = True
                        while True:
                            if time.monotonic() > deadline or os.path.getsize(output) > 150000: raise ValueError('adapter 실행 시간/출력 제한 초과')
                            try:
                                p.communicate(input=payload+b'\n' if initial else None, timeout=.1)
                                break
                            except subprocess.TimeoutExpired: initial = False
                        if p.returncode != 0: raise ValueError('adapter 종료 오류. 출력/비밀정보는 기록하지 않았습니다.')
                    finally:
                        if p.poll() is None:
                            if os.name == 'nt': subprocess.run(['taskkill','/PID',str(p.pid),'/T','/F'], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                            else: os.killpg(p.pid, signal.SIGKILL)
                            p.wait()
                with open(output, 'rb') as f: raw = f.read(150001)
        else:
            parsed = urlsplit(adapter['url'])
            addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
            if any(not ipaddress.ip_address(x[4][0]).is_global for x in addresses): raise ValueError('외부 adapter는 공인 HTTPS 주소만 허용합니다.')
            # Connect only to the checked IP; TLS verifies the original host (no DNS rebind).
            connection = None
            try:
                deadline = time.monotonic() + 180
                connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=180)
                sock = socket.create_connection((addresses[0][4][0], parsed.port or 443), timeout=180)
                sock.settimeout(max(.01, deadline-time.monotonic()))
                tls = ssl.create_default_context().wrap_socket(sock, server_hostname=parsed.hostname)
                connection.sock = tls
                tls.settimeout(max(.01, deadline-time.monotonic()))
                connection.request('POST', parsed.path or '/', body=payload, headers={'Content-Type':'application/json'})
                tls.settimeout(max(.01, deadline-time.monotonic()))
                r = connection.getresponse()
                if not 200 <= r.status < 300: raise ValueError('HTTP status/redirect rejected')
                parts, count = [], 0
                while count <= 150000:
                    remaining = deadline-time.monotonic()
                    if remaining <= 0: raise ValueError('HTTP timeout')
                    tls.settimeout(remaining)
                    part = r.read1(min(8192,150001-count))
                    if not part: break
                    parts.append(part);count += len(part)
                raw = b''.join(parts)
            except Exception: raise ValueError('외부 adapter 요청 실패. URL/응답 상세는 기록하지 않았습니다.') from None
            finally:
                if connection: connection.close()
        if len(raw) > 150000: raise ValueError('adapter 출력은 150,000바이트 이내입니다.')
        try: response = json.loads(raw)
        except Exception: raise ValueError('adapter는 JSON 객체 하나만 stdout/HTTP 응답으로 반환해야 합니다.') from None
        validate_shape(response, schema)
        return {'status':'ok','response':response}

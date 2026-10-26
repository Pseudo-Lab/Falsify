"""0.3.5 timeout hotfix. Frozen v033/v034 strategies remain unchanged.

Document-only calls may wait 120s instead of 70s, within the same 150s
invocation budget. Exit 124 is the stdio timeout diagnostic; no automatic retry.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
PREVIOUS = HERE.parent / 'evidence_blue_v034'
_spec = importlib.util.spec_from_file_location('falsify_blue_v034_for_v035', PREVIOUS / 'runner.py')
v034 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v034)

VERSION = '0.3.5'
PROFILE_ID = 'shinick-blue-evidence-external-v035'
PROFILE_NAME = 'BLUE Evidence v0.3.5 · 시간 초과 핫픽스 · 외부 문헌 + 독립·교차검토'
AUDIT_SCHEMA = 'falsify.blue-evidence-audit.v0.3.5'
AUDIT_DIR_NAME = 'blue-evidence-v035-audits'
DOCUMENT_TIMEOUT = 120
TOTAL_SECONDS = 150
EXIT_TIMEOUT = 124
MARKER = v034.MARKER
INSTRUCTIONS = v034.INSTRUCTIONS


class AuditFailure(Exception):
    def __init__(self, code, audit):
        super().__init__(code)
        self.code, self.audit = code, audit


def source_map():
    sources = v034.source_map()
    sources['app/examples/evidence_blue_v035/runner.py'] = hashlib.sha256(HERE.joinpath('runner.py').read_bytes()).hexdigest()
    return sources


def contract_settings():
    return {**v034.contract_settings(), 'bundleSha256': v034.v033.v2.digest(source_map()),
            'diagnosticVersion': VERSION, 'auditSchema': AUDIT_SCHEMA,
            'documentTimeoutSeconds': DOCUMENT_TIMEOUT, 'totalTimeoutSeconds': TOTAL_SECONDS}


def check_settings(settings):
    expected = contract_settings()
    if not isinstance(settings, dict) or any(settings.get(k) != v for k, v in expected.items()):
        raise ValueError('settings_contract')


def model_timeout(stage, remaining, elapsed):
    cap = DOCUMENT_TIMEOUT if stage == 'document-stage' else 70
    # Cleanup/audit must finish before the outer 180s adapter deadline.
    return max(0, min(cap, remaining - 5, TOTAL_SECONDS - elapsed - 5))


def execute(raw, backend_factory=None, search=None, audit_dir=None):
    started = time.monotonic()
    folder = Path(audit_dir) if audit_dir is not None else v034.v033.REPO / '.local' / AUDIT_DIR_NAME
    folder.mkdir(parents=True, exist_ok=True)
    audit = {'schema': AUDIT_SCHEMA, 'diagnosticVersion': VERSION, 'id': uuid.uuid4().hex,
             'inputSha256': hashlib.sha256(raw).hexdigest(), 'startedAt': time.time(),
             'modelCalls': [], 'experimental': True,
             'documentTimeoutSeconds': DOCUMENT_TIMEOUT, 'totalTimeoutSeconds': TOTAL_SECONDS}
    path = folder / (audit['id'] + '.json')
    inner_dir = folder / 'inherited' / audit['id']
    failure = None
    try:
        if len(raw) > 1500000:
            raise ValueError('input_bound')
        invocation = json.loads(raw)
        settings = invocation.get('settings', {})
        check_settings(settings)
        audit.update(bundleSha256=settings['bundleSha256'], appCall=invocation.get('call'), appMaxCalls=invocation.get('maxCalls'))
        rewritten = copy.deepcopy(invocation)
        rewritten['settings'].update(v034.contract_settings())

        def infer(stage, prompt, schema, remaining):
            seconds = model_timeout(stage, remaining, time.monotonic() - started)
            if seconds < 2:
                return {'status': 'timeout', 'error_code': 'timeout', 'response': None}
            if backend_factory is not None:
                return backend_factory(stage, prompt, schema, seconds)
            return v034.v033.ClaudeBackend(max_calls=1, timeout_seconds=seconds,
                max_prompt_chars=100000, model=v034.MODEL, effort=v034.EFFORT).infer(prompt, schema)

        try:
            answer = v034.execute(json.dumps(rewritten, ensure_ascii=False).encode('utf8'), infer, search, inner_dir)
        except v034.AuditFailure as error:
            failure = error.code
            answer = None
        files = list(inner_dir.glob('*.json'))
        if len(files) != 1:
            raise ValueError('inherited_source_missing')
        blob = files[0].read_bytes()
        inner = json.loads(blob)
        for key in ('modelCalls', 'scanDerivation', 'scanContract', 'pipeline', 'externalLookup',
                    'methodologyPackets', 'expertValidation', 'independentOpinions', 'state', 'result'):
            if key in inner:
                audit[key] = inner[key]
        audit['inheritedAudit'] = {'path': files[0].relative_to(folder).as_posix(), 'fileSha256': hashlib.sha256(blob).hexdigest()}
        if failure:
            if any(c.get('status') == 'timeout' or c.get('error_code') == 'timeout' for c in audit['modelCalls']):
                failure = 'model_timeout'
            raise AuditFailure(failure, audit)
        audit.update(state='completed', finishedAt=time.time())
        v034._save(path, audit)
        return answer
    except Exception as error:
        code = error.code if isinstance(error, AuditFailure) else v034.public_error_code(error)
        audit.update(state='failed', errorCode=code, finishedAt=time.time())
        v034._save(path, audit)
        raise AuditFailure(code, audit) from None


def main():
    if sys.platform == 'win32':
        sys.stdin.reconfigure(encoding='utf8')
        sys.stdout.reconfigure(encoding='utf8')
    try:
        answer = execute(sys.stdin.buffer.read(1500001))
    except AuditFailure as error:
        raise SystemExit(EXIT_TIMEOUT if error.code == 'model_timeout' else 1) from None
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == '__main__':
    main()

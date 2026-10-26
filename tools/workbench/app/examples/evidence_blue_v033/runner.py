"""Subscription-only stdio adapter. Four model calls maximum; fixed-API script lookup."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
APP = HERE.parents[1]
REPO = APP.parent
sys.path.insert(0, str(APP / 'local'))
from cli_backend import ClaudeBackend
from core import MARKER, SCOPE, run, v2

AUDIT_SCHEMA = 'falsify.blue-evidence-audit.v0.3.3'
AUDIT_DIR_NAME = 'blue-evidence-v033-audits'
ALLOWED_ERROR_CODES = {
    'input_bound', 'settings_contract', 'internal_call_or_time_budget', 'model_stage_failed',
    'external_service_opt_in_required', 'evaluation_artifact_query_rejected', 'review_prompt_bound',
    'challenge_prompt_bound', 'unretrieved_external_quote', 'external_basis_binding',
    'non_ok_findings', 'finding_id', 'unprovided_paper_quote', 'explanation_bounds', 'relation_bounds',
    'scan_reanchor_failed',
    'scan_contract_failed',
}


class AuditFailure(Exception):
    """Stable public code only. The audit object stays on the instance and is not the message."""

    def __init__(self, code, audit):
        super().__init__(code)
        self.code = code
        self.audit = audit


def public_error_code(error):
    # Fixed codes only. Any other exception contributes its type name, never str(error).
    if isinstance(error, ValueError) and str(error) in ALLOWED_ERROR_CODES:
        return str(error)
    return type(error).__name__


def record_model_return(row, result):
    """Keep the returned response unchanged, before the caller validates it. No prompt or environment."""
    row.update({k: result.get(k) for k in ('status', 'error_code', 'usage', 'elapsed_seconds', 'observed_models', 'observed_tool_calls')})
    if isinstance(result, dict) and 'response' in result:
        row['response'] = copy.deepcopy(result['response'])
    row['state'] = 'returned'


def restore_process_home():
    # OS-profile lookup only; never read or copy credentials.
    key = 'USERPROFILE' if os.name == 'nt' else 'HOME'
    if os.environ.get(key):
        return
    if os.name == 'nt':
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x28, None, 0, buffer) != 0 or not buffer.value:
            raise ValueError('profile_directory_unavailable')
        value = buffer.value
    else:
        import pwd
        value = pwd.getpwuid(os.getuid()).pw_dir
    if not Path(value).is_absolute() or not Path(value).is_dir():
        raise ValueError('profile_directory_unavailable')
    os.environ[key] = value


def bundle_identity():
    paths = [HERE / n for n in ('core.py', 'runner.py', 'reanchor.py')]
    paths += [HERE.parent / 'evidence_blue_v031' / n for n in ('core.py', 'literature.py')]
    paths += [HERE.parent / 'evidence_blue' / n for n in ('core.py', 'corpus.json')]
    paths += [APP / 'local' / n for n in ('cli_backend.py', 'blue_service.py', 'red_service.py',
                                          'harness.py', 'harness_adapter.py')]
    paths += [REPO / 'experiments' / 'selfplay_codex.py']
    return v2.digest({str(p.relative_to(REPO)).replace('\\', '/'): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths})


def execute(raw, backend_factory=None, search=None, audit_dir=None):
    started = time.monotonic()
    audit = {'schema': AUDIT_SCHEMA, 'diagnosticVersion': '0.3.3', 'id': uuid.uuid4().hex,
        'inputSha256': hashlib.sha256(raw).hexdigest(), 'modelCalls': [], 'scope': SCOPE, 'startedAt': time.time()}
    folder = Path(audit_dir) if audit_dir is not None else REPO / '.local' / AUDIT_DIR_NAME
    folder.mkdir(parents=True, exist_ok=True)
    audit_path = folder / (audit['id'] + '.json')
    lock = threading.Lock()
    def save():
        temporary = audit_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(audit_path)
    try:
        if len(raw) > 1500000:
            raise ValueError('input_bound')
        invocation = json.loads(raw)
        settings = invocation.get('settings', {})
        if (settings.get('bundleSha256') != bundle_identity() or settings.get('scope') != SCOPE
                or settings.get('internalMaxCalls') != 4 or settings.get('externalLookup') != {'enabled': True, 'providers': ['crossref', 'europepmc']}):
            raise ValueError('settings_contract')
        restore_process_home()
        audit.update(bundleSha256=settings['bundleSha256'], appCall=invocation.get('call'), appMaxCalls=invocation.get('maxCalls'))
        save()
        def infer(stage, prompt, schema):
            with lock:
                remaining = 150 - (time.monotonic() - started)
                if len(audit['modelCalls']) >= 4 or remaining < 2:
                    raise ValueError('internal_call_or_time_budget')
                row = {'stage': stage, 'state': 'reserved', 'promptSha256': hashlib.sha256(prompt.encode()).hexdigest()}
                audit['modelCalls'].append(row); save()
            if backend_factory is None:
                result = ClaudeBackend(max_calls=1, timeout_seconds=min(70, remaining), max_prompt_chars=100000,
                    model='claude-opus-5-5', effort='medium').infer(prompt, schema)
            else:
                result = backend_factory(stage, prompt, schema, remaining)
            with lock:
                record_model_return(row, result); save()
            if result['status'] != 'ok':
                raise ValueError('model_stage_failed')
            return result['response']
        corpus = json.loads((HERE.parent / 'evidence_blue' / 'corpus.json').read_text(encoding='utf-8'))
        if search is None:
            answer = run(invocation, corpus, infer, audit)
        else:
            answer = run(invocation, corpus, infer, audit, search)
        audit.update(state='completed', result=answer, finishedAt=time.time()); save()
        return answer
    except Exception as error:
        # No upstream diagnostics/prompt/credentials in stdout or generic error text.
        code = public_error_code(error)
        audit.update(state='failed', errorCode=code, finishedAt=time.time()); save()
        raise AuditFailure(code, audit) from None


def main():
    if os.name == 'nt':
        sys.stdin.reconfigure(encoding='utf-8'); sys.stdout.reconfigure(encoding='utf-8')
    raw = sys.stdin.buffer.read(1500001)
    try:
        answer = execute(raw)
    except AuditFailure:
        raise SystemExit(1) from None
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == '__main__':
    main()

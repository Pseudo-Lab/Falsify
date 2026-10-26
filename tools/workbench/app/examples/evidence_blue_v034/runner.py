"""Experimental 0.3.4 stdio adapter. Execution is the frozen v033 pipeline.

Bundle identity adds app/local/blue_evidence_refs.py to every file v033 already
hashes, including blue_service.py. v033's own bundle function is not modified.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
V033_DIR = HERE.parent / 'evidence_blue_v033'
# v033 imports `core` and `reanchor` as top-level modules. Keep this package ahead of that directory.
if str(V033_DIR) not in sys.path:
    sys.path.insert(1, str(V033_DIR))
_spec = importlib.util.spec_from_file_location('falsify_blue_v033_runner_for_v034', V033_DIR / 'runner.py')
v033 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v033)

VERSION = '0.3.4'
PROFILE_ID = 'shinick-blue-evidence-external-v034'
PROFILE_NAME = 'BLUE Evidence v0.3.4 · 실험 · 외부 문헌 + 독립·교차검토'
INSTRUCTIONS = (
    '통계와 방법론 독립 검토 후 새 세션에서 교차 검토합니다. 문서 내부 지적과 외부 문헌 근거 지적을 구분하고 '
    '실제 조회한 출처를 인용하세요. 검색 미발견을 결함으로 단정하지 마세요. 근거는 제공받은 논문에서 정확하게 복사하세요.'
)
AUDIT_SCHEMA = 'falsify.blue-evidence-audit.v0.3.4'
AUDIT_DIR_NAME = 'blue-evidence-v034-audits'
HELPER_REL = 'app/local/blue_evidence_refs.py'
RUNNER_REL = 'app/examples/evidence_blue_v034/runner.py'
HELPER_MARKERS = (b'def build_evidence_refs', b'def resolve_evidence_ref')
HELPER_CODES = {'helper_missing', 'helper_unknown', 'helper_stale', 'inherited_source_missing'}
SCOPE = v033.SCOPE
MARKER = v033.MARKER
MODEL = 'claude-opus-5-5'
EFFORT = 'medium'
EXTERNAL_LOOKUP = {'enabled': True, 'providers': ['crossref', 'europepmc']}


class AuditFailure(Exception):
    """Stable public code only. The audit object stays on the instance."""

    def __init__(self, code, audit):
        super().__init__(code)
        self.code = code
        self.audit = audit


def read_bytes(path):
    return Path(path).read_bytes()


def public_error_code(error):
    if isinstance(error, ValueError) and str(error) in HELPER_CODES | set(v033.ALLOWED_ERROR_CODES):
        return str(error)
    return v033.public_error_code(error)


def inherited_paths():
    """Same path list v033.bundle_identity hashes. Helper is intentionally absent."""
    here, app, repo = v033.HERE, v033.APP, v033.REPO
    paths = [here / name for name in ('core.py', 'runner.py', 'reanchor.py')]
    paths += [here.parent / 'evidence_blue_v031' / name for name in ('core.py', 'literature.py')]
    paths += [here.parent / 'evidence_blue' / name for name in ('core.py', 'corpus.json')]
    paths += [app / 'local' / name for name in (
        'cli_backend.py', 'blue_service.py', 'red_service.py', 'harness.py', 'harness_adapter.py')]
    paths += [repo / 'experiments' / 'selfplay_codex.py']
    return paths


def _key(path):
    return str(Path(path).relative_to(v033.REPO)).replace('\\', '/')


def inherited_sources():
    found = {}
    for path in inherited_paths():
        if not path.is_file():
            raise ValueError('inherited_source_missing')
        found[_key(path)] = hashlib.sha256(read_bytes(path)).hexdigest()
    return found


def helper_path():
    return v033.APP / 'local' / 'blue_evidence_refs.py'


def helper_digest():
    path = helper_path()
    if not path.is_file():
        raise ValueError('helper_missing')
    data = read_bytes(path)
    if any(marker not in data for marker in HELPER_MARKERS):
        raise ValueError('helper_unknown')
    try:
        key = _key(path)
    except ValueError:
        raise ValueError('helper_unknown') from None
    if key != HELPER_REL:
        raise ValueError('helper_unknown')
    return hashlib.sha256(data).hexdigest()


def source_map():
    files = inherited_sources()
    files[HELPER_REL] = helper_digest()
    runner_path = HERE / 'runner.py'
    if not runner_path.is_file() or _key(runner_path) != RUNNER_REL:
        raise ValueError('inherited_source_missing')
    files[RUNNER_REL] = hashlib.sha256(read_bytes(runner_path)).hexdigest()
    return files


def bundle_identity():
    return v033.v2.digest(source_map())


def contract_settings():
    sources = source_map()
    return {
        'scope': SCOPE,
        'bundleSha256': v033.v2.digest(sources),
        'internalMaxCalls': 4,
        'model': MODEL,
        'effort': EFFORT,
        'externalLookup': {'enabled': EXTERNAL_LOOKUP['enabled'], 'providers': list(EXTERNAL_LOOKUP['providers'])},
        'diagnosticVersion': VERSION,
        'auditSchema': AUDIT_SCHEMA,
        'helper': HELPER_REL,
        'helperSha256': sources[HELPER_REL],
        'inheritedSources': inherited_sources(),
        'experimental': True,
    }


def check_settings(settings):
    if not isinstance(settings, dict):
        raise ValueError('settings_contract')
    # File state first, then the recorded binding, then the rest of the contract.
    current = helper_digest()
    if settings.get('helper') != HELPER_REL:
        raise ValueError('helper_unknown')
    if settings.get('helperSha256') != current:
        raise ValueError('helper_stale')
    expected = contract_settings()
    keys = (
        'bundleSha256', 'diagnosticVersion', 'auditSchema', 'scope', 'internalMaxCalls',
        'model', 'effort', 'externalLookup', 'helper', 'helperSha256', 'inheritedSources', 'experimental',
    )
    if any(settings.get(key) != expected[key] for key in keys):
        raise ValueError('settings_contract')


def _save(path, audit):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def _merge_pipeline_audit(audit, inner, settings):
    for key in (
        'modelCalls', 'scanDerivation', 'scanContract', 'pipeline', 'externalLookup',
        'methodologyPackets', 'expertValidation', 'independentOpinions', 'state',
        'errorCode', 'result', 'finishedAt', 'appCall', 'appMaxCalls',
    ):
        if key in inner:
            # modelCalls carries the raw response; copy it so the inner file object stays untouched.
            audit[key] = copy.deepcopy(inner[key]) if key == 'modelCalls' else inner[key]
    audit['schema'] = AUDIT_SCHEMA
    audit['diagnosticVersion'] = VERSION
    audit['bundleSha256'] = settings.get('bundleSha256')
    audit['helper'] = HELPER_REL
    audit['helperSha256'] = settings.get('helperSha256')


def _owned_inner_dir(folder, outer_id):
    """One directory per outer invocation. Never the shared audit folder."""
    path = folder / 'inherited' / outer_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read_owned_inner(inner_dir, outer_folder):
    """Read the single inherited audit in this invocation's directory. Do not delete it."""
    files = [item for item in inner_dir.iterdir() if item.is_file() and item.suffix == '.json']
    if len(files) != 1:
        raise ValueError('inherited_source_missing')
    path = files[0]
    blob = path.read_bytes()
    data = json.loads(blob.decode('utf-8'))
    link = {
        'path': path.relative_to(outer_folder).as_posix(),
        'fileSha256': hashlib.sha256(blob).hexdigest(),
        'inputSha256': data['inputSha256'],
    }
    return data, link


def execute(raw, backend_factory=None, search=None, audit_dir=None):
    folder = Path(audit_dir) if audit_dir is not None else v033.REPO / '.local' / AUDIT_DIR_NAME
    folder.mkdir(parents=True, exist_ok=True)
    audit = {
        'schema': AUDIT_SCHEMA, 'diagnosticVersion': VERSION, 'id': uuid.uuid4().hex,
        'inputSha256': hashlib.sha256(raw).hexdigest(), 'modelCalls': [], 'scope': SCOPE,
        'startedAt': time.time(), 'experimental': True,
    }
    path = folder / (audit['id'] + '.json')
    try:
        if len(raw) > 1500000:
            raise ValueError('input_bound')
        invocation = json.loads(raw)
        settings = invocation.get('settings', {})
        check_settings(settings)
        audit.update(bundleSha256=settings.get('bundleSha256'), helper=HELPER_REL,
                     helperSha256=settings.get('helperSha256'), appCall=invocation.get('call'),
                     appMaxCalls=invocation.get('maxCalls'))
        _save(path, audit)
        rewritten = copy.deepcopy(invocation)
        rewritten['settings']['bundleSha256'] = v033.bundle_identity()
        inner_dir = _owned_inner_dir(folder, audit['id'])
        try:
            answer = v033.execute(json.dumps(rewritten).encode(), backend_factory, search, inner_dir)
        except v033.AuditFailure as error:
            inner, link = _read_owned_inner(inner_dir, folder)
            _merge_pipeline_audit(audit, inner, settings)
            audit['inheritedAudits'] = [link]
            _save(path, audit)
            raise AuditFailure(error.code, audit) from None
        inner, link = _read_owned_inner(inner_dir, folder)
        _merge_pipeline_audit(audit, inner, settings)
        audit['inheritedAudits'] = [link]
        _save(path, audit)
        return answer
    except AuditFailure:
        raise
    except Exception as error:
        code = public_error_code(error)
        audit.update(state='failed', errorCode=code, finishedAt=time.time())
        _save(path, audit)
        raise AuditFailure(code, audit) from None


def main():
    if os.name == 'nt':
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')
    raw = sys.stdin.buffer.read(1500001)
    try:
        answer = execute(raw)
    except AuditFailure:
        raise SystemExit(1) from None
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == '__main__':
    main()

"""Cleanroom round runner and answer-key-free rule distiller for the Co-Evolution Arena.

``run_round`` executes 1..N blind BLUE turns inside a fresh temporary directory that
contains only the blind PDF (and optional supplements) and scores them with
``arena_runner.evaluate_arena_match``. ``distill_round`` turns a scored round record
into a generalized harness patch that carries codes and counts only.

The cleanroom is **not** an OS sandbox. Adapter execution is delegated to
``app/local/harness_adapter.py``, whose own contract says: "This is not isolation:
trusted code can access the user's filesystem/network." The runner removes the gold
ledger, the source PDF, the original paths and every non-allowlisted environment
variable from the child's reach; it cannot stop a hostile adapter from reading them.

Stdlib only. Scoring and blind-bundle verification come from ``arena_runner``;
adapter execution and env/process policy come from ``harness_adapter``.
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import time
from typing import Callable

_EVAL_DIR = Path(__file__).resolve().parent
if str(_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_EVAL_DIR))
_REPO_ROOT = _EVAL_DIR.parents[1]
_APP_LOCAL = _REPO_ROOT / 'app' / 'local'
if str(_APP_LOCAL) not in sys.path:
    sys.path.insert(0, str(_APP_LOCAL))

import arena_runner as arena  # noqa: E402

try:  # adapter execution is imported, never reimplemented
    import harness_adapter  # noqa: E402
except ImportError:  # pragma: no cover - harness_adapter is stdlib-only today
    harness_adapter = None

ROUND_SCHEMA = 'falsify.arena-round.v1'
PATCH_SCHEMA = 'falsify.harness-patch.v1'
COMPACT_RULES_SCHEMA = 'falsify.harness-rule-compaction.v1'
ERROR_SCHEMA = 'falsify.arena-round-error.v1'
INVOCATION_SCHEMA = 'falsify.harness-invocation.v1'
BLUE_REPORT_SCHEMA = 'falsify.blue-report.v1'

ISOLATION_NOTICE = (
    'cleanroom-tempdir: fresh temporary cwd, harness_adapter minimal environment, blind bytes only. '
    'Not an OS sandbox: harness_adapter.py states "This is not isolation: trusted code can access '
    "the user's filesystem/network\". A hostile adapter can still read the gold ledger and the source PDF."
)

# The 11 fixed strings the JS C1 brief test forbids (app/tests/coevolution-arena.spec.cjs:351),
# plus the value/pattern denylists that catch quotes, ids, p-values and file names.
ANSWER_KEY_STRINGS = (
    '12%', '24%', '28%', 'reference [1]', 'reference [99]', 'NCT01234567', 'p = 0.08',
    'No difference was observed', 'Treatment reduced mortality', 'Exploratory endpoint', '=SUM',
)
EXTRA_DENY_KEYS = frozenset({
    'findingid', 'paperid', 'paper_id', 'filehash', 'file_hash', 'quote', 'excerpt',
    'evidence', 'itemtext', 'rationales', 'goldanswer',
})
DENY_KEYS = frozenset(arena.FORBIDDEN_SUPPLEMENT_KEYS) | EXTRA_DENY_KEYS

DOI_RE = re.compile(r'\b10\.\d{4,9}/\S+')
P_VALUE_RE = re.compile(r'(?<![A-Za-z])p\s*[=<>]\s*0?\.\d+')
REGISTRY_RE = re.compile(r'\b(?:NCT\d{6,}|OSF[A-Z0-9]{4,}|GSE\d{3,}|PDB\s*[0-9][A-Za-z0-9]{3})\b')
FILE_NAME_RE = re.compile(
    r'(?<![A-Za-z0-9_.-])[A-Za-z0-9_-]{1,64}\.(?:pdf|csv|tsv|json|xlsx|docx|tex|png|jpe?g|zip)\b',
    re.IGNORECASE,
)
CODE_RE = re.compile(r'^[A-Z][A-Z0-9]{0,6}(?:-[A-Z0-9]{1,3})?$')
ENV_NAME_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
BUNDLE_ERROR_CODES = frozenset({'supplement_invalid', 'source_pdf_invalid', 'blind_pdf_invalid'})

PROMPT_HEAD = (
    'Review the blind document bundle in the current working directory.\n'
    '- blind.pdf: the document under review. It is the only source of truth.\n'
)
PROMPT_TAIL = (
    'Report every defect you can support with verbatim evidence copied from these files. '
    'Do not assume access to any answer key, gold ledger, RED plan or reference solution; '
    'if it is not in the bundle it does not exist.\n'
    'Reply with exactly one JSON object matching outputSchema: '
    '{"schema": "falsify.blue-report.v1", "findings": [{"id": "...", '
    '"decision": "defect"|"clean"|"확인필요", "pageIndex": 0, "bbox": [x0,y0,x1,y1], '
    '"supplementName": "...", "quote": "verbatim evidence", "confidence": 0.0}]}. '
    'Use "확인필요" (abstain) instead of guessing.\n'
)

FAMILY_TEMPLATES = {
    'D1': ('수치 변형', '표 합계·백분율·표본 수를 원문에서 다시 계산하고 본문·표·초록의 같은 지표를 교차 대조한다.'),
    'D2': ('인용 왜곡', 'PDF 링크(/URI)와 본문 서지 표기를 교차 검증하고 참고문헌 중복·불일치를 확인한다.'),
    'D3': ('논리 모순', '결론의 단정과 방법·한계 섹션의 전제·제외 조건을 나란히 놓고 충돌을 확인한다.'),
    'D4': ('결과지표 왜곡', '사전 등록·프로토콜의 주 결과와 보고된 주 결과를 대조한다.'),
    'D4-1': ('결과지표·등록부 왜곡', 'pre-specified·primary outcome 주장을 연구방법과 등록부 기준으로 재확인한다.'),
    'D5': ('시각·레이아웃 변형', '차트 축·막대 높이·패널 라벨을 본문 서술 수치와 픽셀 단위로 대조한다.'),
    'D6': ('보충자료 불일치', '보충 표의 분모·군 크기·부분합을 본문 표와 재계산해 대조한다.'),
    'D7': ('참고문헌·식별자 변형', 'DOI·등록번호·권호 쪽수를 원문 인용 표기와 하나씩 대조한다.'),
    'S1': ('의미 반전', '부정어·방향성 반전과 상관→인과 과잉 해석을 문맥 단위로 확인한다.'),
    'NA': ('미분류 축', '결함 축 코드가 없는 항목은 표면·수치·인용 교차 확인 절차를 그대로 적용한다.'),
}


class ArenaRoundError(ValueError):
    """Fixed-code input/execution failure; ``exit_code`` is the module CLI status."""

    def __init__(self, code: str, exit_code: int = 2) -> None:
        self.code = code
        self.exit_code = exit_code
        super().__init__(code)


class DistillScrubError(ValueError):
    """Raised when a distilled artifact would carry answer-key material."""

    def __init__(self, hits: list[str] | None = None) -> None:
        self.code = 'distill_scrub_failed'
        self.hits = list(hits or [])
        super().__init__(self.code)


@dataclasses.dataclass
class _Plan:
    argv: list[str]
    adapter: Callable[..., bytes]
    adapter_injected: bool
    runs: int
    timeout: int
    round_id: str
    cleanroom: Path
    stdout_dir: Path
    supplement_names: list[str]
    gold: object
    baseline: object
    env_allow: tuple[str, ...]
    keep_cleanroom: bool
    source_sha256: str | None


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def _error_exit(code: str) -> int:
    if code == 'timeout':
        return 124
    if code in ('blindness_leak_detected', 'distill_scrub_failed'):
        return 3
    return 2


def _validate_argv(agent_argv) -> list[str]:
    if isinstance(agent_argv, (str, bytes, bytearray)) or not isinstance(agent_argv, (list, tuple)):
        raise ArenaRoundError('agent_argv_invalid')
    argv = [str(part) for part in agent_argv]
    if not argv or any(not part or '\0' in part for part in argv):
        raise ArenaRoundError('agent_argv_invalid')
    return argv


def _validate_int(value, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ArenaRoundError(name + '_invalid')
    return value


def _resolve_env_allow(env_allow, adapter_injected: bool) -> tuple[str, ...]:
    if env_allow is None:
        return ()
    if isinstance(env_allow, str) or not isinstance(env_allow, (list, tuple, set, frozenset)):
        raise ArenaRoundError('env_allow_invalid')
    names = tuple(sorted({str(name) for name in env_allow}))
    if any(not ENV_NAME_RE.fullmatch(name) for name in names):
        raise ArenaRoundError('env_allow_invalid')
    if names and not adapter_injected:
        # The default path uses harness_adapter's fixed minimal env. Extra names are
        # refused instead of silently widening or replacing it.
        raise ArenaRoundError('env_allow_unsupported')
    return names


def _supplement_name(entry: dict, index: int, used: set[str]) -> str:
    raw = str(entry.get('name') or f'supplement-{index + 1}')
    base = Path(raw).name
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', base).lstrip('.') or f'supplement-{index + 1}'
    if safe in used:
        stem, _, suffix = safe.partition('.')
        safe = f'{stem}-{index + 1}.{suffix}' if suffix else f'{stem}-{index + 1}'
    return safe


def _supplement_payload(entry: dict) -> bytes:
    if isinstance(entry.get('bytes'), (bytes, bytearray, memoryview)):
        return bytes(entry['bytes'])
    if isinstance(entry.get('text'), str):
        return entry['text'].encode('utf-8')
    return str(entry.get('content') or '').encode('utf-8')


def _write_cleanroom(cleanroom: Path, blind_raw: bytes, supplements: list[dict]) -> list[str]:
    (cleanroom / 'blind.pdf').write_bytes(blind_raw)
    names: list[str] = []
    if not supplements:
        return names
    sup_dir = cleanroom / 'supplements'
    sup_dir.mkdir()
    used: set[str] = set()
    for index, entry in enumerate(supplements):
        name = _supplement_name(entry, index, used)
        (sup_dir / name).write_bytes(_supplement_payload(entry))
        used.add(name)
        names.append(name)
    return names


def _make_cleanroom() -> Path:
    return Path(tempfile.mkdtemp(prefix='falsify-round-'))


def _dispose_plan(plan: _Plan) -> None:
    shutil.rmtree(plan.stdout_dir, ignore_errors=True)
    if not plan.keep_cleanroom:
        shutil.rmtree(plan.cleanroom, ignore_errors=True)


@contextlib.contextmanager
def _timeout_scope(seconds: int):
    """Apply the round timeout by narrowing harness_adapter's own wait budget."""
    original = harness_adapter.TIMEOUT_SECONDS
    harness_adapter.TIMEOUT_SECONDS = max(1, int(seconds))
    try:
        yield
    finally:
        harness_adapter.TIMEOUT_SECONDS = original


def _default_adapter(*, timeout: int) -> Callable[..., bytes]:
    def run(argv, payload, cwd, stdout_path, env_allow=None):
        if env_allow:
            raise ArenaRoundError('env_allow_unsupported')
        if harness_adapter is None:  # pragma: no cover - defensive
            raise ArenaRoundError('adapter_unavailable')
        with _timeout_scope(timeout):
            return harness_adapter.run_stdio(list(argv), payload, str(cwd), str(stdout_path))

    return run


def _blue_harness() -> dict:
    return {
        'schema': 'falsify.harness.v1',
        'id': 'arena-round-blue',
        'name': 'Arena round BLUE',
        'version': '1',
        'role': 'blue',
        'instructions': (
            'Work only from the blind bundle in this directory. Quote the exact supporting '
            'evidence, keep uncertain items as 확인필요, and never assume an answer key.'
        ),
        'maxCalls': 1,
    }


def _blue_output_schema() -> dict:
    return {
        'type': 'object',
        'required': ['findings'],
        'properties': {
            'schema': {'const': BLUE_REPORT_SCHEMA},
            'findings': {
                'type': 'array',
                'items': {
                    'type': 'object',
                    'required': ['id', 'decision'],
                    'properties': {
                        'id': {'type': 'string'},
                        'decision': {'type': 'string'},
                        'pageIndex': {'type': 'integer'},
                        'bbox': {'type': 'array'},
                        'supplementName': {'type': 'string'},
                        'quote': {'type': 'string'},
                        'confidence': {'type': 'number'},
                    },
                },
            },
        },
    }


def _build_prompt(supplement_names: list[str]) -> str:
    lines = ''.join(f'- supplements/{name}: read-only supplementary material.\n' for name in supplement_names)
    return PROMPT_HEAD + lines + PROMPT_TAIL


def _build_plan(
    *, blind_raw, argv, supplements, gold, baseline, adapter, runs, timeout,
    run_id, env_allow, keep_cleanroom, source_pdf_bytes, started_at,
) -> _Plan:
    adapter_injected = adapter is not None
    runs = _validate_int(runs, 'runs', 1, 20)
    timeout = _validate_int(timeout, 'timeout', 1, 1800)
    allowed_env = _resolve_env_allow(env_allow, adapter_injected)
    if adapter_injected and not callable(adapter):
        raise ArenaRoundError('adapter_invalid')
    cleanroom = _make_cleanroom()
    try:
        names = _write_cleanroom(cleanroom, blind_raw, supplements)
        stdout_dir = Path(tempfile.mkdtemp(prefix='falsify-round-out-'))
    except OSError:
        shutil.rmtree(cleanroom, ignore_errors=True)
        raise ArenaRoundError('cleanroom_unavailable') from None
    digest_seed = f'{arena._sha256_hex(blind_raw)}|{Path(argv[0]).name}|{started_at}'.encode('utf-8')
    round_id = str(run_id or 'round-' + hashlib.sha256(digest_seed).hexdigest()[:12])
    return _Plan(
        argv=argv,
        adapter=adapter if adapter_injected else _default_adapter(timeout=timeout),
        adapter_injected=adapter_injected,
        runs=runs,
        timeout=timeout,
        round_id=round_id,
        cleanroom=cleanroom,
        stdout_dir=stdout_dir,
        supplement_names=names,
        gold=gold,
        baseline=baseline,
        env_allow=allowed_env,
        keep_cleanroom=bool(keep_cleanroom),
        source_sha256=arena._sha256_hex(source_pdf_bytes) if source_pdf_bytes is not None else None,
    )


def _invocation_payload(plan: _Plan, index: int) -> bytes:
    if harness_adapter is None:  # pragma: no cover - defensive
        raise ArenaRoundError('adapter_unavailable')
    envelope = harness_adapter.invocation(
        _blue_harness(), _build_prompt(plan.supplement_names), _blue_output_schema(), index + 1, plan.runs,
    )
    return json.dumps(envelope, ensure_ascii=False).encode('utf-8') + b'\n'


def _adapter_error(error: Exception) -> ArenaRoundError:
    code = str(getattr(error, 'code', '') or 'unknown')
    if code == 'timeout':
        return ArenaRoundError('timeout', exit_code=124)
    if code in ('process_exit', 'invalid_output', 'executable_missing', 'settings_mismatch', 'auth_required'):
        return ArenaRoundError(code)
    return ArenaRoundError('adapter_failed')


def _call_adapter(plan: _Plan, payload: bytes, stdout_path: Path) -> bytes:
    kwargs = {'env_allow': plan.env_allow} if plan.env_allow else {}
    try:
        raw = plan.adapter(list(plan.argv), payload, plan.cleanroom, stdout_path, **kwargs)
    except ArenaRoundError:
        raise
    except Exception as error:  # adapter failures are translated to fixed codes
        raise _adapter_error(error) from None
    if not isinstance(raw, (bytes, bytearray, memoryview)):
        raise ArenaRoundError('invalid_output')
    return bytes(raw)


def _parse_report(raw: bytes) -> dict:
    try:
        report = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ArenaRoundError('invalid_output') from None
    if not isinstance(report, dict) or not isinstance(report.get('findings'), list):
        raise ArenaRoundError('invalid_output')
    if any(not isinstance(finding, dict) for finding in report['findings']):
        raise ArenaRoundError('invalid_output')
    return report


def _execute_one(plan: _Plan, index: int) -> tuple[dict, list[dict]]:
    stdout_path = plan.stdout_dir / f'run-{index + 1}.json'
    payload = _invocation_payload(plan, index)
    started = time.monotonic()
    raw = _call_adapter(plan, payload, stdout_path)
    duration_ms = int(round((time.monotonic() - started) * 1000))
    report = _parse_report(raw)
    meta = {
        'runId': f'{plan.round_id}-r{index + 1}',
        'agentId': Path(plan.argv[0]).name,
        'exitCode': 0,
        'stdoutSha256': arena._sha256_hex(raw),
        'durationMs': duration_ms,
        'findingCount': len(report['findings']),
    }
    return meta, report['findings']


def _execute_runs(plan: _Plan) -> tuple[list[dict], list[dict], ArenaRoundError | None]:
    metas: list[dict] = []
    blue_runs: list[dict] = []
    for index in range(plan.runs):
        try:
            meta, findings = _execute_one(plan, index)
        except ArenaRoundError as error:
            return metas, blue_runs, error
        metas.append(meta)
        blue_runs.append({'runId': meta['runId'], 'agentId': meta['agentId'], 'findings': findings})
    return metas, blue_runs, None


def _evaluate_runs(plan: _Plan, blue_runs: list[dict]):
    if plan.gold is None:
        return None
    try:
        return arena.evaluate_arena_match(plan.gold, blue_runs, baseline_signals=plan.baseline)
    except (ValueError, TypeError):
        raise ArenaRoundError('gold_ledger_invalid') from None


def _adapter_block(plan: _Plan) -> dict:
    return {
        'type': 'stdio-injected' if plan.adapter_injected else 'stdio-subprocess',
        'executableBasename': Path(plan.argv[0]).name,
        'argvShape': [len(plan.argv)],
    }


def _isolation_block(plan: _Plan) -> dict:
    written = ['blind.pdf'] + [f'supplements/{name}' for name in plan.supplement_names]
    return {
        'kind': 'cleanroom-tempdir',
        'osSandbox': False,
        'notice': ISOLATION_NOTICE,
        'agentCwd': 'cleanroom',
        'filesWritten': written,
        'cleanroomRetained': plan.keep_cleanroom,
        'envSource': "harness_adapter.run_stdio fixed allowlist (not an OS sandbox)",
        'envAllowRequested': list(plan.env_allow),
        'network': 'unrestricted',
    }


def _harness_hash() -> str | None:
    if harness_adapter is None:  # pragma: no cover - defensive
        return None
    module_file = getattr(harness_adapter, '__file__', None)
    if not module_file:
        return None
    try:
        return arena._sha256_hex(Path(module_file).read_bytes())
    except OSError:  # pragma: no cover - defensive
        return None


def _round_record(plan: _Plan, verification: dict, started_at: str, metas: list[dict], evaluation) -> dict:
    record = {
        'schema': ROUND_SCHEMA,
        'ok': True,
        'roundId': plan.round_id,
        'startedAt': started_at,
        'finishedAt': _utc_now(),
        'blindBundleSha256': verification['pdfSha256'],
        'adapter': _adapter_block(plan),
        'harnessHash': _harness_hash(),
        'isolation': _isolation_block(plan),
        'cleanroomRetained': plan.keep_cleanroom,
        'runCount': len(metas),
        'runs': metas,
        'evaluation': evaluation,
        'leaks': [],
    }
    if plan.source_sha256:
        record['sourceSha256'] = plan.source_sha256
    if evaluation is None:
        record['warning'] = 'gold_ledger_absent'
    return record


def _blindness_record(verification: dict, started_at: str) -> dict:
    return {
        'schema': ROUND_SCHEMA,
        'ok': False,
        'error': 'blindness_leak_detected',
        'roundId': None,
        'startedAt': started_at,
        'finishedAt': _utc_now(),
        'blindBundleSha256': verification['pdfSha256'],
        'adapter': None,
        'isolation': {
            'kind': 'none',
            'osSandbox': False,
            'notice': ISOLATION_NOTICE,
            'cleanroomRetained': False,
        },
        'cleanroomRetained': False,
        'runCount': 0,
        'runs': [],
        'evaluation': None,
        'leaks': verification['leaks'],
        'blindVerification': verification,
    }


def _failed_record(plan: _Plan, error: ArenaRoundError, verification: dict, started_at: str,
                  metas: list[dict]) -> dict:
    record = _round_record(plan, verification, started_at, metas, None)
    record['ok'] = False
    record['error'] = error.code
    record.pop('warning', None)
    return record


def run_round(
    blind_pdf_bytes,
    agent_argv,
    *,
    gold_ledger=None,
    blind_supplements=None,
    source_pdf_bytes=None,
    adapter=None,
    runs=1,
    run_id=None,
    timeout=180,
    env_allow=None,
    baseline_signals=None,
    keep_cleanroom=False,
) -> dict:
    """Run 1..N blind BLUE turns in a cleanroom and score them against a gold ledger.

    The blind bundle is verified first: a leaked bundle returns a blindness record
    (module CLI exit 3) and never creates a cleanroom or launches the agent.
    """
    started_at = _utc_now()
    try:
        blind_raw = arena._as_pdf_bytes(blind_pdf_bytes, 'blind')
    except ValueError:
        raise ArenaRoundError('blind_pdf_invalid') from None
    supplements = list(blind_supplements or [])
    try:
        verification = arena.verify_blind_bundle(blind_raw, supplements, source_pdf_bytes)
    except ValueError as error:
        code = str(error)
        raise ArenaRoundError(code if code in BUNDLE_ERROR_CODES else 'blind_bundle_invalid') from None
    if not verification['blindClean']:
        return _blindness_record(verification, started_at)
    plan = _build_plan(
        blind_raw=blind_raw,
        argv=_validate_argv(agent_argv),
        supplements=supplements,
        gold=gold_ledger,
        baseline=baseline_signals,
        adapter=adapter,
        runs=runs,
        timeout=timeout,
        run_id=run_id,
        env_allow=env_allow,
        keep_cleanroom=keep_cleanroom,
        source_pdf_bytes=source_pdf_bytes,
        started_at=started_at,
    )
    try:
        return _run_plan(plan, verification, started_at)
    finally:
        _dispose_plan(plan)


def _run_plan(plan: _Plan, verification: dict, started_at: str) -> dict:
    metas, blue_runs, error = _execute_runs(plan)
    if error is not None:
        return _failed_record(plan, error, verification, started_at, metas)
    try:
        evaluation = _evaluate_runs(plan, blue_runs)
    except ArenaRoundError as eval_error:
        return _failed_record(plan, eval_error, verification, started_at, metas)
    return _round_record(plan, verification, started_at, metas, evaluation)


# --------------------------------------------------------------------------------------
# distill
# --------------------------------------------------------------------------------------


def _require_evaluation(round_record) -> dict:
    if not isinstance(round_record, dict):
        raise ArenaRoundError('round_record_invalid')
    evaluation = round_record.get('evaluation')
    if not isinstance(evaluation, dict):
        raise ArenaRoundError('evaluation_absent')
    return evaluation


def _gold_codes(gold_ledger) -> dict[str, dict]:
    """Defect id -> code-only axes; item text is never copied."""
    if gold_ledger is None:
        return {}
    try:
        items = arena._normalize_gold_ledger(gold_ledger)
    except ValueError:
        raise ArenaRoundError('gold_ledger_invalid') from None
    codes: dict[str, dict] = {}
    for item in items:
        surface = 'SUPPLEMENT' if item['supplementName'] else ('LAYOUT' if item['bbox'] else 'TEXT')
        codes[item['defectId']] = {
            'family': _code(item['family']) or 'NA',
            'world': _code(item['world']) or 'NA',
            'difficulty': _code(item['difficulty']) or 'NA',
            'surface': surface,
        }
    return codes


def _code(value: str) -> str:
    return str(value or '').strip().upper()


def _matched_ids(run: dict) -> set[str]:
    return {str(pair.get('defectId')) for pair in (run.get('matchedPairs') or []) if isinstance(pair, dict)}


def _detection_matrix(evaluation: dict) -> dict[str, list[bool]]:
    runs = [run for run in (evaluation.get('runs') or []) if isinstance(run, dict)]
    order: list[str] = []
    for run in runs:
        for pair in run.get('matchedPairs') or []:
            defect_id = str(pair.get('defectId'))
            if defect_id not in order:
                order.append(defect_id)
        for defect_id in run.get('missedDefectIds') or []:
            if str(defect_id) not in order:
                order.append(str(defect_id))
    matched = [_matched_ids(run) for run in runs]
    return {defect_id: [defect_id in hits for hits in matched] for defect_id in order}


def _classify_defects(matrix: dict[str, list[bool]]) -> dict[str, list[str]]:
    classes: dict[str, list[str]] = {'missed': [], 'flip': [], 'detected': []}
    for defect_id in sorted(matrix):
        flags = matrix[defect_id]
        if not flags or not any(flags):
            classes['missed'].append(defect_id)
        elif all(flags):
            classes['detected'].append(defect_id)
        else:
            classes['flip'].append(defect_id)
    return classes


def _row(defect_id: str, codes: dict[str, dict], klass: str) -> dict:
    axes = codes.get(defect_id) or {}
    return {
        'failureClass': klass,
        'family': axes.get('family') or 'NA',
        'surface': axes.get('surface') or 'NA',
        'world': axes.get('world') or 'NA',
        'difficulty': axes.get('difficulty') or 'NA',
    }


def _bump(bucket: dict[str, dict], code: str, klass: str) -> None:
    entry = bucket.setdefault(code, {'total': 0, 'missed': 0, 'flip': 0, 'detected': 0})
    entry['total'] += 1
    entry[klass] += 1


def _stratify(rows: list[dict]) -> dict[str, dict[str, dict]]:
    axes: dict[str, dict[str, dict]] = {'family': {}, 'surface': {}, 'world': {}, 'difficulty': {}}
    for row in rows:
        for axis in axes:
            _bump(axes[axis], row[axis], row['failureClass'])
    return axes


def _totals(evaluation: dict) -> dict:
    aggregate = evaluation.get('aggregate') or {}
    runs = [run for run in (evaluation.get('runs') or []) if isinstance(run, dict)]
    zero_drop = 0
    for run in runs:
        zero_drop += len(run.get('uncertainMatchedDefectIds') or [])
    return {
        'runCount': int(evaluation.get('runCount') or len(runs)),
        'goldCount': int(evaluation.get('goldCount') or 0),
        'tp': int(aggregate.get('tp') or 0),
        'fn': int(aggregate.get('fn') or 0),
        'pureFp': int(aggregate.get('pureFp') or 0),
        'preExistingExempted': int(aggregate.get('preExistingExempted') or 0),
        'abstainedCount': int(aggregate.get('abstainedCount') or 0),
        'zeroDropRecovered': zero_drop,
        'recall': aggregate.get('recall'),
        'precision': aggregate.get('precision'),
        'stealthYield': aggregate.get('stealthYield'),
    }


def _gold_items(gold_ledger) -> list[tuple[str, dict]]:
    """Raw (defectId, item) pairs; raw items keep stealthStatus, normalizers drop it."""
    if gold_ledger is None:
        return []
    if isinstance(gold_ledger, list):
        items = gold_ledger
    elif isinstance(gold_ledger, dict):
        items = next(
            (gold_ledger[key] for key in ('defects', 'changes', 'entries', 'operations')
             if isinstance(gold_ledger.get(key), list)),
            None,
        )
        if items is None:
            raise ArenaRoundError('gold_ledger_invalid')
    else:
        raise ArenaRoundError('gold_ledger_invalid')
    return [
        (str(item.get('defectId') or item.get('id') or f'gold-{index + 1}'), item)
        for index, item in enumerate(items)
        if isinstance(item, dict)
    ]


def _early_red_ids(gold_ledger) -> list[str]:
    early = [
        defect_id
        for defect_id, item in _gold_items(gold_ledger)
        if str(item.get('stealthStatus') or '').strip().lower() == 'detectable_artifact'
    ]
    return sorted(set(early))


def _run_ids(run: dict) -> set[str]:
    ids: set[str] = set()
    for pair in run.get('matchedPairs') or []:
        ids.add(str(pair.get('defectId') or ''))
        ids.add(str(pair.get('findingId') or ''))
    for field in ('missedDefectIds', 'uncertainMatchedDefectIds'):
        ids.update(str(value) for value in run.get(field) or [])
    for false_positive in run.get('pureFalsePositives') or []:
        ids.add(str(false_positive.get('findingId') or ''))
    return ids


def _id_values(round_record: dict, gold_ledger) -> list[str]:
    """Every defect/finding/unit id that must never reappear in a distilled artifact."""
    ids = {defect_id for defect_id, _ in _gold_items(gold_ledger)}
    evaluation = round_record.get('evaluation') or {}
    for run in evaluation.get('runs') or []:
        if isinstance(run, dict):
            ids |= _run_ids(run)
    for unit in (evaluation.get('agreement') or {}).get('units') or []:
        ids.add(str(unit.get('unitId') or ''))
    return sorted(value for value in ids if value and len(value) >= 3)


def _build_summary(evaluation: dict, gold_ledger) -> dict:
    matrix = _detection_matrix(evaluation)
    classes = _classify_defects(matrix)
    codes = _gold_codes(gold_ledger)
    early = set(_early_red_ids(gold_ledger))
    rows = [_row(defect_id, codes, 'missed') for defect_id in classes['missed']]
    rows += [_row(defect_id, codes, 'flip') for defect_id in classes['flip']]
    rows += [_row(defect_id, codes, 'detected') for defect_id in classes['detected']]
    totals = _totals(evaluation)
    summary = dict(totals)
    summary.update({
        'detectedUnion': len(classes['detected']),
        'missedUnion': len(classes['missed']),
        'flipUnion': len(classes['flip']),
        'earlyRedCount': len([defect_id for defect_id in classes['detected'] if defect_id in early]),
        'axes': _stratify(rows),
    })
    return summary


def _rule(rule_id: str, failure_class: str, statement: str, procedure: list[str], rationale: str,
          family: str | None = None, surface: str | None = None) -> dict:
    rule = {'ruleId': rule_id, 'failureClass': failure_class}
    if family:
        rule['family'] = family
    if surface:
        rule['surface'] = surface
    rule['statement'] = statement
    rule['procedure'] = procedure
    rule['rationale'] = rationale
    return rule


def _family_rule(code: str, counts: dict) -> dict:
    label, step = FAMILY_TEMPLATES.get(code, FAMILY_TEMPLATES['NA'])
    missed = int(counts.get('missed') or 0)
    flips = int(counts.get('flip') or 0)
    detail = f', 재현 불안정 {flips}건' if flips else ''
    statement = f'{code}({label}) 미탐 {missed + flips}건{detail}: {step}'
    procedure = [step, f'{code} 축 항목만 모아 같은 절차를 2회 반복하고 불일치 항목을 확인필요로 남긴다.']
    rationale = f'{code} 축은 코드 단위로 절차를 고정할 수 있어 항목 값 없이도 재현 가능하다.'
    return _rule(f'fn-{code.lower()}', 'fn', statement, procedure, rationale, family=code)


AXIS_LABELS = {'family': '계열', 'surface': '표면', 'world': '월드', 'difficulty': '난이도'}


def _axis_rule(axis: str, code: str, counts: dict) -> dict:
    label = AXIS_LABELS.get(axis, axis)
    missed = int(counts.get('missed') or 0) + int(counts.get('flip') or 0)
    statement = f'{label} 코드 {code} 미탐 {missed}건: 같은 {label} 코드 항목에서 먼저 재계산·교차 대조를 수행한다.'
    procedure = [
        f'{label} 코드 {code}에 속한 항목만 추출해 표·본문·보충자료 순서로 대조한다.',
        '대조 결과가 원문과 양립하면 확인필요로 남기고 순수 오탐으로 확정하지 않는다.',
    ]
    rationale = f'{label} 코드 {code}는 반복 실패가 집중된 축이라 절차 보강 우선순위가 높다.'
    return _rule(f'fn-{axis}-{code.lower()}', 'fn', statement, procedure, rationale)


def _axis_rules(axes: dict) -> list[dict]:
    rules: list[dict] = []
    for code, counts in sorted(axes.get('family', {}).items()):
        if counts['missed'] or counts['flip']:
            rules.append(_family_rule(code, counts))
    for axis in ('surface', 'world', 'difficulty'):
        for code, counts in sorted(axes.get(axis, {}).items()):
            if counts['missed'] or counts['flip']:
                rules.append(_axis_rule(axis, code, counts))
    return rules


def _class_rules(summary: dict) -> list[dict]:
    rules = []
    if summary['pureFp']:
        rules.append(_rule(
            'fp-pure', 'pure_fp',
            f'순수 오탐 {summary["pureFp"]}건: 지적 전 다중검정 보정과 부분집합 분모 조건을 먼저 확인한다.',
            ['지적 대상이 이미 원문에 존재하는 정상 표기인지 먼저 확인한다.',
             '보정·분모 조건이 확인되면 결함이 아니라 기존 정상 항목으로 분류한다.'],
            '순수 오탐은 원본에 없는 결함을 새로 주장할 때 발생하므로 반증 확인 절차를 앞에 둔다.',
        ))
    if summary['preExistingExempted']:
        rules.append(_rule(
            'fp-pre-existing', 'pre_existing',
            f'원본 기존 오류 {summary["preExistingExempted"]}건: 출판본 자체 불일치를 순수 오탐과 분리 보고한다.',
            ['기준선 신호와 일치하는 지적은 별도 등급으로 분리한다.',
             '분리된 지적은 정확도 계산에서 제외하고 근거와 함께 기록한다.'],
            '기존 오류를 순수 오탐으로 세면 탐지 절차가 실제로 나빠진 것처럼 보인다.',
        ))
    if summary['abstainedCount'] or summary['zeroDropRecovered']:
        rules.append(_rule(
            'abstain-retention', 'abstain',
            f'확인필요 {summary["abstainedCount"]}건 · Zero-Drop 복구 {summary["zeroDropRecovered"]}건 보존: '
            '경계 지적을 즉시 탈락시키지 않는다.',
            ['근거가 부분적으로만 성립하는 지적은 확인필요로 유지한다.',
             '확정 임계치를 넘지 못한 지적도 다음 라운드 근거로 보존한다.'],
            'Zero-Drop은 확신도 경계의 참 지적을 버리지 않는 계약이다.',
        ))
    if summary['flipUnion']:
        rules.append(_rule(
            'flip-instability', 'flip',
            f'재현 불안정 {summary["flipUnion"]}건: 같은 입력에서 탐지가 갈리는 축은 절차를 고정한다.',
            ['갈린 축의 판정 순서와 인용 규칙을 고정한다.',
             '같은 입력을 반복 실행해 판정이 유지되는지 확인한다.'],
            '반복 실행에서 갈리는 결함은 모델 성능이 아니라 절차 모호성의 신호다.',
        ))
    if summary['earlyRedCount']:
        rules.append(_rule(
            'early-red-stealth', 'early_red',
            f'조기 노출 {summary["earlyRedCount"]}건: 위장이 성립하지 않은 주입은 다음 라운드에서 재설계한다.',
            ['탐지된 주입의 표면 흔적을 제거하고 다중 표면 결합으로 다시 주입한다.',
             '동일 축을 반복 사용하지 않고 인접 축으로 확장한다.'],
            '위장 실패 주입은 BLUE 난이도를 올리지 못하므로 RED 예산을 낭비한다.',
        ))
    return rules


def _select_rules(rules: list[dict], max_rules: int) -> list[dict]:
    ordered = sorted(rules, key=lambda item: (item.get('family') or '', item['failureClass'], item['ruleId']))
    unique: dict[str, dict] = {}
    for rule in ordered:
        unique.setdefault(rule['ruleId'], rule)
    return sorted(unique.values(), key=lambda item: (item.get('family') or '', item['failureClass'], item['ruleId']))[
        :max_rules
    ]


def _brief_lines(header: str, summary_text: str, rules: list[dict], tail: list[str]) -> str:
    lines = [header, summary_text]
    lines.extend(f'{index + 1}. {rule["statement"]}' for index, rule in enumerate(rules))
    offset = len(rules)
    lines.extend(f'{offset + index + 1}. {text}' for index, text in enumerate(tail))
    return '\n'.join(lines)


def _red_brief(summary: dict, rules: list[dict]) -> dict:
    missed = summary['missedUnion'] + summary['flipUnion']
    text = (
        f'관찰 요약: 주입 {summary["goldCount"]}건 중 BLUE 미탐 {missed}건 · '
        f'확정 탐지 {summary["detectedUnion"]}건 · 순수 오탐 {summary["pureFp"]}건.'
    )
    tail = [
        '기탐지 유형은 L1 → L2 → L3 → L4 단계로 교차 섹션(본문↔표·차트·참고문헌) 연동을 강화하고 '
        '단순 어휘 치환은 피한다.',
        '다음 라운드 주입은 위장이 유지되는 표면만 사용하고, 정답 힌트나 과장 단서는 남기지 않는다.',
    ]
    return {
        'title': '도둑(RED) 스트레스 테스트 고도화 지침',
        'summary': text,
        'rules': [rule['statement'] for rule in rules],
        'instructionsText': _brief_lines('[RED Co-Evolution Brief]', text, rules, tail),
    }


def _blue_brief(summary: dict, rules: list[dict]) -> dict:
    missed = summary['missedUnion'] + summary['flipUnion']
    text = (
        f'관찰 요약: 적중 {summary["tp"]} / 주입 {summary["goldCount"]}건 · 미탐 {missed}건 · '
        f'순수 오탐 {summary["pureFp"]}건 · 원본 기존 오류 {summary["preExistingExempted"]}건 · '
        f'확인필요 {summary["abstainedCount"]}건.'
    )
    tail = [
        f'Zero-Drop 복구 {summary["zeroDropRecovered"]}건 보존: 확신도 경계의 지적을 즉시 탈락시키지 말고 '
        '확인필요 등급으로 유지한다.',
        '미탐 0건 · 순수 오탐 0건이어도 표면 교차 확인 절차는 유지한다.',
    ]
    return {
        'title': '경찰(BLUE) 검증 도구 보강 지침',
        'summary': text,
        'rules': [rule['statement'] for rule in rules],
        'instructionsText': _brief_lines('[BLUE Co-Evolution Brief]', text, rules, tail),
    }


def _secret_texts(gold_ledger, round_record: dict) -> list[str]:
    secrets: list[str] = []
    if gold_ledger is not None:
        try:
            for item in arena._normalize_gold_ledger(gold_ledger):
                secrets.extend(text for text in item['texts'] if len(text) >= 12)
        except ValueError:
            raise ArenaRoundError('gold_ledger_invalid') from None
    evaluation = round_record.get('evaluation') or {}
    for run in evaluation.get('runs') or []:
        for false_positive in run.get('pureFalsePositives') or []:
            quote = str(false_positive.get('quote') or '')
            if len(quote) >= 12:
                secrets.append(quote)
    return sorted({arena._norm_space(text).lower() for text in secrets if arena._norm_space(text)})


def _scrub_string(text: str, secrets: list[str], ids: set[str], path: str, hits: list[str]) -> None:
    lowered = text.lower()
    for token in arena.UNAMBIGUOUS_SUPPLEMENT_TOKENS:
        if token in lowered:
            hits.append(f'{path}:token')
    for secret in ANSWER_KEY_STRINGS:
        if secret.lower() in lowered:
            hits.append(f'{path}:answer_key_literal')
    for name, pattern in (('doi', DOI_RE), ('p_value', P_VALUE_RE), ('registry', REGISTRY_RE), ('file_name', FILE_NAME_RE)):
        if pattern.search(text):
            hits.append(f'{path}:{name}')
    for secret in secrets:
        if secret in lowered:
            hits.append(f'{path}:verbatim')
    if ids & {token.lower() for token in re.split(r'[^A-Za-z0-9_-]+', text)}:
        hits.append(f'{path}:item_id')
    if re.search(r'\b(gold|ledger|answer)\b', lowered):
        hits.append(f'{path}:answer_reference')


def _scrub_node(node, secrets: list[str], ids: set[str], path: str, hits: list[str]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if str(key).lower() in DENY_KEYS:
                hits.append(f'{path}.{key}:forbidden_key')
            _scrub_node(value, secrets, ids, f'{path}.{key}', hits)
        return
    if isinstance(node, list):
        for index, value in enumerate(node):
            _scrub_node(value, secrets, ids, f'{path}[{index}]', hits)
        return
    if isinstance(node, str):
        _scrub_string(node, secrets, ids, path, hits)


def _scrub_codes(patch: dict, hits: list[str]) -> None:
    for axis, buckets in (patch['summary'].get('axes') or {}).items():
        for code in buckets:
            if not CODE_RE.fullmatch(str(code)):
                hits.append(f'summary.axes.{axis}.{code}:code_invalid')
    for rule in patch['rules']:
        for field in ('family', 'surface'):
            value = rule.get(field)
            if value is not None and not CODE_RE.fullmatch(str(value)):
                hits.append(f'rules.{rule["ruleId"]}.{field}:code_invalid')


def _scrub(patch: dict, secrets: list[str], ids: set[str]) -> None:
    hits: list[str] = []
    _scrub_node(patch, secrets, ids, 'patch', hits)
    _scrub_codes(patch, hits)
    if hits:
        raise DistillScrubError(hits)


_FAILURE_ALIASES = {
    'early_red': 'early_caught',
    'earlyred': 'early_caught',
    'purefp': 'pure_fp',
    'pure_false_positive': 'pure_fp',
    'false_positive': 'pure_fp',
    'fp': 'pure_fp',
    'miss': 'missed',
}
_SEVERITY_RANK = {'missed': 0, 'flip': 1, 'pure_fp': 2, 'early_caught': 3}
_FAMILY_RE = re.compile(
    r'(?:family|계열)\s*(?:code|코드)?\s*[:#-]?\s*([A-Za-z][A-Za-z0-9-]{0,12})',
    re.IGNORECASE,
)
_SURFACE_RE = re.compile(
    r'(?:surface|표면)\s*(?:code|코드)?\s*[:#-]?\s*([A-Za-z][A-Za-z0-9-]{0,12})',
    re.IGNORECASE,
)
_LEAD_CODE_RE = re.compile(r'^\s*([A-Z][A-Z0-9]{0,6}(?:-[A-Z0-9]{1,3})?)\b')


def _code_token(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    code = re.sub(r'[^A-Za-z0-9-]+', '', text).upper()
    if not code:
        return None
    if CODE_RE.fullmatch(code):
        return code
    return 'S' + hashlib.sha256(code.encode('utf-8')).hexdigest()[:6].upper()


def _failure_token(rule: dict) -> str:
    raw = rule.get('failureClass')
    if raw is None:
        raw = rule.get('kind')
    token = str(raw or 'other').strip().lower().replace('-', '_').replace(' ', '_')
    return _FAILURE_ALIASES.get(token, token or 'other')


def _axes_token(rule: dict, key: str) -> str | None:
    axes = rule.get('axes')
    if not isinstance(axes, dict) or key not in axes:
        return None
    return _code_token(axes.get(key))


def _id_tokens(rule_id: str) -> dict:
    parts = [part for part in re.split(r'[^A-Za-z0-9]+', str(rule_id or '')) if part]
    lowered = [part.lower() for part in parts]
    found = {}
    for index, name in enumerate(lowered):
        axis = {'family': 'family', 'surface': 'surface'}.get(name)
        if axis and index + 1 < len(parts):
            found[axis] = _code_token(parts[index + 1])
    if 'family' not in found and len(parts) >= 2 and lowered[0] in ('fn', 'fp', 'rule'):
        if lowered[1] not in ('family', 'surface'):
            found['family'] = _code_token(parts[1])
    return {key: value for key, value in found.items() if value}


def _statement_stem(statement: str) -> str:
    text = re.sub(r'\d+', '', statement.lower())
    text = re.sub(r'[^a-z0-9가-힣]+', '-', text).strip('-')
    return text[:64]


def _statement_axes(statement: str) -> dict:
    text = str(statement or '')
    found = {}
    family = _FAMILY_RE.search(text)
    surface = _SURFACE_RE.search(text)
    if family:
        found['family'] = _code_token(family.group(1))
    if surface:
        found['surface'] = _code_token(surface.group(1))
    if 'family' not in found:
        lead = _LEAD_CODE_RE.match(text)
        if lead:
            found['family'] = _code_token(lead.group(1))
    return {key: value for key, value in found.items() if value}


def _axis_value(rule: dict, key: str) -> str | None:
    if key in rule:
        direct = _code_token(rule.get(key))
        if direct:
            return direct
    from_axes = _axes_token(rule, key)
    if from_axes:
        return from_axes
    from_id = _id_tokens(str(rule.get('ruleId') or '')).get(key)
    if from_id:
        return from_id
    return _statement_axes(str(rule.get('statement') or '')).get(key)


def _rule_signature(rule: dict) -> tuple[str, str, str]:
    family = _axis_value(rule, 'family')
    surface = _axis_value(rule, 'surface') or 'NA'
    if not family:
        stem = _statement_stem(str(rule.get('statement') or ''))
        family = _code_token(stem) if stem else 'NA'
    return family or 'NA', surface, _failure_token(rule)


def _support_value(rule: dict) -> int:
    for key in ('supportCount', 'count'):
        value = rule.get(key)
        if type(value) is int and value >= 0:
            return value
    return 1


def _statement_key(rule: dict) -> tuple:
    priority = rule.get('priority', 0)
    if isinstance(priority, bool) or not isinstance(priority, (int, float)):
        priority = 0
    statement = str(rule.get('statement') or '')
    noisy = 1 if re.search(r'\d', statement) else 0
    return (float(priority), -noisy, len(statement), statement)


def _constituent_ids(rule: dict) -> list:
    nested = rule.get('mergedRuleIds')
    if isinstance(nested, list) and nested:
        return nested
    return [rule.get('ruleId')]


def _merged_ids(members: list[dict]) -> list[str]:
    found = []
    seen: set[str] = set()
    for rule in members:
        for candidate in _constituent_ids(rule):
            rule_id = str(candidate or '').strip()
            if not rule_id or rule_id in seen:
                continue
            seen.add(rule_id)
            found.append(rule_id)
    return found


def _merge_group(signature: tuple[str, str, str], members: list[dict]) -> dict:
    best = max(members, key=_statement_key)
    family, surface, failure = signature
    return {
        'ruleId': 'cr-' + hashlib.sha256('|'.join(signature).encode('utf-8')).hexdigest()[:12],
        'failureClass': failure,
        'family': family,
        'surface': surface,
        'statement': str(best.get('statement') or ''),
        'supportCount': sum(_support_value(rule) for rule in members),
        'mergedRuleIds': _merged_ids(members),
    }


def _severity_key(rule: dict) -> tuple:
    rank = _SEVERITY_RANK.get(str(rule.get('failureClass') or ''), 9)
    return (rank, -int(rule.get('supportCount') or 0), str(rule.get('ruleId') or ''))


def _group_rules(rules: list) -> list[dict]:
    groups: dict[tuple, list] = {}
    order: list[tuple] = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        signature = _rule_signature(rule)
        bucket = groups.get(signature)
        if bucket is None:
            bucket = []
            groups[signature] = bucket
            order.append(signature)
        bucket.append(rule)
    return [_merge_group(signature, groups[signature]) for signature in order]


def _scrub_compact(document: dict) -> None:
    probe = dict(document)
    probe['summary'] = {'axes': {}}
    try:
        _scrub(probe, [], set())
    except DistillScrubError:
        raise ArenaRoundError('distill_scrub_failed', 3) from None


def _leak_view(rule: dict) -> dict:
    view = dict(rule)
    for key in ('family', 'surface'):
        if key in view:
            view[key] = _code_token(view.get(key)) or 'NA'
    if 'ruleId' not in view:
        view['ruleId'] = 'rule'
    return view


def _scrub_input_rules(rules: list) -> None:
    views = [_leak_view(rule) for rule in rules if isinstance(rule, dict)]
    _scrub_compact({'schema': COMPACT_RULES_SCHEMA, 'rules': views, 'scrubbed': True})


def compact_harness_rules(rules: list[dict], *, max_rules: int = 24) -> dict:
    """Merge repeated harness rules into one scrubbed, severity-ordered set."""
    limit = _validate_int(max_rules, 'max_rules', 1, 100)
    if not isinstance(rules, list):
        raise ArenaRoundError('rules_invalid')
    _scrub_input_rules(rules)
    chosen = sorted(_group_rules(rules), key=_severity_key)[:limit]
    document = {
        'schema': COMPACT_RULES_SCHEMA,
        'inputRuleCount': len(rules),
        'outputRuleCount': len(chosen),
        'droppedCount': len(rules) - len(chosen),
        'rules': chosen,
        'scrubbed': True,
    }
    _scrub_compact(document)
    return document


def distill_round(round_record, *, gold_ledger=None, max_rules=40) -> dict:
    """Turn a scored round record into a generalized, answer-key-free harness patch."""
    max_rules = _validate_int(max_rules, 'max_rules', 1, 400)
    evaluation = _require_evaluation(round_record)
    summary = _build_summary(evaluation, gold_ledger)
    rules = _select_rules(_axis_rules(summary['axes']) + _class_rules(summary), max_rules)
    finished = str(round_record.get('finishedAt') or round_record.get('startedAt') or '')
    patch = {
        'schema': PATCH_SCHEMA,
        'patchId': '',
        'generatedAt': finished,
        'basedOnRoundId': str(round_record.get('roundId') or ''),
        'source': ROUND_SCHEMA,
        'summary': summary,
        'rules': rules,
        'redBrief': _red_brief(summary, rules),
        'blueBrief': _blue_brief(summary, rules),
        'scrubbed': True,
        'answerKeyFree': True,
    }
    _scrub(patch, _secret_texts(gold_ledger, round_record), set(_id_values(round_record, gold_ledger)))
    canonical = json.dumps(patch, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    patch['patchId'] = 'patch-' + hashlib.sha256(canonical).hexdigest()[:16]
    return patch


# --------------------------------------------------------------------------------------
# module CLI
# --------------------------------------------------------------------------------------


def _build_cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='arena_round.py',
        description='Cleanroom ARENA round runner and answer-key-free rule distiller.',
    )
    sub = parser.add_subparsers(dest='command', required=True)

    run = sub.add_parser('run-round', help='Run 1..N blind BLUE turns in a cleanroom and score them.')
    run.add_argument('--pdf', required=True, type=Path, help='Blind PDF (verified before the cleanroom exists)')
    run.add_argument('--source-pdf', type=Path, help='Optional source PDF for inherited-metadata exemption')
    run.add_argument('--supplement', action='extend', nargs='+', type=Path, default=[], help='Supplement files')
    run.add_argument('--gold', type=Path, help='Gold RED ledger JSON (omit to run without scoring)')
    run.add_argument('--baseline', type=Path, help='Optional Baseline Guard sensor JSON')
    run.add_argument('--agent-cmd', help='Agent executable (stdio adapter; falsify.harness-invocation.v1 in)')
    run.add_argument('--agent-arg', action='extend', nargs='+', default=[], help='Agent arguments')
    run.add_argument('--timeout', type=int, default=180, help='Per-run wall clock seconds (1-1800)')
    run.add_argument('--runs', type=int, default=1, help='Repeat count (1-20)')
    run.add_argument('--env-allow', action='extend', nargs='+', default=[], help='Extra env names (injected adapters only)')
    run.add_argument('--keep-cleanroom', action='store_true', help='Retain the cleanroom directory (path is not recorded)')
    run.add_argument('--out', type=Path, help='Optional output JSON path')

    dist = sub.add_parser('distill', help='Distill a scored round record into an answer-key-free patch.')
    dist.add_argument('--round', required=True, type=Path, help='Round record JSON')
    dist.add_argument('--gold', type=Path, help='Optional gold ledger for axis codes and stealth status')
    dist.add_argument('--max-rules', type=int, default=40, help='Rule cap (1-400)')
    dist.add_argument('--out', type=Path, help='Optional output JSON path')
    return parser


def _load_json(path: Path | None, code: str):
    if path is None:
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ArenaRoundError(code) from None


def _cmd_run_round(args: argparse.Namespace) -> int:
    if not args.agent_cmd:
        raise ArenaRoundError('agent_required')
    supplements = [{'name': path.name, 'bytes': path.read_bytes()} for path in args.supplement]
    record = run_round(
        args.pdf.read_bytes(),
        [args.agent_cmd, *(args.agent_arg or [])],
        gold_ledger=_load_json(args.gold, 'gold_ledger_invalid'),
        blind_supplements=supplements,
        source_pdf_bytes=args.source_pdf.read_bytes() if args.source_pdf else None,
        runs=args.runs,
        timeout=args.timeout,
        env_allow=tuple(args.env_allow or ()),
        baseline_signals=_load_json(args.baseline, 'baseline_signals_invalid'),
        keep_cleanroom=args.keep_cleanroom,
    )
    _write_json_output(record, args.out)
    return 0 if record.get('ok') else _error_exit(str(record.get('error')))


def _cmd_distill(args: argparse.Namespace) -> int:
    round_record = _load_json(args.round, 'round_record_invalid')
    patch = distill_round(
        round_record,
        gold_ledger=_load_json(args.gold, 'gold_ledger_invalid'),
        max_rules=args.max_rules,
    )
    _write_json_output(patch, args.out)
    return 0


def _write_json_output(payload: dict, out_path: Path | None) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if out_path is not None:
        out_path.write_text(rendered + '\n', encoding='utf-8')
    print(rendered)


def _error_payload(command: str, error: Exception) -> dict:
    hits = getattr(error, 'hits', [])
    return {
        'schema': ERROR_SCHEMA,
        'ok': False,
        'command': command,
        'error': str(getattr(error, 'code', 'input_invalid')),
        'hitCount': len(hits),
    }


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint: run-round and distill, one JSON document on stdout."""
    args = _build_cli_parser().parse_args(argv)
    command = args.command
    try:
        if command == 'run-round':
            return _cmd_run_round(args)
        return _cmd_distill(args)
    except DistillScrubError as error:
        _write_json_output(_error_payload(command, error), args.out)
        return 3
    except ArenaRoundError as error:
        _write_json_output(_error_payload(command, error), args.out)
        return error.exit_code
    except (OSError, ValueError) as error:  # unreadable input paths and similar
        _write_json_output(_error_payload(command, ArenaRoundError('input_invalid')), args.out)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

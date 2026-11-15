"""Unattended RED/BLUE duel and generation-capped harness patch promotion.

``run_duel`` keeps the RED workspace (source PDF and gold ledger) out of the BLUE
cleanroom. ``apply_harness_patch`` promotes a scrubbed ``falsify.harness-patch.v1``
only while generation, answer-key scrubbing, and holdout false-positive guards pass.

Scoring, blind verification, cleanroom rounds, stdio execution, the baseline sensor,
quote checks, and detectability simulation are reused. This module does not
reimplement them.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile

_EVAL_DIR = Path(__file__).resolve().parent
if str(_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_EVAL_DIR))
_REPO_ROOT = _EVAL_DIR.parents[1]
_APP_LOCAL = _REPO_ROOT / 'app' / 'local'
if str(_APP_LOCAL) not in sys.path:
    sys.path.insert(0, str(_APP_LOCAL))

import arena_round  # noqa: E402
import arena_runner  # noqa: E402
import blue_report_validate  # noqa: E402
import harness_adapter  # noqa: E402
from paper_blue_sensor import run_blue_sensor  # noqa: E402
from paper_evidence import EvidenceStore  # noqa: E402

DUEL_SCHEMA = 'falsify.arena-duel.v1'
PATCH_APPLY_SCHEMA = 'falsify.harness-patch-apply.v1'
ERROR_SCHEMA = 'falsify.arena-duel-error.v1'
HARNESS_SCHEMA = 'falsify.harness.v1'
PATCH_SCHEMA = 'falsify.harness-patch.v1'
MAX_GENERATIONS_CAP = 3
_DIFF_RANK = {'L1': 1, 'L2': 2, 'L3': 3, 'L4': 4}
_ROLES = ('blue', 'red')


class ArenaDuelError(ValueError):
    """Fixed-code duel failure. ``exit_code`` is the module CLI status."""

    def __init__(self, code: str, exit_code: int = 2, extra: dict | None = None) -> None:
        self.code = code
        self.exit_code = exit_code
        self.extra = dict(extra or {})
        super().__init__(code)


# --------------------------------------------------------------------------------------
# shared checks
# --------------------------------------------------------------------------------------


def _require_pdf(raw, code: str) -> bytes:
    if not isinstance(raw, (bytes, bytearray)) or not bytes(raw).startswith(b'%PDF-'):
        raise ArenaDuelError(code, 2)
    return bytes(raw)


def _require_argv(argv, code: str) -> list[str]:
    try:
        return arena_round._validate_argv(argv)
    except arena_round.ArenaRoundError:
        raise ArenaDuelError(code, 2) from None


def _require_difficulty(min_difficulty):
    if min_difficulty is None:
        return None
    token = str(min_difficulty).strip().upper()
    if token not in _DIFF_RANK:
        raise ArenaDuelError('min_difficulty_invalid', 2)
    return token


def _bind_sensor(pdf_bytes: bytes, code: str) -> dict:
    raw = _require_pdf(pdf_bytes, code)
    digest = hashlib.sha256(raw).hexdigest()
    store = EvidenceStore()
    try:
        summary = store.prepare(raw, digest)
        report = run_blue_sensor(
            summary['paperId'],
            file_hash=digest,
            max_signals=50,
            include_external_oracle=False,
            store=store,
        )
    except (ValueError, TypeError, RuntimeError, OSError):
        raise ArenaDuelError('baseline_sensor_failed', 2) from None
    return {'report': report, 'store': store, 'paperId': report.get('paperId'), 'fileHash': digest}


def _exit_for_round(code: str) -> int:
    if code == 'timeout':
        return 124
    if code in ('blindness_leak_detected', 'distill_scrub_failed'):
        return 3
    return 2


def _require_round_ok(record: dict) -> dict:
    if record.get('ok'):
        return record
    code = str(record.get('error') or 'round_failed')
    raise ArenaDuelError(code, _exit_for_round(code))


# --------------------------------------------------------------------------------------
# RED workspace
# --------------------------------------------------------------------------------------


def _safe_name(entry: dict, index: int, used: set[str]) -> str:
    raw = str(entry.get('name') or f'supplement-{index + 1}')
    base = Path(raw).name
    cleaned = ''.join(ch if ch.isalnum() or ch in '._-' else '_' for ch in base).lstrip('.')
    safe = cleaned or f'supplement-{index + 1}'
    if safe in used:
        stem, dot, suffix = safe.partition('.')
        safe = f'{stem}-{index + 1}.{suffix}' if suffix else f'{stem}-{index + 1}'
    used.add(safe)
    return safe


def _payload_bytes(entry: dict) -> bytes:
    if isinstance(entry.get('bytes'), (bytes, bytearray, memoryview)):
        return bytes(entry['bytes'])
    if isinstance(entry.get('text'), str):
        return entry['text'].encode('utf-8')
    return str(entry.get('content') or '').encode('utf-8')


def _write_supplements(workspace: Path, supplements) -> list[str]:
    entries = list(supplements or [])
    if not entries:
        return []
    folder = workspace / 'supplements'
    folder.mkdir()
    names: list[str] = []
    used: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ArenaDuelError('supplement_invalid', 2)
        name = _safe_name(entry, index, used)
        (folder / name).write_bytes(_payload_bytes(entry))
        names.append(name)
    return names


def _red_payload(min_difficulty, names: list[str], extra: dict | None = None) -> bytes:
    body = {
        'schema': 'falsify.red-invocation.v1',
        'sourcePdf': 'source.pdf',
        'outPdf': 'blind.pdf',
        'outGold': 'gold.json',
        'outSupplementsDir': 'blind_supplements',
        'minDifficulty': min_difficulty,
        'supplementNames': names,
    }
    if extra:
        body.update(extra)
    return json.dumps(body, ensure_ascii=False).encode('utf-8')


def _harness_red_fields(red_harness) -> dict | None:
    """Scrub-check a RED harness and return the brief fields forwarded to RED only."""
    if red_harness is None:
        return None
    _require_base(red_harness)
    brief = red_harness.get('redBrief')
    rules = red_harness.get('accumulatedRules') or []
    probe = {
        'summary': {'axes': {}},
        'rules': [rule for rule in list(rules) if isinstance(rule, dict)],
        'instructions': str(red_harness.get('instructions') or ''),
    }
    if brief is not None:
        probe['redBrief'] = brief
    _rescrub(probe)
    fields = {'harnessGeneration': red_harness.get('generation', 0)}
    if brief is not None:
        fields['redBrief'] = brief
    return fields


def _default_red_adapter(timeout: int):
    def run(argv, payload, cwd, stdout_path, env_allow=None):
        if env_allow:
            raise ArenaDuelError('env_allow_unsupported', 2)
        with arena_round._timeout_scope(timeout):
            return harness_adapter.run_stdio(list(argv), payload, str(cwd), str(stdout_path))

    return run


def _raise_adapter(error: Exception) -> None:
    code = str(getattr(error, 'code', '') or '')
    if code == 'timeout':
        raise ArenaDuelError('timeout', 124) from None
    raise ArenaDuelError('red_adapter_failed', 2) from None


def _call_red(adapter, argv, payload: bytes, cwd: Path, stdout_path: Path) -> bytes:
    try:
        raw = adapter(list(argv), payload, cwd, stdout_path)
    except ArenaDuelError:
        raise
    except Exception as error:
        _raise_adapter(error)
    if not isinstance(raw, (bytes, bytearray, memoryview)):
        raise ArenaDuelError('red_output_invalid', 2)
    return bytes(raw)


def _try_object(raw: bytes):
    if not raw or not raw.strip():
        return None
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if isinstance(payload, dict):
        return payload
    return None


def _b64_bytes(value) -> bytes:
    if not isinstance(value, str) or not value.strip():
        raise ArenaDuelError('red_output_invalid', 2)
    try:
        return base64.b64decode(value, validate=True)
    except ValueError:
        raise ArenaDuelError('red_output_invalid', 2) from None


def _gold_value(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise ArenaDuelError('gold_ledger_invalid', 2) from None
    if not isinstance(value, (dict, list)):
        raise ArenaDuelError('gold_ledger_invalid', 2)
    return value


def _one_stdio_supplement(item, index: int) -> dict:
    if not isinstance(item, dict):
        raise ArenaDuelError('red_output_invalid', 2)
    name = Path(str(item.get('name') or f'supplement-{index + 1}')).name
    if 'base64' in item:
        payload = _b64_bytes(item.get('base64'))
    elif 'text' in item:
        payload = str(item.get('text') or '').encode('utf-8')
    else:
        raise ArenaDuelError('red_output_invalid', 2)
    return {'name': name, 'bytes': payload}


def _stdio_supplements(items) -> list[dict]:
    if items is None:
        return []
    if not isinstance(items, list):
        raise ArenaDuelError('red_output_invalid', 2)
    return [_one_stdio_supplement(item, index) for index, item in enumerate(items)]


def _from_stdio(payload: dict):
    has_pdf = 'blindPdfBase64' in payload
    has_gold = 'goldLedger' in payload
    if not has_pdf and not has_gold:
        return None
    if not has_pdf or not has_gold:
        raise ArenaDuelError('red_output_invalid', 2)
    blind = _b64_bytes(payload.get('blindPdfBase64'))
    if not blind.startswith(b'%PDF-'):
        raise ArenaDuelError('blind_pdf_invalid', 2)
    gold = _gold_value(payload.get('goldLedger'))
    return blind, gold, _stdio_supplements(payload.get('blindSupplements')), 'stdio'


def _dir_supplements(folder: Path) -> list[dict]:
    if not folder.is_dir():
        return []
    supplements = []
    for path in sorted(folder.iterdir()):
        if path.is_file():
            supplements.append({'name': path.name, 'bytes': path.read_bytes()})
    return supplements


def _from_files(workspace: Path):
    blind_path = workspace / 'blind.pdf'
    gold_path = workspace / 'gold.json'
    if not blind_path.is_file() or not gold_path.is_file():
        raise ArenaDuelError('red_output_invalid', 2)
    blind = blind_path.read_bytes()
    if not blind.startswith(b'%PDF-'):
        raise ArenaDuelError('blind_pdf_invalid', 2)
    try:
        gold = json.loads(gold_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ArenaDuelError('gold_ledger_invalid', 2) from None
    supplements = _dir_supplements(workspace / 'blind_supplements')
    return blind, _gold_value(gold), supplements, 'files'


def _read_red_output(workspace: Path, raw: bytes):
    payload = _try_object(raw)
    if isinstance(payload, dict):
        parsed = _from_stdio(payload)
        if parsed is not None:
            return parsed
    return _from_files(workspace)


def _execute_red(source: bytes, red_argv, supplements, min_difficulty, timeout: int, red_adapter, red_fields=None) -> dict:
    argv = _require_argv(red_argv, 'red_argv_invalid')
    adapter = red_adapter or _default_red_adapter(timeout)
    if not callable(adapter):
        raise ArenaDuelError('red_adapter_invalid', 2)
    workspace = Path(tempfile.mkdtemp(prefix='falsify-duel-red-'))
    names: list[str] = []
    try:
        names = _write_supplements(workspace, supplements)
        (workspace / 'source.pdf').write_bytes(source)
        payload = _red_payload(min_difficulty, names, red_fields)
        raw = _call_red(adapter, argv, payload, workspace, workspace / 'red-stdout.bin')
        blind, gold, blind_supplements, mode = _read_red_output(workspace, raw)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
    return {
        'blind': blind,
        'gold': gold,
        'supplements': blind_supplements,
        'mode': mode,
        'supplementNames': names,
    }


# --------------------------------------------------------------------------------------
# gates
# --------------------------------------------------------------------------------------


def _ledger_lists(gold) -> list:
    if isinstance(gold, list):
        return gold
    if not isinstance(gold, dict):
        raise ArenaDuelError('gold_ledger_invalid', 2)
    items: list = []
    for key in ('defects', 'changes', 'entries', 'operations'):
        value = gold.get(key)
        if isinstance(value, list):
            items.extend(value)
    return items


def _difficulty_token(item):
    if not isinstance(item, dict):
        return None
    for key in ('difficulty', 'detectability', 'crossInferenceDistance'):
        token = str(item.get(key) or '').strip().upper()
        if token in _DIFF_RANK:
            return token
    return None


def _ops_are_simulatable(ops) -> bool:
    if not isinstance(ops, list) or not ops:
        return False
    return all(isinstance(op, dict) and op.get('kind') for op in ops)


def _simulated_tokens(gold, sensor: dict) -> list[str]:
    if not isinstance(gold, dict) or not _ops_are_simulatable(gold.get('operations')):
        return []
    try:
        from paper_red_detectability import simulate_red_detectability
        report = simulate_red_detectability(
            sensor['paperId'],
            gold.get('operations'),
            file_hash=sensor['fileHash'],
            store=sensor['store'],
        )
    except (ValueError, TypeError, KeyError, RuntimeError, OSError):
        return []
    tokens = []
    for item in report.get('results') or []:
        token = _difficulty_token(item)
        if token:
            tokens.append(token)
    return tokens


def _declared_tokens(gold) -> list[str]:
    tokens = []
    for item in _ledger_lists(gold):
        token = _difficulty_token(item)
        if token:
            tokens.append(token)
    return tokens


def _check_difficulty(gold, minimum: str, sensor: dict) -> None:
    floor = _DIFF_RANK[minimum]
    tokens = _declared_tokens(gold) + _simulated_tokens(gold, sensor)
    low = sorted({token for token in tokens if _DIFF_RANK[token] < floor})
    if not low:
        return
    raise ArenaDuelError('difficulty_below_minimum', 3, {
        'minDifficulty': minimum,
        'difficulties': low,
    })


def _gate_bundle(blind: bytes, supplements, source: bytes, gold, minimum, sensor: dict) -> dict:
    try:
        verification = arena_runner.verify_blind_bundle(
            blind,
            blind_supplements=supplements,
            source_pdf_bytes=source,
        )
    except ValueError as error:
        raise ArenaDuelError('blind_bundle_invalid', 2, {'reason': str(error)}) from None
    if not verification.get('blindClean'):
        raise ArenaDuelError('blindness_leak_detected', 3, {'verification': verification})
    if minimum:
        _check_difficulty(gold, minimum, sensor)
    return verification


# --------------------------------------------------------------------------------------
# BLUE round, quotes, holdout
# --------------------------------------------------------------------------------------


def _blue_inner(blue_adapter, timeout: int):
    if blue_adapter is None:
        return arena_round._default_adapter(timeout=timeout)
    if not callable(blue_adapter):
        raise ArenaDuelError('blue_adapter_invalid', 2)
    return blue_adapter


def _capturing_adapter(inner, bucket: list):
    def run(argv, payload, cwd, stdout_path, env_allow=None):
        if env_allow:
            raw = inner(list(argv), payload, cwd, stdout_path, env_allow=env_allow)
        else:
            raw = inner(list(argv), payload, cwd, stdout_path)
        if not isinstance(raw, (bytes, bytearray, memoryview)):
            raise ArenaDuelError('blue_output_invalid', 2)
        blob = bytes(raw)
        bucket.append(blob)
        return blob

    return run


def _run_scored_round(blind, argv, gold, supplements, source, runs, timeout, adapter, baseline) -> dict:
    try:
        record = arena_round.run_round(
            blind,
            argv,
            gold_ledger=gold,
            blind_supplements=supplements,
            source_pdf_bytes=source,
            runs=runs,
            timeout=timeout,
            adapter=adapter,
            baseline_signals=baseline,
        )
    except arena_round.ArenaRoundError as error:
        raise ArenaDuelError(error.code, error.exit_code) from None
    return _require_round_ok(record)


def _parse_report(raw: bytes) -> dict:
    try:
        report = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ArenaDuelError('blue_output_invalid', 2) from None
    if not isinstance(report, dict) or not isinstance(report.get('findings'), list):
        raise ArenaDuelError('blue_output_invalid', 2)
    return report


def _confirmed_defect(finding: dict) -> bool:
    return arena_runner._finding_status_kind(finding) == 'defect'


def _missing_ids(quote_check: dict) -> set[str]:
    return {
        str(record.get('findingId') or '')
        for record in quote_check.get('quotes') or []
        if record.get('status') == 'missing'
    }


def _downgrade_missing(findings: list, missing_ids: set[str]) -> tuple[list, int]:
    changed = []
    count = 0
    for index, finding in enumerate(findings):
        item = dict(finding) if isinstance(finding, dict) else {}
        identifier = blue_report_validate.finding_id(item, index)
        if identifier in missing_ids and _confirmed_defect(item):
            item['decision'] = '확인필요'
            item['verdictLabel'] = '확인필요'
            count += 1
        changed.append(item)
    return changed, count


def _validate_report(pdf_bytes: bytes, report: dict) -> dict:
    try:
        return blue_report_validate.validate_blue_report(pdf_bytes, report)
    except blue_report_validate.BlueReportError as error:
        raise ArenaDuelError('quote_validation_failed', error.exit_code, {'reason': error.code}) from None


def _recovered_count(result: dict) -> int:
    summary = (result.get('zeroDrop') or {}).get('summary') or {}
    if 'recoveredCount' in summary:
        return int(summary.get('recoveredCount') or 0)
    recovered = (result.get('zeroDrop') or {}).get('recoveredFindingIds') or []
    return len(recovered)


def _blank_quotes() -> dict:
    return {
        'exactCount': 0,
        'normalizedCount': 0,
        'missingCount': 0,
        'zeroDropRecovered': 0,
        'downgradedCount': 0,
        'runs': [],
    }


def _absorb_quote(totals: dict, check: dict, recovered: int, downgraded: int, run_id: str, findings: list) -> None:
    totals['exactCount'] += int(check.get('exactCount') or 0)
    totals['normalizedCount'] += int(check.get('normalizedCount') or 0)
    totals['missingCount'] += int(check.get('missingCount') or 0)
    totals['zeroDropRecovered'] += recovered
    totals['downgradedCount'] += downgraded
    totals['runs'].append({'runId': run_id, 'findings': findings, 'quoteCheck': check})


def _quote_one(pdf_bytes: bytes, report: dict, meta: dict, index: int, totals: dict) -> dict:
    check_result = _validate_report(pdf_bytes, report)
    check = check_result.get('quoteCheck') or {}
    findings, downgraded = _downgrade_missing(report.get('findings') or [], _missing_ids(check))
    run_id = str(meta.get('runId') or f'run-{index + 1}')
    agent_id = str(meta.get('agentId') or run_id)
    _absorb_quote(totals, check, _recovered_count(check_result), downgraded, run_id, findings)
    return {'runId': run_id, 'agentId': agent_id, 'findings': findings}


def _apply_quote_gate(pdf_bytes: bytes, reports: list[dict], metas: list) -> tuple[dict, list]:
    totals = _blank_quotes()
    rescored = []
    for index, report in enumerate(reports):
        meta = metas[index] if index < len(metas) else {}
        rescored.append(_quote_one(pdf_bytes, report, meta, index, totals))
    return totals, rescored


def _rescore(record: dict, gold, baseline, pdf_bytes: bytes, captured: list, enabled: bool) -> dict:
    if not enabled:
        return _blank_quotes()
    reports = [_parse_report(raw) for raw in captured]
    totals, runs = _apply_quote_gate(pdf_bytes, reports, list(record.get('runs') or []))
    if totals['downgradedCount']:
        record['evaluation'] = arena_runner.evaluate_arena_match(gold, runs, baseline_signals=baseline)
    return totals


def _metric(record: dict, key: str) -> int:
    evaluation = record.get('evaluation') or {}
    aggregate = evaluation.get('aggregate') or {}
    if key in aggregate and aggregate.get(key) is not None:
        return int(aggregate[key])
    total = 0
    for run in evaluation.get('runs') or []:
        if isinstance(run, dict):
            total += int(run.get(key) or 0)
    return total


def _holdout_entry(entry, blue_argv, runs: int, timeout: int, adapter) -> dict:
    if not isinstance(entry, dict):
        raise ArenaDuelError('holdout_invalid', 2)
    raw = entry.get('bytes')
    if not isinstance(raw, (bytes, bytearray)):
        raise ArenaDuelError('holdout_invalid', 2)
    sensor = _bind_sensor(bytes(raw), 'holdout_pdf_invalid')
    gold = {'schema': 'falsify.red-gold-ledger.v1', 'defects': []}
    record = _run_scored_round(
        bytes(raw), blue_argv, gold, [], None, runs, timeout, adapter, sensor['report'],
    )
    return {
        'name': str(entry.get('name') or 'holdout'),
        'pureFp': _metric(record, 'pureFp'),
        'preExistingExempted': _metric(record, 'preExistingExempted'),
        'abstained': _metric(record, 'abstainedCount'),
        'roundId': record.get('roundId'),
    }


def _holdout_summary(entries, blue_argv, runs: int, timeout: int, adapter) -> dict:
    papers = [
        _holdout_entry(entry, blue_argv, runs, timeout, adapter)
        for entry in list(entries or [])
    ]
    return {
        'paperCount': len(papers),
        'totalPureFp': sum(paper['pureFp'] for paper in papers),
        'totalAbstained': sum(paper['abstained'] for paper in papers),
        'totalPreExistingExempted': sum(paper['preExistingExempted'] for paper in papers),
        'papers': papers,
    }


def _distill(record: dict, gold, max_rules: int) -> dict:
    try:
        return arena_round.distill_round(record, gold_ledger=gold, max_rules=max_rules)
    except arena_round.DistillScrubError as error:
        raise ArenaDuelError('distill_scrub_failed', 3, {'hitCount': len(error.hits)}) from None
    except arena_round.ArenaRoundError as error:
        raise ArenaDuelError(error.code, error.exit_code) from None


def _duel_result(source: bytes, red: dict, verification: dict, record: dict, quotes: dict, holdout: dict, patch: dict) -> dict:
    return {
        'schema': DUEL_SCHEMA,
        'ok': True,
        'duelId': 'duel-' + hashlib.sha256(source).hexdigest()[:12],
        'redSummary': {
            'outputMode': red['mode'],
            'blindSha256': hashlib.sha256(red['blind']).hexdigest(),
            'supplementCount': len(red['supplements']),
            'sourceSupplementNames': list(red['supplementNames']),
            'workspaceDisposed': True,
            'blindClean': bool(verification.get('blindClean')),
        },
        'round': record,
        'quoteValidation': quotes,
        'holdoutSummary': holdout,
        'harnessPatch': patch,
    }


def run_duel(
    source_pdf_bytes: bytes,
    *,
    red_argv: list[str],
    blue_argv: list[str],
    supplements: list[dict] | None = None,
    holdout_pdfs: list[dict] | None = None,
    min_difficulty: str | None = None,
    runs: int = 1,
    timeout: int = 180,
    validate_quotes: bool = True,
    max_rules: int = 40,
    red_adapter=None,
    blue_adapter=None,
    red_harness: dict | None = None,
    blue_harness: dict | None = None,
) -> dict:
    """Run one isolated RED pass, a cleanroom BLUE round, and an answer-key-free patch."""
    source = _require_pdf(source_pdf_bytes, 'source_pdf_invalid')
    minimum = _require_difficulty(min_difficulty)
    argv = _require_argv(blue_argv, 'blue_argv_invalid')
    if blue_harness is not None:
        _require_base(blue_harness)
    sensor = _bind_sensor(source, 'source_pdf_invalid')
    red = _execute_red(
        source, red_argv, supplements, minimum, timeout, red_adapter, _harness_red_fields(red_harness),
    )
    verification = _gate_bundle(red['blind'], red['supplements'], source, red['gold'], minimum, sensor)
    inner = _blue_inner(blue_adapter, timeout)
    captured: list[bytes] = []
    record = _run_scored_round(
        red['blind'], argv, red['gold'], red['supplements'], source,
        runs, timeout, _capturing_adapter(inner, captured), sensor['report'],
    )
    quotes = _rescore(record, red['gold'], sensor['report'], red['blind'], captured, validate_quotes)
    holdout = _holdout_summary(holdout_pdfs, argv, runs, timeout, inner)
    patch = _distill(record, red['gold'], max_rules)
    return _duel_result(source, red, verification, record, quotes, holdout, patch)


# --------------------------------------------------------------------------------------
# harness promotion
# --------------------------------------------------------------------------------------


def _require_max_generations(value: int) -> int:
    if isinstance(value, bool) or type(value) is not int or not 1 <= value <= MAX_GENERATIONS_CAP:
        raise ArenaDuelError('max_generations_invalid', 2)
    return value


def _require_base(base: dict) -> None:
    if not isinstance(base, dict):
        raise ArenaDuelError('harness_invalid', 2)
    if base.get('schema') == HARNESS_SCHEMA:
        return
    if 'role' in base or 'instructions' in base:
        return
    raise ArenaDuelError('harness_invalid', 2)


def _require_patch(patch: dict) -> None:
    if not isinstance(patch, dict) or patch.get('schema') != PATCH_SCHEMA:
        raise ArenaDuelError('patch_invalid', 2)
    if patch.get('answerKeyFree') is not True or patch.get('scrubbed') is not True:
        raise ArenaDuelError('patch_not_scrubbed', 3)


def _rescrub(patch: dict) -> None:
    try:
        arena_round._scrub(patch, [], set())
    except arena_round.DistillScrubError as error:
        raise ArenaDuelError('patch_not_scrubbed', 3, {'hitCount': len(error.hits)}) from None
    except (KeyError, TypeError, AttributeError):
        raise ArenaDuelError('patch_invalid', 2) from None


def _generation_of(base: dict) -> int:
    try:
        return int(base.get('generation') or 0)
    except (TypeError, ValueError):
        raise ArenaDuelError('generation_invalid', 2) from None


def _check_cap(generation: int, maximum: int) -> None:
    if generation + 1 > maximum:
        raise ArenaDuelError('generation_cap_exceeded', 3, {
            'currentGeneration': generation,
            'maxGenerations': maximum,
        })


def _resolve_role(role, base: dict) -> str:
    chosen = str(role or base.get('role') or 'blue').strip().lower()
    if chosen not in _ROLES:
        raise ArenaDuelError('role_invalid', 2)
    return chosen


def _nonnegative_int(value, code: str) -> int:
    if isinstance(value, bool) or type(value) is not int or value < 0:
        raise ArenaDuelError(code, 2)
    return value


def _holdout_guard(baseline, candidate) -> dict:
    if baseline is None and candidate is None:
        return {'checked': False, 'rolledBack': False}
    if baseline is None or candidate is None:
        raise ArenaDuelError('holdout_fp_invalid', 2)
    base = _nonnegative_int(baseline, 'holdout_fp_invalid')
    cand = _nonnegative_int(candidate, 'holdout_fp_invalid')
    if cand > base:
        raise ArenaDuelError('holdout_fp_regression', 3, {
            'baselineHoldoutFp': base,
            'candidateHoldoutFp': cand,
            'rolledBack': True,
        })
    return {
        'checked': True,
        'rolledBack': False,
        'baselineHoldoutFp': base,
        'candidateHoldoutFp': cand,
    }


def _brief_for(patch: dict, role: str) -> dict:
    key = 'blueBrief' if role == 'blue' else 'redBrief'
    brief = patch.get(key) or {}
    if not isinstance(brief, dict):
        raise ArenaDuelError('patch_invalid', 2)
    return brief


def _new_rules(patch: dict, applied_ids) -> list[dict]:
    seen = {str(rule_id) for rule_id in list(applied_ids or [])}
    chosen = []
    for rule in patch.get('rules') or []:
        if not isinstance(rule, dict):
            continue
        rule_id = str(rule.get('ruleId') or '')
        if not rule_id or rule_id in seen:
            continue
        seen.add(rule_id)
        chosen.append(rule)
    return chosen


def _rules_block(role: str, generation: int, brief: dict, rules: list[dict]) -> str:
    lines = [f'[Co-Evolution {role} gen {generation}]']
    text = str(brief.get('instructionsText') or brief.get('summary') or '').strip()
    if text:
        lines.append(text)
    for rule in rules:
        statement = str(rule.get('statement') or '').strip()
        if statement:
            lines.append(f"- {rule.get('ruleId')}: {statement}")
    return '\n'.join(lines)


def _bound_instructions(existing, block: str, limit: int) -> str:
    if isinstance(limit, bool) or type(limit) is not int or limit < 1:
        raise ArenaDuelError('max_instructions_chars_invalid', 2)
    base = str(existing or '')
    if len(base) >= limit:
        return base[:limit]
    addition = ('\n\n' + block) if base else block
    if len(base) + len(addition) > limit:
        addition = addition[:limit - len(base)].rstrip()
    return base + addition


def _next_identity(base: dict, generation: int, patch_id: str, rule_ids: list[str]):
    base_id = str(base.get('id') or 'harness')
    applied = [str(item) for item in list(base.get('appliedPatches') or [])]
    if patch_id and patch_id not in applied:
        applied.append(patch_id)
    known = [str(item) for item in list(base.get('appliedRuleIds') or [])]
    for rule_id in rule_ids:
        if rule_id not in known:
            known.append(rule_id)
    return base_id, applied, known


def _copy_harness(base: dict, role: str, instructions: str, generation: int, base_id: str, applied, known) -> dict:
    harness = dict(base)
    harness['schema'] = HARNESS_SCHEMA
    harness['role'] = role
    harness['instructions'] = instructions
    harness['generation'] = generation
    harness['appliedPatches'] = applied
    harness['appliedRuleIds'] = known
    harness['parentId'] = base.get('id')
    harness['id'] = f'{base_id}-gen{generation}'
    return harness


def _require_bool(value, code: str) -> bool:
    if type(value) is not bool:
        raise ArenaDuelError(code, 2)
    return value


def _root_instructions(base: dict) -> str:
    saved = base.get('rootInstructions')
    if isinstance(saved, str):
        return saved
    text = str(base.get('instructions') or '')
    marker = text.find('[Co-Evolution ')
    if marker < 0:
        return text
    return text[:marker].rstrip()


def _compact_block(role: str, generation: int, rules: list[dict]) -> str:
    lines = [f'[Co-Evolution {role} compacted gen {generation}]']
    for rule in rules:
        statement = str(rule.get('statement') or '').strip()
        if statement:
            lines.append(f"- {rule.get('ruleId')}: {statement}")
    return '\n'.join(lines)


def _joined_rules(base: dict, added: list[dict]) -> list[dict]:
    current = []
    for rule in list(base.get('accumulatedRules') or []):
        if isinstance(rule, dict):
            current.append(dict(rule))
    for rule in added:
        current.append(dict(rule))
    return current


def _scrub_accumulated(rules: list[dict]) -> None:
    _rescrub({'summary': {'axes': {}}, 'rules': rules})


def _compacted_rules(base: dict, added: list[dict]) -> dict:
    try:
        return arena_round.compact_harness_rules(_joined_rules(base, added))
    except arena_round.ArenaRoundError as error:
        code = 'patch_not_scrubbed' if error.code == 'distill_scrub_failed' else error.code
        raise ArenaDuelError(code, error.exit_code) from None


def _instruction_update(base, patch, role, generation, added, limit, compact_rules):
    root = _root_instructions(base)
    if compact_rules:
        rules = [rule for rule in list(_compacted_rules(base, added).get('rules') or []) if isinstance(rule, dict)]
        text = _bound_instructions(root, _compact_block(role, generation, rules), limit)
        return text, root, rules, len(rules)
    text = _bound_instructions(
        base.get('instructions'),
        _rules_block(role, generation, _brief_for(patch, role), added),
        limit,
    )
    return text, root, _joined_rules(base, added), None


def _carry_red_brief(harness: dict, patch: dict, role: str) -> None:
    if role != 'red':
        return
    brief = patch.get('redBrief')
    if isinstance(brief, dict):
        harness['redBrief'] = dict(brief)


def apply_harness_patch(
    base_harness: dict,
    patch: dict,
    *,
    role: str | None = None,
    max_generations: int = 3,
    baseline_holdout_fp: int | None = None,
    candidate_holdout_fp: int | None = None,
    max_instructions_chars: int = 12000,
    compact_rules: bool = False,
) -> dict:
    """Merge one scrubbed patch or refuse on generation cap, scrub, or holdout regression."""
    compacting = _require_bool(compact_rules, 'compact_rules_invalid')
    _require_base(base_harness)
    _require_patch(patch)
    _rescrub(patch)
    maximum = _require_max_generations(max_generations)
    role_name = _resolve_role(role, base_harness)
    generation = _generation_of(base_harness)
    _check_cap(generation, maximum)
    guard = _holdout_guard(baseline_holdout_fp, candidate_holdout_fp)
    added = _new_rules(patch, base_harness.get('appliedRuleIds') or [])
    instructions, root, accumulated, compact_count = _instruction_update(
        base_harness, patch, role_name, generation + 1, added, max_instructions_chars, compacting,
    )
    _scrub_accumulated(accumulated)
    rule_ids = [str(rule.get('ruleId')) for rule in added]
    base_id, applied, known = _next_identity(
        base_harness, generation + 1, str(patch.get('patchId') or ''), rule_ids,
    )
    harness = _copy_harness(
        base_harness, role_name, instructions, generation + 1, base_id, applied, known,
    )
    harness['rootInstructions'] = root
    harness['accumulatedRules'] = accumulated
    _carry_red_brief(harness, patch, role_name)
    payload = {
        'schema': PATCH_APPLY_SCHEMA,
        'ok': True,
        'promoted': True,
        'generation': generation + 1,
        'maxGenerations': maximum,
        'addedRuleCount': len(added),
        'holdoutGuard': guard,
        'harness': harness,
    }
    if compact_count is not None:
        payload['compactedRuleCount'] = compact_count
    return payload


# --------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='arena_duel.py', description='RED/BLUE duel and harness patch promotion.')
    sub = parser.add_subparsers(dest='command', required=True)
    duel = sub.add_parser('duel', help='Run an unattended RED versus BLUE duel.')
    duel.add_argument('--source-pdf', required=True, type=Path)
    duel.add_argument('--red-cmd', required=True)
    duel.add_argument('--red-arg', action='extend', nargs='+', default=[])
    duel.add_argument('--blue-cmd', required=True)
    duel.add_argument('--blue-arg', action='extend', nargs='+', default=[])
    duel.add_argument('--supplement', action='extend', nargs='+', type=Path, default=[])
    duel.add_argument('--holdout-pdf', action='append', type=Path, default=[])
    duel.add_argument('--min-difficulty')
    duel.add_argument('--runs', type=int, default=1)
    duel.add_argument('--timeout', type=int, default=180)
    duel.add_argument('--max-rules', type=int, default=40)
    duel.add_argument('--no-validate-quotes', action='store_true')
    duel.add_argument('--out', type=Path)
    apply = sub.add_parser('apply-patch', help='Promote a scrubbed harness patch under the generation cap.')
    apply.add_argument('--harness', required=True, type=Path)
    apply.add_argument('--patch', required=True, type=Path)
    apply.add_argument('--role')
    apply.add_argument('--max-generations', type=int, default=3)
    apply.add_argument('--baseline-holdout-fp', type=int)
    apply.add_argument('--candidate-holdout-fp', type=int)
    apply.add_argument('--max-instructions-chars', type=int, default=12000)
    apply.add_argument('--compact-rules', action='store_true')
    apply.add_argument('--out', type=Path)
    return parser


def _write_json(payload: dict, out_path) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if out_path is not None:
        Path(out_path).write_text(rendered + '\n', encoding='utf-8')
    print(rendered)


def _error_document(error: ArenaDuelError) -> dict:
    payload = {
        'schema': ERROR_SCHEMA,
        'ok': False,
        'error': error.code,
        'exitCode': error.exit_code,
    }
    payload.update(error.extra)
    return payload


def _load_json_file(path: Path, code: str):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ArenaDuelError(code, 2) from None


def _named_bytes(paths) -> list[dict]:
    return [{'name': path.name, 'bytes': path.read_bytes()} for path in paths]


def _cmd_duel(args: argparse.Namespace) -> int:
    result = run_duel(
        args.source_pdf.read_bytes(),
        red_argv=[args.red_cmd, *(args.red_arg or [])],
        blue_argv=[args.blue_cmd, *(args.blue_arg or [])],
        supplements=_named_bytes(args.supplement),
        holdout_pdfs=_named_bytes(args.holdout_pdf),
        min_difficulty=args.min_difficulty,
        runs=args.runs,
        timeout=args.timeout,
        validate_quotes=not args.no_validate_quotes,
        max_rules=args.max_rules,
    )
    _write_json(result, args.out)
    return 0


def _cmd_apply(args: argparse.Namespace) -> int:
    result = apply_harness_patch(
        _load_json_file(args.harness, 'harness_invalid'),
        _load_json_file(args.patch, 'patch_invalid'),
        role=args.role,
        max_generations=args.max_generations,
        baseline_holdout_fp=args.baseline_holdout_fp,
        candidate_holdout_fp=args.candidate_holdout_fp,
        max_instructions_chars=args.max_instructions_chars,
        compact_rules=bool(args.compact_rules),
    )
    _write_json(result, args.out)
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint: ``duel`` and ``apply-patch``, one JSON document on stdout."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == 'duel':
            return _cmd_duel(args)
        if args.command == 'apply-patch':
            return _cmd_apply(args)
        return 2
    except ArenaDuelError as error:
        _write_json(_error_document(error), getattr(args, 'out', None))
        return error.exit_code
    except (OSError, ValueError):
        _write_json(_error_document(ArenaDuelError('input_invalid', 2)), getattr(args, 'out', None))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())

"""Rollback-safe multi-generation RED/BLUE co-evolution campaign.

Generation 0 records a benchmark baseline. Each later generation reuses
``arena_duel.run_duel`` and ``arena_duel.apply_harness_patch``. A failed patch,
holdout guard, or benchmark comparison keeps the active harness. A blindness
leak aborts the campaign. The returned lineage is scrubbed with
``arena_round._scrub``.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import inspect
import json
from pathlib import Path
import sys

_EVAL_DIR = Path(__file__).resolve().parent
if str(_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_EVAL_DIR))

import arena_duel  # noqa: E402
import arena_round  # noqa: E402
import benchmark_suite  # noqa: E402

CAMPAIGN_SCHEMA = 'falsify.evolution-lineage.v1'
ERROR_SCHEMA = 'falsify.evolution-campaign-error.v1'
MAX_GENERATIONS_CAP = arena_duel.MAX_GENERATIONS_CAP
_RECOVERABLE_DUEL = frozenset({
    'distill_scrub_failed',
    'difficulty_below_minimum',
    'patch_not_scrubbed',
})
_METRIC_KEYS = (
    'recall',
    'layer0Recall',
    'semanticRecall',
    'holdoutPureFp',
    'aurc',
    'stealthYield',
)


class ArenaCampaignError(ValueError):
    """Fixed-code campaign failure. ``exit_code`` is the module CLI status."""

    def __init__(self, code: str, exit_code: int = 2, extra: dict | None = None) -> None:
        self.code = code
        self.exit_code = exit_code
        self.extra = dict(extra or {})
        super().__init__(code)


def _require_generations(value) -> int:
    if isinstance(value, bool) or type(value) is not int:
        raise ArenaCampaignError('max_generations_invalid', 2)
    if value < 1 or value > MAX_GENERATIONS_CAP:
        raise ArenaCampaignError('max_generations_invalid', 2)
    return value


def _require_role(role) -> str:
    if not isinstance(role, str):
        raise ArenaCampaignError('role_invalid', 2)
    chosen = role.strip().lower()
    if chosen not in ('blue', 'red', 'both'):
        raise ArenaCampaignError('role_invalid', 2)
    return chosen


def _pdf_bytes(raw) -> bytes:
    if isinstance(raw, (bytes, bytearray)) and bytes(raw).startswith(b'%PDF-'):
        return bytes(raw)
    raise ArenaCampaignError('source_pdfs_invalid', 2)


def _source_from_bytes(raw, index: int) -> dict:
    return {'name': f'source-{index}', 'bytes': _pdf_bytes(raw), 'supplements': []}


def _source_from_dict(entry: dict, index: int) -> dict:
    supplements = entry.get('supplements') or []
    if not isinstance(supplements, list):
        raise ArenaCampaignError('source_pdfs_invalid', 2)
    name = entry.get('name')
    if not isinstance(name, str) or not name.strip():
        name = f'source-{index}'
    return {'name': name, 'bytes': _pdf_bytes(entry.get('bytes')), 'supplements': list(supplements)}


def _normalize_source(entry, index: int) -> dict:
    if isinstance(entry, (bytes, bytearray)):
        return _source_from_bytes(entry, index)
    if isinstance(entry, dict):
        return _source_from_dict(entry, index)
    raise ArenaCampaignError('source_pdfs_invalid', 2)


def _require_sources(source_pdfs) -> list[dict]:
    if not isinstance(source_pdfs, list) or not source_pdfs:
        raise ArenaCampaignError('source_pdfs_invalid', 2)
    return [_normalize_source(entry, index) for index, entry in enumerate(source_pdfs)]


def _copy_base(base_harness: dict) -> dict:
    try:
        arena_duel._require_base(base_harness)
    except arena_duel.ArenaDuelError as error:
        raise ArenaCampaignError(error.code, error.exit_code, error.extra) from None
    return copy.deepcopy(base_harness)


def _default_harness(role: str) -> dict:
    return {
        'schema': arena_duel.HARNESS_SCHEMA,
        'id': 'harness',
        'role': role,
        'instructions': 'Review only the blind bundle.',
        'generation': 0,
        'appliedRuleIds': [],
        'appliedPatches': [],
    }


def _default_red_harness() -> dict:
    return {
        'schema': arena_duel.HARNESS_SCHEMA,
        'id': 'harness-red',
        'role': 'red',
        'instructions': 'Generate stealth-clean blind mutations.',
        'generation': 0,
        'appliedRuleIds': [],
        'appliedPatches': [],
    }


def _campaign_pair(role: str, base_harness: dict, base_red_harness):
    if role == 'red':
        return _copy_base(base_harness), None
    blue = _copy_base(base_harness)
    if role != 'both':
        return blue, None
    if base_red_harness is None:
        return blue, _default_red_harness()
    return blue, _copy_base(base_red_harness)


def _harness_sha256(harness: dict) -> str:
    payload = json.dumps(harness, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _generation_value(harness: dict) -> int:
    try:
        return int(harness.get('generation') or 0)
    except (TypeError, ValueError):
        return 0


def _metric_num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _fp_int(value, fallback: int) -> int:
    number = _metric_num(value)
    if number is None:
        return fallback
    return int(number)


def _dict_section(report, key: str) -> dict:
    if not isinstance(report, dict):
        return {}
    value = report.get(key)
    if isinstance(value, dict):
        return value
    return {}


def _metrics_from_bench(report) -> dict:
    gold = _dict_section(report, 'goldSummary')
    hold = _dict_section(report, 'holdoutSummary')
    selective = gold.get('selective')
    if not isinstance(selective, dict):
        selective = {}
    values = {
        'recall': gold.get('recall'),
        'layer0Recall': gold.get('layer0Recall'),
        'semanticRecall': gold.get('semanticRecall'),
        'holdoutPureFp': hold.get('totalPureFp'),
        'aurc': selective.get('aurc'),
        'stealthYield': gold.get('stealthYield'),
    }
    return {key: _metric_num(values[key]) for key in _METRIC_KEYS}


def _copy_metrics(metrics) -> dict:
    if not isinstance(metrics, dict):
        return {key: None for key in _METRIC_KEYS}
    copied = {key: metrics.get(key) for key in _METRIC_KEYS}
    return copied


def _bind_duel(red_argv, blue_argv, holdout_pdfs, min_difficulty, runs, timeout, max_rules):
    def duel_fn(source_entry, generation_index, active_harness, red_harness=None, blue_harness=None):
        del generation_index, active_harness
        supplements = list(source_entry.get('supplements') or [])
        return arena_duel.run_duel(
            source_entry['bytes'],
            red_argv=list(red_argv),
            blue_argv=list(blue_argv),
            supplements=supplements,
            holdout_pdfs=holdout_pdfs,
            min_difficulty=min_difficulty,
            runs=runs,
            timeout=timeout,
            max_rules=max_rules,
            red_harness=red_harness,
            blue_harness=blue_harness,
        )

    return duel_fn


def _bind_bench():
    def benchmark_fn(generation_index, candidate_harness):
        del generation_index, candidate_harness
        return benchmark_suite.run_benchmark_suite(mode='sensor')

    return benchmark_fn


def _record(index: int, status: str, harness: dict, metrics, reason) -> dict:
    record = {
        'generation': index,
        'status': status,
        'harnessSha256': _harness_sha256(harness),
        'harnessGeneration': _generation_value(harness),
        'metrics': _copy_metrics(metrics),
    }
    if reason:
        record['rollbackReason'] = reason
    return record


def _baseline(ctx: dict) -> dict:
    bench = ctx['benchmark_fn'](0, ctx['harness'])
    metrics = _metrics_from_bench(bench)
    ctx['bench'] = bench
    ctx['metrics'] = metrics
    ctx['holdout_fp'] = _fp_int(metrics.get('holdoutPureFp'), 0)
    ctx['stealth_yield'] = metrics.get('stealthYield')
    return _record(0, 'baseline', ctx['harness'], metrics, None)


def _duel_failure(ctx: dict, index: int, error: arena_duel.ArenaDuelError, harness=None) -> dict:
    if error.code == 'blindness_leak_detected':
        raise ArenaCampaignError('blindness_leak_detected', 3, error.extra)
    if error.code == 'timeout':
        raise ArenaCampaignError('timeout', 124, error.extra)
    if error.code not in _RECOVERABLE_DUEL:
        raise ArenaCampaignError(error.code, error.exit_code, error.extra)
    chosen = harness if isinstance(harness, dict) else ctx['harness']
    return _record(index, 'rolled_back', chosen, ctx['metrics'], error.code)


def _duel_fp(duel: dict, fallback: int) -> int:
    summary = duel.get('holdoutSummary') if isinstance(duel, dict) else None
    if not isinstance(summary, dict) or 'totalPureFp' not in summary:
        return fallback
    return _fp_int(summary.get('totalPureFp'), fallback)


def _apply_role(ctx: dict) -> str:
    role = ctx.get('apply_role') or ctx['role']
    if role == 'both':
        return 'blue'
    return role


def _applied_harness(ctx: dict, base, patch, role: str, baseline_fp, candidate_fp):
    try:
        applied = arena_duel.apply_harness_patch(
            base,
            patch,
            role=role,
            max_generations=ctx['generations'],
            baseline_holdout_fp=baseline_fp,
            candidate_holdout_fp=candidate_fp,
            max_instructions_chars=ctx['max_chars'],
            compact_rules=ctx['compact_rules'],
        )
    except arena_duel.ArenaDuelError as error:
        return None, error.code
    harness = applied.get('harness') if isinstance(applied, dict) else None
    if not isinstance(harness, dict):
        return None, 'patch_invalid'
    text = harness.get('instructions')
    if isinstance(text, str) and len(text) > ctx['max_chars']:
        return None, 'instructions_too_long'
    return harness, None


def _attempt_apply(ctx: dict, patch, candidate_fp: int):
    return _applied_harness(
        ctx, ctx['harness'], patch, _apply_role(ctx), ctx['holdout_fp'], candidate_fp,
    )


def _regression_reason(comparison) -> str:
    names = comparison.get('regressions') if isinstance(comparison, dict) else None
    if not isinstance(names, list):
        names = []
    joined = ','.join(str(item) for item in names)
    return 'benchmark_regression:' + joined


def _gate_benchmark(ctx: dict, index: int, harness: dict, candidate_fp: int) -> dict:
    bench = ctx['benchmark_fn'](index, harness)
    comparison = benchmark_suite.compare_benchmark_reports(
        ctx['bench'],
        bench,
        max_recall_drop=ctx['max_recall_drop'],
        allow_holdout_fp_increase=False,
    )
    metrics = _metrics_from_bench(bench)
    if comparison.get('passed') is False:
        return _record(index, 'rolled_back', ctx['harness'], metrics, _regression_reason(comparison))
    ctx['harness'] = harness
    ctx['bench'] = bench
    ctx['metrics'] = metrics
    ctx['holdout_fp'] = candidate_fp
    return _record(index, 'promoted', harness, metrics, None)


def _after_duel(ctx: dict, index: int, duel) -> dict:
    if not isinstance(duel, dict):
        return _record(index, 'rolled_back', ctx['harness'], ctx['metrics'], 'duel_invalid')
    candidate_fp = _duel_fp(duel, ctx['holdout_fp'])
    harness, reason = _attempt_apply(ctx, duel.get('harnessPatch'), candidate_fp)
    if harness is None:
        return _record(index, 'rolled_back', ctx['harness'], ctx['metrics'], reason)
    return _gate_benchmark(ctx, index, harness, candidate_fp)


def _signature_params(fn):
    try:
        return list(inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return []


def _call_both_duel(ctx: dict, source, index: int, target: str):
    fn = ctx['duel_fn']
    blue = ctx['harness']
    red = ctx['red_harness']
    active = blue if target == 'blue' else red
    params = _signature_params(fn)
    names = {param.name for param in params}
    positional = [
        param for param in params
        if param.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    if 'red_harness' in names or 'blue_harness' in names:
        kwargs = {}
        if 'red_harness' in names:
            kwargs['red_harness'] = red
        if 'blue_harness' in names:
            kwargs['blue_harness'] = blue
        return fn(source, index, active, **kwargs)
    if len(positional) >= 4:
        return fn(source, index, blue, red)
    return fn(source, index, active)


def _yield_value(node):
    if not isinstance(node, dict) or 'stealthYield' not in node:
        return None
    return _metric_num(node.get('stealthYield'))


def _duel_stealth(duel):
    if not isinstance(duel, dict):
        return None
    direct = _yield_value(duel)
    if direct is not None:
        return direct
    for key in ('roundRecord', 'round'):
        node = duel.get(key)
        found = _yield_value(node)
        if found is not None:
            return found
        if not isinstance(node, dict):
            continue
        evaluation = node.get('evaluation')
        found = _yield_value(evaluation)
        if found is not None:
            return found
        aggregate = evaluation.get('aggregate') if isinstance(evaluation, dict) else None
        found = _yield_value(aggregate)
        if found is not None:
            return found
    return None


def _stealth_blocked(active, candidate) -> bool:
    if candidate is None or active is None:
        return False
    if candidate < active:
        return True
    return active >= 0.5 and candidate < 0.5


def _after_red(ctx: dict, index: int, duel) -> dict:
    current = ctx['red_harness']
    if not isinstance(duel, dict):
        return _record(index, 'rolled_back', current, ctx['metrics'], 'duel_invalid')
    harness, reason = _applied_harness(ctx, current, duel.get('harnessPatch'), 'red', None, None)
    if harness is None:
        return _record(index, 'rolled_back', current, ctx['metrics'], reason)
    candidate = _duel_stealth(duel)
    if _stealth_blocked(ctx.get('stealth_yield'), candidate):
        return _record(index, 'rolled_back', current, ctx['metrics'], 'stealth_yield_regression')
    ctx['red_harness'] = harness
    if candidate is not None:
        ctx['stealth_yield'] = candidate
    return _record(index, 'promoted', harness, ctx['metrics'], None)


def _run_both(ctx: dict, index: int, source) -> dict:
    target = 'blue' if index % 2 else 'red'
    ctx['apply_role'] = target
    try:
        duel = _call_both_duel(ctx, source, index, target)
    except arena_duel.ArenaDuelError as error:
        record = _duel_failure(ctx, index, error, ctx['red_harness'] if target == 'red' else ctx['harness'])
        record['targetRole'] = target
        return record
    if target == 'blue':
        record = _after_duel(ctx, index, duel)
    else:
        record = _after_red(ctx, index, duel)
    record['targetRole'] = target
    return record


def _run_generation(ctx: dict, index: int) -> dict:
    source = ctx['sources'][(index - 1) % len(ctx['sources'])]
    if ctx['role'] == 'both':
        return _run_both(ctx, index, source)
    try:
        duel = ctx['duel_fn'](source, index, ctx['harness'])
    except arena_duel.ArenaDuelError as error:
        return _duel_failure(ctx, index, error)
    return _after_duel(ctx, index, duel)


def _mark(left: dict, right: dict, key: str, minimize: bool):
    left_value = _metric_num(left.get(key))
    right_value = _metric_num(right.get(key))
    if left_value is None or right_value is None:
        return None
    if left_value == right_value:
        return 0
    improved = left_value < right_value if minimize else left_value > right_value
    return 1 if improved else -1


def _dominates(left: dict, right: dict) -> bool:
    marks = [
        _mark(left, right, 'recall', False),
        _mark(left, right, 'holdoutPureFp', True),
    ]
    aurc = _mark(left, right, 'aurc', True)
    if aurc is not None:
        marks.append(aurc)
    decided = [item for item in marks if item is not None]
    if not decided:
        return False
    if any(item < 0 for item in decided):
        return False
    return any(item > 0 for item in decided)


def _is_dominated(metrics: dict, pool: list[dict]) -> bool:
    for other in pool:
        if other is metrics:
            continue
        if _dominates(other, metrics):
            return True
    return False


def _pareto_ready(record: dict) -> bool:
    metrics = record.get('metrics') if isinstance(record, dict) else None
    if not isinstance(metrics, dict):
        return False
    if _metric_num(metrics.get('recall')) is None:
        return False
    return _metric_num(metrics.get('holdoutPureFp')) is not None


def _frontier_point(record: dict) -> dict:
    return {
        'generation': record['generation'],
        'status': record['status'],
        'harnessSha256': record['harnessSha256'],
        'harnessGeneration': record['harnessGeneration'],
        'metrics': _copy_metrics(record.get('metrics')),
    }


def _pareto(records: list[dict]) -> list[dict]:
    ready = [record for record in records if _pareto_ready(record)]
    pool = [record['metrics'] for record in ready]
    chosen = []
    for record in ready:
        if _is_dominated(record['metrics'], pool):
            continue
        chosen.append(_frontier_point(record))
    return chosen


def _scrub_lineage(lineage: dict) -> None:
    try:
        arena_round._scrub(lineage, [], set())
    except arena_round.DistillScrubError as error:
        raise ArenaCampaignError('lineage_scrub_failed', 3, {'hitCount': len(error.hits), 'hits': error.hits}) from None


def _lineage(ctx: dict, records: list[dict]) -> dict:
    lineage = {
        'schema': CAMPAIGN_SCHEMA,
        'ok': True,
        'role': ctx['role'],
        'generationsRequested': ctx['generations'],
        'answerKeyFree': True,
        'scrubbed': True,
        'summary': {'axes': {}},
        'rules': [],
        'generations': records,
        'paretoFrontier': _pareto(records),
        'finalHarness': ctx['harness'],
        'finalHarnessSha256': _harness_sha256(ctx['harness']),
    }
    if ctx['role'] == 'both':
        lineage['finalBlueHarness'] = ctx['harness']
        lineage['finalRedHarness'] = ctx['red_harness']
    _scrub_lineage(lineage)
    return lineage


def run_evolution_campaign(
    source_pdfs: list,
    *,
    base_harness: dict,
    red_argv: list[str],
    blue_argv: list[str],
    holdout_pdfs: list[dict] | None = None,
    generations: int = 3,
    role: str = 'blue',
    min_difficulty: str | None = 'L3',
    runs: int = 1,
    timeout: int = 180,
    max_rules: int = 40,
    max_instructions_chars: int = 16000,
    max_recall_drop: float = 0.0,
    duel_fn=None,
    benchmark_fn=None,
    base_red_harness: dict | None = None,
    compact_rules: bool = False,
) -> dict:
    """Run a 1..3 generation campaign and return an answer-key-free lineage."""
    count = _require_generations(generations)
    role_name = _require_role(role)
    if type(compact_rules) is not bool:
        raise ArenaCampaignError('compact_rules_invalid', 2)
    harness, red_harness = _campaign_pair(role_name, base_harness, base_red_harness)
    ctx = {
        'sources': _require_sources(source_pdfs),
        'role': role_name,
        'generations': count,
        'max_chars': max_instructions_chars,
        'max_recall_drop': max_recall_drop,
        'harness': harness,
        'red_harness': red_harness,
        'compact_rules': compact_rules,
        'duel_fn': duel_fn or _bind_duel(
            red_argv, blue_argv, holdout_pdfs, min_difficulty, runs, timeout, max_rules,
        ),
        'benchmark_fn': benchmark_fn or _bind_bench(),
        'bench': None,
        'metrics': {},
        'holdout_fp': 0,
    }
    records = [_baseline(ctx)]
    for index in range(1, count + 1):
        records.append(_run_generation(ctx, index))
    return _lineage(ctx, records)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='arena_campaign.py',
        description='Multi-generation RED/BLUE co-evolution campaign.',
    )
    parser.add_argument('--source-pdf', action='append', type=Path)
    parser.add_argument('--supplement', action='append', type=Path)
    parser.add_argument('--holdout-pdf', action='append', type=Path)
    parser.add_argument('--base-harness', type=Path)
    parser.add_argument('--base-red-harness', type=Path)
    parser.add_argument('--role', default='blue', choices=('blue', 'red', 'both'))
    parser.add_argument('--compact-rules', action='store_true')
    parser.add_argument('--red-cmd')
    parser.add_argument('--red-arg', action='append')
    parser.add_argument('--blue-cmd')
    parser.add_argument('--blue-arg', action='append')
    parser.add_argument('--generations', type=int, default=3)
    parser.add_argument('--min-difficulty', default='L3')
    parser.add_argument('--runs', type=int, default=1)
    parser.add_argument('--timeout', type=int, default=180)
    parser.add_argument('--max-recall-drop', type=float, default=0.0)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--out-harness', type=Path)
    parser.add_argument('--out-red-harness', type=Path)
    return parser


def _command(cmd, extra, code: str) -> list[str]:
    if not isinstance(cmd, str) or not cmd.strip():
        raise ArenaCampaignError(code, 2)
    return [cmd, *[str(item) for item in list(extra or [])]]


def _load_harness(path, role: str) -> dict:
    if path is None:
        return _default_harness(role)
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ArenaCampaignError('harness_invalid', 2) from None
    if not isinstance(data, dict):
        raise ArenaCampaignError('harness_invalid', 2)
    return data


def _file_entry(path: Path) -> dict:
    return {'name': Path(path).name, 'bytes': Path(path).read_bytes()}


def _read_sources(paths, supplement_paths) -> list[dict]:
    supplements = [_file_entry(path) for path in supplement_paths]
    sources = []
    for path in paths:
        entry = _file_entry(path)
        entry['supplements'] = list(supplements)
        sources.append(entry)
    return sources


def _run_cli(args: argparse.Namespace) -> dict:
    count = _require_generations(args.generations)
    role = _require_role(args.role)
    if not args.source_pdf:
        raise ArenaCampaignError('source_pdfs_invalid', 2)
    red_base = None
    if args.base_red_harness is not None:
        red_base = _load_harness(args.base_red_harness, 'red')
    harness_role = 'blue' if role == 'both' else role
    return run_evolution_campaign(
        _read_sources(args.source_pdf, args.supplement or []),
        base_harness=_load_harness(args.base_harness, harness_role),
        red_argv=_command(args.red_cmd, args.red_arg, 'red_argv_invalid'),
        blue_argv=_command(args.blue_cmd, args.blue_arg, 'blue_argv_invalid'),
        holdout_pdfs=[_file_entry(path) for path in list(args.holdout_pdf or [])],
        generations=count,
        role=role,
        min_difficulty=args.min_difficulty,
        runs=args.runs,
        timeout=args.timeout,
        max_recall_drop=args.max_recall_drop,
        base_red_harness=red_base,
        compact_rules=bool(args.compact_rules),
    )


def _write_json(payload: dict, out_path) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    print(rendered)
    if out_path is not None:
        Path(out_path).write_text(rendered + '\n', encoding='utf-8')


def _error_document(error: ArenaCampaignError) -> dict:
    payload = {
        'schema': ERROR_SCHEMA,
        'ok': False,
        'error': error.code,
        'exitCode': error.exit_code,
    }
    for key, value in error.extra.items():
        if key not in payload:
            payload[key] = value
    return payload


def _emit_error(error: ArenaCampaignError, out_path) -> None:
    try:
        _write_json(_error_document(error), out_path)
    except TypeError:
        safe = {
            'schema': ERROR_SCHEMA,
            'ok': False,
            'error': error.code,
            'exitCode': error.exit_code,
        }
        _write_json(safe, out_path)


def _emit_harness(payload: dict, path) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    Path(path).write_text(rendered + '\n', encoding='utf-8')


def _emit_lineage(lineage: dict, out_path, harness_path, red_path=None) -> None:
    _write_json(lineage, out_path)
    if harness_path is not None:
        _emit_harness(lineage['finalHarness'], harness_path)
    if red_path is not None and isinstance(lineage.get('finalRedHarness'), dict):
        _emit_harness(lineage['finalRedHarness'], red_path)


def _parse(argv):
    try:
        return _build_parser().parse_args(argv)
    except SystemExit as exc:
        code = exc.code
        return 0 if code in (0, None) else 2


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint. Prints one JSON document and returns 0, 2, 3, or 124."""
    args = _parse(argv)
    if isinstance(args, int):
        return args
    try:
        lineage = _run_cli(args)
    except ArenaCampaignError as error:
        _emit_error(error, args.out)
        return error.exit_code
    except OSError:
        _emit_error(ArenaCampaignError('input_invalid', 2), getattr(args, 'out', None))
        return 2
    _emit_lineage(lineage, args.out, args.out_harness, getattr(args, 'out_red_harness', None))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

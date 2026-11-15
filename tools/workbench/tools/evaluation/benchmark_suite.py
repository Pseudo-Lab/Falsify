"""Deterministic synthetic gold and benign-trap holdout benchmark.

Sensor mode scores the offline BLUE layer-0 stack. Agent mode scores an
injected runner or a stdio BLUE agent. Reports use falsify.benchmark-report.v1.
"""
from __future__ import annotations

import argparse
import importlib
import json
from pathlib import Path
import sys

SCHEMA = 'falsify.benchmark-report.v1'
GOLD_SCHEMA = 'falsify.red-gold-ledger.v1'
LAYER0_DIFFICULTIES = ('L1', 'L2')
SEMANTIC_DIFFICULTIES = ('L3', 'L4')

_STAT_P = 'The paired contrast was t(38) = 1.10, p = 0.004 in the primary analysis.'
_STAT_PCT = 'The response count was 15/50 (42.0%) among enrolled participants.'
_URI_LINE = '[1] Alpha Group. Synthetic cohort report. Journal of Examples. 2024. doi:10.1000/alpha-2024'
_URI_VISIBLE = 'doi:10.1000/alpha-2024'
_CITE_LINE = 'Prior reports described the association [1] and a later claim [9].'
_N_LINE = 'We enrolled N = 200 participants at the coordinating center.'
_S3_LINE = 'Baseline characteristics appear in Supplementary Table S3.'
_FIG_EXCERPT = 'p1-1 [72.0, 122.0, 200.0, 218.0] vs p1-2 [300.0, 122.0, 428.0, 218.0]'
_D3_LINE = 'This study demonstrates that Drug Z causally halves mortality compared with standard care.'
_S1_LINE = 'Treatment reduced the error rate relative to Control.'
_CLEAN_DOI = 'doi:10.1000/clean-2025'


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _ensure_local() -> None:
    entries = (
        str(Path(__file__).resolve().parent),
        str(_repo_root() / 'app' / 'local'),
    )
    for entry in entries:
        if entry not in sys.path:
            sys.path.append(entry)


def _panel_png(seed: int = 3, width: int = 48, height: int = 36) -> bytes:
    import pymupdf

    samples = bytearray()
    for y in range(height):
        for x in range(width):
            samples += bytes((
                (x * 3 + y * 7 + seed * 13) % 256,
                (x * 5 + y * 11 + seed * 29) % 256,
                ((x // 4) * 23 + (y // 6) * 31 + seed * 41) % 256,
            ))
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, width, height, bytes(samples), 0)
    return pixmap.tobytes('png')


def _write_lines(page, lines) -> None:
    for index, line in enumerate(lines):
        page.insert_text((72, 64 + index * 14), line, fontsize=10)


def _place_link(page, link) -> None:
    if not link:
        return
    import pymupdf

    phrase, uri = link
    rects = page.search_for(phrase)
    if not rects:
        raise ValueError('link_anchor_missing')
    page.insert_link({'kind': pymupdf.LINK_URI, 'from': rects[0], 'uri': uri})


def _place_images(page, images) -> None:
    if not images:
        return
    import pymupdf

    for bbox, blob in images:
        page.insert_image(pymupdf.Rect(*bbox), stream=blob)


def _render_pdf(lines, link=None, images=None) -> bytes:
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    _write_lines(page, lines)
    _place_link(page, link)
    _place_images(page, images)
    raw = doc.tobytes()
    doc.close()
    return raw


def _participant_csv(count: int, split: bool = False) -> str:
    rows = ['participant_id,arm']
    for index in range(1, count + 1):
        arm = 'T' if split and index <= count // 2 else 'C' if split else 'A'
        rows.append(f'P{index},{arm}')
    return '\n'.join(rows)


def _defect(defect_id, world, family, difficulty, excerpt, *, stealth=False, label=None) -> dict:
    item = {
        'defectId': defect_id,
        'world': world,
        'family': family,
        'difficulty': difficulty,
        'pageIndex': 0,
        'excerpt': excerpt,
        'after': excerpt,
        'quote': excerpt,
        'stealthPass': stealth,
    }
    if label:
        item['label'] = label
    return item


def _ledger(defects) -> dict:
    return {'schema': GOLD_SCHEMA, 'defects': defects}


def _pack(case_id, world, family, difficulty, holdout, lines, defects, supplements=None, link=None, images=None) -> dict:
    return {
        'caseId': case_id,
        'world': world,
        'family': family,
        'difficulty': difficulty,
        'isHoldout': holdout,
        'blindPdfBytes': _render_pdf(lines, link, images),
        'supplements': list(supplements or []),
        'goldLedger': _ledger(defects),
    }


def _case_stat() -> dict:
    return _pack(
        'gold-w1-d1-stat-pvalue', 'W1', 'D1', 'L1', False,
        ['Results', _STAT_P, _STAT_PCT],
        [
            _defect('gold-w1-d1-stat', 'W1', 'D1', 'L1', _STAT_P),
            _defect('gold-w1-d1-percent', 'W1', 'D1', 'L1', _STAT_PCT),
        ],
    )


def _case_uri() -> dict:
    return _pack(
        'gold-w2-d2-uri-hijack', 'W2', 'D2', 'L1', False,
        ['Introduction', _CITE_LINE, 'References', _URI_LINE],
        [
            _defect('gold-w2-d2-uri', 'W2', 'D2', 'L1', _URI_VISIBLE),
            _defect('gold-w2-d2-cite', 'W2', 'D2', 'L1', _CITE_LINE),
        ],
        link=(_URI_VISIBLE, 'https://doi.org/10.1000/unrelated-9999'),
    )


def _case_supplement() -> dict:
    supplements = [
        {'name': 'participants.csv', 'text': _participant_csv(140)},
        {'name': 'supplement.md', 'text': 'Table S1 lists the visit window.\n'},
    ]
    return _pack(
        'gold-w3-d6-supplement-mismatch', 'W3', 'D6', 'L2', False,
        ['Methods', _N_LINE, _S3_LINE],
        [
            _defect('gold-w3-d6-n', 'W3', 'D6', 'L2', _N_LINE),
            _defect('gold-w3-d6-s3', 'W3', 'D6', 'L2', _S3_LINE),
        ],
        supplements=supplements,
    )


def _case_figure() -> dict:
    png = _panel_png()
    images = [((72, 120, 200, 220), png), ((300, 120, 428, 220), png)]
    return _pack(
        'gold-w4-d41-figure-duplicate', 'W4', 'D4-1', 'L2', False,
        ['Figure 1A. Panel of the primary assay.', 'Figure 2B. Panel of the replication assay.'],
        [_defect('gold-w4-d41-dup', 'W4', 'D4-1', 'L2', _FIG_EXCERPT, label='p1-1 [')],
        images=images,
    )


def _case_overclaim() -> dict:
    lines = [
        'Methods',
        'This was a single-arm observational cohort with n = 42 and no randomization.',
        'Conclusion',
        _D3_LINE,
    ]
    return _pack(
        'gold-w5-d3-overclaim', 'W5', 'D3', 'L4', False, lines,
        [_defect('gold-w5-d3-causal', 'W5', 'D3', 'L4', _D3_LINE, stealth=True)],
    )


def _case_direction() -> dict:
    lines = [
        'Table 1. Error rates by arm',
        'Treatment error rate was 18.4% and Control error rate was 9.2%.',
        'Discussion',
        _S1_LINE,
    ]
    return _pack(
        'gold-w5-s1-direction-inversion', 'W5', 'S1', 'L4', False, lines,
        [_defect('gold-w5-s1-direction', 'W5', 'S1', 'L4', _S1_LINE, stealth=True)],
    )


def _holdout(case_id, lines, supplements=None, link=None) -> dict:
    return _pack(case_id, 'W1', 'BENIGN', 'L1', True, lines, [], supplements=supplements, link=link)


def _case_holdout_aor() -> dict:
    lines = [
        'Methods',
        'The cohort compared exposed 24/100 with unexposed 20/100, crude OR = 1.26.',
        'A multivariable logistic regression gave adjusted aOR = 2.15 (95% CI 1.12-4.13), adjusted for age and baseline severity.',
    ]
    return _holdout('holdout-benign-multivariable-aor', lines)


def _case_holdout_fdr() -> dict:
    lines = [
        'Results',
        'The raw test statistic was t(28) = 2.45 with a Benjamini-Hochberg FDR-corrected q = 0.09.',
        'Bonferroni-adjusted p_adj = 0.14 was also reported for that contrast.',
    ]
    return _holdout('holdout-benign-fdr-padj', lines)


def _case_holdout_km() -> dict:
    lines = [
        'Methods',
        'Survival used a delayed-entry (left-truncated) cohort.',
        'Number at risk',
        'Cohort 80 94',
        'Time 0 6',
    ]
    return _holdout('holdout-benign-left-truncated-km', lines)


def _case_holdout_clean() -> dict:
    lines = [
        'Methods',
        'We enrolled N = 120 participants, with 60 assigned to treatment and 60 assigned to control.',
        'Results',
        'Events were 30/60 (50.0%) in treatment versus 15/60 (25.0%) in control.',
        'The contrast was t(118) = 2.50, p = 0.014.',
        'See the matching supplement.csv file.',
        'References',
        '[1] Clean Group. Consistent trial report. Journal of Examples. 2025. doi:10.1000/clean-2025',
    ]
    supplements = [{'name': 'supplement.csv', 'text': _participant_csv(120, split=True)}]
    return _holdout(
        'holdout-benign-consistent-trial', lines, supplements,
        link=(_CLEAN_DOI, 'https://doi.org/10.1000/clean-2025'),
    )


def build_benchmark_corpus() -> list[dict]:
    """Return the 6 gold cases and 4 benign-trap holdout cases."""
    return [
        _case_stat(),
        _case_uri(),
        _case_supplement(),
        _case_figure(),
        _case_overclaim(),
        _case_direction(),
        _case_holdout_aor(),
        _case_holdout_fdr(),
        _case_holdout_km(),
        _case_holdout_clean(),
    ]


def _select_cases(cases, case_ids) -> list[dict]:
    if not case_ids:
        return list(cases)
    wanted = set(case_ids)
    selected = [case for case in cases if case['caseId'] in wanted]
    if len(selected) != len(wanted):
        raise ValueError('case_id_unknown')
    return selected


def _pdf_page_texts(raw: bytes) -> list[str]:
    import pymupdf

    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        return [doc[idx].get_text('text') or '' for idx in range(doc.page_count)]
    finally:
        doc.close()


def _supplement_payload(item) -> dict:
    text = item.get('text')
    raw = item.get('bytes')
    if text is None and isinstance(raw, (bytes, bytearray)):
        text = bytes(raw).decode('utf-8', errors='replace')
    return {'name': item.get('name') or 'supplement', 'text': text or ''}


def _sensor_signals(case) -> list:
    import hashlib

    import paper_blue_sensor as sensor
    import paper_evidence as pe

    raw = case['blindPdfBytes']
    store = pe.EvidenceStore()
    summary = store.prepare(raw, hashlib.sha256(raw).hexdigest())
    result = sensor.run_blue_sensor(
        summary['paperId'], summary['fileHash'],
        include_figure_forensics=True, include_external_oracle=False, store=store,
    )
    return list(result.get('signals') or [])


def _supplement_signals(case) -> list:
    import paper_supplement_audit as audit

    supplements = [_supplement_payload(item) for item in case['supplements']]
    report = audit.audit_paper_with_supplements(_pdf_page_texts(case['blindPdfBytes']), supplements)
    return list(report.get('signals') or [])


def _invoke_raw_audit(audit, case):
    pages = _pdf_page_texts(case['blindPdfBytes'])
    supplements = case['supplements']
    try:
        return audit(pages, supplements)
    except TypeError:
        return audit({'pages': pages, 'supplements': supplements})


def _signals_from_report(report):
    if not isinstance(report, dict):
        return []
    signals = report.get('signals')
    if isinstance(signals, list):
        return signals
    findings = report.get('findings')
    return list(findings) if isinstance(findings, list) else []


def _raw_dataset_signals(case) -> list:
    try:
        module = importlib.import_module('paper_raw_dataset_audit')
    except ImportError:
        return []
    audit = getattr(module, 'audit_raw_datasets', None)
    if not callable(audit):
        return []
    return _signals_from_report(_invoke_raw_audit(audit, case))


def _signal_finding(signal, index) -> dict:
    excerpt = ' '.join(str(signal.get('excerpt') or '').split())
    page = signal.get('pageIndex')
    page_index = page if type(page) is int and page >= 0 else 0
    supplement = signal.get('supplementFile') or signal.get('supplementName')
    return {
        'id': str(signal.get('id') or f'sens-{index + 1}'),
        'family': signal.get('family'),
        'pageIndex': page_index,
        'excerpt': excerpt,
        'quote': excerpt,
        'detail': str(signal.get('detail') or ''),
        'itemId': signal.get('itemId'),
        'supplementName': supplement,
        'decision': 'defect',
    }


def _signals_to_run(signals, run_id) -> dict:
    findings = [
        _signal_finding(signal, index)
        for index, signal in enumerate(signals)
        if isinstance(signal, dict)
    ]
    return {'runId': run_id, 'agentId': 'layer0-sensor', 'findings': findings}


def _sensor_run(case) -> dict:
    _ensure_local()
    signals = _sensor_signals(case)
    signals.extend(_supplement_signals(case))
    signals.extend(_raw_dataset_signals(case))
    return _signals_to_run(signals, case['caseId'])


def _coerce_run(produced, run_id) -> dict:
    if not isinstance(produced, dict):
        raise ValueError('runner_output_invalid')
    findings = produced.get('findings')
    if isinstance(findings, list):
        return {'runId': run_id, 'agentId': 'runner_fn', 'findings': findings}
    runs = produced.get('runs')
    if isinstance(runs, list) and runs and isinstance(runs[0], dict):
        nested = runs[0].get('findings')
        if isinstance(nested, list):
            return {'runId': run_id, 'agentId': 'runner_fn', 'findings': nested}
    raise ValueError('runner_output_invalid')


def _score_run(case, run) -> dict:
    _ensure_local()
    import arena_runner

    evaluation = arena_runner.evaluate_arena_match(case['goldLedger'], run)
    return evaluation['runs'][0]


def _summary_from_record(record):
    if not isinstance(record, dict):
        return None
    evaluation = record.get('evaluation')
    if not isinstance(evaluation, dict):
        return None
    runs = evaluation.get('runs')
    if isinstance(runs, list) and runs and isinstance(runs[0], dict):
        return runs[0]
    return None


def _evaluate_agent_process(case, agent_argv) -> dict:
    if not agent_argv:
        raise ValueError('agent_argv_required')
    _ensure_local()
    import arena_round

    try:
        record = arena_round.run_round(
            case['blindPdfBytes'], list(agent_argv),
            gold_ledger=case['goldLedger'], blind_supplements=case['supplements'], runs=1,
        )
    except arena_round.ArenaRoundError as exc:
        raise ValueError(str(exc.code)) from exc
    summary = _summary_from_record(record)
    if summary is not None:
        return summary
    return _score_run(case, {'runId': case['caseId'], 'findings': []})


def _evaluate_case(case, mode, agent_argv, runner_fn) -> dict:
    if mode == 'sensor':
        return _score_run(case, _sensor_run(case))
    if runner_fn is not None:
        return _score_run(case, _coerce_run(runner_fn(case), case['caseId']))
    return _evaluate_agent_process(case, agent_argv)


def _validate_mode(mode, agent_argv, runner_fn) -> None:
    if mode not in ('sensor', 'agent'):
        raise ValueError('mode_invalid')
    if mode == 'agent' and runner_fn is None and not agent_argv:
        raise ValueError('agent_argv_required')


def _blank_bucket() -> dict:
    return {'total': 0, 'detected': 0, 'missed': 0, 'uncertain': 0, 'recall': None}


def _add_counts(slot, bucket) -> None:
    for field in ('total', 'detected', 'missed', 'uncertain'):
        slot[field] += int(bucket.get(field) or 0)


def _with_recall(merged) -> dict:
    for bucket in merged.values():
        total = bucket['total']
        bucket['recall'] = round(bucket['detected'] / total, 4) if total else None
    return merged


def _merge_axes(summaries, key) -> dict:
    merged = {}
    for summary in summaries:
        for name, bucket in (summary.get(key) or {}).items():
            _add_counts(merged.setdefault(name, _blank_bucket()), bucket)
    return _with_recall(merged)


def _ratio(detected, total):
    if not total:
        return 0.0
    return round(detected / total, 4)


def _difficulty_recall(buckets, keys) -> float:
    detected = 0
    total = 0
    for key in keys:
        bucket = buckets.get(key) or {}
        detected += int(bucket.get('detected') or 0)
        total += int(bucket.get('total') or 0)
    return _ratio(detected, total)


def _sum_field(summaries, field) -> int:
    return sum(int(summary.get(field) or 0) for summary in summaries)


def _stealth_yield(summaries):
    total = _sum_field(summaries, 'stealthTotal')
    if not total:
        return None
    return round(_sum_field(summaries, 'stealthEvaded') / total, 4)


def _selective_items(summaries) -> list[dict]:
    items = []
    for summary in summaries:
        items.extend({'tier': 1, 'isCorrect': True} for _ in range(int(summary.get('tp') or 0)))
        items.extend({'tier': 1, 'isCorrect': False} for _ in range(int(summary.get('pureFp') or 0)))
    return items


def _selective_block(items) -> dict:
    from agreement_selective import compute_selective_prediction

    raw = compute_selective_prediction(items)
    return {
        'aurc': raw.get('aurc'),
        'tier1Precision': raw.get('selective_accuracy'),
        'overallAccuracy': raw.get('full_coverage_accuracy'),
        'coverage': raw.get('coverage_at_committed'),
    }


def _split_cases(cases, summaries):
    gold, holdout = [], []
    for case, summary in zip(cases, summaries):
        target = holdout if case['isHoldout'] else gold
        target.append((case, summary))
    return gold, holdout


def _gold_summary(pairs) -> dict:
    summaries = [summary for _case, summary in pairs]
    tp = _sum_field(summaries, 'tp')
    fn = _sum_field(summaries, 'fn')
    by_difficulty = _merge_axes(summaries, 'byDifficulty')
    return {
        'caseCount': len(pairs),
        'totalGoldDefects': tp + fn,
        'tp': tp,
        'fn': fn,
        'recall': _ratio(tp, tp + fn),
        'layer0Recall': _difficulty_recall(by_difficulty, LAYER0_DIFFICULTIES),
        'semanticRecall': _difficulty_recall(by_difficulty, SEMANTIC_DIFFICULTIES),
        'byWorld': _merge_axes(summaries, 'byWorld'),
        'byFamily': _merge_axes(summaries, 'byFamily'),
        'byDifficulty': by_difficulty,
        'selective': _selective_block(_selective_items(summaries)),
        'stealthYield': _stealth_yield(summaries),
    }


def _holdout_summary(pairs) -> dict:
    cases = [
        {'caseId': case['caseId'], 'pureFp': int(summary.get('pureFp') or 0)}
        for case, summary in pairs
    ]
    total = sum(item['pureFp'] for item in cases)
    count = len(pairs)
    abstained = _sum_field([summary for _case, summary in pairs], 'abstainedCount')
    return {
        'caseCount': count,
        'totalPureFp': total,
        'pureFpRatePerPaper': round(total / count, 4) if count else 0.0,
        'abstainedCount': abstained,
        'cases': cases,
    }


def _case_result(case, summary) -> dict:
    return {
        'caseId': case['caseId'],
        'world': case['world'],
        'family': case['family'],
        'difficulty': case['difficulty'],
        'isHoldout': case['isHoldout'],
        'tp': int(summary.get('tp') or 0),
        'fn': int(summary.get('fn') or 0),
        'pureFp': int(summary.get('pureFp') or 0),
        'recall': summary.get('recall'),
    }


def _num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _nested(obj, *keys):
    current = obj
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _delta(current, baseline):
    if current is None or baseline is None:
        return None
    return round(current - baseline, 4)


def _recall_regressed(baseline, current, max_recall_drop) -> bool:
    base = _num(_nested(baseline, 'goldSummary', 'recall'))
    cur = _num(_nested(current, 'goldSummary', 'recall'))
    if base is None or cur is None:
        return False
    return base - cur > float(max_recall_drop) + 1e-12


def _fp_regressed(baseline, current, allow_increase) -> bool:
    if allow_increase:
        return False
    base = _num(_nested(baseline, 'holdoutSummary', 'totalPureFp'))
    cur = _num(_nested(current, 'holdoutSummary', 'totalPureFp'))
    if base is None or cur is None:
        return False
    return cur > base


def compare_benchmark_reports(baseline_report, current_report, *, max_recall_drop=0.0, allow_holdout_fp_increase=False) -> dict:
    """Fail when holdout pure FP rises or gold recall drops past max_recall_drop."""
    regressions = []
    if _recall_regressed(baseline_report, current_report, max_recall_drop):
        regressions.append('recall_drop')
    if _fp_regressed(baseline_report, current_report, allow_holdout_fp_increase):
        regressions.append('holdout_pure_fp_increase')
    passed = not regressions
    base_recall = _num(_nested(baseline_report, 'goldSummary', 'recall'))
    cur_recall = _num(_nested(current_report, 'goldSummary', 'recall'))
    base_fp = _num(_nested(baseline_report, 'holdoutSummary', 'totalPureFp'))
    cur_fp = _num(_nested(current_report, 'holdoutSummary', 'totalPureFp'))
    base_aurc = _num(_nested(baseline_report, 'goldSummary', 'selective', 'aurc'))
    cur_aurc = _num(_nested(current_report, 'goldSummary', 'selective', 'aurc'))
    return {
        'passed': passed,
        'code': 'ok' if passed else 'benchmark_regression_detected',
        'regressions': regressions,
        'deltas': {
            'recallDelta': _delta(cur_recall, base_recall),
            'holdoutPureFpDelta': _delta(cur_fp, base_fp),
            'aurcDelta': _delta(cur_aurc, base_aurc),
        },
    }


def _build_report(mode, cases, summaries, baseline, max_recall_drop, allow_fp) -> dict:
    gold_pairs, hold_pairs = _split_cases(cases, summaries)
    report = {
        'schema': SCHEMA,
        'mode': mode,
        'caseCount': len(cases),
        'goldSummary': _gold_summary(gold_pairs),
        'holdoutSummary': _holdout_summary(hold_pairs),
        'caseResults': [_case_result(case, summary) for case, summary in zip(cases, summaries)],
        'comparison': None,
    }
    if baseline is not None:
        report['comparison'] = compare_benchmark_reports(
            baseline, report,
            max_recall_drop=max_recall_drop,
            allow_holdout_fp_increase=allow_fp,
        )
    return report


def run_benchmark_suite(mode='sensor', *, cases=None, case_ids=None, agent_argv=None, runner_fn=None, baseline_report=None, max_recall_drop=0.0, allow_holdout_fp_increase=False) -> dict:
    """Score the synthetic corpus with the layer-0 sensor or a BLUE agent."""
    _validate_mode(mode, agent_argv, runner_fn)
    selected = _select_cases(cases if cases is not None else build_benchmark_corpus(), case_ids)
    summaries = [_evaluate_case(case, mode, agent_argv, runner_fn) for case in selected]
    return _build_report(
        mode, selected, summaries, baseline_report, max_recall_drop, allow_holdout_fp_increase,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Synthetic RED/BLUE regression benchmark.')
    parser.add_argument('--mode', choices=('sensor', 'agent'), default='sensor')
    parser.add_argument('--agent-cmd')
    parser.add_argument('--agent-arg', action='append', default=[])
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--baseline-report', type=Path)
    parser.add_argument('--max-recall-drop', type=float, default=0.0)
    parser.add_argument('--out', type=Path)
    return parser


def _agent_argv(args):
    if args.mode != 'agent':
        return None
    if not args.agent_cmd:
        raise ValueError('agent_cmd_required')
    return [args.agent_cmd, *list(args.agent_arg or [])]


def _load_baseline(path):
    if path is None:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError('baseline_report_invalid') from exc
    if not isinstance(data, dict):
        raise ValueError('baseline_report_invalid')
    return data


def _write_report(report, out_path) -> None:
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if out_path is not None:
        Path(out_path).write_text(rendered + '\n', encoding='utf-8')


def _exit_code(exc) -> int:
    code = exc.code
    if code in (0, None):
        return 0
    return 2


def main(argv=None) -> int:
    """Emit a benchmark report and return 0, 2, or 3."""
    parser = _parser()
    try:
        args = parser.parse_args(argv)
        report = run_benchmark_suite(
            args.mode,
            case_ids=list(args.case or []),
            agent_argv=_agent_argv(args),
            baseline_report=_load_baseline(args.baseline_report),
            max_recall_drop=args.max_recall_drop,
        )
    except SystemExit as exc:
        return _exit_code(exc)
    except ValueError:
        return 2
    _write_report(report, args.out)
    comparison = report.get('comparison')
    if isinstance(comparison, dict) and comparison.get('passed') is False:
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())

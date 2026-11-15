"""Multi-rater agreement (Krippendorff's alpha) and selective prediction (Risk-Coverage / AURC).

Stdlib only. Supports score.py-compatible 12-column BLUE CSVs and unit-matrix JSON.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from pathlib import Path

SCHEMA = 'falsify.agreement-selective.v1'
ORDINAL_SCALES = (
    ('맞음', '확인필요', '아님'),
    ('undetected', 'uncertain', 'detected'),
    ('missed', 'uncertain', 'detected'),
)
CORRECT_VERDICTS = frozenset({'supported', 'pre-existing', 'gold-error', 'true', 'correct', 'tp', '1'})
INCORRECT_VERDICTS = frozenset({'unsupported', 'pure_fp', 'purefp', 'false', 'fp', 'incorrect', '0'})
NUMERIC_RE = re.compile(r'^-?\d+(?:\.\d+)?$')


def _round4(value: float) -> float:
    rounded = round(float(value), 4)
    return 0.0 if rounded == 0.0 else rounded


def _round6(value: float) -> float:
    rounded = round(float(value), 6)
    return 0.0 if rounded == 0.0 else rounded


def _normalize_rating(value) -> str | None:
    if value is None or isinstance(value, bool):
        return None if value is None else ('true' if value else 'false')
    if isinstance(value, float) and not math.isfinite(value):
        return None
    text = str(value).strip()
    if not text or text.lower() == 'pending':
        return None
    return text


def _extract_pairable_units(units) -> list[list[str]]:
    if not isinstance(units, (list, tuple)):
        return []
    pairable: list[list[str]] = []
    for entry in units:
        if isinstance(entry, dict):
            raw = entry.get('ratings')
        elif isinstance(entry, (list, tuple)):
            raw = entry
        else:
            raw = None
        if not isinstance(raw, (list, tuple)):
            continue
        cleaned = [r for r in (_normalize_rating(v) for v in raw) if r is not None]
        if len(cleaned) >= 2:
            pairable.append(cleaned)
    return pairable


def _match_ordinal_scale(observed: set[str]) -> tuple[str, ...] | None:
    for scale in ORDINAL_SCALES:
        if observed.issubset(scale):
            return scale
    return None


def _resolve_category_order(pairable: list[list[str]], level: str, explicit_order=None) -> list[str]:
    observed = {val for unit in pairable for val in unit}
    if explicit_order:
        norm = [r for r in (_normalize_rating(v) for v in explicit_order) if r is not None]
        base = [c for c in norm if c in observed]
        extras = sorted(observed - set(base))
        return base + extras
    if level == 'ordinal':
        scale = _match_ordinal_scale(observed)
        if scale is not None:
            return [c for c in scale if c in observed]
    items = list(observed)
    if items and all(NUMERIC_RE.match(c) for c in items):
        return sorted(items, key=float)
    return sorted(items)


def _build_coincidence_matrix(pairable: list[list[str]], categories: list[str]):
    idx = {c: i for i, c in enumerate(categories)}
    size = len(categories)
    matrix = [[0.0] * size for _ in range(size)]
    marginals = [0] * size
    total_pairs = 0
    for unit in pairable:
        m = len(unit)
        counts = [0] * size
        for val in unit:
            counts[idx[val]] += 1
        for i in range(size):
            if not counts[i]:
                continue
            marginals[i] += counts[i]
            total_pairs += counts[i]
            for j in range(size):
                if not counts[j]:
                    continue
                matrix[i][j] += (counts[i] * (counts[j] - (1 if i == j else 0))) / (m - 1)
    return matrix, marginals, total_pairs


def _ordinal_delta_sq(marginals: list[int], i: int, j: int) -> float:
    lo, hi = (i, j) if i < j else (j, i)
    span = sum(marginals[lo:hi + 1]) - (marginals[i] + marginals[j]) / 2.0
    return span * span


def _compute_disagreements(matrix, marginals: list[int], total_pairs: int, level: str):
    size = len(marginals)
    do_sum = 0.0
    de_sum = 0.0
    for i in range(size):
        for j in range(i + 1, size):
            d2 = _ordinal_delta_sq(marginals, i, j) if level == 'ordinal' else 1.0
            do_sum += 2.0 * matrix[i][j] * d2
            de_sum += 2.0 * marginals[i] * marginals[j] * d2
    return do_sum / total_pairs, de_sum / (total_pairs * (total_pairs - 1))


def _alpha_band(alpha: float) -> str:
    if alpha >= 0.8:
        return '신뢰 가능 (≥0.80)'
    if alpha >= 0.667:
        return '잠정 합의 (0.67–0.80)'
    return '판정 기준 재정렬 필요 (<0.67)'


def compute_krippendorff_alpha(units, level: str = 'nominal', categories=None) -> dict:
    """Compute exact Krippendorff's alpha for nominal or ordinal ratings."""
    metric_level = 'ordinal' if level == 'ordinal' else 'nominal'
    pairable = _extract_pairable_units(units)
    if not pairable:
        return {
            'status': 'insufficient_pairs',
            'level': metric_level,
            'alpha': None,
            'observed_disagreement': None,
            'expected_disagreement': None,
            'pairable_units': 0,
            'total_pairs': 0,
            'categories': [],
            'band': '비교 가능한 복수 판정 부족',
        }
    cats = _resolve_category_order(pairable, metric_level, categories)
    matrix, marginals, total_pairs = _build_coincidence_matrix(pairable, cats)
    observed, expected = _compute_disagreements(matrix, marginals, total_pairs, metric_level)
    if expected == 0.0:
        return {
            'status': 'unanimous',
            'level': metric_level,
            'alpha': 1.0,
            'observed_disagreement': 0.0,
            'expected_disagreement': 0.0,
            'pairable_units': len(pairable),
            'total_pairs': total_pairs,
            'categories': cats,
            'band': '신뢰 가능 (≥0.80)',
        }
    alpha = _round4(1.0 - observed / expected)
    return {
        'status': 'ok',
        'level': metric_level,
        'alpha': alpha,
        'observed_disagreement': _round6(observed),
        'expected_disagreement': _round6(expected),
        'pairable_units': len(pairable),
        'total_pairs': total_pairs,
        'categories': cats,
        'band': _alpha_band(alpha),
    }


def _resolve_item_tier(item: dict) -> int:
    raw_tier = item.get('tier')
    if raw_tier in (1, 2, 3, '1', '2', '3'):
        return int(raw_tier)
    if (
        item.get('zeroDropRecovered') is True
        or item.get('zero_drop_recovered') is True
        or str(item.get('zero_drop_recovered', '')).strip().lower() in ('true', '1', 'yes')
        or item.get('origin') == 'zero-drop'
        or item.get('status') == 'zero-drop-recovered'
    ):
        return 3
    lbl = str(item.get('verdictLabel') or item.get('label') or '').strip()
    verdict = str(item.get('verdict') or '').strip().lower()
    if (
        lbl == '확인필요'
        or item.get('uncertainty') == 'high'
        or verdict in ('uncertain', 'needs-verification')
        or item.get('deferred') is True
        or item.get('abstained') is True
    ):
        return 2
    return 1


def _resolve_item_correctness(item: dict) -> bool | None:
    for key in ('isCorrect', 'is_correct'):
        val = item.get(key)
        if isinstance(val, bool):
            return val
    for key in ('h1Verdict', 'h1_verdict', 'verdict', 'goldLabel', 'gold_label', 'is_correct'):
        raw = str(item.get(key) or '').strip().lower()
        if raw in CORRECT_VERDICTS:
            return True
        if raw in INCORRECT_VERDICTS:
            return False
    return None


def _build_stage_point(stage: str, count: int, correct_count: int, total: int) -> dict:
    coverage = _round4(count / total)
    if not count:
        return {'stage': stage, 'count': 0, 'coverage': coverage, 'accuracy': None, 'risk': None}
    acc = correct_count / count
    return {
        'stage': stage,
        'count': count,
        'coverage': coverage,
        'accuracy': _round4(acc),
        'risk': _round4(1.0 - acc),
    }


def _compute_trapezoidal_aurc(curve: list[dict]) -> float | None:
    pts = [p for p in curve if p['risk'] is not None and p['count'] > 0]
    if not pts:
        return None
    area = pts[0]['coverage'] * pts[0]['risk']
    for i in range(1, len(pts)):
        dc = pts[i]['coverage'] - pts[i - 1]['coverage']
        if dc > 0.0:
            area += dc * (pts[i - 1]['risk'] + pts[i]['risk']) / 2.0
    return _round4(area)


def compute_selective_prediction(items) -> dict:
    """Compute abstention rate, selective accuracy/risk, abstention gain, and trapezoidal AURC."""
    clean: list[tuple[int, bool]] = []
    for item in items or ():
        if not isinstance(item, dict):
            continue
        correct = _resolve_item_correctness(item)
        if correct is not None:
            clean.append((_resolve_item_tier(item), correct))
    if not clean:
        return {
            'status': 'insufficient_data',
            'total_evaluated': 0,
            'committed_count': 0,
            'abstained_count': 0,
            'abstention_rate': None,
            'coverage_at_committed': None,
            'selective_accuracy': None,
            'selective_risk': None,
            'full_coverage_accuracy': None,
            'full_coverage_risk': None,
            'abstention_gain': None,
            'aurc': None,
            'risk_coverage_curve': [],
        }
    counts = {1: 0, 2: 0, 3: 0}
    correct_counts = {1: 0, 2: 0, 3: 0}
    for tier, is_ok in clean:
        counts[tier] += 1
        if is_ok:
            correct_counts[tier] += 1
    n1, n2, n3 = counts[1], counts[2], counts[3]
    c1, c2, c3 = correct_counts[1], correct_counts[2], correct_counts[3]
    total = n1 + n2 + n3
    abstained = n2 + n3
    full_acc = (c1 + c2 + c3) / total
    sel_acc = (c1 / n1) if n1 > 0 else None
    curve = [
        _build_stage_point('확정(아님)만 채택', n1, c1, total),
        _build_stage_point('수동 확인필요 포함', n1 + n2, c1 + c2, total),
        _build_stage_point('Zero-Drop 복원 포함 전체', total, c1 + c2 + c3, total),
    ]
    return {
        'status': 'ok',
        'total_evaluated': total,
        'committed_count': n1,
        'abstained_count': abstained,
        'abstention_rate': _round4(abstained / total),
        'coverage_at_committed': _round4(n1 / total),
        'selective_accuracy': _round4(sel_acc) if sel_acc is not None else None,
        'selective_risk': _round4(1.0 - sel_acc) if sel_acc is not None else None,
        'full_coverage_accuracy': _round4(full_acc),
        'full_coverage_risk': _round4(1.0 - full_acc),
        'abstention_gain': _round4(sel_acc - full_acc) if sel_acc is not None else None,
        'aurc': _compute_trapezoidal_aurc(curve),
        'risk_coverage_curve': curve,
    }


def _csv_unit_key(row: dict) -> tuple[str, str, str]:
    return (
        str(row.get('paper_id') or '').strip(),
        str(row.get('location') or '').strip(),
        str(row.get('defect_type') or '').strip(),
    )


def _read_csv_rows(path: Path) -> list[dict]:
    with path.open('r', encoding='utf-8-sig', newline='') as handle:
        return list(csv.DictReader(handle))


def _load_gold_entries(gold_path: Path | None) -> dict[tuple[str, ...], dict]:
    if gold_path is None:
        return {}
    if gold_path.suffix.lower() == '.csv':
        rows = _read_csv_rows(gold_path)
    else:
        raw = json.loads(gold_path.read_text(encoding='utf-8'))
        rows = _normalize_gold_json(raw)
    lookup: dict[tuple[str, ...], dict] = {}
    for entry in rows:
        key3 = _csv_unit_key(entry)
        lookup[key3] = entry
        lookup[(key3[0], key3[1])] = entry
    return lookup


def _normalize_gold_json(raw) -> list[dict]:
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    if isinstance(raw, dict):
        if isinstance(raw.get('entries'), list):
            return [r for r in raw['entries'] if isinstance(r, dict)]
        out = []
        for k, val in raw.items():
            parts = k.split('|') if '|' in k else k.split('::')
            base = {'paper_id': parts[0] if len(parts) > 0 else '', 'location': parts[1] if len(parts) > 1 else '', 'defect_type': parts[2] if len(parts) > 2 else ''}
            out.append({**base, **(val if isinstance(val, dict) else {'gold_label': val})})
        return out
    return []


def _row_to_selective_item(row: dict, gold_map: dict) -> dict | None:
    label = str(row.get('label') or '').strip()
    if label == '맞음' and row.get('tier') not in (1, 2, 3, '1', '2', '3'):
        return None
    key3 = _csv_unit_key(row)
    gold = gold_map.get(key3) or gold_map.get((key3[0], key3[1])) or {}
    merged = {**row, **gold}
    evidence_lower = str(row.get('evidence') or '').lower()
    if 'zero-drop' in evidence_lower and 'tier' not in merged:
        merged['origin'] = 'zero-drop'
    return merged


def evaluate_csv_files(csv_paths: list[Path], gold_path: Path | None = None, categories=None) -> dict:
    """Align 2+ 12-column BLUE CSVs by (paper_id, location, defect_type) and compute metrics."""
    streams = [_read_csv_rows(p) for p in csv_paths]
    gold_map = _load_gold_entries(gold_path)
    unit_map: dict[tuple[str, str, str], list[str | None]] = {}
    selective_items: list[dict] = []
    num_raters = len(streams)
    for idx, rows in enumerate(streams):
        for row in rows:
            key = _csv_unit_key(row)
            if key not in unit_map:
                unit_map[key] = [None] * num_raters
            unit_map[key][idx] = row.get('label')
            sel_item = _row_to_selective_item(row, gold_map)
            if sel_item is not None:
                selective_items.append(sel_item)
    units = [{'unitId': '|'.join(k), 'ratings': v} for k, v in unit_map.items()]
    return _build_summary(units, selective_items, categories)


def evaluate_units_json(json_path: Path, gold_path: Path | None = None, categories=None) -> dict:
    """Evaluate explicit unit matrix JSON and optional selective prediction items."""
    payload = json.loads(json_path.read_text(encoding='utf-8'))
    if isinstance(payload, list):
        units, items = payload, []
    elif isinstance(payload, dict):
        units = payload.get('units') or []
        items = payload.get('items') or []
        categories = categories or payload.get('categories')
    else:
        units, items = [], []
    if not items and gold_path is not None:
        gold_map = _load_gold_entries(gold_path)
        items = list(gold_map.values())
    return _build_summary(units, items, categories)


def _build_summary(units, selective_items, categories=None) -> dict:
    nominal = compute_krippendorff_alpha(units, level='nominal', categories=categories)
    ordinal = compute_krippendorff_alpha(units, level='ordinal', categories=categories)
    selective = compute_selective_prediction(selective_items)
    return {
        'schema': SCHEMA,
        'nominal_alpha': nominal['alpha'],
        'ordinal_alpha': ordinal['alpha'],
        'nominal': nominal,
        'ordinal': ordinal,
        'abstention_rate': selective['abstention_rate'],
        'selective_accuracy': selective['selective_accuracy'],
        'full_coverage_accuracy': selective['full_coverage_accuracy'],
        'abstention_gain': selective['abstention_gain'],
        'risk_coverage_curve': selective['risk_coverage_curve'],
        'aurc': selective['aurc'],
        'selective_prediction': selective,
        'units_count': len(units),
    }


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Compute Krippendorff alpha and selective prediction AURC.')
    parser.add_argument('--csv', nargs='+', type=Path, help='2+ score.py-compatible 12-column BLUE CSV files')
    parser.add_argument('--units-json', type=Path, help='Explicit unit matrix JSON file')
    parser.add_argument('--gold', type=Path, help='Optional gold/audit labels JSON or CSV')
    parser.add_argument('--categories', type=str, help='Comma-separated ordered categories for ordinal alpha')
    parser.add_argument('--out', type=Path, help='Optional path to write JSON summary')
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    categories = [c.strip() for c in args.categories.split(',') if c.strip()] if args.categories else None
    if args.csv:
        if len(args.csv) < 2:
            print('At least 2 CSV files are required for multi-rater alignment.', file=sys.stderr)
            return 2
        summary = evaluate_csv_files(args.csv, args.gold, categories)
    elif args.units_json:
        summary = evaluate_units_json(args.units_json, args.gold, categories)
    else:
        print('Specify --csv <file1> <file2> ... or --units-json <file>.', file=sys.stderr)
        return 2
    rendered = json.dumps(summary, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(rendered + '\n', encoding='utf-8')
    print(rendered)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

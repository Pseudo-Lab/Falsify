"""Heterogeneous multi-BLUE consensus without ground-truth leakage.

Findings cluster by shared id or by quote overlap on the same page or
supplement. Minority defect votes are kept as ``확인필요``. When PDF bytes
are supplied, ``blue_report_validate.finalize_blue_report`` downgrades
unverified quotes and the merged report is ready to score.
"""
from __future__ import annotations

import math
from pathlib import Path
import re
import sys

_EVAL_DIR = Path(__file__).resolve().parent
_APP_LOCAL = _EVAL_DIR.parents[1] / 'app' / 'local'
if str(_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_EVAL_DIR))
if str(_APP_LOCAL) not in sys.path:
    sys.path.insert(0, str(_APP_LOCAL))

import blue_report_validate  # noqa: E402
from agreement_selective import compute_krippendorff_alpha  # noqa: E402

SCHEMA = 'falsify.blue-ensemble.v1'
_RED_KEYS = frozenset({
    'before', 'after', 'gold', 'goldLedger', 'why_hard', 'candidateRationales',
})
_LABELS = {
    '아님': '아님',
    'defect': '아님',
    'unsupported': '아님',
    '확인필요': '확인필요',
    'needs_verification': '확인필요',
    'needs-verification': '확인필요',
    'uncertain': '확인필요',
    'abstain': '확인필요',
    '맞음': '맞음',
    'supported': '맞음',
    'clean': '맞음',
    'verified_clean': '맞음',
    'no_defect': '맞음',
}
_SEVERITY = {'맞음': 0, '확인필요': 1, '아님': 2}
_TOKEN_RE = re.compile(r'[A-Za-z0-9가-힣]+')
_JACCARD_MIN = 0.45
_SUBSTRING_MIN = 8


def _has_red_key(node) -> bool:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in _RED_KEYS or _has_red_key(value):
                return True
        return False
    if isinstance(node, list):
        return any(_has_red_key(item) for item in node)
    return False


def _require_reports(reports) -> list[dict]:
    if not isinstance(reports, list) or not 2 <= len(reports) <= 12:
        raise ValueError('invalid_reports')
    for report in reports:
        if not isinstance(report, dict) or _has_red_key(report):
            raise ValueError('forbidden_red_key' if isinstance(report, dict) else 'invalid_reports')
    return reports


def _rater_ids(reports: list[dict], provided) -> list[str]:
    if provided is None:
        return [f'rater-{index + 1}' for index in range(len(reports))]
    if not isinstance(provided, list) or len(provided) != len(reports):
        raise ValueError('invalid_rater_ids')
    cleaned = []
    for item in provided:
        if not isinstance(item, str) or not item.strip():
            raise ValueError('invalid_rater_ids')
        cleaned.append(item.strip())
    return cleaned


def _minimum(value, count: int) -> int:
    if value is None:
        return math.ceil(count / 2)
    if isinstance(value, bool) or type(value) is not int or not 1 <= value <= count:
        raise ValueError('invalid_min_consensus')
    return value


def _findings_of(report: dict) -> list[dict]:
    for key in ('findings', 'verdicts'):
        value = report.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _label_of(finding: dict) -> str:
    for key in ('verdictLabel', 'verdict', 'decision'):
        value = finding.get(key)
        if not isinstance(value, str):
            continue
        mapped = _LABELS.get(value.strip()) or _LABELS.get(value.strip().lower())
        if mapped:
            return mapped
    return '확인필요'


def _quote_of(finding: dict) -> str:
    for key in ('quote', 'excerpt', 'resolutionQuote'):
        value = finding.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ''


def _shared_id(finding: dict) -> str:
    for key in ('candidateId', 'id'):
        value = finding.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ''


def _page_of(finding: dict):
    value = finding.get('pageIndex')
    if type(value) is int and value >= 0:
        return value
    return None


def _text_field(finding: dict, key: str) -> str:
    value = finding.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return ''


def _norm_quote(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip().lower()


def _tokens(text: str) -> frozenset:
    return frozenset(_TOKEN_RE.findall(text.lower()))


def _observation(rater_index: int, rater_id: str, finding: dict) -> dict:
    quote = _quote_of(finding)
    norm = _norm_quote(quote)
    return {
        'rater': rater_index,
        'raterId': rater_id,
        'key': _shared_id(finding),
        'page': _page_of(finding),
        'supplement': _text_field(finding, 'supplementName'),
        'family': _text_field(finding, 'family'),
        'quote': quote,
        'norm': norm,
        'tokens': _tokens(norm),
        'label': _label_of(finding),
    }


def _observations(reports: list[dict], rater_ids: list[str]) -> list[dict]:
    rows = []
    for index, report in enumerate(reports):
        for finding in _findings_of(report):
            rows.append(_observation(index, rater_ids[index], finding))
    return rows


def _substring_match(left: str, right: str) -> bool:
    if len(left) < _SUBSTRING_MIN or len(right) < _SUBSTRING_MIN:
        return False
    return left in right or right in left


def _jaccard(left: frozenset, right: frozenset) -> float:
    if not left or not right:
        return 0.0
    union = left | right
    if not union:
        return 0.0
    return len(left & right) / len(union)


def _same_place(left: dict, right: dict) -> bool:
    if left['page'] is not None and left['page'] == right['page']:
        return True
    if left['supplement'] and left['supplement'] == right['supplement']:
        return True
    return False


def _quote_close(left: dict, right: dict) -> bool:
    if _substring_match(left['norm'], right['norm']):
        return True
    return _jaccard(left['tokens'], right['tokens']) >= _JACCARD_MIN


def _same_unit(left: dict, right: dict) -> bool:
    if left['key'] and left['key'] == right['key']:
        return True
    if not _same_place(left, right):
        return False
    return _quote_close(left, right)


def _find(parent: list[int], index: int) -> int:
    while parent[index] != index:
        parent[index] = parent[parent[index]]
        index = parent[index]
    return index


def _unite(parent: list[int], left: int, right: int) -> None:
    root_left = _find(parent, left)
    root_right = _find(parent, right)
    if root_left != root_right:
        parent[root_right] = root_left


def _cluster(observations: list[dict]) -> list[list[dict]]:
    parent = list(range(len(observations)))
    for left in range(len(observations)):
        for right in range(left + 1, len(observations)):
            if _same_unit(observations[left], observations[right]):
                _unite(parent, left, right)
    groups: dict[int, list[dict]] = {}
    for index, item in enumerate(observations):
        groups.setdefault(_find(parent, index), []).append(item)
    return list(groups.values())


def _cluster_key(items: list[dict]):
    keys = sorted(item['key'] for item in items if item['key'])
    norms = sorted(item['norm'] for item in items if item['norm'])
    lead_key = keys[0] if keys else ''
    lead_norm = norms[0] if norms else ''
    return (lead_key, lead_norm, min(item['rater'] for item in items))


def _sort_clusters(clusters: list[list[dict]]) -> list[list[dict]]:
    return sorted(clusters, key=_cluster_key)


def _severe(items: list[dict]) -> str:
    return max((item['label'] for item in items), key=lambda label: _SEVERITY[label])


def _votes(items: list[dict]) -> dict:
    by_rater: dict[int, list[dict]] = {}
    for item in items:
        by_rater.setdefault(item['rater'], []).append(item)
    votes = {'아님': 0, '확인필요': 0, '맞음': 0}
    for group in by_rater.values():
        votes[_severe(group)] += 1
    return votes


def _decide(votes: dict, minimum: int):
    defect = votes['아님']
    hold = votes['확인필요']
    if defect >= minimum:
        return '아님', 'defect', defect >= 2, None
    if defect >= 1 or hold >= 1:
        return '확인필요', 'needs_verification', False, 'split_ensemble_verdict'
    return '맞음', 'verified_clean', False, None


def _unit_id(items: list[dict], index: int) -> str:
    keys = sorted({item['key'] for item in items if item['key']})
    if keys:
        return keys[0]
    return f'unit-{index + 1}'


def _quote_labels(decision: str) -> set[str]:
    if decision == 'defect':
        return {'아님'}
    if decision == 'needs_verification':
        return {'아님', '확인필요'}
    return {'맞음'}


def _longest_quote(items: list[dict], labels: set[str]) -> str:
    pool = [item['quote'] for item in items if item['label'] in labels and item['quote']]
    if not pool:
        pool = [item['quote'] for item in items if item['quote']]
    if not pool:
        return ''
    return max(pool, key=len)


def _first_text(items: list[dict], field: str) -> str:
    for item in items:
        if item[field]:
            return item[field]
    return ''


def _first_page(items: list[dict]):
    for item in items:
        if item['page'] is not None:
            return item['page']
    return None


def _rater_list(items: list[dict]) -> list[str]:
    ordered = []
    seen = set()
    for item in items:
        if item['raterId'] in seen:
            continue
        seen.add(item['raterId'])
        ordered.append(item['raterId'])
    return ordered


def _build_unit(items: list[dict], minimum: int, index: int) -> dict:
    votes = _votes(items)
    label, decision, corroborated, reason = _decide(votes, minimum)
    unit = {
        'id': _unit_id(items, index),
        'verdictLabel': label,
        'decision': decision,
        'corroborated': corroborated,
        'voteBreakdown': votes,
        'quote': _longest_quote(items, _quote_labels(decision)),
        'pageIndex': _first_page(items),
        'raterIds': _rater_list(items),
    }
    supplement = _first_text(items, 'supplement')
    family = _first_text(items, 'family')
    if supplement:
        unit['supplementName'] = supplement
    if family:
        unit['family'] = family
    if reason:
        unit['arbitrationReason'] = reason
    return unit


def _ratings_for(items: list[dict], rater_count: int, missing):
    by_rater: dict[int, list[dict]] = {}
    for item in items:
        by_rater.setdefault(item['rater'], []).append(item)
    ratings = []
    for index in range(rater_count):
        if index in by_rater:
            ratings.append(_severe(by_rater[index]))
        else:
            ratings.append(missing)
    return ratings


def _agreement(clusters: list[list[dict]], rater_count: int) -> dict:
    complete_units = []
    observed_units = []
    for index, items in enumerate(clusters):
        unit_id = _unit_id(items, index)
        complete_units.append({
            'unitId': unit_id,
            'ratings': _ratings_for(items, rater_count, '맞음'),
        })
        observed_units.append({
            'unitId': unit_id,
            'ratings': _ratings_for(items, rater_count, None),
        })
    return {
        'completeUnitAlpha': compute_krippendorff_alpha(complete_units),
        'observedPairAlpha': compute_krippendorff_alpha(observed_units),
    }


def _pdf_finding(unit: dict) -> dict:
    finding = {
        'id': unit['id'],
        'verdictLabel': unit['verdictLabel'],
        'decision': unit['decision'],
        'quote': unit['quote'],
        'family': unit.get('family') or 'D1',
    }
    if unit.get('pageIndex') is not None:
        finding['pageIndex'] = unit['pageIndex']
    if unit.get('supplementName'):
        finding['supplementName'] = unit['supplementName']
    return finding


def _csv_text(document: dict) -> str:
    rows = list(document.get('findings') or []) + list(document.get('resolvedOk') or [])
    paper_id = str(document.get('paperId') or 'ensemble')
    built = blue_report_validate.build_csv_rows(rows, paper_id, {})
    return blue_report_validate.render_csv(built['rows'])['text']


def _with_pdf(payload: dict, pdf_bytes, supplements, ledger) -> dict:
    if pdf_bytes is None:
        return payload
    report = {
        'schema': 'falsify.blue-report.v1',
        'findings': [_pdf_finding(item) for item in payload['findings']],
    }
    finalized = blue_report_validate.finalize_blue_report(
        pdf_bytes,
        report,
        supplements=supplements,
        ledger=ledger,
    )
    document = finalized['finalizedReport']
    payload['finalReport'] = document
    payload['csvText'] = _csv_text(document)
    payload['autoDowngradedCount'] = finalized.get('autoDowngradedCount', 0)
    return payload


def ensemble_blue_reports(
    reports: list[dict],
    *,
    rater_ids: list[str] | None = None,
    pdf_bytes: bytes | None = None,
    supplements: list[dict] | None = None,
    ledger_candidates: list[dict] | None = None,
    min_consensus: int | None = None,
) -> dict:
    """Merge K BLUE reports. Minority defects stay visible as 확인필요."""
    chosen = _require_reports(reports)
    raters = _rater_ids(chosen, rater_ids)
    minimum = _minimum(min_consensus, len(chosen))
    clusters = _sort_clusters(_cluster(_observations(chosen, raters)))
    payload = {
        'schema': SCHEMA,
        'ok': True,
        'answerKeyFree': True,
        'raterCount': len(chosen),
        'raterIds': raters,
        'minConsensus': minimum,
        'krippendorffAlpha': _agreement(clusters, len(chosen)),
        'findings': [
            _build_unit(items, minimum, index)
            for index, items in enumerate(clusters)
        ],
    }
    return _with_pdf(payload, pdf_bytes, supplements, ledger_candidates)

"""RED detectability simulator and cross-surface claim propagation trace.

Two read-only analyses that let a RED author reason about exposure *before*
exporting a blind PDF.

``simulate_red_detectability``
    Applies the proposed operations in memory only (the bound source bytes are
    never mutated) and asks the offline BLUE Layer 0 sensor what would fire on
    the edited copy. Pre-existing defects are removed by diffing the
    ``(family, kind, pageIndex, excerpt)`` signal keys of the source baseline
    against the output, so a source that already trips a detector never counts
    as a new detection.

    Each operation is then bucketed by *cross-inference distance*, a
    deterministic and documented rule:

    * ``L1`` -- exactly one static Layer 0 signal fires on the same surface and
      page as the operation (direct single-oracle comparison).
    * ``L2`` -- detection needs at least two signals, or the operation declares
      at least two defect families, or the single signal is table row/column
      arithmetic (a numeric recomputation across rows/columns).
    * ``L3`` -- the operation and the fired signal live on different surfaces
      (prose / table / figure / citation / supplement), or the operation edits a
      non-prose surface and no static signal fires at all, so detection needs
      cross-clause reasoning.
    * ``L4`` -- no Layer 0 detector exists for the family. ``D3`` and ``S1`` are
      *not* implemented in Layer 0 today and always land here. An operation that
      leaves every detector silent is also ``L4`` (``no_layer0_signal_fired``).

    Table-cell arithmetic is re-evaluated in memory on the post-edit cell value
    (the evidence store item cache is not re-extracted for an in-memory copy),
    so a sum drift is reported exactly as Layer 0 reports it after re-extraction.

    Visual operations (``chart-shape``, ``chart-redraw``, ``region``,
    ``region-replace``) also diff figure-forensic signals on a fresh in-memory
    evidence store of the edited PDF. Text and table edits skip that pass.

``trace_claim_propagation``
    Reports where a numeric or short textual claim appears across prose, table,
    figure, citation and supplement surfaces. Ids come from
    :func:`blue_evidence_refs.ref_id` whenever an offset/segment identity
    exists, so a repeated literal at two offsets keeps two stable ids.

Both functions are pure read-only: no file writes, no network, no subprocess,
and no export of the edited bytes.
"""
import copy
import hashlib
import math

from blue_evidence_refs import _occurrences, ref_id
from paper_blue_sensor import run_blue_sensor
from paper_evidence_text import list_references, read_page_text
from paper_stat_audit import _audit_table_item, _collect_artifact_index, _table_grid
from paper_supplement_audit import _extract_csv_metric_claims, _extract_metrics_from_text
from paper_text_span_mutator import normalize_supplements
from paper_uri_mutator import list_pdf_uri_links
from paper_red_mcp import (
    _apply_operations,
    _collect_all_items,
    _detect_baseline_overlaps,
    _text_overlaps,
)

DETECTABILITY_SCHEMA = 'falsify.red-detectability.v1'
CLAIM_SCHEMA = 'falsify.claim-propagation.v1'
MAX_SIGNALS = 100
MAX_OCCURRENCES = 40
MAX_QUERY_CHARS = 200
SURFACES = ('prose', 'table', 'figure', 'citation', 'supplement')
DISTANCES = ('L1', 'L2', 'L3', 'L4')
# Families with no Layer 0 detector at all. D3 (unsupported inference / overclaim)
# and S1 (supplement-only supply defect) are absent from paper_blue_sensor today.
NO_LAYER0_FAMILIES = frozenset({'D3', 'S1'})
_KIND_SURFACE = {
    'table-cell': 'table',
    'chart-shape': 'figure',
    'chart-redraw': 'figure',
    'region': 'figure',
    'region-replace': 'figure',
    'uri-link': 'citation',
    'supplement-edit': 'supplement',
    'text-span': 'prose',
}
_FAMILY_SURFACE = {'D2': 'citation', 'D4': 'supplement', 'D4-1': 'supplement'}
_TABLE_ARITHMETIC_KINDS = frozenset({'table_sum_mismatch', 'percentage_mismatch'})
_VISUAL_KINDS = frozenset({'chart-shape', 'chart-redraw', 'region', 'region-replace'})
_FIGURE_SIGNAL_KINDS = frozenset({
    'duplicate_figure_panel',
    'mirrored_figure_panel',
    'rotated_figure_panel',
    'cropped_figure_panel',
    'chart_printed_value_mismatch',
})


class _OutputStore:
    """Read-only store view whose source bytes are the in-memory edited PDF.

    Everything except :meth:`source_bytes` delegates to the real evidence store,
    so extracted items stay bound to the immutable source while page text, links
    and form widgets are re-read from the edited copy.
    """

    def __init__(self, store, pdf_bytes):
        self._store = store
        self._pdf = bytes(pdf_bytes)

    def status(self, paper_id):
        return self._store.status(paper_id)

    def source_bytes(self, paper_id, file_hash):
        return self._pdf

    def list_items(self, *args, **kwargs):
        return self._store.list_items(*args, **kwargs)

    def read_item(self, *args, **kwargs):
        return self._store.read_item(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._store, name)


def _default_store():
    from paper_evidence import default_store
    return default_store


def _default_service():
    from paper_chart_edit_service import default_service
    return default_service


def _bound_hash(store, paper_id, file_hash):
    if type(paper_id) is not str or not 1 <= len(paper_id) <= 160:
        raise ValueError('paper_evidence_id_invalid')
    try:
        bound = store.status(paper_id).get('fileHash')
    except KeyError:
        raise ValueError('paper_evidence_unknown_id') from None
    if not isinstance(bound, str) or not bound:
        raise ValueError('paper_evidence_summary_invalid')
    if file_hash is None:
        return bound
    if file_hash != bound:
        raise ValueError('paper_evidence_hash_mismatch')
    return bound


def _bounded_limit(value, cap, code):
    if isinstance(value, bool) or type(value) is not int or not 1 <= value <= cap:
        raise ValueError(code)
    return value


def _op_id(op, idx):
    op_id = op.get('id') if isinstance(op, dict) else None
    return op_id if isinstance(op_id, str) and op_id else f'red-op-{idx}'


def _changes_by_id(changes):
    return {
        change['id']: change
        for change in changes or []
        if isinstance(change, dict) and isinstance(change.get('id'), str) and change['id']
    }


def _signal_key(signal):
    return (
        signal.get('family'),
        signal.get('kind'),
        signal.get('pageIndex'),
        signal.get('excerpt'),
    )


def _merge_new_signals(baseline_report, output_signals):
    """Return numbered output signals whose keys are absent from the baseline."""
    baseline_keys = {
        _signal_key(signal) for signal in (baseline_report or {}).get('signals') or []
    }
    fresh, seen = [], set()
    for signal in output_signals or []:
        key = _signal_key(signal)
        if key in baseline_keys or key in seen:
            continue
        seen.add(key)
        fresh.append(signal)
    fresh.sort(key=_sort_key)
    return [{**signal, 'id': f'rdet-{index + 1}'} for index, signal in enumerate(fresh)]


def _sort_key(signal):
    page = signal.get('pageIndex')
    return (
        page if type(page) is int else -1,
        str(signal.get('family')),
        str(signal.get('kind')),
        str(signal.get('excerpt')),
    )


def _op_surface(kind):
    return _KIND_SURFACE.get(str(kind or ''), 'prose')


def _signal_surface(signal):
    kind = str(signal.get('kind') or '')
    if kind in _FIGURE_SIGNAL_KINDS:
        return 'figure'
    if kind == 'cross_modal_number_mismatch':
        reported = signal.get('reported')
        target = reported.get('target') if isinstance(reported, dict) else None
        return 'table' if str(target or '').lower().startswith('table') else 'figure'
    if kind in _TABLE_ARITHMETIC_KINDS:
        return 'table'
    return _FAMILY_SURFACE.get(str(signal.get('family') or ''), 'prose')


def _declared_families(op, change):
    values = [op.get('family')]
    if isinstance(op.get('families'), list):
        values.extend(op['families'])
    values.extend([(change or {}).get('defectFamily'), (change or {}).get('family')])
    families = []
    for value in values:
        if isinstance(value, str) and value and value not in families:
            families.append(value)
    return families


def _distance_rule(op, change, signals):
    """Bucket one operation into L1..L4 with short machine-readable reasons."""
    blind = [f for f in _declared_families(op, change) if f in NO_LAYER0_FAMILIES]
    if blind:
        return 'L4', [f'no_layer0_detector_for_{family}' for family in blind]
    op_surface = _op_surface(op.get('kind'))
    surfaces = {_signal_surface(signal) for signal in signals}
    if len(signals) >= 2:
        return 'L2', ['multiple_layer0_signals']
    if len(_declared_families(op, change)) >= 2:
        return 'L2', ['mixed_defect_families']
    if surfaces and op_surface not in surfaces:
        return 'L3', ['cross_surface_reasoning_required']
    if not signals:
        if op_surface != 'prose':
            return 'L3', ['cross_surface_no_static_signal']
        return 'L4', ['no_layer0_signal_fired']
    kinds = {str(signal.get('kind') or '') for signal in signals}
    if kinds & _TABLE_ARITHMETIC_KINDS:
        return 'L2', ['numeric_recomputation_across_rows_columns']
    return 'L1', ['single_oracle_hit']


def _exposure(distance, signal_count):
    if distance == 'L1':
        return 'immediate'
    if distance == 'L2':
        return 'immediate' if signal_count >= 2 else 'cross-section'
    if distance == 'L3':
        return 'cross-section'
    return 'low'


def _patched_table_item(store, paper_id, item_id, op):
    """Return a deep copy of the table item with the operation's cell value applied."""
    if not isinstance(item_id, str) or not item_id:
        return None
    try:
        item = store.read_item(paper_id, item_id)
    except (KeyError, ValueError):
        return None
    if not isinstance(item, dict) or item.get('type') != 'table':
        return None
    patched = copy.deepcopy(item)
    table = patched.get('table')
    cells = table.get('cells') if isinstance(table, dict) else None
    touched = False
    for cell in cells or []:
        if not isinstance(cell, dict):
            continue
        if cell.get('row') == op.get('row') and cell.get('column') == op.get('column'):
            cell['text'] = op.get('after')
            touched = True
    return patched if touched else None


def _patched_table_signals(store, paper_id, operations, changes):
    """Re-evaluate Layer 0 D1 table arithmetic on the post-edit cell values."""
    by_id = _changes_by_id(changes)
    signals = []
    for idx, op in enumerate(operations):
        if not isinstance(op, dict) or op.get('kind') != 'table-cell':
            continue
        op_id = _op_id(op, idx)
        item_id = op.get('itemId') or by_id.get(op_id, {}).get('itemId')
        item = _patched_table_item(store, paper_id, item_id, op)
        if item is None:
            continue
        for signal in _audit_table_item(item, item.get('pageIndex', 0), item.get('id')):
            signals.append({
                'family': 'D1',
                'kind': signal.get('kind'),
                'pageIndex': signal.get('pageIndex'),
                'excerpt': signal.get('excerpt'),
                'detail': signal.get('detail'),
                'itemId': signal.get('itemId'),
                'reported': signal.get('reported'),
                'computed': signal.get('computed'),
            })
    return signals


def _output_signals(store, paper_id, source_bytes, output_bytes, operations, changes, limit):
    """Layer 0 signals that the edited copy would produce, without pre-existing noise."""
    if output_bytes == source_bytes:
        return []
    report = run_blue_sensor(
        paper_id,
        max_signals=limit,
        include_external_oracle=False,
        store=_OutputStore(store, output_bytes),
    )
    return list(report.get('signals') or []) + _patched_table_signals(store, paper_id, operations, changes)


def _matched_signals(overlap_signals):
    matched = [
        {
            'id': signal.get('id'),
            'family': signal.get('family'),
            'kind': signal.get('kind'),
            'pageIndex': signal.get('pageIndex'),
            'excerpt': signal.get('excerpt'),
        }
        for signal in overlap_signals or []
    ]
    return sorted(matched, key=lambda item: (
        item['pageIndex'] if type(item['pageIndex']) is int else -1,
        str(item['kind']),
        str(item['excerpt']),
    ))


def _signal_haystack(signal):
    parts = [str(signal.get('excerpt') or ''), str(signal.get('detail') or '')]
    for key in ('reported', 'computed'):
        value = signal.get(key)
        if isinstance(value, dict):
            parts.extend(str(item) for item in value.values())
    return ' '.join(' '.join(parts).split()).lower()


def _op_values(op):
    return [
        value for value in (op.get('before'), op.get('beforeUri'))
        if isinstance(value, str) and value.strip()
    ]


def _page_of(op, change):
    if type(op.get('pageIndex')) is int:
        return op.get('pageIndex')
    return change.get('pageIndex')


def _same_page(op, change, signal):
    op_page = _page_of(op, change)
    sig_page = signal.get('pageIndex')
    if type(op_page) is int and type(sig_page) is int and op_page != sig_page:
        return False
    return True


def _owns_figure_signal(op, change, signal):
    if op.get('kind') not in _VISUAL_KINDS:
        return False
    if str(signal.get('kind') or '') not in _FIGURE_SIGNAL_KINDS:
        return False
    return _same_page(op, change, signal)


def _op_owns_signal(op, change, signal):
    """Fallback ownership test when the shared matcher cannot attribute a signal."""
    if _owns_figure_signal(op, change, signal):
        return True
    if op.get('kind') == 'supplement-edit':
        return False
    op_page = op.get('pageIndex') if type(op.get('pageIndex')) is int else change.get('pageIndex')
    sig_page = signal.get('pageIndex')
    if type(op_page) is int and type(sig_page) is int and op_page != sig_page:
        return False
    item_id = op.get('itemId') or change.get('itemId')
    if isinstance(item_id, str) and item_id and signal.get('itemId') == item_id:
        return True
    haystack = _signal_haystack(signal)
    return any(_text_overlaps(value, haystack) for value in _op_values(op))


def _attribute_signals(operations, changes, signals):
    """Attribute new signals to operations, reusing the shared overlap matcher first."""
    primary = _detect_baseline_overlaps(operations, changes, {'signals': signals})
    attributed = {entry['operationId']: list(entry.get('signals') or []) for entry in primary}
    claimed = {signal.get('id') for signals_ in attributed.values() for signal in signals_}
    unclaimed = [signal for signal in signals if signal.get('id') not in claimed]
    by_id = _changes_by_id(changes)
    for idx, op in enumerate(operations):
        if not unclaimed or not isinstance(op, dict):
            continue
        op_id = _op_id(op, idx)
        change = by_id.get(op_id) or {}
        owned = [signal for signal in unclaimed if _op_owns_signal(op, change, signal)]
        if not owned:
            continue
        attributed.setdefault(op_id, []).extend(owned)
        taken = {signal.get('id') for signal in owned}
        unclaimed = [signal for signal in unclaimed if signal.get('id') not in taken]
    return attributed



def _baseline_overlap(overlap):
    if not overlap:
        return None
    return {
        'signalIds': list(overlap.get('signalIds') or []),
        'signals': _matched_signals(overlap.get('signals')),
    }


def _operation_result(idx, op, context):
    by_id = context['changes']
    op_id = _op_id(op, idx)
    change = by_id.get(op_id) or {}
    attributed = context['attributed'].get(op_id) or []
    matched = _matched_signals(attributed)
    distance, reasons = _distance_rule(op, change, attributed)
    families = _declared_families(op, change)
    declared = op.get('difficulty')
    result = {
        'operationId': op_id,
        'kind': op.get('kind'),
        'family': families[0] if families else None,
        'difficulty': declared if declared in DISTANCES else distance,
        'detectedByLayer0': bool(matched),
        'matchedSignals': matched,
        'crossInferenceDistance': distance,
        'exposureRisk': _exposure(distance, len(matched)),
        'reasons': reasons,
    }
    overlap = _baseline_overlap(context['overlaps'].get(op_id))
    if overlap is not None:
        result['baselineOverlap'] = overlap
    return result


def _distance_counts(results):
    counts = {distance: 0 for distance in DISTANCES}
    for result in results:
        counts[result['crossInferenceDistance']] += 1
    return counts


def _ops_need_figure_diff(operations):
    for op in operations or []:
        if isinstance(op, dict) and op.get('kind') in _VISUAL_KINDS:
            return True
    return False


def _figure_report_signals(paper_id, file_hash, bound):
    from paper_figure_forensics import audit_figure_forensics
    try:
        report = audit_figure_forensics(paper_id, file_hash=file_hash, store=bound, max_signals=30)
    except (ValueError, KeyError, TypeError):
        return []
    fresh = []
    for signal in report.get('signals') or []:
        if signal.get('kind') in _FIGURE_SIGNAL_KINDS:
            fresh.append(signal)
    return fresh


def _store_for_edited_pdf(pdf_bytes):
    from paper_evidence import EvidenceStore
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    edited = EvidenceStore()
    summary = edited.prepare(pdf_bytes, digest)
    return edited, summary['paperId'], summary['fileHash']


def _figure_delta(store, paper_id, file_hash, output_bytes):
    baseline = _figure_report_signals(paper_id, file_hash, store)
    try:
        edited_store, edited_id, edited_hash = _store_for_edited_pdf(output_bytes)
    except (ValueError, KeyError, TypeError):
        return []
    edited = _figure_report_signals(edited_id, edited_hash, edited_store)
    return _merge_new_signals({'signals': baseline}, edited)


def _with_figure_delta(store, paper_id, file_hash, source_bytes, output_bytes, ops, sensor_fresh):
    if output_bytes == source_bytes or not _ops_need_figure_diff(ops):
        return sensor_fresh
    figure_fresh = _figure_delta(store, paper_id, file_hash, output_bytes)
    if not figure_fresh:
        return sensor_fresh
    combined = list(sensor_fresh) + list(figure_fresh)
    return _merge_new_signals({'signals': []}, combined)


def simulate_red_detectability(
    paper_id,
    operations,
    *,
    file_hash=None,
    store=None,
    supplements=None,
    max_signals=MAX_SIGNALS,
    service=None,
):
    """Simulate which Layer 0 detectors would fire on the proposed RED operations.

    ``service`` optionally supplies the chart scene service that already holds the
    caller's prepared scenes; it defaults to the shared chart-edit singleton.
    """
    store = _default_store() if store is None else store
    file_hash = _bound_hash(store, paper_id, file_hash)
    limit = _bounded_limit(max_signals, MAX_SIGNALS, 'limit')
    if not isinstance(operations, list):
        raise ValueError('visual_operation_invalid')
    ops = operations
    normalized_supplements = normalize_supplements(supplements) if supplements else []
    _source, output_bytes, vis_result, _blind = _apply_operations(
        store,
        service or _default_service(),
        paper_id,
        file_hash,
        ops,
        supplements=normalized_supplements or None,
    )
    changes = vis_result.get('changes') or []
    baseline = run_blue_sensor(
        paper_id, file_hash=file_hash, max_signals=limit,
        include_external_oracle=False, store=store,
    )
    sensor_fresh = _merge_new_signals(
        baseline,
        _output_signals(store, paper_id, _source, output_bytes, ops, changes, limit),
    )
    fresh = _with_figure_delta(
        store, paper_id, file_hash, _source, output_bytes, ops, sensor_fresh,
    )
    context = {
        'changes': _changes_by_id(changes),
        'attributed': _attribute_signals(ops, changes, fresh),
        'overlaps': {
            overlap['operationId']: overlap
            for overlap in _detect_baseline_overlaps(ops, changes, baseline)
        },
    }
    results = [_operation_result(idx, op, context) for idx, op in enumerate(ops)]
    return {
        'schema': DETECTABILITY_SCHEMA,
        'paperId': paper_id,
        'fileHash': file_hash,
        'operationCount': len(results),
        'immediateDetectionCount': sum(1 for r in results if r['detectedByLayer0']),
        'distanceCounts': _distance_counts(results),
        'results': results,
        'notes': [
            'pre_existing_defects_excluded_by_baseline_diff',
            'table_cell_arithmetic_reevaluated_in_memory',
            'D3_and_S1_have_no_layer0_detector',
            'read_only_no_export',
        ],
    }


def _numeric_target(needle):
    try:
        value = float(needle.replace(',', ''))
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    decimals = len(needle.split('.', 1)[1]) if '.' in needle else 0
    return (value, min(decimals, 6))


def _rounds_to(candidate, target):
    value, decimals = target
    return abs(float(candidate) - value) <= 0.5 * (10.0 ** -decimals) + 1e-12


def _parse_query(query):
    if not isinstance(query, str):
        raise ValueError('query_invalid')
    needle = ' '.join(query.split())
    if not 1 <= len(needle) <= MAX_QUERY_CHARS:
        raise ValueError('query_invalid')
    return needle, _numeric_target(needle)


def _excerpt(text, start, length, radius=60):
    lo = max(0, start - radius)
    hi = min(len(text), start + length + radius)
    prefix = '...' if lo > 0 else ''
    suffix = '...' if hi < len(text) else ''
    return prefix + text[lo:hi].strip() + suffix


def _bbox(value):
    if isinstance(value, list) and len(value) == 4:
        return [float(v) for v in value]
    return None


def _block_occurrences(page_index, block_index, block, needle):
    text = ' '.join(str(block.get('text') or '').split())
    lowered = text.lower()
    if needle not in lowered:
        return []
    segment = f'p{page_index}-b{block_index}'
    hits = _occurrences(lowered, needle)
    return [
        {
            'surface': 'prose',
            'pageIndex': page_index,
            'bbox': _bbox(block.get('bbox')),
            'refId': ref_id(segment, start, start + len(needle), text[start:start + len(needle)]),
            'excerpt': _excerpt(text, start, len(needle)),
        }
        for start in hits
    ]


def _prose_occurrences(store, paper_id, needle):
    page_count = store.status(paper_id).get('pageCount', 0)
    found = []
    for page_index in range(page_count if type(page_count) is int else 0):
        page = read_page_text(paper_id, page_index, store=store)
        for block_index, block in enumerate(page.get('blocks') or []):
            found.extend(_block_occurrences(page_index, block_index, block, needle))
    return found


def _full_items(store, paper_id):
    items = []
    for meta in _collect_all_items(store, paper_id):
        try:
            items.append(store.read_item(paper_id, meta['id']))
        except (KeyError, ValueError):
            continue
    return items


def _artifact_values(entry, kind, item):
    values = [value for value, _dec in entry.get('pcts') or []]
    values.extend(value for value, _dec in entry.get('pvals') or [])
    values.extend(entry.get('pts') or [])
    values.extend(estimate for estimate, _lo, _hi in entry.get('cis') or [])
    if kind == 'table':
        values.extend(_plain_cell_numbers(item))
    return [value for value in values if type(value) in (int, float)]


def _plain_cell_numbers(item):
    """Printed table cell numbers, so a plain integer claim is traceable to its cell."""
    grid, _rows, _columns, _header_rows = _table_grid(item)
    numbers = []
    for text in grid.values():
        cleaned = text.strip().replace(',', '')
        try:
            numbers.append(float(cleaned))
        except ValueError:
            continue
    return numbers


def _artifact_text(kind, item):
    parts = [str(item.get('caption') or '')]
    if kind == 'table':
        table = item.get('table')
        cells = table.get('cells') if isinstance(table, dict) else None
        parts.extend(str(cell.get('text') or '') for cell in cells or [] if isinstance(cell, dict))
    else:
        for source in (item, item.get('chart') if isinstance(item.get('chart'), dict) else {}):
            for printed in source.get('printedValues') or []:
                if isinstance(printed, dict):
                    parts.append(str(printed.get('rawText') or printed.get('value') or ''))
    return ' '.join(' '.join(parts).split())


def _artifact_occurrence(kind, label, item, entry, needle, numeric):
    if numeric is not None:
        if not any(_rounds_to(value, numeric) for value in _artifact_values(entry, kind, item)):
            return None
        excerpt = f'{kind.title()} {label} printed value {needle}'
    else:
        haystack = _artifact_text(kind, item).lower()
        if needle not in haystack:
            return None
        excerpt = _excerpt(_artifact_text(kind, item), haystack.find(needle), len(needle))
    return {
        'surface': 'table' if kind == 'table' else 'figure',
        'pageIndex': item.get('pageIndex', 0),
        'bbox': _bbox(item.get('bbox')),
        'itemId': item.get('id'),
        'refId': ref_id(f'{kind}-{label}', 0, len(needle), needle),
        'excerpt': excerpt,
    }


def _artifact_occurrences(store, paper_id, needle, numeric):
    items = _full_items(store, paper_id)
    index = _collect_artifact_index(items)
    by_id = {item.get('id'): item for item in items}
    found = []
    for (kind, label), entry in index.items():
        item = by_id.get(entry.get('itemId')) or {}
        occurrence = _artifact_occurrence(kind, label, item, entry, needle, numeric)
        if occurrence is not None:
            found.append(occurrence)
    return found


def _citation_occurrences(store, paper_id, file_hash, needle):
    found = []
    references = list_references(paper_id, 0, 100, store=store).get('references') or []
    for entry in references:
        raw = ' '.join(str(entry.get('rawText') or '').split())
        start = raw.lower().find(needle)
        if start < 0:
            continue
        found.append({
            'surface': 'citation',
            'pageIndex': entry.get('pageIndex', 0),
            'refId': ref_id(
                f"ref-{entry.get('index')}", start, start + len(needle), raw[start:start + len(needle)],
            ),
            'excerpt': _excerpt(raw, start, len(needle)),
        })
    source = store.source_bytes(paper_id, file_hash)
    for link in list_pdf_uri_links(source).get('links') or []:
        uri = str(link.get('uri') or '')
        if needle not in uri.lower():
            continue
        found.append({
            'surface': 'citation',
            'pageIndex': link.get('pageIndex', 0),
            'bbox': _bbox(link.get('bbox')),
            'refId': ref_id(f"link-{link.get('linkId')}", 0, len(needle), needle),
            'excerpt': uri[:160],
        })
    return found


def _claim_matches(claim, needle, numeric):
    if numeric is not None:
        value = claim.get('value')
        if type(value) not in (int, float):
            return False
        return _rounds_to(value, numeric)
    return needle in str(claim.get('excerpt') or '').lower()


def _supplement_claims(supplement):
    """Claim records for one supplement: prose ``metric = value`` plus CSV cells."""
    meta = {
        'segmentId': supplement['supplementId'],
        'pageIndex': 0,
        'suppKind': supplement['kind'],
        'fileName': supplement['name'],
        'anchorKey': None,
    }
    claims = list(_extract_metrics_from_text(supplement['text'], meta))
    claims.extend(_extract_csv_metric_claims(
        {'kind': supplement['kind'], 'name': supplement['name'], 'segments': [{'text': supplement['text']}]},
        None,
    ))
    return claims


def _supplement_occurrences(supplements, needle, numeric):
    found = []
    for supplement in normalize_supplements(supplements or []):
        for claim in _supplement_claims(supplement):
            if not _claim_matches(claim, needle, numeric):
                continue
            excerpt = str(claim.get('excerpt') or '')
            start = max(0, excerpt.lower().find(needle))
            found.append({
                'surface': 'supplement',
                'pageIndex': claim.get('pageIndex', 0),
                'supplementName': supplement['name'],
                'refId': ref_id(
                    f"supp-{supplement['supplementId']}", start, start + len(needle),
                    excerpt[start:start + len(needle)],
                ),
                'excerpt': _excerpt(excerpt, start, len(needle)),
            })
    return found


def _dedupe_occurrences(occurrences):
    seen, unique = set(), []
    for occurrence in occurrences:
        key = (occurrence['surface'], occurrence.get('pageIndex'), occurrence.get('excerpt'))
        if key in seen:
            continue
        seen.add(key)
        unique.append(occurrence)
    return unique


def _surface_counts(occurrences):
    counts = {surface: 0 for surface in SURFACES}
    for occurrence in occurrences:
        surface = occurrence['surface']
        counts[surface] = counts.get(surface, 0) + 1
    return counts


def trace_claim_propagation(
    paper_id,
    query,
    *,
    file_hash=None,
    store=None,
    supplements=None,
    max_occurrences=MAX_OCCURRENCES,
):
    """Trace one numeric or short textual claim across every paper surface."""
    store = _default_store() if store is None else store
    file_hash = _bound_hash(store, paper_id, file_hash)
    cap = _bounded_limit(max_occurrences, MAX_OCCURRENCES, 'limit')
    needle, numeric = _parse_query(query)
    lowered = needle.lower()
    occurrences = []
    occurrences.extend(_prose_occurrences(store, paper_id, lowered))
    occurrences.extend(_artifact_occurrences(store, paper_id, lowered, numeric))
    occurrences.extend(_citation_occurrences(store, paper_id, file_hash, lowered))
    occurrences.extend(_supplement_occurrences(supplements, lowered, numeric))
    unique = _dedupe_occurrences(occurrences)
    return {
        'schema': CLAIM_SCHEMA,
        'paperId': paper_id,
        'fileHash': file_hash,
        'query': needle,
        'occurrenceCount': len(unique),
        'truncated': len(unique) > cap,
        'surfaces': _surface_counts(unique),
        'occurrences': unique[:cap],
    }

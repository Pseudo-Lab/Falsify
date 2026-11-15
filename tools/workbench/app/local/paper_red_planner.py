"""Read-only planner for coordinated multi-surface RED mutation bundles.

Discovers numeric and directional claims across prose, tables, citations and
supplements, then keeps only bundles whose in-memory detectability simulation
meets the requested L1..L4 tier. Nothing is written to disk.
"""
import re

from paper_blue_sensor import run_blue_sensor
from paper_red_detectability import simulate_red_detectability, trace_claim_propagation
from paper_red_mcp import _list_targets
from paper_text_span_mutator import list_pdf_text_spans, normalize_supplements
from paper_uri_mutator import list_pdf_uri_links

SCHEMA = 'falsify.red-mutation-plan.v1'
DISTANCES = ('L1', 'L2', 'L3', 'L4')
HINT_TOKENS = (
    'intentional', 'fabricated', 'fake-doi', 'red-team', 'injected', 'falsify-red',
    'red-plan', 'answer-key', 'answer_key', 'tampered', 'falsify', '변조', '가짜', '함정', '정답',
)
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
_SURFACE_ORDER = ('prose', 'table', 'figure', 'citation', 'supplement')
_RATIONALE = 'Shifts a reported value on the selected surface.'
_SWAPS = (
    ('suggests', 'confirms', 'D3', 'W2'),
    ('shows', 'proves', 'D3', 'W2'),
    ('increased', 'decreased', 'D3', 'W2'),
    ('decreased', 'increased', 'D3', 'W2'),
    ('higher', 'lower', 'D3', 'W2'),
    ('lower', 'higher', 'D3', 'W2'),
    ('lacks', 'shows', 'S1', 'W3'),
    ('associated with', 'causally reduces', 'D3', 'W2'),
    ('prove', 'shows', 'D3', 'W2'),
    ('prevents', 'suggests', 'D3', 'W2'),
    ('causes', 'tracks', 'D3', 'W2'),
    ('always', 'rarely', 'D3', 'W2'),
    ('confirms', 'suggests', 'D3', 'W2'),
)
_DECIMAL_RE = re.compile(r'\b\d+\.\d+\b')
_N_RE = re.compile(r'\bN\s*=\s*(\d+)\b', re.I)
_P_RE = re.compile(r'\bp\s*=\s*(\d+\.\d+)\b', re.I)
_PCT_RE = re.compile(r'(\d+)\s*/\s*(\d+)\s*\(\s*(\d+(?:\.\d+)?)%\s*\)')
_TOTAL_RE = re.compile(r'^\s*(?:total|sum)\b', re.I)
_MAX_TRACES = 6
_MAX_CANDIDATES = 8


def distance_rank(label):
    """Return 0..3 for L1..L4. Unknown labels sort below every real tier."""
    try:
        return DISTANCES.index(label)
    except ValueError:
        return -1


def _require_difficulty(value):
    if value not in DISTANCES:
        raise ValueError('target_difficulty_invalid')
    return value


def _require_limit(value):
    if isinstance(value, bool) or type(value) is not int or not 1 <= value <= 20:
        raise ValueError('limit')
    return value


def _default_store():
    from paper_evidence import default_store
    return default_store


def _contains_hint(text):
    lowered = str(text or '').lower()
    for token in HINT_TOKENS:
        if token.lower() in lowered:
            return True
    return False


def _exact_phrase(text, phrase):
    match = re.search(r'(?<!\w)' + re.escape(phrase) + r'(?!\w)', text or '', re.I)
    if match is None:
        return None
    return text[match.start():match.end()]


def _nudge_digits(token):
    chars = list(token)
    for index in range(len(chars) - 1, -1, -1):
        if not chars[index].isdigit():
            continue
        chars[index] = '1' if chars[index] != '1' else '2'
        return ''.join(chars)
    return None


def _far_pvalue(number):
    if not re.fullmatch(r'\d+\.\d+', number or ''):
        return None
    whole, frac = number.split('.')
    flipped = ''.join('1' if char == '9' else '9' for char in frac)
    updated = whole + '.' + flipped
    if updated == number:
        return None
    return updated


def _mismatch_percent(number):
    if not re.fullmatch(r'\d+', number or ''):
        return _nudge_digits(number)
    if number[0] == '8':
        return '1' + number[1:]
    return '8' + number[1:]


def _surfaces(ops):
    present = {_KIND_SURFACE.get(op.get('kind'), 'prose') for op in ops}
    return [name for name in _SURFACE_ORDER if name in present]


def _op_blob(op):
    parts = []
    for key in ('before', 'after', 'beforeUri', 'afterUri', 'rationale'):
        value = op.get(key)
        if isinstance(value, str):
            parts.append(value)
    return '\n'.join(parts)


def _clean_ops(ops):
    if any(_contains_hint(_op_blob(op)) for op in ops):
        return None
    return ops


def _blocked(signals):
    items, uris, excerpts = set(), set(), []
    for signal in signals or []:
        item_id = signal.get('itemId')
        if isinstance(item_id, str) and item_id:
            items.add(item_id)
        _collect_uris(signal, uris)
        excerpt = signal.get('excerpt')
        if isinstance(excerpt, str) and len(excerpt) >= 12:
            excerpts.append(excerpt.lower())
    return {'items': items, 'uris': uris, 'excerpts': excerpts}


def _collect_uris(signal, uris):
    for pocket in (signal.get('computed'), signal.get('reported')):
        if not isinstance(pocket, dict):
            continue
        uri = pocket.get('uri')
        if isinstance(uri, str) and uri:
            uris.add(uri)


def _text_blocked(text, blocked):
    lowered = str(text or '').lower()
    if not lowered:
        return False
    for excerpt in blocked['excerpts']:
        if excerpt in lowered or lowered in excerpt:
            return True
    return False


def _discover(store, paper_id, file_hash, supplements):
    raw = store.source_bytes(paper_id, file_hash)
    spans = list_pdf_text_spans(raw, limit=200).get('spans') or []
    targets = _list_targets(store, paper_id, file_hash)
    links = list_pdf_uri_links(raw).get('links') or []
    return {
        'spans': spans,
        'tables': targets.get('tables') or [],
        'links': links,
        'supplements': supplements,
    }


def _add_unique(found, token):
    if token and token not in found and not _contains_hint(token):
        found.append(token)
    return found


def _decimal_tokens(text):
    found = []
    for match in _DECIMAL_RE.finditer(text or ''):
        token = match.group(0)
        if _inside_pvalue(text, match.start()) or _percent_suffix(text, match.end()):
            continue
        _add_unique(found, token)
    return found


def _inside_pvalue(text, start):
    window = text[max(0, start - 8):start].lower()
    return 'p =' in window or 'p=' in window


def _percent_suffix(text, end):
    return end < len(text) and text[end:end + 1] == '%'


def _query_tokens(discovered):
    found = []
    texts = [span.get('text') or '' for span in discovered['spans']]
    texts.extend(rec.get('text') or '' for rec in discovered['supplements'])
    for text in texts:
        for token in _decimal_tokens(text):
            _add_unique(found, token)
        for match in _N_RE.finditer(text):
            _add_unique(found, match.group(1))
        for before, _after, _family, _world in _SWAPS:
            if _exact_phrase(text, before):
                _add_unique(found, before)
        if len(found) >= _MAX_TRACES:
            break
    return found[:_MAX_TRACES]


def _trace_one(paper_id, file_hash, store, supplements, query):
    try:
        return trace_claim_propagation(
            paper_id, query, file_hash=file_hash, store=store, supplements=supplements or None,
        )
    except ValueError:
        return None


def _trace_all(paper_id, file_hash, store, supplements, queries, strict):
    traces = []
    for query in queries:
        if strict:
            traces.append(trace_claim_propagation(
                paper_id, query, file_hash=file_hash, store=store, supplements=supplements or None,
            ))
            continue
        traced = _trace_one(paper_id, file_hash, store, supplements, query)
        if traced is not None:
            traces.append(traced)
    return traces


def _multi_surface_queries(traces):
    found = []
    for trace in traces:
        surfaces = trace.get('surfaces') or {}
        hits = [name for name, count in surfaces.items() if count]
        if len(hits) >= 2:
            _add_unique(found, trace.get('query'))
    return found


def _stamp(kind, suffix, family, world, difficulty):
    return {
        'id': f'plan-{kind}-{suffix}',
        'kind': kind,
        'world': world,
        'family': family,
        'difficulty': difficulty,
        'rationale': _RATIONALE,
    }


def _text_op(span, before, after, family, world, difficulty, suffix):
    op = _stamp('text', suffix, family, world, difficulty)
    op.update({
        'kind': 'text-span',
        'pageIndex': span.get('pageIndex'),
        'before': before,
        'after': after,
        'occurrence': 0,
    })
    return op


def _table_op(table, cell, before, after, suffix):
    op = _stamp('cell', suffix, 'D1', 'W1', 'L2')
    op.update({
        'kind': 'table-cell',
        'itemId': table.get('itemId'),
        'row': cell.get('row'),
        'column': cell.get('column'),
        'before': before,
        'after': after,
    })
    return op


def _supp_op(rec, before, after, suffix):
    op = _stamp('supp', suffix, 'D1', 'W4', 'L3')
    op.update({
        'kind': 'supplement-edit',
        'supplementId': rec.get('supplementId'),
        'name': rec.get('name'),
        'before': before,
        'after': after,
        'occurrence': 0,
    })
    return op


def _uri_op(link, after, suffix):
    op = _stamp('uri', suffix, 'D2', 'W5', 'L1')
    op.update({
        'kind': 'uri-link',
        'linkId': link.get('linkId'),
        'pageIndex': link.get('pageIndex'),
        'annotIndex': link.get('annotIndex'),
        'beforeUri': link.get('uri'),
        'afterUri': after,
    })
    return op


def _alt_uri(uri):
    if not isinstance(uri, str) or 'doi.org' not in uri.lower():
        return None
    if uri.rstrip('/').endswith('other-study'):
        return 'https://doi.org/10.1000/alt-study'
    return 'https://doi.org/10.1000/other-study'


def _phrase_for(text, token):
    index = text.find(token)
    if index < 0:
        return None
    head = text[:index].rstrip()
    space = head.rfind(' ')
    start = 0 if space < 0 else space + 1
    if space > 0:
        earlier = head.rfind(' ', 0, space)
        start = 0 if earlier < 0 else earlier + 1
    return text[start:index + len(token)]


def _span_for_token(spans, token, blocked):
    for span in spans:
        text = span.get('text') or ''
        if token not in text or _text_blocked(text, blocked):
            continue
        phrase = _phrase_for(text, token)
        if phrase and not _contains_hint(phrase):
            return span, phrase
    return None, None


def _total_rows(table):
    rows = set()
    for cell in table.get('cells') or []:
        if cell.get('column') != 0:
            continue
        if _TOTAL_RE.match(str(cell.get('text') or '').strip()):
            rows.add(cell.get('row'))
    return rows


def _has_total(table):
    return bool(_total_rows(table))


def _cell_has_token(cell, token):
    text = str(cell.get('text') or '')
    stripped = text.strip()
    if stripped == token:
        return text
    return None


def _safe_cell(tables, token, blocked):
    for table in tables:
        if table.get('itemId') in blocked['items'] or _has_total(table):
            continue
        skip = _total_rows(table)
        for cell in table.get('cells') or []:
            if cell.get('row') in (None, 0) or cell.get('row') in skip or cell.get('column') in (None, 0):
                continue
            before = _cell_has_token(cell, token)
            if before is not None:
                return table, cell, before
    return None, None, None


def _body_integer(table, blocked):
    if table.get('itemId') in blocked['items'] or not _has_total(table):
        return None
    skip = _total_rows(table)
    for cell in table.get('cells') or []:
        if cell.get('row') in (None, 0) or cell.get('row') in skip or cell.get('column') in (None, 0):
            continue
        text = str(cell.get('text') or '')
        if text.strip().isdigit():
            return cell, text
    return None


def _break_integer(text):
    stripped = text.strip()
    if not stripped.isdigit():
        return None
    if set(stripped) == {'9'}:
        filled = '1' if stripped != '1' else '2'
        nudged = filled * len(stripped)
    else:
        nudged = '9' * len(stripped)
    if text == stripped:
        return nudged
    return text.replace(stripped, nudged, 1)


def _line_edit(text, token, nudged):
    lines = [line for line in str(text or '').splitlines() if token in line]
    if not lines:
        return None, None
    before = lines[0]
    after = before.replace(token, nudged, 1)
    if before == after or _contains_hint(after):
        return None, None
    return before, after


def _supplement_for(supplements, token):
    ranked = sorted(
        supplements,
        key=lambda rec: (0 if str(rec.get('text') or '').count(token) >= 2 else 1, rec.get('name') or ''),
    )
    for rec in ranked:
        if token in str(rec.get('text') or ''):
            return rec
    return None


def _l4_bundles(spans, blocked, ids):
    bundles, seen = [], set()
    for span in spans:
        page = span.get('pageIndex')
        text = span.get('text') or ''
        if page in seen or _text_blocked(text, blocked):
            continue
        for before, after, family, world in _SWAPS:
            exact = _exact_phrase(text, before)
            if exact is None:
                continue
            bundles.append([_text_op(span, exact, after, family, world, 'L4', ids['n'])])
            ids['n'] += 1
            seen.add(page)
            break
        if len(bundles) >= 3:
            break
    return bundles


def _l1_uri_bundles(links, blocked, ids):
    bundles = []
    for link in links:
        uri = link.get('uri')
        if uri in blocked['uris']:
            continue
        after = _alt_uri(uri)
        if after is None or after == uri:
            continue
        bundles.append([_uri_op(link, after, ids['n'])])
        ids['n'] += 1
        if len(bundles) >= 2:
            break
    return bundles


def _replace_span_token(span, token, updated, family, world, difficulty, suffix):
    text = span.get('text') or ''
    phrase = _phrase_for(text, token) or token
    if phrase not in text:
        return None
    after = phrase.replace(token, updated, 1)
    if after == phrase or _contains_hint(after):
        return None
    return _text_op(span, phrase, after, family, world, difficulty, suffix)


def _l1_stat_bundles(spans, blocked, ids):
    bundles = []
    for span in spans:
        text = span.get('text') or ''
        if _text_blocked(text, blocked):
            continue
        match = _P_RE.search(text)
        if match is None:
            continue
        updated = _far_pvalue(match.group(1))
        if updated is None:
            continue
        op = _replace_span_token(span, match.group(1), updated, 'D1', 'W3', 'L1', ids['n'])
        if op is None:
            continue
        bundles.append([op])
        ids['n'] += 1
        if len(bundles) >= 1:
            break
    return bundles


def _l1_percent_bundles(spans, blocked, ids):
    bundles = []
    for span in spans:
        text = span.get('text') or ''
        if _text_blocked(text, blocked):
            continue
        match = _PCT_RE.search(text)
        if match is None:
            continue
        updated = _mismatch_percent(match.group(3))
        if not updated:
            continue
        phrase = match.group(0)
        after = phrase.replace(match.group(3) + '%', updated + '%', 1)
        if after == phrase:
            continue
        bundles.append([_text_op(span, phrase, after, 'D1', 'W3', 'L1', ids['n'])])
        ids['n'] += 1
        break
    return bundles


def _l2_table_bundles(tables, blocked, ids):
    bundles = []
    for table in tables:
        found = _body_integer(table, blocked)
        if found is None:
            continue
        cell, text = found
        after = _break_integer(text)
        if after is None or after == text:
            continue
        bundles.append([_table_op(table, cell, text, after, ids['n'])])
        ids['n'] += 1
        if len(bundles) >= 2:
            break
    return bundles


def _synced_text(span, phrase, token, nudged, suffix):
    after = phrase.replace(token, nudged, 1)
    if after == phrase:
        return None
    return _text_op(span, phrase, after, 'D1', 'W3', 'L3', suffix)


def _l3_bundle(span, phrase, cell_info, supp, token, nudged, ids):
    text_op = _synced_text(span, phrase, token, nudged, ids['n'])
    ids['n'] += 1
    if text_op is None:
        return None
    ops = [text_op]
    if cell_info[0] is not None:
        table, cell, before = cell_info
        ops.append(_table_op(table, cell, before, before.replace(token, nudged, 1), ids['n']))
        ids['n'] += 1
    if supp is not None:
        before, after = _line_edit(supp.get('text') or '', token, nudged)
        if before is not None:
            ops.append(_supp_op(supp, before, after, ids['n']))
            ids['n'] += 1
    if len(ops) < 2 or len(_surfaces(ops)) < 2:
        return None
    return ops[:3]


def _numeric_token(token):
    text = str(token or '')
    if _contains_hint(text):
        return False
    return '.' in text or text.isdigit()


def _l3_tokens(discovered, traces):
    traced = [token for token in _multi_surface_queries(traces) if _numeric_token(token)]
    if traced:
        return traced
    return _decimal_tokens(' '.join(span.get('text') or '' for span in discovered['spans']))


def _l3_bundles(discovered, traces, blocked, ids):
    tokens = _l3_tokens(discovered, traces)
    bundles = []
    for token in tokens:
        if '.' not in str(token) and not str(token).isdigit():
            continue
        nudged = _nudge_digits(str(token))
        if nudged is None:
            continue
        span, phrase = _span_for_token(discovered['spans'], str(token), blocked)
        if span is None:
            continue
        cell_info = _safe_cell(discovered['tables'], str(token), blocked)
        supp = _supplement_for(discovered['supplements'], str(token))
        bundle = _l3_bundle(span, phrase, cell_info, supp, str(token), nudged, ids)
        if bundle is not None:
            bundles.append(bundle)
        if len(bundles) >= 3:
            break
    return bundles


def _bundle_key(ops):
    rows = []
    for op in ops:
        rows.append((
            op.get('kind'), op.get('pageIndex'), op.get('before'), op.get('after'),
            op.get('itemId'), op.get('row'), op.get('column'), op.get('beforeUri'),
            op.get('supplementId'), op.get('name'),
        ))
    return tuple(rows)


def _extend_unique(found, bundles):
    for ops in bundles:
        cleaned = _clean_ops(ops)
        if cleaned is None:
            continue
        key = _bundle_key(cleaned)
        if key in found['seen']:
            continue
        found['seen'].add(key)
        found['ops'].append(cleaned)
    return found


def _candidate_groups(discovered, traces, blocked):
    ids = {'n': 1}
    return {
        'L3': _l3_bundles(discovered, traces, blocked, ids),
        'L4': _l4_bundles(discovered['spans'], blocked, ids),
        'L2': _l2_table_bundles(discovered['tables'], blocked, ids),
        'L1': (
            _l1_uri_bundles(discovered['links'], blocked, ids)
            + _l1_stat_bundles(discovered['spans'], blocked, ids)
            + _l1_percent_bundles(discovered['spans'], blocked, ids)
        ),
    }


def _ordered_candidates(groups, target, query):
    order = [target] + [tier for tier in DISTANCES if tier != target]
    found = {'seen': set(), 'ops': []}
    for tier in order:
        _extend_unique(found, groups.get(tier) or [])
    if query is None:
        return found['ops'][:_MAX_CANDIDATES]
    needle = ' '.join(query.split()).lower()
    related = []
    for ops in found['ops']:
        blob = '\n'.join(_op_blob(op) for op in ops).lower()
        if needle and needle in blob:
            related.append(ops)
    return related[:_MAX_CANDIDATES]


def _simulation_summary(sim, distances):
    return {
        'schema': sim.get('schema'),
        'operationCount': sim.get('operationCount'),
        'immediateDetectionCount': sim.get('immediateDetectionCount'),
        'distanceCounts': sim.get('distanceCounts'),
        'distances': list(distances),
    }


def _bundle_difficulty(distances):
    rank = min(distance_rank(distance) for distance in distances)
    if rank < 0:
        return None
    return DISTANCES[rank]


def _verify_one(paper_id, file_hash, store, supplements, service, ops):
    try:
        sim = simulate_red_detectability(
            paper_id, ops, file_hash=file_hash, store=store,
            supplements=supplements or None, service=service,
        )
    except ValueError:
        return None
    results = sim.get('results') or []
    if len(results) != len(ops):
        return None
    distances = []
    for row in results:
        distance = row.get('crossInferenceDistance')
        if row.get('baselineOverlap') or distance not in DISTANCES:
            return None
        distances.append(distance)
    effective = _bundle_difficulty(distances)
    if effective is None:
        return None
    return {
        'operations': ops,
        'surfaces': _surfaces(ops),
        'effectiveDifficulty': effective,
        'layer0Triggered': any(bool(row.get('detectedByLayer0')) for row in results),
        'simulationSummary': _simulation_summary(sim, distances),
    }


def _meets(row, target):
    return distance_rank(row['effectiveDifficulty']) >= distance_rank(target)


def _coordinated(row):
    return len(row['operations']) >= 2 and len(row['surfaces']) >= 2


def _verify_all(paper_id, file_hash, store, supplements, service, candidates):
    verified = []
    for ops in candidates:
        row = _verify_one(paper_id, file_hash, store, supplements, service, ops)
        if row is not None:
            verified.append(row)
    return verified


def _rank_key(row, target):
    met = 0 if _meets(row, target) else 1
    coordinated = 0 if target == 'L3' and _coordinated(row) else 1
    if target != 'L3':
        coordinated = 0
    silent = 0 if target in ('L3', 'L4') and not row['layer0Triggered'] else 1
    if target not in ('L3', 'L4'):
        silent = 0
    gap = abs(distance_rank(row['effectiveDifficulty']) - distance_rank(target))
    return (met, coordinated, silent, gap, -len(row['operations']))


def _pack(rows, target):
    packed = []
    for index, row in enumerate(rows):
        ops = row['operations']
        packed.append({
            'bundleId': f'plan-{index + 1}',
            'surfaces': row['surfaces'],
            'operationCount': len(ops),
            'effectiveDifficulty': row['effectiveDifficulty'],
            'layer0Triggered': row['layer0Triggered'],
            'targetMet': _meets(row, target),
            'operations': ops,
            'simulationSummary': row['simulationSummary'],
        })
    return packed


def _queries_for(discovered, claim_query):
    if claim_query is None:
        return _query_tokens(discovered)
    return [claim_query]


def plan_coordinated_mutations(
    paper_id,
    *,
    file_hash=None,
    store=None,
    supplements=None,
    service=None,
    target_difficulty='L3',
    max_bundles=5,
    claim_query=None,
):
    """Return detectability-verified coordinated mutation bundles for one bound PDF."""
    target = _require_difficulty(target_difficulty)
    limit = _require_limit(max_bundles)
    loaded = normalize_supplements(supplements)
    bound_store = _default_store() if store is None else store
    baseline = run_blue_sensor(
        paper_id, file_hash=file_hash, include_external_oracle=False, store=bound_store,
    )
    actual_hash = baseline['fileHash']
    discovered = _discover(bound_store, paper_id, actual_hash, loaded)
    queries = _queries_for(discovered, claim_query)
    traces = _trace_all(
        paper_id, actual_hash, bound_store, loaded, queries, claim_query is not None,
    )
    groups = _candidate_groups(discovered, traces, _blocked(baseline.get('signals')))
    candidates = _ordered_candidates(groups, target, claim_query)
    verified = _verify_all(paper_id, actual_hash, bound_store, loaded, service, candidates)
    ranked = sorted(verified, key=lambda row: _rank_key(row, target))[:limit]
    signal_count = baseline.get('signalCount', 0)
    return {
        'schema': SCHEMA,
        'paperId': baseline.get('paperId', paper_id),
        'fileHash': actual_hash,
        'targetDifficulty': target,
        'baselineSignalCount': signal_count,
        'baselineClean': signal_count == 0,
        'bundleCount': len(ranked),
        'bundles': _pack(ranked, target),
    }

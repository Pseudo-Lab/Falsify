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


def _plan_scene(op):
    plan = op.get('plan') if isinstance(op, dict) else None
    if isinstance(plan, dict):
        return plan.get('sceneId')
    return None


def _bundle_key(ops):
    rows = []
    for op in ops:
        rows.append((
            op.get('kind'), op.get('pageIndex'), op.get('before'), op.get('after'),
            op.get('itemId'), op.get('row'), op.get('column'), op.get('beforeUri'),
            op.get('supplementId'), op.get('name'), _plan_scene(op),
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


def _brief_names(brief, *keys):
    if not isinstance(brief, dict):
        return []
    found = []
    for key in keys:
        value = brief.get(key)
        if isinstance(value, str) and value:
            found.append(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item:
                    found.append(item)
    return found


def _brief_rank(row, brief):
    surfaces = set(_brief_names(brief, 'preferredSurfaces', 'targetSurfaces'))
    families = set(_brief_names(brief, 'targetFamilies'))
    worlds = set(_brief_names(brief, 'targetWorlds'))
    if not surfaces and not families and not worlds:
        return 0
    have = set(row.get('surfaces') or [])
    have_families, have_worlds = set(), set()
    for op in row.get('operations') or []:
        if not isinstance(op, dict):
            continue
        have_families.add(op.get('family'))
        have_worlds.add(op.get('world'))
    score = 0
    if surfaces and surfaces <= have:
        score += 2
    elif surfaces & have:
        score += 1
    if families & have_families:
        score += 1
    if worlds & have_worlds:
        score += 1
    return -score


def _rank_key(row, target, brief=None):
    met = 0 if _meets(row, target) else 1
    coordinated = 0 if target == 'L3' and _coordinated(row) else 1
    if target != 'L3':
        coordinated = 0
    silent = 0 if target in ('L3', 'L4') and not row['layer0Triggered'] else 1
    if target not in ('L3', 'L4'):
        silent = 0
    gap = abs(distance_rank(row['effectiveDifficulty']) - distance_rank(target))
    return (_brief_rank(row, brief), met, coordinated, silent, gap, -len(row['operations']))


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


_MIN_CHART_AREA = 2500.0
_MAX_CHART_PIXELS = 16_000_000.0
_MAX_CHART_REGIONS = 4
_CHART_PAD = 48.0
_CLUSTER_GAP = 36.0


def _charts_enabled(service):
    if service is not None:
        return True
    from paper_chart_edit_service import capability
    return bool(capability().get('available'))


def _fresh_chart_service(store):
    from paper_chart_edit_service import ChartEditService
    return ChartEditService(store=store)


def _as_box(value):
    if value is None:
        return None
    try:
        box = [float(value[0]), float(value[1]), float(value[2]), float(value[3])]
    except (TypeError, ValueError, IndexError):
        return None
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    return box


def _round_box(box):
    return [round(box[0], 3), round(box[1], 3), round(box[2], 3), round(box[3], 3)]


def _region_key(page_index, box):
    return (page_index, round(box[0], 1), round(box[1], 1), round(box[2], 1), round(box[3], 1))


def _box_area(box):
    return (box[2] - box[0]) * (box[3] - box[1])


def _clamp_box(box, rect):
    if box is None:
        return None
    clamped = [
        max(float(rect.x0), min(box[0], float(rect.x1))),
        max(float(rect.y0), min(box[1], float(rect.y1))),
        max(float(rect.x0), min(box[2], float(rect.x1))),
        max(float(rect.y0), min(box[3], float(rect.y1))),
    ]
    if clamped[2] <= clamped[0] or clamped[3] <= clamped[1]:
        return None
    area = _box_area(clamped)
    if area < _MIN_CHART_AREA or area > _MAX_CHART_PIXELS:
        return None
    return clamped


def _has_region(regions, key):
    for item in regions:
        if item['key'] == key:
            return True
    return False


def _push_region(regions, page_index, box, rect):
    if box is None or len(regions) >= _MAX_CHART_REGIONS:
        return
    rounded = _clamp_box(_round_box(box), rect)
    if rounded is None:
        return
    key = _region_key(page_index, rounded)
    if _has_region(regions, key):
        return
    regions.append({'pageIndex': page_index, 'bbox': _round_box(rounded), 'key': key})


def _filled_box(drawing):
    if not isinstance(drawing, dict) or drawing.get('fill') is None:
        return None
    box = _as_box(drawing.get('rect'))
    if box is None or _box_area(box) < 80:
        return None
    return box


def _page_draw_boxes(page):
    boxes = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return boxes
    for drawing in drawings or []:
        box = _filled_box(drawing)
        if box is not None:
            boxes.append(box)
    return boxes


def _overlaps(left, right):
    if left[2] < right[0] - _CLUSTER_GAP or right[2] < left[0] - _CLUSTER_GAP:
        return False
    if left[3] < right[1] - _CLUSTER_GAP or right[3] < left[1] - _CLUSTER_GAP:
        return False
    return True


def _union(left, right):
    return [
        min(left[0], right[0]), min(left[1], right[1]),
        max(left[2], right[2]), max(left[3], right[3]),
    ]


def _cluster_boxes(boxes):
    groups = []
    for box in boxes:
        groups.append(list(box))
    changed = True
    while changed and len(groups) > 1:
        changed = False
        current = groups[0]
        pending = []
        for other in groups[1:]:
            if _overlaps(current, other):
                current = _union(current, other)
                changed = True
            else:
                pending.append(other)
        pending.append(current)
        groups = pending
    return groups


def _page_figures(figures, page_index):
    found = []
    for figure in figures:
        if figure.get('pageIndex') == page_index:
            found.append(figure)
    return found


def _covering_figure(box, figures):
    for figure in figures:
        outer = _as_box(figure.get('bbox'))
        if outer is None:
            continue
        inside = outer[0] <= box[0] and outer[1] <= box[1] and box[2] <= outer[2] and box[3] <= outer[3]
        if inside:
            return outer
    return None


def _pad_box(box, rect):
    padded = [
        box[0] - _CHART_PAD, box[1] - _CHART_PAD,
        box[2] + _CHART_PAD, box[3] + _CHART_PAD,
    ]
    return _clamp_box(padded, rect)


def _add_vector_regions(page, page_index, figures, regions):
    for box in _cluster_boxes(_page_draw_boxes(page)):
        if len(regions) >= _MAX_CHART_REGIONS:
            return
        cover = _covering_figure(box, figures)
        if cover is not None:
            _push_region(regions, page_index, cover, page.rect)
        else:
            _push_region(regions, page_index, _pad_box(box, page.rect), page.rect)


def _add_figure_regions(page, page_index, figures, regions):
    for figure in figures:
        if len(regions) >= _MAX_CHART_REGIONS:
            return
        _push_region(regions, page_index, _as_box(figure.get('bbox')), page.rect)


def _page_regions(page, page_index, figures, regions):
    local = _page_figures(figures, page_index)
    _add_vector_regions(page, page_index, local, regions)
    _add_figure_regions(page, page_index, local, regions)


def _chart_regions(store, paper_id, file_hash):
    import pymupdf
    raw = store.source_bytes(paper_id, file_hash)
    figures = _list_targets(store, paper_id, file_hash).get('figures') or []
    regions = []
    doc = pymupdf.open(stream=raw, filetype='pdf')
    try:
        for index in range(len(doc)):
            _page_regions(doc[index], index, figures, regions)
            if len(regions) >= _MAX_CHART_REGIONS:
                break
    finally:
        doc.close()
    return regions


def _prepare_chart(service, paper_id, file_hash, region):
    try:
        scene = service.prepare({
            'paperId': paper_id,
            'fileHash': file_hash,
            'pageIndex': region['pageIndex'],
            'bbox': region['bbox'],
        })
    except Exception:
        return None
    if not isinstance(scene, dict) or not scene.get('series'):
        return None
    return scene


def _plot_limits(plot):
    box = plot if isinstance(plot, list) and len(plot) == 4 else [0.0, 0.0, 1.0, 1.0]
    try:
        return float(box[0]), float(box[1]), float(box[2]), float(box[3])
    except (TypeError, ValueError):
        return 0.0, 0.0, 1.0, 1.0


def _in_plot(x, y, plot):
    x0, y0, x1, y1 = _plot_limits(plot)
    return x0 <= x <= x1 and y0 <= y <= y1


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _bar_candidate(point, series, plot):
    baseline = _number(point.get('baseline', series.get('baseline')))
    x, y = _number(point.get('x')), _number(point.get('y'))
    if baseline is None or x is None or y is None:
        return None
    span = y - baseline
    if abs(span) < 4:
        return None
    for scale in (1.18, 0.82):
        new_y = baseline + span * scale
        moved = abs(new_y - y) >= abs(span) * 0.12 and _in_plot(x, new_y, plot)
        if moved:
            return abs(span), x, new_y
    return None


def _scatter_candidate(point, plot):
    x, y = _number(point.get('x')), _number(point.get('y'))
    if x is None or y is None:
        return None
    x0, y0, x1, y1 = _plot_limits(plot)
    dx, dy = (x1 - x0) * 0.18, (y1 - y0) * 0.18
    for new_x, new_y in ((x, y + dy), (x, y - dy), (x + dx, y), (x - dx, y)):
        if _in_plot(new_x, new_y, plot) and (abs(new_x - x) > 1 or abs(new_y - y) > 1):
            return abs(new_x - x) + abs(new_y - y), new_x, new_y
    return None


def _best_mark(series, plot):
    best = None
    points = series.get('points') or []
    for index, point in enumerate(points):
        if not isinstance(point, dict):
            continue
        if series.get('kind') == 'bar':
            found = _bar_candidate(point, series, plot)
        else:
            found = _scatter_candidate(point, plot)
        if found is not None and (best is None or found[0] > best[0]):
            best = (found[0], index, found[1], found[2])
    return best


def _mark_move(series, plot):
    best = _best_mark(series, plot)
    if best is None:
        return None
    _delta, index, x, y = best
    return {
        'id': 'cs-1',
        'kind': 'set-values',
        'seriesId': series.get('id'),
        'points': [{'index': index, 'x': x, 'y': y}],
    }


def _curve_move(series, plot):
    points = series.get('points') or []
    if len(points) < 3:
        return None
    xs, ys = [], []
    for point in points:
        x, y = _number(point.get('x') if isinstance(point, dict) else None), None
        y = _number(point.get('y') if isinstance(point, dict) else None)
        if x is None or y is None:
            return None
        xs.append(x)
        ys.append(y)
    x0, y0, x1, y1 = _plot_limits(plot)
    mid_x = (min(xs) + max(xs)) / 2.0
    mid_y = (min(ys) + max(ys)) / 2.0
    radius = max(max(xs) - min(xs), max(ys) - min(ys), 12.0) / 2.0
    delta = max((y1 - y0) * 0.18, 4.0)
    dy = delta if mid_y + delta <= y1 else -delta
    return {
        'id': 'cs-1', 'kind': 'deform', 'seriesId': series.get('id'),
        'center': [mid_x, mid_y], 'radius': radius, 'dx': 0, 'dy': dy,
    }


def _first_series_edit(series_list, plot, marks):
    for series in series_list:
        if not isinstance(series, dict) or not series.get('id'):
            continue
        if marks and series.get('kind') not in ('bar', 'scatter'):
            continue
        edit = _mark_move(series, plot) if marks else _curve_move(series, plot)
        if edit is not None:
            return edit
    return None


def _scene_edit(scene):
    try:
        plot = scene.get('plotBbox')
        series_list = scene.get('series') or []
        if scene.get('mode') == 'marks':
            return _first_series_edit(series_list, plot, True)
        return _first_series_edit(series_list, plot, False)
    except (TypeError, ValueError):
        return None


def _chart_op(scene, edit, suffix):
    op = _stamp('chart', suffix, 'D4-1', 'W4', 'L3')
    op['kind'] = 'chart-shape'
    op['pageIndex'] = scene.get('pageIndex')
    op['plan'] = {
        'schema': 'falsify.chart-edit-plan.v1',
        'paperId': scene.get('paperId'),
        'fileHash': scene.get('fileHash'),
        'sceneId': scene.get('sceneId'),
        'revision': 1,
        'operations': [edit],
    }
    return op


def _first_l3(discovered, traces, blocked):
    bundles = _l3_bundles(discovered, traces, blocked, {'n': 1})
    if not bundles:
        return None
    return bundles[0]


def _chart_with_text(chart, companion):
    if not companion or companion[0].get('kind') != 'text-span':
        return None
    return [chart, companion[0]]


def _push_chart_bundles(bundles, chart, companion):
    if companion:
        bundles.append([chart] + list(companion))
    pair = _chart_with_text(chart, companion)
    if pair is not None:
        bundles.append(pair)
    elif not companion:
        bundles.append([chart])


def _collect_chart_bundles(store, paper_id, file_hash, service, discovered, traces, blocked):
    bundles = []
    companion = _first_l3(discovered, traces, blocked)
    suffix = 1
    for region in _chart_regions(store, paper_id, file_hash):
        if len(bundles) >= 4:
            break
        scene = _prepare_chart(service, paper_id, file_hash, region)
        if scene is None:
            continue
        edit = _scene_edit(scene)
        if edit is None:
            continue
        _push_chart_bundles(bundles, _chart_op(scene, edit, suffix), companion)
        suffix += 1
    return bundles[:4]


def _chart_bundles_for(store, paper_id, file_hash, service, discovered, traces, blocked):
    if not _charts_enabled(service):
        return [], service
    active = service if service is not None else _fresh_chart_service(store)
    bundles = _collect_chart_bundles(
        store, paper_id, file_hash, active, discovered, traces, blocked,
    )
    if not bundles:
        return [], service
    return bundles, active


def _prepend_candidates(primary, existing):
    found = {'seen': set(), 'ops': []}
    _extend_unique(found, primary[:4])
    _extend_unique(found, existing)
    return found['ops'][:_MAX_CANDIDATES]


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
    red_brief=None,
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
    blocked = _blocked(baseline.get('signals'))
    groups = _candidate_groups(discovered, traces, blocked)
    candidates = _ordered_candidates(groups, target, claim_query)
    chart_bundles, active = _chart_bundles_for(
        bound_store, baseline.get('paperId', paper_id), actual_hash, service,
        discovered, traces, blocked,
    )
    if chart_bundles:
        candidates = _prepend_candidates(chart_bundles, candidates)
        service = active
    verified = _verify_all(paper_id, actual_hash, bound_store, loaded, service, candidates)
    ranked = sorted(verified, key=lambda row: _rank_key(row, target, red_brief))[:limit]
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

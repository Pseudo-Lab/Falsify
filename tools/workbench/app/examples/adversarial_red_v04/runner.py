"""Autonomous stdio/CLI RED runner.

Stages: baseline guard, surface discovery, deterministic planning, detectability
and stealth retries, then a blind bundle plus a sealed gold ledger.
"""
import argparse
import base64
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
APP_LOCAL = REPO / 'app' / 'local'
if str(APP_LOCAL) not in sys.path:
    sys.path.insert(0, str(APP_LOCAL))

import harness
from paper_blue_sensor import run_blue_sensor
from paper_chart_edit_service import ChartEditService
from paper_evidence import EvidenceStore
from paper_mcp import open_selected
from paper_red_detectability import simulate_red_detectability, trace_claim_propagation
from paper_red_planner import plan_coordinated_mutations
from paper_red_mcp import (
    _apply_operations,
    _detect_baseline_overlaps,
    _list_targets,
    _modified_regions,
)
from paper_stealth_audit import audit_pdf_stealth
from paper_supplement_mutator import normalize_red_supplements_extended
from paper_text_span_mutator import (
    assert_blind_supplements,
    list_pdf_text_spans,
)
from paper_uri_mutator import list_pdf_uri_links

VERSION = '0.4.0'
PROFILE_ID = 'shinick-adversarial-red-v04'
OUTPUT_SCHEMA = 'falsify.red-runner-output.v1'
AUDIT_SCHEMA = 'falsify.red-runner-audit.v0.4'
GOLD_SCHEMA = 'falsify.red-gold-ledger.v1'
DISTANCES = ('L1', 'L2', 'L3', 'L4')
INSTRUCTIONS = (
    'Generate stealth-clean coordinated adversarial defects at the requested difficulty. '
    'Prefer 3-surface plan_coordinated_mutations bundles across figure, prose, and table or supplement. '
    'Use xlsx-cell and ipynb-cell when a workbook or notebook shares a metric with the manuscript. '
    'Use L4 semantic D3, S1, and D5 prose swaps when red_brief asks for them. '
    'Pass red_brief so preferred surfaces and target families rank first. '
    'Keep untouched xlsx and ipynb supplements byte-for-byte. '
    'Never overwrite the source PDF or source supplements. '
    'Keep the gold ledger separate from the blind bundle. '
    'Do not emit answer-key tokens in the blind PDF or supplements.'
)
TRACKED_SOURCES = (
    'app/local/paper_red_planner.py',
    'app/local/paper_red_mcp.py',
    'app/local/paper_red_detectability.py',
    'app/local/paper_blue_sensor.py',
    'app/local/paper_text_span_mutator.py',
    'app/local/paper_supplement_mutator.py',
    'app/local/paper_uri_mutator.py',
    'app/local/paper_stealth_audit.py',
    'app/local/paper_chart_edit_service.py',
    'app/local/paper_evidence.py',
    'app/local/paper_mcp.py',
    'app/local/paper_figure_forensics.py',
    'app/examples/adversarial_red_v04/runner.py',
    'app/examples/adversarial_red_v04/build_profile.py',
)
_BINARY_EXTS = frozenset({'.pdf', '.docx'})
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
    'xlsx-cell': 'supplement',
    'ipynb-cell': 'supplement',
    'text-span': 'prose',
}
_FAMILIES = ('D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'S1')
_SURFACES = ('prose', 'table', 'figure', 'citation', 'supplement')
_SWAPS = (
    ('prove', 'show', 'D3', 'W2'),
    ('prevents', 'suggests', 'D3', 'W2'),
    ('causes', 'tracks', 'D3', 'W2'),
    ('always', 'rarely', 'D3', 'W2'),
    ('confirms', 'suggests', 'D3', 'W2'),
    ('lacks', 'shows', 'S1', 'W3'),
)
_DECIMAL = re.compile(r'\b\d+\.\d+\b')
_CODE = re.compile(r'[a-z0-9_]+')


class RedRunnerError(Exception):
    """Stable runner failure. exit_code 3 is the difficulty/stealth gate."""

    def __init__(self, code, exit_code=3):
        super().__init__(code)
        self.code = code
        self.exit_code = exit_code


def distance_rank(label):
    """Return 0..3 for L1..L4. Unknown labels sort below every real tier."""
    try:
        return DISTANCES.index(label)
    except ValueError:
        return -1


def source_map():
    """SHA-256 of each tracked runner and RED helper file."""
    sources = {}
    for rel in TRACKED_SOURCES:
        path = REPO / rel
        if not path.is_file():
            raise ValueError('tracked_source_missing')
        sources[rel.replace('\\', '/')] = hashlib.sha256(path.read_bytes()).hexdigest()
    return sources


def bundle_identity():
    """Canonical bundle digest. Same inputs always return the same hash."""
    return harness.digest(source_map())


def contract_settings():
    """Harness settings pinned to bundle_identity() and per-file hashes."""
    sources = source_map()
    settings = {
        'bundleSha256': harness.digest(sources),
        'diagnosticVersion': VERSION,
        'auditSchema': AUDIT_SCHEMA,
        'outputSchema': OUTPUT_SCHEMA,
        'profileId': PROFILE_ID,
        'role': 'red',
    }
    for rel, digest in sources.items():
        settings[Path(rel).stem + 'Sha256'] = digest
    return settings


def check_settings(settings):
    """Reject invocation settings that drift from contract_settings()."""
    expected = contract_settings()
    if not isinstance(settings, dict) or any(settings.get(key) != value for key, value in expected.items()):
        raise ValueError('settings_contract')


def _difficulty(value):
    if value is None:
        return 'L3'
    if value not in DISTANCES:
        raise RedRunnerError('target_difficulty_invalid', exit_code=2)
    return value


def _bounded_int(value, name, lo, hi, default):
    if value is None:
        return default
    if isinstance(value, bool) or type(value) is not int or not lo <= value <= hi:
        raise RedRunnerError(name + '_invalid', exit_code=2)
    return value


def _require_output(path, code):
    if not isinstance(path, str) or not path.strip():
        raise RedRunnerError(code, exit_code=2)
    return path


def _contains_hint(text):
    lowered = str(text or '').lower()
    for token in HINT_TOKENS:
        if token.lower() in lowered:
            return True
    return False


def _op_text(op):
    parts = []
    for key in ('before', 'after', 'afterFormula', 'beforeUri', 'afterUri', 'rationale'):
        value = op.get(key)
        if isinstance(value, str):
            parts.append(value)
    return '\n'.join(parts)


def _without_hints(ops):
    kept = []
    for op in ops:
        if isinstance(op, dict) and not _contains_hint(_op_text(op)):
            kept.append(op)
    return kept


def _ensure_ids(ops):
    numbered = []
    for index, op in enumerate(ops):
        item = dict(op)
        if not isinstance(item.get('id'), str) or not item['id']:
            item['id'] = f'red-op-{index}'
        numbered.append(item)
    return numbered


def _dict_uri(pocket):
    if not isinstance(pocket, dict):
        return None
    uri = pocket.get('uri')
    if isinstance(uri, str) and uri:
        return uri
    return None


def _baseline_markers(signals):
    """Item ids and URIs already condemned by Layer 0 on the untouched source."""
    items, uris = set(), set()
    for sig in signals or []:
        item_id = sig.get('itemId')
        if isinstance(item_id, str) and item_id:
            items.add(item_id)
        for pocket in (sig.get('computed'), sig.get('reported')):
            uri = _dict_uri(pocket)
            if uri:
                uris.add(uri)
    return items, uris


def _blocked_by_markers(op, markers):
    items, uris = markers
    if op.get('itemId') in items:
        return True
    before_uri = op.get('beforeUri')
    if isinstance(before_uri, str) and before_uri in uris:
        return True
    return False


def _hydrate_uri(op, links):
    if op.get('kind') != 'uri-link':
        return op
    if isinstance(op.get('beforeUri'), str) and op.get('beforeUri'):
        return op
    for link in links:
        if link.get('linkId') == op.get('linkId') and link.get('uri'):
            hydrated = dict(op)
            hydrated['beforeUri'] = link['uri']
            return hydrated
    return op


def _without_baseline(ops, baseline, links):
    markers = _baseline_markers((baseline or {}).get('signals') or [])
    kept = []
    for op in ops:
        hydrated = _hydrate_uri(op, links)
        if _blocked_by_markers(hydrated, markers):
            continue
        kept.append(hydrated)
    return kept


def _has_word(text, word):
    return re.search(r'(?<!\w)' + re.escape(word) + r'(?!\w)', text or '') is not None


def _text_op(span, before, after, family, world, index):
    return {
        'id': f"red-l4-p{span.get('pageIndex')}-{before}-{index}",
        'kind': 'text-span',
        'pageIndex': span.get('pageIndex'),
        'before': before,
        'after': after,
        'occurrence': 0,
        'world': world,
        'family': family,
        'difficulty': 'L4',
        'rationale': 'Softens a qualifier that has no static detector.',
    }


def _page_counts(spans):
    counts = {}
    for span in spans:
        page = span.get('pageIndex')
        counts[page] = counts.get(page, 0) + 1
    return counts


def _text_candidates(spans):
    """One qualifier swap per page, preferring a quiet page and the first matching pair."""
    counts = _page_counts(spans)
    ordered = sorted(spans, key=lambda span: (counts.get(span.get('pageIndex'), 99), span.get('pageIndex') or 0))
    found, seen = [], set()
    for span in ordered:
        page = span.get('pageIndex')
        if page in seen or len(found) >= 4:
            continue
        text = span.get('text') or ''
        for before, after, family, world in _SWAPS:
            if not _has_word(text, before):
                continue
            found.append(_text_op(span, before, after, family, world, len(found)))
            seen.add(page)
            break
    return found


def _nudge(token):
    if '.' not in token:
        return None
    whole, frac = token.split('.', 1)
    if not whole.isdigit() or not frac.isdigit() or not frac:
        return None
    digit = '1' if frac[-1] != '1' else '2'
    return whole + '.' + frac[:-1] + digit


def _supplement_op(rec, token, nudged, index):
    return {
        'id': f'red-l3-supp-{index}',
        'kind': 'supplement-edit',
        'supplementId': rec['supplementId'],
        'name': rec['name'],
        'before': token,
        'after': nudged,
        'occurrence': 0,
        'world': 'W4',
        'family': 'D1',
        'difficulty': 'L3',
        'rationale': 'Shifts a numeric claim onto another document surface.',
    }


def _supplement_candidates(supplements):
    found = []
    for rec in supplements:
        for token in _DECIMAL.findall(rec.get('text') or ''):
            nudged = _nudge(token)
            if nudged is None:
                continue
            found.append(_supplement_op(rec, token, nudged, len(found)))
            break
        if len(found) >= 2:
            break
    return found


def _numeric_cell(table):
    for cell in table.get('cells') or []:
        text = str(cell.get('text') or '').strip()
        row = cell.get('row')
        if row in (None, 0) or not text.isdigit():
            continue
        return cell
    return None


def _table_op(table, cell):
    text = str(cell.get('text') or '').strip()
    after = '98' if text == '99' else '99'
    return {
        'id': f"red-l2-{table.get('itemId')}-{cell.get('row')}-{cell.get('column')}",
        'kind': 'table-cell',
        'itemId': table.get('itemId'),
        'row': cell.get('row'),
        'column': cell.get('column'),
        'before': text,
        'after': after,
        'world': 'W1',
        'family': 'D1',
        'difficulty': 'L2',
        'rationale': 'Shifts a table value against its row and column totals.',
    }


def _table_candidates(tables):
    found = []
    for table in tables:
        cell = _numeric_cell(table)
        if cell is None or len(found) >= 2:
            continue
        found.append(_table_op(table, cell))
    return found


def _alt_uri(uri):
    if not isinstance(uri, str) or 'doi.org' not in uri.lower():
        return None
    if uri.rstrip('/').endswith('other-study'):
        return 'https://doi.org/10.1000/alt-study'
    return 'https://doi.org/10.1000/other-study'


def _uri_op(link, index):
    after = _alt_uri(link.get('uri'))
    if after is None or after == link.get('uri'):
        return None
    return {
        'id': f"red-l1-{link.get('linkId') or index}",
        'kind': 'uri-link',
        'linkId': link.get('linkId'),
        'pageIndex': link.get('pageIndex'),
        'annotIndex': link.get('annotIndex'),
        'beforeUri': link.get('uri'),
        'afterUri': after,
        'world': 'W5',
        'family': 'D2',
        'difficulty': 'L1',
        'rationale': 'Points one bibliography link at a different DOI.',
    }


def _uri_candidates(links):
    found = []
    for index, link in enumerate(links):
        op = _uri_op(link, index)
        if op is None or len(found) >= 2:
            continue
        found.append(op)
    return found


def _builtin_candidates(discovered):
    tables = discovered['targets'].get('tables') or []
    return (
        _text_candidates(discovered['spans'])
        + _supplement_candidates(discovered['supplements'])
        + _table_candidates(tables)
        + _uri_candidates(discovered['links'])
    )


def _planner_ops(planner_fn, context):
    if planner_fn is None:
        return []
    proposed = planner_fn(context)
    if proposed is None:
        return []
    if not isinstance(proposed, list):
        raise RedRunnerError('planner_invalid', exit_code=2)
    return proposed


def _candidate_pool(discovered, ops_hint, planner_fn, context):
    if ops_hint is not None:
        return _ensure_ids(ops_hint)
    return _ensure_ids(_planner_ops(planner_fn, context) + _builtin_candidates(discovered))


def _mentioned(text, token):
    pattern = r'(?<![a-z0-9])' + re.escape(token.lower()) + r'(?![a-z0-9])'
    return re.search(pattern, text) is not None


def _brief_text(brief):
    if brief is None:
        return ''
    if isinstance(brief, str):
        return brief
    return json.dumps(brief, ensure_ascii=False)


def _focus(brief):
    text = _brief_text(brief).lower()
    families = [item for item in _FAMILIES if _mentioned(text, item)]
    surfaces = [item for item in _SURFACES if _mentioned(text, item)]
    kinds = [item for item in _KIND_SURFACE if _mentioned(text, item)]
    return families, surfaces + kinds


def _brief_rank(op, focus):
    families, surfaces = focus
    if not families and not surfaces:
        return 0
    surface = _KIND_SURFACE.get(op.get('kind'), 'prose')
    if op.get('family') in families or surface in surfaces or op.get('kind') in surfaces:
        return 0
    return 1


def _gap(op, target):
    return abs(distance_rank(op['_distance']) - distance_rank(target))


def _boost(op, traces):
    token = op.get('before')
    if not isinstance(token, str):
        return 1
    for trace in traces:
        if trace.get('query') != token:
            continue
        surfaces = trace.get('surfaces') or {}
        hits = [name for name, count in surfaces.items() if count]
        if len(hits) >= 2:
            return 0
    return 1


def _tie(op, seed):
    raw = json.dumps(op.get('id'), ensure_ascii=False)
    return hashlib.sha256(f'{seed}:{raw}'.encode()).hexdigest()


def _closest(ops, target):
    best = None
    for op in ops:
        gap = _gap(op, target)
        if best is None or gap < best:
            best = gap
    return [op for op in ops if _gap(op, target) == best]


def _take_ops(ordered, max_ops):
    chosen, pages = [], set()
    for op in ordered:
        if len(chosen) >= max_ops:
            break
        if op.get('kind') == 'text-span' and op.get('pageIndex') in pages:
            continue
        if op.get('kind') == 'text-span':
            pages.add(op.get('pageIndex'))
        chosen.append(op)
    return chosen


def _passing(scored, target, max_ops, focus, seed, traces):
    meeting = []
    for op in scored:
        if distance_rank(op['_distance']) >= distance_rank(target):
            meeting.append(op)
    if not meeting:
        return []
    ordered = sorted(_closest(meeting, target), key=lambda op: (
        _brief_rank(op, focus), _gap(op, target), _boost(op, traces), _tie(op, seed),
    ))
    return _take_ops(ordered, max_ops)


def _score_one(bound, service, op, supplements):
    try:
        sim = simulate_red_detectability(
            bound['paperId'], [op], file_hash=bound['fileHash'], store=bound['store'],
            supplements=supplements or None, service=service,
        )
    except ValueError:
        return None
    results = sim.get('results') or []
    if not results or results[0].get('baselineOverlap'):
        return None
    distance = results[0].get('crossInferenceDistance')
    if distance not in DISTANCES:
        return None
    scored = dict(op)
    scored['_distance'] = distance
    return scored


def _score_all(bound, service, ops, supplements):
    scored = []
    for op in ops:
        row = _score_one(bound, service, op, supplements)
        if row is not None:
            scored.append(row)
    return scored


def _confirm(bound, service, ops, supplements, target):
    sim = simulate_red_detectability(
        bound['paperId'], ops, file_hash=bound['fileHash'], store=bound['store'],
        supplements=supplements or None, service=service,
    )
    kept = []
    for op, row in zip(ops, sim.get('results') or []):
        distance = row.get('crossInferenceDistance')
        if row.get('baselineOverlap') or distance not in DISTANCES:
            continue
        if distance_rank(distance) < distance_rank(target):
            continue
        kept.append({**op, '_distance': distance})
    return kept, sim


def _resolve_ops(bound, service, scored, supplements, target, max_ops, focus, seed, traces):
    pool = list(scored)
    for attempt in range(1, 4):
        picked = _passing(pool, target, max_ops, focus, seed, traces)
        if not picked:
            break
        kept, sim = _confirm(bound, service, picked, supplements, target)
        if kept:
            return kept, sim, attempt
        rejected = {op.get('id') for op in picked}
        pool = [op for op in pool if op.get('id') not in rejected]
    raise RedRunnerError('difficulty_target_unmet', exit_code=3)


def _public_op(op):
    exported = {}
    for key, value in op.items():
        if isinstance(key, str) and key.startswith('_'):
            continue
        exported[key] = value
    if op.get('_distance') in DISTANCES:
        exported['difficulty'] = op['_distance']
    return exported


def _blind_leak(blind):
    try:
        assert_blind_supplements(blind)
    except ValueError:
        return True
    for rec in blind or []:
        if _contains_hint(rec.get('text') or ''):
            return True
    return False


def _apply_once(bound, service, ops, supplements):
    _source, edited, vis, blind = _apply_operations(
        bound['store'], service, bound['paperId'], bound['fileHash'],
        [_public_op(op) for op in ops], supplements=supplements or None,
    )
    changes = vis.get('changes') or []
    stealth = audit_pdf_stealth(bound['raw'], edited, modified_regions=_modified_regions(vis))
    return {'edited': edited, 'changes': changes, 'blind': blind, 'stealth': stealth}


def _export_clean(bound, service, ops, supplements, baseline):
    current = list(ops)
    for _attempt in range(3):
        if not current:
            break
        try:
            exported = _apply_once(bound, service, current, supplements)
        except ValueError:
            current = current[1:]
            continue
        leaked = exported['stealth'].get('status') == 'detectable_artifact'
        if leaked or _blind_leak(exported['blind']):
            current = current[1:]
            continue
        overlaps = _detect_baseline_overlaps(current, exported['changes'], baseline)
        if overlaps:
            raise RedRunnerError('difficulty_target_unmet', exit_code=3)
        exported['ops'] = current
        return exported
    raise RedRunnerError('stealth_audit_failed', exit_code=3)


def _before_after(op, change):
    if op.get('kind') == 'uri-link':
        return op.get('beforeUri') or change.get('beforeUri'), op.get('afterUri') or change.get('afterUri')
    return op.get('before', change.get('before')), op.get('after', change.get('after'))


def _defect(op, change, stealth_pass):
    before, after = _before_after(op, change or {})
    page = op.get('pageIndex')
    if type(page) is not int:
        page = (change or {}).get('pageIndex')
    return {
        'defectId': op.get('id'),
        'operationId': op.get('id'),
        'kind': op.get('kind'),
        'world': op.get('world'),
        'family': op.get('family'),
        'difficulty': op.get('_distance'),
        'surface': _KIND_SURFACE.get(op.get('kind'), 'prose'),
        'stealthPass': stealth_pass,
        'pageIndex': page if type(page) is int else None,
        'itemId': op.get('itemId') or (change or {}).get('itemId'),
        'supplementName': op.get('name') or (change or {}).get('supplementName'),
        'before': before,
        'after': after,
    }


def _ledger(bound, target, ops, simulation, stealth, changes, edited):
    by_id = {
        change['id']: change
        for change in changes
        if isinstance(change, dict) and change.get('id')
    }
    passed = stealth.get('status') != 'detectable_artifact'
    defects = [_defect(op, by_id.get(op.get('id'), {}), passed) for op in ops]
    return {
        'schema': GOLD_SCHEMA,
        'paperId': bound['paperId'],
        'sourceSha256': bound['fileHash'],
        'outputSha256': hashlib.sha256(edited).hexdigest(),
        'targetDifficulty': target,
        'detectabilitySummary': simulation,
        'stealthAudit': stealth,
        'operations': [_public_op(op) for op in ops],
        'changes': changes,
        'defects': defects,
    }


def _refuse_same_path(source, dest):
    if source and dest and Path(source).resolve() == Path(dest).resolve():
        raise RedRunnerError('source_overwrite_refused', exit_code=2)


def _write_bytes(path, raw):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)


def _write_text(path, text):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')


def _structured_name(name):
    return str(name or '').lower().endswith(('.xlsx', '.ipynb'))


def _payload_bytes(rec):
    if not _structured_name(rec.get('name')):
        return None
    encoded = rec.get('contentBase64')
    if not isinstance(encoded, str) or not encoded:
        return None
    return base64.b64decode(encoded)


def _write_one_supplement(folder, rec):
    assert_blind_supplements(rec)
    target = folder / Path(rec['name']).name
    raw = _payload_bytes(rec)
    if raw is None:
        _write_text(target, rec.get('text') or '')
    else:
        _write_bytes(target, raw)
    return str(target)


def _write_supplements(directory, blind):
    folder = Path(directory)
    folder.mkdir(parents=True, exist_ok=True)
    return [_write_one_supplement(folder, rec) for rec in blind]


def _write_binary(directory, records):
    folder = Path(directory)
    folder.mkdir(parents=True, exist_ok=True)
    paths = []
    for rec in records or []:
        target = folder / Path(rec['name']).name
        _write_bytes(target, rec['raw'])
        paths.append(str(target))
    return paths


def _supplement_edit(ops):
    kinds = ('supplement-edit', 'xlsx-cell', 'ipynb-cell')
    for op in ops:
        if op.get('kind') in kinds:
            return True
    return False


def _structured_blind(blind):
    found = []
    for rec in blind or []:
        if _structured_name(rec.get('name')):
            found.append(rec)
    return found


def _maybe_write_supplements(directory, blind, ops, binaries=None):
    edited = _supplement_edit(ops)
    extra = list(binaries or [])
    structured = _structured_blind(blind)
    if not edited and not extra and not structured:
        return []
    if not directory:
        if edited:
            raise RedRunnerError('out_supplement_dir_required', exit_code=2)
        return []
    paths = _write_supplements(directory, blind) if edited or structured else []
    return paths + _write_binary(directory, extra)


def _bind_document(pdf_path, pdf_bytes):
    store = EvidenceStore()
    if pdf_path:
        summary = open_selected(store, pdf_path)
        raw = store.source_bytes(summary['paperId'], summary['fileHash'])
        return {
            'store': store, 'paperId': summary['paperId'], 'fileHash': summary['fileHash'],
            'raw': raw, 'path': str(pdf_path),
        }
    if not isinstance(pdf_bytes, (bytes, bytearray)) or not bytes(pdf_bytes).startswith(b'%PDF-'):
        raise RedRunnerError('pdf_invalid', exit_code=2)
    raw = bytes(pdf_bytes)
    digest = hashlib.sha256(raw).hexdigest()
    summary = store.prepare(raw, digest)
    return {
        'store': store, 'paperId': summary['paperId'], 'fileHash': summary['fileHash'],
        'raw': raw, 'path': None,
    }


def _discover(bound, supplements):
    targets = _list_targets(bound['store'], bound['paperId'], bound['fileHash'])
    links = list_pdf_uri_links(bound['raw']).get('links') or []
    spans = list_pdf_text_spans(bound['raw'], limit=200).get('spans') or []
    return {'targets': targets, 'links': links, 'spans': spans, 'supplements': supplements}


def _push_decimals(found, text):
    for token in _DECIMAL.findall(text or ''):
        if token in found or len(found) >= 4:
            continue
        found.append(token)
    return found


def _anchor_queries(spans, supplements):
    found = []
    for span in spans:
        _push_decimals(found, span.get('text') or '')
    for rec in supplements:
        _push_decimals(found, rec.get('text') or '')
    return found


def _trace_anchors(bound, supplements, spans):
    traces = []
    for query in _anchor_queries(spans, supplements):
        try:
            traces.append(trace_claim_propagation(
                bound['paperId'], query, file_hash=bound['fileHash'],
                store=bound['store'], supplements=supplements or None,
            ))
        except ValueError:
            continue
    return traces


def _slim_signal(sig):
    return {
        'id': sig.get('id'), 'family': sig.get('family'), 'kind': sig.get('kind'),
        'pageIndex': sig.get('pageIndex'), 'itemId': sig.get('itemId'),
    }


def _context(bound, discovered, baseline, traces, target, seed, max_ops, brief):
    supplements = []
    for rec in discovered['supplements']:
        supplements.append({
            'supplementId': rec['supplementId'], 'name': rec['name'],
            'kind': rec['kind'], 'text': rec['text'],
        })
    return {
        'paperId': bound['paperId'],
        'fileHash': bound['fileHash'],
        'targetDifficulty': target,
        'seed': seed,
        'maxOps': max_ops,
        'redBrief': brief,
        'baselineSignals': [_slim_signal(sig) for sig in (baseline.get('signals') or [])],
        'tables': discovered['targets'].get('tables') or [],
        'figures': discovered['targets'].get('figures') or [],
        'links': discovered['links'],
        'spans': discovered['spans'],
        'supplements': supplements,
        'traces': traces,
    }


def _summary(bound, target, ops, stealth, paths, baseline, traces, attempts, pool_count):
    return {
        'schema': OUTPUT_SCHEMA,
        'ok': True,
        'appliedCount': len(ops),
        'achievedDifficulties': [op['_distance'] for op in ops],
        'stealthStatus': stealth['status'],
        'outPdf': paths['outPdf'],
        'outGold': paths['outGold'],
        'outSupplements': paths['outSupplements'],
        'audit': {
            'schema': AUDIT_SCHEMA,
            'version': VERSION,
            'profileId': PROFILE_ID,
            'paperId': bound['paperId'],
            'targetDifficulty': target,
            'baselineSignalCount': len((baseline or {}).get('signals') or []),
            'traceCount': len(traces),
            'attemptCount': attempts,
            'candidateCount': pool_count,
        },
    }


def _bundle_surfaces(ops):
    found = set()
    for op in ops:
        if isinstance(op, dict):
            found.add(_KIND_SURFACE.get(op.get('kind'), 'prose'))
    return found


def _name_list(brief, *keys):
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


def _brief_miss(ops, brief):
    wanted = _name_list(brief, 'preferredSurfaces', 'targetSurfaces')
    families = _name_list(brief, 'targetFamilies')
    worlds = _name_list(brief, 'targetWorlds')
    if not wanted and not families and not worlds:
        return 0
    surfaces = _bundle_surfaces(ops)
    have_families = {op.get('family') for op in ops if isinstance(op, dict)}
    have_worlds = {op.get('world') for op in ops if isinstance(op, dict)}
    missed = False
    if wanted and not set(wanted) <= surfaces:
        missed = True
    if families and not set(families) & have_families:
        missed = True
    if worlds and not set(worlds) & have_worlds:
        missed = True
    return 1 if missed else 0


def _bundle_rank(ops, brief):
    surfaces = _bundle_surfaces(ops)
    three = 'figure' in surfaces and 'prose' in surfaces and bool(surfaces & {'table', 'supplement'})
    if three:
        tier = 0
    elif len(surfaces) >= 2:
        tier = 1
    else:
        tier = 2
    return (_brief_miss(ops, brief), tier, -len(ops))


def _plan_rows(bound, service, supplements, target, red_brief=None):
    try:
        plan = plan_coordinated_mutations(
            bound['paperId'], file_hash=bound['fileHash'], store=bound['store'],
            supplements=supplements or None, service=service, target_difficulty=target,
            max_bundles=5, red_brief=red_brief if isinstance(red_brief, dict) else None,
        )
    except ValueError:
        return []
    rows = []
    for bundle in plan.get('bundles') or []:
        ops = bundle.get('operations') or []
        if bundle.get('targetMet') and ops:
            rows.append(ops)
    rows.sort(key=lambda ops: _bundle_rank(ops, red_brief))
    return rows


def _ops_meet(sim, target):
    rows = sim.get('results') or []
    if not rows:
        return False
    for row in rows:
        distance = row.get('crossInferenceDistance')
        if row.get('baselineOverlap') or distance not in DISTANCES:
            return False
        if distance_rank(distance) < distance_rank(target):
            return False
    return True


def _score_planned(ops, sim):
    by_id = {row.get('operationId'): row for row in sim.get('results') or []}
    scored = []
    for op in ops:
        distance = by_id.get(op.get('id'), {}).get('crossInferenceDistance')
        if distance not in DISTANCES:
            return None
        scored.append({**op, '_distance': distance})
    return scored


def _accept_planned(bound, service, ops, supplements, baseline, links, target):
    cleaned = _without_baseline(_without_hints(_ensure_ids(ops)), baseline, links)
    if len(cleaned) != len(ops):
        return None
    try:
        sim = simulate_red_detectability(
            bound['paperId'], cleaned, file_hash=bound['fileHash'], store=bound['store'],
            supplements=supplements or None, service=service,
        )
    except ValueError:
        return None
    if not _ops_meet(sim, target):
        return None
    scored = _score_planned(cleaned, sim)
    if scored is None:
        return None
    try:
        exported = _apply_once(bound, service, scored, supplements)
    except ValueError:
        return None
    leaked = exported['stealth'].get('status') == 'detectable_artifact'
    if leaked or _blind_leak(exported['blind']):
        return None
    if _detect_baseline_overlaps(cleaned, exported['changes'], baseline):
        return None
    exported['ops'] = scored
    exported['simulation'] = sim
    return exported


def _first_planned(bound, service, supplements, baseline, links, target, red_brief=None):
    for index, ops in enumerate(_plan_rows(bound, service, supplements, target, red_brief), start=1):
        accepted = _accept_planned(bound, service, ops, supplements, baseline, links, target)
        if accepted is None:
            continue
        accepted['attempts'] = index
        accepted['poolCount'] = index
        return accepted
    return None


def _attach_blind(summary, edited, blind, ledger):
    summary['blindPdfBase64'] = base64.b64encode(edited).decode('ascii')
    summary['blindSupplements'] = [
        {'name': rec.get('name'), 'text': rec.get('text') or ''} for rec in blind or []
    ]
    summary['goldLedger'] = ledger
    return summary


def run_red_pipeline(
    pdf_bytes=None, *, pdf_path=None, supplements=None, binaries=None, target_difficulty='L3', max_ops=3,
    seed=7, red_brief=None, ops_hint=None, planner_fn=None, out_pdf=None, out_gold=None,
    out_supplement_dir=None, out_audit=None,
):
    """Run the five-stage RED pipeline and write the blind bundle plus gold ledger."""
    target = _difficulty(target_difficulty)
    max_ops = _bounded_int(max_ops, 'max_ops', 1, 12, 3)
    seed = _bounded_int(seed, 'seed', 0, 2_147_483_647, 7)
    out_pdf = _require_output(out_pdf, 'out_pdf_required')
    out_gold = _require_output(out_gold, 'out_gold_required')
    _refuse_same_path(pdf_path, out_pdf)
    _refuse_same_path(pdf_path, out_gold)
    _refuse_same_path(pdf_path, out_audit)
    bound = _bind_document(pdf_path, pdf_bytes)
    loaded = normalize_red_supplements_extended(supplements) if supplements else []
    service = ChartEditService(store=bound['store'])
    baseline = run_blue_sensor(
        bound['paperId'], file_hash=bound['fileHash'], include_external_oracle=False, store=bound['store'],
    )
    discovered = _discover(bound, loaded)
    traces = _trace_anchors(bound, loaded, discovered['spans'])
    context = _context(bound, discovered, baseline, traces, target, seed, max_ops, red_brief)
    planned = None
    if ops_hint is None:
        planned = _first_planned(
            bound, service, loaded, baseline, discovered['links'], target, red_brief,
        )
    if planned is not None:
        exported = planned
        simulation = planned['simulation']
        attempts = planned['attempts']
        pool_count = planned['poolCount']
    else:
        pool = _candidate_pool(discovered, ops_hint, planner_fn, context)
        pool = _without_baseline(_without_hints(pool), baseline, discovered['links'])
        scored = _score_all(bound, service, pool, loaded)
        selected, simulation, attempts = _resolve_ops(
            bound, service, scored, loaded, target, max_ops, _focus(red_brief), seed, traces,
        )
        exported = _export_clean(bound, service, selected, loaded, baseline)
        pool_count = len(pool)
    ledger = _ledger(
        bound, target, exported['ops'], simulation, exported['stealth'],
        exported['changes'], exported['edited'],
    )
    _write_bytes(out_pdf, exported['edited'])
    _write_text(out_gold, json.dumps(ledger, ensure_ascii=False, indent=2) + '\n')
    supp_paths = _maybe_write_supplements(
        out_supplement_dir, exported['blind'], exported['ops'], binaries,
    )
    paths = {'outPdf': str(out_pdf), 'outGold': str(out_gold), 'outSupplements': supp_paths}
    summary = _summary(
        bound, target, exported['ops'], exported['stealth'], paths, baseline, traces, attempts, pool_count,
    )
    if out_audit:
        _write_text(out_audit, json.dumps(summary['audit'], ensure_ascii=False, indent=2) + '\n')
    return _attach_blind(summary, exported['edited'], exported['blind'], ledger)


def _first(mapping, *keys):
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _coerce_json(value):
    if value is None or isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        raise RedRunnerError('json_invalid', exit_code=2)
    text = value.strip()
    path = Path(text)
    if text[:1] not in '{[' and path.is_file():
        text = path.read_text(encoding='utf-8')
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RedRunnerError('json_invalid', exit_code=2) from None


def _ops_hint(value):
    parsed = _coerce_json(value)
    if parsed is None:
        return None
    if not isinstance(parsed, list):
        raise RedRunnerError('ops_hint_invalid', exit_code=2)
    return parsed


def _maybe_check_settings(settings):
    if isinstance(settings, dict) and 'bundleSha256' in settings:
        check_settings(settings)


def _pdf_source(invocation):
    encoded = _first(invocation, 'pdfBase64', 'pdf_base64')
    if encoded:
        try:
            return None, base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            raise RedRunnerError('pdf_invalid', exit_code=2) from None
    path = _first(invocation, 'sourcePdf', 'pdfPath', 'pdf')
    if path:
        return str(path), None
    raise RedRunnerError('pdf_required', exit_code=2)


def _named_supplements(names):
    if not isinstance(names, list):
        raise RedRunnerError('supplement_invalid', exit_code=2)
    folder = Path.cwd() / 'supplements'
    paths = []
    for name in names:
        if not isinstance(name, str) or not name or Path(name).name != name:
            raise RedRunnerError('supplement_invalid', exit_code=2)
        paths.append(str(folder / name))
    return paths


def _supplement_input(invocation):
    names = invocation.get('supplementNames')
    if isinstance(names, list) and names:
        return _named_supplements(names)
    value = _first(invocation, 'supplementPaths', 'supplements')
    if not value:
        return []
    if isinstance(value, str):
        return [value]
    return value


def _read_binary(path):
    if not path.is_file():
        raise RedRunnerError('supplement_invalid', exit_code=2)
    return {'name': path.name, 'raw': path.read_bytes()}


def _route_supplement(item, text, binary):
    if isinstance(item, dict):
        text.append(item)
        return
    path = Path(str(item))
    if path.suffix.lower() in _BINARY_EXTS:
        binary.append(_read_binary(path))
        return
    text.append(str(path))


def _partition_supplements(value):
    text, binary = [], []
    if not value:
        return text, binary
    items = [value] if isinstance(value, str) else list(value)
    for item in items:
        _route_supplement(item, text, binary)
    return text, binary


def _load_text_inputs(items):
    if not items:
        return []
    return normalize_red_supplements_extended(list(items))


def _cue_brief(primary, secondary):
    parts = [part for part in (primary, secondary) if isinstance(part, str)]
    text = ' '.join(parts).lower()
    if not text:
        return None
    surfaces = [name for name in _SURFACES if name in text]
    families = [name for name in _FAMILIES if name.lower() in text]
    brief = {}
    if surfaces:
        brief['preferredSurfaces'] = surfaces
    if families:
        brief['targetFamilies'] = families
    return brief or None


def _invocation_brief(invocation):
    explicit = _coerce_json(_first(invocation, 'redBrief', 'red_brief'))
    if isinstance(explicit, dict):
        return explicit
    settings = invocation.get('settings') if isinstance(invocation.get('settings'), dict) else {}
    nested = settings.get('redBrief')
    if isinstance(nested, dict):
        return nested
    return _cue_brief(invocation.get('instructions'), settings.get('instructions'))


def execute(invocation, planner_fn=None):
    """Run one CLI dict or falsify.harness-invocation.v1 / falsify.red-invocation.v1 payload."""
    if not isinstance(invocation, dict):
        raise RedRunnerError('invocation_invalid', exit_code=2)
    schema = invocation.get('schema')
    allowed = (None, 'falsify.harness-invocation.v1', 'falsify.red-invocation.v1')
    if schema not in allowed:
        raise RedRunnerError('invocation_schema_invalid', exit_code=2)
    _maybe_check_settings(invocation.get('settings'))
    pdf_path, pdf_bytes = _pdf_source(invocation)
    text_items, binaries = _partition_supplements(_supplement_input(invocation))
    return run_red_pipeline(
        pdf_bytes,
        pdf_path=pdf_path,
        supplements=_load_text_inputs(text_items),
        binaries=binaries,
        target_difficulty=_first(invocation, 'minDifficulty', 'targetDifficulty', 'target_difficulty'),
        max_ops=_first(invocation, 'maxOps', 'max_ops'),
        seed=invocation.get('seed', 7),
        red_brief=_invocation_brief(invocation),
        ops_hint=_ops_hint(_first(invocation, 'opsHint', 'ops_hint')),
        planner_fn=planner_fn,
        out_pdf=_first(invocation, 'outPdfPath', 'outPdf', 'out_pdf'),
        out_gold=_first(invocation, 'outGoldPath', 'outGold', 'out_gold'),
        out_supplement_dir=_first(invocation, 'outSupplementsDir', 'outSupplementDir', 'out_supplement_dir'),
        out_audit=_first(invocation, 'outAuditPath', 'outAudit', 'out_audit'),
    )


def _parse_cli(argv):
    parser = argparse.ArgumentParser(description='Autonomous RED runner v0.4.0')
    parser.add_argument('--pdf', required=True)
    parser.add_argument('--out-pdf', required=True)
    parser.add_argument('--out-gold', required=True)
    parser.add_argument('--out-audit')
    parser.add_argument('--supplement', action='append')
    parser.add_argument('--out-supplement-dir')
    parser.add_argument('--target-difficulty', default='L3', choices=list(DISTANCES))
    parser.add_argument('--max-ops', type=int, default=3)
    parser.add_argument('--seed', type=int, default=7)
    parser.add_argument('--red-brief')
    parser.add_argument('--ops-hint')
    args = parser.parse_args(argv)
    return {
        'pdfPath': args.pdf,
        'outPdfPath': args.out_pdf,
        'outGoldPath': args.out_gold,
        'outAuditPath': args.out_audit,
        'supplementPaths': args.supplement or [],
        'outSupplementDir': args.out_supplement_dir,
        'targetDifficulty': args.target_difficulty,
        'maxOps': args.max_ops,
        'seed': args.seed,
        'redBrief': args.red_brief,
        'opsHint': args.ops_hint,
    }


def _read_stdin():
    raw = sys.stdin.read()
    if not str(raw or '').strip():
        raise RedRunnerError('invocation_invalid', exit_code=2)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RedRunnerError('invocation_invalid', exit_code=2) from None


def _emit(code):
    print(json.dumps({'schema': OUTPUT_SCHEMA, 'ok': False, 'error': code}, ensure_ascii=False))


def _error_code(exc):
    code = exc.args[0] if exc.args and isinstance(exc.args[0], str) else 'runner_failed'
    if _CODE.fullmatch(code):
        return code
    return 'runner_failed'


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if '--pdf' not in args:
            if any(flag in args for flag in ('-h', '--help')):
                _parse_cli(args)
            result = execute(_read_stdin())
        else:
            result = execute(_parse_cli(args))
    except RedRunnerError as exc:
        _emit(exc.code)
        return exc.exit_code
    except ValueError as exc:
        _emit(_error_code(exc))
        return 2
    except OSError:
        _emit('io_error')
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())

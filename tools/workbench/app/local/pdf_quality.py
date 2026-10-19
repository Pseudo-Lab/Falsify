"""Bounded, local, independent per-output PDF QA with PyMuPDF (MuPDF), a different engine from the editor's PDFium.

Public API:
  verify_pdf_quality(source_bytes, output_bytes, edits, page_map, page_count=None, *, edit_plan=None) -> report (in-process)
  inspect_isolated(source_path, output_path, edits, page_map, page_count=None, *, edit_plan=None) -> report (child process)
  sanitize(value) -> report, or the unavailable report when the value is not a well-formed report

Report: {schema:'falsify.pdf-quality.v1', status, method, checks:[{code, status, pages}], limitations}.
status is passed|warning|failed|unavailable; pages are 1-based OUTPUT page numbers; codes and limitations come
from fixed sets. No document text or filesystem path ever leaves this module. Only 'failed' is a definite defect
(changed unedited page, missing intended After/original text, unreadable output); uncertain coverage, ambiguous
continuations and hidden-text heuristics are warnings. Nothing is repaired, rewritten, flattened or rasterized.

Edited pages are also checked regionally by the sibling pdf_regions.py (loaded by absolute path, so the isolated child
needs no sys.path or working directory): QA locates every selected Before in the immutable source itself, compares the
page outside those tight source regions, and checks the After's style and visibility. A supplied edit_plan is only
cross-checked against that located plan (code edit_plan); it never defines what is excluded.
"""
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

SCHEMA = 'falsify.pdf-quality.v1'
STATUSES = ('passed', 'warning', 'failed', 'unavailable')
CODES = ('engine', 'output_readable', 'page_count', 'page_map', 'unedited_geometry', 'unedited_text', 'unedited_render',
    'edited_after_present', 'edited_before_removed', 'edited_text_order', 'continuation_pages',
    'hidden_text_invisible', 'hidden_text_white', 'hidden_text_covered', 'edit_plan',
    'edited_page_render', 'edited_page_text', 'edited_region_style', 'edited_region_visible')
REGIONAL = ('edited_page_render', 'edited_page_text', 'edited_region_style', 'edited_region_visible')
LIMITATIONS = {
    'scope': 'Independent MuPDF re-read of this output only; not full scientific, typographic or human verification.',
    'text': 'Text is compared after Unicode compatibility normalization ignoring whitespace and hyphens.',
    'render': 'Unedited pages are compared at bounded RGB resolution; only sub-threshold antialiasing deltas are tolerated.',
    'hidden': 'Invisible, white and covered text checks are heuristic diagnostics counted against the source page.',
    'page_map_assumed': 'No usable page map: identity mapping assumed, so unedited-page differences are warnings only.',
    'page_map_unusable': 'No usable page map and page counts differ: unedited pages were not compared.',
    'budget': 'Page, raster or time budget reached: some pages were not fully compared.',
    'continuation': 'Continuation pages are inferred from the page map; copied header/footer text is tolerated and ambiguity is a warning.',
    'regional': 'Edited pages are compared outside tight source-located edit regions, and the After text style and visibility are checked.',
    'regional_partial': 'Some edited-page areas (moved, reflowed, continued, ambiguous or unsupported text) were only partially compared.',
    'unavailable': 'Independent QA could not run; this output is not independently checked.',
}
LIMITS = {'timeoutSeconds': 90, 'workBudgetSeconds': 60, 'maxPages': 2000, 'maxRenderPages': 120, 'maxRasterSide': 1000,
    'maxGroupChars': 20000, 'maxTraceChars': 200000, 'maxStdoutBytes': 256 * 1024, 'maxListedPages': 50}
GEOMETRY_TOLERANCE = 0.01  # points; PDFium float32 MediaBox reserialization drift is ~0.00003 pt
PIXEL_DELTA = 40           # channel levels a sample must move to count as changed (smaller deltas are 'minor')
MIN_LOST_CHUNK = 16        # normalized chars of original text that must vanish from the whole output to fail
ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
HIDDEN = ('hidden_text_invisible', 'hidden_text_white', 'hidden_text_covered')
_DROP = re.compile(r'[\s\u00ad\-\u2010\u2011]+')

def unavailable(method='mupdf unavailable'):
    return {'schema': SCHEMA, 'status': 'unavailable', 'method': method,
        'checks': [{'code': 'engine', 'status': 'unavailable', 'pages': []}], 'limitations': [LIMITATIONS['unavailable']]}

def _overall(checks):
    states = {c['status'] for c in checks}
    if 'failed' in states: return 'failed'
    if states == {'unavailable'}: return 'unavailable'
    return 'warning' if states & {'warning', 'unavailable'} else 'passed'

def sanitize(value):
    """Strict whitelist copy of a report; anything malformed becomes the unavailable report."""
    try:
        if not isinstance(value, dict) or value.get('schema') != SCHEMA or value.get('status') not in STATUSES: raise ValueError
        method = value.get('method')
        if not isinstance(method, str) or not re.fullmatch(r'[a-z0-9][a-z0-9 .,/+()-]{0,119}', method): raise ValueError
        checks = value.get('checks')
        if not isinstance(checks, list) or not 1 <= len(checks) <= len(CODES): raise ValueError
        out = []
        for c in checks:
            pages = c.get('pages') if isinstance(c, dict) else None
            if c.get('code') not in CODES or c.get('status') not in STATUSES or not isinstance(pages, list) \
                    or len(pages) > LIMITS['maxListedPages'] or any(type(p) is not int or not 1 <= p <= 100000 for p in pages): raise ValueError
            out.append({'code': c['code'], 'status': c['status'], 'pages': list(pages)})
        if len({c['code'] for c in out}) != len(out): raise ValueError
        lims = value.get('limitations')
        if not isinstance(lims, list) or any(l not in LIMITATIONS.values() for l in lims): raise ValueError
        if _overall(out) != value['status']: raise ValueError
        return {'schema': SCHEMA, 'status': value['status'], 'method': method, 'checks': out, 'limitations': list(dict.fromkeys(lims))}
    except (ValueError, AttributeError, TypeError):
        return unavailable()

def _norm(text): return _DROP.sub('', unicodedata.normalize('NFKC', text or ''))

_SPACE = re.compile(r'[\s\xad]+')
def _norm_signed(text): return _SPACE.sub('', unicodedata.normalize('NFKC', text or ''))  # keeps hyphens and minus signs

_REGIONS = []
def _regions():
    """The sibling pdf_regions module loaded from this file's own directory by absolute path (never sys.path or the
    working directory, so it also loads in the isolated -I child); None when it cannot be loaded."""
    if not _REGIONS:
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location('falsify_pdf_regions', Path(__file__).resolve().with_name('pdf_regions.py'))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            _REGIONS.append(module)
        except Exception:
            _REGIONS.append(None)
    return _REGIONS[0]

class _Report:
    RANK = {'passed': 0, 'unavailable': 1, 'warning': 2, 'failed': 3}
    def __init__(self): self.checks, self.lims = {}, ['scope', 'text']
    def set(self, code, status, pages=()):
        """Worst status wins; pages (0-based output indices) accumulate for the worst status only."""
        pages = {int(p) + 1 for p in pages}
        old = self.checks.get(code)
        if old is None or self.RANK[status] > self.RANK[old['status']]: self.checks[code] = {'code': code, 'status': status, 'pages': pages}
        elif status == old['status']: old['pages'] |= pages
    def note(self, key):
        if key not in self.lims: self.lims.append(key)
    def result(self, method):
        checks = [{**self.checks[c], 'pages': sorted(self.checks[c]['pages'])[:LIMITS['maxListedPages']]} for c in CODES if c in self.checks]
        return {'schema': SCHEMA, 'status': _overall(checks), 'method': method, 'checks': checks,
            'limitations': [LIMITATIONS[k] for k in self.lims]}

def _valid_map(page_map, src_n, out_n):
    """Groups [output, *continuations] per source page when the map is an in-order partition of every output page
    with continuations directly after their own page; else None. Only indices are used (no body-band metadata)."""
    if not isinstance(page_map, list) or len(page_map) != src_n: return None
    index = lambda v: type(v) is int and v >= 0  # bool is not an index
    expected, groups = 0, []
    for i, e in enumerate(page_map):
        if not isinstance(e, dict) or not index(e.get('sourcePageIndex')) or not index(e.get('outputPageIndex')) \
                or e['sourcePageIndex'] != i or e['outputPageIndex'] != expected: return None
        cont = e.get('continuationPageIndices', [])
        if not isinstance(cont, list) or not all(index(c) for c in cont) or cont != list(range(expected + 1, expected + 1 + len(cont))): return None
        groups.append([expected, *cont])
        expected += 1 + len(cont)
    return groups if expected == out_n else None

def _text(page, mupdf): return page.get_text('text', sort=True, flags=mupdf.TEXT_MEDIABOX_CLIP)

def _lines(page, mupdf): return [n for n in (_norm(l) for l in _text(page, mupdf).split('\n')) if n]

def _edge_match(line, src_line):
    """Exact source edge line, or the same line with a decimal continuation suffix (e.g. 10 -> 10.1)."""
    return line == src_line or re.fullmatch(re.escape(src_line) + r'\.\d{1,3}', line) is not None

def _strip_copied_edges(src_lines, group_lines):
    """Body text of the group with only confidently source-derived edges removed: up to two trailing lines of the
    first page and up to two leading/trailing lines of each continuation page that match the source page's own
    first/last lines. Anything else is kept."""
    heads, tails = src_lines[:2], src_lines[-2:]
    out = []
    for k, lines in enumerate(group_lines):
        lines = list(lines)
        if k > 0:
            for _ in range(2):
                if lines and any(_edge_match(lines[0], h) for h in heads): lines.pop(0)
        if len(group_lines) > 1:
            for _ in range(2):
                if lines and any(_edge_match(lines[-1], t) for t in tails): lines.pop()
        out.append(''.join(lines))
    return ''.join(out)

def _in_order_coverage(needle, haystack):
    """Fraction of needle matched in order inside haystack, allowing inserted text between the matched parts;
    stray matches shorter than four characters do not count."""
    if not needle: return 1.0
    blocks = difflib.SequenceMatcher(None, needle, haystack, autojunk=False).get_matching_blocks()
    return sum(b.size for b in blocks if b.size >= min(4, len(needle))) / len(needle)

def _geometry_equal(a, b):
    if a.rotation != b.rotation: return False
    return all(abs(x - y) <= GEOMETRY_TOLERANCE for r1, r2 in [(a.mediabox, b.mediabox), (a.cropbox, b.cropbox)] for x, y in zip(r1, r2))

def _raster(page, mupdf):
    rect = page.rect
    zoom = min(1.0, LIMITS['maxRasterSide'] / max(rect.width, rect.height, 1))
    return page.get_pixmap(matrix=mupdf.Matrix(zoom, zoom), colorspace=mupdf.csRGB, alpha=False, annots=True)

def _render_diff(a, b, mupdf):
    """'same' | 'minor' | 'changed' under the same MuPDF render; a 1 px size drift compares the overlap. Any sample
    moving more than PIXEL_DELTA (e.g. a recolored page number) is a change; the float32 page-box drift renders
    identically in MuPDF, so no area-based allowance is needed."""
    pa, pb = _raster(a, mupdf), _raster(b, mupdf)
    if abs(pa.width - pb.width) > 1 or abs(pa.height - pb.height) > 1: return 'changed'
    if (pa.width, pa.height) == (pb.width, pb.height) and pa.samples == pb.samples: return 'same'
    w, h = min(pa.width, pb.width) * pa.n, min(pa.height, pb.height)
    sa, sb = pa.samples, pb.samples
    minor = False
    for y in range(h):
        ra, rb = sa[y * pa.stride:y * pa.stride + w], sb[y * pb.stride:y * pb.stride + w]
        if ra == rb: continue
        if any(abs(x - z) > PIXEL_DELTA for x, z in zip(ra, rb)): return 'changed'
        minor = True
    return 'minor' if minor else 'same'

def _hidden_counts(page, budget):
    """(invisible, white, covered) counts from MuPDF's text trace and draw-order bbox log; None over budget."""
    trace = page.get_texttrace()
    if sum(len(s.get('chars', ())) for s in trace) > budget: return None
    invisible = white = 0
    for s in trace:
        n = sum(1 for c in s.get('chars', ()) if not chr(c[0]).isspace())
        if s.get('type') == 3 or s.get('opacity', 1) == 0: invisible += n
        elif s.get('type') == 0:
            color, cs = tuple(s.get('color') or ()), s.get('colorspace')
            if color and ((cs in (1, 3) and min(color) >= 0.97) or (cs == 4 and max(color) <= 0.03)): white += n
    log = page.get_bboxlog()
    if len(log) > budget: return None
    covered = 0
    for i, (kind, r) in enumerate(log):
        area = max(r[2] - r[0], 0) * max(r[3] - r[1], 0)
        if kind not in ('fill-text', 'stroke-text') or area <= 0: continue
        for kind2, q in log[i + 1:]:
            if kind2 not in ('fill-path', 'fill-image', 'fill-shade'): continue
            iw, ih = min(r[2], q[2]) - max(r[0], q[0]), min(r[3], q[3]) - max(r[1], q[1])
            if iw > 0 and ih > 0 and iw * ih >= 0.9 * area: covered += 1; break
    return invisible, white, covered

def _lost_chunks(expected, actual):
    ops = difflib.SequenceMatcher(None, expected, actual, autojunk=False).get_opcodes()
    return [expected[i1:i2] for tag, i1, i2, _, _ in ops if tag in ('delete', 'replace')], \
        sum(j2 - j1 for tag, _, _, j1, j2 in ops if tag in ('insert', 'replace'))

def _block_text(page, mupdf):
    """Normalized text block by block, ordered by block top then left, so side-by-side columns are not interleaved."""
    blocks = page.get_text('blocks', flags=mupdf.TEXT_MEDIABOX_CLIP)
    return ''.join(_norm_signed(b[4]) for b in sorted(blocks, key=lambda b: (round(b[1], 1), b[0])) if b[6] == 0)

def _block_order_exact(src_page, out_pages, edits, mupdf):
    """True only when the output pages read block by block are exactly the source page read the same way with exactly
    the selected Before->After edits: every source character (hyphens and signs included) in order, nothing added,
    removed or substituted."""
    actual = ''.join(_block_text(p, mupdf) for p in out_pages)
    pairs = [(_norm_signed(e['before']), _norm_signed(e['after'])) for e in edits]
    return len(actual) <= LIMITS['maxGroupChars'] and actual in _candidates(_block_text(src_page, mupdf), pairs)

def _candidates(source, pairs):
    """Expected normalized page text after the exact Before->After edits; an ambiguous Before tries a few occurrences."""
    variants = [source]
    for before, after in pairs:
        nxt = []
        for v in variants:
            nxt += [v[:s] + after + v[s + len(before):] for s in [m.start() for m in re.finditer(re.escape(before), v)][:4]]
        if not nxt: return []
        variants = nxt[:16]
    return variants

def _check_edited(rep, src_page, out, group, edits, out_all, mupdf):
    src_lines = _lines(src_page, mupdf)
    src_text = ''.join(src_lines)
    group_lines = [_lines(out[o], mupdf) for o in group]
    parts = [''.join(l) for l in group_lines]
    actual = ''.join(parts)
    body = _strip_copied_edges(src_lines, group_lines) if len(group) > 1 else actual
    pairs = [(_norm(e['before']), _norm(e['after'])) for e in edits]
    # MuPDF must find each exact Before in the source before a missing After counts as definite.
    reliable = all(b and b in src_text for b, _ in pairs)
    for b, a in pairs:
        if a in actual or a in body: state = 'passed'
        elif not reliable: state = 'warning'
        elif len(group) == 1: state = 'failed' if _in_order_coverage(a, actual) < 1.0 else 'warning'
        # A long After crossing pages can be interleaved with copied header/footer text that was not confidently
        # recognized: only an After mostly absent from the group is definite.
        else: state = 'failed' if _in_order_coverage(a, actual) < 0.5 else 'warning'
        rep.set('edited_after_present', state, () if state == 'passed' else group)
        residual = actual.count(b) - (src_text.count(b) - 1) - actual.count(a) * a.count(b) if b else 0
        rep.set('edited_before_removed', 'warning' if residual > 0 else 'passed', group if residual > 0 else ())
    if len(group) > 1:
        rep.note('continuation')
        empty = [o for o, p in zip(group[1:], parts[1:]) if not p]
        rep.set('continuation_pages', 'warning' if empty else 'passed', empty)
    if not reliable or len(src_text) > LIMITS['maxGroupChars'] or len(actual) > LIMITS['maxGroupChars']:
        rep.set('edited_text_order', 'warning', group); return
    best = None
    for expected in _candidates(src_text, pairs):
        lost, extra = _lost_chunks(expected, actual)
        score = (sum(map(len, lost)), extra)
        if best is None or score < best[0]: best = (score, lost, extra)
    if best is None: rep.set('edited_text_order', 'warning', group); return
    _, lost, extra = best
    if not lost and (extra == 0 or len(group) > 1): rep.set('edited_text_order', 'passed'); return
    # Original text gone from the entire output is definite loss; reordering, extraction quirks and
    # continuation header/footer copies are ambiguous warnings.
    vanished = any(len(c) >= MIN_LOST_CHUNK and c not in out_all for c in lost)
    # Line-sorted extraction joins the lines of side-by-side columns, so a column that grew re-pairs its lines with the
    # neighbour's and splits source runs that are all still there. That is only an ordering warning when the group read
    # block by block is exactly the source with exactly the selected edits; any other difference stays definite.
    if vanished and _block_order_exact(src_page, [out[o] for o in group], edits, mupdf): vanished = False
    rep.set('edited_text_order', 'failed' if vanished else 'warning', group)

def _check_regional(rep, regions, s, src_page, out, group, ks, edits, located, models, mupdf, assumed):
    """Regional codes for one edited source page. Unsupported cases (continuation, unlocated edit, budget) are warnings."""
    if regions is None:
        for code in REGIONAL: rep.set(code, 'unavailable', group)
        return
    if len(group) > 1 or any(k not in located for k in ks) or models.get(s) is None:
        rep.note('budget' if s in models and models[s] is None else 'regional_partial')
        for code in REGIONAL: rep.set(code, 'warning', group)
        return
    picks = [(located[k][0], edits[k]['after'], located[k][1]) for k in ks]
    try:
        res, notes = regions.check_page(src_page, out[group[0]], models[s], picks, mupdf, lambda p: _raster(p, mupdf), LIMITS['maxTraceChars'])
    except Exception:
        res, notes = {}, {'regional_partial'}
    for code in REGIONAL:
        state = res.get(code, 'warning')
        if state == 'failed' and assumed: state = 'warning'  # an assumed page mapping never gates
        rep.set(code, state, () if state == 'passed' else group)
    for key in sorted(notes): rep.note(key)

def verify_pdf_quality(source_bytes, output_bytes, edits, page_map, page_count=None, *, edit_plan=None):
    """In-process QA. edits: [{pageIndex, before, after}] exactly as selected; page_map: sanitized sourcePageMap or None;
    page_count: the editor's reported {source, output}, compared with the actual counts and never trusted; edit_plan:
    the private source-derived plan, only cross-checked against QA's own located plan."""
    try: import pymupdf as mupdf
    except Exception: return unavailable()
    started = time.monotonic()
    method = 'mupdf ' + re.sub(r'[^0-9.]', '', str(getattr(mupdf, 'VersionBind', '')))[:20] + ' text/geometry/raster'
    rep = _Report()
    try: src = mupdf.open(stream=bytes(source_bytes), filetype='pdf')
    except Exception: return unavailable(method)
    try: out = mupdf.open(stream=bytes(output_bytes), filetype='pdf')
    except Exception:
        rep.set('output_readable', 'failed'); return sanitize(rep.result(method))
    if out.needs_pass or out.page_count < 1:
        rep.set('output_readable', 'failed'); return sanitize(rep.result(method))
    # A repaired-on-open output is suspicious only when the source opened cleanly.
    rep.set('output_readable', 'warning' if out.is_repaired and not src.is_repaired else 'passed')
    src_n, out_n = src.page_count, out.page_count
    if src.needs_pass or max(src_n, out_n) > LIMITS['maxPages']:
        rep.note('budget'); rep.set('unedited_text', 'unavailable'); return sanitize(rep.result(method))
    if page_count is not None:  # a reported count is compared with the actual one; none reported makes no claim
        reported = page_count if isinstance(page_count, dict) else {}
        rep.set('page_count', 'passed' if (reported.get('source'), reported.get('output')) == (src_n, out_n) else 'warning')
    edited = {}
    for e in edits: edited.setdefault(e['pageIndex'], []).append(e)
    groups, assumed = _valid_map(page_map, src_n, out_n), False
    if groups is not None and any(len(g) > 1 and i not in edited for i, g in enumerate(groups)): groups = None
    if groups is None:
        rep.set('page_map', 'warning')
        if src_n == out_n: groups, assumed = [[i] for i in range(src_n)], True; rep.note('page_map_assumed')
        else: rep.note('page_map_unusable'); rep.set('unedited_text', 'unavailable')
    else: rep.set('page_map', 'passed')
    if not edited or any(i >= src_n for i in edited): rep.set('edited_after_present', 'warning')
    if groups is None: return sanitize(rep.result(method))
    rep.note('render'); rep.note('hidden')
    defect = 'warning' if assumed else 'failed'
    regions, located, models = _regions(), {}, {}
    if regions is not None:
        try: plan, located, models = regions.build_plan(src, mupdf, hashlib.sha256(bytes(source_bytes)).hexdigest(), edits, LIMITS['maxTraceChars'])
        except Exception: regions = None
    if edit_plan is not None:
        accepted = regions is not None and regions.compare_plan(edit_plan, plan) == 'accepted'
        rep.set('edit_plan', 'passed' if accepted else 'warning')
    out_all = ''.join(_norm(_text(p, mupdf)) for p in out)
    rendered = 0
    for s, group in enumerate(groups):
        if s in edited:
            _check_edited(rep, src[s], out, group, edited[s], out_all, mupdf)
            ks = [k for k, e in enumerate(edits) if e['pageIndex'] == s]
            if rendered >= LIMITS['maxRenderPages'] or time.monotonic() - started > LIMITS['workBudgetSeconds']:
                rep.note('budget')
                for code in REGIONAL: rep.set(code, 'warning', group)
            else:
                rendered += 1
                _check_regional(rep, regions, s, src[s], out, group, ks, edits, located, models, mupdf, assumed)
            base = _hidden_counts(src[s], LIMITS['maxTraceChars'])
            tallies = [_hidden_counts(out[o], LIMITS['maxTraceChars']) for o in group]
            if base is None or any(t is None for t in tallies):
                rep.note('budget')
                for code in HIDDEN: rep.set(code, 'warning', group)
                continue
            for k, code in enumerate(HIDDEN):
                grew = sum(t[k] for t in tallies) > base[k]
                rep.set(code, 'warning' if grew else 'passed', group if grew else ())
            continue
        a, b = src[s], out[group[0]]
        geometry_ok = _geometry_equal(a, b)
        rep.set('unedited_geometry', 'passed' if geometry_ok else defect, () if geometry_ok else [group[0]])
        text_ok = _norm(_text(a, mupdf)) == _norm(_text(b, mupdf))
        if rendered >= LIMITS['maxRenderPages'] or time.monotonic() - started > LIMITS['workBudgetSeconds']:
            rep.note('budget'); rep.set('unedited_render', 'warning', [group[0]])
            rep.set('unedited_text', 'passed' if text_ok else 'warning', () if text_ok else [group[0]]); continue
        rendered += 1
        diff = _render_diff(a, b, mupdf)
        rep.set('unedited_render', {'same': 'passed', 'minor': 'warning', 'changed': defect}[diff], () if diff == 'same' else [group[0]])
        # Changed extraction under a stable render (e.g. a shared font's ToUnicode) is reported, not gated.
        rep.set('unedited_text', 'passed' if text_ok else (defect if diff == 'changed' else 'warning'), () if text_ok else [group[0]])
    return sanitize(rep.result(method))

def default_runner(argv, *, input, cwd, env, timeout):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    return subprocess.run(argv, input=input, cwd=cwd, env=env, timeout=timeout, shell=False,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)

def inspect_isolated(source_path, output_path, edits, page_map, page_count=None, *, edit_plan=None, runner=None):
    """Production entry: verify_pdf_quality in a child of this interpreter (startup executable, isolated mode,
    minimal environment, fixed argv) with a hard timeout. Any failure to run is 'unavailable', never 'passed'."""
    if not sys.executable: return unavailable()
    request = {'source': str(source_path), 'output': str(output_path), 'pageMap': page_map, 'pageCount': page_count,
        'edits': [{'pageIndex': e['pageIndex'], 'before': e['before'], 'after': e['after']} for e in edits]}
    if edit_plan is not None:
        try: json.dumps(edit_plan, allow_nan=False); request['editPlan'] = edit_plan
        except (TypeError, ValueError, RecursionError): request['editPlan'] = 'malformed'  # cross-checked as rejected
    env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
    try:
        result = (runner or default_runner)([sys.executable, '-I', str(Path(__file__).resolve()), '--worker'],
            input=json.dumps(request).encode('utf-8'), cwd=str(Path(output_path).parent), env=env, timeout=LIMITS['timeoutSeconds'])
        raw = result.stdout or b''
        if result.returncode != 0 or len(raw) > LIMITS['maxStdoutBytes']: return unavailable()
        lines = [l for l in raw.decode('utf-8', 'strict').splitlines() if l.strip()]
        return sanitize(json.loads(lines[0])) if len(lines) == 1 else unavailable()
    except (subprocess.TimeoutExpired, OSError, ValueError, UnicodeDecodeError):
        return unavailable()

def _worker():
    request = json.loads(sys.stdin.buffer.read(4 * 1024 * 1024).decode('utf-8'))
    report = verify_pdf_quality(Path(request['source']).read_bytes(), Path(request['output']).read_bytes(),
        request['edits'], request.get('pageMap'), request.get('pageCount'), edit_plan=request.get('editPlan'))
    sys.stdout.write(json.dumps(report) + '\n')

if __name__ == '__main__' and sys.argv[1:] == ['--worker']:
    try: _worker()
    except Exception: sys.stdout.write(json.dumps(unavailable()) + '\n')

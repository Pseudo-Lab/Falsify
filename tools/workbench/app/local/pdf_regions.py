"""Source-located edit regions and edited-page regional QA for pdf_quality (MuPDF only, never output-defined masks).

build_plan derives the private 'falsify.pdf-edit-plan.v1' from the immutable source alone: each selected Before is
anchored in its page's MuPDF character stream with whitespace removed and nothing else normalized, so signs, digits,
hyphens and operators keep their meaning. A missing or repeated anchor is reported, never guessed. Regions are tight
per-line boxes of the selected source characters in MuPDF unrotated page points; styles are their {font, size, color}.
compare_plan only cross-checks a supplied plan against that one: a caller can never define, widen or move what QA
excludes. check_page compares one edited output page with its source page and returns fixed codes only (no text,
coordinates or paths).

The raster comparison of an edited page excludes only the tight per-line boxes of the selected SOURCE characters plus
a fixed BLEED, never whole lines, whole pages or anything the output defines. Where the After or kept text of an
edited line legitimately lands outside those sealed boxes (a longer or shorter After, re-justified spacing), the
difference there is at most a warning (regional_partial); it is never widened into the exclusion and never passes.

A re-serialized page may also move unchanged glyphs by a float32 rounding step (about 1e-4 pt). That is invisible, but
it can carry a glyph origin across MuPDF's sub-pixel glyph quantization and re-antialias its edge by more than
PIXEL_DELTA. Such samples are only a warning, and only when each one lies on an unedited glyph whose character and
exact style match the source and whose position moved by more than 0 and at most DRIFT_TOL, the glyph keeps its ink
within NOISE_INK, and no drawing, image, annotation or unmatched output text differs or appears there. Anything else
(an added mark, a white cover, a recolor, a resize) stays a definite failure.

An engine that re-emits text positions in floating point (e.g. a re-derived leading) can instead translate a whole run
of unchanged glyphs rigidly by a few thousandths of a point. A glyph also counts as drifted when it belongs to a rigid
run: at least two consecutive glyphs of one unedited line (or one kept stretch of an edited line between selections),
each with the same character and exact style, all moved by the same vector (every coordinate within DRIFT_TOL of the
run's first glyph, box shape kept) of at most RIGID_TOL (far below one raster pixel). The same ink, drawing, image,
annotation and unmatched-text proof applies; a single glyph, a run whose glyphs moved differently, a restyled glyph or a
translation beyond RIGID_TOL stays a definite failure.
"""
import hashlib
import json
import math
import re
from collections import Counter

PLAN_SCHEMA = 'falsify.pdf-edit-plan.v1'
POLICY = 'document-consistency-text'
CODES = ('edited_page_render', 'edited_page_text', 'edited_region_style', 'edited_region_visible')
LIMITS = {'maxPlanBytes': 512 * 1024, 'maxPlanEdits': 64, 'maxEditLines': 64, 'maxStyles': 16, 'maxMaskFraction': 0.5}
BASE_TOL = 0.6           # points: same baseline
POS_TOL = 0.6            # points: same glyph origin on an unedited line
PLAN_TOL = 1.5           # points: a supplied region may differ this much from the located one
BLEED = 1.0              # points of antialiasing bleed around the sealed selected source regions (fixed, never widened)
SIZE_TOL = (0.25, 0.03)  # absolute points, fraction of the source size
COLOR_TOL = 8            # RGB channel levels
WIDTH_TOL = (0.3, 0.1)   # absolute points, fraction of a source advance: a renamed font with other metrics
PIXEL_DELTA = 40         # channel levels a sample must move to count as changed
MINOR_FRACTION = 0.0005  # sub-PIXEL_DELTA samples outside the excluded lines tolerated before it is a warning
INK_DELTA = 64           # channel levels a pixel must differ from its line background to count as ink
DRIFT_TOL = 0.002        # points: float32 re-serialization drift of an unchanged glyph (never a visible move)
RIGID_TOL = 0.02         # points: rigid float re-emit translation of a whole run of unchanged glyphs (< 1/30 pixel)
NOISE_INK = 0.08         # fraction of its ink a drifted glyph may gain or lose when its antialiased edge re-quantizes
NOISE_MAX = 4096         # high-delta pixels examined for drift noise; beyond this a difference is definite
IMAGE_KEYS = ('bbox', 'transform', 'digest', 'width', 'height', 'bpc', 'cs-name')
_SUBSET = re.compile(r'^[A-Z]{6}\+')
_HEX = re.compile(r'[0-9a-f]{64}')

def font_key(name):
    """Font identity without subset prefix, case, punctuation or a PostScript/Regular suffix."""
    key = re.sub(r'[^a-z0-9]', '', _SUBSET.sub('', name or '').lower())
    return re.sub(r'(?:regular|psmt|mt|ps)+$', '', key) or key

class _Char:
    __slots__ = ('c', 'box', 'base', 'style', 'line', 'block')
    def __init__(self, c, box, base, style, line, block):
        self.c, self.box, self.base, self.style, self.line, self.block = c, box, base, style, line, block

class PageModel:
    def __init__(self, chars): self.chars, self.stream = chars, ''.join(ch.c for ch in chars)

def page_model(page, mupdf, max_chars):
    """Non-whitespace characters (one code point each) of the horizontal text lines in MuPDF extraction order, or None
    over the character budget. Rotated or vertical lines are left to the raster comparison."""
    raw = page.get_text('rawdict', flags=mupdf.TEXT_PRESERVE_WHITESPACE | mupdf.TEXT_MEDIABOX_CLIP)
    chars, line = [], 0
    for block, b in enumerate(raw.get('blocks', ())):
        for l in (b.get('lines', ()) if b.get('type') == 0 else ()):
            line += 1
            d = l.get('dir') or (1, 0)
            if abs(d[1]) > 1e-3 or d[0] <= 0: continue
            for s in l.get('spans', ()):
                font = _SUBSET.sub('', str(s.get('font') or ''))[:64]
                style = (font_key(font), float(s.get('size') or 0), int(s.get('color') or 0) & 0xFFFFFF, font)
                for ch in s.get('chars', ()):
                    for c in ch.get('c', ''):
                        if not c.isspace(): chars.append(_Char(c, tuple(ch['bbox']), ch['origin'][1], style, line, block))
                if len(chars) > max_chars: return None
    return PageModel(chars)

def _find(stream, needle, limit=2):
    hits, i = [], stream.find(needle)
    while i >= 0 and len(hits) < limit: hits.append(i); i = stream.find(needle, i + 1)
    return hits

def locate(model, before):
    """('resolved', selected char indices) for exactly one whitespace-free occurrence; else ('ambiguous'|'unavailable', [])."""
    needle = re.sub(r'\s+', '', before or '')
    hits = _find(model.stream, needle) if needle else []
    if len(hits) != 1: return ('ambiguous' if hits else 'unavailable'), []
    return 'resolved', list(range(hits[0], hits[0] + len(needle)))

def _sha(text): return hashlib.sha256(text.encode('utf-8')).hexdigest()

def _union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))

def build_plan(doc, mupdf, source_sha256, edits, max_chars):
    """(plan, located, models): plan is the private contract dict; located maps edit index -> (selected char indices,
    source styles) of resolved edits; models maps page index -> PageModel, or None when over budget."""
    models, located, entries, taken = {}, {}, [], {}
    for k, e in enumerate(edits):
        p = e.get('pageIndex')
        entry = {'id': f'edit-{k + 1}', 'pageIndex': p, 'beforeSha256': _sha(e['before']), 'afterSha256': _sha(e['after']),
            'status': 'unavailable', 'regions': [], 'styles': []}
        entries.append(entry)
        if type(p) is not int or not 0 <= p < doc.page_count or k >= LIMITS['maxPlanEdits']: continue
        if p not in models: models[p] = page_model(doc[p], mupdf, max_chars)
        if models[p] is None: continue
        chars = models[p].chars
        status, picked = locate(models[p], e['before'])
        lines = {}
        for i in picked: lines.setdefault(chars[i].line, []).append(chars[i].box)
        styles = list(dict.fromkeys(chars[i].style for i in picked))
        if status == 'resolved' and (len(lines) > LIMITS['maxEditLines'] or len(styles) > LIMITS['maxStyles']): status = 'unavailable'
        # Two edits claiming the same source characters cannot both be honoured, so the later one is not guessed.
        if status == 'resolved' and taken.setdefault(p, set()) & set(picked): status = 'ambiguous'
        entry['status'] = status
        if status != 'resolved': continue
        taken[p] |= set(picked)
        located[k] = (picked, styles)
        entry['regions'] = [[round(v, 3) for v in _union(boxes)] for boxes in lines.values()]
        entry['styles'] = [{'font': s[3], 'size': round(s[1], 3), 'color': s[2]} for s in styles]
    states = {e['status'] for e in entries}
    status = 'resolved' if states == {'resolved'} else 'partial' if 'resolved' in states else 'unavailable'
    return {'schema': PLAN_SCHEMA, 'sourceSha256': source_sha256, 'policy': POLICY, 'status': status, 'edits': entries}, located, models

def _num(v): return type(v) in (int, float) and math.isfinite(v)

def _same_regions(got, own):
    if len(got) != len(own): return False
    for r in got:
        if not isinstance(r, list) or len(r) != 4 or not all(_num(v) for v in r) or r[0] >= r[2] or r[1] >= r[3]: return False
    key = lambda r: (r[1], r[0])
    return all(abs(a - b) <= PLAN_TOL for g, o in zip(sorted(got, key=key), sorted(own, key=key)) for a, b in zip(g, o))

def _same_styles(got, own):
    if len(got) != len(own): return False
    for s in got:
        if not isinstance(s, dict) or not isinstance(s.get('font'), str) or len(s['font']) > 128 or not _num(s.get('size')) \
                or s['size'] <= 0 or type(s.get('color')) is not int or not 0 <= s['color'] <= 0xFFFFFF: return False
    key = lambda s: (font_key(s['font']), s['color'], s['size'])
    return all(_style_eq((font_key(g['font']), g['size'], g['color']), (font_key(o['font']), o['size'], o['color']))
        for g, o in zip(sorted(got, key=key), sorted(own, key=key)))

def compare_plan(supplied, plan):
    """'absent' | 'accepted' | 'rejected'. A supplied plan is accepted only when it is well formed, bound to the same
    source bytes and selected Before/After hashes, and agrees with the located plan; it never adds or widens a region.
    Ids are the caller's own labels (QA numbers its edits edit-N internally). A supplied edit may be more conservative
    (ambiguous/unavailable with no regions) than the located one, but never claims a region QA could not locate."""
    if supplied is None: return 'absent'
    try:
        if not isinstance(supplied, dict) or len(json.dumps(supplied, allow_nan=False)) > LIMITS['maxPlanBytes']: return 'rejected'
        if any(supplied.get(k) != plan[k] for k in ('schema', 'sourceSha256', 'policy')): return 'rejected'
        if supplied.get('status') not in ('resolved', 'partial', 'unavailable'): return 'rejected'
        got_edits = supplied.get('edits')
        if not isinstance(got_edits, list) or len(got_edits) != len(plan['edits']): return 'rejected'
        for got, own in zip(got_edits, plan['edits']):
            if not isinstance(got, dict) or not isinstance(got.get('id'), str) or not 0 < len(got['id']) <= 64 \
                    or type(got.get('pageIndex')) is not int: return 'rejected'
            if not all(_HEX.fullmatch(str(got.get(k))) for k in ('beforeSha256', 'afterSha256')): return 'rejected'
            if any(got.get(k) != own[k] for k in ('pageIndex', 'beforeSha256', 'afterSha256')): return 'rejected'
            if not isinstance(got.get('regions'), list) or not isinstance(got.get('styles'), list): return 'rejected'
            if got.get('status') in ('ambiguous', 'unavailable'):
                if got['regions'] or got['styles']: return 'rejected'
            elif got.get('status') != 'resolved' or own['status'] != 'resolved' \
                    or not (_same_regions(got['regions'], own['regions']) and _same_styles(got['styles'], own['styles'])):
                return 'rejected'
        return 'accepted'
    except (TypeError, ValueError, AttributeError, KeyError, RecursionError):
        return 'rejected'

def _style_eq(a, b):
    """(font key, size, RGB int) equality with a bounded size and color tolerance."""
    return _style_cmp(a, b) == 'same'

def _style_cmp(a, b):
    """'same', 'font' (only the font identity differs; size and color within tolerance) or 'bad' (size or color)."""
    if abs(a[1] - b[1]) > max(SIZE_TOL[0], SIZE_TOL[1] * a[1]): return 'bad'
    if any(abs(((a[2] >> s) & 255) - ((b[2] >> s) & 255)) > COLOR_TOL for s in (16, 8, 0)): return 'bad'
    return 'same' if a[0] == b[0] else 'font'

def _width(ch): return ch.box[2] - ch.box[0]

def _glyph(style, ch, refs):
    """Verdict of one output glyph drawn where the source style is expected. A font name mismatch alone (fallback,
    embedding or renaming) is 'font', i.e. unverified, unless the source advances of the same character in that
    style (refs) prove other metrics, which is 'bad'. Size and color changes are always 'bad'."""
    v = _style_cmp(style, ch.style)
    if v != 'font' or not refs: return v
    lo, hi = min(refs), max(refs)
    ok = lo - max(WIDTH_TOL[0], WIDTH_TOL[1] * lo) <= _width(ch) <= hi + max(WIDTH_TOL[0], WIDTH_TOL[1] * hi)
    return 'font' if ok else 'bad'

def _after_glyph(styles, ch, refs):
    """Best verdict of one After glyph against any of the selected source styles; refs maps (char, style) to the
    source advances of that character in that style."""
    vs = [_glyph(s, ch, refs.get((ch.c, s), ())) for s in styles]
    return 'same' if 'same' in vs else 'font' if 'font' in vs else 'bad'

def _rows(chars):
    """[(baseline, char indices left to right)] grouping characters that share a baseline. Characters MuPDF reports at
    one glyph origin (a ligature's components: consecutive on one line, origins within DRIFT_TOL) keep their extraction
    order, so a float re-serialization of that origin cannot permute them; their characters are still compared exactly."""
    x = []
    for i, ch in enumerate(chars):
        prev = chars[i - 1] if i else None
        x.append(x[-1] if prev is not None and prev.line == ch.line and abs(ch.box[0] - prev.box[0]) <= DRIFT_TOL else ch.box[0])
    rows = []
    for i in sorted(range(len(chars)), key=lambda i: (chars[i].base, x[i], i)):
        if rows and chars[i].base - rows[-1][0] <= BASE_TOL: rows[-1][1].append(i)
        else: rows.append((chars[i].base, [i]))
    return [(base, sorted(idx, key=lambda i: (x[i], i))) for base, idx in rows]

def _text(chars, row): return ''.join(chars[i].c for i in row)

def _same_row(S, row, O, orow, placed):
    """'same', 'font' (only font names differ, advances within tolerance) or None when the rows differ."""
    if len(row) != len(orow): return None
    font = False
    for i, j in zip(row, orow):
        a, b = S[i], O[j]
        v = _glyph(a.style, b, [_width(a)]) if a.c == b.c else 'bad'
        if v == 'bad': return None
        font |= v == 'font'
        if placed and (abs(a.base - b.base) > BASE_TOL or abs(a.box[0] - b.box[0]) > POS_TOL): return None
    return 'font' if font else 'same'

def _px(pix, page, box, margin=0.0):
    zx, zy = pix.width / page.rect.width, pix.height / page.rect.height
    return (max(0, int((box[0] - margin) * zx)), max(0, int((box[1] - margin) * zy)),
        min(pix.width, math.ceil((box[2] + margin) * zx)), min(pix.height, math.ceil((box[3] + margin) * zy)))

def _blank(sa, sb, pix, page, boxes):
    """Zero the given boxes (plus BLEED) in both sample buffers."""
    n, stride = pix.n, pix.stride
    for box in boxes:
        x0, y0, x1, y1 = _px(pix, page, box, BLEED)
        if x1 <= x0: continue
        blank = bytes((x1 - x0) * n)
        for y in range(y0, y1):
            o = y * stride + x0 * n
            sa[o:o + len(blank)] = blank; sb[o:o + len(blank)] = blank

def _masked_diff(pa, pb, page, sealed, zones, explain=None):
    """(status, zone_changed) for the same-frame renders. Only the sealed source regions (plus BLEED) are excluded.
    A difference confined to the zones (After or kept edited-line text that slid outside the sealed regions) is a
    warning, never a pass; elsewhere any sample moving more than PIXEL_DELTA is a definite change unless explain
    (given the set of such (x, y) pixels) proves it is float32 drift noise of unchanged glyphs, which is a warning."""
    if (pa.width, pa.height, pa.n, pa.stride) != (pb.width, pb.height, pb.n, pb.stride): return 'failed', False
    sa, sb, stride, n = bytearray(pa.samples), bytearray(pb.samples), pa.stride, pa.n
    _blank(sa, sb, pa, page, sealed)
    za = zb = None
    if zones: za, zb = bytes(sa), bytes(sb); _blank(sa, sb, pa, page, zones)
    if sa == sb: return ('warning', True) if za != zb else ('passed', False)
    minor, high = 0, set()
    for y in range(pa.height):
        ra, rb = sa[y * stride:(y + 1) * stride], sb[y * stride:(y + 1) * stride]
        if ra == rb: continue
        for k, (x, z) in enumerate(zip(ra, rb)):
            if x != z:
                if abs(x - z) <= PIXEL_DELTA: minor += 1; continue
                high.add((k // n, y))
                if explain is None or len(high) > NOISE_MAX: return 'failed', False
    if high: return ('warning', True) if explain(high) else ('failed', False)
    if minor > MINOR_FRACTION * len(sa): return 'warning', False
    return ('warning', True) if za != zb else ('passed', False)

def _overlap(a, b): return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])

def _norm(v):
    """Drawing/image values made comparable: numbers rounded to 0.01, points/rects/quads as nested tuples."""
    if v is None or isinstance(v, (str, bool)): return v
    if isinstance(v, (int, float)): return round(v, 2)
    if isinstance(v, dict): return tuple(sorted((k, _norm(x)) for k, x in v.items() if k not in ('seqno', 'layer', 'level')))
    return tuple(_norm(x) for x in v)

def _ink_sum(pix, box):
    n, stride, data = pix.n, pix.stride, pix.samples
    return sum(255 * n - sum(data[y * stride + x * n:y * stride + x * n + n]) for y in range(box[1], box[3]) for x in range(box[0], box[2]))

def _drift_noise(high, pa, pb, src_page, out_page, drifted, unmatched):
    """True when every high-delta pixel lies on an unedited glyph pair from drifted (same character and exact style,
    position moved by more than 0 and at most DRIFT_TOL), each such glyph keeps its ink within NOISE_INK, and no
    drawing, image, annotation or unmatched output character differs or appears on those glyphs."""
    rects, rows = [], {}
    for s, o in drifted:
        box = _union([s.box, o.box]); px = _px(pb, out_page, box, 1.0)
        rects.append((box, px))
        for y in range(px[1], px[3]): rows.setdefault(y, []).append(len(rects) - 1)
    hit = set()
    for x, y in high:
        k = next((k for k in rows.get(y, ()) if rects[k][1][0] <= x < rects[k][1][2]), None)
        if k is None: return False
        hit.add(k)
    boxes = [rects[k][0] for k in hit]
    for k in hit:
        a, b = _ink_sum(pa, rects[k][1]), _ink_sum(pb, rects[k][1])
        if not a or abs(a - b) > NOISE_INK * max(a, b): return False
    if any(_overlap(u, box) for u in unmatched for box in boxes): return False
    near = lambda r: any(_overlap(tuple(r), box) for box in boxes)
    for page in (src_page, out_page):
        if any(near(a.rect) for a in page.annots()): return False
    objects = lambda page: sorted([('d', _norm(d)) for d in page.get_drawings() if near(d['rect'])] +
        [('i', _norm({k: i.get(k) for k in IMAGE_KEYS})) for i in page.get_image_info(hashes=True) if near(i['bbox'])], key=repr)
    return objects(src_page) == objects(out_page)

def _ink(pix, page, chars):
    """Per character: True/False whether a letter or digit leaves ink against its own line's background, None when
    it is not a letter or digit or has no pixel area."""
    rows = {}
    for k, ch in enumerate(chars): rows.setdefault(round(ch.base, 1), []).append(k)
    n, stride, data = pix.n, pix.stride, pix.samples
    pixel = lambda x, y: data[y * stride + x * n:y * stride + x * n + n]
    flags = [None] * len(chars)
    for row in rows.values():
        x0, y0, x1, y1 = _px(pix, page, _union([chars[k].box for k in row]))
        background = Counter(pixel(x, y) for y in range(y0, y1) for x in range(x0, x1)).most_common(1)
        if not background: continue
        bg = background[0][0]
        for k in row:
            ch = chars[k]
            if not ch.c.isalnum(): continue
            cx0, cy0, cx1, cy1 = _px(pix, page, ch.box)
            if cx1 <= cx0 or cy1 <= cy0: continue
            flags[k] = any(max(abs(p - q) for p, q in zip(pixel(x, y), bg)) > INK_DELTA for y in range(cy0, cy1) for x in range(cx0, cx1))
    return flags

def _box_eq(a, b): return all(abs(x - y) <= 0.01 for x, y in zip(a, b))

def _rigid(run):
    """True when a run of (source, output) glyph pairs (at least two, same character and exact style) moved by one
    common nonzero vector of at most RIGID_TOL: every pair's baseline and box deltas lie within DRIFT_TOL of the first
    pair's, and each box kept its shape (x0/x1 and y0/y1/baseline deltas agree within DRIFT_TOL)."""
    if len(run) < 2 or any(s.c != o.c or s.style != o.style for s, o in run): return False
    deltas = [(o.box[0] - s.box[0], o.box[2] - s.box[2], o.base - s.base, o.box[1] - s.box[1], o.box[3] - s.box[3]) for s, o in run]
    ref = deltas[0]
    if any(abs(d[0] - d[1]) > DRIFT_TOL or max(d[2:]) - min(d[2:]) > DRIFT_TOL for d in deltas): return False
    if any(abs(a - b) > DRIFT_TOL for d in deltas for a, b in zip(d, ref)): return False
    return 0 < max(abs(v) for d in deltas for v in d) <= RIGID_TOL

def check_page(src_page, out_page, model, picks, mupdf, raster, max_chars):
    """Regional QA of one edited output page against its source page. picks: [(selected source char indices, After,
    source styles)] for every edit on the page, all resolved. Returns ({code: status}, {limitation keys})."""
    if src_page.rotation or not _box_eq(src_page.cropbox, src_page.mediabox):
        return dict.fromkeys(CODES, 'warning'), {'regional_partial'}
    if out_page.rotation or not _box_eq(out_page.mediabox, src_page.mediabox) or not _box_eq(out_page.cropbox, out_page.mediabox):
        return {'edited_page_render': 'failed'}, {'regional'}
    out_model = page_model(out_page, mupdf, max_chars)
    if out_model is None: return dict.fromkeys(CODES, 'warning'), {'budget'}
    S, O, res, notes = model.chars, out_model.chars, {}, {'regional'}
    selected, first, afters = {}, {}, {}
    for k, (picked, after, _) in enumerate(picks):
        selected.update(dict.fromkeys(picked, k))
        first[k], afters[k] = min(picked), re.sub(r'\s+', '', after)
    src_rows, out_rows = _rows(S), _rows(O)
    row_of = {i: r for r, (_, row) in enumerate(src_rows) for i in row}
    edited = sorted({row_of[i] for i in selected})
    # Expected characters of the edited lines: unselected source characters kept, each Before replaced by its After.
    expected = []
    for r in edited:
        for i in src_rows[r][1]:
            k = selected.get(i)
            if k is None: expected.append((S[i].c, i, None))
            elif i == first[k]: expected += [(c, None, k) for c in afters[k]]
    # Same placement: every edited source line has exactly one output line on its baseline, and together they hold
    # exactly the expected characters. Anything else is reflow, which is only partially compared.
    used, mapped, strict = set(), [], True
    for r in edited:
        near = [q for q, (base, _) in enumerate(out_rows) if abs(base - src_rows[r][0]) <= BASE_TOL and q not in used]
        if len(near) != 1: strict = False; break
        used.add(near[0]); mapped.append(near[0])
    aligned = [j for q in mapped for j in out_rows[q][1]] if strict else []
    strict = strict and ''.join(O[j].c for j in aligned) == ''.join(c for c, _, _ in expected)
    if not strict: used = set()
    blocks, edited_set, by_text = {S[i].block for i in selected}, set(edited), {}
    for q, (_, row) in enumerate(out_rows):
        if q not in used: by_text.setdefault(_text(O, row), []).append(q)
    # text_font/after_font: a font name changed without a proven size, color or metric change (unverified, warning).
    lost = restyled = moved = text_font = after_font = False
    pairs = []  # (source, output) characters of unedited lines matched in place: candidates for float32 drift noise
    runs = []   # consecutive (source, output) pairs of one line or kept stretch: candidates for a rigid translation
    first_row = lambda row, hits, placed: next(((q, v) for q in hits for v in (_same_row(S, row, O, out_rows[q][1], placed),) if v), None)
    for r, (_, row) in enumerate(src_rows):
        if r in edited_set or (not strict and any(S[i].block in blocks for i in row)): continue
        hits = [q for q in by_text.get(_text(S, row), ()) if q not in used]
        match = first_row(row, hits, True)
        if match is not None:
            runs.append([(S[i], O[j]) for i, j in zip(row, out_rows[match[0]][1])]); pairs += runs[-1]
        else:
            match = first_row(row, hits, False)
            if match is not None: moved = True
            elif hits: match, restyled = (hits[0], None), True
            else: lost = True
        if match is not None: used.add(match[0]); text_font |= match[1] == 'font'
    refs = {}
    for ch in S: refs.setdefault((ch.c, ch.style), []).append(_width(ch))
    # zones: output-side areas that may legitimately differ but are outside the sealed source regions (warning only).
    boxes, style_bad, unknown, zones, kept = {k: [] for k in afters}, False, False, [], []
    stretch = None  # source row of the current kept stretch of an edited line (broken by a selection or a new line)
    if strict:
        for (_, i, k), j in zip(expected, aligned):
            if k is not None:
                stretch = None
                boxes[k].append(O[j])
                v = _after_glyph(picks[k][2], O[j], refs)
                style_bad |= v == 'bad'; after_font |= v == 'font'
                zones.append(O[j].box)
                continue
            # Unselected text on an edited line keeps its style; it may only slide along its own baseline.
            v = _glyph(S[i].style, O[j], [_width(S[i])])
            restyled |= v == 'bad'; text_font |= v == 'font'
            kept.append((S[i], O[j]))
            if stretch != row_of[i]: stretch = row_of[i]; runs.append([])
            runs[-1].append(kept[-1])
            if abs(S[i].box[0] - O[j].box[0]) > POS_TOL or abs(S[i].box[2] - O[j].box[2]) > POS_TOL: zones += [S[i].box, O[j].box]
        res['edited_page_text'] = ('failed' if lost or restyled or moved else
            'warning' if text_font or len(used) < len(out_rows) else 'passed')
    else:
        notes.add('regional_partial')
        res['edited_page_text'] = 'failed' if lost or restyled else 'warning'
        for k, after in afters.items():
            hits = _find(out_model.stream, after)
            if len(hits) != 1: unknown = True; continue
            boxes[k] = O[hits[0]:hits[0] + len(after)]
            vs = {_after_glyph(picks[k][2], ch, refs) for ch in boxes[k]}
            style_bad |= 'bad' in vs; after_font |= 'font' in vs
    if text_font or after_font: notes.add('regional_partial')
    res['edited_region_style'] = 'failed' if style_bad else 'warning' if unknown or after_font else 'passed'
    trace = out_page.get_texttrace()
    if sum(len(s.get('chars', ())) for s in trace) > max_chars:
        notes.add('budget'); res['edited_region_visible'] = 'warning'; trace = None
    pa, pb = raster(src_page), raster(out_page)
    if trace is not None:
        hidden = [s['bbox'] for s in trace if s.get('type') == 3 or s.get('opacity', 1) == 0]
        overlaps = lambda a, b: min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])
        after = [ch for chars in boxes.values() for ch in chars]
        shown = after + [o for _, o in kept]
        # Every After letter must leave ink; kept same-line letters must still leave ink where the source did.
        lost_ink = any(f is False for f in _ink(pb, out_page, after))
        if kept:
            was, now = _ink(pa, src_page, [s for s, _ in kept]), _ink(pb, out_page, [o for _, o in kept])
            lost_ink |= any(w and n is False for w, n in zip(was, now))
        invisible = lost_ink or any(overlaps(ch.box, h) for ch in shown for h in hidden)
        res['edited_region_visible'] = 'failed' if invisible else 'warning' if unknown else 'passed'
    if not strict:
        res['edited_page_render'] = 'warning'; return res, notes
    pairs += [(s, o) for s, o in kept if abs(s.box[0] - o.box[0]) <= POS_TOL and abs(s.box[2] - o.box[2]) <= POS_TOL]
    drifted = [(s, o) for s, o in pairs if s.c == o.c and s.style == o.style and
        0 < max(abs(s.base - o.base), *(abs(a - b) for a, b in zip(s.box, o.box))) <= DRIFT_TOL]
    # A kept stretch that slid along its line (zones) moved beyond RIGID_TOL and is never rigid.
    seen = {id(o) for _, o in drifted}
    drifted += [p for run in runs if _rigid(run) for p in run if id(p[1]) not in seen]
    matched = {id(o) for _, o in pairs} | {id(ch) for chars in boxes.values() for ch in chars}
    unmatched = [o.box for o in O if id(o) not in matched]
    explain = lambda high: bool(drifted) and _drift_noise(high, pa, pb, src_page, out_page, drifted, unmatched)
    # Sealed: tight per-line boxes of the selected SOURCE characters only (never whole lines or output boxes).
    by_line = {}
    for i in selected: by_line.setdefault(S[i].line, []).append(S[i].box)
    sealed = [_union(b) for b in by_line.values()]
    area = sum((b[2] - b[0] + 2 * BLEED) * (b[3] - b[1] + 2 * BLEED) for b in sealed)
    if area > LIMITS['maxMaskFraction'] * src_page.rect.width * src_page.rect.height:
        notes.add('regional_partial'); res['edited_page_render'] = 'warning'
    else:
        res['edited_page_render'], partial = _masked_diff(pa, pb, src_page, sealed, zones, explain)
        if partial: notes.add('regional_partial')
    return res, notes

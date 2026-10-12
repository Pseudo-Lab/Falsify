"""EXPERIMENTAL deterministic fixed-area text layout probe for one exact user After (metrics only; edits nothing).

Public API:
  propose_layout(after, bbox, font, font_size, line_height, obstacles=()) -> private result {schema:'falsify.pdf-layout-probe.v1', ...}
  propose_from_source(source_bytes, edit, line_height, *, bbox=None, obstacles=()) -> the same, with font and size read only from
      paper_inventory.build_edit_plan for one resolved, single-line, single-style horizontal edit; anything else is 'unsupported'
  reconstruct(result, after) -> the exact After rebuilt only from a 'fits' result's offsets, else None

The probe answers one question: would this exact After, drawn left-aligned in the given fixed font, size and line pitch, fit inside
the given box without entering the given obstacles? status is fits|overflow|unsupported. It never shrinks the font or the line
pitch, never adds a page or a line outside the box, never hyphenates or splits a Latin/digit/sign run, never hangs punctuation
past the box, never rewrites the After and never guesses a glyph: a character the font program has no glyph for, or a control or
format character, makes the result 'unsupported' with no positions. Widths are PyMuPDF Font advances (no kerning, shaping or
ligatures): metrics-only evidence, not a guarantee that the source font, its PDF encoding or a renderer would draw these shapes.
A multi-line proposal whose line bands (ascender to descender of the font metrics) would overlap at the caller's pitch is
'unsupported' (reason 'line-bands-overlap'), never 'fits': metrics cannot prove the actual ink of adjacent lines stays apart.
That is a conservative refusal, not proof of a broken PDF; the probe never raises the pitch or shrinks the font to avoid it.
The box is geometry, not edit authority. The result is private (offsets, hashes and coordinates, never text). Nothing here edits,
masks, flattens or writes a PDF; the source wrapper only reads the source bytes.

Line breaking borrows ideas, not code, from BabelDOC's typesetting midend (AGPL-3.0; funstory-ai/BabelDOC commit
38d3896dcde9b5a940c62cf5563cadea673a64d3, babeldoc/format/pdf/document_il/midend/typesetting.py): break only at spaces or next
to CJK characters, keep closing punctuation off a line start and opening punctuation off a line end, drop spaces at a soft break,
and keep laying out after the box is full so an overflow is measured. Its scale search (font shrinking), punctuation hanging,
CJK/Latin spacing insertion, first-line indent, font substitution and box expansion are deliberately not used.
"""
import hashlib
import math
import unicodedata

SCHEMA = 'falsify.pdf-layout-probe.v1'
STATUSES = ('fits', 'overflow', 'unsupported')
BABELDOC = {'repository': 'https://github.com/funstory-ai/BabelDOC', 'commit': '38d3896dcde9b5a940c62cf5563cadea673a64d3',
    'file': 'babeldoc/format/pdf/document_il/midend/typesetting.py', 'license': 'AGPL-3.0-only',
    'use': 'line-breaking ideas re-implemented; no BabelDOC code copied, imported or executed'}
POLICY = {'fontShrink': False, 'lineHeightShrink': False, 'pageAddition': False, 'hyphenation': False, 'punctuationHanging': False,
    'textRewrite': False, 'pdfMutation': False, 'qaMasks': False, 'productionExport': False}
LIMITS = {'maxChars': 4000, 'maxObstacles': 256, 'maxSlots': 4000, 'maxCoordinate': 100000.0, 'maxFontSize': 1000.0}
EPS = 0.01   # points; edge tolerance (source-plan regions are rounded to 0.001 pt)
BUILTIN = ('helv', 'heit', 'hebo', 'hebi', 'tiro', 'tiit', 'tibo', 'tibi', 'cour', 'coit', 'cobo', 'cobi', 'symb', 'zadb', 'cjk')
BASE14 = {'Helvetica': 'helv', 'Helvetica-Oblique': 'heit', 'Helvetica-Bold': 'hebo', 'Helvetica-BoldOblique': 'hebi',
    'Times-Roman': 'tiro', 'Times-Italic': 'tiit', 'Times-Bold': 'tibo', 'Times-BoldItalic': 'tibi', 'Courier': 'cour',
    'Courier-Oblique': 'coit', 'Courier-Bold': 'cobo', 'Courier-BoldOblique': 'cobi', 'Symbol': 'symb', 'ZapfDingbats': 'zadb'}
BAD_CATEGORIES = ('Cc', 'Cf', 'Cs', 'Co', 'Cn', 'Zl', 'Zp')   # tabs, controls, soft hyphen, joiners, surrogates, unassigned
NO_LINE_START = frozenset(',.:;?!)]}%’”…–—·、。〉》」』】〕〗'
    '・ー！），．：；？］｝～')
NO_LINE_END = frozenset('([{‘“〈《「『【〔〖〘〚（［｛')

class _Overflow(Exception):
    def __init__(self, kind, offset): super().__init__(kind); self.kind, self.offset = kind, offset

def _sha(text): return hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()
def _number(v): return type(v) in (int, float) and math.isfinite(v) and abs(v) <= LIMITS['maxCoordinate']
def _round(v): return round(float(v), 4)

def _rect(value, strict):
    """(x0, y0, x1, y1) floats for a finite, ordered 4-sequence (positive area when strict), else None."""
    if not isinstance(value, (list, tuple)) or len(value) != 4 or not all(_number(v) for v in value): return None
    x0, y0, x1, y1 = (float(v) for v in value)
    ordered = (x0 < x1 and y0 < y1) if strict else (x0 <= x1 and y0 <= y1)
    return (x0, y0, x1, y1) if ordered else None

def _cjk(c):
    o = ord(c)
    return unicodedata.east_asian_width(c) in ('W', 'F') or 0x1100 <= o <= 0x11FF or 0xA960 <= o <= 0xA97F or 0xD7B0 <= o <= 0xD7FF

def _cjk_break(prev, cur):
    """Zero-width break opportunity between two non-space characters: only next to a CJK character, never before closing
    punctuation or a combining mark and never after opening punctuation. Latin, digits and signs (-0.42) stay whole."""
    if not (_cjk(prev) or _cjk(cur)): return False
    return prev not in NO_LINE_END and cur not in NO_LINE_START and unicodedata.category(cur) not in ('Mn', 'Mc', 'Me')

def _tokens(text, a, b, adv):
    """Unbreakable pieces ('space'|'word', start, end, width) of text[a:b], which holds no line break. Two adjacent words are
    separated by a zero-width CJK break opportunity."""
    out, i = [], a
    while i < b:
        j = i + 1
        if text[i] == ' ':
            while j < b and text[j] == ' ': j += 1
        else:
            while j < b and text[j] != ' ' and not _cjk_break(text[j - 1], text[j]): j += 1
        width = 0.0
        for c in text[i:j]: width += adv[c]
        out.append(('space' if text[i] == ' ' else 'word', i, j, width))
        i = j
    return out

def _layout(after, box, size, pitch, asc, desc, obstacles, adv):
    """Greedy left-aligned lines over fixed slots (slot k: top y0 + k*pitch, baseline top + ascender*size). Raises _Overflow
    for a piece wider than the box; otherwise returns (lines, slots inside the box), continuing below the box if needed."""
    x0, y0, x1, y1 = box
    glyph = (asc - desc) * size
    inside = 0 if glyph > y1 - y0 + EPS else int((y1 - y0 - glyph + EPS) // pitch) + 1

    def segment(s):
        """Widest free (x, limit) of slot s after removing obstacles that meet its glyph band; a slot below the box is
        virtual (full width, used only to count the lines an overflow needs)."""
        if s >= inside: return x0, x1
        top = y0 + s * pitch
        free = [(x0, x1)]
        for ox0, oy0, ox1, oy1 in obstacles:
            if oy0 >= top + glyph or oy1 <= top or ox0 >= x1 or ox1 <= x0: continue
            free = [p for a, b in free for p in ((a, min(b, ox0)), (max(a, ox1), b)) if p[1] > p[0]]
        return max(free, key=lambda p: (p[1] - p[0], -p[0])) if free else None

    def open_line(start, width, s):
        if width > x1 - x0 + EPS: raise _Overflow('unbreakable-width', start)
        while s < LIMITS['maxSlots']:
            seg = segment(s)
            if seg and width <= seg[1] - seg[0] + EPS:
                return {'slot': s, 'start': start, 'end': start, 'x': seg[0], 'limit': seg[1], 'cursor': seg[0]}
            s += 1
        raise _Overflow('slot-budget', start)

    lines, pos, n, slot = [], 0, len(after), 0
    while True:
        b = pos
        while b < n and after[b] not in '\r\n': b += 1
        line, pending = None, None
        for kind, i, j, w in _tokens(after, pos, b, adv):
            if kind == 'space' and line is not None:
                pending = (i, j, w); continue
            gap = pending[2] if pending else 0.0
            if line is not None and line['cursor'] + gap + w <= line['limit'] + EPS:
                line['cursor'] += gap + w; line['end'] = j; pending = None; continue
            if line is not None:   # soft break: the pending space run (or a CJK zero-width break) is consumed, not drawn
                lines.append(line); slot = line['slot'] + 1
            line = open_line(i, w, slot)
            line['cursor'] += w; line['end'] = j; pending = None
        if line is None: line = open_line(pos, 0.0, slot)   # an empty paragraph still takes one line
        if pending and line['cursor'] + pending[2] <= line['limit'] + EPS:
            line['cursor'] += pending[2]; line['end'] = pending[1]
        lines.append(line); slot = line['slot'] + 1
        if b >= n: return lines, inside
        pos = b + (2 if after.startswith('\r\n', b) else 1)

def _result(after, status, reason, **extra):
    out = {'schema': SCHEMA, 'experimental': True, 'status': status, 'reason': reason,
        'binding': {'afterSha256': _sha(after) if isinstance(after, str) else None,
            'afterChars': len(after) if isinstance(after, str) else None, 'textModified': False},
        'fixed': None, 'metrics': None, 'region': {'owner': 'caller', 'editAuthority': False},
        'lines': None, 'overflow': None, 'characters': None, 'policy': dict(POLICY), 'inspiration': dict(BABELDOC)}
    out.update(extra)
    return out

def _builtin(font):
    """(pymupdf.Font, origin, None) for a caller Font object or an allow-listed PyMuPDF built-in name, else (None, reason, None)."""
    try:
        import pymupdf
    except ImportError:
        return None, 'pymupdf-unavailable', None
    if isinstance(font, pymupdf.Font): return font, 'caller-font-object', None
    if isinstance(font, str) and font in BUILTIN: return pymupdf.Font(font), 'pymupdf-builtin:' + font, None
    return None, 'font-unavailable', None

def _propose(after, bbox, resolved, size, pitch, obstacles, region):
    if not isinstance(after, str): return _result(after, 'unsupported', 'after-not-text')
    if not after.strip(): return _result(after, 'unsupported', 'after-empty')
    if len(after) > LIMITS['maxChars']: return _result(after, 'unsupported', 'after-too-long')
    box = _rect(bbox, True)
    if box is None: return _result(after, 'unsupported', 'invalid-bbox', region=region)
    if not _number(size) or not 0 < size <= LIMITS['maxFontSize']: return _result(after, 'unsupported', 'invalid-font-size', region=region)
    if not _number(pitch) or pitch <= 0: return _result(after, 'unsupported', 'invalid-line-height', region=region)
    if not isinstance(obstacles, (list, tuple)): return _result(after, 'unsupported', 'invalid-obstacles', region=region)
    if len(obstacles) > LIMITS['maxObstacles']: return _result(after, 'unsupported', 'too-many-obstacles', region=region)
    rects = [_rect(o, False) for o in obstacles]
    if any(r is None for r in rects): return _result(after, 'unsupported', 'invalid-obstacles', region=region)
    font, origin, vertical = resolved
    if font is None: return _result(after, 'unsupported', origin, region=region)
    asc, desc = (float(v) for v in vertical or (font.ascender, font.descender))
    fixed = {'bbox': [_round(v) for v in box], 'fontSize': float(size), 'lineHeight': float(pitch), 'alignment': 'left',
        'obstacles': len(rects)}
    if not (math.isfinite(asc) and math.isfinite(desc) and asc > desc):
        return _result(after, 'unsupported', 'font-metrics-unavailable', fixed=fixed, region=region)
    import pymupdf
    metrics = {'kind': 'metrics-only', 'advances': 'pymupdf.Font.char_lengths', 'pymupdf': pymupdf.VersionBind,
        'fontName': str(font.name)[:128], 'fontOrigin': origin, 'verticalMetrics': 'source-span' if vertical else 'font-program',
        'ascender': _round(asc), 'descender': _round(desc),
        'kerning': False, 'shaping': False, 'ligatures': False, 'sourceShapeGuarantee': False}
    chars = sorted(set(after) - {'\r', '\n'})
    bad = [c for c in chars if unicodedata.category(c) in BAD_CATEGORIES]
    missing = [c for c in chars if c not in bad and not font.has_glyph(ord(c))]
    characters = {'distinct': len(chars), 'unsupported': ['U+%04X' % ord(c) for c in bad][:32],
        'missingGlyphs': ['U+%04X' % ord(c) for c in missing][:32], 'missingCount': len(missing)}
    common = {'fixed': fixed, 'metrics': metrics, 'region': region, 'characters': characters}
    if bad: return _result(after, 'unsupported', 'unsupported-character', **common)
    if missing: return _result(after, 'unsupported', 'missing-glyphs', **common)
    adv = {c: float(font.char_lengths(c, fontsize=float(size))[0]) for c in chars}
    try: lines, inside = _layout(after, box, float(size), float(pitch), asc, desc, sorted(rects), adv)
    except _Overflow as o:
        return _result(after, 'overflow', o.kind, overflow={'kind': o.kind, 'firstUnplacedOffset': o.offset,
            'availableLines': None, 'requiredLines': None}, **common)
    used = lines[-1]['slot'] + 1
    if used > inside:
        first = next(l['start'] for l in lines if l['slot'] >= inside)
        return _result(after, 'overflow', 'height', overflow={'kind': 'height', 'firstUnplacedOffset': first,
            'availableLines': inside, 'requiredLines': used}, **common)
    glyph = (asc - desc) * float(size)
    if any((b['slot'] - a['slot']) * float(pitch) < glyph for a, b in zip(lines, lines[1:])):
        # every proposed line (an empty paragraph too) owns its full band; adjacent bands may touch but never overlap
        return _result(after, 'unsupported', 'line-bands-overlap', **common)
    out = []
    for l in lines:
        top = box[1] + l['slot'] * pitch
        out.append({'slot': l['slot'], 'start': l['start'], 'end': l['end'], 'x': _round(l['x']), 'top': _round(top),
            'baseline': _round(top + asc * size), 'bottom': _round(top + (asc - desc) * size), 'width': _round(l['cursor'] - l['x'])})
    return _result(after, 'fits', None, lines=out, **common)

def propose_layout(after, bbox, font, font_size, line_height, obstacles=()):
    """Fixed-area layout proposal for the exact After in a caller-owned box: font is a pymupdf.Font or a built-in name in
    BUILTIN; bbox and obstacles are [x0, y0, x1, y1] in top-left-origin page points. Never raises for bad input."""
    try: return _propose(after, bbox, _builtin(font), font_size, line_height, obstacles, {'owner': 'caller', 'editAuthority': False})
    except Exception:
        return _result(after if isinstance(after, str) else None, 'unsupported', 'probe-error')

def _source_font(source, page_index, name, size):
    """(pymupdf.Font, origin, vertical) for the one page font named by the plan style font, read only, else (None, reason, None). The base
    name (subset tag removed) must equal it; MuPDF truncates long span font names, so only when no font matches exactly may a
    single page font whose base name starts with it be used (origin says so). An embedded program gives its own advances and
    cmap coverage (a subset or CID font without a Unicode cmap lacks them); a non-embedded base-14 font gives PyMuPDF's built-in
    metrics for that name. vertical is the one (ascender, descender) MuPDF reports for spans of this font and size (the metrics
    behind the plan's character boxes), else None."""
    import pymupdf
    doc = pymupdf.open(stream=source, filetype='pdf')
    try:
        exact, prefix = {}, {}
        for xref, _ext, kind, basefont, *_rest in doc[page_index].get_fonts(full=True):
            base = basefont.split('+', 1)[-1]
            if name in (basefont, base): exact[xref] = kind
            elif name and base.startswith(name): prefix[xref] = kind
        found, how = (exact, '') if exact else (prefix, ':name-prefix')
        if not found: return None, 'source-font-not-found', None
        if len(found) > 1: return None, 'source-font-ambiguous', None
        xref, kind = next(iter(found.items()))
        if kind == 'Type3': return None, 'source-font-type3', None
        spans = {(float(s.get('ascender', 0)), float(s.get('descender', 0))) for b in doc[page_index].get_text('dict').get('blocks', [])
            for l in b.get('lines', []) for s in l.get('spans', []) if s.get('font') == name and round(float(s.get('size', 0)), 3) == size}
        vertical = next(iter(spans)) if len(spans) == 1 else None
        buffer = doc.extract_font(xref)[3]
        if buffer:
            try: return pymupdf.Font(fontbuffer=buffer), 'source-embedded-program' + how, vertical
            except Exception: return None, 'source-font-program-unreadable', None
        if name in BASE14: return pymupdf.Font(BASE14[name]), 'base14-builtin-metrics', vertical
        return None, 'source-font-not-embedded', None
    finally:
        doc.close()

def propose_from_source(source_bytes, edit, line_height, *, bbox=None, obstacles=()):
    """Read-only source wrapper: font and size come from paper_inventory.build_edit_plan (the existing source contract) for one
    {id, pageIndex, before, after} edit that resolves to exactly one horizontal line region in one style. The box defaults to that
    tight source region (still geometry, not edit authority). The source bytes are never written."""
    after = edit.get('after') if isinstance(edit, dict) else None
    try:
        import paper_inventory
        source = bytes(source_bytes) if isinstance(source_bytes, (bytes, bytearray)) else b''
        plan = paper_inventory.build_edit_plan(source, [edit])
        entry = plan['edits'][0]
        origin = {'sourceSha256': plan['sourceSha256'], 'planSchema': plan['schema'], 'editStatus': entry['status'],
            'regions': len(entry['regions']), 'styles': len(entry['styles'])}
        region = {'owner': 'caller' if bbox is not None else 'source-edit-plan', 'editAuthority': False, 'source': origin}
        if entry['status'] != 'resolved' or len(entry['regions']) != 1 or len(entry['styles']) != 1:
            return _result(after, 'unsupported', 'source-not-simple', region=region)
        style = entry['styles'][0]
        resolved = _source_font(source, edit['pageIndex'], style['font'], style['size'])
        return _propose(after, entry['regions'][0] if bbox is None else bbox, resolved, style['size'], line_height, obstacles, region)
    except ValueError:
        return _result(after, 'unsupported', 'invalid-edit')
    except Exception:
        return _result(after, 'unsupported', 'probe-error')

def reconstruct(result, after):
    """The exact After rebuilt only from a 'fits' result: each line's drawn run plus the spaces/line breaks consumed before the
    next line. None unless the result is bound to this After and its offsets are ordered, contiguous and lose no drawn char."""
    try:
        if not isinstance(after, str) or not isinstance(result, dict) or result.get('schema') != SCHEMA or result.get('status') != 'fits' \
                or result['binding']['afterSha256'] != _sha(after) or not result['lines']: return None
        pieces, prev = [], 0
        for k, line in enumerate(result['lines']):
            s, e = line['start'], line['end']
            if type(s) is not int or type(e) is not int or not prev <= s <= e <= len(after): return None
            gap = after[prev:s]
            if (k == 0 and gap) or gap.strip(' \r\n'): return None
            pieces += [gap, after[s:e]]; prev = e
        tail = after[prev:]
        if tail.strip(' '): return None
        text = ''.join(pieces) + tail
        return text if text == after else None
    except (KeyError, TypeError):
        return None

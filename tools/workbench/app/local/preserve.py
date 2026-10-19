"""Conservative PDF edits: same line/font, no reflow, unchanged exterior pixels.

A shorter After does not leave a hole before the rest of its line: when that rest is drawn by the same text operator,
it moves left along its baseline by exactly the width the line lost (the original gap after the selection is kept),
and every moved glyph is verified at that exact position; otherwise the original positions are kept as before.

PyMuPDF is optional and is AGPL/commercial licensed; see docs/document-red.md.
No Word/HTML renderer is configured: those exports fail closed, not reconstruct.
"""
import base64
import hashlib
import re
import struct

from pdf_typography import (EPS, MAX_TRACKING_EM, MICRO_OVERLAP_PT, MIN_SPACE_RATIO, TIGHT_SPACE_RATIO, find_show, plan_fit,
    rewrite_items, rewrite_parts, serialize_tj, source_space_range, verify_fit)
from pdf_font_codec import font_codec  # Base14/Type0 existing-font codec (separate module).

def font_names(buffer):
    """Read bounded SFNT name records (no font substitution or fuzzy matching)."""
    if len(buffer) < 12: return []
    count = struct.unpack_from('>H', buffer, 4)[0]
    if count > 256 or len(buffer) < 12 + 16 * count: return []
    for i in range(count):
        tag, _, start, length = struct.unpack_from('>4sIII', buffer, 12 + i * 16)
        if tag != b'name': continue
        if start + length > len(buffer) or length < 6: return []
        _, records, strings = struct.unpack_from('>HHH', buffer, start)
        if records > 1024 or 6 + 12 * records > length: return []
        names = []
        for j in range(records):
            platform, encoding, language, name_id, size, offset = struct.unpack_from('>HHHHHH', buffer, start + 6 + j * 12)
            if name_id not in [1, 4, 6] or strings + offset + size > length: continue
            try: names.append(buffer[start+strings+offset:start+strings+offset+size].decode('utf-16be' if platform in [0,3] else 'mac_roman'))
            except UnicodeError: pass
        return names
    return []

BASE14 = {'Helvetica': 'helv', 'Helvetica-Bold': 'hebo', 'Helvetica-Oblique': 'heit',
    'Helvetica-BoldOblique': 'hebi', 'Times-Roman': 'tiro', 'Times-Bold': 'tibo',
    'Times-Italic': 'tiit', 'Times-BoldItalic': 'tibi', 'Courier': 'cour',
    'Courier-Bold': 'cobo', 'Courier-Oblique': 'coit', 'Courier-BoldOblique': 'cobi'}

def parse_to_unicode(data):
    """Strictly parse a simple-font ToUnicode CMap (1-byte codespace) into {code: text}.

    Returns None (fail closed) for usecmap, multi-byte or missing codespace, malformed or
    unexpected tokens, conflicting duplicate codes, invalid UTF-16 or oversized input.
    """
    if not data or len(data) > 256 * 1024: return None
    text = data.decode('latin-1')
    if re.search(r'\busecmap\b', text): return None
    spaces = re.findall(r'begincodespacerange(.*?)endcodespacerange', text, re.S)
    if not spaces: return None
    for body in spaces:
        pairs = re.findall(r'<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>', body)
        if not pairs or re.sub(r'<[0-9A-Fa-f]*>\s*<[0-9A-Fa-f]*>', '', body).strip(): return None
        if any(len(lo) != 2 or len(hi) != 2 or int(lo, 16) > int(hi, 16) for lo, hi in pairs): return None
    def utf16(h):
        if not h or len(h) % 4: raise ValueError()
        return bytes.fromhex(h).decode('utf-16be')
    mapping = {}
    def put(code, value):
        if mapping.get(code, value) != value: raise ValueError()
        mapping[code] = value
    hexstr = r'<([0-9A-Fa-f]*)>'
    try:
        for count, body in re.findall(r'(\d+)\s+beginbfchar(.*?)endbfchar', text, re.S):
            entries = re.findall(hexstr + r'\s*' + hexstr, body)
            if len(entries) != int(count) or re.sub(r'<[0-9A-Fa-f]*>\s*<[0-9A-Fa-f]*>', '', body).strip(): return None
            for src, dst in entries:
                if len(src) != 2: return None
                put(int(src, 16), utf16(dst))
        range_entry = r'<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>\s*(<[0-9A-Fa-f]*>|\[(?:\s*<[0-9A-Fa-f]*>)*\s*\])'
        for count, body in re.findall(r'(\d+)\s+beginbfrange(.*?)endbfrange', text, re.S):
            entries = re.findall(range_entry, body)
            if len(entries) != int(count) or re.sub(range_entry, '', body).strip(): return None
            for lo, hi, dst in entries:
                if len(lo) != 2 or len(hi) != 2: return None
                lo, hi = int(lo, 16), int(hi, 16)
                if lo > hi: return None
                if dst.startswith('['):
                    items = re.findall(hexstr, dst)
                    if len(items) != hi - lo + 1: return None
                    for i, item in enumerate(items): put(lo + i, utf16(item))
                else:
                    base = bytes.fromhex(dst[1:-1])
                    if len(base) < 2 or len(base) % 2: return None
                    for i in range(hi - lo + 1):
                        last = int.from_bytes(base[-2:], 'big') + i
                        if last > 0xFFFF: return None
                        put(lo + i, utf16((base[:-2] + last.to_bytes(2, 'big')).hex()))
    except ValueError: return None
    # Every bf section must have been consumed by the strict patterns above.
    if len(re.findall(r'beginbf(?:char|range)', text)) != len(re.findall(r'\d+\s+beginbf(?:char|range)', text)): return None
    return mapping

def truetype_symbolic_gid(buffer, code):
    """GID for a code in a symbolic TrueType's (3,0) or (1,0) cmap (PDF 32000 9.6.6.4).

    Returns a GID in 1..numGlyphs-1, 0 if the cmap has no glyph for the code, or None if the
    font cannot be parsed (callers must treat None as unverifiable, never as present).
    """
    try:
        count = struct.unpack_from('>H', buffer, 4)[0]
        if count > 256: return None
        directory = {}
        for i in range(count):
            tag, _, offset, size = struct.unpack_from('>4sIII', buffer, 12 + i * 16)
            directory[tag] = (offset, size)
        if b'cmap' not in directory or b'maxp' not in directory: return None
        start, length = directory[b'cmap']
        if start + length > len(buffer): return None
        glyphs = struct.unpack_from('>H', buffer, directory[b'maxp'][0] + 4)[0]
        tables = {}
        for i in range(min(struct.unpack_from('>H', buffer, start + 2)[0], 64)):
            platform, encoding, offset = struct.unpack_from('>HHI', buffer, start + 4 + i * 8)
            tables.setdefault((platform, encoding), start + offset)
        for key, lookup in [((3, 0), [0xF000 + code, code, 0xF100 + code, 0xF200 + code]), ((1, 0), [code])]:
            if key not in tables: continue
            at = tables[key]
            fmt = struct.unpack_from('>H', buffer, at)[0]
            for c in lookup:
                gid = 0
                if fmt == 0 and c < 256: gid = buffer[at + 6 + c]
                elif fmt == 6:
                    first, n = struct.unpack_from('>HH', buffer, at + 6)
                    if first <= c < first + n: gid = struct.unpack_from('>H', buffer, at + 10 + 2 * (c - first))[0]
                elif fmt == 4:
                    segs = struct.unpack_from('>H', buffer, at + 6)[0] // 2
                    ends, starts = at + 14, at + 16 + 2 * segs
                    for s in range(segs):
                        end, begin = struct.unpack_from('>H', buffer, ends + 2 * s)[0], struct.unpack_from('>H', buffer, starts + 2 * s)[0]
                        if begin <= c <= end:
                            delta = struct.unpack_from('>h', buffer, starts + 2 * segs + 2 * s)[0]
                            ro_at = starts + 4 * segs + 2 * s
                            ro = struct.unpack_from('>H', buffer, ro_at)[0]
                            gid = (c + delta) & 0xFFFF if ro == 0 else struct.unpack_from('>H', buffer, ro_at + ro + 2 * (c - begin))[0]
                            if ro and gid: gid = (gid + delta) & 0xFFFF
                            break
                else: return None
                if gid: return gid if gid < glyphs else None
            return 0
        return None
    except (struct.error, IndexError): return None

def page_encoding_codes(doc, xref, fontbuffer, after, drawn):
    """Map After to the original simple font's own byte codes via its validated ToUnicode CMap.

    Used when the embedded program has no Unicode cmap (e.g. symbolic TrueType subsets),
    so glyph lookup by Unicode reports a false absence. A character is accepted only if
    exactly one code maps to it, the code has a positive /Widths entry, and the character
    is actually drawn with this font in the original document (proving the glyph exists).
    For a symbolic TrueType (no /Encoding) the code must also resolve to a nonzero GID in the
    embedded (3,0)/(1,0) cmap. `drawn` must come from spans of this exact font object only.
    Returns (codes, width_units) or raises ValueError naming the characters that are missing.
    """
    get = lambda key: doc.xref_get_key(xref, key)
    if get('Subtype')[1] not in ['/TrueType', '/Type1', '/MMType1'] or get('ToUnicode')[0] != 'xref':
        raise ValueError('원본 subset 글꼴의 문자 매핑(ToUnicode)을 검증할 수 없습니다. 원본 글꼴의 문자로 수정하세요.')
    mapping = parse_to_unicode(doc.xref_stream(int(get('ToUnicode')[1].split()[0])) or b'')
    first = int(get('FirstChar')[1]) if get('FirstChar')[0] == 'int' else None
    widths = [float(w) for w in re.findall(r'-?\d+(?:\.\d+)?', get('Widths')[1])] if get('Widths')[0] == 'array' else []
    last = int(get('LastChar')[1]) if get('LastChar')[0] == 'int' else None
    if mapping is None or first is None or last is None or not widths or len(widths) != last - first + 1:
        raise ValueError('원본 subset 글꼴의 문자 매핑(ToUnicode/Widths)을 검증할 수 없습니다. 원본 글꼴의 문자로 수정하세요.')
    symbolic_tt = get('Subtype')[1] == '/TrueType' and get('Encoding')[0] == 'null'
    reverse = {}
    for code, value in mapping.items(): reverse.setdefault(value, []).append(code)
    codes, units, absent, ambiguous, unproven = [], 0.0, [], [], []
    for c in after:
        found = reverse.get(c, [])
        if not found: absent.append(c); continue
        if len(found) != 1: ambiguous.append(c); continue
        code = found[0]
        width = widths[code - first] if 0 <= code - first < len(widths) else 0
        if symbolic_tt:
            gid = truetype_symbolic_gid(fontbuffer, code)
            if gid == 0: absent.append(c); continue
            if gid is None: unproven.append(c); continue
        if width <= 0 or c not in drawn: unproven.append(c); continue
        codes.append(code); units += width
    describe = lambda chars: ', '.join(repr(c) + f' (U+{ord(c):04X})' for c in dict.fromkeys(chars))
    if absent or ambiguous or unproven:
        parts = []
        if absent: parts.append('원본 subset 글꼴에 없는 문자: ' + describe(absent))
        if ambiguous: parts.append('글리프 매핑이 모호한 문자: ' + describe(ambiguous))
        if unproven: parts.append('원본에서 이 글꼴로 그려진 적이 없어 글리프를 검증할 수 없는 문자: ' + describe(unproven))
        raise ValueError('; '.join(parts) + '. 대체 글꼴을 쓰지 않습니다. 원본 문서에 이 글꼴로 이미 나오는 문자만 사용하도록 After를 수정하세요.')
    return codes, units

def font_resource_name(doc, page, xref):
    """Name under which the page's own /Resources/Font already references `xref`, else None."""
    names = [f[4] for f in page.get_fonts(full=True) if f[0] == xref and f[6] == 0]
    return names[0] if len(names) == 1 else None

def simple_widths(doc, xref):
    """{code: width in 1/1000 text space} from a simple font's /FirstChar and /Widths."""
    get = lambda key: doc.xref_get_key(xref, key)
    first = int(get('FirstChar')[1])
    return {first + i: float(w) for i, w in enumerate(re.findall(r'-?\d+(?:\.\d+)?', get('Widths')[1]))}

# Why an in-place rewrite of the original text operator could not be proved (find_show codes).
INPLACE_REASONS = {
    'spacing state': '선택한 텍스트에 기본값이 아닌 자간/단어 간격/기준선 이동/가로 비율(Tc/Tw/Ts/Tz)이 적용되어 있습니다',
    'font size': '텍스트 연산자의 실제 글꼴 크기(Tf x 텍스트/좌표 행렬)가 추출된 크기와 같음을 증명할 수 없습니다',
    'unbalanced q': '콘텐츠의 q/Q 그래픽 상태 저장·복원 짝이 맞지 않습니다', 'Q': '콘텐츠의 q/Q 그래픽 상태 저장·복원 짝이 맞지 않습니다',
    'undecodable': '같은 글꼴의 텍스트 연산자에 한 문자로 해석되지 않는 코드(합자 등)가 있습니다',
    'incomplete code': '원래 글꼴의 다중 바이트 코드가 불완전한 문자열이 있습니다',
    'duplicate': '같은 텍스트가 콘텐츠 안에서 여러 번 나와 고유하게 특정할 수 없습니다',
    "'": "따옴표 텍스트 연산자(')로 그려진 텍스트입니다", '"': '따옴표 텍스트 연산자(")로 그려진 텍스트입니다',
    'partial': '선택한 텍스트가 같은 글꼴의 연속된 텍스트 연산자 안에 있지 않습니다(다른 글꼴/객체로 나뉨)',
    'not found': '선택한 텍스트를 페이지 콘텐츠의 원래 텍스트 연산자에서 찾을 수 없습니다(폼 XObject 등)',
    'shared': '선택한 텍스트가 여러 페이지가 공유하는 콘텐츠 스트림에 있습니다',
    'resource': '페이지 리소스에서 원래 글꼴 객체의 이름을 고유하게 찾을 수 없습니다',
    'codec': '이 글꼴 형식의 원래 문자 코드/폭을 검증할 수 없습니다'}

def unsupported(label, code, detail=None):
    reason = INPLACE_REASONS.get(code) or f'콘텐츠 구조({code})를 해석할 수 없습니다'
    return ValueError(f"{label}: 지원하지 않는 PDF 구성이라 레이아웃 보존 다운로드를 만들지 않습니다 — {reason}"
        + (f' ({detail})' if detail else '') + '. 원래 글꼴 객체 재사용·원래 텍스트 연산자 제자리 수정·읽기 순서 보존을 모두 '
        '증명할 수 있을 때만 내보내며, 다른 글꼴을 추가하거나 지우고 덧붙이는 방식으로 대신 만들지 않습니다.')

def page_chars(raw):
    return [(c, span) for block in raw['blocks'] for line in block.get('lines', []) for span in line['spans']
        for c in span.get('chars', []) if not c.get('synthetic')]

def ink_boxes(page, raw):
    """id(char of raw) -> the glyph's outline box (MuPDF accurate bboxes), or {} when that extraction does not pair
    one-to-one with raw. A glyph whose outline box is empty keeps no entry (its line box is used) unless it is white
    space, which has no ink."""
    import pymupdf as fitz
    plain = page_chars(raw)
    accurate = page_chars(page.get_text('rawdict', flags=fitz.TEXTFLAGS_RAWDICT | fitz.TEXT_ACCURATE_BBOXES))
    if len(accurate) != len(plain) or any(a['c'] != b['c'] or max(abs(u - v) for u, v in zip(a['origin'], b['origin'])) > 1e-3
            for (a, _), (b, _) in zip(accurate, plain)): return {}
    boxes = {}
    for (a, _), (b, _) in zip(accurate, plain):
        box = fitz.Rect(a['bbox'])
        if not box.is_empty or b['c'].isspace(): boxes[id(b)] = box
    return boxes

# Antialiasing bleed (pt) around a vector path's stroke extent when testing it against text moved by a gap close.
DECOR_BLEED_PT = 0.5

def decoration_boxes(page):
    """Painted extent of every vector path (bbox grown by half its stroke width plus DECOR_BLEED_PT, so a zero-height
    rule or zero-width bar still has area) and every image placement on the page."""
    import pymupdf as fitz
    boxes = []
    for d in page.get_drawings():
        half = (d.get('width') or 0) / 2 + DECOR_BLEED_PT
        boxes.append(fitz.Rect(d['rect']) + (-half, -half, half, half))
    return boxes + [fitz.Rect(im['bbox']) for im in page.get_image_info()]

def export_pdf(raw, patches):
    """Export with closed shorter-After gaps where provable; any failure of that attempt falls back to the original
    positions (the fallback's own result or error is returned)."""
    state = {'closed': 0}
    try: return _export_pdf(raw, patches, True, state)
    except ValueError:
        if not state['closed']: raise
    output, verification = _export_pdf(raw, patches, False, {'closed': 0})
    return output, verification | {'gapCloseFallback': True}

def _export_pdf(raw, patches, close_gaps, state):
    import pymupdf as fitz
    if len(raw) > 25 * 1024 * 1024 or not raw.startswith(b'%PDF-'): raise ValueError('PDF 크기/서명 오류')
    if re.search(rb'/ByteRange\s*\[|/FT\s*/Sig\b', raw): raise ValueError('서명된 PDF는 편집하지 않습니다.')
    doc = fitz.open(stream=raw, filetype='pdf')
    original = fitz.open(stream=raw, filetype='pdf')
    try:
        if doc.is_encrypted or doc.page_count > 200: raise ValueError('암호화/200페이지 초과 PDF는 편집하지 않습니다.')
        jobs, raws, all_raw, inks = {}, {}, [], {}
        rawdict = lambda n: raws.setdefault(n, original[n].get_text('rawdict'))
        def document_raw():
            if not all_raw: all_raw.extend(rawdict(i) for i in range(original.page_count))
            return all_raw
        content_owners = {}
        for i in range(doc.page_count):
            for x in doc[i].get_contents(): content_owners.setdefault(x, set()).add(i)
        normalize = lambda s: re.sub(r'^[A-Z]{6}\+', '', s).replace(' ', '')
        for p in patches:
            match = re.fullmatch(r'PDF p\. (\d+)', p['label'])
            if not match: raise ValueError('PDF 원본 페이지 위치가 필요합니다.')
            n = int(match[1]) - 1
            if not 0 <= n < doc.page_count: raise ValueError('PDF 페이지 범위 오류')
            page = doc[n]
            matches = []
            raw_text = rawdict(n)
            quote = p['before'].replace('\u00a0', ' ')
            after = p['after'].replace('\u00a0', ' ')
            for block in raw_text['blocks']:
                for line in block.get('lines', []):
                    for span in line['spans']:
                        chars = span.get('chars', [])
                        text = ''.join(c['c'] for c in chars).replace('\u00a0', ' ')
                        start = text.find(quote)
                        if start >= 0:
                            if text.find(quote, start + 1) >= 0: raise ValueError('PDF 내 중복 인용')
                            matches.append((line, span, start))
            if len(matches) != 1: raise ValueError('한 줄·한 글꼴 안의 고유 인용만 보존 편집할 수 있습니다. 줄바꿈/혼합 글꼴/추출 오차를 확인하세요.')
            line, span, start = matches[0]
            chars = span['chars'][start:start + len(quote)]
            prev = span['chars'][start - 1] if start else None
            nxt = span['chars'][start + len(quote)] if start + len(quote) < len(span['chars']) else None
            if tuple(line['dir']) != (1.0, 0.0) or page.rotation != 0: raise ValueError('회전 텍스트/페이지는 보존 편집하지 않습니다.')
            if '\n' in p['after'] or '\r' in p['after']: raise ValueError('한 줄 안의 변경만 지원합니다.')
            # Rendering state of the original glyphs: filled, opaque, horizontal writing mode only.
            origin = chars[0]['origin']
            trace = [t for t in page.get_texttrace() if any(abs(ch[2][0] - origin[0]) < 0.01 and abs(ch[2][1] - origin[1]) < 0.01 for ch in t['chars'])]
            if not trace or any(t['type'] != 0 or t['opacity'] != 1 or t['wmode'] != 0 for t in trace):
                raise ValueError(f"{p['label']}: 일반 채움 텍스트가 아닌 원본(외곽선/투명/세로쓰기)은 보존 편집하지 않습니다.")
            def existing_codec():
                try: return font_codec(doc, page, span['font'], after, drawn)
                except ValueError as error: raise ValueError(f"{p['label']}: {error}") from None
            # Only the page's own font object and byte codes are used (exact outlines and widths).
            drawn = {c['c'] for c, other_span in page_chars(raw_text) if normalize(other_span['font']) == normalize(span['font'])}
            codec_error = None
            if span['font'] in BASE14:
                # The codec proves each After character against the font's actual /Encoding and the
                # characters already drawn with it (e.g. WinAnsi curly quotes or the euro sign).
                try: codec = existing_codec()
                except ValueError as error:
                    # Report an over-long After first (standard metrics), then the glyph/encoding proof.
                    standard, codec_error = fitz.Font(BASE14[span['font']]), error
                    codec = {'codes': list(after), 'widths': {c: standard.glyph_advance(ord(c)) * 1000 for c in after}}
            else:
                # Reuse only the actual embedded font, never substitute a similar-looking font.
                fonts = []
                for f in page.get_fonts(full=True):
                    buffer = doc.extract_font(f[0])[3] if f[0] else b''
                    if len(buffer) > 10*1024*1024: raise ValueError('임베디드 글꼴 크기 제한 초과')
                    if normalize(span['font']) in [normalize(name) for name in [f[3], *font_names(buffer)]]: fonts.append((f, buffer))
                if len(fonts) != 1: raise ValueError('원본 임베디드 글꼴을 고유하게 찾을 수 없습니다.')
                try:
                    fontbuffer = fonts[0][1]
                    if not fontbuffer: raise ValueError()
                    font = fitz.Font(fontbuffer=fontbuffer)
                except Exception: raise ValueError('원본 글꼴을 재사용할 수 없습니다. 다른 글꼴로 대체하지 않습니다.') from None
                fontxref = fonts[0][0][0]
                # Exactly one font object on this page matches this name (checked above), so spans
                # carrying the name were drawn with that object.
                # Type0 goes straight to the codec: its drawn-char + unique CID/ToUnicode + /W proof does
                # not depend on a Unicode cmap in the program (has_glyph would be a false absence).
                if doc.xref_get_key(fontxref, 'Subtype')[1] == '/Type0': codec = existing_codec()
                else:
                    try:
                        codes, _ = page_encoding_codes(doc, fontxref, fontbuffer, after, drawn)
                        codec = {'xref': fontxref, 'resource': font_resource_name(doc, page, fontxref), 'codes': codes, 'codeBytes': 1,
                            'mapping': parse_to_unicode(doc.xref_stream(int(doc.xref_get_key(fontxref, 'ToUnicode')[1].split()[0])) or b''),
                            'widths': simple_widths(doc, fontxref)}
                    except ValueError as error:
                        if any(not font.has_glyph(ord(c), fallback=False) for c in after): raise ValueError(f"{p['label']}: {error}") from None
                        raise unsupported(p['label'], 'codec', str(error))
            codes, widths = codec['codes'], codec['widths']
            natural = [widths[code] * span['size'] / 1000 for code in codes]
            rect = fitz.Rect(chars[0]['bbox'])
            for c in chars[1:]: rect |= fitz.Rect(c['bbox'])
            # Numerical contact (<= MICRO_OVERLAP_PT) with the immediately adjacent whitespace of the same
            # line: the edit geometry stops at that whitespace's edge; the whitespace itself is kept and
            # its position is asserted unchanged after export. Any other overlap still fails.
            tightened = []
            if nxt is not None and nxt['c'].isspace() and 0 < rect.x1 - nxt['bbox'][0] <= MICRO_OVERLAP_PT:
                tightened.append({'side': 'right', 'overlapPt': round(rect.x1 - nxt['bbox'][0], 4)}); rect.x1 = nxt['bbox'][0]
            if prev is not None and prev['c'].isspace() and 0 < prev['bbox'][2] - rect.x0 <= MICRO_OVERLAP_PT:
                tightened.append({'side': 'left', 'overlapPt': round(prev['bbox'][2] - rect.x0, 4)}); rect.x0 = prev['bbox'][2]
            # Shorter After: the rest of the same extracted line (same baseline) moves left by the width the line lost.
            followers, width = [], sum(natural)
            if close_gaps:
                line_chars = [c for s in line['spans'] for c in s.get('chars', []) if not c.get('synthetic')]
                followers = line_chars[next(k for k, c in enumerate(line_chars) if c is chars[-1]) + 1:]
                if width >= chars[-1]['bbox'][2] - origin[0] - EPS or any(abs(c['origin'][1] - origin[1]) > 0.01 for c in followers):
                    followers = []
            shift = width - (chars[-1]['bbox'][2] - origin[0]) if followers else 0.0
            area = fitz.Rect(rect)
            for c in followers: area |= fitz.Rect(c['bbox'])
            selected_chars = {id(c) for c in chars}
            moved = {id(c) for c in followers}
            # Characters on another baseline are tested by their glyph ink, not their line box: at ordinary leading
            # the ascender-to-descender line boxes of adjacent lines overlap by a fraction of a point with no ink there.
            # Characters on the selection's baseline (and any glyph without a measured outline box) keep the line box.
            if n not in inks: inks[n] = ink_boxes(original[n], raw_text)
            # Unselected text over the selection itself is refused. Under the moved rest of the line only (optional gap
            # close), any foreign text, vector path or image would not move with it: the closure is unprovable and
            # export_pdf falls back to the original positions.
            unsafe = None
            for char, _ in page_chars(raw_text):
                if id(char) in selected_chars or id(char) in moved: continue
                box = fitz.Rect(char['bbox'])
                if abs(char['origin'][1] - origin[1]) > 0.01: box = inks[n].get(id(char), box)
                if rect.intersects(box):
                    raise ValueError(f"{p['label']}: 선택하지 않은 텍스트와 편집 영역이 겹칩니다 "
                        f"(인접 문자 {char['c']!r}, bbox x0={char['bbox'][0]:.3f}, 편집 영역 x1={rect.x1:.3f}).")
                if unsafe is None and area.intersects(box): unsafe = f"text {char['c']!r}"
            if followers:
                state['closed'] += 1
                extension = fitz.Rect(followers[0]['bbox'])
                for c in followers[1:]: extension |= fitz.Rect(c['bbox'])
                if unsafe is None and any(extension.intersects(box) for box in decoration_boxes(original[n])): unsafe = 'vector/image'
                if unsafe: raise ValueError(f'gap close: {unsafe} under the following text')
                end = origin[0] + width
            else: end = min(rect.x1, nxt['origin'][0]) if nxt is not None else rect.x1
            space_natural = next((w for w, c in zip(natural, after) if c == ' '), 0.25 * span['size'])
            space_range = source_space_range(document_raw(), lambda name: normalize(name) == normalize(span['font']), span['size'], space_natural)
            try: plan = plan_fit(after, natural, end - origin[0], span['size'], space_natural, space_range)
            except ValueError as error: raise ValueError(f"{p['label']}: {error}") from None
            if codec_error: raise codec_error
            if any(area.intersects(a.rect) for a in (page.annots() or [])): raise ValueError('주석과 겹치는 영역은 편집하지 않습니다.')
            if any(area.intersects(link['from']) for link in page.get_links()): raise ValueError('링크와 겹치는 영역은 편집하지 않습니다.')
            if any(area.intersects(widget.rect) for widget in (page.widgets() or [])): raise ValueError('폼 필드와 겹치는 영역은 편집하지 않습니다.')
            for existing in jobs.get(n, []):
                if area.intersects(existing['rect']): raise ValueError('선택한 PDF 변경 영역이 겹칩니다.')
            # Rewrite the original text operator itself so content order and following glyphs stay.
            # Graphics/text state carries across the page's content streams in order.
            if not codec['resource'] or font_resource_name(doc, page, codec['xref']) != codec['resource']: raise unsupported(p['label'], 'resource')
            try: parts = find_show([(x, doc.xref_stream(x)) for x in page.get_contents()], codec['resource'], codec['mapping'], quote,
                size=span['size'], code_bytes=codec['codeBytes'])
            except LookupError as error: raise unsupported(p['label'], error.args[0] if error.args else 'content') from None
            except ValueError as error: raise unsupported(p['label'], error.args[0] if error.args else 'content') from None
            if not parts: raise unsupported(p['label'], 'not found')
            if any(content_owners.get(part[5]) != {n} for part in parts): raise unsupported(p['label'], 'shared')
            # TJ offsets are 1/1000 of the effective font size; the result is re-measured after export.
            extras_units = [v * 1000 / span['size'] for v in plan['extras']]
            try: splices, compensation = rewrite_parts(parts, codes, extras_units, lambda code: widths[code], codec['codeBytes'])
            except (LookupError, KeyError) as error: raise unsupported(p['label'], 'rewrite', str(error)) from None
            if followers:
                # The followers move only through the compensating offset after the replacement (natural extras, so it
                # directly follows the codes). Anything else is not closed here; export_pdf falls back.
                if len(parts) != 1 or any(extras_units): raise ValueError('gap close: not a single natural operator')
                start_, end_, items, index, count, _ = parts[0]
                new, comp = rewrite_items(items, index, count, codes, extras_units, lambda code: widths[code])
                at = [k for k, (kind, _) in enumerate(items) if kind == 'g'][index] + len(codes)
                if comp is None or at >= len(new) or new[at] != ('k', comp): raise ValueError('gap close: no compensating offset')
                new[at] = ('k', comp - shift * 1000 / span['size'])
                splices, compensation = [(start_, end_, serialize_tj(new, codec['codeBytes']))], [round(new[at][1], 3)]
            inplace = {'splices': [(part[5], *splice) for part, splice in zip(parts, splices)], 'operators': len(parts), 'compensationUnits': compensation}
            touched = {(sp[0], sp[1]) for sp in inplace['splices']}
            if any(touched & {(sp[0], sp[1]) for sp in o['inplace']['splices']} for o in jobs.get(n, [])):
                raise ValueError('같은 원본 텍스트 연산자 안의 여러 변경은 아직 보존 편집하지 않습니다.')
            jobs.setdefault(n, []).append({'patch': p, 'after': after, 'rect': area, 'end': end, 'origin': origin, 'font': codec['resource'],
                'natural': natural, 'plan': plan, 'size': span['size'], 'spanfont': span['font'], 'selected': selected_chars,
                'tightened': tightened, 'inplace': inplace, 'codeBytes': codec['codeBytes'], 'shift': dict.fromkeys(moved, shift)})
        for n, edits in jobs.items():
            streams = {}
            for e in edits:
                for x, start, end, operand in e['inplace']['splices']: streams.setdefault(x, []).append((start, end, operand))
            for x, splices in streams.items():
                data = doc.xref_stream(x)
                for start, end, operand in sorted(splices, reverse=True): data = data[:start] + operand + data[end:]
                doc.update_stream(x, data)
        output = doc.tobytes(garbage=4, deflate=True)
        verified = fitz.open(stream=output, filetype='pdf')
        try:
            if verified.page_count != original.page_count: raise ValueError('페이지 수가 변경되었습니다.')
            if verified.metadata != original.metadata: raise ValueError('문서 메타데이터가 변경되었습니다.')
            if verified.get_xml_metadata() != original.get_xml_metadata(): raise ValueError('문서 XMP 메타데이터가 변경되었습니다.')
            # No font resource or program may be added, removed or replaced.
            describe = lambda d, n: sorted((f[1], f[2], f[3], f[4], f[5], f[6] != 0) for f in d[n].get_fonts(full=True))
            programs = lambda d: sorted({hashlib.sha256(d.extract_font(f[0])[3]).hexdigest() for page in d for f in page.get_fonts(full=True) if f[0]})
            if any(describe(verified, n) != describe(original, n) for n in range(original.page_count)) or programs(verified) != programs(original):
                raise ValueError('글꼴 리소스/프로그램이 변경되었습니다. 레이아웃 보존 다운로드를 차단합니다.')
            report, shifted = [], 0
            # Sequential 96dpi raster comparison; no edited pixels outside precise masks.
            for n in range(original.page_count):
                a, b = original[n], verified[n]
                if a.rect != b.rect or a.mediabox != b.mediabox or a.cropbox != b.cropbox: raise ValueError('PDF 페이지 치수가 변경되었습니다.')
                if a.rect.width * a.rect.height > 3000000: raise ValueError('검증 가능한 페이지 치수를 초과했습니다.')
                pix_a = a.get_pixmap(matrix=fitz.Matrix(4/3, 4/3), alpha=False)
                pix_b = b.get_pixmap(matrix=fitz.Matrix(4/3, 4/3), alpha=False)
                if (pix_a.width, pix_a.height) != (pix_b.width, pix_b.height): raise ValueError('PDF 렌더링 치수가 변경되었습니다.')
                masks = []
                if n in jobs:
                    text_a, text_b = a.get_text().replace('\u00a0', ' '), b.get_text().replace('\u00a0', ' ')
                    expected = text_a
                    for e in jobs[n]:
                        masks.append((e['rect'] * fitz.Matrix(4/3, 4/3) + (-2, -2, 2, 2)).irect)
                        before = e['patch']['before'].replace('\u00a0', ' ')
                        # The original string must be actually removed, not hidden under a white rectangle.
                        if before in text_b or e['after'] not in text_b: raise ValueError('PDF 텍스트 제거/삽입 검증에 실패했습니다.')
                        expected = expected.replace(before, e['after'], 1)
                    # Reading order: the same words in the same order. A shorter replacement leaves white
                    # space inside the selection, which an extractor may report as a line break; that is
                    # recorded, not treated as reordering.
                    if expected.split() != text_b.split(): raise ValueError(f'PDF p. {n + 1}: 추출되는 읽기 순서가 원본과 달라졌습니다. 레이아웃 보존 다운로드를 차단합니다.')
                    exact_extraction = expected == text_b
                    # Every unselected glyph (including adjacent spaces) keeps its character, font, size and origin; the
                    # rest of a line after a shorter After keeps them too, moved along its baseline by exactly the shift.
                    selected = set().union(*(e['selected'] for e in jobs[n]))
                    shifts = {k: v for e in jobs[n] for k, v in e['shift'].items()}
                    shifted += len(shifts)
                    pool = {}
                    for c, span in page_chars(b.get_text('rawdict')): pool.setdefault(c['c'], []).append((c, span))
                    for c, span in page_chars(rawdict(n)):
                        if id(c) in selected: continue
                        candidates = pool.get(c['c'], [])
                        x = c['origin'][0] + shifts.get(id(c), 0.0)
                        hit = next((k for k, (d, s) in enumerate(candidates) if abs(d['origin'][0] - x) <= 0.01
                            and abs(d['origin'][1] - c['origin'][1]) <= 0.01 and s['font'] == span['font'] and abs(s['size'] - span['size']) <= 0.01), None)
                        if hit is None: raise ValueError(f"선택하지 않은 문자 {c['c']!r}의 위치/글꼴이 바뀌었습니다 (x={c['origin'][0]:.3f}). 레이아웃 보존 다운로드를 차단합니다.")
                        candidates.pop(hit)
                    rest = [cs for v in pool.values() for cs in v]
                    if len(rest) != sum(len(e['after']) for e in jobs[n]): raise ValueError('선택 영역 밖에 추가/누락된 문자가 있습니다.')
                    for e in jobs[n]:
                        mine = sorted((cs for cs in rest if abs(cs[0]['origin'][1] - e['origin'][1]) <= 0.01
                            and e['origin'][0] - 0.01 <= cs[0]['origin'][0] <= e['end'] + 0.01), key=lambda cs: cs[0]['origin'][0])
                        if any(normalize(s['font']) != normalize(e['spanfont']) or abs(s['size'] - e['size']) > 0.01 for _, s in mine):
                            raise ValueError('삽입 텍스트의 글꼴/크기가 원본과 다릅니다.')
                        glyphs = [c for c, _ in mine]
                        entry = {'label': e['patch']['label'], 'method': 'in-place-text-operator', 'fontResource': e['font'],
                            'reusedOriginalFontObject': True, 'codeBytes': e['codeBytes'], 'fontSizePt': e['size'],
                            'baselineY': round(e['origin'][1], 3), 'logicalTextOrderPreserved': True,
                            'exactExtractedTextOnPage': exact_extraction, 'microOverlapTightening': e['tightened']}
                        measured = verify_fit(glyphs, e['after'], e['natural'], e['plan'], e['origin'], e['size'], e['end'])
                        entry['spacing'] = {k: v for k, v in e['plan'].items() if k != 'extras'} | measured
                        entry |= {'rewrittenOperators': e['inplace']['operators'], 'compensationUnits': e['inplace']['compensationUnits']}
                        entry['followingTextShift'] = {'pt': round(next(iter(e['shift'].values())), 3), 'glyphs': len(e['shift'])} if e['shift'] else None
                        report.append(entry)
                bytes_a, bytes_b, stride = pix_a.samples, pix_b.samples, pix_a.stride
                for y in range(pix_a.height):
                    row_a, row_b = bytes_a[y*stride:(y+1)*stride], bytes_b[y*stride:(y+1)*stride]
                    if row_a == row_b: continue
                    for x in range(pix_a.width):
                        if row_a[x*3:x*3+3] != row_b[x*3:x*3+3] and not any(m.x0 <= x < m.x1 and m.y0 <= y < m.y1 for m in masks):
                            raise ValueError('선택 영역 밖의 픽셀이 바뀌었습니다. 레이아웃 보존 다운로드를 차단합니다.')
            return output, {'mode': 'pdf-original-font-single-line', 'pages': doc.page_count, 'rasterDpi': 96,
                'outsideSelectedAreasUnchanged': True, 'textActuallyRemoved': True, 'unselectedGlyphPositionsUnchanged': not shifted,
                'unselectedGlyphsShiftedAlongEditedLine': shifted,
                'metadataUnchanged': True, 'fontResourcesUnchanged': True, 'logicalTextOrderPreserved': True, 'edits': report,
                'typographyLimits': {'minSpaceRatio': MIN_SPACE_RATIO, 'tightSpaceRatio': TIGHT_SPACE_RATIO,
                    'spaceRange': 'narrowest/widest space the source uses for the same font and size',
                    'maxTrackingEm': MAX_TRACKING_EM, 'trackingStretch': False, 'fontSubstitution': False, 'sizeChange': False,
                    'horizontalScale': False, 'microOverlapPt': MICRO_OVERLAP_PT},
                'limits': '96dpi 픽셀 비교이며 모든 PDF 뷰어/접근성/인쇄 특성 보증은 아닙니다. 간격은 한도 안에서 조정되었으며 원본 간격과 동일하다고 보증하지 않습니다.'}
        finally: verified.close()
    finally: doc.close(); original.close()

def handle_export(data):
    if data.get('format') != 'PDF': raise ValueError('DOCX/ODT/HTML은 원래 앱의 렌더러 검증 경로가 아직 없습니다. 레이아웃 보존을 확인할 수 없어 완성본 다운로드를 차단합니다. 변경 계획 JSON은 저장할 수 있습니다.')
    try: raw = base64.b64decode(data['file'], validate=True)
    except Exception: raise ValueError('원본 파일 데이터가 올바르지 않습니다.') from None
    if hashlib.sha256(raw).hexdigest() != data.get('fileHash'): raise ValueError('원본 파일 해시가 일치하지 않습니다.')
    patches = data.get('patches')
    if not isinstance(patches, list) or not 1 <= len(patches) <= 12: raise ValueError('선택한 변경이 필요합니다.')
    for p in patches:
        if not isinstance(p, dict) or not all(isinstance(p.get(k), str) for k in ['label', 'before', 'after']): raise ValueError('변경 형식 오류')
        if not p['before'].strip() or not p['after'].strip() or max(len(p['before']), len(p['after'])) > 4000 or p['before'] == p['after']: raise ValueError('변경 내용 오류')
        for pattern in [r'\d+(?:[.,]\d+)*', r'\[[^\]\n]*\]|https?://\S+']:
            if re.findall(pattern, p['before']) != re.findall(pattern, p['after']): raise ValueError('수치/인용 변경은 범위 밖입니다.')
    result, verification = export_pdf(raw, patches)
    return {'file': base64.b64encode(result).decode('ascii'), 'sourceFileHash': data['fileHash'],
        'outputFileHash': hashlib.sha256(result).hexdigest(), 'verification': verification}

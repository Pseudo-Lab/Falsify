"""Original-font codecs: encode After with the page's own font object, never a substitute.

Supported shapes (everything else raises ValueError with a human-readable reason):
- Base14 simple Type1 without an embedded program (Symbol/ZapfDingbats excluded), using its
  actual /Encoding (WinAnsi, MacRoman, Standard; no /Differences) and its /Widths or, when
  absent, the standard font metrics.
- Embedded Type0 /Identity-H fonts with a strictly parsed two-byte ToUnicode CMap and the
  descendant CIDFont's own /W and /DW widths.

A character of After is accepted only if exactly one code maps to it and that character is
already drawn with this font in the source (`drawn`), proving the glyph exists in the program.
The module is independent of preserve.py (stdlib + PyMuPDF only) and never creates fonts or
resources.
"""
import re

MAX_CMAP = 1024 * 1024
MAX_TOKENS = 200000
MAX_CODE = 0xFFFF
# Total expanded assignments allowed per parse (bfrange / W ranges), independent of input bytes.
MAX_EXPANSION = 2 * (MAX_CODE + 1)

BASE14 = {'Helvetica': 'helv', 'Helvetica-Bold': 'hebo', 'Helvetica-Oblique': 'heit',
    'Helvetica-BoldOblique': 'hebi', 'Times-Roman': 'tiro', 'Times-Bold': 'tibo',
    'Times-Italic': 'tiit', 'Times-BoldItalic': 'tibi', 'Courier': 'cour',
    'Courier-Bold': 'cobo', 'Courier-Oblique': 'coit', 'Courier-BoldOblique': 'cobi'}

# Adobe StandardEncoding (PDF 32000 Annex D) for codes that differ from ASCII/absent in it.
STANDARD_HIGH = {0x27: '’', 0x60: '‘', 0xA1: '¡', 0xA2: '¢', 0xA3: '£', 0xA4: '⁄',
    0xA5: '¥', 0xA6: 'ƒ', 0xA7: '§', 0xA8: '¤', 0xA9: "'", 0xAA: '“', 0xAB: '«',
    0xAC: '‹', 0xAD: '›', 0xAE: 'ﬁ', 0xAF: 'ﬂ', 0xB1: '–', 0xB2: '†',
    0xB3: '‡', 0xB4: '·', 0xB6: '¶', 0xB7: '•', 0xB8: '‚', 0xB9: '„',
    0xBA: '”', 0xBB: '»', 0xBC: '…', 0xBD: '‰', 0xBF: '¿', 0xC1: '`', 0xC2: '´',
    0xC3: 'ˆ', 0xC4: '˜', 0xC5: '¯', 0xC6: '˘', 0xC7: '˙', 0xC8: '¨',
    0xCA: '˚', 0xCB: '¸', 0xCD: '˝', 0xCE: '˛', 0xCF: 'ˇ', 0xD0: '—',
    0xE1: 'Æ', 0xE3: 'ª', 0xE8: 'Ł', 0xE9: 'Ø', 0xEA: 'Œ', 0xEB: 'º', 0xF1: 'æ',
    0xF5: 'ı', 0xF8: 'ł', 0xF9: 'ø', 0xFA: 'œ', 0xFB: 'ß'}

def encoding_table(name):
    """{code: char} for a supported simple-font base encoding, or None."""
    table = {}
    if name == 'StandardEncoding':
        for code in range(32, 127): table[code] = chr(code)
        table.update(STANDARD_HIGH)
        return table
    codec = {'WinAnsiEncoding': 'cp1252', 'MacRomanEncoding': 'mac_roman'}.get(name)
    if codec is None: return None
    for code in range(32, 256):
        if code == 127: continue
        try: table[code] = bytes([code]).decode(codec)
        except UnicodeDecodeError: pass  # undefined WinAnsi codes are not mapped
    return table

def normalize(name):
    return re.sub(r'^[A-Z]{6}\+', '', name or '')

def describe(chars):
    return ', '.join(repr(c) + f' (U+{ord(c):04X})' for c in dict.fromkeys(chars))

def ref(value):
    match = re.fullmatch(r'\s*(\d+)\s+0\s+R\s*', value or '')
    return int(match[1]) if match else None

def numbers(text):
    return [float(n) for n in re.findall(r'-?\d+(?:\.\d+)?|-?\.\d+', text)]

def parse_to_unicode(data, code_bytes):
    """Strict bounded ToUnicode CMap parser for a single code length.

    Returns {code: text}. Raises ValueError for usecmap, missing/mixed/other-length codespace,
    codes outside the codespace, malformed or unconsumed bf sections, conflicting duplicate
    codes, invalid UTF-16 or oversized input.
    """
    if not data or len(data) > MAX_CMAP: raise ValueError('ToUnicode CMap이 없거나 너무 큽니다')
    text = data.decode('latin-1')
    if re.search(r'\busecmap\b', text): raise ValueError('usecmap을 쓰는 ToUnicode CMap은 지원하지 않습니다')
    width = 2 * code_bytes
    pair = r'<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>'
    spaces = re.findall(r'(\d+)\s+begincodespacerange(.*?)endcodespacerange', text, re.S)
    if not spaces or len(spaces) != len(re.findall(r'begincodespacerange', text)):
        raise ValueError('ToUnicode codespace가 없거나 형식이 잘못되었습니다')
    ranges = []
    for count, body in spaces:
        entries = re.findall(pair, body)
        if len(entries) != int(count) or re.sub(pair, '', body).strip(): raise ValueError('ToUnicode codespace 형식 오류')
        for lo, hi in entries:
            if len(lo) != width or len(hi) != width: raise ValueError(f'ToUnicode codespace가 {code_bytes}바이트 코드가 아닙니다(혼합 또는 다른 길이)')
            if int(lo, 16) > int(hi, 16): raise ValueError('ToUnicode codespace 범위 오류')
            ranges.append((int(lo, 16), int(hi, 16)))
    inside = lambda code: any(lo <= code <= hi for lo, hi in ranges)
    mapping, unknown, budget = {}, set(), [MAX_EXPANSION]
    def spend(n):
        budget[0] -= n
        if budget[0] < 0: raise ValueError('ToUnicode 확장 매핑이 너무 많습니다')
    def utf16(h):
        if h and len(h) % 2: return None
        if not h or len(h) % 4: raise ValueError('ToUnicode 대상 UTF-16 오류')
        try: return bytes.fromhex(h).decode('utf-16be')
        except UnicodeDecodeError: raise ValueError('ToUnicode 대상 UTF-16 오류') from None
    def put(code, value):
        if value is None:
            # Odd-length destination hex (seen from some producers for non-BMP targets): the code's
            # text is unknowable, so it is never offered for encoding; everything else stays strict.
            if not inside(code) or code in mapping: raise ValueError('ToUnicode 코드 오류')
            unknown.add(code); return
        if code in unknown: raise ValueError('ToUnicode에 같은 코드의 상충하는 매핑이 있습니다')
        if not inside(code): raise ValueError('ToUnicode 코드가 codespace 밖에 있습니다')
        if mapping.get(code, value) != value: raise ValueError('ToUnicode에 같은 코드의 상충하는 매핑이 있습니다')
        mapping[code] = value
        if len(mapping) > 65536: raise ValueError('ToUnicode 매핑이 너무 많습니다')
    for count, body in re.findall(r'(\d+)\s+beginbfchar(.*?)endbfchar', text, re.S):
        entries = re.findall(pair, body)
        if len(entries) != int(count) or re.sub(pair, '', body).strip(): raise ValueError('ToUnicode bfchar 형식 오류')
        spend(len(entries))
        for src, dst in entries:
            if len(src) != width: raise ValueError('ToUnicode bfchar 코드 길이 오류')
            put(int(src, 16), utf16(dst))
    entry = r'<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>\s*(<[0-9A-Fa-f]*>|\[(?:\s*<[0-9A-Fa-f]*>)*\s*\])'
    for count, body in re.findall(r'(\d+)\s+beginbfrange(.*?)endbfrange', text, re.S):
        entries = re.findall(entry, body)
        if len(entries) != int(count) or re.sub(entry, '', body).strip(): raise ValueError('ToUnicode bfrange 형식 오류')
        for lo, hi, dst in entries:
            if len(lo) != width or len(hi) != width or lo[:-2].lower() != hi[:-2].lower():
                raise ValueError('ToUnicode bfrange 코드 범위 오류')
            lo, hi = int(lo, 16), int(hi, 16)
            if lo > hi: raise ValueError('ToUnicode bfrange 코드 범위 오류')
            spend(hi - lo + 1)
            if dst.startswith('['):
                items = re.findall(r'<([0-9A-Fa-f]*)>', dst)
                if len(items) != hi - lo + 1: raise ValueError('ToUnicode bfrange 배열 길이 오류')
                for i, item in enumerate(items): put(lo + i, utf16(item))
            else:
                if len(dst) % 2:
                    for i in range(hi - lo + 1): put(lo + i, None)
                    continue
                base = bytes.fromhex(dst[1:-1])
                if len(base) < 2 or len(base) % 2: raise ValueError('ToUnicode bfrange 대상 오류')
                for i in range(hi - lo + 1):
                    last = int.from_bytes(base[-2:], 'big') + i
                    if last > 0xFFFF: raise ValueError('ToUnicode bfrange 대상 범위 오류')
                    put(lo + i, utf16((base[:-2] + last.to_bytes(2, 'big')).hex()))
    sections = len(re.findall(r'beginbf(?:char|range)', text))
    if sections != len(re.findall(r'\d+\s+beginbf(?:char|range)', text)): raise ValueError('ToUnicode bf 구역 형식 오류')
    if re.search(r'begin(?:cid|notdef)(?:char|range)', text): raise ValueError('ToUnicode에 지원하지 않는 cid/notdef 구역이 있습니다')
    return mapping

def parse_cid_widths(text):
    """Strict /W array parser: [c [w...] c1 c2 w ...] -> {cid: width}."""
    if len(text) > MAX_CMAP: raise ValueError('/W 배열이 너무 큽니다')
    tokens = re.findall(r'\[|\]|-?\d+(?:\.\d+)?|-?\.\d+|\S', text)
    if len(tokens) > MAX_TOKENS or not tokens or tokens[0] != '[' or tokens[-1] != ']': raise ValueError('/W 배열 형식 오류')
    tokens, widths, i, budget = tokens[1:-1], {}, 0, MAX_EXPANSION
    num = lambda t: re.fullmatch(r'-?\d+(?:\.\d+)?|-?\.\d+', t) is not None
    def put(cid, w):
        if cid > MAX_CODE: raise ValueError('/W 배열 CID 범위 오류')
        if cid in widths and widths[cid] != w: raise ValueError('/W 배열에 상충하는 너비가 있습니다')
        widths[cid] = w
    while i < len(tokens):
        if not num(tokens[i]) or '.' in tokens[i] or int(tokens[i]) < 0: raise ValueError('/W 배열 형식 오류')
        first = int(tokens[i])
        if i + 1 < len(tokens) and tokens[i + 1] == '[':
            try: end = tokens.index(']', i + 2)
            except ValueError: raise ValueError('/W 배열 형식 오류') from None
            items = tokens[i + 2:end]
            if not items or not all(num(t) for t in items): raise ValueError('/W 배열 형식 오류')
            budget -= len(items)
            if budget < 0: raise ValueError('/W 배열 확장이 너무 많습니다')
            for k, t in enumerate(items): put(first + k, float(t))
            i = end + 1
        elif i + 2 < len(tokens) and all(num(t) for t in tokens[i + 1:i + 3]) and '.' not in tokens[i + 1]:
            last = int(tokens[i + 1])
            if last < first or last > MAX_CODE: raise ValueError('/W 배열 범위 오류')
            budget -= last - first + 1
            if budget < 0: raise ValueError('/W 배열 확장이 너무 많습니다')
            for cid in range(first, last + 1): put(cid, float(tokens[i + 2]))
            i += 3
        else: raise ValueError('/W 배열 형식 오류')
    return widths

def object_text(doc, kind, value, what):
    """Source text of a direct or indirect (non-stream) object value."""
    if kind == 'xref':
        x = ref(value)
        if x is None or doc.xref_is_stream(x): raise ValueError(f'{what}을(를) 확인할 수 없습니다')
        return doc.xref_object(x, compressed=True)
    return value

def page_font(doc, page, spanfont):
    """The unique font object drawn directly by the page (not via Form XObject) under `spanfont`."""
    want = normalize(spanfont)
    hits = []
    for xref, _, subtype, basefont, name, _, referencer in page.get_fonts(full=True):
        names = {normalize(basefont)}
        if subtype == 'Type0':
            kind, value = doc.xref_get_key(xref, 'DescendantFonts')
            refs = re.findall(r'(\d+)\s+0\s+R', object_text(doc, kind, value, 'DescendantFonts') if kind in ('array', 'xref') else '')
            if len(refs) == 1:
                kind, value = doc.xref_get_key(int(refs[0]), 'BaseFont')
                if kind == 'name': names.add(normalize(value.lstrip('/')))
        if want in names: hits.append((xref, subtype, name, referencer))
    if not hits: raise ValueError(f'페이지에서 원본 글꼴 {spanfont!r}을(를) 찾을 수 없습니다.')
    if any(h[3] != 0 for h in hits): raise ValueError(f'원본 글꼴 {spanfont!r}이(가) Form XObject 안에서 쓰여 지원하지 않습니다.')
    if len({h[0] for h in hits}) != 1 or len({h[2] for h in hits}) != 1:
        raise ValueError(f'원본 글꼴 {spanfont!r}에 해당하는 페이지 글꼴 리소스가 여러 개라 모호합니다.')
    xref, subtype, name, _ = hits[0]
    if resource_xref(doc, page, name) != xref: raise ValueError(f'페이지 리소스 {name!r}가 원본 글꼴 객체를 가리키는지 확인할 수 없습니다.')
    return xref, subtype, name

def resource_xref(doc, page, name):
    """Read-only lookup of /Resources/Font/<name> on the page itself."""
    kind, value = doc.xref_get_key(page.xref, 'Resources')
    if kind == 'xref': owner, prefix = ref(value), ''
    elif kind == 'dict': owner, prefix = page.xref, 'Resources/'
    else: return None
    kind, value = doc.xref_get_key(owner, prefix + 'Font')
    if kind == 'xref': owner, prefix = ref(value), ''
    elif kind == 'dict': prefix += 'Font/'
    else: return None
    kind, value = doc.xref_get_key(owner, prefix + name)
    return ref(value) if kind == 'xref' else None

def encode(after, mapping, widths, drawn, label):
    """Unique, drawn, positive-width code per After char, else ValueError naming the chars."""
    reverse = {}
    for code, value in mapping.items(): reverse.setdefault(value, []).append(code)
    codes, absent, ambiguous, unproven = [], [], [], []
    for c in after:
        found, seen = reverse.get(c, []), c in drawn
        if not found and c == ' ':
            # A space glyph extracted as NBSP (e.g. TrueType space and nbsp sharing one glyph).
            found, seen = reverse.get(' ', []), seen or ' ' in drawn
        if not found: absent.append(c); continue
        if len(found) != 1: ambiguous.append(c); continue
        if not seen or widths.get(found[0], 0) <= 0 or found[0] == 0: unproven.append(c); continue
        codes.append(found[0])
    if absent or ambiguous or unproven:
        parts = []
        if absent: parts.append(f'원본 {label} 글꼴에 매핑이 없는 문자: ' + describe(absent))
        if ambiguous: parts.append('글리프 매핑이 모호한 문자: ' + describe(ambiguous))
        if unproven: parts.append('원본에서 이 글꼴로 그려진 적이 없어 글리프를 검증할 수 없는 문자: ' + describe(unproven))
        raise ValueError('; '.join(parts) + '. 대체 글꼴을 쓰지 않습니다. 원본 문서에 이 글꼴로 이미 나오는 문자만 사용하도록 After를 수정하세요.')
    return codes

def base14_codec(doc, xref, name, after, drawn):
    import pymupdf as fitz
    get = lambda key: doc.xref_get_key(xref, key)
    basefont = get('BaseFont')[1].lstrip('/') if get('BaseFont')[0] == 'name' else ''
    if basefont not in BASE14: raise ValueError(f'표준 14 글꼴이 아닌 비임베디드 Type1 글꼴({basefont!r})은 지원하지 않습니다.')
    if get('FontDescriptor')[0] != 'null':
        for key in ('FontFile', 'FontFile2', 'FontFile3'):
            if doc.xref_get_key(xref, 'FontDescriptor/' + key)[0] != 'null':
                raise ValueError(f'임베디드 Type1 글꼴({basefont})은 이 codec에서 지원하지 않습니다.')
    kind, value = get('Encoding')
    if kind == 'null': encoding = 'StandardEncoding'
    elif kind == 'name': encoding = value.lstrip('/')
    elif kind in ('dict', 'xref'):
        if doc.xref_get_key(xref, 'Encoding/Differences')[0] != 'null':
            raise ValueError(f'{basefont}의 /Differences 인코딩은 지원하지 않습니다.')
        kind, value = doc.xref_get_key(xref, 'Encoding/BaseEncoding')
        encoding = value.lstrip('/') if kind == 'name' else 'StandardEncoding' if kind == 'null' else ''
    else: encoding = ''
    table = encoding_table(encoding)
    if table is None: raise ValueError(f'{basefont}의 인코딩 {encoding or value!r}은(는) 지원하지 않습니다.')
    if get('ToUnicode')[0] != 'null':
        try: unicode = parse_to_unicode(doc.xref_stream(ref(get('ToUnicode')[1]) or 0) or b'', 1)
        except ValueError as error: raise ValueError(f'{basefont} ToUnicode를 검증할 수 없습니다: {error}') from None
        if any(unicode.get(code, char) != char for code, char in table.items()):
            raise ValueError(f'{basefont} ToUnicode가 /Encoding과 일치하지 않아 모호합니다.')
    font = fitz.Font(BASE14[basefont])
    table = {code: char for code, char in table.items() if font.has_glyph(ord(char), fallback=False)}
    if get('Widths')[0] != 'null':
        first, last = get('FirstChar'), get('LastChar')
        listed = numbers(object_text(doc, *get('Widths'), '/Widths'))
        if first[0] != 'int' or last[0] != 'int' or len(listed) != int(last[1]) - int(first[1]) + 1:
            raise ValueError(f'{basefont}의 /Widths를 검증할 수 없습니다.')
        widths = {code: listed[code - int(first[1])] for code in table if int(first[1]) <= code <= int(last[1])}
    # Unrounded advance of the standard font program PyMuPDF renders/measures (matches text_length).
    else: widths = {code: font.glyph_advance(ord(char)) * 1000 for code, char in table.items()}
    mapping = {code: char for code, char in table.items() if widths.get(code, 0) > 0}
    codes = encode(after, mapping, widths, drawn, basefont)
    return {'xref': xref, 'resource': name, 'mapping': mapping, 'codes': codes,
        'widths': {code: widths[code] for code in mapping}, 'codeBytes': 1}

def type0_codec(doc, xref, name, after, drawn):
    get = lambda key: doc.xref_get_key(xref, key)
    kind, value = get('Encoding')
    if kind != 'name' or value != '/Identity-H':
        raise ValueError(f'Type0 글꼴 인코딩 {value!r}은(는) 지원하지 않습니다(Identity-H만, 세로쓰기/CMap 스트림 제외).')
    kind, value = get('DescendantFonts')
    refs = re.findall(r'(\d+)\s+0\s+R', object_text(doc, kind, value, 'DescendantFonts')) if kind in ('array', 'xref') else []
    if len(refs) != 1: raise ValueError('Type0 글꼴의 DescendantFonts를 확인할 수 없습니다.')
    cid = int(refs[0])
    dget = lambda key: doc.xref_get_key(cid, key)
    if dget('Subtype')[1] not in ('/CIDFontType2', '/CIDFontType0'): raise ValueError('지원하지 않는 CIDFont 종류입니다.')
    if not any(doc.xref_get_key(cid, 'FontDescriptor/' + key)[0] == 'xref' for key in ('FontFile2', 'FontFile3')):
        raise ValueError('Type0 글꼴 프로그램이 임베디드되어 있지 않아 지원하지 않습니다.')
    if get('ToUnicode')[0] != 'xref': raise ValueError('Type0 글꼴에 ToUnicode가 없어 문자 매핑을 검증할 수 없습니다.')
    try: unicode = parse_to_unicode(doc.xref_stream(ref(get('ToUnicode')[1]) or 0) or b'', 2)
    except ValueError as error: raise ValueError(f'Type0 ToUnicode를 검증할 수 없습니다: {error}') from None
    kind, value = dget('DW')
    if kind not in ('null', 'int', 'float'): raise ValueError('CIDFont /DW를 확인할 수 없습니다.')
    default = float(value) if kind != 'null' else 1000.0
    kind, value = dget('W')
    if kind == 'null': listed = {}
    elif kind in ('array', 'xref'): listed = parse_cid_widths(object_text(doc, kind, value, "/W"))
    else: raise ValueError('CIDFont /W를 확인할 수 없습니다.')
    # Identity-H: code == CID.
    mapping = {code: text for code, text in unicode.items() if len(text) == 1}
    widths = {code: listed.get(code, default) for code in mapping}
    codes = encode(after, mapping, widths, drawn, 'Type0')
    return {'xref': xref, 'resource': name, 'mapping': mapping, 'codes': codes, 'widths': widths, 'codeBytes': 2}

def font_codec(doc, page, spanfont, after, drawn):
    """Encode `after` with the page's original font object named `spanfont`.

    `drawn` must contain only characters drawn with this exact font in the source document.
    Returns {'xref', 'resource', 'mapping', 'codes', 'widths', 'codeBytes'}; raises ValueError.
    """
    xref, subtype, name = page_font(doc, page, spanfont)
    if subtype == 'Type0': return type0_codec(doc, xref, name, after, drawn)
    if subtype == 'Type1': return base14_codec(doc, xref, name, after, drawn)
    raise ValueError(f'글꼴 종류 {subtype}는 이 codec에서 지원하지 않습니다.')

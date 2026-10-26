"""Host-generated evidence references for BLUE reread selection.

The catalog covers only text placed in the selection prompt: non-empty segment-index
previews and validated scan quotes. Each id is a content hash of one source span, so a
repeated literal at two offsets gets two ids. Resolution is catalog lookup plus an exact
source check at the bound offsets. It never searches for another occurrence.
"""
import hashlib
import json
import re

# er + at least four digits. Sequential numbers are not used: an id from an older catalog
# must not slide onto a different span when an earlier entry appears or disappears.
_ID_LIKE = re.compile(r'er[0-9]+\Z')
_ID_WELL = re.compile(r'er[0-9]{4,}\Z')
# Exact measurement runs, including internal spaces ("0.003   0.001"). Not a normalizer.
_NUMERIC = re.compile(r'\d+(?:[.,]\d+)*(?:[ \t]+\d+(?:[.,]\d+)*)+|\d+[.,]\d+')
SLICE = 120
_CONTEXT = 40
_CONTEXTS = (40, 16, 0)


def is_evidence_ref_id(anchor):
    """True for id-shaped anchors, including malformed ones that must not fall through to quote search."""
    return isinstance(anchor, str) and _ID_LIKE.fullmatch(anchor) is not None


def ref_id(segment_id, start, end, text):
    raw = json.dumps([segment_id, start, end, text], ensure_ascii=False, separators=(',', ':'))
    number = int(hashlib.sha256(raw.encode('utf-8')).hexdigest()[:12], 16)
    return f'er{number:012d}'


def _occurrences(haystack, needle):
    """Non-overlapping exact offsets. Same rule as str.count; not a first-match guess."""
    if not needle:
        return []
    found, start = [], 0
    while True:
        i = haystack.find(needle, start)
        if i < 0:
            return found
        found.append(i)
        start = i + len(needle)


def _source_map(segments):
    source, order = {}, {}
    for i, s in enumerate(segments or []):
        if not isinstance(s, dict):
            continue
        sid, text = s.get('id'), s.get('text')
        if isinstance(sid, str) and isinstance(text, str) and sid not in source:
            source[sid] = text
            order[sid] = i
    return source, order


def _previews(source, index_entries):
    """(segmentId, offset, preview) rows whose preview is exactly that source slice."""
    rows = []
    for e in index_entries or []:
        if not isinstance(e, dict):
            continue
        sid, preview, off = e.get('segmentId'), e.get('preview'), e.get('offset')
        text = source.get(sid)
        if (not isinstance(sid, str) or not isinstance(preview, str) or preview == '' or type(off) is not int
                or not isinstance(text, str) or off < 0 or off + len(preview) > len(text)):
            continue
        if text[off:off + len(preview)] != preview:
            continue
        rows.append((sid, off, preview))
    return rows


def _context_in(container, rel, length, ctx):
    if ctx <= 0:
        return '', ''
    return container[max(0, rel - ctx):rel], container[rel + length:rel + length + ctx]


def _clip(before, after, ctx):
    if ctx <= 0:
        return '', ''
    return before[-ctx:], after[:ctx]


def _public(cands, ctx):
    refs, seen = [], set()
    for c in cands:
        before, after = _clip(c['before'], c['after'], ctx)
        ref = {'id': ref_id(c['segmentId'], c['start'], c['end'], c['text']), 'segmentId': c['segmentId'],
               'start': c['start'], 'end': c['end'], 'text': c['text'], 'before': before, 'after': after}
        if ref['id'] in seen:
            raise ValueError('BLUE 근거 참조 ID가 충돌합니다.')
        seen.add(ref['id'])
        refs.append(ref)
    return refs


def _fit(cands, budget):
    """Shrink disambiguating context before dropping later spans. Dropped spans are reported, not relabeled."""
    if not cands:
        return [], False
    if budget < 2:
        return [], True
    ordered = sorted(cands, key=lambda c: (c['order'], c['start'], c['end'], c['text']))
    for ctx in _CONTEXTS:
        refs = _public(ordered, ctx)
        if len(json.dumps(refs, ensure_ascii=False)) <= budget:
            return refs, False
    refs = _public(ordered, 0)
    best, lo, hi = 0, 0, len(refs)
    while lo <= hi:
        mid = (lo + hi) // 2
        if len(json.dumps(refs[:mid], ensure_ascii=False)) <= budget:
            best, lo = mid, mid + 1
        else:
            hi = mid - 1
    return refs[:best], best < len(refs)


def build_evidence_refs(segments, index_entries, note_quotes, budget, max_span=300, max_note=600):
    """Return (refs, truncated, delivered_spans).

    budget is the maximum len(json.dumps(refs)). delivered_spans are the exact preview and
    located note-quote intervals a ref is allowed to occupy. Text outside those intervals
    is not copied into a ref.
    """
    source, order = _source_map(segments)
    previews = _previews(source, index_entries)
    spans = [(sid, off, off + len(preview)) for sid, off, preview in previews]
    cands = []

    def add(sid, start, text, before, after):
        if sid not in order or not isinstance(text, str) or not text.strip():
            return
        end = start + len(text)
        if not any(s == sid and a <= start and end <= b for s, a, b in spans):
            return
        cands.append({'order': order[sid], 'segmentId': sid, 'start': start, 'end': end, 'text': text,
                      'before': before, 'after': after})

    for sid, off, preview in previews:
        for rel in range(0, len(preview), SLICE):
            piece = preview[rel:rel + SLICE]
            if len(piece) > max_span:
                continue
            before, after = _context_in(preview, rel, len(piece), _CONTEXT)
            add(sid, off + rel, piece, before, after)
        for match in _NUMERIC.finditer(preview):
            piece = match.group(0)
            if len(piece) > max_span:
                continue
            before, after = _context_in(preview, match.start(), len(piece), _CONTEXT)
            add(sid, off + match.start(), piece, before, after)
    seen_notes = set()
    for item in note_quotes or []:
        if not isinstance(item, (tuple, list)) or len(item) != 2:
            continue
        sid, quote = item
        if not isinstance(sid, str) or not isinstance(quote, str) or not quote.strip() or len(quote) > max_note:
            continue
        text = source.get(sid)
        if not isinstance(text, str) or (sid, quote) in seen_notes:
            continue
        seen_notes.add((sid, quote))
        positions = _occurrences(text, quote)
        located = []
        for pos in positions:
            end = pos + len(quote)
            if any(ps == sid and off <= pos and end <= off + len(preview) for ps, off, preview in previews):
                located.append(pos)
        # A repeated quote that sits in no delivered preview has no determined offset.
        if len(positions) != 1 and not located:
            continue
        chosen = positions if len(positions) == 1 else located
        if len(positions) == 1 and not any(s == sid and a <= positions[0] and positions[0] + len(quote) <= b for s, a, b in spans):
            spans.append((sid, positions[0], positions[0] + len(quote)))
        for pos in chosen:
            before, after = '', ''
            for ps, off, preview in previews:
                if ps == sid and off <= pos and pos + len(quote) <= off + len(preview):
                    before, after = _context_in(preview, pos - off, len(quote), _CONTEXT)
                    break
            add(sid, pos, quote, before, after)
    deduped, seen = [], set()
    for c in cands:
        key = (c['segmentId'], c['start'], c['end'])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(c)
    try:
        limit = int(budget)
    except (TypeError, ValueError):
        limit = 0
    refs, truncated = _fit(deduped, limit)
    return refs, truncated, spans


def resolve_evidence_ref(anchor, segment_id, source_text, visible_texts, catalog, delivered_spans):
    """Return (start, text) for one catalog id. Never searches the source for the literal."""
    if not isinstance(anchor, str) or not _ID_WELL.fullmatch(anchor):
        raise ValueError('BLUE 재독 근거 참조 ID 형식이 올바르지 않습니다.')
    ref = (catalog or {}).get(anchor)
    if not isinstance(ref, dict):
        raise ValueError('BLUE 재독 근거 참조 ID가 이번 선택에 전달된 목록에 없습니다.')
    if ref.get('segmentId') != segment_id:
        raise ValueError('BLUE 재독 근거 참조 ID의 문단이 대상과 다릅니다.')
    start, end, text = ref.get('start'), ref.get('end'), ref.get('text')
    if type(start) is not int or type(end) is not int or not isinstance(text, str) or not isinstance(source_text, str):
        raise ValueError('BLUE 재독 근거 참조가 손상되었습니다.')
    if ref_id(segment_id, start, end, text) != anchor:
        raise ValueError('BLUE 재독 근거 참조 ID가 묶인 범위와 일치하지 않습니다.')
    if not (0 <= start < end <= len(source_text)) or source_text[start:end] != text or end - start != len(text):
        raise ValueError('BLUE 재독 근거 참조가 원문 위치와 일치하지 않습니다.')
    inside = False
    for span in delivered_spans or []:
        if isinstance(span, (tuple, list)) and len(span) == 3:
            sid, a, b = span
            if sid == segment_id and type(a) is int and type(b) is int and a <= start and end <= b:
                inside = True
                break
    if not inside:
        raise ValueError('BLUE 재독 근거 참조가 선택 단계에 전달된 범위 밖입니다.')
    if not any(isinstance(v, str) and text in v for v in visible_texts or []):
        raise ValueError('BLUE 재독 근거 참조가 선택 단계에 전달된 텍스트에 없습니다.')
    return start, text

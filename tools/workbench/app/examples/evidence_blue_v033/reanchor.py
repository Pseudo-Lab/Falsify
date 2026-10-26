"""Formatting-only reanchor for scan evidence quotes. Does not validate or drop items."""
import copy

MIN_NORMALIZED = 24
SCHEMA = 'falsify.blue-evidence-derivation.v0.3.3'


def _letter(char):
    return 'A' <= char <= 'Z' or 'a' <= char <= 'z'


def _line_end_hyphen(text, index):
    """Index of the letter after ASCII '-' + linebreak between ASCII letters, else None."""
    if index <= 0 or text[index] != '-' or not _letter(text[index - 1]):
        return None
    cursor = index + 1
    if cursor >= len(text):
        return None
    if text[cursor] == '\r':
        cursor += 1
        if cursor < len(text) and text[cursor] == '\n':
            cursor += 1
    elif text[cursor] == '\n':
        cursor += 1
    else:
        return None
    if cursor < len(text) and _letter(text[cursor]):
        return cursor
    return None


def normalize(text):
    """Remove whitespace and a line-end hyphen. offsets[k] is the source index of kept char k."""
    kept, offsets = [], []
    index = 0
    while index < len(text):
        if text[index].isspace():
            index += 1
            continue
        after = _line_end_hyphen(text, index)
        if after is not None:
            index = after
            continue
        kept.append(text[index])
        offsets.append(index)
        index += 1
    return ''.join(kept), offsets


def _segments(delivered):
    rows = delivered.get('segments') if isinstance(delivered, dict) else delivered
    grouped = {}
    if not isinstance(rows, list):
        return grouped
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get('id'), str) and isinstance(row.get('text'), str):
            grouped.setdefault(row['id'], []).append(row['text'])
    return grouped


def _hits(fragment, needle):
    normalized, offsets = normalize(fragment)
    found, start = [], 0
    while len(found) < 2:
        at = normalized.find(needle, start)
        if at < 0:
            break
        found.append((offsets[at], offsets[at + len(needle) - 1] + 1))
        start = at + 1
    return found


def _resolve(item, grouped):
    if not isinstance(item, dict) or not isinstance(item.get('quote'), str) or not isinstance(item.get('segmentId'), str):
        return {'decision': 'rejected', 'reason': 'malformed'}, None
    segment_id, quote = item['segmentId'], item['quote']
    fragments = grouped.get(segment_id)
    if not fragments:
        return {'decision': 'rejected', 'reason': 'undelivered', 'segmentId': segment_id}, None
    for fragment_index, fragment in enumerate(fragments):
        at = fragment.find(quote)
        if at >= 0:
            return {'decision': 'exact', 'segmentId': segment_id, 'fragment': fragment_index,
                    'start': at, 'end': at + len(quote)}, None
    needle, _ = normalize(quote)
    base = {'segmentId': segment_id, 'nonWhitespace': len(needle)}
    if len(needle) < MIN_NORMALIZED:
        return {'decision': 'rejected', 'reason': 'short', **base}, None
    hits = []
    for fragment_index, fragment in enumerate(fragments):
        for start, end in _hits(fragment, needle):
            hits.append((fragment_index, start, end, fragment))
            if len(hits) > 1:
                return {'decision': 'rejected', 'reason': 'ambiguous', **base}, None
    if len(hits) != 1:
        return {'decision': 'rejected', 'reason': 'missing', **base}, None
    fragment_index, start, end, fragment = hits[0]
    span = fragment[start:end]
    if normalize(span)[0] != needle:
        return {'decision': 'rejected', 'reason': 'missing', **base}, None
    return {'decision': 'reanchored', 'fragment': fragment_index, 'start': start, 'end': end, **base}, span


def reanchor_scan(response, delivered):
    """Deep-copy a scan response. Replace only a unique formatting alias in evidence[].quote."""
    if not isinstance(response, dict) or not isinstance(response.get('evidence'), list):
        return copy.deepcopy(response), {'schema': SCHEMA, 'stage': 'document-scan', 'applied': False,
                                          'reason': 'not_scan_evidence', 'items': []}
    derived = copy.deepcopy(response)
    grouped = _segments(delivered)
    items = []
    for index, item in enumerate(derived['evidence']):
        record, span = _resolve(item, grouped)
        record['index'] = index
        if span is not None and isinstance(item, dict):
            item['quote'] = span
        items.append(record)
    return derived, {'schema': SCHEMA, 'stage': 'document-scan', 'applied': True,
                     'quoteTextStored': False, 'items': items}

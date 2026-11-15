"""Read-only native PDF text, search, and bibliography extraction backed by EvidenceStore."""
import re
import statistics

import pymupdf

from paper_table_logical import line_text_with_superscripts

MAX_PAGE_TEXT_CHARS = 60_000
MAX_QUERY_CHARS = 200
MAX_SEARCH_LIMIT = 100
MAX_REF_LIMIT = 200
MAX_SCAN_PAGES = 2000

_REF_HEADING = re.compile(
    r'^\s*(?:\d+(?:\.\d+)*\.?\s+)?(references|bibliography|works\s+cited|literature\s+cited|참고\s*문헌)\s*:?\s*$',
    re.IGNORECASE,
)
_POST_REF_HEADING = re.compile(
    r'^\s*(?:[A-Z0-9]+(?:\.\d+)*\.?\s+)?(appendix(?:\s+[A-Z0-9]+)?|supplementary\s+(?:material|information|data|tables|figures)|supporting\s+information|부록)\s*:?\s*$',
    re.IGNORECASE,
)
_SECTION_HINT = re.compile(
    r'^\s*(?:\d+(?:\.\d+)*\.?\s+)?(abstract|introduction|background|methods?|materials?\s+and\s+methods?|results?|discussion|conclusions?|references|bibliography|acknowledgements?|appendix|서론|방법|결과|고찰|결론|참고\s*문헌)\b',
    re.IGNORECASE,
)
_PAGE_NUMBER = re.compile(r'^\s*(?:(?:page|p\.?)\s*)?\d{1,5}(?:\s*(?:/|of)\s*\d{1,5})?\s*$|^\s*[-–—]\s*\d{1,5}\s*[-–—]\s*$', re.IGNORECASE)
_BRACKET_REF = re.compile(r'^\s*\[(\d{1,4})\]\s*(.*)$')
_DOT_REF = re.compile(r'^\s*(\d{1,4})[.)]\s+(\S.*)$')
_AUTHOR_START = re.compile(r'^[A-Z\u00c0-\u024f][A-Za-z\u00c0-\u024f\'\-]+,\s+[A-Z]')
_DOI = re.compile(r'\b(10\.\d{4,9}/[^\s,;)\]>]+)', re.IGNORECASE)
_YEAR = re.compile(r'\b(19\d{2}|20\d{2})[a-z]?\b')


def _default_store():
    from paper_evidence import default_store
    return default_store


def _require_bound_pdf(paper_id, store):
    if type(paper_id) is not str or not 1 <= len(paper_id) <= 160:
        raise ValueError('paper_evidence_id_invalid')
    store = _default_store() if store is None else store
    summary = store.status(paper_id)
    file_hash = summary.get('fileHash')
    if not isinstance(file_hash, str) or not file_hash:
        raise ValueError('paper_evidence_summary_invalid')
    if not hasattr(store, 'source_bytes'):
        raise ValueError('paper_evidence_source_unavailable')
    raw = store.source_bytes(paper_id, file_hash)
    if not isinstance(raw, (bytes, bytearray)) or not bytes(raw).startswith(b'%PDF-'):
        raise ValueError('paper_evidence_source_unavailable')
    return paper_id, file_hash, summary, bytes(raw)


def _open_pdf(raw):
    try:
        doc = pymupdf.open(stream=raw, filetype='pdf')
    except Exception:
        raise ValueError('pdf_invalid') from None
    if doc.needs_pass or doc.page_count < 1 or doc.page_count > MAX_SCAN_PAGES:
        doc.close()
        raise ValueError('pdf_invalid')
    return doc


def _raw_spans(line):
    spans = []
    for sp in line.get('spans', []):
        txt, bbox = sp.get('text', ''), sp.get('bbox')
        if txt and isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            spans.append({'text': txt, 'bbox': [float(v) for v in bbox],
                          'size': float(sp.get('size') or 0.0), 'flags': int(sp.get('flags') or 0)})
    return spans


def _spans_bbox(spans):
    return [
        min(s['bbox'][0] for s in spans), min(s['bbox'][1] for s in spans),
        max(s['bbox'][2] for s in spans), max(s['bbox'][3] for s in spans),
    ]


def _line_metrics(line):
    spans = _raw_spans(line)
    if not spans:
        return None
    text, _changed = line_text_with_superscripts(spans)
    if not text:
        return None
    lbox = line.get('bbox') or _spans_bbox(spans)
    dom = max(spans, key=lambda s: len(s['text']))
    return {
        'text': text,
        'bbox': [round(float(v), 3) for v in lbox],
        'size': dom['size'],
        'bold': bool(dom['flags'] & 16),
    }


def _extract_raw_blocks(page):
    data = page.get_text('dict', flags=pymupdf.TEXT_MEDIABOX_CLIP) or {}
    blocks = []
    for raw_block in data.get('blocks', []):
        if raw_block.get('type') != 0:
            continue
        lines = [rec for ln in raw_block.get('lines', []) if (rec := _line_metrics(ln)) is not None]
        if not lines:
            continue
        bbox = [
            round(min(ln['bbox'][0] for ln in lines), 3),
            round(min(ln['bbox'][1] for ln in lines), 3),
            round(max(ln['bbox'][2] for ln in lines), 3),
            round(max(ln['bbox'][3] for ln in lines), 3),
        ]
        sizes = [ln['size'] for ln in lines if ln['size'] > 0]
        blocks.append({
            'bbox': bbox,
            'lines': lines,
            'text': '\n'.join(ln['text'] for ln in lines),
            'size': statistics.median(sizes) if sizes else 0.0,
            'bold': all(ln['bold'] for ln in lines),
        })
    return blocks, float(page.rect.width), float(page.rect.height)


def _column_kind(bbox, page_width):
    if page_width <= 0:
        return 'full'
    x0, _y0, x1, _y1 = bbox
    mid = page_width / 2.0
    gutter = 0.06 * page_width
    if (x0 < mid - gutter and x1 > mid + gutter) or (x1 - x0) > 0.58 * page_width:
        return 'full'
    return 'left' if (x0 + x1) / 2.0 < mid else 'right'


def _sort_band(band_blocks):
    left = sorted((b for b in band_blocks if b['column'] == 'left'), key=lambda b: (b['bbox'][1], b['bbox'][0]))
    right = sorted((b for b in band_blocks if b['column'] == 'right'), key=lambda b: (b['bbox'][1], b['bbox'][0]))
    if left and right:
        return left + right
    return sorted(band_blocks, key=lambda b: (b['bbox'][1], b['bbox'][0]))


def _order_blocks(blocks, page_width):
    if not blocks:
        return []
    for blk in blocks:
        blk['column'] = _column_kind(blk['bbox'], page_width)
    fulls = sorted((b for b in blocks if b['column'] == 'full'), key=lambda b: (b['bbox'][1], b['bbox'][0]))
    others = [b for b in blocks if b['column'] != 'full']
    ordered, remaining = [], list(others)
    for full in fulls:
        fy = (full['bbox'][1] + full['bbox'][3]) / 2.0
        above = [b for b in remaining if (b['bbox'][1] + b['bbox'][3]) / 2.0 < fy]
        remaining = [b for b in remaining if (b['bbox'][1] + b['bbox'][3]) / 2.0 >= fy]
        ordered.extend(_sort_band(above))
        ordered.append(full)
    ordered.extend(_sort_band(remaining))
    return ordered


def _norm_margin_text(text):
    return re.sub(r'\d+', '#', ' '.join(text.split())).strip().lower()


def _is_margin_box(bbox, page_height):
    return page_height > 0 and (bbox[3] <= 0.11 * page_height or bbox[1] >= 0.89 * page_height)


def _repeated_furniture_keys(doc):
    counts = {}
    sample_limit = min(doc.page_count, 80)
    for idx in range(sample_limit):
        page = doc[idx]
        height = float(page.rect.height)
        seen_on_page = set()
        for blk in page.get_text('blocks'):
            if len(blk) < 7 or blk[6] != 0:
                continue
            bbox = blk[:4]
            if not _is_margin_box(bbox, height):
                continue
            key = _norm_margin_text(blk[4])
            if key and key not in seen_on_page:
                seen_on_page.add(key)
                counts[key] = counts.get(key, 0) + 1
    return {k for k, v in counts.items() if v >= 2}


def _strip_furniture(blocks, page_height, repeated_keys):
    kept = []
    for blk in blocks:
        if _is_margin_box(blk['bbox'], page_height):
            txt = blk['text'].strip()
            if _PAGE_NUMBER.match(txt) or _norm_margin_text(txt) in repeated_keys:
                continue
        kept.append(blk)
    return kept


def _is_heading(blk, body_size):
    txt = ' '.join(blk['text'].split())
    if not txt or len(txt) > 160 or len(blk['lines']) > 3:
        return False
    if body_size > 0 and blk['size'] >= body_size * 1.15:
        return True
    if _REF_HEADING.match(txt) or _POST_REF_HEADING.match(txt):
        return True
    return bool((blk['bold'] or (body_size > 0 and blk['size'] >= body_size * 1.03)) and _SECTION_HINT.match(txt))


def _page_blocks(doc, page_index, section_only, repeated_keys):
    blocks, width, height = _extract_raw_blocks(doc[page_index])
    if section_only:
        blocks = _strip_furniture(blocks, height, repeated_keys)
    ordered = _order_blocks(blocks, width)
    sizes = [b['size'] for b in ordered if b['size'] > 0 and len(b['text']) > 40] or [b['size'] for b in ordered if b['size'] > 0]
    body_size = statistics.median(sizes) if sizes else 0.0
    headings, out = [], []
    for idx, blk in enumerate(ordered):
        heading = _is_heading(blk, body_size)
        if heading:
            headings.append(' '.join(blk['text'].split()))
        out.append({
            'index': idx,
            'bbox': blk['bbox'],
            'text': blk['text'],
            'heading': heading,
            'column': blk['column'],
        })
    return out, headings


def read_page_text(paper_id, page_index, section_only=False, store=None):
    """Read native PDF page text in reading order for one prepared paper."""
    if type(page_index) is not int or page_index < 0:
        raise ValueError('page_index')
    if type(section_only) is not bool:
        raise ValueError('section_only')
    paper_id, file_hash, summary, raw = _require_bound_pdf(paper_id, store)
    if page_index >= summary['pageCount']:
        raise ValueError('page_index')
    with _open_pdf(raw) as doc:
        repeated = _repeated_furniture_keys(doc) if section_only else set()
        blocks, headings = _page_blocks(doc, page_index, section_only, repeated)
    full_text = '\n\n'.join(b['text'] for b in blocks)
    truncated = len(full_text) > MAX_PAGE_TEXT_CHARS
    text = full_text[:MAX_PAGE_TEXT_CHARS] if truncated else full_text
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'pageIndex': page_index,
        'pageNumber': page_index + 1,
        'text': text,
        'blocks': blocks,
        'headings': headings,
        'truncated': truncated,
    }


def _snippet(text, start, end, radius=90):
    lo = max(0, start - radius)
    hi = min(len(text), end + radius)
    prefix = '...' if lo > 0 else ''
    suffix = '...' if hi < len(text) else ''
    return prefix + text[lo:hi].strip() + suffix


def _find_block_match(blk, query, case_sensitive):
    norm = ' '.join(blk['text'].split())
    hay = norm if case_sensitive else norm.lower()
    ndl = query if case_sensitive else query.lower()
    pos = hay.find(ndl)
    if pos >= 0:
        return _snippet(norm, pos, pos + len(ndl))
    return None


def _tokens_match(blk, tokens, case_sensitive):
    norm = ' '.join(blk['text'].split())
    hay = norm if case_sensitive else norm.lower()
    if all(tok in hay for tok in tokens):
        first = hay.find(tokens[0])
        return _snippet(norm, first, first + len(tokens[0]))
    return None


def search_text(paper_id, query, limit=20, case_sensitive=False, store=None):
    """Search native PDF text across pages for a bounded substring or multi-token match."""
    if not isinstance(query, str):
        raise ValueError('query_invalid')
    needle = ' '.join(query.strip().split())
    if not 1 <= len(needle) <= MAX_QUERY_CHARS:
        raise ValueError('query_invalid')
    if type(limit) is not int or not 1 <= limit <= MAX_SEARCH_LIMIT:
        raise ValueError('limit')
    if type(case_sensitive) is not bool:
        raise ValueError('case_sensitive')
    paper_id, file_hash, _summary, raw = _require_bound_pdf(paper_id, store)
    exact_matches, token_matches = [], []
    tokens = (needle if case_sensitive else needle.lower()).split()
    with _open_pdf(raw) as doc:
        for idx in range(doc.page_count):
            blocks, _headings = _page_blocks(doc, idx, False, set())
            for blk in blocks:
                snip = _find_block_match(blk, needle, case_sensitive)
                if snip is not None:
                    exact_matches.append({'pageIndex': idx, 'pageNumber': idx + 1, 'snippet': snip, 'bbox': blk['bbox']})
                elif len(tokens) > 1:
                    tsnip = _tokens_match(blk, tokens, case_sensitive)
                    if tsnip is not None:
                        token_matches.append({'pageIndex': idx, 'pageNumber': idx + 1, 'snippet': tsnip, 'bbox': blk['bbox']})
    chosen = exact_matches if exact_matches else token_matches
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'query': query.strip(),
        'totalMatches': len(chosen),
        'matches': chosen[:limit],
    }


def _collect_ref_lines(doc):
    repeated = _repeated_furniture_keys(doc)
    ref_lines, capturing = [], False
    for idx in range(doc.page_count):
        raw_blocks, width, height = _extract_raw_blocks(doc[idx])
        ordered = _order_blocks(_strip_furniture(raw_blocks, height, repeated), width)
        for blk in ordered:
            for ln in blk['lines']:
                txt = ln['text'].strip()
                if not txt:
                    continue
                if not capturing:
                    if _REF_HEADING.match(txt):
                        capturing = True
                    continue
                if _POST_REF_HEADING.match(txt):
                    return ref_lines, True
                ref_lines.append((idx, ln['bbox'], txt, blk['column']))
    return ref_lines, capturing


def _extract_doi_year(text):
    doi_m = _DOI.search(text)
    doi = doi_m.group(1).rstrip('.,;)') if doi_m else None
    years = _YEAR.findall(text)
    year = int(years[-1]) if years else None
    return doi, year


def _parse_numbered_refs(ref_lines):
    entries, current, expected = [], None, None
    for page_idx, _bbox, txt, _col in ref_lines:
        bm = _BRACKET_REF.match(txt)
        dm = None if bm else _DOT_REF.match(txt)
        if bm:
            num, body = int(bm.group(1)), bm.group(2).strip()
        elif dm:
            num, body = int(dm.group(1)), dm.group(2).strip()
            if not (1 <= num <= 500 and (expected is None and num == 1 or num == expected)):
                num = None
        else:
            num = None
        if num is not None:
            if current is not None:
                entries.append(current)
            current = {'index': num, 'pageIndex': page_idx, 'parts': [body] if body else []}
            expected = num + 1
        elif current is not None:
            current['parts'].append(txt)
    if current is not None:
        entries.append(current)
    return entries


def _looks_like_new_author_ref(current, bbox, txt, col_left):
    prev_text = ' '.join(current['parts'])
    has_year = bool(_YEAR.search(prev_text))
    ends_stop = prev_text.rstrip().endswith(('.', ')', ']')) or bool(_DOI.search(prev_text))
    at_left = abs(bbox[0] - col_left) <= 5.0
    return (has_year or ends_stop) and (at_left and bool(_AUTHOR_START.match(txt)))


def _parse_author_year_refs(ref_lines):
    if not ref_lines:
        return []
    col_lefts = {}
    for _p, bbox, _t, col in ref_lines:
        col_lefts[col] = min(col_lefts[col], bbox[0]) if col in col_lefts else bbox[0]
    entries, current = [], None
    for page_idx, bbox, txt, col in ref_lines:
        if current is None:
            current = {'index': 1, 'pageIndex': page_idx, 'parts': [txt]}
            continue
        if _looks_like_new_author_ref(current, bbox, txt, col_lefts[col]):
            entries.append(current)
            current = {'index': len(entries) + 1, 'pageIndex': page_idx, 'parts': [txt]}
        else:
            current['parts'].append(txt)
    if current is not None:
        entries.append(current)
    return entries


def _format_ref_entry(entry):
    raw_text = ' '.join(p for p in entry['parts'] if p).strip()
    doi, year = _extract_doi_year(raw_text)
    return {
        'index': entry['index'],
        'rawText': raw_text,
        'pageIndex': entry['pageIndex'],
        'doi': doi,
        'year': year,
    }


def list_references(paper_id, offset=0, limit=50, store=None):
    """Extract segmented bibliography/reference entries from the bound PDF."""
    if type(offset) is not int or offset < 0:
        raise ValueError('offset')
    if type(limit) is not int or not 1 <= limit <= MAX_REF_LIMIT:
        raise ValueError('limit')
    paper_id, file_hash, _summary, raw = _require_bound_pdf(paper_id, store)
    with _open_pdf(raw) as doc:
        ref_lines, found_section = _collect_ref_lines(doc)
    if not found_section or not ref_lines:
        return {
            'paperId': paper_id, 'fileHash': file_hash, 'total': 0,
            'offset': offset, 'limit': limit, 'status': 'not_found', 'references': [],
        }
    entries = _parse_numbered_refs(ref_lines)
    if len(entries) < 2 and not any(_BRACKET_REF.match(ln[2]) or _DOT_REF.match(ln[2]) for ln in ref_lines[:5]):
        entries = _parse_author_year_refs(ref_lines)
    formatted = [_format_ref_entry(e) for e in entries if e['parts']]
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'total': len(formatted),
        'offset': offset,
        'limit': limit,
        'status': 'ready' if formatted else 'not_found',
        'references': formatted[offset:offset + limit],
    }

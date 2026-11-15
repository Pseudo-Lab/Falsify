"""Native PDF body text span inspector/mutator and in-memory supplement mutator for coordinated RED."""
import base64
import difflib
import hashlib
from pathlib import Path
import re

import pymupdf

from paper_evidence_text import _order_blocks
from paper_stealth_audit import BLINDNESS_META_PATTERNS
from paper_supplement_audit import infer_supplement_kind
from paper_visual_edit import _font, _span

SCHEMA = 'falsify.text-span-mutation.v1'
LIST_SCHEMA = 'falsify.text-span-list.v1'
SUPPLEMENT_SCHEMA = 'falsify.supplement-mutation.v1'

MAX_SUPPLEMENTS = 12
MAX_SUPPLEMENT_BYTES = 10 * 1024 * 1024
MAX_SPAN_LIMIT = 1000
MAX_AFTER_LEN = 4000
ALLOWED_SUPPLEMENT_EXTS = frozenset({'.txt', '.csv', '.tsv', '.json', '.md', '.log', '.py', '.r'})
FORBIDDEN_RED_KEYS = frozenset({
    'before', 'after', 'patch', 'gold', 'why_hard', 'candidateRationales', 'falsify', 'red-plan',
})
_HINT_TOKENS = (
    'intentional', 'fabricated', 'fake-doi', 'red-team', 'injected', 'falsify-red',
    'red-plan', 'answer-key', 'answer_key', 'tampered', '변조', '가짜', '함정', '정답',
)
_BBOX_FINITE = (int, float)


class SpanMutationError(ValueError):
    """Self-healing mutation error carrying structured nearestCandidates and recoveryHint."""

    def __init__(self, code: str, details: dict | None = None):
        super().__init__(code)
        self.code = code
        payload = dict(details or {})
        payload['error'] = code
        payload.setdefault('nearestCandidates', [])
        payload.setdefault('recoveryHint', 'Inspect target text and retry with exact values.')
        self.details = payload


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _require_pdf_bytes(pdf_bytes: bytes) -> bytes:
    if not isinstance(pdf_bytes, (bytes, bytearray)) or not bytes(pdf_bytes).startswith(b'%PDF-'):
        raise ValueError('pdf_invalid')
    return bytes(pdf_bytes)


def _has_blindness_leak(text: str) -> bool:
    low = text.lower()
    if any(tok in low for tok in _HINT_TOKENS):
        return True
    return any(pat.search(text) for pat in BLINDNESS_META_PATTERNS)


def _join_line_spans(raw_spans: list[dict]) -> tuple[str, dict]:
    ordered = sorted(raw_spans, key=lambda s: s['bbox'][0])
    dom = max(ordered, key=lambda s: len(s['text']))
    base_size = float(dom.get('size') or 10.0)
    parts, prev_x1 = [], None
    for sp in ordered:
        txt = sp['text']
        if prev_x1 is not None and parts and not parts[-1].endswith((' ', '\n')) and not txt.startswith(' '):
            if sp['bbox'][0] - prev_x1 > max(1.0, base_size * 0.18):
                parts.append(' ')
        parts.append(txt)
        prev_x1 = max(prev_x1, sp['bbox'][2]) if prev_x1 is not None else sp['bbox'][2]
    return ''.join(parts).strip(), dom


def _valid_spans(raw_line: dict) -> list[dict]:
    spans = []
    for sp in raw_line.get('spans', []):
        bbox = sp.get('bbox')
        if sp.get('text') and isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            spans.append(sp)
    return spans


def _spans_bbox(spans: list[dict]) -> list[float]:
    return [
        float(min(s['bbox'][0] for s in spans)),
        float(min(s['bbox'][1] for s in spans)),
        float(max(s['bbox'][2] for s in spans)),
        float(max(s['bbox'][3] for s in spans)),
    ]


def _extract_line_record(raw_line: dict) -> dict | None:
    spans = _valid_spans(raw_line)
    if not spans:
        return None
    text, dom = _join_line_spans(spans)
    if not text:
        return None
    raw_bbox = raw_line.get('bbox')
    bbox = [float(v) for v in raw_bbox] if raw_bbox else _spans_bbox(spans)
    origin = dom.get('origin')
    return {
        'text': text,
        'bbox': bbox,
        'font': str(dom.get('font') or 'Helvetica'),
        'size': float(dom.get('size') or 10.0),
        'color': int(dom.get('color') or 0),
        'origin': list(origin) if origin else None,
        'spans': spans,
    }


def _extract_page_blocks(page) -> list[dict]:
    data = page.get_text('dict', flags=pymupdf.TEXT_MEDIABOX_CLIP) or {}
    blocks = []
    for raw_block in data.get('blocks', []):
        if raw_block.get('type') != 0:
            continue
        lines = [rec for ln in raw_block.get('lines', []) if (rec := _extract_line_record(ln)) is not None]
        if not lines:
            continue
        bbox = [
            min(ln['bbox'][0] for ln in lines), min(ln['bbox'][1] for ln in lines),
            max(ln['bbox'][2] for ln in lines), max(ln['bbox'][3] for ln in lines),
        ]
        blocks.append({'bbox': bbox, 'lines': lines, 'text': '\n'.join(ln['text'] for ln in lines)})
    return blocks


def _extract_page_lines(page, page_idx: int) -> list[dict]:
    blocks = _extract_page_blocks(page)
    ordered = _order_blocks(blocks, float(page.rect.width))
    lines, line_idx = [], 0
    for blk in ordered:
        for ln in blk['lines']:
            lines.append({
                'spanId': f'p{page_idx}-l{line_idx}',
                'pageIndex': page_idx,
                'bbox': [round(float(v), 2) for v in ln['bbox']],
                'font': ln['font'],
                'size': round(float(ln['size']), 2),
                'color': ln['color'],
                'origin': ln['origin'],
                'text': ln['text'],
                'blockBbox': [round(float(v), 2) for v in blk['bbox']],
                'column': blk.get('column', 'full'),
                'spans': ln['spans'],
            })
            line_idx += 1
    return lines


def _line_matches_query(text: str, needle: str) -> bool:
    if not needle:
        return True
    low = text.lower()
    return needle in low or needle in ' '.join(low.split())


def list_pdf_text_spans(
    pdf_bytes: bytes,
    page_index: int | None = None,
    query: str | None = None,
    limit: int = 200,
) -> dict:
    """List compact reading-order text lines/spans for exact text-span targeting."""
    raw = _require_pdf_bytes(pdf_bytes)
    if isinstance(limit, bool) or type(limit) is not int or not 1 <= limit <= MAX_SPAN_LIMIT:
        raise ValueError('span_limit_invalid')
    if query is not None and not isinstance(query, str):
        raise ValueError('span_query_invalid')
    needle = ' '.join(query.strip().lower().split()) if query else ''
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        if page_index is not None and (
            isinstance(page_index, bool) or type(page_index) is not int or not 0 <= page_index < len(doc)
        ):
            raise ValueError('paper_evidence_page_invalid')
        indices = [page_index] if page_index is not None else list(range(len(doc)))
        matched = []
        for idx in indices:
            for ln in _extract_page_lines(doc[idx], idx):
                if _line_matches_query(ln['text'], needle):
                    matched.append({
                        'spanId': ln['spanId'],
                        'pageIndex': ln['pageIndex'],
                        'bbox': ln['bbox'],
                        'font': ln['font'],
                        'size': ln['size'],
                        'text': ln['text'],
                    })
    return {
        'schema': LIST_SCHEMA,
        'spanCount': min(len(matched), limit),
        'totalMatches': len(matched),
        'truncated': len(matched) > limit,
        'spans': matched[:limit],
    }


def _line_similarity(target: str, candidate: str) -> float:
    t_low, c_low = target.lower(), candidate.lower()
    if t_low in c_low or c_low in t_low:
        return 0.9 + 0.1 * difflib.SequenceMatcher(None, t_low, c_low).ratio()
    t_tokens = set(re.findall(r'[a-z0-9._-]+', t_low))
    c_tokens = set(re.findall(r'[a-z0-9._-]+', c_low))
    overlap = len(t_tokens & c_tokens) / max(1, len(t_tokens | c_tokens))
    seq = difflib.SequenceMatcher(None, t_low, c_low).ratio()
    return 0.65 * seq + 0.35 * overlap


def _nearest_line_candidates(page_lines: list[dict], target: str, limit: int = 3) -> list[dict]:
    scored = sorted(
        page_lines,
        key=lambda ln: _line_similarity(target, ln['text']),
        reverse=True,
    )
    return [
        {'spanId': ln['spanId'], 'pageIndex': ln['pageIndex'], 'bbox': ln['bbox'], 'text': ln['text']}
        for ln in scored[:limit]
    ]


def _validate_bbox(bbox) -> list[float] | None:
    if bbox is None:
        return None
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        raise SpanMutationError('text_span_bbox_invalid', {
            'recoveryHint': 'bbox must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.',
        })
    vals = [float(v) for v in bbox]
    if any(isinstance(v, bool) or type(v) not in _BBOX_FINITE for v in bbox) or vals[2] <= vals[0] or vals[3] <= vals[1]:
        raise SpanMutationError('text_span_bbox_invalid', {
            'recoveryHint': 'bbox coordinates must be finite numbers with x1 > x0 and y1 > y0.',
        })
    return vals


def _validate_before_after_occ(op: dict, prefix: str, ctx: dict) -> tuple[str, str, int]:
    before, after, occ = op.get('before'), op.get('after'), op.get('occurrence', 0)
    if not isinstance(before, str) or not before.strip():
        raise SpanMutationError(f'{prefix}_before_invalid', {
            **ctx, 'recoveryHint': 'Provide a non-empty exact string for "before".',
        })
    if not isinstance(after, str) or '\x00' in after or len(after) > MAX_AFTER_LEN or after == before:
        raise SpanMutationError(f'{prefix}_after_invalid', {
            **ctx, 'recoveryHint': 'Provide a valid non-identical "after" string without NUL bytes.',
        })
    if _has_blindness_leak(after):
        raise SpanMutationError(f'{prefix}_blindness_rejected', {
            **ctx, 'recoveryHint': 'Replacement text contains blindness-leaking keywords; use neutral scientific wording.',
        })
    if isinstance(occ, bool) or type(occ) is not int or occ < 0:
        raise SpanMutationError(f'{prefix}_occurrence_invalid', {
            **ctx, 'recoveryHint': 'occurrence must be a non-negative integer.',
        })
    return before, after, occ


def _validate_text_op(op: dict, page_count: int, idx: int) -> dict:
    if not isinstance(op, dict):
        raise ValueError('text_span_operation_invalid')
    op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'text-op-{idx}'
    page_idx = op.get('pageIndex')
    if isinstance(page_idx, bool) or type(page_idx) is not int or not 0 <= page_idx < page_count:
        raise SpanMutationError('paper_evidence_page_invalid', {
            'pageIndex': page_idx,
            'recoveryHint': f'pageIndex must be an integer in 0..{max(0, page_count - 1)}.',
        })
    before, after, occ = _validate_before_after_occ(op, 'text_span', {'pageIndex': page_idx})
    span_id = op.get('spanId')
    return {
        'id': op_id,
        'pageIndex': page_idx,
        'before': before,
        'after': after,
        'occurrence': occ,
        'bbox': _validate_bbox(op.get('bbox')),
        'spanId': span_id if isinstance(span_id, str) else None,
    }


def _find_clip_rect(page, page_lines: list[dict], op: dict):
    if op['bbox'] is not None:
        return pymupdf.Rect(op['bbox'])
    if op['spanId']:
        hit = next((ln for ln in page_lines if ln['spanId'] == op['spanId']), None)
        if hit is None:
            raise SpanMutationError('text_span_not_found', {
                'pageIndex': op['pageIndex'],
                'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
                'recoveryHint': f"spanId '{op['spanId']}' was not found on page {op['pageIndex']}. Call list_text_spans.",
            })
        return pymupdf.Rect(hit['bbox']) + (-2, -2, 2, 2)
    return None


def _match_span_rect(page, page_lines: list[dict], op: dict) -> pymupdf.Rect:
    clip = _find_clip_rect(page, page_lines, op)
    rects = page.search_for(op['before'], clip=clip)
    cands = _nearest_line_candidates(page_lines, op['before'])
    if not rects:
        raise SpanMutationError('text_span_not_found', {
            'pageIndex': op['pageIndex'],
            'nearestCandidates': cands,
            'recoveryHint': (
                f"Exact text '{op['before'][:60]}' not found on page {op['pageIndex']}. "
                'Copy exact text from nearestCandidates or call list_text_spans.'
            ),
        })
    if op['occurrence'] >= len(rects):
        raise SpanMutationError('text_span_occurrence_out_of_range', {
            'pageIndex': op['pageIndex'],
            'matchCount': len(rects),
            'nearestCandidates': cands,
            'recoveryHint': (
                f"Requested occurrence {op['occurrence']}, but found {len(rects)} match(es) on page "
                f"{op['pageIndex']}. Use occurrence in 0..{len(rects) - 1}."
            ),
        })
    return pymupdf.Rect(rects[op['occurrence']])


def _line_for_rect(page_lines: list[dict], rect: pymupdf.Rect) -> dict | None:
    best, best_area = None, 0.0
    for ln in page_lines:
        inter = (pymupdf.Rect(ln['bbox']) & rect).get_area()
        if inter > best_area:
            best, best_area = ln, inter
    return best


def _max_line_width(page, page_lines: list[dict], rect: pymupdf.Rect, matched_line: dict | None) -> float:
    rect_cy = (rect.y0 + rect.y1) / 2.0
    right_neighbors = []
    for ln in page_lines:
        for sp in ln['spans']:
            sb = sp['bbox']
            sp_cy = (sb[1] + sb[3]) / 2.0
            if abs(sp_cy - rect_cy) <= max(4.0, rect.height * 0.55) and sb[0] >= rect.x1 - 1.5:
                right_neighbors.append(sb[0])
    if right_neighbors:
        return max(rect.width, min(right_neighbors) - rect.x0 - 0.5)
    page_w = float(page.rect.width)
    col = matched_line.get('column', 'full') if matched_line else 'full'
    col_right = page_w * 0.48 if col == 'left' else page_w - 36.0
    blk_right = matched_line['blockBbox'][2] if matched_line else rect.x1
    return max(rect.width, min(col_right, max(blk_right + 24.0, rect.x1 + 36.0)) - rect.x0)


def _fit_font_size(font_metrics, text: str, orig_size: float, max_width: float) -> tuple[float | None, float | None]:
    if not text:
        return orig_size, 0.0
    min_size = min(orig_size, max(5.5, orig_size * 0.78))
    size = orig_size
    while size >= min_size - 1e-6:
        width = font_metrics.text_length(text, fontsize=size)
        if width <= max_width + 0.5:
            return round(size, 3), width
        size -= 0.25
    return None, None


def _color_tuple(color_int: int) -> tuple[float, float, float]:
    return ((color_int >> 16 & 255) / 255.0, (color_int >> 8 & 255) / 255.0, (color_int & 255) / 255.0)


def _plan_page_text_op(doc, page, page_lines: list[dict], op: dict, font_idx: int, prior_rects: list) -> dict:
    rect = _match_span_rect(page, page_lines, op)
    if any((r & rect).get_area() > 0.01 for r in prior_rects):
        raise SpanMutationError('text_span_operations_overlap', {
            'pageIndex': op['pageIndex'],
            'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
            'recoveryHint': 'Two text-span operations target overlapping regions on the same page.',
        })
    matched_line = _line_for_rect(page_lines, rect)
    span = _span(page, rect)
    if not span.get('origin') and matched_line and matched_line.get('origin'):
        span = {**span, 'origin': matched_line['origin']}
    try:
        font_name, substituted, font_metrics = _font(doc, page, span, op['after'], font_idx)
    except ValueError as exc:
        raise SpanMutationError('text_span_font_missing', {
            'pageIndex': op['pageIndex'],
            'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
            'recoveryHint': f'Font cannot render replacement glyphs ({exc}); use ASCII/standard characters.',
        }) from None
    orig_size = max(4.0, float(span.get('size') or 10.0))
    max_width = _max_line_width(page, page_lines, rect, matched_line)
    fitted_size, fitted_width = _fit_font_size(font_metrics, op['after'], orig_size, max_width)
    if fitted_size is None:
        raise SpanMutationError('text_span_no_room', {
            'pageIndex': op['pageIndex'],
            'nearestCandidates': _nearest_line_candidates(page_lines, op['before']),
            'recoveryHint': (
                f"Replacement '{op['after'][:40]}' exceeds available width ({round(max_width, 1)}pt). "
                'Shorten "after" so it fits cleanly inside the column/line.'
            ),
        })
    origin_y = float(span['origin'][1]) if span.get('origin') else float(rect.y1 - max(1.0, fitted_size * 0.2))
    mod_x1 = max(rect.x1, rect.x0 + fitted_width)
    return {
        'op': op,
        'rect': rect,
        'modBbox': [round(float(v), 2) for v in (rect.x0, rect.y0, mod_x1, rect.y1)],
        'fontName': font_name,
        'fontSubstituted': substituted,
        'fittedSize': fitted_size,
        'origSize': orig_size,
        'originY': origin_y,
        'color': _color_tuple(int(span.get('color') or 0)),
    }


def _apply_page_text_plans(page, plans: list[dict]) -> None:
    for plan in plans:
        page.add_redact_annot(plan['rect'], fill=False, cross_out=False)
    page.apply_redactions(images=0, graphics=0, text=0)
    for plan in plans:
        op = plan['op']
        if op['after']:
            page.insert_text(
                (plan['rect'].x0, plan['originY']),
                op['after'],
                fontname=plan['fontName'],
                fontsize=plan['fittedSize'],
                color=plan['color'],
                overlay=True,
            )


def _text_change_record(plan: dict) -> dict:
    op = plan['op']
    return {
        'id': op['id'],
        'kind': 'text-span',
        'pageIndex': op['pageIndex'],
        'bbox': plan['modBbox'],
        'before': op['before'],
        'after': op['after'],
        'occurrence': op['occurrence'],
        'font': plan['fontName'],
        'fontSubstituted': plan['fontSubstituted'],
        'fontSize': round(float(plan['fittedSize']), 2),
        'originalFontSize': round(float(plan['origSize']), 2),
    }


def mutate_pdf_text_spans(pdf_bytes: bytes, operations: list[dict]) -> dict:
    """Apply stealth glyph-only text-span replacements on an in-memory PDF copy."""
    raw = _require_pdf_bytes(pdf_bytes)
    if not isinstance(operations, list):
        raise ValueError('text_span_operations_invalid')
    if not operations:
        return {
            'schema': SCHEMA,
            'sourceSha256': _sha256(raw),
            'outputSha256': _sha256(raw),
            'appliedCount': 0,
            'changes': [],
            'modifiedRegions': [],
            'pdfBytes': raw,
        }
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        validated = [_validate_text_op(op, len(doc), i) for i, op in enumerate(operations)]
        by_page: dict[int, list[dict]] = {}
        for op in validated:
            by_page.setdefault(op['pageIndex'], []).append(op)
        all_plans = []
        font_idx = 0
        for page_idx, page_ops in by_page.items():
            page = doc[page_idx]
            page_lines = _extract_page_lines(page, page_idx)
            page_plans, prior_rects = [], []
            for op in page_ops:
                plan = _plan_page_text_op(doc, page, page_lines, op, font_idx, prior_rects)
                prior_rects.append(plan['rect'])
                page_plans.append(plan)
                font_idx += 1
            all_plans.append((page, page_plans))
        changes, modified_regions = [], []
        for page, page_plans in all_plans:
            _apply_page_text_plans(page, page_plans)
            for plan in page_plans:
                changes.append(_text_change_record(plan))
                modified_regions.append({'pageIndex': plan['op']['pageIndex'], 'bbox': plan['modBbox']})
        out_bytes = doc.tobytes(garbage=4, deflate=True)
    return {
        'schema': SCHEMA,
        'sourceSha256': _sha256(raw),
        'outputSha256': _sha256(out_bytes),
        'appliedCount': len(changes),
        'changes': changes,
        'modifiedRegions': modified_regions,
        'pdfBytes': out_bytes,
    }


def _load_single_supplement(path_obj: Path, idx: int, total_bytes: int) -> tuple[dict, int]:
    if path_obj.suffix.lower() not in ALLOWED_SUPPLEMENT_EXTS or not path_obj.is_file():
        raise ValueError('supplement_file_invalid')
    try:
        size = path_obj.stat().st_size
        raw = path_obj.read_bytes()
    except OSError:
        raise ValueError('supplement_file_invalid') from None
    if len(raw) != size or size > MAX_SUPPLEMENT_BYTES or total_bytes + size > MAX_SUPPLEMENT_BYTES:
        raise ValueError('supplement_size_limit')
    if b'\x00' in raw:
        raise ValueError('supplement_encoding_invalid')
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('supplement_encoding_invalid') from None
    return {
        'supplementId': f'supp-{idx}',
        'name': path_obj.name,
        'kind': infer_supplement_kind(path_obj.name),
        'sha256': _sha256(raw),
        'sizeBytes': size,
        'lineCount': len(text.splitlines()),
        'text': text,
    }, total_bytes + size


def load_red_supplements(paths: list[str | Path] | None) -> list[dict]:
    """Load up to 12 immutable UTF-8 supplement files into memory (max 10 MiB total)."""
    if not paths:
        return []
    if not isinstance(paths, (list, tuple)) or len(paths) > MAX_SUPPLEMENTS:
        raise ValueError('supplement_count_limit')
    loaded, total_bytes = [], 0
    for idx, item in enumerate(paths):
        rec, total_bytes = _load_single_supplement(Path(item), idx, total_bytes)
        loaded.append(rec)
    return loaded


def normalize_supplements(supplements) -> list[dict]:
    """Accept either startup file paths or pre-loaded supplement dicts."""
    if not supplements:
        return []
    if not isinstance(supplements, (list, tuple)) or len(supplements) > MAX_SUPPLEMENTS:
        raise ValueError('supplement_count_limit')
    if all(isinstance(s, (str, Path)) for s in supplements):
        return load_red_supplements(list(supplements))
    out, total = [], 0
    for idx, entry in enumerate(supplements):
        if not isinstance(entry, dict) or not isinstance(entry.get('text'), str) or '\x00' in entry['text']:
            raise ValueError('supplement_entry_invalid')
        name = Path(str(entry.get('name') or f'supplement-{idx}.txt')).name
        raw = entry['text'].encode('utf-8')
        total += len(raw)
        if total > MAX_SUPPLEMENT_BYTES:
            raise ValueError('supplement_size_limit')
        out.append({
            'supplementId': str(entry.get('supplementId') or f'supp-{idx}'),
            'name': name,
            'kind': entry.get('kind') or infer_supplement_kind(name),
            'sha256': _sha256(raw),
            'sizeBytes': len(raw),
            'lineCount': len(entry['text'].splitlines()),
            'text': entry['text'],
        })
    return out


def _nearest_supplement_lines(text: str, target: str, limit: int = 3) -> list[dict]:
    lines = [{'lineNumber': i + 1, 'text': ln} for i, ln in enumerate(text.splitlines()) if ln.strip()]
    ranked = sorted(lines, key=lambda item: _line_similarity(target, item['text']), reverse=True)
    return ranked[:limit]


def _find_occurrences(text: str, needle: str) -> list[int]:
    positions, start = [], 0
    while True:
        pos = text.find(needle, start)
        if pos == -1:
            return positions
        positions.append(pos)
        start = pos + len(needle)


def _resolve_supplement_target(state: dict[str, dict], op: dict) -> dict:
    sid = op.get('supplementId')
    name = op.get('name')
    for rec in state.values():
        if sid and (rec['supplementId'] == sid or rec['name'] == sid):
            return rec
        if name and rec['name'] == name:
            return rec
    cands = [{'supplementId': r['supplementId'], 'name': r['name']} for r in list(state.values())[:3]]
    raise SpanMutationError('supplement_not_found', {
        'pageIndex': None,
        'nearestCandidates': cands,
        'recoveryHint': 'Target supplement not found. Call list_red_supplements for valid supplementId/name.',
    })


def _apply_single_supplement_op(state: dict[str, dict], op: dict, idx: int) -> dict:
    target = _resolve_supplement_target(state, op)
    before, after, occ = _validate_before_after_occ(
        op, 'supplement', {'supplementId': target['supplementId'], 'supplementName': target['name']},
    )
    positions = _find_occurrences(target['text'], before)
    cands = _nearest_supplement_lines(target['text'], before)
    if not positions:
        raise SpanMutationError('supplement_before_not_found', {
            'supplementId': target['supplementId'],
            'supplementName': target['name'],
            'nearestCandidates': cands,
            'recoveryHint': (
                f"Exact 'before' text not found in {target['name']}. "
                'Copy a line from nearestCandidates or call list_red_supplements.'
            ),
        })
    if occ >= len(positions):
        raise SpanMutationError('supplement_occurrence_out_of_range', {
            'supplementId': target['supplementId'],
            'supplementName': target['name'],
            'matchCount': len(positions),
            'nearestCandidates': cands,
            'recoveryHint': f'Requested occurrence {occ}, found {len(positions)} match(es) (0..{len(positions) - 1}).',
        })
    pos = positions[occ]
    target['text'] = target['text'][:pos] + after + target['text'][pos + len(before):]
    op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'supp-op-{idx}'
    return {
        'id': op_id,
        'kind': 'supplement-edit',
        'supplementId': target['supplementId'],
        'supplementName': target['name'],
        'before': before,
        'after': after,
        'occurrence': occ,
    }


def assert_blind_supplements(value) -> None:
    """Reject any RED ground-truth keys inside blindSupplements."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_RED_KEYS:
                raise ValueError(f'forbidden_red_key_{key}')
            assert_blind_supplements(item)
    elif isinstance(value, list):
        for item in value:
            assert_blind_supplements(item)


def mutate_supplements(supplements: list[dict], operations: list[dict]) -> dict:
    """Apply in-memory supplement-edit operations and return blind mutated payloads."""
    state = {rec['supplementId']: dict(rec) for rec in supplements}
    changes = [_apply_single_supplement_op(state, op, idx) for idx, op in enumerate(operations)]
    blind = []
    for rec in state.values():
        raw = rec['text'].encode('utf-8')
        blind.append({
            'supplementId': rec['supplementId'],
            'name': rec['name'],
            'kind': rec['kind'],
            'sha256': _sha256(raw),
            'sizeBytes': len(raw),
            'contentBase64': base64.b64encode(raw).decode('ascii'),
            'text': rec['text'],
        })
    assert_blind_supplements(blind)
    return {
        'schema': SUPPLEMENT_SCHEMA,
        'appliedCount': len(changes),
        'changes': changes,
        'blindSupplements': blind,
    }

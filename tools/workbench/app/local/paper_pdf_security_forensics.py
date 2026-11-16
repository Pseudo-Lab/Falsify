"""Offline PDF security auditor for hidden text and prompt-injection directives.

Deterministic and network-free. Accepts raw PDF bytes or a bound evidence
``paper_id``. PyMuPDF text traces, page dictionaries, content streams,
annotations, and document metadata are the only inputs.
"""
import hashlib
import re

import pymupdf

from paper_evidence_blue import require_summary
from paper_evidence_text import _open_pdf, _require_bound_pdf

SCHEMA = "falsify.pdf-security-forensics.v1"
MAX_SECURITY_PAGES = 80
_WHITE_LEVEL = 248
_FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "why_hard", "candidateRationales", "plan",
})
_TOPIC_RE = re.compile(
    r"prompt\s+injection|jailbreak|llm\s+security|adversarial\s+prompt",
    re.IGNORECASE,
)
_INJECTION_RES = (
    re.compile(r"ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions", re.IGNORECASE),
    re.compile(r"disregard\s+(?:all\s+)?(?:previous|prior)\s+instructions", re.IGNORECASE),
    re.compile(r"system\s+prompt\s*:", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+a\s+helpful", re.IGNORECASE),
    re.compile(r"classify\s+this\s+(?:paper|manuscript)\s+as\s+clean", re.IGNORECASE),
    re.compile(r"report\s+zero\s+defects", re.IGNORECASE),
    re.compile(r"do\s+not\s+report\s+any\s+(?:errors|defects|findings)", re.IGNORECASE),
    re.compile(r"이전\s*지시를\s*(?:모두\s*)?무시"),
    re.compile(r"결함\s*없음으로\s*(?:판정|보고)"),
)
_BT_RE = re.compile(r"\bBT\b(.*?)\bET\b", re.DOTALL)
_TR_RE = re.compile(r"(?<![\d.])(\d+)\s+Tr\b")
_LITERAL_RE = re.compile(r"\(((?:\\.|[^\\)])*)\)")
_HEX_RE = re.compile(r"<([0-9A-Fa-f\s]{4,})>")
_TM_RE = re.compile(
    r"([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s+"
    r"([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s+"
    r"([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s+Tm"
)
_TF_RE = re.compile(r"/[^\s]+\s+([+-]?\d+(?:\.\d+)?)\s+Tf")
_META_FIELDS = ("title", "subject", "keywords", "author")
_HEADING_FIELDS = ("title", "subject", "keywords")


def _require_limit(value):
    if isinstance(value, bool) or type(value) is not int or not 1 <= value <= 100:
        raise ValueError("limit")


def _reject_red_keys(obj):
    if isinstance(obj, dict):
        _reject_red_dict(obj)
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            _reject_red_keys(item)


def _reject_red_dict(obj):
    for key, val in obj.items():
        if key in _FORBIDDEN_RED_KEYS:
            raise ValueError("forbidden_red_key")
        _reject_red_keys(val)


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _resolve_pdf(paper_id_or_bytes, file_hash, store):
    if isinstance(paper_id_or_bytes, (bytes, bytearray)):
        raw = bytes(paper_id_or_bytes)
        if not raw.startswith(b"%PDF-"):
            raise ValueError("pdf_invalid")
        digest = _sha256(raw)
        if file_hash is not None and file_hash != digest:
            raise ValueError("paper_evidence_hash_mismatch")
        return None, digest, raw
    if type(paper_id_or_bytes) is not str:
        raise ValueError("paper_evidence_id_invalid")
    paper_id, actual_hash, summary, raw = _require_bound_pdf(paper_id_or_bytes, store)
    require_summary(summary, paper_id=paper_id, file_hash=file_hash)
    return paper_id, actual_hash, raw


def _channels(color):
    if isinstance(color, bool) or color is None:
        return None
    if isinstance(color, int):
        return _int_channels(color)
    if isinstance(color, float):
        return _float_channels(color)
    if isinstance(color, (list, tuple)) and color:
        return _seq_channels(color)
    return None


def _int_channels(color):
    if color < 0:
        return None
    if color <= 255:
        return (color, color, color)
    return ((color >> 16) & 255, (color >> 8) & 255, color & 255)


def _float_channels(color):
    scaled = color * 255.0 if color <= 1.0 else color
    value = int(round(scaled))
    return (value, value, value)


def _seq_channels(color):
    vals = []
    for item in list(color)[:3]:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            return None
        vals.append(item * 255.0 if float(item) <= 1.0 else float(item))
    if len(vals) == 1:
        vals = vals * 3
    if len(vals) < 3:
        return None
    return tuple(int(round(value)) for value in vals[:3])


def _near_white(color):
    channels = _channels(color)
    if channels is None:
        return False
    return all(channel >= _WHITE_LEVEL for channel in channels)


def _dark_fill(fill):
    channels = _channels(fill)
    if channels is None:
        return False
    brightness = 0.299 * channels[0] + 0.587 * channels[1] + 0.114 * channels[2]
    return brightness <= 115.0


def _bbox_tuple(raw):
    if raw is None or isinstance(raw, (str, bytes)):
        return None
    try:
        box = (float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))
    except (TypeError, ValueError, IndexError, KeyError):
        return None
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    return box


def _intersects(left, right):
    return left[0] < right[2] and left[2] > right[0] and left[1] < right[3] and left[3] > right[1]


def _outside(bbox, width, height):
    return not _intersects(bbox, (0.0, 0.0, float(width), float(height)))


def _collapsed(text):
    return " ".join(str(text or "").split())


def _injection_match(text):
    if not text:
        return None
    for pattern in _INJECTION_RES:
        found = pattern.search(text)
        if found:
            return found
    return None


def _excerpt_around(text, match):
    start = max(0, match.start() - 40)
    end = min(len(text), match.end() + 40)
    return _collapsed(text[start:end])[:220]


def _trace_text(chars):
    parts = []
    for char in chars or []:
        if not isinstance(char, (list, tuple)) or not char:
            continue
        code = char[0]
        if isinstance(code, int) and 0 < code <= 0x10FFFF:
            parts.append(chr(code))
    return "".join(parts)


def _trace_spans(page, page_index):
    spans = []
    try:
        trace = page.get_texttrace() or []
    except Exception:
        return spans
    for item in trace:
        span = _trace_span(item, page_index)
        if span is not None:
            spans.append(span)
    return spans


def _trace_span(item, page_index):
    if not isinstance(item, dict):
        return None
    text = _trace_text(item.get("chars"))
    if not text.strip():
        return None
    return {
        "text": text,
        "size": float(item.get("size") or 0.0),
        "color": item.get("color"),
        "bbox": _bbox_tuple(item.get("bbox")),
        "render": int(item.get("type") or 0),
        "pageIndex": page_index,
        "origin": "span",
    }


def _dict_spans(page, page_index):
    spans = []
    try:
        data = page.get_text("dict") or {}
    except Exception:
        return spans
    for block in data.get("blocks") or []:
        if not isinstance(block, dict) or block.get("type") != 0:
            continue
        for line in block.get("lines") or []:
            spans.extend(_line_spans(line, page_index))
    return spans


def _line_spans(line, page_index):
    spans = []
    if not isinstance(line, dict):
        return spans
    for span in line.get("spans") or []:
        made = _dict_span(span, page_index)
        if made is not None:
            spans.append(made)
    return spans


def _dict_span(span, page_index):
    if not isinstance(span, dict):
        return None
    text = str(span.get("text") or "")
    if not text.strip():
        return None
    return {
        "text": text,
        "size": float(span.get("size") or 0.0),
        "color": span.get("color"),
        "bbox": _bbox_tuple(span.get("bbox")),
        "render": 0,
        "pageIndex": page_index,
        "origin": "span",
    }


def _span_key(span):
    box = span.get("bbox") or ()
    rounded = tuple(round(value, 1) for value in box) if box else ()
    return (_collapsed(span.get("text")), rounded)


def _merge_spans(page, page_index):
    merged = []
    seen = set()
    for span in _trace_spans(page, page_index) + _dict_spans(page, page_index):
        key = _span_key(span)
        if key in seen:
            continue
        seen.add(key)
        merged.append(span)
    return merged, seen


def _unescape_literal(body):
    out, index = [], 0
    while index < len(body):
        char = body[index]
        if char != "\\":
            out.append(char)
            index += 1
            continue
        index += 1
        if index >= len(body):
            break
        out.append({"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f"}.get(body[index], body[index]))
        index += 1
    return "".join(out)


def _hex_text(body):
    compact = re.sub(r"\s+", "", body)
    if len(compact) < 4 or len(compact) % 2:
        return ""
    try:
        return bytes.fromhex(compact).decode("latin1")
    except ValueError:
        return ""


def _block_strings(block):
    found = []
    for match in _LITERAL_RE.finditer(block):
        text = _unescape_literal(match.group(1))
        if text.strip():
            found.append(text)
    for match in _HEX_RE.finditer(block):
        text = _hex_text(match.group(1))
        if text.strip():
            found.append(text)
    return found


def _last_render_mode(block):
    modes = [int(value) for value in _TR_RE.findall(block)]
    if not modes:
        return None
    return modes[-1]


def _stream_bbox(block, page_height, text):
    placed = _TM_RE.search(block)
    if placed is None:
        return None
    x_pos = float(placed.group(5))
    pdf_y = float(placed.group(6))
    size_match = _TF_RE.search(block)
    size = float(size_match.group(1)) if size_match else 12.0
    width = max(size, len(text) * size * 0.5)
    top = page_height - pdf_y - size * 0.25
    return (x_pos, top, x_pos + width, top + size)


def _stream_spans(page, page_index, seen):
    spans = []
    try:
        raw = page.read_contents() or b""
    except Exception:
        return spans
    text = raw.decode("latin1", errors="replace")
    height = float(page.rect.height)
    for block in _BT_RE.findall(text):
        if _last_render_mode(block) != 3:
            continue
        spans.extend(_invisible_block_spans(block, page_index, height, seen))
    return spans


def _invisible_block_spans(block, page_index, height, seen):
    spans = []
    for text in _block_strings(block):
        key = (_collapsed(text), ())
        if any(key[0] and key[0] in existing[0] for existing in seen):
            continue
        bbox = _stream_bbox(block, height, text)
        span = {
            "text": text,
            "size": 12.0,
            "color": 0,
            "bbox": bbox,
            "render": 3,
            "pageIndex": page_index,
            "origin": "span",
        }
        seen.add(_span_key(span))
        spans.append(span)
    return spans


def _page_spans(page, page_index):
    merged, seen = _merge_spans(page, page_index)
    merged.extend(_stream_spans(page, page_index, seen))
    return merged


def _image_records(page):
    records = []
    try:
        infos = page.get_image_info() or []
    except Exception:
        return records
    page_area = float(page.rect.width) * float(page.rect.height)
    for info in infos:
        box = _bbox_tuple(info.get("bbox") if isinstance(info, dict) else None)
        if box is None or page_area <= 0:
            continue
        area = (box[2] - box[0]) * (box[3] - box[1])
        records.append({"bbox": box, "scan": area >= 0.70 * page_area})
    return records


def _drawings(page):
    try:
        return page.get_drawings() or []
    except Exception:
        return []


def _dark_rect(drawings, bbox):
    for draw in drawings:
        if not isinstance(draw, dict) or not _dark_fill(draw.get("fill")):
            continue
        box = _bbox_tuple(draw.get("rect"))
        if box is not None and _intersects(bbox, box):
            return True
    return False


def _mean_grey(pix):
    count = pix.width * pix.height
    if count <= 0 or pix.n <= 0:
        return 255.0
    total, seen = 0.0, 0
    step = 1 if count < 4000 else 4
    for y in range(0, pix.height, step):
        for x in range(0, pix.width, step):
            off = (y * pix.width + x) * pix.n
            if pix.n >= 3:
                grey = 0.299 * pix.samples[off] + 0.587 * pix.samples[off + 1] + 0.114 * pix.samples[off + 2]
            else:
                grey = float(pix.samples[off])
            total += grey
            seen += 1
    if seen == 0:
        return 255.0
    return total / seen


def _dark_image(page, bbox, images):
    for image in images:
        if not _intersects(bbox, image["bbox"]):
            continue
        try:
            pix = page.get_pixmap(clip=pymupdf.Rect(*bbox), dpi=36, alpha=False)
        except Exception:
            continue
        if _mean_grey(pix) <= 115.0:
            return True
    return False


def _dark_backing(page, bbox, drawings, images):
    if bbox is None:
        return False
    if _dark_rect(drawings, bbox):
        return True
    return _dark_image(page, bbox, images)


def _overlaps_scan(span, images):
    bbox = span.get("bbox")
    if bbox is None:
        return False
    return any(image["scan"] and _intersects(bbox, image["bbox"]) for image in images)


def _visible_body(span, width, height):
    if int(span.get("render") or 0) == 3:
        return False
    if float(span.get("size") or 0.0) < 6.5:
        return False
    if _near_white(span.get("color")):
        return False
    bbox = span.get("bbox")
    if bbox is None or _outside(bbox, width, height):
        return False
    return True


def _micro(span):
    size = float(span.get("size") or 0.0)
    letters = len(_collapsed(span.get("text")).replace(" ", ""))
    return 0.0 < size < 1.5 and letters >= 4


def _hidden_reason(page, span, drawings, images, width, height):
    bbox = span.get("bbox")
    if bbox is not None and _outside(bbox, width, height):
        return "off-page"
    if _micro(span):
        return "micro-font"
    if _near_white(span.get("color")) and not _dark_backing(page, bbox, drawings, images):
        return "near-white"
    if int(span.get("render") or 0) == 3 and not _ocr_exempt(span, images):
        return "render-mode-3"
    return None


def _ocr_exempt(span, images):
    if _injection_match(span.get("text")) is not None:
        return False
    return _overlaps_scan(span, images)


def _hidden_signal(span, reason):
    text = _collapsed(span.get("text"))[:220]
    bbox = [round(value, 3) for value in span["bbox"]] if span.get("bbox") else []
    return _make_signal(
        "hidden_pdf_text_layer",
        "invisible-or-micro-text",
        span["pageIndex"],
        text,
        f"Hidden PDF text ({reason}) on page {span['pageIndex'] + 1}.",
        {"reason": reason, "bbox": bbox},
        {"reason": reason, "source": "span", "render": int(span.get("render") or 0), "size": span.get("size"), "bbox": bbox},
    )


def _make_signal(kind, subtype, page_index, excerpt, detail, reported, computed):
    return {
        "family": "D7",
        "kind": kind,
        "subtype": subtype,
        "pageIndex": int(page_index),
        "excerpt": _collapsed(excerpt)[:220],
        "detail": detail,
        "reported": reported,
        "computed": computed,
    }


def _injection_signal(page_index, text, match, source, reported, computed):
    phrase = match.group(0)
    return _make_signal(
        "prompt_injection_directive",
        "agent-prompt-injection",
        page_index,
        _excerpt_around(text, match),
        f"Prompt-injection directive in {source}: {phrase}",
        {"source": source, "match": phrase, **reported},
        {"source": source, "match": phrase, **computed},
    )


def _page_hidden_signals(page, page_index):
    signals = []
    images = _image_records(page)
    drawings = _drawings(page)
    width, height = float(page.rect.width), float(page.rect.height)
    for span in _page_spans(page, page_index):
        reason = _hidden_reason(page, span, drawings, images, width, height)
        if reason is not None:
            signals.append(_hidden_signal(span, reason))
    return signals


def _security_topic(text):
    return bool(text and _TOPIC_RE.search(text))


def _heading_topic(spans, metadata, width, height):
    for field in _HEADING_FIELDS:
        if _security_topic(metadata.get(field)):
            return True
    for span in spans:
        if not _visible_body(span, width, height):
            continue
        if float(span.get("size") or 0.0) < 11.0 and not _security_topic(span.get("text")):
            continue
        if _security_topic(span.get("text")):
            return True
    return False


def _span_injection(span, width, height, security):
    match = _injection_match(span.get("text"))
    if match is None:
        return None
    if security and _visible_body(span, width, height):
        return None
    bbox = [round(value, 3) for value in span["bbox"]] if span.get("bbox") else []
    return _injection_signal(
        span["pageIndex"], span["text"], match, "span",
        {"bbox": bbox}, {"render": int(span.get("render") or 0), "size": span.get("size")},
    )


def _annotation_texts(page):
    found = []
    try:
        annot = page.first_annot
    except Exception:
        return found
    while annot:
        info = annot.info or {}
        for field in ("content", "subject", "title"):
            value = info.get(field)
            if isinstance(value, str) and value.strip():
                found.append((field, value))
        annot = annot.next
    return found


def _annotation_signals(page, page_index):
    signals = []
    for field, text in _annotation_texts(page):
        match = _injection_match(text)
        if match is None:
            continue
        signals.append(_injection_signal(page_index, text, match, "annotation", {"field": field}, {"field": field}))
    return signals


def _metadata_map(doc):
    meta = doc.metadata or {}
    return {field: str(meta.get(field) or "") for field in _META_FIELDS}


def _metadata_signals(metadata):
    signals = []
    for field in _META_FIELDS:
        text = metadata.get(field) or ""
        match = _injection_match(text)
        if match is None:
            continue
        signals.append(_injection_signal(0, text, match, "metadata", {"field": field}, {"field": field}))
    return signals


def _supplement_items(supplements):
    if isinstance(supplements, dict):
        return [supplements]
    if isinstance(supplements, (list, tuple)):
        return [item for item in supplements if isinstance(item, (dict, str))]
    return []


def _supplement_signals(supplements):
    signals = []
    for item in _supplement_items(supplements):
        text, page_index = _supplement_text(item)
        match = _injection_match(text)
        if match is None:
            continue
        signals.append(_injection_signal(page_index, text, match, "supplement", {"pageIndex": page_index}, {"pageIndex": page_index}))
    return signals


def _supplement_text(item):
    if isinstance(item, str):
        return item, 0
    page_index = item.get("pageIndex", 0)
    if isinstance(page_index, bool) or type(page_index) is not int or page_index < 0:
        page_index = 0
    return str(item.get("text") or ""), page_index


def _page_injection_signals(page, page_index, security):
    width, height = float(page.rect.width), float(page.rect.height)
    signals = []
    for span in _page_spans(page, page_index):
        signal = _span_injection(span, width, height, security)
        if signal is not None:
            signals.append(signal)
    signals.extend(_annotation_signals(page, page_index))
    return signals


def _document_security(doc, spans_by_page, metadata):
    for page_index, spans in spans_by_page.items():
        page = doc[page_index]
        if _heading_topic(spans, metadata, float(page.rect.width), float(page.rect.height)):
            return True
    return False


def _collect_page_signals(doc):
    hidden, injection, spans_by_page = [], [], {}
    page_count = min(doc.page_count, MAX_SECURITY_PAGES)
    for page_index in range(page_count):
        page = doc[page_index]
        spans = _page_spans(page, page_index)
        spans_by_page[page_index] = spans
        hidden.extend(_page_hidden_signals(page, page_index))
    return hidden, injection, spans_by_page, page_count


def _add_injection(doc, spans_by_page, metadata, supplements, security):
    signals = []
    for page_index in spans_by_page:
        signals.extend(_page_injection_signals(doc[page_index], page_index, security))
    signals.extend(_metadata_signals(metadata))
    signals.extend(_supplement_signals(supplements))
    return signals


def _signal_sort_key(sig):
    computed = sig.get("computed") or {}
    return (sig["pageIndex"], sig["kind"], sig["excerpt"], str(computed.get("source")), str(computed.get("reason")))


def _dedupe_key(sig):
    computed = sig.get("computed") or {}
    return (sig["kind"], sig["pageIndex"], sig["excerpt"], computed.get("source"), computed.get("reason"), computed.get("field"))


def _number_signals(signals, max_signals):
    unique, seen = [], set()
    for sig in sorted(signals, key=_signal_sort_key):
        key = _dedupe_key(sig)
        if key in seen:
            continue
        seen.add(key)
        unique.append(sig)
    truncated = len(unique) > max_signals
    numbered = [{"id": f"sec-{index + 1}", **sig} for index, sig in enumerate(unique[:max_signals])]
    return numbered, truncated


def _audit_doc(doc, supplements, max_signals):
    hidden, _ignored, spans_by_page, page_count = _collect_page_signals(doc)
    metadata = _metadata_map(doc)
    security = _document_security(doc, spans_by_page, metadata)
    injection = _add_injection(doc, spans_by_page, metadata, supplements, security)
    numbered, truncated = _number_signals(hidden + injection, max_signals)
    return numbered, truncated or doc.page_count > MAX_SECURITY_PAGES, page_count


def audit_pdf_security(paper_id_or_bytes, file_hash=None, *, supplements=None, max_signals=30, store=None):
    """Audit a PDF for hidden text layers and prompt-injection directives."""
    _require_limit(max_signals)
    _reject_red_keys(supplements)
    paper_id, actual_hash, raw = _resolve_pdf(paper_id_or_bytes, file_hash, store)
    with _open_pdf(raw) as doc:
        signals, truncated, _page_count = _audit_doc(doc, supplements, max_signals)
    result = {
        "schema": SCHEMA,
        "paperId": paper_id,
        "fileHash": actual_hash,
        "signalCount": len(signals),
        "truncated": bool(truncated),
        "signals": signals,
    }
    _reject_red_keys(result)
    return result

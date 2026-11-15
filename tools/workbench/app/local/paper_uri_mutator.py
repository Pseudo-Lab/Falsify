"""Lossless PDF /URI hyperlink inspector and mutator for RED D2-1 / D2-3 injection."""
import hashlib
import io
import re
from urllib.parse import urlsplit

import pikepdf
import pymupdf

from paper_stealth_audit import BLINDNESS_META_PATTERNS, audit_pdf_stealth

SCHEMA = 'falsify.red-uri-mutator.v1'
MAX_URI_LEN = 1024
_LINK_ID_RE = re.compile(r'^p(\d+)-a(\d+)$')
_HINT_TOKENS = (
    'intentional',
    'fabricated',
    'fake-doi',
    'red-team',
    'injected',
    'falsify-red',
    'red-plan',
    'answer-key',
    'answer_key',
    'tampered',
    '변조',
    '가짜',
    '함정',
    '정답',
)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _require_pdf_bytes(pdf_bytes: bytes) -> bytes:
    if not isinstance(pdf_bytes, (bytes, bytearray)) or not bytes(pdf_bytes).startswith(b'%PDF-'):
        raise ValueError('pdf_invalid')
    return bytes(pdf_bytes)


def _decode_pdf_uri(obj) -> str:
    if isinstance(obj, pikepdf.String):
        return bytes(obj).decode('utf-8', errors='replace')
    return str(obj)


def _has_blindness_hint(uri: str) -> bool:
    low = uri.lower()
    if any(tok in low for tok in _HINT_TOKENS):
        return True
    return any(pat.search(uri) for pat in BLINDNESS_META_PATTERNS)


def _validate_after_uri(uri) -> str:
    if not isinstance(uri, str) or not uri or len(uri) > MAX_URI_LEN:
        raise ValueError('uri_invalid')
    low = uri.lower()
    if not low.startswith(('https://', 'http://')):
        raise ValueError('uri_scheme_rejected')
    if any(ch.isspace() or ord(ch) < 0x21 for ch in uri):
        raise ValueError('uri_whitespace_or_control_rejected')
    if _has_blindness_hint(uri):
        raise ValueError('uri_blindness_hint_rejected')
    if any(ord(ch) > 0x7E for ch in uri):
        raise ValueError('uri_non_ascii_rejected')
    parsed = urlsplit(uri)
    if not parsed.netloc:
        raise ValueError('uri_host_missing')
    return uri


def _links_by_xref(py_page) -> dict[int, pymupdf.Rect]:
    out = {}
    for item in py_page.get_links() or ():
        xref = item.get('xref')
        rect = item.get('from')
        if isinstance(xref, int) and xref > 0 and rect is not None:
            out[xref] = pymupdf.Rect(rect)
    return out


def _annot_rect(py_page, annot, xref_map: dict[int, pymupdf.Rect]) -> pymupdf.Rect:
    xref = annot.objgen[0] if hasattr(annot, 'objgen') else 0
    if xref and xref in xref_map:
        return xref_map[xref]
    raw_rect = annot.get('/Rect')
    if isinstance(raw_rect, pikepdf.Array) and len(raw_rect) == 4:
        vals = [float(v) for v in raw_rect]
        rect = pymupdf.Rect(vals) * (~py_page.transformation_matrix)
        rect.normalize()
        return rect
    return pymupdf.Rect(0, 0, 0, 0)


def _uri_from_annot(annot) -> str | None:
    if not isinstance(annot, pikepdf.Dictionary):
        return None
    if annot.get('/Subtype') != pikepdf.Name('/Link'):
        return None
    action = annot.get('/A')
    if not isinstance(action, pikepdf.Dictionary):
        return None
    if action.get('/S') != pikepdf.Name('/URI') or '/URI' not in action:
        return None
    return _decode_pdf_uri(action['/URI'])


def list_pdf_uri_links(pdf_bytes: bytes) -> dict:
    """Enumerate all /Link annotations carrying /A -> /S /URI across pages."""
    raw = _require_pdf_bytes(pdf_bytes)
    links = []
    with pikepdf.Pdf.open(io.BytesIO(raw)) as pdf, pymupdf.open(stream=raw, filetype='pdf') as doc:
        for page_idx, page in enumerate(pdf.pages):
            annots = page.obj.get('/Annots')
            if not isinstance(annots, pikepdf.Array) or page_idx >= len(doc):
                continue
            py_page = doc[page_idx]
            xref_map = _links_by_xref(py_page)
            for annot_idx, annot in enumerate(annots):
                uri_str = _uri_from_annot(annot)
                if uri_str is None:
                    continue
                rect = _annot_rect(py_page, annot, xref_map)
                clip_text = ' '.join(py_page.get_text('text', clip=rect + (-2, -2, 2, 2)).split())
                links.append({
                    'linkId': f'p{page_idx}-a{annot_idx}',
                    'pageIndex': page_idx,
                    'annotIndex': annot_idx,
                    'bbox': [round(float(v), 2) for v in (rect.x0, rect.y0, rect.x1, rect.y1)],
                    'uri': uri_str,
                    'visibleText': clip_text,
                })
    return {'schema': SCHEMA, 'linkCount': len(links), 'links': links}


def _resolve_edit_target(edit: dict) -> tuple[int, int]:
    if not isinstance(edit, dict):
        raise ValueError('uri_edit_invalid')
    link_id = edit.get('linkId')
    page_idx = edit.get('pageIndex')
    annot_idx = edit.get('annotIndex')
    if link_id is not None:
        m = _LINK_ID_RE.fullmatch(str(link_id))
        if not m:
            raise ValueError('uri_link_id_invalid')
        p_id, a_id = int(m.group(1)), int(m.group(2))
        if page_idx is not None and page_idx != p_id:
            raise ValueError('uri_link_target_mismatch')
        if annot_idx is not None and annot_idx != a_id:
            raise ValueError('uri_link_target_mismatch')
        page_idx, annot_idx = p_id, a_id
    if type(page_idx) is not int or type(annot_idx) is not int or page_idx < 0 or annot_idx < 0:
        raise ValueError('uri_link_target_invalid')
    return page_idx, annot_idx


def _apply_single_uri_edit(pdf: pikepdf.Pdf, edit: dict) -> dict:
    page_idx, annot_idx = _resolve_edit_target(edit)
    if page_idx >= len(pdf.pages):
        raise ValueError('uri_page_out_of_range')
    annots = pdf.pages[page_idx].obj.get('/Annots')
    if not isinstance(annots, pikepdf.Array) or annot_idx >= len(annots):
        raise ValueError('uri_annot_out_of_range')
    annot = annots[annot_idx]
    current_uri = _uri_from_annot(annot)
    if current_uri is None:
        raise ValueError('uri_annot_not_link_uri')
    before_uri = edit.get('beforeUri')
    if before_uri is not None and current_uri != before_uri:
        raise ValueError('uri_before_mismatch')
    after_uri = _validate_after_uri(edit.get('afterUri'))
    old_action = annot.get('/A')
    new_action = pikepdf.Dictionary({k: v for k, v in old_action.items()})
    new_action[pikepdf.Name('/URI')] = pikepdf.String(after_uri)
    annot[pikepdf.Name('/A')] = new_action
    change = {
        'linkId': f'p{page_idx}-a{annot_idx}',
        'pageIndex': page_idx,
        'annotIndex': annot_idx,
        'beforeUri': current_uri,
        'afterUri': after_uri,
        'defectFamily': 'D2',
        'subtype': 'identifier-hijack',
    }
    if isinstance(edit.get('rationale'), str) and edit['rationale'].strip():
        change['rationale'] = edit['rationale'].strip()
    return change


def mutate_pdf_uri_links(pdf_bytes: bytes, edits: list[dict], *, require_clean_stealth: bool = True) -> dict:
    """Losslessly rewrite targeted /URI strings in a PDF copy and verify pixel-identical stealth."""
    raw = _require_pdf_bytes(pdf_bytes)
    if not isinstance(edits, list):
        raise ValueError('uri_edits_invalid')
    changes = []
    with pikepdf.Pdf.open(io.BytesIO(raw)) as pdf:
        for edit in edits:
            changes.append(_apply_single_uri_edit(pdf, edit))
        buf = io.BytesIO()
        pdf.save(buf)
        out_bytes = buf.getvalue()
    stealth = audit_pdf_stealth(raw, out_bytes, modified_regions=[])
    if require_clean_stealth and stealth.get('status') == 'detectable_artifact':
        raise ValueError('stealth_audit_failed')
    return {
        'schema': SCHEMA,
        'sourceSha256': _sha256(raw),
        'outputSha256': _sha256(out_bytes),
        'appliedCount': len(changes),
        'changes': changes,
        'stealthAudit': stealth,
        'pdfBytes': out_bytes,
    }

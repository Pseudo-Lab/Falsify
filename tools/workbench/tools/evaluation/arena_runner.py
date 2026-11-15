"""Headless Co-Evolution Arena evaluator and blind-bundle verifier.

Core matching/scoring uses Python stdlib plus agreement_selective.py.
PDF blind verification uses pymupdf when installed together with pure-bytes
fallback inspection across DocInfo, XMP, non-link annotations, AcroForm widgets,
and raw trailer/comment strings.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

_EVAL_DIR = Path(__file__).resolve().parent
if str(_EVAL_DIR) not in sys.path:
    sys.path.insert(0, str(_EVAL_DIR))

from agreement_selective import compute_krippendorff_alpha, compute_selective_prediction

try:
    import pymupdf  # type: ignore
except ImportError:
    pymupdf = None

BLIND_SCHEMA = 'falsify.blind-verification.v1'
ARENA_SCHEMA = 'falsify.arena-evaluation.v1'

WORLDS = ('W1', 'W2', 'W3', 'W4', 'W5')
FAMILIES = ('D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7')
DIFFICULTIES = ('L1', 'L2', 'L3', 'L4')

PDF_LEAK_TOKENS = (
    'falsify', 'falsify-red', 'red-plan', 'red_plan', 'gold_ledger', 'gold-ledger',
    'goldledger', 'candidaterationales', 'why_hard', 'why-hard', 'stealth_audit',
    'stealth-audit', 'answer-key', 'answer_key', 'tampered', 'attack', 'candidate',
    'rationale', 'before', 'after', '변조', '정답', '의도적',
)
FORBIDDEN_SUPPLEMENT_KEYS = frozenset({
    'before', 'after', 'patch', 'gold', 'why_hard', 'whyhard',
    'candidaterationales', 'defectid', 'goldledger', 'gold_ledger',
    'redplan', 'red_plan', 'plan',
})
UNAMBIGUOUS_SUPPLEMENT_TOKENS = (
    'falsify-red', 'red-plan', 'red_plan', 'gold_ledger', 'goldledger',
    'why_hard', 'candidaterationales', 'defectid', 'stealth_audit',
    'answer-key', 'answer_key',
)
SUPPLEMENT_JSON_KEY_RE = re.compile(
    r'["\'](before|after|patch|gold|why_hard|candidateRationales|defectId|goldLedger)["\']\s*:',
    re.IGNORECASE,
)

ABSTAIN_TOKENS = frozenset({
    'needs_check', 'needs-check', 'needs_verification', 'needs-verification',
    '확인필요', 'uncertain', 'abstain', 'abstained', 'deferred',
})
NON_DEFECT_TOKENS = frozenset({
    'clean', 'no_defect', 'no-defect', '맞음', 'supported', 'none',
})
STEALTH_PASS_TOKENS = frozenset({'clean', 'pass', 'passed', 'stealth_pass', 'stealthpass'})
STEALTH_FAIL_TOKENS = frozenset({'detectable_artifact', 'fail', 'failed', 'warning'})

_STREAM_RE = re.compile(rb'stream\r?\n.*?\r?\nendstream', re.DOTALL)
_COMMENT_RE = re.compile(rb'%([^\r\n]*)')
_TRAILER_RE = re.compile(rb'trailer\s*<<(.*?)>>', re.DOTALL)
_XMP_RE = re.compile(rb'(?:<x:xmpmeta\b.*?</x:xmpmeta>|<\?xpacket\b.*?\?>)', re.DOTALL | re.IGNORECASE)
_DICT_RE = re.compile(rb'<<(?:[^<>]|<[^<>]*>|<<(?:[^<>]|<[^<>]*>)*>>)*>>', re.DOTALL)
_INFO_REF_RE = re.compile(rb'/Info\s+(\d+)\s+(\d+)\s+R')
_PDF_STR_RE = re.compile(rb'/([A-Za-z0-9_.-]+)\s*\(((?:\\.|[^\\()])*)\)')
_PDF_HEX_RE = re.compile(rb'/([A-Za-z0-9_.-]+)\s*<([0-9A-Fa-f\s]+)>')
_TOKEN_RE = re.compile(r'[a-z0-9가-힣]+(?:[./-][a-z0-9가-힣]+)*')


def _round4(value: float | None) -> float | None:
    if value is None:
        return None
    rounded = round(float(value), 4)
    return 0.0 if rounded == 0.0 else rounded


def _sha256_hex(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _as_pdf_bytes(data, label: str) -> bytes:
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ValueError(f'{label}_pdf_invalid')
    raw = bytes(data)
    if not raw.startswith(b'%PDF-'):
        raise ValueError(f'{label}_pdf_invalid')
    return raw


def _decode_pdf_literal(raw: bytes) -> str:
    text = raw.decode('latin-1', errors='replace')
    out = []
    idx = 0
    escapes = {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f'}
    while idx < len(text):
        ch = text[idx]
        if ch == '\\' and idx + 1 < len(text):
            nxt = text[idx + 1]
            out.append(escapes.get(nxt, nxt))
            idx += 2
            continue
        out.append(ch)
        idx += 1
    return ''.join(out)


def _decode_pdf_hex(raw: bytes) -> str:
    cleaned = re.sub(rb'\s+', b'', raw)
    if len(cleaned) % 2:
        cleaned += b'0'
    try:
        blob = bytes.fromhex(cleaned.decode('ascii'))
    except ValueError:
        return ''
    if blob.startswith((b'\xfe\xff', b'\xff\xfe')):
        return blob.decode('utf-16', errors='replace')
    return blob.decode('utf-8', errors='replace')


def _extract_dict_strings(dict_bytes: bytes, target_keys=None) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    for match in _PDF_STR_RE.finditer(dict_bytes):
        key = match.group(1).decode('latin-1', errors='replace')
        if target_keys is None or key in target_keys:
            val = _decode_pdf_literal(match.group(2)).strip()
            if val:
                items.append((key, val))
    for match in _PDF_HEX_RE.finditer(dict_bytes):
        key = match.group(1).decode('latin-1', errors='replace')
        if target_keys is None or key in target_keys:
            val = _decode_pdf_hex(match.group(2)).strip()
            if val:
                items.append((key, val))
    return items


def _strip_pdf_streams(raw: bytes) -> bytes:
    return _STREAM_RE.sub(b' ', raw)


def _extract_info_bytes_text(non_stream: bytes) -> list[str]:
    parts: list[str] = []
    ref = _INFO_REF_RE.search(non_stream)
    if ref:
        obj_pat = re.compile(rb'\b' + ref.group(1) + rb'\s+' + ref.group(2) + rb'\s+obj\b(.*?)\bendobj\b', re.DOTALL)
        obj_match = obj_pat.search(non_stream)
        if obj_match:
            for key, val in _extract_dict_strings(obj_match.group(1)):
                parts.append(f'{key}:{val}')
    info_keys = {'Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'}
    for key, val in _extract_dict_strings(non_stream, info_keys):
        entry = f'{key}:{val}'
        if entry not in parts:
            parts.append(entry)
    return parts


def _extract_xmp_bytes_text(raw: bytes) -> list[str]:
    return [m.group(0).decode('utf-8', errors='replace') for m in _XMP_RE.finditer(raw)]


def _extract_annot_and_form_bytes(non_stream: bytes) -> tuple[list[str], list[str]]:
    annots: list[str] = []
    forms: list[str] = []
    for match in _DICT_RE.finditer(non_stream):
        blob = match.group(0)
        is_form = b'/FT' in blob or b'/AcroForm' in blob
        is_link = bool(re.search(rb'/Subtype\s*/Link\b', blob))
        has_annot_keys = any(tok in blob for tok in (b'/Contents', b'/Subj', b'/Popup'))
        if is_form:
            for key, val in _extract_dict_strings(blob, {'V', 'DV', 'TU', 'T'}):
                forms.append(f'{key}:{val}')
        elif not is_link and (has_annot_keys or b'/Subtype' in blob):
            for key, val in _extract_dict_strings(blob, {'Contents', 'Subj', 'T', 'Title', 'NM'}):
                annots.append(f'{key}:{val}')
    return annots, forms


def _extract_trailer_comments(non_stream: bytes) -> list[str]:
    items: list[str] = []
    for match in _COMMENT_RE.finditer(non_stream):
        raw_line = match.group(1)
        if raw_line.startswith((b'PDF-', b'%EOF')):
            continue
        if any(byte > 127 for byte in raw_line[:4]):
            continue
        text = raw_line.decode('utf-8', errors='replace').strip()
        if text:
            items.append(text)
    for match in _TRAILER_RE.finditer(non_stream):
        for key, val in _extract_dict_strings(match.group(1)):
            items.append(f'{key}:{val}')
    return items


def _extract_pymupdf_surfaces(raw: bytes) -> dict[str, list[str]]:
    if pymupdf is None:
        return {}
    try:
        doc = pymupdf.open(stream=raw, filetype='pdf')
    except Exception:
        return {}
    docinfo, xmp, annots, forms = [], [], [], []
    with doc:
        for key, val in (doc.metadata or {}).items():
            if val is not None and str(val).strip():
                docinfo.append(f'{key}:{val}')
        try:
            xml = doc.get_xml_metadata()
            if xml and xml.strip():
                xmp.append(xml)
        except Exception:
            pass
        for page_idx in range(len(doc)):
            page = doc[page_idx]
            _collect_page_annots(page, page_idx, annots)
            _collect_page_widgets(page, page_idx, forms)
    return {'docinfo': docinfo, 'xmp': xmp, 'annotation': annots, 'acroform': forms}


def _collect_page_annots(page, page_idx: int, out: list[str]) -> None:
    for annot in list(page.annots() or []):
        atype = annot.type[1] if isinstance(annot.type, (list, tuple)) and len(annot.type) > 1 else ''
        if atype == 'Link':
            continue
        info = annot.info or {}
        for key in ('content', 'subject', 'title', 'id'):
            val = info.get(key)
            if isinstance(val, str) and val.strip():
                out.append(f'p{page_idx}:{key}:{val.strip()}')


def _collect_page_widgets(page, page_idx: int, out: list[str]) -> None:
    for widget in list(page.widgets() or []):
        for key in ('field_name', 'field_label', 'field_value'):
            val = getattr(widget, key, None)
            if isinstance(val, str) and val.strip():
                out.append(f'p{page_idx}:{key}:{val.strip()}')


def _merge_unique(primary: list[str], secondary: list[str]) -> list[str]:
    merged = list(primary)
    seen = {item.lower() for item in primary}
    for item in secondary:
        if item.lower() not in seen:
            merged.append(item)
            seen.add(item.lower())
    return merged


def _extract_pdf_surfaces(raw: bytes) -> dict[str, list[str]]:
    non_stream = _strip_pdf_streams(raw)
    bytes_docinfo = _extract_info_bytes_text(non_stream)
    bytes_xmp = _extract_xmp_bytes_text(raw)
    bytes_annots, bytes_forms = _extract_annot_and_form_bytes(non_stream)
    trailer_comments = _extract_trailer_comments(non_stream)
    fitz_data = _extract_pymupdf_surfaces(raw)
    return {
        'docinfo': _merge_unique(fitz_data.get('docinfo', []), bytes_docinfo),
        'xmp': _merge_unique(fitz_data.get('xmp', []), bytes_xmp),
        'annotation': _merge_unique(fitz_data.get('annotation', []), bytes_annots),
        'acroform': _merge_unique(fitz_data.get('acroform', []), bytes_forms),
        'trailer_comment': trailer_comments,
    }


def _compile_token_pattern(token: str) -> re.Pattern[str]:
    if token.isascii():
        return re.compile(r'(?<![a-z0-9_])' + re.escape(token) + r'(?![a-z0-9_])', re.IGNORECASE)
    return re.compile(re.escape(token))


_PDF_LEAK_PATTERNS = tuple((tok, _compile_token_pattern(tok)) for tok in PDF_LEAK_TOKENS)


def _snippet(text: str, start: int, end: int) -> str:
    lo = max(0, start - 24)
    hi = min(len(text), end + 24)
    return ' '.join(text[lo:hi].split())[:160]


def _count_token_matches(text: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    for token, pat in _PDF_LEAK_PATTERNS:
        hits = len(pat.findall(text))
        if hits:
            counts[token] = hits
    return counts


def _scan_surface_leaks(surface: str, blind_text: str, src_text: str) -> list[dict]:
    if not blind_text:
        return []
    src_counts = _count_token_matches(src_text)
    leaks: list[dict] = []
    for token, pat in _PDF_LEAK_PATTERNS:
        remaining_exempt = src_counts.get(token, 0)
        for match in pat.finditer(blind_text):
            if remaining_exempt > 0:
                remaining_exempt -= 1
                continue
            leaks.append({
                'surface': surface,
                'token': token,
                'snippet': _snippet(blind_text, match.start(), match.end()),
            })
    return leaks


def _scan_json_red_keys(value, name: str, leaks: list[dict], depth: int = 0) -> None:
    if depth > 16:
        return
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in FORBIDDEN_SUPPLEMENT_KEYS:
                leaks.append({
                    'surface': 'supplement',
                    'supplementName': name,
                    'token': str(key),
                    'snippet': f'JSON key "{key}"',
                })
            _scan_json_red_keys(child, name, leaks, depth + 1)
    elif isinstance(value, list):
        for item in value:
            _scan_json_red_keys(item, name, leaks, depth + 1)


def _supplement_text_and_name(entry, idx: int) -> tuple[str, str]:
    if not isinstance(entry, dict):
        raise ValueError('supplement_invalid')
    name = str(entry.get('name') or f'supplement-{idx + 1}')
    if isinstance(entry.get('text'), str):
        return name, entry['text']
    if isinstance(entry.get('bytes'), (bytes, bytearray, memoryview)):
        return name, bytes(entry['bytes']).decode('utf-8', errors='replace')
    if isinstance(entry.get('content'), str):
        return name, entry['content']
    raise ValueError('supplement_invalid')


def _scan_csv_header_keys(name: str, text: str, leaks: list[dict]) -> None:
    if not name.lower().endswith(('.csv', '.tsv')):
        return
    first_line = text.splitlines()[0] if text.splitlines() else ''
    sep = '\t' if name.lower().endswith('.tsv') else ','
    for col in first_line.split(sep):
        cleaned = col.strip().strip('"\'').lower()
        if cleaned in FORBIDDEN_SUPPLEMENT_KEYS:
            leaks.append({
                'surface': 'supplement',
                'supplementName': name,
                'token': cleaned,
                'snippet': f'header:{first_line[:120]}',
            })


def _scan_single_supplement(name: str, text: str) -> list[dict]:
    leaks: list[dict] = []
    stripped = text.lstrip()
    if stripped.startswith(('{', '[')):
        try:
            parsed = json.loads(stripped)
            _scan_json_red_keys(parsed, name, leaks)
            if leaks:
                return leaks
        except json.JSONDecodeError:
            pass
    _scan_csv_header_keys(name, text, leaks)
    for match in SUPPLEMENT_JSON_KEY_RE.finditer(text):
        leaks.append({
            'surface': 'supplement',
            'supplementName': name,
            'token': match.group(1),
            'snippet': _snippet(text, match.start(), match.end()),
        })
    for tok in UNAMBIGUOUS_SUPPLEMENT_TOKENS:
        pat = _compile_token_pattern(tok)
        for match in pat.finditer(text):
            leaks.append({
                'surface': 'supplement',
                'supplementName': name,
                'token': tok,
                'snippet': _snippet(text, match.start(), match.end()),
            })
    return leaks


def verify_blind_bundle(
    blind_pdf_bytes: bytes,
    blind_supplements: list[dict] | None = None,
    source_pdf_bytes: bytes | None = None,
) -> dict:
    """Verify that a blind PDF and supplements contain no RED metadata or answer-key leaks."""
    blind_raw = _as_pdf_bytes(blind_pdf_bytes, 'blind')
    src_raw = _as_pdf_bytes(source_pdf_bytes, 'source') if source_pdf_bytes is not None else None
    blind_surfaces = _extract_pdf_surfaces(blind_raw)
    src_surfaces = _extract_pdf_surfaces(src_raw) if src_raw is not None else {}

    src_meta_union = '\n'.join(src_surfaces.get('docinfo', []) + src_surfaces.get('xmp', []))
    leaks: list[dict] = []
    for surface, items in blind_surfaces.items():
        blind_text = '\n'.join(items)
        if surface in ('docinfo', 'xmp') and src_raw is not None:
            src_text = src_meta_union
        else:
            src_text = '\n'.join(src_surfaces.get(surface, []))
        leaks.extend(_scan_surface_leaks(surface, blind_text, src_text))

    supplements = list(blind_supplements or [])
    for idx, entry in enumerate(supplements):
        name, text = _supplement_text_and_name(entry, idx)
        leaks.extend(_scan_single_supplement(name, text))

    return {
        'schema': BLIND_SCHEMA,
        'blindClean': not leaks,
        'pdfSha256': _sha256_hex(blind_raw),
        'supplementCount': len(supplements),
        'leakCount': len(leaks),
        'leaks': leaks,
    }


def _norm_space(text: str | None) -> str:
    return ' '.join(str(text or '').split()).strip()


def _normalize_bbox(raw) -> tuple[float, float, float, float] | None:
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        vals = tuple(float(v) for v in raw)
    except (TypeError, ValueError):
        return None
    if vals[2] <= vals[0] or vals[3] <= vals[1]:
        return None
    return vals


def _bbox_iou(a: tuple[float, float, float, float] | None, b: tuple[float, float, float, float] | None) -> float:
    if a is None or b is None:
        return 0.0
    inter_w = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    inter_h = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = inter_w * inter_h
    if inter <= 0.0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    union = area_a + area_b - inter
    return (inter / union) if union > 0.0 else 0.0


def _tokenize(text: str) -> set[str]:
    tokens = set(_TOKEN_RE.findall(text.lower()))
    slash_parts = {part for tok in tokens if '/' in tok for part in tok.split('/') if len(part) >= 3}
    sub = {part for tok in tokens for part in re.findall(r'[a-z0-9가-힣]{3,}', tok)}
    return tokens | slash_parts | sub


def _text_similarity(text_a: str, text_b: str) -> float:
    na = _norm_space(text_a).lower()
    nb = _norm_space(text_b).lower()
    if not na or not nb:
        return 0.0
    shorter, longer = (na, nb) if len(na) <= len(nb) else (nb, na)
    sub_score = 0.0
    if len(shorter) >= 6 and shorter in longer:
        sub_score = 0.65 + 0.35 * (len(shorter) / len(longer))
    ta, tb = _tokenize(na), _tokenize(nb)
    shared = ta & tb
    jaccard = (len(shared) / len(ta | tb)) if (ta and tb) else 0.0
    id_hit = 0.65 if any(len(t) >= 8 and any(c in t for c in './-') for t in shared) else 0.0
    return max(sub_score, jaccard, id_hit)


def _best_text_similarity(texts_a: list[str], texts_b: list[str]) -> float:
    best = 0.0
    for a in texts_a:
        if not a:
            continue
        for b in texts_b:
            if not b:
                continue
            best = max(best, _text_similarity(a, b))
    return best


def _resolve_stealth_pass(raw: dict) -> bool | None:
    if isinstance(raw.get('stealthPass'), bool):
        return raw['stealthPass']
    status = str(raw.get('stealthStatus') or '').strip().lower()
    if status in STEALTH_PASS_TOKENS:
        return True
    if status in STEALTH_FAIL_TOKENS:
        return False
    return None


def _normalize_gold_item(raw: dict, idx: int) -> dict:
    defect_id = str(raw.get('defectId') or raw.get('id') or f'gold-{idx + 1}')
    page_idx = raw.get('pageIndex')
    page_idx = page_idx if type(page_idx) is int and page_idx >= 0 else None
    texts = [
        _norm_space(raw.get(k))
        for k in ('after', 'quote', 'excerpt', 'afterUri', 'location', 'label')
        if _norm_space(raw.get(k))
    ]
    return {
        'defectId': defect_id,
        'world': str(raw.get('world') or '').strip().upper(),
        'family': str(raw.get('family') or raw.get('defectType') or raw.get('defect_type') or '').strip().upper(),
        'difficulty': str(raw.get('difficulty') or '').strip().upper(),
        'pageIndex': page_idx,
        'bbox': _normalize_bbox(raw.get('bbox')),
        'itemId': _norm_space(raw.get('itemId')) or None,
        'supplementName': _norm_space(raw.get('supplementName')) or None,
        'before': _norm_space(raw.get('before')),
        'after': _norm_space(raw.get('after')),
        'texts': texts,
        'stealthPass': _resolve_stealth_pass(raw),
    }


def _normalize_gold_ledger(gold_ledger) -> list[dict]:
    if isinstance(gold_ledger, list):
        items = gold_ledger
    elif isinstance(gold_ledger, dict):
        for key in ('defects', 'changes', 'entries', 'operations'):
            if isinstance(gold_ledger.get(key), list):
                items = gold_ledger[key]
                break
        else:
            raise ValueError('gold_ledger_invalid')
    else:
        raise ValueError('gold_ledger_invalid')
    return [_normalize_gold_item(d, i) for i, d in enumerate(items) if isinstance(d, dict)]


def _finding_status_kind(raw: dict) -> str:
    tokens = [
        str(raw.get(k) or '').strip().lower()
        for k in ('decision', 'verdict', 'severity', 'label', 'status')
        if raw.get(k) is not None
    ]
    if any(tok in ABSTAIN_TOKENS for tok in tokens) or raw.get('abstained') is True or raw.get('deferred') is True:
        return 'abstain'
    if raw.get('uncertainty') == 'high' and not any(tok in ('defect', '아님', 'unsupported') for tok in tokens):
        return 'abstain'
    if any(tok in NON_DEFECT_TOKENS for tok in tokens):
        return 'clean'
    return 'defect'


def _extract_finding_texts(raw: dict) -> list[str]:
    texts = [_norm_space(raw.get(k)) for k in ('quote', 'excerpt', 'detail') if _norm_space(raw.get(k))]
    if isinstance(raw.get('evidence'), list):
        for ev in raw['evidence']:
            if isinstance(ev, dict) and _norm_space(ev.get('quote')):
                texts.append(_norm_space(ev.get('quote')))
    if not texts and _norm_space(raw.get('rationale')):
        texts.append(_norm_space(raw.get('rationale')))
    return texts


def _extract_run_findings_raw(run: dict) -> list:
    if isinstance(run.get('findings'), list):
        return run['findings']
    if isinstance(run.get('response'), dict) and isinstance(run['response'].get('findings'), list):
        return run['response']['findings']
    if isinstance(run.get('signals'), list):
        return run['signals']
    if isinstance(run.get('sensor'), dict):
        items = list(run['sensor'].get('signals') or [])
        if isinstance(run.get('supplementAudit'), dict):
            items.extend(run['supplementAudit'].get('signals') or [])
        return items
    return []


def _normalize_finding(raw: dict, idx: int) -> dict:
    page_idx = raw.get('pageIndex')
    page_idx = page_idx if type(page_idx) is int and page_idx >= 0 else None
    conf = raw.get('confidence')
    confidence = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else None
    texts = _extract_finding_texts(raw)
    return {
        'findingId': str(raw.get('id') or raw.get('findingId') or f'finding-{idx + 1}'),
        'kind': _finding_status_kind(raw),
        'confidence': confidence,
        'pageIndex': page_idx,
        'bbox': _normalize_bbox(raw.get('bbox')),
        'itemId': _norm_space(raw.get('itemId')) or None,
        'supplementName': _norm_space(raw.get('supplementName')) or None,
        'quote': texts[0] if texts else '',
        'texts': texts,
        'family': str(raw.get('family') or '').strip().upper() or None,
    }


def _normalize_blue_runs(blue_runs) -> list[dict]:
    raw_list = [blue_runs] if isinstance(blue_runs, dict) else list(blue_runs or [])
    if not raw_list:
        raise ValueError('blue_runs_empty')
    normalized = []
    for idx, run in enumerate(raw_list):
        if not isinstance(run, dict):
            raise ValueError('blue_run_invalid')
        findings_raw = _extract_run_findings_raw(run)
        findings = [_normalize_finding(f, i) for i, f in enumerate(findings_raw) if isinstance(f, dict)]
        run_id = str(run.get('runId') or run.get('id') or f'run-{idx + 1}')
        agent_id = str(run.get('agentId') or run.get('model') or run_id)
        normalized.append({'runId': run_id, 'agentId': agent_id, 'findings': findings})
    return normalized


def _extract_baseline_items(baseline_signals) -> list:
    if baseline_signals is None:
        return []
    if isinstance(baseline_signals, list):
        return baseline_signals
    if not isinstance(baseline_signals, dict):
        raise ValueError('baseline_signals_invalid')
    for key in ('signals', 'findings'):
        if isinstance(baseline_signals.get(key), list):
            return baseline_signals[key]
    sensor = baseline_signals.get('sensor')
    return list(sensor.get('signals') or []) if isinstance(sensor, dict) else []


def _normalize_baseline_signals(baseline_signals) -> list[dict]:
    items = _extract_baseline_items(baseline_signals)
    out = []
    for idx, sig in enumerate(items):
        if not isinstance(sig, dict):
            continue
        page_idx = sig.get('pageIndex')
        page_idx = page_idx if type(page_idx) is int and page_idx >= 0 else None
        texts = [_norm_space(sig.get(k)) for k in ('excerpt', 'quote', 'detail') if _norm_space(sig.get(k))]
        out.append({
            'signalId': str(sig.get('id') or f'base-{idx + 1}'),
            'pageIndex': page_idx,
            'bbox': _normalize_bbox(sig.get('bbox')),
            'itemId': _norm_space(sig.get('itemId')) or None,
            'supplementName': _norm_space(sig.get('supplementName')) or None,
            'texts': texts,
        })
    return out


def _pages_compatible(page_a: int | None, page_b: int | None) -> bool:
    return page_a is None or page_b is None or page_a == page_b


def _norm_sup_name(name: str | None) -> str:
    return Path(name).name.lower() if name else ''


def _match_score(target: dict, finding: dict) -> float:
    text_sim = _best_text_similarity(target['texts'], finding['texts'])
    if target['itemId'] and finding['itemId'] and target['itemId'].lower() == finding['itemId'].lower():
        if _pages_compatible(target['pageIndex'], finding['pageIndex']):
            return 0.90 + 0.10 * text_sim
    if target['supplementName'] and finding['supplementName']:
        if _norm_sup_name(target['supplementName']) == _norm_sup_name(finding['supplementName']):
            return 0.85 + 0.15 * text_sim
    if target['pageIndex'] is not None and finding['pageIndex'] is not None and target['pageIndex'] == finding['pageIndex']:
        iou = _bbox_iou(target['bbox'], finding['bbox'])
        if iou >= 0.25:
            return 0.60 + 0.35 * iou + 0.05 * text_sim
    if _pages_compatible(target['pageIndex'], finding['pageIndex']) and text_sim >= 0.35:
        return 0.45 + 0.45 * text_sim
    return 0.0


def _greedy_bipartite_match(gold: list[dict], findings: list[dict]) -> tuple[list[tuple[int, int, float]], set[int], set[int]]:
    candidates: list[tuple[float, int, int]] = []
    for g_idx, g_item in enumerate(gold):
        for f_idx, f_item in enumerate(findings):
            score = _match_score(g_item, f_item)
            if score > 0.0:
                candidates.append((score, g_idx, f_idx))
    candidates.sort(key=lambda item: (-item[0], item[1], item[2]))
    matched_g: set[int] = set()
    matched_f: set[int] = set()
    pairs: list[tuple[int, int, float]] = []
    for score, g_idx, f_idx in candidates:
        if g_idx in matched_g or f_idx in matched_f:
            continue
        matched_g.add(g_idx)
        matched_f.add(f_idx)
        pairs.append((g_idx, f_idx, _round4(score)))
    return pairs, matched_g, matched_f


def _matches_any_target(targets: list[dict], finding: dict) -> bool:
    return any(_match_score(target, finding) > 0.0 for target in targets)


def _init_axis_buckets(keys: tuple[str, ...]) -> dict[str, dict]:
    return {k: {'total': 0, 'detected': 0, 'missed': 0, 'uncertain': 0, 'recall': None} for k in keys}


def _update_axis_bucket(buckets: dict[str, dict], key: str, state: str) -> None:
    if not key:
        return
    if key not in buckets:
        buckets[key] = {'total': 0, 'detected': 0, 'missed': 0, 'uncertain': 0, 'recall': None}
    bucket = buckets[key]
    bucket['total'] += 1
    bucket[state] += 1


def _finalize_axis_buckets(buckets: dict[str, dict]) -> dict[str, dict]:
    for bucket in buckets.values():
        bucket['recall'] = _round4(bucket['detected'] / bucket['total']) if bucket['total'] else None
    return buckets


def _format_selective(raw: dict) -> dict:
    return {
        'status': raw.get('status'),
        'totalEvaluated': raw.get('total_evaluated', 0),
        'committedCount': raw.get('committed_count', 0),
        'abstainedCount': raw.get('abstained_count', 0),
        'abstentionRate': raw.get('abstention_rate'),
        'coverageAtCommitted': raw.get('coverage_at_committed'),
        'selectiveAccuracy': raw.get('selective_accuracy'),
        'selectiveRisk': raw.get('selective_risk'),
        'fullCoverageAccuracy': raw.get('full_coverage_accuracy'),
        'fullCoverageRisk': raw.get('full_coverage_risk'),
        'abstentionGain': raw.get('abstention_gain'),
        'aurc': raw.get('aurc'),
        'riskCoverageCurve': raw.get('risk_coverage_curve', []),
    }


def _evaluate_single_run(gold: list[dict], run: dict, baseline: list[dict]) -> tuple[dict, list[str], list[dict]]:
    active = [f for f in run['findings'] if f['kind'] == 'defect']
    abstained = [f for f in run['findings'] if f['kind'] == 'abstain']

    pairs, matched_g, matched_f = _greedy_bipartite_match(gold, active)
    unmatched_gold_indices = [i for i in range(len(gold)) if i not in matched_g]
    unmatched_gold = [gold[i] for i in unmatched_gold_indices]

    abstain_pairs, matched_abstain_g, _ = _greedy_bipartite_match(unmatched_gold, abstained)
    uncertain_g = {unmatched_gold_indices[u_idx] for u_idx in matched_abstain_g}

    defect_states, by_world, by_family, by_diff = _tally_gold_axes(gold, matched_g, uncertain_g)
    pure_fps, exempted, sel_items = _classify_unmatched_findings(
        run['runId'], active, matched_f, abstained, gold, baseline, pairs,
    )
    tp, fn, pure_fp_cnt = len(pairs), len(gold) - len(pairs), len(pure_fps)
    prec = _round4(tp / (tp + pure_fp_cnt)) if (tp + pure_fp_cnt) > 0 else None
    rec = _round4(tp / (tp + fn)) if (tp + fn) > 0 else None
    f1 = _compute_f1(prec, rec)
    stealth_total, stealth_evaded, stealth_yield = _compute_stealth_yield(gold, matched_g)

    run_summary = {
        'runId': run['runId'],
        'agentId': run['agentId'],
        'tp': tp,
        'fn': fn,
        'pureFp': pure_fp_cnt,
        'preExistingExempted': len(exempted),
        'abstainedCount': len(abstained),
        'recall': rec,
        'precision': prec,
        'f1': f1,
        'stealthTotal': stealth_total,
        'stealthEvaded': stealth_evaded,
        'stealthYield': stealth_yield,
        'byWorld': by_world,
        'byFamily': by_family,
        'byDifficulty': by_diff,
        'selectivePrediction': _format_selective(compute_selective_prediction(sel_items)),
        'matchedPairs': [
            {'defectId': gold[g_i]['defectId'], 'findingId': active[f_i]['findingId'], 'score': sc}
            for g_i, f_i, sc in pairs
        ],
        'missedDefectIds': [gold[i]['defectId'] for i in range(len(gold)) if i not in matched_g],
        'pureFalsePositives': pure_fps,
        'exemptedFindingIds': [f['findingId'] for f in exempted],
        'uncertainMatchedDefectIds': [gold[i]['defectId'] for i in sorted(uncertain_g)],
        'abstainMatchedPairs': [
            {'defectId': unmatched_gold[g_i]['defectId'], 'findingId': abstained[f_i]['findingId'], 'score': sc}
            for g_i, f_i, sc in abstain_pairs
        ],
    }
    return run_summary, defect_states, sel_items


def _tally_gold_axes(gold: list[dict], matched_g: set[int], uncertain_g: set[int]):
    by_world = _init_axis_buckets(WORLDS)
    by_family = _init_axis_buckets(FAMILIES)
    by_diff = _init_axis_buckets(DIFFICULTIES)
    states: list[str] = []
    for idx, g_item in enumerate(gold):
        state = 'detected' if idx in matched_g else ('uncertain' if idx in uncertain_g else 'missed')
        states.append(state)
        _update_axis_bucket(by_world, g_item['world'], state)
        _update_axis_bucket(by_family, g_item['family'], state)
        _update_axis_bucket(by_diff, g_item['difficulty'], state)
    return states, _finalize_axis_buckets(by_world), _finalize_axis_buckets(by_family), _finalize_axis_buckets(by_diff)


def _classify_unmatched_findings(
    run_id: str,
    active: list[dict],
    matched_f: set[int],
    abstained: list[dict],
    gold: list[dict],
    baseline: list[dict],
    pairs: list[tuple[int, int, float]],
) -> tuple[list[dict], list[dict], list[dict]]:
    pure_fps: list[dict] = []
    exempted: list[dict] = []
    sel_items: list[dict] = [{'tier': 1, 'isCorrect': True} for _ in pairs]
    for f_idx, f_item in enumerate(active):
        if f_idx in matched_f:
            continue
        if _matches_any_target(baseline, f_item):
            exempted.append(f_item)
        else:
            pure_fps.append({
                'runId': run_id,
                'findingId': f_item['findingId'],
                'pageIndex': f_item['pageIndex'],
                'quote': f_item['quote'],
            })
            sel_items.append({'tier': 1, 'isCorrect': False})
    for a_item in abstained:
        if not _matches_any_target(gold, a_item) and _matches_any_target(baseline, a_item):
            continue
        sel_items.append({'tier': 2, 'isCorrect': _matches_any_target(gold, a_item)})
    return pure_fps, exempted, sel_items


def _compute_f1(precision: float | None, recall: float | None) -> float | None:
    if precision is None or recall is None:
        return None
    if precision + recall == 0.0:
        return 0.0
    return _round4(2.0 * precision * recall / (precision + recall))


def _compute_stealth_yield(gold: list[dict], matched_g: set[int]) -> tuple[int, int, float | None]:
    stealth_indices = [i for i, item in enumerate(gold) if item['stealthPass'] is True]
    if not stealth_indices:
        return 0, 0, None
    evaded = sum(1 for i in stealth_indices if i not in matched_g)
    return len(stealth_indices), evaded, _round4(evaded / len(stealth_indices))


def _pool_axis(run_summaries: list[dict], axis_key: str, base_keys: tuple[str, ...]) -> dict[str, dict]:
    pooled = _init_axis_buckets(base_keys)
    for run in run_summaries:
        for key, bucket in run[axis_key].items():
            if key not in pooled:
                pooled[key] = {'total': 0, 'detected': 0, 'missed': 0, 'uncertain': 0, 'recall': None}
            for field in ('total', 'detected', 'missed', 'uncertain'):
                pooled[key][field] += bucket[field]
    return _finalize_axis_buckets(pooled)


def _build_aggregate_metrics(gold: list[dict], run_summaries: list[dict], state_matrix: list[list[str]]) -> dict:
    total_tp = sum(r['tp'] for r in run_summaries)
    total_fn = sum(r['fn'] for r in run_summaries)
    total_fp = sum(r['pureFp'] for r in run_summaries)
    total_ex = sum(r['preExistingExempted'] for r in run_summaries)
    total_ab = sum(r['abstainedCount'] for r in run_summaries)
    recall = _round4(total_tp / (total_tp + total_fn)) if (total_tp + total_fn) else None
    precision = _round4(total_tp / (total_tp + total_fp)) if (total_tp + total_fp) else None
    union_detected = sum(1 for col in range(len(gold)) if any(row[col] == 'detected' for row in state_matrix))
    union_recall = _round4(union_detected / len(gold)) if gold else None
    stealth_tot = sum(r['stealthTotal'] for r in run_summaries)
    stealth_ev = sum(r['stealthEvaded'] for r in run_summaries)
    return {
        'tp': total_tp,
        'fn': total_fn,
        'pureFp': total_fp,
        'preExistingExempted': total_ex,
        'abstainedCount': total_ab,
        'recall': recall,
        'precision': precision,
        'f1': _compute_f1(precision, recall),
        'unionDetected': union_detected,
        'unionRecall': union_recall,
        'stealthYield': _round4(stealth_ev / stealth_tot) if stealth_tot else None,
        'byWorld': _pool_axis(run_summaries, 'byWorld', WORLDS),
        'byFamily': _pool_axis(run_summaries, 'byFamily', FAMILIES),
        'byDifficulty': _pool_axis(run_summaries, 'byDifficulty', DIFFICULTIES),
    }


def _build_agreement_block(gold: list[dict], state_matrix: list[list[str]]) -> dict:
    units = [
        {'unitId': g_item['defectId'], 'ratings': [row[idx] for row in state_matrix]}
        for idx, g_item in enumerate(gold)
    ]
    nominal = compute_krippendorff_alpha(units, level='nominal')
    ordinal = compute_krippendorff_alpha(
        units, level='ordinal', categories=['missed', 'uncertain', 'detected'],
    )
    return {
        'nominalAlpha': nominal['alpha'],
        'ordinalAlpha': ordinal['alpha'],
        'nominal': nominal,
        'ordinal': ordinal,
        'units': units,
    }


def _build_feedback_digest(gold: list[dict], state_matrix: list[list[str]], run_summaries: list[dict]) -> dict:
    evaded_ids: list[str] = []
    trivially_caught_ids: list[str] = []
    for idx, g_item in enumerate(gold):
        col = [row[idx] for row in state_matrix]
        if col and all(state != 'detected' for state in col):
            evaded_ids.append(g_item['defectId'])
        elif col and all(state == 'detected' for state in col):
            trivially_caught_ids.append(g_item['defectId'])
    pure_fps = [fp for run in run_summaries for fp in run['pureFalsePositives']]
    return {
        'evadedGoldDefectIds': evaded_ids,
        'pureFalsePositives': pure_fps,
        'triviallyCaughtDefectIds': trivially_caught_ids,
    }


def evaluate_arena_match(
    gold_ledger,
    blue_runs,
    baseline_signals=None,
) -> dict:
    """Evaluate 1+ blind BLUE runs against a gold RED defect ledger with Baseline Guard."""
    gold = _normalize_gold_ledger(gold_ledger)
    runs = _normalize_blue_runs(blue_runs)
    baseline = _normalize_baseline_signals(baseline_signals)

    run_summaries: list[dict] = []
    state_matrix: list[list[str]] = []
    pooled_selective_items: list[dict] = []
    for run in runs:
        summary, states, sel_items = _evaluate_single_run(gold, run, baseline)
        run_summaries.append(summary)
        state_matrix.append(states)
        pooled_selective_items.extend(sel_items)

    return {
        'schema': ARENA_SCHEMA,
        'goldCount': len(gold),
        'runCount': len(runs),
        'baselineSignalCount': len(baseline),
        'runs': run_summaries,
        'aggregate': _build_aggregate_metrics(gold, run_summaries, state_matrix),
        'agreement': _build_agreement_block(gold, state_matrix),
        'selectivePrediction': _format_selective(compute_selective_prediction(pooled_selective_items)),
        'feedbackDigest': _build_feedback_digest(gold, state_matrix, run_summaries),
    }


def _build_cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Headless falsify RED/BLUE arena runner & blind verifier.')
    sub = parser.add_subparsers(dest='command', required=True)

    vb = sub.add_parser('verify-blind', help='Verify a blind PDF and supplements for RED leaks.')
    vb.add_argument('--pdf', required=True, type=Path, help='Path to blind PDF')
    vb.add_argument('--source-pdf', type=Path, help='Optional source PDF for inherited metadata exemption')
    vb.add_argument('--supplement', action='extend', nargs='+', type=Path, default=[], help='Supplement file paths')
    vb.add_argument('--out', type=Path, help='Optional output JSON path')

    ev = sub.add_parser('evaluate', help='Evaluate BLUE run JSON files against a gold RED ledger.')
    ev.add_argument('--gold', required=True, type=Path, help='Gold ledger JSON file')
    ev.add_argument('--blue', required=True, action='extend', nargs='+', type=Path, help='1+ BLUE run JSON files')
    ev.add_argument('--baseline', type=Path, help='Optional Baseline Guard sensor JSON file')
    ev.add_argument('--out', type=Path, help='Optional output JSON path')
    return parser


def _write_json_output(payload: dict, out_path: Path | None) -> None:
    rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    if out_path is not None:
        out_path.write_text(rendered + '\n', encoding='utf-8')
    print(rendered)


def _run_verify_blind_cli(args: argparse.Namespace) -> int:
    supplements = [
        {'name': path.name, 'bytes': path.read_bytes()}
        for path in args.supplement
    ]
    source_bytes = args.source_pdf.read_bytes() if args.source_pdf else None
    report = verify_blind_bundle(
        args.pdf.read_bytes(),
        blind_supplements=supplements,
        source_pdf_bytes=source_bytes,
    )
    _write_json_output(report, args.out)
    return 0 if report['blindClean'] else 3


def _run_evaluate_cli(args: argparse.Namespace) -> int:
    gold = json.loads(args.gold.read_text(encoding='utf-8'))
    blue = [json.loads(path.read_text(encoding='utf-8')) for path in args.blue]
    baseline = json.loads(args.baseline.read_text(encoding='utf-8')) if args.baseline else None
    report = evaluate_arena_match(gold, blue, baseline_signals=baseline)
    _write_json_output(report, args.out)
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for verify-blind and evaluate subcommands."""
    parser = _build_cli_parser()
    args = parser.parse_args(argv)
    if args.command == 'verify-blind':
        return _run_verify_blind_cli(args)
    if args.command == 'evaluate':
        return _run_evaluate_cli(args)
    return 2


if __name__ == '__main__':
    raise SystemExit(main())

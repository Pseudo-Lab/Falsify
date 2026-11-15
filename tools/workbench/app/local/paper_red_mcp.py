"""Unified coordinated RED MCP server for one selected PDF.

Usage:
    python app/local/paper_red_mcp.py --pdf PATH

Reuses EvidenceStore, ChartEditService, export_visual, and audit_pdf_stealth.
Never modifies the startup PDF on disk; keeps paper_mcp.py and paper_chart_edit_mcp.py separate.

Self-healing error contract
---------------------------
Every failed mutation returns one payload shape, whichever surface failed:

    {"error": "<fixed_code>", "actualValue": <rejected value or null>,
     "nearestCandidates": [ {...}, ... ], "bbox": [x0,y0,x1,y1] | null,
     "recoveryHint": "<actionable one sentence>"}

`text-span` and `supplement-edit` failures raise SpanMutationError, which already
carries these details. Native/child failures surface only a fixed code, so the
parent enriches them here: `visual_*`/table-cell failures list nearby table cells
(row, column, text, bbox), `chart_*` failures list series/point centers from the
prepared scene (or name prepare_chart_scene), `uri_*` failures list the bound
PDF links, and taxonomy/normalizer failures enumerate the valid world, difficulty,
family and kind vocabulary in the hint. Candidates never carry absolute paths,
working directories or the bound source bytes.
"""
import argparse
import base64
import copy
import hashlib
import json
import logging
import re
import sys

import pymupdf
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations

from paper_blue_sensor import run_blue_sensor
from paper_chart_edit_service import ChartEditService, SCHEMA as CHART_SCHEMA, default_service
from paper_evidence_text import _extract_raw_blocks, _order_blocks
from paper_mcp import _cancellable_thread, _guard, _ok, open_selected
from paper_red_errors import (
    RedMutationError,
    build_error_payload,
    code_of,
    error_surface,
    is_fixed_code,
    normalize_payload,
    taxonomy_hint,
    VALID_DIFFICULTIES,
    VALID_FAMILIES,
    VALID_KINDS,
    VALID_WORLDS,
)
from paper_stealth_audit import audit_pdf_stealth
from paper_text_span_mutator import (
    SpanMutationError,
    assert_blind_supplements,
    list_pdf_text_spans,
    load_red_supplements,
    mutate_pdf_text_spans,
    mutate_supplements,
    normalize_supplements,
)
from paper_uri_mutator import list_pdf_uri_links, mutate_pdf_uri_links
from paper_visual_edit import SCHEMA as VISUAL_SCHEMA, export_visual

SERVER_NAME = 'Falsify Coordinated RED Editor'
MAX_CANDIDATE_PDF_BYTES = 50 * 1024 * 1024
GOLD_LEDGER_SCHEMA = 'falsify.red-gold-ledger.v1'
_VALID_WORLDS = frozenset({'W1', 'W2', 'W3', 'W4', 'W5'})
_VALID_DIFFICULTIES = frozenset({'L1', 'L2', 'L3', 'L4'})
_VALID_FAMILY_RE = re.compile(r'^(?:D[1-7](?:-\d+)?|S\d+)$')
_READONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
_EDITING = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _collect_all_items(store, paper_id, page_index=None):
    items, offset = [], 0
    for _ in range(500):
        page = store.list_items(paper_id, page_index=page_index, offset=offset, limit=50)
        batch = page.get('items', [])
        items.extend(batch)
        nxt = page.get('nextOffset')
        if nxt is None or not batch:
            break
        offset = nxt
    return items


def _extract_paragraphs(raw, page_count, page_index=None):
    indices = [page_index] if page_index is not None else list(range(page_count))
    paragraphs = []
    with pymupdf.open(stream=raw, filetype='pdf') as doc:
        for idx in indices:
            if idx >= len(doc):
                raise ValueError('paper_evidence_page_invalid')
            blocks, width, _ = _extract_raw_blocks(doc[idx])
            ordered = _order_blocks(blocks, width)
            for b_idx, blk in enumerate(ordered):
                paragraphs.append({
                    'pageIndex': idx,
                    'blockIndex': b_idx,
                    'bbox': blk['bbox'],
                    'text': blk['text'],
                })
    return paragraphs


def _list_targets(store, paper_id, file_hash, page_index=None):
    summary = store.status(paper_id)
    page_count = summary['pageCount']
    if page_index is not None and (type(page_index) is not int or not 0 <= page_index < page_count):
        raise ValueError('paper_evidence_page_invalid')
    raw = store.source_bytes(paper_id, file_hash)
    paragraphs = _extract_paragraphs(raw, page_count, page_index=page_index)
    metas = _collect_all_items(store, paper_id, page_index=page_index)
    tables, figures = [], []
    for meta in metas:
        if meta.get('type') == 'table':
            full = store.read_item(paper_id, meta['id'])
            tbl = full.get('table') or {}
            tables.append({
                'itemId': meta['id'],
                'pageIndex': meta['pageIndex'],
                'bbox': meta.get('bbox'),
                'rows': tbl.get('rows'),
                'columns': tbl.get('columns'),
                'caption': meta.get('caption'),
                'cells': tbl.get('cells', []),
            })
        elif meta.get('type') == 'figure' and meta.get('classification', 'scientific') != 'decorative':
            figures.append({
                'itemId': meta['id'],
                'pageIndex': meta['pageIndex'],
                'bbox': meta.get('bbox'),
                'caption': meta.get('caption'),
            })
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'pageCount': page_count,
        'paragraphs': paragraphs,
        'tables': tables,
        'figures': figures,
    }


def _list_links(store, paper_id, file_hash, page_index=None):
    page_count = store.status(paper_id)['pageCount']
    if page_index is not None and (type(page_index) is not int or not 0 <= page_index < page_count):
        raise ValueError('paper_evidence_page_invalid')
    res = list_pdf_uri_links(store.source_bytes(paper_id, file_hash))
    links = [lnk for lnk in res['links'] if page_index is None or lnk['pageIndex'] == page_index]
    return {**res, 'paperId': paper_id, 'fileHash': file_hash, 'linkCount': len(links), 'links': links}


def _sync_scene_to_default(service, scene_id):
    if service is default_service or not hasattr(service, 'scenes') or not scene_id:
        return
    with service.lock:
        entry = service.scenes.get(scene_id)
    if entry is not None:
        with default_service.lock:
            default_service.scenes[scene_id] = copy.deepcopy(entry)


def _normalize_table_op(op, op_id):
    return {
        'id': op_id,
        'kind': 'table-cell',
        'itemId': op.get('itemId'),
        'row': op.get('row'),
        'column': op.get('column'),
        'before': op.get('before'),
        'after': op.get('after'),
    }


def _normalize_shape_op(op, op_id, paper_id, file_hash, service):
    plan = dict(op.get('plan') or {})
    plan.setdefault('schema', CHART_SCHEMA)
    plan.setdefault('paperId', paper_id)
    plan.setdefault('fileHash', file_hash)
    _sync_scene_to_default(service, plan.get('sceneId'))
    return {'id': op_id, 'kind': 'chart-shape', 'plan': plan}


def _normalize_region_op(op, op_id, kind, store, paper_id):
    asset_kind = op.get('assetKind') or ('graph' if kind == 'chart-redraw' else 'figure')
    png_b64 = op.get('png') if op.get('png') is not None else op.get('pngBase64')
    before_sha = op.get('beforeImageSha256')
    page_index, bbox = op.get('pageIndex'), op.get('bbox')
    if before_sha is None and type(page_index) is int and isinstance(bbox, list):
        before_sha = store.render_region(paper_id, page_index, bbox=bbox, dpi=150)['sha256']
    normalized = {
        'id': op_id,
        'kind': 'region',
        'assetKind': asset_kind,
        'pageIndex': page_index,
        'bbox': bbox,
        'beforeImageSha256': before_sha,
        'png': png_b64,
    }
    if 'dataChanges' in op:
        normalized['dataChanges'] = op['dataChanges']
    return normalized


def _normalize_uri_op(op, op_id):
    out = {
        'id': op_id,
        'kind': 'uri-link',
        'pageIndex': op.get('pageIndex'),
        'annotIndex': op.get('annotIndex'),
        'afterUri': op.get('afterUri'),
    }
    for key in ('linkId', 'beforeUri', 'rationale'):
        if op.get(key) is not None:
            out[key] = op.get(key)
    return out


def _normalize_text_span_op(op, op_id):
    out = {
        'id': op_id,
        'kind': 'text-span',
        'pageIndex': op.get('pageIndex'),
        'before': op.get('before'),
        'after': op.get('after'),
        'occurrence': op.get('occurrence', 0),
    }
    for key in ('bbox', 'spanId'):
        if op.get(key) is not None:
            out[key] = op[key]
    return out


def _normalize_supplement_op(op, op_id):
    out = {
        'id': op_id,
        'kind': 'supplement-edit',
        'before': op.get('before'),
        'after': op.get('after'),
        'occurrence': op.get('occurrence', 0),
    }
    for key in ('supplementId', 'name'):
        if op.get(key) is not None:
            out[key] = op[key]
    return out


def _validate_op_taxonomy(op):
    world = op.get('world')
    if world is not None and world not in _VALID_WORLDS:
        raise ValueError('red_taxonomy_invalid')
    difficulty = op.get('difficulty')
    if difficulty is not None and difficulty not in _VALID_DIFFICULTIES:
        raise ValueError('red_taxonomy_invalid')
    family = op.get('family')
    if family is not None and (not isinstance(family, str) or not _VALID_FAMILY_RE.fullmatch(family)):
        raise ValueError('red_taxonomy_invalid')
    rationale = op.get('rationale')
    if rationale is not None and not isinstance(rationale, str):
        raise ValueError('red_taxonomy_invalid')


def _normalize_single_op(op, idx, store, paper_id, file_hash, service):
    if not isinstance(op, dict):
        raise ValueError('visual_operation_invalid')
    _validate_op_taxonomy(op)
    op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'red-op-{idx}'
    kind = op.get('kind')
    if kind == 'table-cell':
        return _normalize_table_op(op, op_id)
    if kind == 'chart-shape':
        return _normalize_shape_op(op, op_id, paper_id, file_hash, service)
    if kind in ('chart-redraw', 'region-replace', 'region'):
        return _normalize_region_op(op, op_id, kind, store, paper_id)
    if kind == 'uri-link':
        return _normalize_uri_op(op, op_id)
    if kind == 'text-span':
        return _normalize_text_span_op(op, op_id)
    if kind in ('supplement-edit', 'supplement-text'):
        return _normalize_supplement_op(op, op_id)
    raise ValueError('visual_operation_invalid')


def _normalize_operations(operations, store, paper_id, file_hash, service):
    if not isinstance(operations, list):
        raise ValueError('visual_operation_invalid')
    return [_normalize_single_op(op, idx, store, paper_id, file_hash, service) for idx, op in enumerate(operations)]


def _empty_vis_result(source_bytes, file_hash):
    return {
        'schema': 'falsify.visual-edit-export.v1',
        'sourceSha256': file_hash,
        'outputSha256': file_hash,
        'file': base64.b64encode(source_bytes).decode('ascii'),
        'changes': [],
        'verification': {'status': 'passed', 'issues': [], 'checks': ['page-count'], 'scope': 'source-preservation'},
    }


def _append_check(vis_result, check_name):
    checks = vis_result.setdefault('verification', {}).setdefault('checks', [])
    if check_name not in checks:
        checks.append(check_name)


def _apply_text_span_ops(edited_bytes, vis_result, text_ops):
    text_res = mutate_pdf_text_spans(edited_bytes, text_ops)
    out_bytes = text_res['pdfBytes']
    vis_result['outputSha256'] = text_res['outputSha256']
    vis_result['file'] = base64.b64encode(out_bytes).decode('ascii')
    vis_result['changes'].extend(text_res['changes'])
    _append_check(vis_result, 'text-span')
    return out_bytes, vis_result


def _apply_uri_ops(edited_bytes, vis_result, uri_ops):
    uri_res = mutate_pdf_uri_links(edited_bytes, uri_ops, require_clean_stealth=True)
    out_bytes = uri_res['pdfBytes']
    vis_result['outputSha256'] = uri_res['outputSha256']
    vis_result['file'] = base64.b64encode(out_bytes).decode('ascii')
    for op, ch in zip(uri_ops, uri_res['changes']):
        vis_result['changes'].append({'id': op['id'], 'kind': 'uri-link', **ch})
    _append_check(vis_result, 'uri-link')
    return out_bytes, vis_result


def _apply_operations(store, service, paper_id, file_hash, operations, supplements=None, cancelled=None):
    source_bytes = store.source_bytes(paper_id, file_hash)
    normalized = _normalize_operations(operations, store, paper_id, file_hash, service)
    visual_kinds = {'table-cell', 'chart-shape', 'region'}
    visual_ops = [op for op in normalized if op['kind'] in visual_kinds]
    text_ops = [op for op in normalized if op['kind'] == 'text-span']
    uri_ops = [op for op in normalized if op['kind'] == 'uri-link']
    supp_ops = [op for op in normalized if op['kind'] == 'supplement-edit']
    if visual_ops:
        vis_req = {
            'schema': VISUAL_SCHEMA,
            'paperId': paper_id,
            'fileHash': file_hash,
            'revision': 'red-coordinated',
            'operations': visual_ops,
        }
        vis_result = export_visual(vis_req, store=store, cancelled=cancelled)
        edited_bytes = base64.b64decode(vis_result['file'], validate=True)
    else:
        edited_bytes = source_bytes
        vis_result = _empty_vis_result(source_bytes, file_hash)
    if text_ops:
        edited_bytes, vis_result = _apply_text_span_ops(edited_bytes, vis_result, text_ops)
    if uri_ops:
        edited_bytes, vis_result = _apply_uri_ops(edited_bytes, vis_result, uri_ops)
    blind_supplements = []
    if supplements or supp_ops:
        supp_res = mutate_supplements(supplements or [], supp_ops)
        blind_supplements = supp_res['blindSupplements']
        vis_result['changes'].extend(supp_res['changes'])
        if supp_ops:
            _append_check(vis_result, 'supplement-edit')
    return source_bytes, edited_bytes, vis_result, blind_supplements


def _modified_regions(vis_result):
    regions = []
    for change in vis_result.get('changes', []):
        if change.get('kind') in ('uri-link', 'supplement-edit'):
            continue
        if type(change.get('pageIndex')) is int and isinstance(change.get('bbox'), list) and len(change['bbox']) == 4:
            regions.append({'pageIndex': change['pageIndex'], 'bbox': change['bbox']})
    return regions


def _render_preview_png(pdf_bytes, page_index, dpi=150):
    if type(page_index) is not int or page_index < 0:
        raise ValueError('paper_evidence_page_invalid')
    with pymupdf.open(stream=pdf_bytes, filetype='pdf') as doc:
        if page_index >= len(doc):
            raise ValueError('paper_evidence_page_invalid')
        png = doc[page_index].get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=False).tobytes('png')
    return base64.b64encode(png).decode('ascii')


def _decode_candidate_pdf(candidate_b64):
    if not isinstance(candidate_b64, str) or not candidate_b64:
        raise ValueError('pdf_invalid')
    try:
        raw = base64.b64decode(candidate_b64, validate=True)
    except (ValueError, TypeError):
        raise ValueError('pdf_invalid') from None
    if len(raw) > MAX_CANDIDATE_PDF_BYTES or not raw.startswith(b'%PDF-'):
        raise ValueError('pdf_invalid')
    return raw


def _text_overlaps(a, b):
    na = ' '.join(str(a or '').split()).lower()
    nb = ' '.join(str(b or '').split()).lower()
    if len(na) < 4 or len(nb) < 4:
        return False
    if na in nb or nb in na:
        return True
    if min(len(na), len(nb)) < 12:
        return False
    short, long_s = (na, nb) if len(na) <= len(nb) else (nb, na)
    return any(short[i:i + 12] in long_s for i in range(len(short) - 11))


def _cue_overlaps(text, sig):
    rep = sig.get('reported')
    if not isinstance(rep, dict):
        return False
    uri = rep.get('uri')
    if isinstance(uri, str) and uri and uri == text:
        return True
    for key in ('citedIndex', 'refIndex', 'index'):
        idx = rep.get(key)
        if type(idx) is int and f'[{idx}]' in text:
            return True
    return False


def _signal_cues(sig):
    rep = sig.get('reported')
    if not isinstance(rep, dict):
        return []
    cues = []
    for key in ('citedIndex', 'refIndex', 'index'):
        if type(rep.get(key)) is int:
            cues.append(f'[{rep[key]}]')
    for key in ('doi', 'uri', 'p', 'statValue', 'pct', 'estimate'):
        val = rep.get(key)
        if val is not None and not isinstance(val, (dict, list, bool)):
            cues.append(str(val).lower())
    return [c for c in cues if c]


def _narrow_excerpt(sig):
    raw = str(sig.get('excerpt') or '')
    cues = _signal_cues(sig)
    if not raw or not cues:
        return raw
    parts = [p for p in re.split(r'(?<=[.!?\n])\s+', raw) if p]
    if len(parts) <= 1:
        return raw
    hits = [p for p in parts if any(c in p.lower() for c in cues)]
    return ' '.join(hits) if hits else raw


def _signal_matches_op(sig, op_page, op_item_id, op_texts):
    sig_page = sig.get('pageIndex')
    if op_page is not None and type(sig_page) is int and op_page != sig_page:
        return False
    if op_item_id and sig.get('itemId') == op_item_id:
        return True
    excerpt = _narrow_excerpt(sig)
    haystack = f"{excerpt} {sig.get('detail') or ''}" if not excerpt else excerpt
    return any(_text_overlaps(txt, haystack) or _cue_overlaps(txt, sig) for txt in op_texts)


def _op_match_fields(op, idx, changes_by_id):
    op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'red-op-{idx}'
    ch = changes_by_id.get(op_id, {})
    op_page = op.get('pageIndex') if type(op.get('pageIndex')) is int else ch.get('pageIndex')
    op_item_id = op.get('itemId') or ch.get('itemId')
    op_texts = [v for v in (op.get('before'), op.get('beforeUri')) if isinstance(v, str) and v.strip()]
    return op_id, op_page, op_item_id, op_texts


def _detect_baseline_overlaps(operations, changes, baseline_report):
    signals = (baseline_report or {}).get('signals') or []
    if not signals or not operations:
        return []
    changes_by_id = {ch['id']: ch for ch in changes if isinstance(ch, dict) and ch.get('id')}
    overlaps = []
    for idx, op in enumerate(operations):
        if op.get('kind') == 'supplement-edit':
            continue
        op_id, op_page, op_item_id, op_texts = _op_match_fields(op, idx, changes_by_id)
        matched = [s for s in signals if _signal_matches_op(s, op_page, op_item_id, op_texts)]
        if matched:
            overlaps.append({
                'operationId': op_id,
                'kind': op.get('kind'),
                'pageIndex': op_page,
                'signalIds': [s.get('id') for s in matched if s.get('id')],
                'signals': [
                    {
                        'id': s.get('id'),
                        'family': s.get('family'),
                        'kind': s.get('kind'),
                        'pageIndex': s.get('pageIndex'),
                        'excerpt': s.get('excerpt'),
                        'detail': s.get('detail'),
                    }
                    for s in matched
                ],
                'warning': 'Operation overlaps pre-existing Layer 0 defect in source PDF.',
            })
    return overlaps


def _defect_before_after(op, ch):
    if 'before' in op or 'after' in op:
        return op.get('before'), op.get('after')
    if 'beforeUri' in op or 'afterUri' in op:
        return op.get('beforeUri') or ch.get('beforeUri'), op.get('afterUri') or ch.get('afterUri')
    return ch.get('before'), ch.get('after')


def _build_gold_ledger(paper_id, file_hash, output_sha256, stealth, operations, changes):
    changes_by_id = {ch['id']: ch for ch in changes if isinstance(ch, dict) and ch.get('id')}
    defects = []
    for idx, op in enumerate(operations):
        op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'red-op-{idx}'
        ch = changes_by_id.get(op_id, {})
        before_val, after_val = _defect_before_after(op, ch)
        kind = op.get('kind')
        family = op.get('family') or ch.get('defectFamily') or ('D2' if kind == 'uri-link' else None)
        defects.append({
            'defectId': op.get('defectId') or op_id,
            'operationId': op_id,
            'kind': kind,
            'pageIndex': op.get('pageIndex') if type(op.get('pageIndex')) is int else ch.get('pageIndex'),
            'bbox': ch.get('bbox') or op.get('bbox'),
            'itemId': op.get('itemId') or ch.get('itemId'),
            'supplementName': ch.get('supplementName') or op.get('name'),
            'before': before_val,
            'after': after_val,
            'world': op.get('world'),
            'family': family,
            'difficulty': op.get('difficulty'),
            'rationale': op.get('rationale'),
            'stealthStatus': stealth['status'],
        })
    return {
        'schema': GOLD_LEDGER_SCHEMA,
        'paperId': paper_id,
        'sourceSha256': file_hash,
        'blindPdfSha256': output_sha256,
        'stealthPass': stealth['status'] != 'detectable_artifact',
        'defects': defects,
    }


def _list_text_spans_for_paper(store, paper_id, file_hash, page_index=None, query=None, limit=200):
    raw = store.source_bytes(paper_id, file_hash)
    res = list_pdf_text_spans(raw, page_index=page_index, query=query, limit=limit)
    return {**res, 'paperId': paper_id, 'fileHash': file_hash}


def _list_supplements_for_paper(paper_id, file_hash, supplements):
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'supplementCount': len(supplements),
        'supplements': [
            {
                'supplementId': s['supplementId'],
                'name': s['name'],
                'kind': s['kind'],
                'sha256': s['sha256'],
                'sizeBytes': s['sizeBytes'],
                'lineCount': s['lineCount'],
                'text': s['text'],
            }
            for s in supplements
        ],
    }


def _get_baseline(store, paper_id, file_hash, baseline_cache):
    if baseline_cache.get('report') is None:
        baseline_cache['report'] = run_blue_sensor(
            paper_id, file_hash=file_hash, include_external_oracle=False, store=store,
        )
    return baseline_cache['report']


def _preview_edits(
    store, service, paper_id, file_hash, operations, preview_page_index, cancelled,
    supplements=None, baseline_cache=None,
):
    source_bytes, edited_bytes, vis_result, blind_supplements = _apply_operations(
        store, service, paper_id, file_hash, operations, supplements=supplements, cancelled=cancelled,
    )
    png_b64 = _render_preview_png(edited_bytes, preview_page_index)
    stealth = audit_pdf_stealth(source_bytes, edited_bytes, modified_regions=_modified_regions(vis_result))
    baseline = _get_baseline(store, paper_id, file_hash, baseline_cache if baseline_cache is not None else {})
    overlaps = _detect_baseline_overlaps(operations, vis_result.get('changes', []), baseline)
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'outputSha256': vis_result['outputSha256'],
        'previewPageIndex': preview_page_index,
        'appliedCount': len(vis_result.get('changes', [])),
        'stealthAudit': stealth,
        'baselineOverlaps': overlaps,
        'blindSupplements': blind_supplements,
        'verification': vis_result.get('verification'),
        'image': png_b64,
    }


def _export_edits(
    store, service, paper_id, file_hash, operations, require_clean_stealth, cancelled,
    supplements=None, baseline_cache=None,
):
    source_bytes, edited_bytes, vis_result, blind_supplements = _apply_operations(
        store, service, paper_id, file_hash, operations, supplements=supplements, cancelled=cancelled,
    )
    stealth = audit_pdf_stealth(source_bytes, edited_bytes, modified_regions=_modified_regions(vis_result))
    if require_clean_stealth and stealth['status'] == 'detectable_artifact':
        raise ValueError('stealth_audit_failed')
    assert_blind_supplements(blind_supplements)
    changes = vis_result.get('changes', [])
    baseline = _get_baseline(store, paper_id, file_hash, baseline_cache if baseline_cache is not None else {})
    overlaps = _detect_baseline_overlaps(operations, changes, baseline)
    gold_ledger = _build_gold_ledger(
        paper_id, file_hash, vis_result['outputSha256'], stealth, operations, changes,
    )
    record = {
        'schema': 'falsify.coordinated-red-record.v1',
        'paperId': paper_id,
        'sourceSha256': file_hash,
        'outputSha256': vis_result['outputSha256'],
        'changes': changes,
        'verification': vis_result.get('verification'),
        'operations': copy.deepcopy(operations),
    }
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'outputSha256': vis_result['outputSha256'],
        'pdfBase64': vis_result['file'],
        'blindSupplements': blind_supplements,
        'stealthAudit': stealth,
        'baselineOverlaps': overlaps,
        'goldLedger': gold_ledger,
        'record': record,
    }


def _audit_candidate(store, paper_id, file_hash, candidate_b64, modified_regions):
    candidate_bytes = _decode_candidate_pdf(candidate_b64)
    source_bytes = store.source_bytes(paper_id, file_hash)
    return audit_pdf_stealth(source_bytes, candidate_bytes, modified_regions=modified_regions)


def _bbox_of(value):
    if isinstance(value, (list, tuple)) and len(value) == 4:
        return [float(v) for v in value]
    return None


def _error_context_ops(context):
    operations = (context or {}).get('operations')
    return [op for op in operations or [] if isinstance(op, dict)]


def _ops_of_kind(context, kind):
    return [op for op in _error_context_ops(context) if op.get('kind') == kind]


def _read_table_item(store, paper_id, item_id):
    if store is None or not isinstance(item_id, str) or not item_id:
        return None
    try:
        item = store.read_item(paper_id, item_id)
    except (KeyError, ValueError):
        return None
    return item if isinstance(item, dict) and item.get('type') == 'table' else None


def _find_cell(item, row, column):
    table = item.get('table') if isinstance(item, dict) else None
    cells = table.get('cells') if isinstance(table, dict) else None
    for cell in cells or []:
        if not isinstance(cell, dict):
            continue
        if cell.get('row') == row and cell.get('column') == column:
            return cell
    return None


def _table_failing_op(context):
    ops = _ops_of_kind(context, 'table-cell')
    for op in reversed(ops):
        item = _read_table_item(context.get('store'), context.get('paperId'), op.get('itemId'))
        if item is None:
            return op
        cell = _find_cell(item, op.get('row'), op.get('column'))
        if cell is None or op.get('before') != str(cell.get('text') or ''):
            return op
    return ops[-1] if ops else None


def _cell_distance(cell, row, column):
    if type(row) is not int or type(column) is not int:
        return 0
    return abs(int(cell.get('row') or 0) - row) + abs(int(cell.get('column') or 0) - column)


def _cell_candidates(item, op):
    table = item.get('table') if isinstance(item, dict) else None
    cells = table.get('cells') if isinstance(table, dict) else None
    if not isinstance(cells, list):
        return []
    row, column = (op or {}).get('row'), (op or {}).get('column')
    ranked = []
    for cell in cells:
        if not isinstance(cell, dict) or not str(cell.get('text') or '').strip():
            continue
        ranked.append((_cell_distance(cell, row, column), int(cell.get('row') or 0), int(cell.get('column') or 0), {
            'row': cell.get('row'),
            'column': cell.get('column'),
            'text': str(cell.get('text') or ''),
            'bbox': _bbox_of(cell.get('bbox')),
        }))
    ranked.sort(key=lambda entry: (entry[0], entry[1], entry[2]))
    return [entry[3] for entry in ranked[:5]]


def _enrich_table(code, context):
    op = _table_failing_op(context)
    item_id = op.get('itemId') if op else None
    item = _read_table_item(context.get('store'), context.get('paperId'), item_id)
    candidates = _cell_candidates(item, op)
    cell = _find_cell(item, (op or {}).get('row'), (op or {}).get('column'))
    bbox = _bbox_of((cell or {}).get('bbox')) or _bbox_of((op or {}).get('bbox'))
    if candidates:
        hint = 'Pick an existing row/column pair from nearestCandidates and pass its exact text as "before".'
    else:
        hint = 'Call list_red_targets for a table itemId, then retry with an existing row and column.'
    return build_error_payload(
        code,
        actual_value=(op or {}).get('before'),
        nearest_candidates=candidates,
        bbox=bbox,
        recovery_hint=hint,
        extra={'itemId': item_id, 'row': (op or {}).get('row'), 'column': (op or {}).get('column')},
    )


def _point_center(point):
    x, y = point.get('x'), point.get('y')
    if type(x) not in (int, float) or type(y) not in (int, float):
        return None
    return [round(float(x), 2), round(float(y), 2)]


def _scene_candidates(scene, limit=5):
    candidates = []
    for series in (scene or {}).get('series') or []:
        if not isinstance(series, dict):
            continue
        for index, point in enumerate(series.get('points') or []):
            center = _point_center(point) if isinstance(point, dict) else None
            if center is None:
                continue
            candidates.append({'seriesId': series.get('id'), 'pointIndex': index, 'center': center})
            if len(candidates) >= limit:
                return candidates
    return candidates


def _scene_of(service, scene_id):
    scenes = getattr(service, 'scenes', None)
    if not isinstance(scenes, dict) or not isinstance(scene_id, str):
        return None
    entry = scenes.get(scene_id)
    scene = entry.get('scene') if isinstance(entry, dict) else None
    return scene if isinstance(scene, dict) else None


def _chart_actual(code, plan):
    """Echo the rejected chart-plan value that the fixed code points at."""
    if code in ('chart_revision_invalid', 'chart_operation_limit'):
        return plan.get('revision')
    return plan.get('sceneId')


def _enrich_chart(code, context):
    ops = _ops_of_kind(context, 'chart-shape')
    op = ops[-1] if ops else None
    plan = (op or {}).get('plan')
    plan = plan if isinstance(plan, dict) else {}
    scene = _scene_of(context.get('service'), plan.get('sceneId'))
    candidates = _scene_candidates(scene or (op or {}).get('scene'))
    bbox = _bbox_of(plan.get('bbox')) or _bbox_of((op or {}).get('bbox'))
    hint = (
        'Call prepare_chart_scene for the figure region, then retry with a seriesId/center pair from nearestCandidates.'
        if candidates else
        'Call prepare_chart_scene for this pageIndex and bbox first, then retry the chart plan with the returned sceneId.'
    )
    return build_error_payload(
        code,
        actual_value=_chart_actual(code, plan),
        nearest_candidates=candidates,
        bbox=bbox,
        recovery_hint=hint,
        extra={'sceneId': plan.get('sceneId'), 'kind': (op or {}).get('kind')},
    )


def _bound_links(context):
    store, paper_id = context.get('store'), context.get('paperId')
    file_hash = context.get('fileHash')
    if store is None or file_hash is None:
        return []
    try:
        return list_pdf_uri_links(store.source_bytes(paper_id, file_hash)).get('links') or []
    except (KeyError, ValueError):
        return []


def _uri_failing_op(context, links):
    by_id = {link.get('linkId'): link for link in links}
    ops = _ops_of_kind(context, 'uri-link')
    for op in reversed(ops):
        link = by_id.get(op.get('linkId'))
        if link is None or op.get('beforeUri') not in (None, link.get('uri')):
            return op
    return ops[-1] if ops else None


def _link_candidate(link):
    return {
        'linkId': link.get('linkId'),
        'pageIndex': link.get('pageIndex'),
        'bbox': _bbox_of(link.get('bbox')),
        'uri': link.get('uri'),
        'visibleText': link.get('visibleText'),
    }


def _enrich_uri(code, context):
    links = _bound_links(context)
    op = _uri_failing_op(context, links)
    candidates = [_link_candidate(link) for link in links[:5]]
    target = next((link for link in links if link.get('linkId') == (op or {}).get('linkId')), None)
    target = target if target is not None else (links[0] if links else None)
    hint = 'Retry with a linkId of the form p<page>-a<annot> from nearestCandidates and its exact uri as beforeUri.'
    return build_error_payload(
        code,
        actual_value=(op or {}).get('beforeUri'),
        nearest_candidates=candidates,
        bbox=_bbox_of((target or {}).get('bbox')) or _bbox_of((op or {}).get('bbox')),
        recovery_hint=hint,
        extra={'linkId': (op or {}).get('linkId')},
    )


def _enrich_text(code, context):
    ops = _ops_of_kind(context or {}, 'text-span') or _ops_of_kind(context or {}, 'supplement-edit')
    op = ops[-1] if ops else None
    if op is None:
        return build_error_payload(code)
    return build_error_payload(
        code,
        actual_value=op.get('before'),
        nearest_candidates=[],
        recovery_hint='Call list_text_spans (or list_red_supplements) with that exact "before" text and retry with its spanId.',
    )


def _taxonomy_actual(op):
    for key, valid in (
        ('world', VALID_WORLDS), ('difficulty', VALID_DIFFICULTIES), ('family', VALID_FAMILIES), ('kind', VALID_KINDS),
    ):
        value = (op or {}).get(key)
        if value is not None and value not in valid:
            return value
    return None


def _taxonomy_rejected(ops):
    """First rejected taxonomy value, matching the normalizer's own operation order."""
    for op in ops:
        rejected = _taxonomy_actual(op)
        if rejected is not None:
            return rejected
    return None


def _enrich_taxonomy(code, context):
    return build_error_payload(
        code,
        actual_value=_taxonomy_rejected(_error_context_ops(context)),
        nearest_candidates=[],
        recovery_hint=taxonomy_hint(),
        extra={
            'validWorlds': list(VALID_WORLDS),
            'validDifficulties': list(VALID_DIFFICULTIES),
            'validFamilies': list(VALID_FAMILIES),
            'validKinds': list(VALID_KINDS),
        },
    )


_ENRICHERS = {
    'taxonomy': _enrich_taxonomy,
    'table': _enrich_table,
    'chart': _enrich_chart,
    'uri': _enrich_uri,
    'text': _enrich_text,
    'supplement': _enrich_text,
}


def _enrich_error(code, context):
    """Build candidates for a bare fixed code raised by a child or normalizer."""
    enricher = _ENRICHERS.get(error_surface(code))
    if enricher is None:
        return build_error_payload(code)
    return enricher(code, context or {})


def _self_healing_error(exc, context=None):
    details = getattr(exc, 'details', None)
    if isinstance(details, dict) and details.get('error'):
        payload = normalize_payload(details)
    else:
        payload = normalize_payload(_enrich_error(code_of(exc), context))
    return CallToolResult(
        content=[TextContent(type='text', text=json.dumps(payload, ensure_ascii=False, separators=(',', ':')))],
        structuredContent=payload,
        isError=True,
    )


def _run_guarded(bound, file_hash, paper_id, action, context=None):
    captured = {}

    def wrapped():
        try:
            return action()
        except (SpanMutationError, RedMutationError) as exc:
            captured['err'] = exc
            return {}
        except ValueError as exc:
            if not is_fixed_code(exc):
                raise
            captured['err'] = exc
            return {}

    result = _guard(bound, file_hash, paper_id, wrapped)
    if 'err' in captured:
        return _self_healing_error(captured['err'], context)
    return result


def build_server(store, paper_id, file_hash, service=None, supplements=None):
    """Build FastMCP coordinated RED server bound to one immutable source PDF and optional supplements."""
    service = service or ChartEditService(store)
    loaded_supplements = normalize_supplements(supplements)
    baseline_cache = {'report': None}
    instructions = (
        'Coordinated RED editor for one selected PDF. Never mutates the input PDF or supplements on disk. '
        'Inspect targets with list_red_targets, list_text_spans, list_pdf_links, and list_red_supplements; '
        'prepare chart scenes with prepare_chart_scene, preview with preview_coordinated_edits, '
        'export blind PDFs with export_coordinated_edits, or self-audit with audit_candidate_pdf. '
        'RED plan with plan_coordinated_mutation, then score exposure with '
        'simulate_red_detectability and trace_claim_propagation before exporting.\nSelected PDF: '
        + json.dumps({'paperId': paper_id, 'fileHash': file_hash})
    )
    server = FastMCP(name=SERVER_NAME, instructions=instructions, log_level='ERROR')

    def error_context(operations=None):
        return {
            'store': store,
            'service': service,
            'paperId': paper_id,
            'fileHash': file_hash,
            'operations': operations,
        }

    def call(pid, fn, operations=None):
        result = _run_guarded(paper_id, file_hash, pid, fn, error_context(operations))
        return result if isinstance(result, CallToolResult) else _ok(result)

    @server.tool(annotations=_READONLY)
    def list_red_targets(paperId: str, pageIndex: int | None = None) -> CallToolResult:
        """List extracted paragraphs/text blocks, tables, and scientific figures for the startup PDF."""
        return call(paperId, lambda: _list_targets(store, paperId, file_hash, page_index=pageIndex))

    @server.tool(annotations=_READONLY)
    def list_text_spans(
        paperId: str,
        pageIndex: int | None = None,
        query: str | None = None,
        limit: int = 200,
    ) -> CallToolResult:
        """List addressable reading-order PDF prose lines/spans with optional query filter."""
        return call(paperId, lambda: _list_text_spans_for_paper(
            store, paperId, file_hash, page_index=pageIndex, query=query, limit=limit,
        ))

    @server.tool(annotations=_READONLY)
    def list_red_supplements(paperId: str) -> CallToolResult:
        """List immutable startup supplements bound to this RED session."""
        return call(paperId, lambda: _list_supplements_for_paper(paperId, file_hash, loaded_supplements))

    @server.tool(annotations=_READONLY)
    def scan_source_baseline(paperId: str) -> CallToolResult:
        """Run offline Layer 0 BLUE baseline scan on the untouched source PDF before choosing RED targets."""
        return call(paperId, lambda: _get_baseline(store, paperId, file_hash, baseline_cache))

    @server.tool(annotations=_READONLY)
    def list_pdf_links(paperId: str, pageIndex: int | None = None) -> CallToolResult:
        """List embedded PDF /Link annotations carrying /A -> /S /URI actions."""
        return call(paperId, lambda: _list_links(store, paperId, file_hash, page_index=pageIndex))

    @server.tool(annotations=_READONLY)
    async def prepare_chart_scene(paperId: str, pageIndex: int, bbox: list[float], options: dict | None = None) -> CallToolResult:
        """Prepare an editable chart scene for a selected figure/graph region."""
        return await _cancellable_thread(lambda cancelled: call(
            paperId,
            lambda: service.prepare(
                {'paperId': paperId, 'fileHash': file_hash, 'pageIndex': pageIndex, 'bbox': bbox, 'options': options},
                cancelled=cancelled,
            ),
        ))

    @server.tool(annotations=_READONLY)
    async def preview_coordinated_edits(paperId: str, operations: list[dict], previewPageIndex: int = 0) -> CallToolResult:
        """Apply operations in memory, render previewPageIndex PNG, and run stealth self-audit."""
        result = await _cancellable_thread(lambda cancelled: _run_guarded(
            paper_id, file_hash, paperId,
            lambda: _preview_edits(
                store, service, paperId, file_hash, operations, previewPageIndex, cancelled,
                supplements=loaded_supplements, baseline_cache=baseline_cache,
            ),
            error_context(operations),
        ))
        if isinstance(result, CallToolResult):
            return result
        image = result.pop('image')
        return _ok(result, (image, 'image/png'))

    @server.tool(annotations=_EDITING)
    async def export_coordinated_edits(paperId: str, operations: list[dict], requireCleanStealth: bool = False) -> CallToolResult:
        """Export a blind edited PDF copy + blindSupplements + stealth audit + sealed goldLedger."""
        return await _cancellable_thread(lambda cancelled: call(
            paperId,
            lambda: _export_edits(
                store, service, paperId, file_hash, operations, requireCleanStealth, cancelled,
                supplements=loaded_supplements, baseline_cache=baseline_cache,
            ),
            operations,
        ))

    @server.tool(annotations=_READONLY)
    async def simulate_red_detectability(paperId: str, operations: list[dict]) -> CallToolResult:
        """Read-only Layer 0 detectability simulation and L1..L4 cross-inference distance for proposed operations."""
        from paper_red_detectability import simulate_red_detectability as simulate

        return await _cancellable_thread(lambda _cancelled: call(
            paperId,
            lambda: simulate(
                paperId, operations, file_hash=file_hash, store=store,
                supplements=loaded_supplements, service=service,
            ),
            operations,
        ))

    @server.tool(annotations=_READONLY)
    def trace_claim_propagation(paperId: str, query: str) -> CallToolResult:
        """Read-only trace of one numeric or short textual claim across prose, table, figure, citation and supplement surfaces."""
        from paper_red_detectability import trace_claim_propagation as trace

        return call(
            paperId,
            lambda: trace(paperId, query, file_hash=file_hash, store=store, supplements=loaded_supplements),
        )

    @server.tool(annotations=_READONLY)
    async def plan_coordinated_mutation(
        paperId: str,
        targetDifficulty: str = 'L3',
        maxBundles: int = 5,
        claimQuery: str | None = None,
    ) -> CallToolResult:
        """Read-only synthesis of detectability-verified coordinated multi-surface RED operation bundles."""
        from paper_red_planner import plan_coordinated_mutations

        return await _cancellable_thread(lambda _cancelled: call(
            paperId,
            lambda: plan_coordinated_mutations(
                paperId,
                file_hash=file_hash,
                store=store,
                supplements=loaded_supplements,
                service=service,
                target_difficulty=targetDifficulty,
                max_bundles=maxBundles,
                claim_query=claimQuery,
            ),
        ))

    @server.tool(annotations=_READONLY)
    async def audit_candidate_pdf(paperId: str, candidatePdfBase64: str, modifiedRegions: list[dict] | None = None) -> CallToolResult:
        """Run forensic and visual stealth self-audit comparing bound source PDF against a candidate PDF."""
        return await _cancellable_thread(lambda _cancelled: call(
            paperId,
            lambda: _audit_candidate(store, paperId, file_hash, candidatePdfBase64, modifiedRegions),
        ))

    return server


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog='python app/local/paper_red_mcp.py', description=__doc__)
    parser.add_argument('--pdf', required=True, help='Read only this PDF. Tools cannot open another file.')
    parser.add_argument(
        '--supplement', action='append', default=[], dest='supplements',
        help='Optional UTF-8 supplement file (repeatable, max 12 files, never modified on disk).',
    )
    args = parser.parse_args(argv)
    try:
        from paper_evidence import default_store
        summary = open_selected(default_store, args.pdf)
        supplements = load_red_supplements(args.supplements)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    logging.getLogger('mcp').setLevel(logging.ERROR)
    build_server(default_store, summary['paperId'], summary['fileHash'], supplements=supplements).run(transport='stdio')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

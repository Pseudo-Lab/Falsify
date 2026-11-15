"""Unified coordinated RED MCP server for one selected PDF.

Usage:
    python app/local/paper_red_mcp.py --pdf PATH

Reuses EvidenceStore, ChartEditService, export_visual, and audit_pdf_stealth.
Never modifies the startup PDF on disk; keeps paper_mcp.py and paper_chart_edit_mcp.py separate.
"""
import argparse
import base64
import copy
import hashlib
import json
import logging
import sys

import pymupdf
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, ToolAnnotations

from paper_chart_edit_service import ChartEditService, SCHEMA as CHART_SCHEMA, default_service
from paper_evidence_text import _extract_raw_blocks, _order_blocks
from paper_mcp import _cancellable_thread, _guard, _ok, open_selected
from paper_stealth_audit import audit_pdf_stealth
from paper_visual_edit import SCHEMA as VISUAL_SCHEMA, export_visual

SERVER_NAME = 'Falsify Coordinated RED Editor'
MAX_CANDIDATE_PDF_BYTES = 50 * 1024 * 1024
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


def _normalize_operations(operations, store, paper_id, file_hash, service):
    if not isinstance(operations, list):
        raise ValueError('visual_operation_invalid')
    normalized = []
    for idx, op in enumerate(operations):
        if not isinstance(op, dict):
            raise ValueError('visual_operation_invalid')
        op_id = op.get('id') if isinstance(op.get('id'), str) and op.get('id') else f'red-op-{idx}'
        kind = op.get('kind')
        if kind == 'table-cell':
            normalized.append(_normalize_table_op(op, op_id))
        elif kind == 'chart-shape':
            normalized.append(_normalize_shape_op(op, op_id, paper_id, file_hash, service))
        elif kind in ('chart-redraw', 'region-replace', 'region'):
            normalized.append(_normalize_region_op(op, op_id, kind, store, paper_id))
        else:
            raise ValueError('visual_operation_invalid')
    return normalized


def _apply_operations(store, service, paper_id, file_hash, operations, cancelled=None):
    source_bytes = store.source_bytes(paper_id, file_hash)
    normalized = _normalize_operations(operations, store, paper_id, file_hash, service)
    if not normalized:
        vis_result = {
            'schema': 'falsify.visual-edit-export.v1',
            'sourceSha256': file_hash,
            'outputSha256': file_hash,
            'file': base64.b64encode(source_bytes).decode('ascii'),
            'changes': [],
            'verification': {'status': 'passed', 'issues': [], 'checks': ['page-count'], 'scope': 'source-preservation'},
        }
        return source_bytes, source_bytes, vis_result
    vis_req = {
        'schema': VISUAL_SCHEMA,
        'paperId': paper_id,
        'fileHash': file_hash,
        'revision': 'red-coordinated',
        'operations': normalized,
    }
    vis_result = export_visual(vis_req, store=store, cancelled=cancelled)
    edited_bytes = base64.b64decode(vis_result['file'], validate=True)
    return source_bytes, edited_bytes, vis_result


def _modified_regions(vis_result):
    regions = []
    for change in vis_result.get('changes', []):
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


def _preview_edits(store, service, paper_id, file_hash, operations, preview_page_index, cancelled):
    source_bytes, edited_bytes, vis_result = _apply_operations(
        store, service, paper_id, file_hash, operations, cancelled=cancelled)
    png_b64 = _render_preview_png(edited_bytes, preview_page_index)
    stealth = audit_pdf_stealth(source_bytes, edited_bytes, modified_regions=_modified_regions(vis_result))
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'outputSha256': vis_result['outputSha256'],
        'previewPageIndex': preview_page_index,
        'appliedCount': len(vis_result.get('changes', [])),
        'stealthAudit': stealth,
        'verification': vis_result.get('verification'),
        'image': png_b64,
    }


def _export_edits(store, service, paper_id, file_hash, operations, require_clean_stealth, cancelled):
    source_bytes, edited_bytes, vis_result = _apply_operations(
        store, service, paper_id, file_hash, operations, cancelled=cancelled)
    stealth = audit_pdf_stealth(source_bytes, edited_bytes, modified_regions=_modified_regions(vis_result))
    if require_clean_stealth and stealth['status'] == 'detectable_artifact':
        raise ValueError('stealth_audit_failed')
    record = {
        'schema': 'falsify.coordinated-red-record.v1',
        'paperId': paper_id,
        'sourceSha256': file_hash,
        'outputSha256': vis_result['outputSha256'],
        'changes': vis_result.get('changes', []),
        'verification': vis_result.get('verification'),
        'operations': copy.deepcopy(operations),
    }
    return {
        'paperId': paper_id,
        'fileHash': file_hash,
        'outputSha256': vis_result['outputSha256'],
        'pdfBase64': vis_result['file'],
        'stealthAudit': stealth,
        'record': record,
    }


def _audit_candidate(store, paper_id, file_hash, candidate_b64, modified_regions):
    candidate_bytes = _decode_candidate_pdf(candidate_b64)
    source_bytes = store.source_bytes(paper_id, file_hash)
    return audit_pdf_stealth(source_bytes, candidate_bytes, modified_regions=modified_regions)


def build_server(store, paper_id, file_hash, service=None):
    """Build FastMCP coordinated RED server bound to one immutable source PDF."""
    service = service or ChartEditService(store)
    instructions = (
        'Coordinated RED editor for one selected PDF. Never mutates the input PDF on disk. '
        'Inspect targets with list_red_targets, prepare chart scenes with prepare_chart_scene, '
        'preview with preview_coordinated_edits, export blind PDFs with export_coordinated_edits, '
        'or self-audit any candidate PDF with audit_candidate_pdf.\nSelected PDF: '
        + json.dumps({'paperId': paper_id, 'fileHash': file_hash})
    )
    server = FastMCP(name=SERVER_NAME, instructions=instructions, log_level='ERROR')

    def call(pid, fn):
        result = _guard(paper_id, file_hash, pid, fn)
        return result if isinstance(result, CallToolResult) else _ok(result)

    @server.tool(annotations=_READONLY)
    def list_red_targets(paperId: str, pageIndex: int | None = None) -> CallToolResult:
        """List extracted paragraphs/text blocks, tables, and scientific figures for the startup PDF."""
        return call(paperId, lambda: _list_targets(store, paperId, file_hash, page_index=pageIndex))

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
        result = await _cancellable_thread(lambda cancelled: _guard(
            paper_id, file_hash, paperId,
            lambda: _preview_edits(store, service, paperId, file_hash, operations, previewPageIndex, cancelled),
        ))
        if isinstance(result, CallToolResult):
            return result
        image = result.pop('image')
        return _ok(result, (image, 'image/png'))

    @server.tool(annotations=_EDITING)
    async def export_coordinated_edits(paperId: str, operations: list[dict], requireCleanStealth: bool = False) -> CallToolResult:
        """Export a blind edited PDF copy + stealth audit + external record."""
        return await _cancellable_thread(lambda cancelled: call(
            paperId,
            lambda: _export_edits(store, service, paperId, file_hash, operations, requireCleanStealth, cancelled),
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
    args = parser.parse_args(argv)
    try:
        from paper_evidence import default_store
        summary = open_selected(default_store, args.pdf)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    logging.getLogger('mcp').setLevel(logging.ERROR)
    build_server(default_store, summary['paperId'], summary['fileHash']).run(transport='stdio')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

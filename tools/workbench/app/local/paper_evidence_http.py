"""Companion-only HTTP adapter for temporary, read-only paper evidence."""
import base64
import binascii
import re


ROUTES = ('/api/paper/evidence/prepare', '/api/paper/evidence/query')
MAX_PDF_BYTES = 25 * 1024 * 1024
HEX = re.compile(r'[0-9a-f]{64}\Z')

def _store(injected):
    if injected is not None: return injected
    try:
        from paper_evidence import default_store
    except ImportError:
        raise ValueError('paper_evidence_unavailable') from None
    return default_store


def prepare(data, *, store=None):
    if not isinstance(data, dict) or set(data) != {'fileHash', 'file'}:
        raise ValueError('paper_evidence_request_invalid')
    digest, encoded = data['fileHash'], data['file']
    if not isinstance(digest, str) or not HEX.fullmatch(digest):
        raise ValueError('paper_evidence_hash_invalid')
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_PDF_BYTES + 2) // 3):
        raise ValueError('paper_evidence_file_limit')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError('paper_evidence_file_invalid') from None
    if not raw or len(raw) > MAX_PDF_BYTES or not raw.startswith(b'%PDF-'):
        raise ValueError('paper_evidence_file_invalid')
    return _store(store).prepare(raw, digest)


def query(data, *, store=None):
    if not isinstance(data, dict):
        raise ValueError('paper_evidence_request_invalid')
    operation = data.get('operation')
    fields = {
        'status': set(), 'list': {'kind', 'pageIndex', 'offset', 'limit'},
        'item': {'itemId'}, 'render': {'pageIndex', 'bbox', 'dpi'}, 'analyses': set(), 'analysis': {'analysisId'},
    }
    if not isinstance(operation, str) or operation not in fields or set(data) - {'paperId', 'operation'} - fields[operation]:
        raise ValueError('paper_evidence_operation_invalid')
    paper_id = data.get('paperId')
    if not isinstance(paper_id, str) or not 1 <= len(paper_id) <= 160:
        raise ValueError('paper_evidence_id_invalid')
    store = _store(store)
    try:
        if operation == 'status': return store.status(paper_id)
        if operation == 'analyses': return store.list_analyses(paper_id)
        if operation == 'analysis': return store.read_analysis(paper_id, data.get('analysisId'))
        if operation == 'list': return store.list_items(paper_id, kind=data.get('kind'), page_index=data.get('pageIndex'), offset=data.get('offset', 0), limit=data.get('limit', 50))
        if operation == 'item': return store.read_item(paper_id, data.get('itemId'))
        return store.render_region(paper_id, data.get('pageIndex'), bbox=data.get('bbox'), dpi=data.get('dpi', 120))
    except KeyError:
        raise ValueError('paper_evidence_expired_or_missing') from None

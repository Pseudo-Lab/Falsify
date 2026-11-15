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


def _query_blue_sensor(paper_id, data, store):
    max_signals = data.get('maxSignals', 50)
    include_external = data.get('includeExternalOracle', False)
    if type(max_signals) is not int or not 1 <= max_signals <= 100:
        raise ValueError('paper_evidence_request_invalid')
    if type(include_external) is not bool:
        raise ValueError('paper_evidence_request_invalid')
    from paper_blue_sensor import run_blue_sensor
    return run_blue_sensor(paper_id, max_signals=max_signals, include_external_oracle=include_external, store=store)


def _query_supplement_audit(paper_id, data, store):
    supplements = data.get('supplements')
    if not isinstance(supplements, list) or len(supplements) > 16:
        raise ValueError('paper_evidence_request_invalid')
    from paper_evidence_text import _open_pdf, _require_bound_pdf
    from paper_supplement_audit import audit_paper_with_supplements
    _, _, _, raw = _require_bound_pdf(paper_id, store)
    with _open_pdf(raw) as doc:
        page_items = [{'id': f'p{idx}', 'pageIndex': idx, 'text': doc[idx].get_text('text') or ''}
                      for idx in range(min(doc.page_count, 80))]
    try:
        return audit_paper_with_supplements(page_items, supplements)
    except ValueError:
        raise ValueError('paper_evidence_request_invalid') from None


_QUERY_HANDLERS = {
    'status': lambda pid, _d, store: store.status(pid),
    'analyses': lambda pid, _d, store: store.list_analyses(pid),
    'analysis': lambda pid, d, store: store.read_analysis(pid, d.get('analysisId')),
    'list': lambda pid, d, store: store.list_items(
        pid, kind=d.get('kind'), page_index=d.get('pageIndex'), offset=d.get('offset', 0), limit=d.get('limit', 50)),
    'item': lambda pid, d, store: store.read_item(pid, d.get('itemId')),
    'blue_sensor': _query_blue_sensor,
    'supplement_audit': _query_supplement_audit,
    'render': lambda pid, d, store: store.render_region(pid, d.get('pageIndex'), bbox=d.get('bbox'), dpi=d.get('dpi', 120)),
}


def query(data, *, store=None):
    if not isinstance(data, dict):
        raise ValueError('paper_evidence_request_invalid')
    operation = data.get('operation')
    fields = {
        'status': set(), 'list': {'kind', 'pageIndex', 'offset', 'limit'},
        'item': {'itemId'}, 'render': {'pageIndex', 'bbox', 'dpi'}, 'analyses': set(), 'analysis': {'analysisId'},
        'blue_sensor': {'maxSignals', 'includeExternalOracle'},
        'supplement_audit': {'supplements'},
    }
    if not isinstance(operation, str) or operation not in fields or set(data) - {'paperId', 'operation'} - fields[operation]:
        raise ValueError('paper_evidence_operation_invalid')
    paper_id = data.get('paperId')
    if not isinstance(paper_id, str) or not 1 <= len(paper_id) <= 160:
        raise ValueError('paper_evidence_id_invalid')
    store = _store(store)
    try:
        return _QUERY_HANDLERS[operation](paper_id, data, store)
    except KeyError:
        raise ValueError('paper_evidence_expired_or_missing') from None

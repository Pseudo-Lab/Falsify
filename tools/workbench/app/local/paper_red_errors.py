"""Unified self-healing error contract shared by every RED mutation surface.

Every failed mutation returns the same MCP payload shape:

    {"error": "<fixed_code>",
     "actualValue": <echo of the rejected value when known> | null,
     "nearestCandidates": [ {...}, ... ],
     "bbox": [x0, y0, x1, y1] | null,
     "recoveryHint": "<one actionable sentence>"}

Contract rules agents can rely on:

* ``error`` is a fixed snake_case code, never a formatted message.
* ``actualValue`` echoes the rejected value when the parent could recover it
  (a rejected cell text, a rejected ``beforeUri``, a rejected taxonomy value).
* ``nearestCandidates`` is always a list. Entries are plain data describing
  assets the caller may retry with: table cells carry ``row``/``column``/
  ``text``/``bbox``, chart shapes carry ``seriesId``/``pointIndex``/``center``,
  URI edits carry ``linkId``/``pageIndex``/``bbox``/``uri``/``visibleText``,
  text-span and supplement edits carry ``spanId``/``text`` style records.
* ``bbox`` is the rejected or nearest page rectangle, or ``None``.
* ``recoveryHint`` is one sentence naming the next action, never a path.
* Extra diagnostic keys (``pageIndex``, ``matchCount``, ``seriesId``, ...) may
  sit next to these five keys; the five contract keys are always present.

Candidates and hints never carry filesystem paths, working directories or the
bound source bytes: :func:`sanitize_details` drops path-shaped keys and the
builders below only copy store-recorded geometry.

Codes are grouped by surface so the parent process can enrich them:

* ``visual_*`` -- table-cell / region edits
* ``chart_*`` -- chart-shape (scene) edits
* ``uri_*`` -- embedded ``/URI`` link edits
* ``text_span_*`` / ``supplement_*`` -- PDF text spans and supplements
* ``red_taxonomy_invalid`` / ``visual_operation_invalid`` -- request taxonomy

Taxonomy codes get no candidates; their hint enumerates the valid vocabulary.
"""
import re

DEFAULT_RECOVERY_HINT = (
    'Inspect the rejected value and retry with an exact value listed in nearestCandidates.'
)
VALID_WORLDS = ('W1', 'W2', 'W3', 'W4', 'W5')
VALID_DIFFICULTIES = ('L1', 'L2', 'L3', 'L4')
VALID_FAMILIES = ('D1', 'D2', 'D3', 'D4', 'D4-1', 'D5', 'D6', 'D7', 'S1')
VALID_KINDS = (
    'table-cell',
    'chart-shape',
    'chart-redraw',
    'region-replace',
    'region',
    'uri-link',
    'text-span',
    'supplement-edit',
)
# Keys that would leak host layout if they reached a blind-agent payload.
_BLOCKED_KEYS = frozenset({
    'path', 'paths', 'filepath', 'file_path', 'cwd', 'dir', 'dirs', 'directory',
    'root', 'home', 'base_dir', 'workdir', 'tmpdir', 'source_path',
})
_BLOCKED_SUFFIXES = ('_path', '_dir', '_cwd', '_root')
_CODE_RE = re.compile(r'[a-z0-9_]{1,80}\Z')


def _safe_key(key):
    """True when a detail key cannot describe a host path."""
    low = str(key).lower()
    return low not in _BLOCKED_KEYS and not low.endswith(_BLOCKED_SUFFIXES)


def sanitize_details(details):
    """Drop path/cwd/dir keys so blind payloads carry no host layout."""
    if not isinstance(details, dict):
        return {}
    return {key: value for key, value in details.items() if _safe_key(key)}


def is_fixed_code(exc):
    """True when a ValueError carries a fixed snake_case contract code."""
    if not isinstance(exc, ValueError) or not exc.args:
        return False
    code = exc.args[0]
    return type(code) is str and _CODE_RE.fullmatch(code) is not None


def code_of(exc):
    """Return the fixed code of a contract exception, or an empty string."""
    return exc.args[0] if is_fixed_code(exc) else ''


def taxonomy_hint():
    """Enumerate the valid RED request vocabulary for a taxonomy rejection."""
    return (
        'Provide world in ' + ', '.join(VALID_WORLDS)
        + '; difficulty in ' + ', '.join(VALID_DIFFICULTIES)
        + '; family in ' + ', '.join(VALID_FAMILIES)
        + '; kind in ' + ', '.join(VALID_KINDS) + '.'
    )


def build_error_payload(
    code,
    *,
    actual_value=None,
    nearest_candidates=None,
    bbox=None,
    recovery_hint=None,
    extra=None,
):
    """Build the five-key self-healing payload, keeping sanitized extras."""
    payload = sanitize_details(extra)
    payload['error'] = code
    payload.setdefault('actualValue', actual_value)
    payload.setdefault('nearestCandidates', list(nearest_candidates or []))
    payload.setdefault('bbox', bbox)
    payload.setdefault('recoveryHint', recovery_hint or DEFAULT_RECOVERY_HINT)
    return payload


def normalize_payload(payload):
    """Guarantee the contract keys on any already-built error payload."""
    data = sanitize_details(payload if isinstance(payload, dict) else {})
    code = data.get('error')
    if not isinstance(code, str) or not code:
        code = 'paper_evidence_failed'
    candidates = data.get('nearestCandidates')
    hint = data.get('recoveryHint')
    data['error'] = code
    data['actualValue'] = data.get('actualValue')
    data['nearestCandidates'] = candidates if isinstance(candidates, list) else []
    data['bbox'] = data.get('bbox')
    data['recoveryHint'] = hint if isinstance(hint, str) and hint else DEFAULT_RECOVERY_HINT
    return data


def error_surface(code):
    """Classify a fixed code into the surface whose candidates can repair it."""
    if code in ('red_taxonomy_invalid', 'visual_operation_invalid'):
        return 'taxonomy'
    if code.startswith('visual_'):
        return 'table'
    if code.startswith('chart_'):
        return 'chart'
    if code.startswith('uri_'):
        return 'uri'
    if code.startswith('text_span_'):
        return 'text'
    if code.startswith('supplement_'):
        return 'supplement'
    return 'none'


class RedMutationError(ValueError):
    """Self-healing mutation error matching the shared RED contract.

    ``.code`` is the fixed contract code and ``.details`` is the payload the MCP
    layer serializes, so callers can rely on ``error``/``actualValue``/
    ``nearestCandidates``/``bbox``/``recoveryHint`` always being present.
    """

    def __init__(self, code, details=None):
        super().__init__(code)
        self.code = code
        self.details = build_error_payload(code, extra=details or {})

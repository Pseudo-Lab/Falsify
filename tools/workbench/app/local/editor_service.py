"""Startup-configured adapter from /api/export to the patched falsify-pdf-editor (Node 24+ WASM).

Paths, the Node executable and the candidate manifest come only from server startup
(--pdf-editor-* options or FALSIFY_PDF_EDITOR_* environment); nothing in an HTTP request
selects them. When configured, export never falls back to the legacy single-line PyMuPDF
path. A strict export reports an editor failure as an error and produces no file.
An explicit boolean draft=true on the export body asks the web bridge to keep a
readable PDF when the saved-file self-check failed. That file is returned with the
check still failed. Nothing rewrites the report to passed, and there is still no
legacy, white-overlay, or raster fallback.
"""
import base64
import hashlib
import inspect
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import paper_inventory
import pdf_quality

ENGINE = 'falsify-pdf-editor'
REQUEST_SCHEMA = 'falsify-web-bridge-request/1'
ENV_ROOT, ENV_MANIFEST = 'FALSIFY_PDF_EDITOR_ROOT', 'FALSIFY_PDF_EDITOR_MANIFEST'
ENV_SOURCE_ROOT, ENV_NODE = 'FALSIFY_PDF_EDITOR_SOURCE_ROOT', 'FALSIFY_PDF_EDITOR_NODE'
MANIFEST_NAME = 'candidate-manifest.json'
MIN_NODE_MAJOR = 24
LIMITS = {'maxFileBytes': 25 * 1024 * 1024, 'maxEdits': 12, 'maxTextChars': 4000, 'maxOutputBytes': 64 * 1024 * 1024,
    'maxReportBytes': 2 * 1024 * 1024, 'maxStdoutBytes': 64 * 1024, 'timeoutSeconds': 180, 'probeTimeoutSeconds': 60}
CHECK_BOUNDARY = ('Same-engine self-check (same PDFium build re-reads the saved file) plus a separate bounded MuPDF '
    'independent QA of this output; neither is full scientific, typographic or human verification. '
    'Pagination is not claimed unless the editor reports it.')
LABEL = re.compile(r'PDF p\. ([1-9][0-9]{0,3})')
HEX64 = re.compile(r'[0-9a-f]{64}')
CODE = re.compile(r'[A-Z][A-Z0-9_]{0,63}')
# Continuation header/footer policy the UI knows how to describe. The scope text is fixed here,
# never echoed from the engine, so no document text or filesystem path can reach the page.
CONTINUATION_POLICY = 'source-number-suffix'
CONTINUATION_SCOPE = ('text-only source-style header/footer; standalone Arabic source number plus decimal suffix; '
    'originals unchanged')
MAX_COPIED_PAGES = 32
EXPORT_KEYS = {'format', 'fileHash', 'file', 'patches', 'draft'}
# Fields the current frontend sends per patch; only label/before/after reach the editor.
PATCH_KEYS = {'label', 'before', 'after', 'id', 'segmentId', 'offset', 'edited'}
# Minimal inherited environment: no NODE_OPTIONS, credentials or inherited editor overrides.
ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'LC_ALL']
PROBE_MESSAGES = {
    'module_missing': 'PDF 편집기 모듈(src/web-bridge.mjs)을 찾을 수 없습니다. --pdf-editor-root 설정을 확인하세요.',
    'manifest_missing': 'PDF 편집기 후보 매니페스트를 찾을 수 없습니다. --pdf-editor-manifest 설정을 확인하세요.',
    'node_missing': f'Node.js {MIN_NODE_MAJOR}+ 실행 파일을 찾을 수 없습니다. 설치 후 다시 확인하세요.',
    'node_too_old': f'Node.js {MIN_NODE_MAJOR}+가 필요합니다.',
    'probe_timeout': 'PDF 편집기 확인 시간이 초과되었습니다.',
    'probe_failed': 'PDF 편집기 런타임을 불러오지 못했습니다(WASM/매니페스트/고정 소스 확인 필요).',
}
NO_FALLBACK = '원본은 바뀌지 않았고, 이전 단일 줄 편집 방식으로 대신 내보내지 않습니다.'
QA_FAILED = ('독립 PDF 품질 검사(MuPDF)가 출력 결함을 확인했습니다: {checks}. 편집하지 않은 페이지가 바뀌었거나 선택한 After/원문 '
    '텍스트가 출력에서 확인되지 않습니다. 안전한 자동 복구 방법이 없어 파일을 내보내지 않습니다. 선택한 변경 수를 줄이거나 '
    '다른 After 문구로 다시 시도하세요.')
# Refusal reasons the UI may show: known lowercase codes of the editor's saved-file self-check failures and
# error-severity repair warnings, each with a fixed Korean label. Any other code, and every free-form report
# field, is dropped; only the known code and a validated page number accompany the label.
REFUSAL_REASONS = {
    'edited_page_text_or_order_mismatch': '편집한 페이지의 텍스트/순서가 기대와 다름',
    'edited_flow_text_or_order_mismatch': '편집한 문단 흐름의 텍스트/순서가 기대와 다름',
    'unedited_page_text_changed': '편집하지 않은 페이지의 텍스트가 바뀜',
    'after_missing': 'After 문구가 출력에서 확인되지 않음',
    'expected_text_uncomputable': '기대 텍스트를 계산할 수 없음',
    'header_footer_moved': '머리글/바닥글이 움직임',
    'edge_band_body_changed': '머리글/바닥글 가장자리 영역의 본문이 바뀜',
    'glyphs_off_page': '글자가 페이지 밖으로 나감',
    'glyph_overlap_increased': '글자 겹침이 늘어남',
    'text_outside_source_columns': '텍스트가 원래 단 밖으로 나감',
    'page_count_changed': '페이지 수가 바뀜',
    'page_count_mismatch': '페이지 수가 예상과 다름',
    'page_map_invalid': '원본-출력 페이지 대응이 올바르지 않음',
    'edit_page_out_of_range': '편집 페이지가 문서 범위를 벗어남',
    'inspection_error': '자기 점검을 실행하지 못함',
    'continuation_without_edit': '편집 없는 페이지에 이어짐 페이지가 생김',
    'continuation_page_empty': '이어짐 페이지가 비어 있음',
    'continuation_line_count_mismatch': '이어짐 페이지 줄 수가 계획과 다름',
    'continuation_outside_body_band': '이어짐 텍스트가 본문 영역 밖에 있음',
    'continuation_page_size_mismatch': '이어짐 페이지 크기가 원본과 다름',
    'continuation_edge_missing': '이어짐 페이지 머리글/바닥글이 빠짐',
    'continuation_edge_extra': '이어짐 페이지 머리글/바닥글에 추가 내용이 있음',
    'continuation_edge_style_mismatch': '이어짐 페이지 머리글/바닥글 서식이 다름',
    'continuation_edge_style_unverifiable': '이어짐 페이지 머리글/바닥글 서식을 확인할 수 없음',
    'continuation_page_number_ambiguous': '이어짐 페이지 번호가 모호함',
    'continuation_page_number_mismatch': '이어짐 페이지 번호가 기대와 다름',
    'continuation_page_number_moved': '이어짐 페이지 번호 위치가 바뀜',
    'continuation_style_invalid': '이어짐 머리글/바닥글 양식이 올바르지 않음',
    'pagination_unsupported': '넘친 본문을 다음 페이지로 넘길 수 없음',
    'pagination_unsupported_foreign_object_in_flow': '넘치는 본문 흐름에 텍스트가 아닌 개체가 있어 페이지 넘김 미지원',
    'pagination_unsupported_multi_column_flow': '여러 단에 걸친 흐름은 페이지 넘김 미지원',
    'pagination_unsupported_edge_paragraph_in_flow': '본문 흐름 안의 머리글/바닥글 문단 때문에 페이지 넘김 미지원',
    'pagination_unsupported_shared_objects': '개체를 공유하는 문단은 페이지 넘김 미지원',
    'pagination_unsupported_non_top_level_text': '중첩된 텍스트 개체는 페이지 넘김 미지원',
    'pagination_unsupported_type3_segments': 'Type3 글꼴 구간은 페이지 넘김 미지원',
    'pagination_unsupported_rotated_page': '회전된 페이지는 페이지 넘김 미지원',
    'pagination_unsupported_cropped_or_offset_page': '잘리거나 원점이 이동된 페이지는 페이지 넘김 미지원',
    'pagination_budget_exceeded': '허용된 새 페이지 수를 넘음',
    'pagination_apply_failed': '페이지 넘김을 적용하지 못함',
    'pagination_body_band_invalid': '본문 영역을 확정할 수 없어 페이지 넘김 불가',
    'pagination_flow_not_monotonic': '본문 줄 순서가 위에서 아래로 이어지지 않음',
    'pagination_line_exceeds_body': '한 줄이 본문 영역보다 큼',
    'reading_order_not_exact': '읽기 순서를 원본과 똑같이 맞출 수 없음',
    'nontext_order_changed': '텍스트가 아닌 개체의 순서가 바뀜',
    'context_mismatch': '선택한 Before 주변 문맥이 페이지와 맞지 않음',
    'paragraph_objects_unavailable': '문단의 PDF 개체를 확인할 수 없음',
    'resize_failed': '문단 크기 조정에 실패함',
    'move_failed': '문단 이동에 실패함',
    'reorder_remove_failed': '읽기 순서 조정(제거)에 실패함',
    'reorder_insert_failed': '읽기 순서 조정(삽입)에 실패함',
}
MAX_REASONS, MAX_REASON_PAGES, MAX_REASON_SCAN = 6, 3, 256

@dataclass(frozen=True)
class EditorConfig:
    root: Path
    manifest: Path
    source_root: Path | None = None
    node: str | None = None

def _absolute(value, name):
    if not isinstance(value, str) or not value or '\x00' in value or not Path(value).is_absolute():
        raise ValueError(f'{name} must be an absolute path')
    return Path(os.path.realpath(value))

def config_from(root=None, manifest=None, source_root=None, node=None, environ=None):
    """Startup configuration, else None for the legacy (unconfigured) companion. Raises ValueError."""
    environ = os.environ if environ is None else environ
    root = root or environ.get(ENV_ROOT) or None
    manifest = manifest or environ.get(ENV_MANIFEST) or None
    source_root = source_root or environ.get(ENV_SOURCE_ROOT) or None
    node = node or environ.get(ENV_NODE) or None
    if root is None and manifest is None:
        if source_root or node: raise ValueError('--pdf-editor-source-root/--pdf-editor-node require --pdf-editor-root and --pdf-editor-manifest')
        return None
    if root is None or manifest is None: raise ValueError('--pdf-editor-root and --pdf-editor-manifest must be configured together')
    config = EditorConfig(_absolute(root, 'pdf editor root'), _absolute(manifest, 'pdf editor manifest'),
        _absolute(source_root, 'pdf editor source root') if source_root else None, str(_absolute(node, 'node executable')) if node else None)
    if config.manifest.name != MANIFEST_NAME: raise ValueError(f'pdf editor manifest must be named {MANIFEST_NAME}')
    return config

def _accepts_edit_plan(fn):
    """True when the QA entry takes a keyword edit_plan; an older inspect_isolated keeps its five-argument call."""
    try: param = inspect.signature(fn).parameters.get('edit_plan')
    except (TypeError, ValueError): return False
    return param is not None and param.kind in (param.KEYWORD_ONLY, param.POSITIONAL_OR_KEYWORD)

def unconfigured_capability():
    return {'available': False, 'configured': False, 'engine': ENGINE, 'version': None, 'wasmSha256': None,
        'reflow': False, 'pagination': False, 'continuationStyle': None, 'draft': False, 'limits': None, 'sourceUrl': None}

def default_runner(argv, *, cwd, env, timeout):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    return subprocess.run(argv, cwd=cwd, env=env, timeout=timeout, shell=False, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, creationflags=flags)

def _single_json(raw):
    if len(raw) > LIMITS['maxStdoutBytes']: raise ValueError('stdout oversize')
    lines = [line for line in raw.decode('utf-8', 'strict').splitlines() if line.strip()]
    if len(lines) != 1: raise ValueError('expected one JSON line')
    value = json.loads(lines[0])
    if not isinstance(value, dict): raise ValueError('expected JSON object')
    return value

def _hex(value): return value if isinstance(value, str) and HEX64.fullmatch(value) else None
def _count(value): return value if type(value) is int and value >= 0 else None

def _refusal_reasons(report):
    """' 진단: label[code] (p. N); ….' for known codes among the refused report's self-check failures and error-severity
    repair warnings, deduplicated per code and bounded; '' when none is known. Never echoes report text."""
    report = report if isinstance(report, dict) else {}
    self_check = report.get('selfCheck') if isinstance(report.get('selfCheck'), dict) else {}
    listed = lambda value: value[:MAX_REASON_SCAN] if isinstance(value, list) else []
    items = listed(self_check.get('failures')) + [w for w in listed(report.get('warnings')) if isinstance(w, dict) and w.get('severity') == 'error']
    pages = {}
    for item in items:
        code = item.get('code') if isinstance(item, dict) else None
        if not isinstance(code, str) or code not in REFUSAL_REASONS or (code not in pages and len(pages) == MAX_REASONS): continue
        found, page = pages.setdefault(code, []), item.get('pageIndex')
        if type(page) is int and 0 <= page < 10000 and page + 1 not in found and len(found) < MAX_REASON_PAGES: found.append(page + 1)
    reasons = [f'{REFUSAL_REASONS[c]}[{c}]' + (f" (p. {', '.join(map(str, p))})" if p else '') for c, p in pages.items()]
    return f" 진단: {'; '.join(reasons)}." if reasons else ''

def _continuation_capability(value, pagination):
    """Engine-declared continuation style, only with pagination and the exact known policy; else None.
    Never inferred from pagination alone."""
    if not pagination or not isinstance(value, dict) or value.get('supported') is not True or value.get('policy') != CONTINUATION_POLICY:
        return None
    return {'supported': True, 'policy': CONTINUATION_POLICY, 'scope': CONTINUATION_SCOPE}

def _continuation_report(value, cap, layout_verified, added_pages, grown):
    """Per-output continuation style: declared capability, verified layout, and copiedPages (1..32) equal to both the
    reported addedPages and the counted page growth. Unknown or mismatched counts make no claim (no partial success)."""
    if not cap.get('continuationStyle') or layout_verified is not True or not isinstance(value, dict) \
            or value.get('policy') != CONTINUATION_POLICY or value.get('applied') is not True:
        return None
    copied = _count(value.get('copiedPages'))
    if copied is None or not 0 < copied <= MAX_COPIED_PAGES or copied != added_pages or copied != grown: return None
    return {'policy': CONTINUATION_POLICY, 'applied': True, 'copiedPages': copied}

def _preserves_draft(status, report, out):
    """True when the bridge explicitly kept a readable PDF after a failed self-check.
    A report that claims the check passed is not a draft and is not rewritten."""
    if not isinstance(status, dict) or status.get('ok') is True or status.get('draft') is not True: return False
    if not isinstance(report, dict) or report.get('ok') is True or report.get('draft') is not True: return False
    if report.get('status') == 'self-check-passed' or report.get('layoutVerified') is True: return False
    self_check = report.get('selfCheck') if isinstance(report.get('selfCheck'), dict) else None
    if self_check is None or self_check.get('status') not in ('failed', 'error') or self_check.get('ok') is True: return False
    try:
        if not out.is_file() or out.stat().st_size < 5: return False
        with open(out, 'rb') as handle: signature = handle.read(5)
    except OSError: return False
    return signature == b'%PDF-'

def _draft_edit_rows(edits, report):
    """Machine edit statuses. After text the self-check did not find is not labeled applied."""
    reported = {}
    for row in report.get('edits') if isinstance(report.get('edits'), list) else []:
        if isinstance(row, dict) and isinstance(row.get('id'), str): reported.setdefault(row['id'], row)
    failures = report.get('selfCheck', {}).get('failures') if isinstance(report.get('selfCheck'), dict) else []
    missing = [item for item in failures if isinstance(item, dict) and item.get('code') == 'after_missing'] if isinstance(failures, list) else []
    ids = {item.get('id') for item in missing if isinstance(item.get('id'), str)}
    pages = {item.get('pageIndex') for item in missing if item.get('id') is None and type(item.get('pageIndex')) is int}
    unlabeled = any(item.get('id') is None and item.get('pageIndex') is None for item in missing)
    rows = []
    for edit in edits:
        row = reported.get(edit['id'], {})
        status = row.get('status')
        if not isinstance(status, str) or not re.fullmatch(r'[a-z][a-z-]{0,40}', status): status = 'unknown'
        if unlabeled or edit['id'] in ids or edit['pageIndex'] in pages:
            if status in ('applied', 'noop'): status = 'after-missing'
        if status in ('passed', 'success', 'self-check-passed'): status = 'unknown'
        rows.append({'label': edit['label'], 'id': edit['id'], 'pageIndex': edit['pageIndex'], 'status': status})
    return rows

def _page_map(value):
    """Bridge-sanitized sourcePageMap: [{sourcePageIndex, outputPageIndex, continuationPageIndices}]; else None."""
    if not isinstance(value, list) or not 1 <= len(value) <= 10000: return None
    def entry(v):
        if not isinstance(v, dict) or _count(v.get('sourcePageIndex')) is None or _count(v.get('outputPageIndex')) is None: return False
        cont = v.get('continuationPageIndices', [])
        if not isinstance(cont, list) or len(cont) > 64 or any(_count(x) is None for x in cont): return False
        return {'sourcePageIndex': v['sourcePageIndex'], 'outputPageIndex': v['outputPageIndex'], 'continuationPageIndices': list(cont)}
    out = [entry(v) for v in value]
    return None if any(v is False for v in out) else out

def validate_export(data):
    """Same wire format and scope checks as the legacy export, plus strict field and label parsing."""
    if data.get('format') != 'PDF': raise ValueError('DOCX/ODT/HTML은 원래 앱의 렌더러 검증 경로가 아직 없습니다. 레이아웃 보존을 확인할 수 없어 완성본 다운로드를 차단합니다. 변경 계획 JSON은 저장할 수 있습니다.')
    if set(data) - EXPORT_KEYS: raise ValueError('알 수 없는 내보내기 필드입니다.')
    if not isinstance(data.get('file'), str) or not isinstance(data.get('fileHash'), str) or not HEX64.fullmatch(data['fileHash']):
        raise ValueError('원본 파일 데이터가 올바르지 않습니다.')
    if len(data['file']) > (LIMITS['maxFileBytes'] * 4) // 3 + 4: raise ValueError('PDF 크기 제한 초과')
    try: raw = base64.b64decode(data['file'], validate=True)
    except Exception: raise ValueError('원본 파일 데이터가 올바르지 않습니다.') from None
    if hashlib.sha256(raw).hexdigest() != data['fileHash']: raise ValueError('원본 파일 해시가 일치하지 않습니다.')
    if not raw.startswith(b'%PDF-') or len(raw) > LIMITS['maxFileBytes']: raise ValueError('PDF 크기/서명 오류')
    patches = data.get('patches')
    if not isinstance(patches, list) or not 1 <= len(patches) <= LIMITS['maxEdits']: raise ValueError('선택한 변경이 필요합니다.')
    edits = []
    for index, p in enumerate(patches):
        if not isinstance(p, dict) or set(p) - PATCH_KEYS or not all(isinstance(p.get(k), str) for k in ['label', 'before', 'after']): raise ValueError('변경 형식 오류')
        if any(k in p and not isinstance(p[k], str) for k in ['id', 'segmentId']) or ('offset' in p and (type(p['offset']) is not int or p['offset'] < 0)) \
                or ('edited' in p and not isinstance(p['edited'], bool)): raise ValueError('변경 형식 오류')
        if not p['before'].strip() or not p['after'].strip() or max(len(p['before']), len(p['after'])) > LIMITS['maxTextChars'] or p['before'] == p['after']: raise ValueError('변경 내용 오류')
        for pattern in [r'\d+(?:[.,]\d+)*', r'\[[^\]\n]*\]|https?://\S+']:
            if re.findall(pattern, p['before']) != re.findall(pattern, p['after']): raise ValueError('수치/인용 변경은 범위 밖입니다.')
        match = LABEL.fullmatch(p['label'])
        if not match: raise ValueError('PDF 원본 페이지 위치가 필요합니다.')
        # Exact Before/After as selected: no rewriting, trimming or auto-selection.
        edits.append({'id': f'edit-{index + 1}', 'pageIndex': int(match[1]) - 1, 'before': p['before'], 'after': p['after'], 'label': p['label']})
    if 'draft' in data and type(data['draft']) is not bool: raise ValueError('변경 형식 오류')
    return raw, edits, data.get('draft') is True

class PdfEditorService:
    def __init__(self, config, runner=None, clock=time.monotonic, retry_seconds=15, quality=None, planner=None):
        self.config, self.runner, self.clock, self.retry_seconds = config, runner or default_runner, clock, retry_seconds
        # Independent per-output QA always runs in production; tests inject a stub explicitly (never keyed to the runner).
        self.quality = quality or pdf_quality.inspect_isolated
        # Only the default production QA receives the private source-derived edit plan (keyword edit_plan, when it
        # accepts one); an explicitly injected checker keeps the legacy five-positional-argument call unchanged.
        self._qa_takes_plan = quality is None and _accepts_edit_plan(self.quality)
        # Source-only edit plan, built in an isolated child before the editor runs; failure degrades to 'unavailable'.
        self.planner = planner or paper_inventory.plan_isolated
        self._lock = threading.Lock()
        self._cap, self._cap_at, self._node = None, None, None
        self.leftovers = []

    @property
    def bridge(self): return self.config.root / 'src' / 'web-bridge.mjs'

    def env(self):
        env = {k: os.environ[k] for k in ENV_ALLOW if k in os.environ}
        env['FALSIFY_EDITOR_CANDIDATE_MANIFEST'] = str(self.config.manifest)
        if self.config.source_root: env['FALSIFY_EDITOR_SOURCE_ROOT'] = str(self.config.source_root)
        return env

    def _unavailable(self, code):
        return {**unconfigured_capability(), 'configured': True, 'limits': dict(LIMITS), 'error': {'code': code, 'message': PROBE_MESSAGES[code]}}

    def _probe(self):
        bridge = self.bridge
        if not self.config.root.is_dir() or not bridge.is_file() or not Path(os.path.realpath(bridge)).is_relative_to(self.config.root): return self._unavailable('module_missing'), None
        if not self.config.manifest.is_file(): return self._unavailable('manifest_missing'), None
        node = self.config.node or shutil.which('node')
        if not node or not Path(node).is_file(): return self._unavailable('node_missing'), None
        try:
            version = self.runner([node, '--version'], cwd=str(self.config.root), env=self.env(), timeout=10)
            match = re.fullmatch(rb'v(\d+)\.\d+\.\d+\s*', version.stdout or b'')
            if version.returncode != 0 or not match: return self._unavailable('node_missing'), None
            if int(match[1]) < MIN_NODE_MAJOR: return self._unavailable('node_too_old'), None
            result = self.runner([node, str(bridge), '--capabilities'], cwd=str(self.config.root), env=self.env(), timeout=LIMITS['probeTimeoutSeconds'])
        except subprocess.TimeoutExpired: return self._unavailable('probe_timeout'), None
        except OSError: return self._unavailable('node_missing'), None
        try: info = _single_json(result.stdout or b'')
        except (ValueError, UnicodeDecodeError): return self._unavailable('probe_failed'), None
        if result.returncode != 0 or info.get('ok') is not True or info.get('engine') != ENGINE or not _hex(info.get('wasmSha256')):
            return self._unavailable('probe_failed'), None
        runtime = info.get('runtime') if isinstance(info.get('runtime'), dict) else {}
        source_url = info.get('sourceUrl') if isinstance(info.get('sourceUrl'), str) and re.fullmatch(r'https://[^\s]{1,300}', info['sourceUrl']) else None
        pagination = info.get('pagination') is True
        cap = {'available': True, 'configured': True, 'engine': ENGINE, 'version': str(info.get('version'))[:40],
            'wasmSha256': info['wasmSha256'], 'reflow': info.get('reflow') is True, 'pagination': pagination,
            'continuationStyle': _continuation_capability(info.get('continuationStyle'), pagination),
            'limits': dict(LIMITS), 'sourceUrl': source_url, 'draft': info.get('draft') is True,
            'runtime': {'jsSha256': _hex(runtime.get('jsSha256')), 'manifestSha256': _hex(runtime.get('manifestSha256')),
                'runtimeKind': runtime.get('runtimeKind') if runtime.get('runtimeKind') in ['candidate', 'pinned'] else None,
                'build': str(runtime.get('build'))[:80] if runtime.get('build') is not None else None}}
        return cap, node

    def capability(self, refresh=False):
        """Truthful probe: loads the verified runtime and instantiates WASM; opens no PDF and starts no agent."""
        with self._lock:
            now = self.clock()
            if not refresh and self._cap is not None and (self._cap['available'] or now - self._cap_at < self.retry_seconds):
                return json.loads(json.dumps(self._cap))
            self._cap, self._node = self._probe()
            self._cap_at = now
            return json.loads(json.dumps(self._cap))

    def _invalidate(self):
        with self._lock: self._cap = None

    def _cleanup(self, directory, names):
        for name in names:
            try: (directory / name).unlink(missing_ok=True)
            except OSError: pass
        try: directory.rmdir()
        except OSError: self.leftovers.append(str(directory))

    def export(self, data):
        raw, edits, draft_mode = validate_export(data)
        cap = self.capability()
        if not cap['available']:
            raise ValueError(f"PDF 편집기를 사용할 수 없습니다 ({cap['error']['code']}): {cap['error']['message']} {NO_FALLBACK}")
        node = self._node
        directory = Path(tempfile.mkdtemp(prefix='falsify-editor-'))
        names = {'source': 'source.pdf', 'request': 'request.json', 'out': 'output.pdf', 'report': 'report.json'}
        paths = {k: directory / v for k, v in names.items()}
        try:
            with open(paths['source'], 'xb') as f: f.write(raw)
            plan = self._edit_plan(paths['source'], data['fileHash'], edits)
            request = {'schema': REQUEST_SCHEMA, 'input': names['source'], 'inputSha256': data['fileHash'], 'reflow': cap['reflow'],
                'edits': [{k: e[k] for k in ['id', 'pageIndex', 'before', 'after']} for e in edits]}
            if draft_mode: request['draft'] = True
            with open(paths['request'], 'x', encoding='utf-8') as f: json.dump(request, f, ensure_ascii=False)
            argv = [node, str(self.bridge), '--request', str(paths['request']), '--out', str(paths['out']), '--report', str(paths['report'])]
            try: result = self.runner(argv, cwd=str(directory), env=self.env(), timeout=LIMITS['timeoutSeconds'])
            except subprocess.TimeoutExpired:
                raise ValueError(f"PDF 편집기 시간 초과({LIMITS['timeoutSeconds']}초). {NO_FALLBACK}") from None
            except OSError:
                self._invalidate()
                raise ValueError(f"{PROBE_MESSAGES['node_missing']} {NO_FALLBACK}") from None
            if hashlib.sha256(paths['source'].read_bytes()).hexdigest() != data['fileHash']: raise ValueError(f'편집기 입력 파일이 바뀌었습니다. {NO_FALLBACK}')
            report = self._read_report(paths['report'])
            try: status = _single_json(result.stdout or b'')
            except (ValueError, UnicodeDecodeError): raise ValueError(f'PDF 편집기 응답 형식 오류. {NO_FALLBACK}') from None
            if result.returncode != 0 or status.get('ok') is not True:
                if draft_mode and _preserves_draft(status, report, paths['out']):
                    return self._result(data, edits, cap, report, paths['out'], paths['source'], plan, draft=True)
                error = (report or {}).get('error') if isinstance((report or {}).get('error'), dict) else {}
                code = next((c for c in [error.get('code'), status.get('code')] if isinstance(c, str) and CODE.fullmatch(c)), 'EDITOR_FAILED')
                raise ValueError(f'PDF 편집기가 변경을 적용하지 못했습니다 ({code}).{_refusal_reasons(report)} {NO_FALLBACK}')
            return self._result(data, edits, cap, report, paths['out'], paths['source'], plan)
        finally: self._cleanup(directory, names.values())

    def _edit_plan(self, source, source_hash, edits):
        """Private plan read from the immutable source and the exact selected Before/After, revalidated against both.
        Never blocks the export: any planner failure or malformed plan becomes the unavailable plan."""
        try: plan = paper_inventory.validate_plan(self.planner(source, source_hash, edits), source_hash, edits)
        except Exception: plan = None
        try: return plan or paper_inventory.unavailable_plan(source_hash, edits)
        except ValueError: return None  # selection outside the planner's bounds: no plan, summary 'unavailable'

    def _read_report(self, path):
        if not path.is_file(): return None
        if path.stat().st_size > LIMITS['maxReportBytes']: raise ValueError(f'PDF 편집기 보고서 크기 제한 초과. {NO_FALLBACK}')
        try: report = json.loads(path.read_text(encoding='utf-8'))
        except (ValueError, UnicodeDecodeError): raise ValueError(f'PDF 편집기 보고서 형식 오류. {NO_FALLBACK}') from None
        return report if isinstance(report, dict) else None

    def _independent(self, source, out, edits, page_map, page_count, plan=None):
        """Sanitized independent QA report; any error running it is 'unavailable' (non-gating, never 'passed')."""
        args = (source, out, [{k: e[k] for k in ['pageIndex', 'before', 'after']} for e in edits], page_map, page_count)
        try: return pdf_quality.sanitize(self.quality(*args, edit_plan=plan) if self._qa_takes_plan else self.quality(*args))
        except Exception: return pdf_quality.unavailable()

    def _result(self, data, edits, cap, report, out, source, plan=None, draft=False):
        fail = lambda what: ValueError(f'PDF 편집기 결과 검증 실패: {what}. {NO_FALLBACK}')
        if report is None: raise fail('보고서 없음')
        if not out.is_file(): raise fail('출력 없음')
        if out.stat().st_size > LIMITS['maxOutputBytes']: raise fail('출력 크기 제한 초과')
        output = out.read_bytes()
        output_hash = hashlib.sha256(output).hexdigest()
        if not output.startswith(b'%PDF-'): raise fail('출력 PDF 서명')
        if draft:
            self_check = report.get('selfCheck') if isinstance(report.get('selfCheck'), dict) else None
            if report.get('ok') is True or report.get('draft') is not True or report.get('status') == 'self-check-passed' or report.get('layoutVerified') is True:
                raise fail('초안 보고가 성공으로 표시됨')
            if self_check is None or self_check.get('status') not in ('failed', 'error') or self_check.get('ok') is True: raise fail('초안 자기 점검 상태가 아님')
            if report.get('inputSha256') != data['fileHash']: raise fail('원본 해시 바인딩 불일치')
        else:
            if report.get('ok') is not True or not isinstance(report.get('selfCheck'), dict) or report['selfCheck'].get('status') != 'passed': raise fail('자기 점검 미통과')
            self_check = report['selfCheck']
        if report.get('outputSha256') != output_hash: raise fail('출력 해시 불일치')
        runtime = report.get('runtime') if isinstance(report.get('runtime'), dict) else {}
        if runtime.get('wasmSha256') != cap['wasmSha256']: raise fail('확인된 런타임과 다른 WASM')
        if not draft:
            applied = report.get('edits') if isinstance(report.get('edits'), list) else []
            if [(e.get('id'), e.get('pageIndex'), e.get('status')) for e in applied if isinstance(e, dict)] != [(e['id'], e['pageIndex'], 'applied') for e in edits]:
                raise fail('적용되지 않은 변경')
        page_count = report.get('pageCount') if isinstance(report.get('pageCount'), dict) else {}
        input_pages, output_pages = _count(page_count.get('source')), _count(page_count.get('output'))
        added_pages = _count(report.get('addedPages'))
        grown = output_pages - input_pages if input_pages is not None and output_pages is not None and output_pages >= input_pages else None
        codes = lambda items: [{'pageIndex': _count(w.get('pageIndex')), 'code': str(w.get('code'))[:64],
            **({'severity': w['severity']} if w.get('severity') in ['error', 'warning', 'info'] else {})}
            for w in (items if isinstance(items, list) else []) if isinstance(w, dict)]
        warnings = codes(report.get('warnings'))
        # Layout verified only on the bridge's verdict AND a passed mandatory saved-file self-check
        # with no failures and no error-severity warnings; same-engine, not independent or scientific proof.
        layout_verified = (report.get('layoutVerified') is True and self_check.get('failures') == []
            and not any(w.get('severity') == 'error' for w in warnings))
        diagnostics = [f"{w['code']}" + (f" (p. {w['pageIndex'] + 1})" if w['pageIndex'] is not None else '') for w in warnings][:5]
        verification = {'mode': ENGINE, 'engine': ENGINE, 'version': cap['version'],
            'runtime': {'wasmSha256': runtime.get('wasmSha256'), 'jsSha256': _hex(runtime.get('jsSha256')), 'manifestSha256': _hex(runtime.get('manifestSha256')),
                'runtimeKind': runtime.get('runtimeKind') if runtime.get('runtimeKind') in ['candidate', 'pinned'] else None},
            'layoutVerified': layout_verified,
            # Facts about this output only; null when the editor did not report them (never invented).
            'reflow': {'wrappedLines': _count(report.get('wrappedLines'))},
            'pagination': {'inputPages': input_pages, 'outputPages': output_pages},
            'addedPages': added_pages,
            'sourcePageMap': _page_map(report.get('sourcePageMap')),
            # Header/footer copy and page-number suffix only as this report declares them; null keeps the body-only reading.
            'continuationStyle': _continuation_report(report.get('continuationStyle'), cap, layout_verified, added_pages, grown),
            'capabilities': {'reflow': cap['reflow'], 'pagination': cap['pagination']},
            'pages': output_pages,
            'edits': _draft_edit_rows(edits, report) if draft else [{'label': e['label'], 'id': e['id'], 'pageIndex': e['pageIndex'], 'status': 'applied'} for e in edits],
            'repairs': [{'pageIndex': r.get('pageIndex'), 'count': r.get('count')} for r in report.get('repairs', []) if isinstance(r, dict)] if isinstance(report.get('repairs'), list) else [],
            'warnings': warnings, 'diagnostics': diagnostics,
            'selfCheck': {'status': self_check.get('status') if draft else 'passed', 'independent': False, 'method': self_check.get('method'), 'warnings': codes(self_check.get('warnings'))},
            'checkBoundary': CHECK_BOUNDARY,
            # Fixed counts only; the private plan's text hashes, styles and coordinates never leave the server.
            'editPlanSummary': paper_inventory.summarize(plan)}
        checks = self._independent(source, out, edits, verification['sourcePageMap'], {'source': input_pages, 'output': output_pages}, plan)
        verification['independentQA'], verification['independentChecks'] = checks['status'], checks
        if checks['status'] == 'failed' and not draft:
            found = [f"{c['code']}" + (f" (출력 p. {', '.join(map(str, c['pages'][:10]))})" if c['pages'] else '') for c in checks['checks'] if c['status'] == 'failed']
            raise ValueError(f"{QA_FAILED.format(checks='; '.join(found))} {NO_FALLBACK}")
        if draft:
            err = report.get('error') if isinstance(report.get('error'), dict) else {}
            code = err.get('code')
            verification['draft'] = True
            verification['quality'] = 'error' if self_check.get('status') == 'error' else 'failed'
            verification['error'] = {'code': code if isinstance(code, str) and CODE.fullmatch(code) else 'SELF_CHECK_FAILED'}
            verification['sourceBinding'] = {'inputSha256': data['fileHash'], 'outputSha256': output_hash}
        return {'file': base64.b64encode(output).decode('ascii'), 'sourceFileHash': data['fileHash'], 'outputFileHash': output_hash, 'verification': verification}

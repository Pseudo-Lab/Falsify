"""Unified self-healing RED mutation error contract tests across every mutation surface."""
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

import anyio
import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
TESTS = ROOT / 'app' / 'tests'
for folder in (LOCAL, TESTS):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))

from chart_shape_fixture import chart_pdf  # noqa: E402
from paper_evidence import EvidenceStore  # noqa: E402
from paper_red_errors import (  # noqa: E402
    RedMutationError,
    VALID_DIFFICULTIES,
    VALID_FAMILIES,
    VALID_KINDS,
    VALID_WORLDS,
    build_error_payload,
    error_surface,
    sanitize_details,
    taxonomy_hint,
)
from paper_red_mcp import build_server  # noqa: E402
from paper_uri_mutator import list_pdf_uri_links  # noqa: E402
from test_paper_evidence import draw_table  # noqa: E402

CONTRACT_KEYS = ('error', 'actualValue', 'nearestCandidates', 'bbox', 'recoveryHint')
_DRIVE_RE = re.compile(r'\b[A-Za-z]:[\\/]')
_ABS_RE = re.compile(r'[\\/](?:Users|home|tmp|var|mnt)[\\/]', re.IGNORECASE)


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _self_healing_pdf() -> bytes:
    """One page with a merged table and one bibliography line carrying a /URI link."""
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 72), 'Table 1. Merged', fontsize=11, fontname='helv')
    draw_table(page)
    page.insert_text(
        (72, 330), '[1] Kim J. Biomarker validation study. doi:10.1000/orig-ref', fontsize=9.5, fontname='helv',
    )
    page.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 320, 430, 336),
        'uri': 'https://doi.org/10.1000/orig-ref',
    })
    raw = doc.tobytes()
    doc.close()
    return raw


class SharedErrorContractTests(unittest.TestCase):
    def test_payload_shape_defaults_and_sanitizing(self):
        payload = build_error_payload(
            'visual_cell_missing',
            actual_value='zzz',
            nearest_candidates=[{'row': 1, 'column': 1, 'text': '1', 'bbox': [0, 0, 1, 1]}],
            bbox=[1, 2, 3, 4],
            extra={'cwd': '/tmp/x', 'source_path': 'C:/paper.pdf', 'pageIndex': 0},
        )
        for key in CONTRACT_KEYS:
            self.assertIn(key, payload)
        self.assertEqual(payload['actualValue'], 'zzz')
        self.assertEqual(payload['bbox'], [1, 2, 3, 4])
        self.assertEqual(payload['pageIndex'], 0)
        self.assertNotIn('cwd', payload)
        self.assertNotIn('source_path', payload)
        self.assertEqual(sanitize_details({'cwd': '.', 'dir': '.', 'ok': 1}), {'ok': 1})
        self.assertEqual(sanitize_details(['not', 'a', 'dict']), {})
        self.assertEqual(sanitize_details({'base_dir': '.', 'step': 2}), {'step': 2})

    def test_red_mutation_error_carries_code_and_defaults(self):
        exc = RedMutationError('chart_scene_expired', {'sceneId': 'abc', 'cwd': '/tmp'})
        self.assertIsInstance(exc, ValueError)
        self.assertEqual(str(exc), 'chart_scene_expired')
        self.assertEqual(exc.code, 'chart_scene_expired')
        self.assertEqual(exc.details['error'], 'chart_scene_expired')
        self.assertEqual(exc.details['nearestCandidates'], [])
        self.assertTrue(exc.details['recoveryHint'])
        self.assertNotIn('cwd', exc.details)

    def test_error_surface_and_taxonomy_hint_vocabulary(self):
        self.assertEqual(error_surface('visual_cell_missing'), 'table')
        self.assertEqual(error_surface('red_taxonomy_invalid'), 'taxonomy')
        self.assertEqual(error_surface('visual_operation_invalid'), 'taxonomy')
        self.assertEqual(error_surface('chart_scene_expired'), 'chart')
        self.assertEqual(error_surface('uri_annot_out_of_range'), 'uri')
        self.assertEqual(error_surface('text_span_not_found'), 'text')
        self.assertEqual(error_surface('supplement_before_not_found'), 'supplement')
        self.assertEqual(error_surface('stealth_audit_failed'), 'none')
        hint = taxonomy_hint()
        for token in VALID_WORLDS + VALID_DIFFICULTIES + VALID_FAMILIES + VALID_KINDS:
            self.assertIn(token, hint)


class SelfHealingMcpTests(unittest.TestCase):
    def setUp(self):
        self.raw = _self_healing_pdf()
        self.digest = _sha(self.raw)
        self.store = EvidenceStore()
        self.pid = self.store.prepare(self.raw, self.digest)['paperId']
        self.server = build_server(self.store, self.pid, self.digest)
        self.export_fn = self.server._tool_manager._tools['export_coordinated_edits'].fn
        targets = self.server._tool_manager._tools['list_red_targets'].fn(self.pid).structuredContent
        self.table = targets['tables'][0]
        self.link = list_pdf_uri_links(self.raw)['links'][0]

    def _assert_contract(self, result):
        self.assertTrue(result.isError, result)
        payload = result.structuredContent
        for key in CONTRACT_KEYS:
            self.assertIn(key, payload, payload)
        self.assertIsInstance(payload['nearestCandidates'], list)
        self.assertTrue(payload['recoveryHint'])
        self.assertNotRegex(payload['recoveryHint'], _DRIVE_RE)
        self.assertEqual(json.loads(result.content[0].text), payload)
        return payload

    def test_bad_table_cell_lists_nearest_cells(self):
        async def run():
            payload = self._assert_contract(await self.export_fn(self.pid, [{
                'id': 'bad-cell',
                'kind': 'table-cell',
                'itemId': self.table['itemId'],
                'row': 9,
                'column': 9,
                'before': 'zzz',
                'after': '1',
            }]))
            self.assertEqual(payload['error'], 'visual_cell_missing')
            self.assertEqual(payload['actualValue'], 'zzz')
            self.assertIsNone(payload['bbox'])
            self.assertTrue(payload['nearestCandidates'])
            for candidate in payload['nearestCandidates']:
                self.assertEqual(set(candidate), {'row', 'column', 'text', 'bbox'})
                self.assertEqual(len(candidate['bbox']), 4)
            self.assertTrue(any(candidate['text'] == '5' for candidate in payload['nearestCandidates']))

        anyio.run(run)

    def test_bad_table_before_echoes_value_and_cell_bbox(self):
        cell = next(c for c in self.table['cells'] if c['text'] == '5')

        async def run():
            payload = self._assert_contract(await self.export_fn(self.pid, [{
                'id': 'bad-before',
                'kind': 'table-cell',
                'itemId': self.table['itemId'],
                'row': cell['row'],
                'column': cell['column'],
                'before': '5.0001',
                'after': '9',
            }]))
            self.assertEqual(payload['error'], 'visual_before_mismatch')
            self.assertEqual(payload['actualValue'], '5.0001')
            self.assertEqual(payload['bbox'], cell['bbox'])
            self.assertTrue(any(candidate['text'] == '5' for candidate in payload['nearestCandidates']))

        anyio.run(run)

    def test_bad_uri_link_lists_bound_links_and_echoes_before_uri(self):
        async def run():
            payload = self._assert_contract(await self.export_fn(self.pid, [{
                'id': 'bad-uri',
                'kind': 'uri-link',
                'linkId': 'p0-a9',
                'beforeUri': 'https://doi.org/10.1000/not-there',
                'afterUri': 'https://doi.org/10.1000/other',
            }]))
            self.assertEqual(payload['error'], 'uri_annot_out_of_range')
            self.assertEqual(payload['actualValue'], 'https://doi.org/10.1000/not-there')
            self.assertTrue(payload['nearestCandidates'])
            first = payload['nearestCandidates'][0]
            self.assertEqual(
                set(first), {'linkId', 'pageIndex', 'bbox', 'uri', 'visibleText'},
            )
            self.assertEqual(first['linkId'], self.link['linkId'])
            self.assertEqual(first['uri'], self.link['uri'])
            self.assertEqual(payload['bbox'], self.link['bbox'])

        anyio.run(run)

    def test_taxonomy_and_operation_codes_enumerate_the_vocabulary(self):
        async def run():
            taxonomy = self._assert_contract(await self.export_fn(self.pid, [{
                'id': 'bad-taxonomy',
                'kind': 'table-cell',
                'itemId': self.table['itemId'],
                'row': 1,
                'column': 1,
                'before': '1',
                'after': '2',
                'world': 'W9',
                'difficulty': 'L9',
            }]))
            self.assertEqual(taxonomy['error'], 'red_taxonomy_invalid')
            self.assertEqual(taxonomy['nearestCandidates'], [])
            self.assertEqual(taxonomy['actualValue'], 'W9')
            for token in VALID_WORLDS + VALID_DIFFICULTIES + VALID_FAMILIES + VALID_KINDS:
                self.assertIn(token, taxonomy['recoveryHint'])
            self.assertEqual(taxonomy['validKinds'], list(VALID_KINDS))

            operation = self._assert_contract(await self.export_fn(self.pid, [{
                'id': 'bad-kind',
                'kind': 'not-a-real-kind',
            }]))
            self.assertEqual(operation['error'], 'visual_operation_invalid')
            self.assertEqual(operation['nearestCandidates'], [])
            self.assertIn('table-cell', operation['recoveryHint'])

        anyio.run(run)

    def test_chart_scene_failure_names_prepare_chart_scene(self):
        raw = chart_pdf()
        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        export_fn = build_server(store, pid, digest)._tool_manager._tools['export_coordinated_edits'].fn

        async def run():
            result = await export_fn(pid, [{
                'id': 'bad-chart',
                'kind': 'chart-shape',
                'plan': {'sceneId': 'deadbeef', 'revision': 1, 'operations': [], 'bbox': [35, 40, 395, 278]},
            }])
            payload = self._assert_contract(result)
            self.assertEqual(payload['error'], 'chart_scene_expired')
            self.assertEqual(payload['actualValue'], 'deadbeef')
            self.assertEqual(payload['nearestCandidates'], [])
            self.assertIn('prepare_chart_scene', payload['recoveryHint'])
            self.assertEqual(payload['bbox'], [35.0, 40.0, 395.0, 278.0])

        anyio.run(run)

    def test_chart_plan_failure_lists_prepared_series_points(self):
        raw = chart_pdf()
        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        tools = build_server(store, pid, digest)._tool_manager._tools
        prepare_fn = tools['prepare_chart_scene'].fn
        export_fn = tools['export_coordinated_edits'].fn

        async def run():
            scene_res = await prepare_fn(pid, 0, [35, 40, 395, 278])
            self.assertFalse(scene_res.isError, scene_res)
            scene = scene_res.structuredContent
            result = await export_fn(pid, [{
                'id': 'bad-revision',
                'kind': 'chart-shape',
                'plan': {'sceneId': scene['sceneId'], 'revision': 'x', 'operations': []},
            }])
            payload = self._assert_contract(result)
            self.assertEqual(payload['error'], 'chart_revision_invalid')
            self.assertEqual(payload['actualValue'], 'x')
            self.assertTrue(payload['nearestCandidates'])
            for candidate in payload['nearestCandidates']:
                self.assertEqual(set(candidate), {'seriesId', 'pointIndex', 'center'})
                self.assertEqual(len(candidate['center']), 2)
            self.assertIn('prepare_chart_scene', payload['recoveryHint'])

            # A bad chart point reference on a prepared scene still lists real series points.
            bad_point = await export_fn(pid, [{
                'id': 'bad-point',
                'kind': 'chart-shape',
                'plan': {'sceneId': scene['sceneId'], 'revision': 1, 'seriesId': 'missing-series'},
            }])
            point_payload = self._assert_contract(bad_point)
            self.assertEqual(point_payload['error'], 'chart_plan_invalid')
            self.assertTrue(point_payload['nearestCandidates'])
            self.assertIn(
                scene['series'][0]['id'],
                {candidate['seriesId'] for candidate in point_payload['nearestCandidates']},
            )

        anyio.run(run)

    def test_text_span_errors_keep_the_existing_span_generators(self):
        async def run():
            payload = self._assert_contract(await self.export_fn(self.pid, [{
                'id': 'bad-span',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'doi:10.1000/orig-ref typo',
                'after': 'doi:10.1000/new-ref',
            }]))
            self.assertEqual(payload['error'], 'text_span_not_found')
            self.assertTrue(payload['nearestCandidates'])
            self.assertTrue(any('orig-ref' in c['text'] for c in payload['nearestCandidates']))

        anyio.run(run)

    def test_no_payload_leaks_absolute_paths_or_working_directories(self):
        payloads = []

        async def run():
            payloads.append(await self.export_fn(self.pid, [{
                'id': 'bad-1', 'kind': 'table-cell', 'itemId': self.table['itemId'],
                'row': 42, 'column': 42, 'before': 'x', 'after': 'y',
            }]))
            payloads.append(await self.export_fn(self.pid, [{
                'id': 'bad-2', 'kind': 'uri-link', 'linkId': 'p5-a5',
                'beforeUri': 'https://doi.org/10.1000/none', 'afterUri': 'https://doi.org/10.1000/x',
            }]))
            payloads.append(await self.export_fn(self.pid, [{'id': 'bad-3', 'kind': 'chart-shape', 'plan': {}}]))

        anyio.run(run)
        for result in payloads:
            blob = result.content[0].text
            self.assertNotRegex(blob, _DRIVE_RE)
            self.assertNotRegex(blob, _ABS_RE)
            self.assertNotIn('\\\\', blob)
            self.assertNotIn(str(ROOT), blob)


if __name__ == '__main__':
    unittest.main()

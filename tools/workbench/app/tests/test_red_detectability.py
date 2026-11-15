"""RED detectability simulation (L1..L4) and cross-surface claim propagation tests."""
import hashlib
import json
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

from paper_evidence import EvidenceStore  # noqa: E402
from paper_red_detectability import (  # noqa: E402
    CLAIM_SCHEMA,
    DETECTABILITY_SCHEMA,
    simulate_red_detectability,
    trace_claim_propagation,
)
from paper_red_mcp import build_server  # noqa: E402
from paper_uri_mutator import list_pdf_uri_links  # noqa: E402
from test_paper_red_fullmodal import _flawed_baseline_pdf  # noqa: E402


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _cell(page, x0, y0, width, height, text):
    rect = pymupdf.Rect(x0, y0, x0 + width, y0 + height)
    page.draw_rect(rect, color=(0, 0, 0), width=1)
    if text:
        page.insert_textbox(
            pymupdf.Rect(rect.x0 + 3, rect.y0 + 7, rect.x1 - 3, rect.y1 - 3), text, fontsize=9, fontname='helv',
        )


ARM_ROWS = (
    ('Site', 'Arm A', 'Arm B', 'Total'),
    ('north', '10', '20', '30'),
    ('south', '5', '15', '20'),
    ('Total', '15', '35', '50'),
)


def _detectability_pdf() -> bytes:
    """Three-page synthetic paper: a summing table, prose claims, references, an identical duplicate claim."""
    doc = pymupdf.open()
    p0 = doc.new_page(width=595, height=842)
    p0.insert_text((72, 72), 'Table 1. Arm outcomes by site', fontsize=11, fontname='helv')
    for row_index, row in enumerate(ARM_ROWS):
        for column_index, text in enumerate(row):
            _cell(p0, 72 + column_index * 110, 82 + row_index * 26, 110, 26, text)
    p0.insert_text(
        (72, 230), 'Primary cohort showed p = 0.04 and AUC = 0.94 in training.', fontsize=10, fontname='helv',
    )
    p0.insert_text(
        (72, 250), 'Our findings prove the marker prevents relapse in all adults.', fontsize=10, fontname='helv',
    )
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((72, 80), 'Supplementary methods remain untouched on page 2.', fontsize=10, fontname='helv')
    p1.insert_text((72, 130), 'References', fontsize=11, fontname='helv')
    p1.insert_text(
        (72, 150), '[1] Kim J. Biomarker validation study. doi:10.1000/orig-ref', fontsize=9.5, fontname='helv',
    )
    p1.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 140, 430, 156),
        'uri': 'https://doi.org/10.1000/orig-ref',
    })
    p2 = doc.new_page(width=595, height=842)
    p2.insert_text((72, 80), 'AUC = 0.94', fontsize=10, fontname='helv')
    p2.insert_text((72, 200), 'AUC = 0.94', fontsize=10, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


def _assert_no_forbidden_keys(obj, path='root'):
    forbidden = {'before', 'after', 'gold', 'patch', 'why_hard', 'candidateRationales'}
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in forbidden:
                raise AssertionError(f'forbidden RED key {key} at {path}')
            _assert_no_forbidden_keys(value, f'{path}.{key}')
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            _assert_no_forbidden_keys(value, f'{path}[{index}]')


SUPPLEMENTS = [{'supplementId': 'supp-0', 'name': 'Table_S1.csv', 'text': 'cohort,N,AUC\nmain,240,0.94\n'}]


class RedDetectabilityTests(unittest.TestCase):
    def setUp(self):
        self.raw = _detectability_pdf()
        self.digest = _sha(self.raw)
        self.store = EvidenceStore()
        self.pid = self.store.prepare(self.raw, self.digest)['paperId']
        self.link = list_pdf_uri_links(self.raw)['links'][0]
        targets = self.store.list_items(self.pid)['items']
        self.table = next(item for item in targets if item['type'] == 'table')

    def _operations(self):
        return [
            {
                'id': 'op-uri',
                'kind': 'uri-link',
                'linkId': self.link['linkId'],
                'beforeUri': 'https://doi.org/10.1000/orig-ref',
                'afterUri': 'https://doi.org/10.1000/other-study',
                'world': 'W5',
                'family': 'D2',
                'difficulty': 'L1',
                'rationale': 'Hijack the reference URI target',
            },
            {
                'id': 'op-cell',
                'kind': 'table-cell',
                'itemId': self.table['id'],
                'row': 1,
                'column': 1,
                'before': '10',
                'after': '99',
                'world': 'W1',
                'family': 'D1',
                'difficulty': 'L2',
                'rationale': 'Break the arm total arithmetic',
            },
            {
                'id': 'op-supp',
                'kind': 'supplement-edit',
                'supplementId': 'supp-0',
                'before': 'main,240,0.94',
                'after': 'main,240,0.71',
                'world': 'W4',
                'family': 'D1',
                'difficulty': 'L3',
                'rationale': 'Contradict the main-text AUC across documents',
            },
            {
                'id': 'op-d3',
                'kind': 'text-span',
                'pageIndex': 0,
                'before': 'prove',
                'after': 'show',
                'world': 'W2',
                'family': 'D3',
                'difficulty': 'L4',
                'rationale': 'Unsupported causal claim with no Layer 0 oracle',
            },
        ]

    def test_distance_buckets_and_layer0_attribution(self):
        result = simulate_red_detectability(
            self.pid, self._operations(), file_hash=self.digest, store=self.store, supplements=SUPPLEMENTS,
        )
        self.assertEqual(result['schema'], DETECTABILITY_SCHEMA)
        self.assertEqual(result['paperId'], self.pid)
        self.assertEqual(result['fileHash'], self.digest)
        self.assertEqual(result['operationCount'], 4)
        by_id = {item['operationId']: item for item in result['results']}
        self.assertEqual(set(by_id), {'op-uri', 'op-cell', 'op-supp', 'op-d3'})

        # L1: one static oracle on the same surface (citation) and page.
        self.assertEqual(by_id['op-uri']['crossInferenceDistance'], 'L1')
        self.assertTrue(by_id['op-uri']['detectedByLayer0'])
        self.assertEqual(
            [signal['kind'] for signal in by_id['op-uri']['matchedSignals']],
            ['uri_visible_doi_mismatch'],
        )
        self.assertEqual(by_id['op-uri']['exposureRisk'], 'immediate')
        self.assertIn('single_oracle_hit', by_id['op-uri']['reasons'])

        # L2: row/column recomputation produces at least two D1 signals.
        self.assertEqual(by_id['op-cell']['crossInferenceDistance'], 'L2')
        self.assertTrue(by_id['op-cell']['detectedByLayer0'])
        self.assertGreaterEqual(len(by_id['op-cell']['matchedSignals']), 2)
        self.assertTrue(
            all(signal['kind'] == 'table_sum_mismatch' for signal in by_id['op-cell']['matchedSignals'])
        )
        self.assertIn('multiple_layer0_signals', by_id['op-cell']['reasons'])
        self.assertEqual(by_id['op-cell']['exposureRisk'], 'immediate')

        # L3: the supplement edit crosses surfaces and no static Layer 0 signal fires.
        self.assertEqual(by_id['op-supp']['crossInferenceDistance'], 'L3')
        self.assertFalse(by_id['op-supp']['detectedByLayer0'])
        self.assertEqual(by_id['op-supp']['matchedSignals'], [])
        self.assertEqual(by_id['op-supp']['exposureRisk'], 'cross-section')

        # L4: D3 has no Layer 0 detector at all.
        self.assertEqual(by_id['op-d3']['crossInferenceDistance'], 'L4')
        self.assertFalse(by_id['op-d3']['detectedByLayer0'])
        self.assertEqual(by_id['op-d3']['matchedSignals'], [])
        self.assertIn('no_layer0_detector_for_D3', by_id['op-d3']['reasons'])
        self.assertEqual(by_id['op-d3']['exposureRisk'], 'low')

        self.assertEqual(result['distanceCounts'], {'L1': 1, 'L2': 1, 'L3': 1, 'L4': 1})
        self.assertEqual(result['immediateDetectionCount'], 2)
        self.assertIn('D3_and_S1_have_no_layer0_detector', result['notes'])
        _assert_no_forbidden_keys(result)
        self.assertEqual(self.store.source_bytes(self.pid, self.digest), self.raw)

    def test_pre_existing_defect_is_reported_as_baseline_overlap(self):
        raw = _flawed_baseline_pdf()
        digest = _sha(raw)
        store = EvidenceStore()
        pid = store.prepare(raw, digest)['paperId']
        result = simulate_red_detectability(pid, [{
            'id': 'touch-defect',
            'kind': 'text-span',
            'pageIndex': 0,
            'before': 'p = 0.25',
            'after': 'p = 0.01',
            'world': 'W3',
            'family': 'D1',
        }], file_hash=digest, store=store)
        self.assertEqual(result['operationCount'], 1)
        overlap = result['results'][0]['baselineOverlap']
        self.assertTrue(overlap['signalIds'])
        self.assertTrue(overlap['signals'])
        self.assertEqual(overlap['signals'][0]['kind'], 'stat_pvalue_mismatch')
        self.assertEqual(store.source_bytes(pid, digest), raw)

    def test_trace_claim_propagation_surfaces_ids_and_dedupe(self):
        numeric = trace_claim_propagation(self.pid, '0.94', store=self.store, supplements=SUPPLEMENTS)
        self.assertEqual(numeric['schema'], CLAIM_SCHEMA)
        self.assertEqual(numeric['query'], '0.94')
        self.assertFalse(numeric['truncated'])
        surfaces = numeric['surfaces']
        self.assertGreaterEqual(surfaces['prose'], 1)
        self.assertEqual(surfaces['supplement'], 1)
        self.assertEqual(numeric['occurrenceCount'], len(numeric['occurrences']))
        for occurrence in numeric['occurrences']:
            self.assertIn(occurrence['surface'], {'prose', 'table', 'figure', 'citation', 'supplement'})
            self.assertTrue(occurrence['refId'].startswith('er'))
            self.assertTrue(occurrence['excerpt'])

        # Two identical prose claims on page 2 collapse to one occurrence.
        page_two = [occ for occ in numeric['occurrences'] if occ['pageIndex'] == 2]
        self.assertEqual(len(page_two), 1)
        self.assertEqual(page_two[0]['excerpt'], 'AUC = 0.94')

        textual = trace_claim_propagation(self.pid, 'Biomarker', store=self.store, supplements=SUPPLEMENTS)
        self.assertGreaterEqual(textual['surfaces']['citation'], 1)
        self.assertGreaterEqual(textual['surfaces']['prose'], 1)
        reference = next(occ for occ in textual['occurrences'] if occ['surface'] == 'citation')
        self.assertIn('Biomarker', reference['excerpt'])
        self.assertTrue(reference['refId'].startswith('er'))

        table_claim = trace_claim_propagation(self.pid, '10', store=self.store)
        self.assertGreaterEqual(table_claim['surfaces']['table'], 1)
        table_occurrence = next(occ for occ in table_claim['occurrences'] if occ['surface'] == 'table')
        self.assertTrue(table_occurrence['itemId'])
        self.assertEqual(len(table_occurrence['bbox']), 4)

        link_claim = trace_claim_propagation(self.pid, '10.1000/orig-ref', store=self.store)
        self.assertGreaterEqual(link_claim['surfaces']['citation'], 2)
        _assert_no_forbidden_keys(textual)
        _assert_no_forbidden_keys(link_claim)

    def test_trace_caps_occurrences_and_validates_arguments(self):
        capped = trace_claim_propagation(self.pid, '10', store=self.store, max_occurrences=2)
        self.assertTrue(capped['truncated'])
        self.assertEqual(len(capped['occurrences']), 2)
        self.assertGreater(capped['occurrenceCount'], 2)
        with self.assertRaises(ValueError):
            trace_claim_propagation(self.pid, '   ', store=self.store)
        with self.assertRaises(ValueError):
            trace_claim_propagation(self.pid, 'x' * 500, store=self.store)
        with self.assertRaises(ValueError):
            trace_claim_propagation(self.pid, '0.94', store=self.store, max_occurrences=0)
        with self.assertRaises(ValueError):
            simulate_red_detectability(self.pid, self._operations(), store=self.store, max_signals=0)
        with self.assertRaises(ValueError):
            simulate_red_detectability(self.pid, 'not-a-list', store=self.store)
        with self.assertRaises(ValueError):
            simulate_red_detectability('other-paper', [], store=self.store)

    def test_unknown_paper_id_and_hash_mismatch_are_rejected(self):
        with self.assertRaises(ValueError):
            trace_claim_propagation('not-the-bound-paper', '0.94', store=self.store)
        with self.assertRaises(ValueError):
            trace_claim_propagation(self.pid, '0.94', file_hash='0' * 64, store=self.store)


class RedDetectabilityToolTests(unittest.TestCase):
    def setUp(self):
        self.raw = _detectability_pdf()
        self.digest = _sha(self.raw)
        self.store = EvidenceStore()
        self.pid = self.store.prepare(self.raw, self.digest)['paperId']
        self.server = build_server(self.store, self.pid, self.digest, supplements=SUPPLEMENTS)
        self.tools = self.server._tool_manager._tools

    def test_tools_are_registered_read_only_and_bound(self):
        for name in ('simulate_red_detectability', 'trace_claim_propagation'):
            self.assertIn(name, self.tools)
            self.assertTrue(self.tools[name].annotations.readOnlyHint)
        self.assertEqual(
            set(self.tools['simulate_red_detectability'].parameters['properties']),
            {'paperId', 'operations'},
        )
        self.assertEqual(set(self.tools['trace_claim_propagation'].parameters['properties']), {'paperId', 'query'})

        simulate_fn = self.tools['simulate_red_detectability'].fn
        trace_fn = self.tools['trace_claim_propagation'].fn
        link = list_pdf_uri_links(self.raw)['links'][0]

        async def run():
            sim = await simulate_fn(self.pid, [{
                'id': 'op-uri', 'kind': 'uri-link', 'linkId': link['linkId'],
                'beforeUri': link['uri'], 'afterUri': 'https://doi.org/10.1000/other-study',
            }])
            self.assertFalse(sim.isError, sim)
            payload = sim.structuredContent
            self.assertEqual(payload['schema'], DETECTABILITY_SCHEMA)
            self.assertEqual(payload['distanceCounts']['L1'], 1)
            self.assertNotIn('pdfBase64', json.dumps(payload))

            traced = trace_fn(self.pid, '0.94')
            self.assertFalse(traced.isError, traced)
            self.assertEqual(traced.structuredContent['schema'], CLAIM_SCHEMA)

            foreign = trace_fn('other-paper', '0.94')
            self.assertTrue(foreign.isError)

        anyio.run(run)
        self.assertEqual(self.store.source_bytes(self.pid, self.digest), self.raw)


if __name__ == '__main__':
    unittest.main()

"""Planner tests for coordinated multi-surface RED bundles. Stdlib unittest only."""
import hashlib
import json
import sys
import unittest
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / 'app' / 'local'
if str(LOCAL) not in sys.path:
    sys.path.insert(0, str(LOCAL))

from paper_evidence import EvidenceStore  # noqa: E402
from paper_red_mcp import build_server  # noqa: E402
from paper_red_planner import (  # noqa: E402
    HINT_TOKENS,
    SCHEMA,
    distance_rank,
    plan_coordinated_mutations,
)


def _cell(page, x0, y0, width, height, text):
    rect = pymupdf.Rect(x0, y0, x0 + width, y0 + height)
    page.draw_rect(rect, color=(0, 0, 0), width=1)
    if text:
        page.insert_textbox(
            pymupdf.Rect(rect.x0 + 3, rect.y0 + 7, rect.x1 - 3, rect.y1 - 3),
            text, fontsize=9, fontname='helv',
        )


def _rows(page, origin_y, rows):
    for row_index, row in enumerate(rows):
        for column_index, text in enumerate(row):
            _cell(page, 72 + column_index * 90, origin_y + row_index * 26, 90, 26, text)


def _planner_pdf():
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((72, 64), 'Primary cohort showed AUC = 0.94 in training.', fontsize=11, fontname='helv')
    page.insert_text((72, 88), 'The study suggests a modest gain.', fontsize=11, fontname='helv')
    page.insert_text((72, 112), 'Response was 12/40 (30%) in the treated arm.', fontsize=11, fontname='helv')
    page.insert_text((72, 136), 'The t test reported t = 2.05, df = 28, p = 0.050.', fontsize=11, fontname='helv')
    _rows(page, 170, (
        ('Metric', 'Value'),
        ('AUC', '0.94'),
        ('N', '240'),
    ))
    _rows(page, 280, (
        ('Site', 'Arm A', 'Arm B', 'Total'),
        ('north', '10', '20', '30'),
        ('south', '5', '15', '20'),
        ('Total', '15', '35', '50'),
    ))
    page2 = doc.new_page(width=595, height=842)
    page2.insert_text((72, 80), '[1] Kim J. Biomarker study. doi:10.1000/orig-ref', fontsize=11, fontname='helv')
    page2.insert_link({
        'kind': pymupdf.LINK_URI,
        'from': pymupdf.Rect(70, 68, 460, 96),
        'uri': 'https://doi.org/10.1000/orig-ref',
    })
    page2.insert_text((72, 140), 'Rates increased after treatment.', fontsize=11, fontname='helv')
    raw = doc.tobytes()
    doc.close()
    return raw


SUPPLEMENTS = [
    {
        'supplementId': 'supp-0',
        'name': 'Table_S1.csv',
        'text': 'cohort,N,AUC\nmain,240,0.94\nraw,240,0.94\n',
    },
    {
        'supplementId': 'supp-1',
        'name': 'methods.md',
        'text': '# Methods\nInclusion threshold kept AUC = 0.94 for the training cohort.\n',
    },
]


def _bind(raw):
    digest = hashlib.sha256(raw).hexdigest()
    store = EvidenceStore()
    paper_id = store.prepare(raw, digest)['paperId']
    return store, paper_id, digest


def _hint_blob(plan):
    return json.dumps(plan, ensure_ascii=False).lower()


class RedPlannerTests(unittest.TestCase):
    def setUp(self):
        self.raw = _planner_pdf()
        self.store, self.paper_id, self.digest = _bind(self.raw)

    def _plan(self, target, claim=None, limit=5):
        return plan_coordinated_mutations(
            self.paper_id,
            file_hash=self.digest,
            store=self.store,
            supplements=SUPPLEMENTS,
            target_difficulty=target,
            max_bundles=limit,
            claim_query=claim,
        )

    def test_rejects_invalid_difficulty_and_limit(self):
        with self.assertRaises(ValueError) as difficulty:
            self._plan('L5')
        self.assertEqual(str(difficulty.exception), 'target_difficulty_invalid')
        for bad in (True, False, 0, 21, '5'):
            with self.assertRaises(ValueError) as limit:
                plan_coordinated_mutations(
                    self.paper_id, store=self.store, supplements=SUPPLEMENTS, max_bundles=bad,
                )
            self.assertEqual(str(limit.exception), 'limit')

    def test_l3_partial_sync_is_silent_and_multi_surface(self):
        plan = self._plan('L3')
        self.assertEqual(plan['schema'], SCHEMA)
        self.assertEqual(plan['paperId'], self.paper_id)
        self.assertEqual(plan['fileHash'], self.digest)
        self.assertEqual(plan['targetDifficulty'], 'L3')
        self.assertEqual(plan['bundleCount'], len(plan['bundles']))
        self.assertGreaterEqual(plan['bundleCount'], 1)
        self.assertEqual(self.store.source_bytes(self.paper_id, self.digest), self.raw)
        bundle = plan['bundles'][0]
        self.assertEqual(bundle['bundleId'], 'plan-1')
        self.assertTrue(bundle['targetMet'])
        self.assertGreaterEqual(distance_rank(bundle['effectiveDifficulty']), distance_rank('L3'))
        self.assertFalse(bundle['layer0Triggered'])
        self.assertGreaterEqual(bundle['operationCount'], 2)
        self.assertGreaterEqual(len(bundle['surfaces']), 2)
        self.assertIn('prose', bundle['surfaces'])
        self.assertTrue(set(bundle['surfaces']) & {'table', 'supplement'})
        kinds = {op['kind'] for op in bundle['operations']}
        self.assertIn('text-span', kinds)
        self.assertTrue(kinds & {'table-cell', 'supplement-edit'})
        blob = '\n'.join(_hint_blob(op) for op in bundle['operations'])
        for token in HINT_TOKENS:
            self.assertNotIn(token.lower(), blob)
        self.assertIn('distances', bundle['simulationSummary'])

    def test_claim_query_traces_the_requested_number(self):
        plan = self._plan('L3', claim='0.94')
        self.assertGreaterEqual(plan['bundleCount'], 1)
        blob = json.dumps(plan['bundles'][0]['operations'])
        self.assertIn('0.94', blob)
        with self.assertRaises(ValueError):
            self._plan('L3', claim='   ')

    def test_l4_polarity_swap_stays_silent(self):
        plan = self._plan('L4')
        self.assertGreaterEqual(plan['bundleCount'], 1)
        bundle = plan['bundles'][0]
        self.assertEqual(bundle['effectiveDifficulty'], 'L4')
        self.assertFalse(bundle['layer0Triggered'])
        self.assertTrue(bundle['targetMet'])
        families = {op.get('family') for op in bundle['operations']}
        self.assertTrue(families & {'D3', 'S1'})

    def test_l1_and_l2_meet_their_floors(self):
        low = self._plan('L1')
        first = low['bundles'][0]
        self.assertEqual(first['effectiveDifficulty'], 'L1')
        self.assertTrue(first['layer0Triggered'])
        self.assertEqual(first['operations'][0]['kind'], 'uri-link')
        mid = self._plan('L2')
        table = mid['bundles'][0]
        self.assertEqual(table['effectiveDifficulty'], 'L2')
        self.assertTrue(table['layer0Triggered'])
        self.assertEqual(table['operations'][0]['kind'], 'table-cell')

    def test_tool_is_registered_read_only(self):
        server = build_server(self.store, self.paper_id, self.digest, supplements=SUPPLEMENTS)
        tool = server._tool_manager._tools['plan_coordinated_mutation']
        self.assertTrue(tool.annotations.readOnlyHint)
        self.assertIn('plan_coordinated_mutation', server.instructions)
        props = set(tool.parameters['properties'])
        self.assertEqual(props, {'paperId', 'targetDifficulty', 'maxBundles', 'claimQuery'})

        async def run():
            return await tool.fn(self.paper_id, 'L4', 2, None)

        import anyio
        result = anyio.run(run)
        self.assertFalse(result.isError, result)
        payload = result.structuredContent
        self.assertEqual(payload['schema'], SCHEMA)
        self.assertLessEqual(payload['bundleCount'], 2)
        self.assertNotIn('pdfBase64', json.dumps(payload))


if __name__ == '__main__':
    unittest.main()
